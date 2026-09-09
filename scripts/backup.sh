#!/usr/bin/env bash
#
# Respaldo de la base de crt-contable.
#
#   ./scripts/backup.sh [ruta/al/crt.db]
#
# Variables opcionales:
#   BACKUP_DIR       carpeta local de respaldos   (def. /root/backups)
#   RETENER_DIAS     borra respaldos más viejos    (def. 60)
#   TELEGRAM_TOKEN   token del bot para copia off-site
#   TELEGRAM_CHAT    chat/canal donde enviar el archivo
#
# Cron diario 3am:
#   0 3 * * *  /opt/crt-contable/scripts/backup.sh >> /var/log/crt-backup.log 2>&1
#
set -euo pipefail

DB="${1:-/opt/crt-contable/data/crt.db}"
DEST="${BACKUP_DIR:-/root/backups}"
RETENER_DIAS="${RETENER_DIAS:-60}"

[ -f "$DB" ] || { echo "No existe la base: $DB" >&2; exit 1; }
command -v sqlite3 >/dev/null || { echo "Falta sqlite3 (sudo apt install -y sqlite3)" >&2; exit 1; }

mkdir -p "$DEST"
STAMP="$(date +%F_%H%M)"
OUT="$DEST/crt-$STAMP.db"

sqlite3 "$DB" ".backup '$OUT'"
gzip -f "$OUT"
ARCHIVO="$OUT.gz"

# rotación local
find "$DEST" -name 'crt-*.db.gz' -mtime "+$RETENER_DIAS" -delete

# copia off-site por Telegram (opcional)
if [ -n "${TELEGRAM_TOKEN:-}" ] && [ -n "${TELEGRAM_CHAT:-}" ]; then
  if curl -sf -F chat_id="$TELEGRAM_CHAT" -F document=@"$ARCHIVO" \
       "https://api.telegram.org/bot$TELEGRAM_TOKEN/sendDocument" >/dev/null; then
    echo "$(date +%FT%T) copia enviada a Telegram"
  else
    echo "$(date +%FT%T) ADVERTENCIA: falló el envío a Telegram" >&2
  fi
fi

echo "$(date +%FT%T) OK $ARCHIVO ($(du -h "$ARCHIVO" | cut -f1))"
