'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'crt.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

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
  fecha TEXT NOT NULL,                    -- YYYY-MM-DD
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  concepto TEXT NOT NULL,
  monto INTEGER NOT NULL,                 -- pesos, sin decimales
  metodo TEXT DEFAULT 'nequi',
  estado TEXT NOT NULL DEFAULT 'pagado',  -- pagado | pendiente
  fecha_pago TEXT,
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
  monto INTEGER NOT NULL,
  tipo TEXT NOT NULL DEFAULT 'variable',  -- fijo | variable
  metodo TEXT DEFAULT 'nequi',
  proveedor TEXT DEFAULT '',
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS suscripciones (
  id INTEGER PRIMARY KEY,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  linea_id INTEGER REFERENCES lineas(id) ON DELETE SET NULL,
  concepto TEXT NOT NULL,
  monto INTEGER NOT NULL,
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
  estado TEXT NOT NULL DEFAULT 'pagado',  -- pagado | pendiente
  notas TEXT DEFAULT '',
  creado TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_ingresos_fecha ON ingresos(fecha);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos(fecha);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_ingresos_estado ON ingresos(estado);
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

/* ------------------------------ migraciones ------------------------------ */
// Cada paso es idempotente donde se pueda y corre una sola vez.
// user_version arranca en 0; se sube uno por paso aplicado.
const PASOS = [
  // v1, v2, ... se agregan aquí a medida que evoluciona el esquema.
];

function migrar() {
  let v = db.pragma('user_version', { simple: true });
  for (let i = v; i < PASOS.length; i++) {
    db.transaction(() => PASOS[i](db))();
    db.pragma('user_version = ' + (i + 1));
    console.log(`[crt] migración aplicada: v${i + 1}`);
  }
}
migrar();

module.exports = db;
