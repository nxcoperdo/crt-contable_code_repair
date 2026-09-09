# Despliegue de crt-contable en un VPS (acceso por IP, sin dominio)

Panel: Express 5 + SQLite (better-sqlite3). Escucha en el puerto **4300** en todas las interfaces.
Guía para Ubuntu 22.04 / 24.04 o Debian 12.

---

## 0. Antes de empezar

Necesitas:
- Un VPS con Ubuntu/Debian y acceso `root` o un usuario con `sudo`.
- La IP pública del VPS (ej. `203.0.113.45`).
- El código del proyecto (repo Git o subida por `scp`).

> **Nota de seguridad importante:** si accedes por `http://IP` (sin HTTPS), **NO** pongas
> `NODE_ENV=production`. Con `NODE_ENV=production` la cookie de sesión lleva el flag `Secure`
> y el navegador solo la manda por HTTPS → no podrías iniciar sesión. Sin ese flag, la cookie
> viaja sin cifrar, así que trátalo como algo temporal hasta tener un dominio + HTTPS.

---

## 1. Conectarse y actualizar el sistema

```bash
ssh root@203.0.113.45

apt update && apt upgrade -y
```

## 2. Crear un usuario para la app (opcional pero recomendado)

```bash
adduser crt
usermod -aG sudo crt
su - crt
```

El resto de la guía asume que trabajas como este usuario (`/home/crt`).

## 3. Instalar Node 22 LTS y herramientas de compilación

`better-sqlite3` se compila al instalar, así que hacen falta `build-essential` y `python3`.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs build-essential python3

node -v    # v22.x
npm -v
```

## 4. Traer el código al VPS

**Opción con Git:**

```bash
cd ~
git clone https://github.com/nxcoperdo/crt-contable_code_repair.git crt-contable
cd crt-contable
```

**Opción con scp (desde tu PC Windows, en PowerShell):**

```powershell
scp -r "C:\Users\ASUS\OneDrive\Desktop\crt-contable" crt@203.0.113.45:/home/crt/crt-contable
```

## 5. Instalar dependencias

```bash
cd ~/crt-contable
npm install --omit=dev
```

Si `better-sqlite3` falla, casi siempre es por falta de `build-essential` / `python3` (paso 3).

## 6. Instalar PM2 y configurar credenciales

```bash
sudo npm install -g pm2
```

Genera el secreto de sesión:

```bash
openssl rand -hex 32
```

Edita `ecosystem.config.js` y reemplaza los valores:

```js
module.exports = {
  apps: [
    {
      name: 'crt-contable',
      script: 'server.js',
      instances: 1,
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        // NO pongas NODE_ENV: 'production' si entras por http://IP (ver nota del paso 0)
        PORT: 4300,
        DATA_DIR: '/home/crt/crt-contable/data',
        ADMIN_USER: 'nico',
        ADMIN_PASS: 'TU-CLAVE-REAL-AQUI',
        SESSION_SECRET: 'PEGA-AQUI-EL-openssl-rand-hex-32',
      },
    },
  ],
};
```

> `ADMIN_USER` / `ADMIN_PASS` solo se usan para crear el usuario en el **primer arranque**
> (cuando la tabla `usuarios` está vacía). Cambiarlos después no cambia la clave; para eso
> hay que tocar la base de datos.

Evita que un `git pull` te pise las credenciales:

```bash
git update-index --skip-worktree ecosystem.config.js
```

## 7. Arrancar la app

```bash
cd ~/crt-contable
pm2 start ecosystem.config.js
pm2 logs crt-contable        # deberías ver "[crt] Contable arriba en http://localhost:4300"
pm2 save
```

Auto-arranque al reiniciar el VPS:

```bash
pm2 startup systemd
# copia y ejecuta el comando "sudo env PATH=..." que imprime
pm2 save
```

---

## 8A. Opción A — Acceso directo por `http://IP:4300`

La app ya escucha en todas las interfaces, solo hay que abrir el puerto en el firewall.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 4300/tcp
sudo ufw enable
sudo ufw status
```

Abre en el navegador: **`http://203.0.113.45:4300`**

## 8B. Opción B — Nginx como proxy inverso en el puerto 80 (`http://IP`)

Más limpio (sin `:4300` en la URL) y te deja añadir HTTPS después.

```bash
sudo apt install -y nginx
sudo nano /etc/nginx/sites-available/crt-contable
```

Contenido:

```nginx
server {
    listen 80;
    server_name 203.0.113.45;   # tu IP, o "_" para cualquier host

    client_max_body_size 2m;

    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_http_version 1.1;
        proxy_set_header Host              $host;
        proxy_set_header X-Real-IP         $remote_addr;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Activar:

```bash
sudo ln -s /etc/nginx/sites-available/crt-contable /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t
sudo systemctl reload nginx
```

Firewall (el 4300 queda solo interno):

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx HTTP'
sudo ufw enable
```

Abre: **`http://203.0.113.45`**

---

## 9. Verificar

```bash
curl -I http://localhost:4300          # en el VPS
pm2 status
```

Entra con `ADMIN_USER` / `ADMIN_PASS`. Si el login "no hace nada" o te devuelve al
formulario: casi seguro dejaste `NODE_ENV=production` con acceso HTTP. Quítalo:

```bash
pm2 restart crt-contable --update-env    # tras editar ecosystem.config.js
```

## 10. Actualizar la app más adelante

```bash
cd ~/crt-contable
git pull
npm install --omit=dev
pm2 restart crt-contable --update-env
```

## 11. Backups de la base de datos

La base está en `DATA_DIR/crt.db` (con archivos `-wal` / `-shm`).

Backup manual:

```bash
sudo apt install -y sqlite3
mkdir -p ~/backups
sqlite3 ~/crt-contable/data/crt.db ".backup '$HOME/backups/crt-$(date +%F).db'"
```

Cron semanal (domingo 3am) — `crontab -e`:

```cron
0 3 * * 0 sqlite3 /home/crt/crt-contable/data/crt.db ".backup '/home/crt/backups/crt-$(date +\%F).db'" && find /home/crt/backups -name 'crt-*.db' -mtime +60 -delete
```

## 12. (Opcional) Generar ingresos de suscripciones vencidas automáticamente

El endpoint `POST /api/suscripciones/generar-vencidas` requiere sesión. Para automatizarlo
por cron necesitas un token de sesión válido (cookie `crt_sesion`) obtenido de un login,
o correrlo manualmente desde el panel. Lo más simple: entrar al panel una vez al mes y
pulsar el botón correspondiente.

---

## Próximos pasos recomendados

1. Comprar un dominio y apuntarlo a la IP.
2. Añadir HTTPS con Certbot (`sudo certbot --nginx`).
3. Recién ahí, poner `NODE_ENV: 'production'` en `ecosystem.config.js` y reiniciar.
