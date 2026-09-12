# CRT Contable

Panel financiero de Code Repair Tech. Node + Express + SQLite, sin build ni dependencias de frontend.

Responde a seis preguntas, en ese orden:

1. Cuánto te quedó limpio este mes (plata que de verdad se movió)
2. Cuál línea (GigantYA, Daemon Leads, AgroValor, NFC, webs, reparaciones) deja plata y cuál sangra
3. Quién te debe y hace cuántos días
4. A quién le debes tú y cuándo vence
5. Cuánto pagas fijo cada mes y cuánto tienes que vender para no perder
6. Cuánto IVA y cuánta retención te tocan este mes

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
| `ZONA_HORARIA` | Zona con la que se fechan los movimientos (por defecto `America/Bogota`) |

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

Para que las suscripciones vencidas se conviertan solas en cuentas por cobrar, define
`CRON_SECRET` (otro `openssl rand -hex 32`) y programa un cron diario:

```bash
crontab -e
# todos los días 7am
0 7 * * * curl -s -X POST "http://127.0.0.1:4300/api/cron/suscripciones?key=EL_CRON_SECRET" > /dev/null
```

Ese endpoint no necesita sesión (se autentica con la clave) y hace dos cosas: convierte
las suscripciones vencidas en cuentas por cobrar **y** los pagos fijos vencidos (VPS,
dominios, APIs) en cuentas por pagar. O entra al panel y aprieta "Generar cobros vencidos"
en **Cobros** y "Generar pagos vencidos" en **Pagos fijos**.

## Recordatorios de cartera

Un resumen diario por Telegram de lo que está por vencer o ya venció (cuentas por cobrar
y por pagar), para no tener que entrar al panel a acordarte. Reutiliza el mismo bot que
manda el backup off-site (ver más abajo): define `TELEGRAM_TOKEN` y `TELEGRAM_CHAT`, y
programa un cron diario (por ejemplo a las 8am):

```bash
crontab -e
0 8 * * * curl -s -X POST "http://127.0.0.1:4300/api/cron/recordatorios?key=$CRON_SECRET" > /dev/null
```

`RECORDATORIOS_DIAS_ANTES` (por defecto 3) controla con cuántos días de anticipación
avisa una cuenta próxima a vencer; lo ya vencido siempre se avisa. Si no hay nada
pendiente en la ventana, no manda mensaje. También puedes mandarlo a mano desde el panel
con el botón **Enviar recordatorios ahora** en el Panel, junto a "Quién te debe".

Además, cada fila de "Quién te debe" que tenga un cliente con teléfono guardado trae un
botón **WhatsApp** que abre un mensaje de cobro prellenado directo al cliente (no aplica
a "Lo que debes": el proveedor es texto libre, sin teléfono).

## Respaldo

La base es un solo archivo. Usa el script incluido:

```bash
./scripts/backup.sh                       # respaldo local en /root/backups, rota a 60 días
BACKUP_DIR=/mnt/disco ./scripts/backup.sh  # otra carpeta
```

Para copia off-site automática, exporta `TELEGRAM_TOKEN` y `TELEGRAM_CHAT` (un bot de
Telegram) antes de llamarlo. Cron diario recomendado:

```bash
0 3 * * * /opt/crt-contable/scripts/backup.sh >> /var/log/crt-backup.log 2>&1
```

También puedes bajar todo en JSON desde `/api/backup` o en CSV desde la vista Reportes.

## Seguridad

- Login con límite de intentos: 5 fallos por IP → bloqueo de 15 min.
- Cabeceras: CSP, `X-Frame-Options`, `nosniff`, y HSTS cuando `NODE_ENV=production`.
- Detrás de nginx, pon `TRUST_PROXY=1` para que el límite de intentos vea la IP real.
- Cambiar la contraseña desde el panel: botón **Cuenta** arriba a la derecha.

## Cómo funciona la contabilidad

- **Base caja de verdad.** La utilidad de un mes sale de los **abonos** de ese mes, no de la
  fecha de la factura. Una factura de enero que cobras en marzo es plata de marzo. (Antes se
  contaba en enero, así que un mes ya cerrado cambiaba solo cuando te pagaban.)
- **Abonos.** Un ingreso o un gasto puede cobrarse o pagarse por partes. El estado sale solo:
  `pendiente` → `parcial` → `pagado`. El botón **Abonos** de cada fila muestra el saldo y el
  historial.
- **Cuentas por cobrar y por pagar.** Un gasto también puede quedar debiendo: el panel tiene
  "Quién te debe" y "Lo que debes", y Reportes trae la cartera por antigüedad (al día, 1–30,
  31–60, 61–90, +90 días).
- **Impuestos.** Cada documento se arma con `base + IVA − retención = total`. El reporte de
  IVA y retenciones se causa con la **fecha del documento** (no con la del pago), que es como
  se declara.
- **Moneda.** Si pagas en USD o EUR, escribes la base en esa moneda y la TRM; el sistema
  guarda todo en pesos y recuerda el valor original.
- **Inventario.** Una entrada de producto crea el gasto de la compra (que puedes dejar
  debiendo). La venta después solo genera ingreso, para no contar el costo dos veces. Cada
  entrada, salida y ajuste queda en el **kardex**.
- **Gastos fijos vs variables.** Marca como fijo lo que pagas todos los meses. Si se repite,
  créalo en **Pagos fijos** y se registra solo: el punto de equilibrio deja de quedarse corto
  porque se te olvidó cargar el VPS.
- **Punto de equilibrio.** Se calcula con los fijos del mes y tu margen de contribución.
- **MRR.** Suma de suscripciones activas, con las anuales divididas entre 12.
- **Nada se borra de golpe.** Lo que borras cae en la **Papelera** con todo lo que colgaba de
  ello; restaurar una venta devuelve su ingreso, sus abonos y vuelve a descontar el stock.
  Toda acción queda en la **bitácora**.
- **Zona horaria.** Todo se fecha en hora de Colombia (`ZONA_HORARIA`, por defecto
  `America/Bogota`). Con UTC, lo registrado después de las 7 p.m. caía al día siguiente.

## Estructura

```
server.js         API (CRUD genérico + abonos + acciones + reportes + export)
db.js             esquema SQLite, migraciones y semilla de líneas
auth.js           login con scrypt y cookie firmada, sin dependencias
public/           panel (index.html, styles.css, app.js, sw.js)
scripts/prueba.js prueba de extremo a extremo: npm run prueba
scripts/backup.sh respaldo de la base
data/crt.db       tu base de datos
```

El esquema se migra solo al arrancar (`user_version` de SQLite). Una base con datos
viejos se actualiza sin perder nada: los ingresos ya marcados como pagados se convierten
en abonos con su fecha de cobro real.

## Añadir cosas después

- **Facturación electrónica DIAN:** ya está el desglose fiscal (base, IVA, retención); falta
  una tabla `facturas` colgando de `ingresos` y el cliente de tu proveedor tecnológico.
- **Datos reales de GigantYA:** un cron que lea la base de GigantYA y cree los ingresos del mes
  automáticamente en vez de escribirlos a mano.
- **Multiusuario:** ya existe la tabla `usuarios`; falta una columna de rol y filtrar por ella.
- **TRM automática:** hoy la escribes a mano en cada documento en dólares; podría bajarse sola.

## Pruebas

```bash
npm run prueba
```

Levanta el servidor contra una base temporal y comprueba de punta a punta el cálculo de
impuestos, los abonos parciales, la base caja, el stock al borrar y restaurar ventas, las
cuentas por pagar y la papelera.
