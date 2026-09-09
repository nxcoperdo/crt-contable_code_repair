# CRT Contable

Panel financiero de Code Repair Tech. Node + Express + SQLite, sin build ni dependencias de frontend.

Responde a cuatro preguntas, en ese orden:

1. Cuánto te quedó limpio este mes
2. Cuál línea (GigantYA, Daemon Leads, AgroValor, NFC, webs, reparaciones) deja plata y cuál sangra
3. Quién te debe y hace cuántos días
4. Cuánto pagas fijo cada mes y cuánto tienes que vender para no perder

## Instalar en el VPS

```bash
cd /var/www
git clone <tu-repo> crt-contable   # o sube la carpeta por scp
cd crt-contable
npm install --omit=dev
```

Crea el archivo `.env` **o** pasa las variables directo a pm2:

| Variable | Para qué |
|---|---|
| `PORT` | Puerto interno (por defecto 4300) |
| `ADMIN_USER` | Tu usuario, solo se usa la primera vez |
| `ADMIN_PASS` | Tu clave, solo se usa la primera vez |
| `SESSION_SECRET` | Cadena larga y aleatoria. Si cambia, se cierran las sesiones |
| `DATA_DIR` | Dónde vive `crt.db` (por defecto `./data`) |
| `NODE_ENV` | Ponlo en `production` para que la cookie sea Secure |

Genera el secreto con: `openssl rand -hex 32`

## Levantar con pm2

```bash
pm2 start server.js --name crt-contable \
  --env production \
  --update-env
pm2 save
```

O con `ecosystem.config.js` (incluido) para no exponer las claves en el shell:

```bash
pm2 start ecosystem.config.js
pm2 save
```

## nginx + HTTPS

```nginx
server {
    server_name contable.tudominio.com;

    location / {
        proxy_pass http://127.0.0.1:4300;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo certbot --nginx -d contable.tudominio.com
```

Después de tener HTTPS, arranca con `NODE_ENV=production` para que la cookie viaje segura.

## Cobros automáticos

Para que las suscripciones vencidas se conviertan solas en cuentas por cobrar, un cron diario:

```bash
crontab -e
# todos los días 7am
0 7 * * * curl -s -X POST http://127.0.0.1:4300/api/suscripciones/generar-vencidas -H 'Cookie: crt_sesion=TU_TOKEN' > /dev/null
```

Saca el token de la cookie `crt_sesion` desde el navegador (DevTools → Application → Cookies). O simplemente entra al panel y aprieta "Generar cobros vencidos" cuando quieras.

## Respaldo

La base es un solo archivo. Respáldala con:

```bash
sqlite3 data/crt.db ".backup '/root/backups/crt-$(date +%F).db'"
```

Cron semanal recomendado. También puedes bajar todo en JSON desde `/api/backup` o en CSV desde la vista Reportes.

## Cómo funciona la contabilidad

- **Base caja.** Un ingreso cuenta cuando está marcado como pagado; un gasto cuenta el día que lo registras.
- **Cuentas por cobrar.** Los ingresos en estado "por cobrar" no suman a la utilidad, pero salen en "Quién te debe".
- **Inventario.** Cuando registras una entrada de producto, se crea el gasto de la compra en ese momento. La venta después solo genera ingreso, para no contar el costo dos veces. El margen por unidad se muestra aparte, como referencia.
- **Gastos fijos vs variables.** Marca como fijo lo que pagas todos los meses (VPS, dominios, APIs). El punto de equilibrio se calcula con esos fijos y tu margen de contribución del mes.
- **MRR.** Suma de suscripciones activas, con las anuales divididas entre 12.

## Estructura

```
server.js       API (CRUD genérico + acciones + reportes + export)
db.js           esquema SQLite y semilla de líneas
auth.js         login con scrypt y cookie firmada, sin dependencias
public/         panel (index.html, styles.css, app.js)
data/crt.db     tu base de datos
```

## Añadir cosas después

- **Facturación DIAN:** una tabla `facturas` colgando de `ingresos` y el cliente de tu proveedor tecnológico.
- **Datos reales de GigantYA:** un cron que lea la base de GigantYA y cree los ingresos del mes automáticamente en vez de escribirlos a mano.
- **Multiusuario:** ya existe la tabla `usuarios`; falta una columna de rol y filtrar por ella.
