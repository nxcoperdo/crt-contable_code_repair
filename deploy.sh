#!/usr/bin/env bash
#
# deploy.sh — despliegue de crt-contable en un VPS Ubuntu/Debian (acceso por IP, sin dominio)
#
# Uso (en el VPS, como usuario con sudo):
#   git clone https://github.com/nxcoperdo/crt-contable_code_repair.git crt-contable
#   cd crt-contable
#   chmod +x deploy.sh
#   ./deploy.sh              # acceso directo por http://IP:4300
#   ./deploy.sh --nginx      # proxy inverso Nginx en http://IP (puerto 80)
#
# Es idempotente: puedes volver a ejecutarlo para actualizar.
#
set -euo pipefail

# ----------------------------- configuración ---------------------------------
ADMIN_USER="${ADMIN_USER:-nicolas}"
ADMIN_PASS="${ADMIN_PASS:-nicolas0925}"
APP_PORT="${APP_PORT:-4300}"
NODE_MAJOR="${NODE_MAJOR:-22}"
APP_NAME="crt-contable"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"

USE_NGINX=0
[[ "${1:-}" == "--nginx" ]] && USE_NGINX=1

# NOTA: sin HTTPS NO se activa NODE_ENV=production (la cookie de sesión llevaría
# el flag Secure y el login por http:// fallaría).

say()  { printf '\n\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\n\033[1;33m[!]\033[0m %s\n' "$*"; }

# ------------------------------- comprobaciones ------------------------------
if [[ $EUID -eq 0 ]]; then
  SUDO=""
else
  SUDO="sudo"
  command -v sudo >/dev/null || { echo "Falta sudo y no eres root."; exit 1; }
fi

# --------------------------- 1. paquetes del sistema ------------------------
say "Actualizando sistema e instalando dependencias base"
export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update -y
$SUDO apt-get install -y curl ca-certificates gnupg build-essential python3 git sqlite3 ufw

# ------------------------------- 2. Node.js --------------------------------
if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt "$NODE_MAJOR" ]]; then
  say "Instalando Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | $SUDO -E bash -
  $SUDO apt-get install -y nodejs
fi
say "Node $(node -v) / npm $(npm -v)"

# ------------------------------- 3. PM2 -----------------------------------
command -v pm2 >/dev/null || { say "Instalando PM2"; $SUDO npm install -g pm2; }

# --------------------------- 4. dependencias app --------------------------
say "Instalando dependencias del proyecto"
cd "$APP_DIR"
npm install --omit=dev

# ----------------------- 5. generar ecosystem.config.js -------------------
SESSION_SECRET_FILE="$APP_DIR/.session_secret"
if [[ -f "$SESSION_SECRET_FILE" ]]; then
  SESSION_SECRET="$(cat "$SESSION_SECRET_FILE")"
else
  SESSION_SECRET="$(openssl rand -hex 32)"
  echo "$SESSION_SECRET" > "$SESSION_SECRET_FILE"
  chmod 600 "$SESSION_SECRET_FILE"
fi

say "Escribiendo ecosystem.config.js"
cat > "$APP_DIR/ecosystem.config.js" <<EOF
module.exports = {
  apps: [
    {
      name: '${APP_NAME}',
      script: 'server.js',
      cwd: '${APP_DIR}',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        // Sin NODE_ENV=production a proposito: acceso por http:// sin TLS.
        PORT: ${APP_PORT},
        DATA_DIR: '${DATA_DIR}',
        ADMIN_USER: '${ADMIN_USER}',
        ADMIN_PASS: '${ADMIN_PASS}',
        SESSION_SECRET: '${SESSION_SECRET}',
      },
    },
  ],
};
EOF

# Evita que git pull pise las credenciales
git -C "$APP_DIR" update-index --skip-worktree ecosystem.config.js 2>/dev/null || true

mkdir -p "$DATA_DIR"

# ------------------------------ 6. arrancar -----------------------------
say "Arrancando/recargando la app con PM2"
if pm2 describe "$APP_NAME" >/dev/null 2>&1; then
  pm2 restart "$APP_NAME" --update-env
else
  pm2 start "$APP_DIR/ecosystem.config.js"
fi
pm2 save

say "Configurando arranque automatico de PM2 al reiniciar"
STARTUP_CMD="$(pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null | grep -E '^\s*sudo ' || true)"
if [[ -n "$STARTUP_CMD" ]]; then
  eval "$STARTUP_CMD"
  pm2 save
fi

# ------------------------------ 7. firewall ----------------------------
say "Configurando firewall (ufw)"
$SUDO ufw allow OpenSSH >/dev/null 2>&1 || $SUDO ufw allow 22/tcp

if [[ $USE_NGINX -eq 1 ]]; then
  say "Instalando y configurando Nginx como proxy inverso"
  $SUDO apt-get install -y nginx
  IP="$(curl -fsS https://api.ipify.org || echo _)"
  $SUDO tee /etc/nginx/sites-available/${APP_NAME} >/dev/null <<EOF
server {
    listen 80;
    server_name ${IP};

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:${APP_PORT};
        proxy_http_version 1.1;
        proxy_set_header Host              \$host;
        proxy_set_header X-Real-IP         \$remote_addr;
        proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }
}
EOF
  $SUDO ln -sf /etc/nginx/sites-available/${APP_NAME} /etc/nginx/sites-enabled/${APP_NAME}
  $SUDO rm -f /etc/nginx/sites-enabled/default
  $SUDO nginx -t
  $SUDO systemctl reload nginx
  $SUDO ufw allow 'Nginx HTTP' >/dev/null 2>&1 || $SUDO ufw allow 80/tcp
  ACCESO="http://${IP}"
else
  $SUDO ufw allow ${APP_PORT}/tcp
  IP="$(curl -fsS https://api.ipify.org || echo TU_IP)"
  ACCESO="http://${IP}:${APP_PORT}"
fi

$SUDO ufw --force enable

# ------------------------------ 8. verificar ---------------------------
say "Verificando"
sleep 2
curl -fsS -o /dev/null -w "HTTP local: %{http_code}\n" "http://localhost:${APP_PORT}" || warn "La app no responde en localhost:${APP_PORT} (revisa: pm2 logs ${APP_NAME})"
pm2 status

cat <<EOF

============================================================
  Despliegue listo.

  URL:      ${ACCESO}
  Usuario:  ${ADMIN_USER}
  Clave:    ${ADMIN_PASS}

  (El usuario solo se crea en el PRIMER arranque, cuando la
   base de datos esta vacia.)

  Logs:        pm2 logs ${APP_NAME}
  Reiniciar:   pm2 restart ${APP_NAME} --update-env
  Actualizar:  git pull && npm install --omit=dev && pm2 restart ${APP_NAME} --update-env
============================================================
EOF
