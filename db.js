'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'crt.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

/* ------------------------------- esquema ---------------------------------
   Modelo de plata:
   - Un ingreso o un gasto es un DOCUMENTO: tiene base gravable, IVA, retención
     y un total (monto) siempre expresado en pesos colombianos.
   - Lo que de verdad mueve caja son los ABONOS. Un documento puede tener
     varios: por eso existen los pagos parciales y el estado "parcial".
   - Los reportes de utilidad se arman con los abonos (base caja de verdad),
     no con la fecha del documento.
-------------------------------------------------------------------------- */

db.exec(`
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY,
  usuario TEXT UNIQUE NOT NULL,
  hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS lineas (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'app',       -- app | servicio | producto | reparacion
  color TEXT NOT NULL DEFAULT '#0E7A4F',
  activa INTEGER NOT NULL DEFAULT 1,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  negocio TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  ciudad TEXT DEFAULT '',
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ingresos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,                    -- YYYY-MM-DD, fecha del documento
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  concepto TEXT NOT NULL,
  base INTEGER NOT NULL DEFAULT 0,        -- base gravable en COP
  iva_pct REAL NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,
  rete_pct REAL NOT NULL DEFAULT 0,       -- retención que te practica el cliente
  rete INTEGER NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'COP',
  trm REAL NOT NULL DEFAULT 1,
  monto_origen INTEGER NOT NULL DEFAULT 0,-- base en la moneda original
  monto INTEGER NOT NULL,                 -- total a cobrar en COP: base + iva - rete
  abonado INTEGER NOT NULL DEFAULT 0,     -- suma de abonos recibidos
  metodo TEXT DEFAULT 'nequi',
  estado TEXT NOT NULL DEFAULT 'pagado',  -- pagado | parcial | pendiente
  fecha_pago TEXT,                        -- fecha del abono que lo terminó de saldar
  vence TEXT,
  suscripcion_id INTEGER REFERENCES suscripciones(id) ON DELETE SET NULL,
  venta_id INTEGER REFERENCES ventas(id) ON DELETE CASCADE,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS gastos (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,  -- NULL = gasto general
  categoria TEXT NOT NULL DEFAULT 'otros',
  concepto TEXT NOT NULL,
  base INTEGER NOT NULL DEFAULT 0,
  iva_pct REAL NOT NULL DEFAULT 0,
  iva INTEGER NOT NULL DEFAULT 0,         -- IVA descontable
  rete_pct REAL NOT NULL DEFAULT 0,       -- retención que TÚ le practicas al proveedor
  rete INTEGER NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'COP',
  trm REAL NOT NULL DEFAULT 1,
  monto_origen INTEGER NOT NULL DEFAULT 0,
  monto INTEGER NOT NULL,
  abonado INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL DEFAULT 'variable',  -- fijo | variable
  metodo TEXT DEFAULT 'nequi',
  estado TEXT NOT NULL DEFAULT 'pagado',  -- pagado | parcial | pendiente
  fecha_pago TEXT,
  vence TEXT,
  proveedor TEXT DEFAULT '',
  recurrente_id INTEGER REFERENCES gastos_recurrentes(id) ON DELETE SET NULL,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

-- Movimientos reales de plata. Un documento se salda con uno o varios abonos.
CREATE TABLE IF NOT EXISTS abonos (
  id INTEGER PRIMARY KEY,
  tipo TEXT NOT NULL,                     -- ingreso | gasto
  doc_id INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  monto INTEGER NOT NULL,
  metodo TEXT DEFAULT 'nequi',
  nota TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suscripciones (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  concepto TEXT NOT NULL,
  monto INTEGER NOT NULL,
  iva_pct REAL NOT NULL DEFAULT 0,
  rete_pct REAL NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'COP',
  ciclo TEXT NOT NULL DEFAULT 'mensual',  -- mensual | anual
  proxima_fecha TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

-- El espejo de suscripciones, para lo que TÚ pagas todos los meses.
CREATE TABLE IF NOT EXISTS gastos_recurrentes (
  id INTEGER PRIMARY KEY,
  concepto TEXT NOT NULL,
  monto INTEGER NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'servidores',
  tipo TEXT NOT NULL DEFAULT 'fijo',
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  proveedor TEXT DEFAULT '',
  metodo TEXT DEFAULT 'nequi',
  iva_pct REAL NOT NULL DEFAULT 0,
  rete_pct REAL NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'COP',
  trm REAL NOT NULL DEFAULT 1,
  ciclo TEXT NOT NULL DEFAULT 'mensual',  -- mensual | anual
  proxima_fecha TEXT NOT NULL,
  activa INTEGER NOT NULL DEFAULT 1,
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY,
  nombre TEXT NOT NULL,
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  sku TEXT DEFAULT '',
  costo_unitario INTEGER NOT NULL DEFAULT 0,
  precio_venta INTEGER NOT NULL DEFAULT 0,
  stock INTEGER NOT NULL DEFAULT 0,
  stock_minimo INTEGER NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY,
  producto_id INTEGER NOT NULL REFERENCES productos(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL,
  tipo TEXT NOT NULL,                     -- entrada | salida | ajuste
  cantidad INTEGER NOT NULL,
  costo_unitario INTEGER NOT NULL DEFAULT 0,
  nota TEXT DEFAULT '',
  venta_id INTEGER REFERENCES ventas(id) ON DELETE CASCADE,
  gasto_id INTEGER REFERENCES gastos(id) ON DELETE SET NULL,
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  cantidad INTEGER NOT NULL DEFAULT 1,
  precio_unitario INTEGER NOT NULL,
  costo_unitario INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL,
  metodo TEXT DEFAULT 'efectivo',
  estado TEXT NOT NULL DEFAULT 'pagado',  -- pagado | parcial | pendiente
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

-- Quién tocó qué. Una app de plata no puede no tener esto.
CREATE TABLE IF NOT EXISTS bitacora (
  id INTEGER PRIMARY KEY,
  fecha TEXT NOT NULL,
  usuario TEXT DEFAULT '',
  accion TEXT NOT NULL,                   -- crear | editar | borrar | restaurar | abonar | ...
  tabla TEXT NOT NULL,
  registro_id INTEGER,
  detalle TEXT DEFAULT '',
  creado TEXT NOT NULL
);

-- Papelera: nada se borra de verdad hasta que la vacíes.
CREATE TABLE IF NOT EXISTS papelera (
  id INTEGER PRIMARY KEY,
  tabla TEXT NOT NULL,
  registro_id INTEGER NOT NULL,
  resumen TEXT DEFAULT '',
  datos TEXT NOT NULL,                    -- JSON: { principal, dependientes }
  usuario TEXT DEFAULT '',
  creado TEXT NOT NULL
);

`);

/* ------------------------------ migraciones ------------------------------ */
// Cada paso es idempotente y corre una sola vez (user_version arranca en 0).
// En una base nueva los pasos no encuentran nada que hacer y pasan de largo.

const columnas = (tabla) => db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);

function agregarColumna(tabla, col, definicion) {
  if (!columnas(tabla).includes(col)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${col} ${definicion}`);
  }
}

const PASOS = [
  // v1: impuestos, multimoneda, abonos, cuentas por pagar, auditoría.
  (d) => {
    const fiscales = [
      ['base', 'INTEGER NOT NULL DEFAULT 0'],
      ['iva_pct', 'REAL NOT NULL DEFAULT 0'],
      ['iva', 'INTEGER NOT NULL DEFAULT 0'],
      ['rete_pct', 'REAL NOT NULL DEFAULT 0'],
      ['rete', 'INTEGER NOT NULL DEFAULT 0'],
      ['moneda', "TEXT NOT NULL DEFAULT 'COP'"],
      ['trm', 'REAL NOT NULL DEFAULT 1'],
      ['monto_origen', 'INTEGER NOT NULL DEFAULT 0'],
      ['abonado', 'INTEGER NOT NULL DEFAULT 0'],
      ['vence', 'TEXT'],
    ];
    for (const [col, def] of fiscales) {
      agregarColumna('ingresos', col, def);
      agregarColumna('gastos', col, def);
    }
    // Los gastos no tenían ni estado ni fecha de pago: nacen como pagados.
    agregarColumna('gastos', 'estado', "TEXT NOT NULL DEFAULT 'pagado'");
    agregarColumna('gastos', 'fecha_pago', 'TEXT');
    agregarColumna('gastos', 'recurrente_id', 'INTEGER');
    agregarColumna('suscripciones', 'iva_pct', 'REAL NOT NULL DEFAULT 0');
    agregarColumna('suscripciones', 'rete_pct', 'REAL NOT NULL DEFAULT 0');
    agregarColumna('suscripciones', 'moneda', "TEXT NOT NULL DEFAULT 'COP'");

    // Base gravable de lo viejo = el total, sin impuestos discriminados.
    d.exec(`UPDATE ingresos SET base = monto, monto_origen = monto WHERE base = 0`);
    d.exec(`UPDATE gastos   SET base = monto, monto_origen = monto WHERE base = 0`);

    // Todo ingreso marcado pagado se convierte en un abono por el total,
    // fechado el día en que se cobró. Así el reporte de caja cuadra.
    d.exec(`
      INSERT INTO abonos (tipo, doc_id, fecha, monto, metodo, nota, creado)
      SELECT 'ingreso', id, COALESCE(fecha_pago, fecha), monto, COALESCE(metodo,'nequi'), 'migración v1', datetime('now')
      FROM ingresos WHERE estado = 'pagado'
        AND NOT EXISTS (SELECT 1 FROM abonos a WHERE a.tipo='ingreso' AND a.doc_id = ingresos.id)`);
    d.exec(`UPDATE ingresos SET abonado = monto WHERE estado = 'pagado'`);

    // Los gastos viejos se registraban ya pagados.
    d.exec(`
      INSERT INTO abonos (tipo, doc_id, fecha, monto, metodo, nota, creado)
      SELECT 'gasto', id, fecha, monto, COALESCE(metodo,'nequi'), 'migración v1', datetime('now')
      FROM gastos
      WHERE NOT EXISTS (SELECT 1 FROM abonos a WHERE a.tipo='gasto' AND a.doc_id = gastos.id)`);
    d.exec(`UPDATE gastos SET abonado = monto, estado = 'pagado', fecha_pago = COALESCE(fecha_pago, fecha)`);
  },
];

function migrar() {
  const v = db.pragma('user_version', { simple: true });
  for (let i = v; i < PASOS.length; i++) {
    db.transaction(() => PASOS[i](db))();
    db.pragma('user_version = ' + (i + 1));
    console.log(`[crt] migración aplicada: v${i + 1}`);
  }
}
migrar();

// Los índices van DESPUÉS de migrar: algunos cuelgan de columnas que la
// migración acaba de añadir (p.ej. gastos.estado en bases anteriores a v1).
db.exec(`
CREATE INDEX IF NOT EXISTS idx_ingresos_fecha ON ingresos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_ingresos_estado ON ingresos(estado);
CREATE INDEX IF NOT EXISTS idx_gastos_estado ON gastos(estado);
CREATE INDEX IF NOT EXISTS idx_abonos_doc ON abonos(tipo, doc_id);
CREATE INDEX IF NOT EXISTS idx_abonos_fecha ON abonos(fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos(producto_id);
CREATE INDEX IF NOT EXISTS idx_bitacora_fecha ON bitacora(fecha);
`);

// Semilla de líneas de negocio en la primera ejecución
const hayLineas = db.prepare('SELECT COUNT(*) c FROM lineas').get().c;
if (!hayLineas) {
  const ins = db.prepare(
    `INSERT INTO lineas (nombre, tipo, color, activa, notas, creado)
     VALUES (?, ?, ?, 1, '', datetime('now'))`
  );
  [
    ['GigantYA', 'app', '#E4571B'],
    ['Daemon Leads', 'app', '#0E7A4F'],
    ['AgroValor', 'app', '#7A6A15'],
    ['Tarjetas NFC', 'producto', '#2C5F8A'],
    ['Webs a clientes', 'servicio', '#6B3FA0'],
    ['Reparaciones', 'reparacion', '#B3402B'],
  ].forEach((l) => ins.run(...l));
}

module.exports = db;
