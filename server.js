'use strict';
const path = require('path');
const express = require('express');
const db = require('./db');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 4300;

// Detrás de nginx: TRUST_PROXY=1 para que req.ip sea la IP real del cliente.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || 1);

const CSP = [
  "default-src 'self'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com",
  "img-src 'self' data:",
  "script-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', CSP);
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }
  next();
});

app.use(express.json({ limit: '8mb' }));

// El service worker debe revalidarse siempre para que los cambios lleguen rápido.
app.get('/sw.js', (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.type('application/javascript');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

// Assets con ETag y revalidación (304 si no cambió); el SW es la capa de caché real.
app.use(
  express.static(path.join(__dirname, 'public'), {
    etag: true,
    maxAge: 0,
    setHeaders: (res) => res.set('Cache-Control', 'no-cache'),
  })
);

auth.asegurarAdmin();

/* -------------------------------- fechas ---------------------------------
   Todo se fecha en hora de Colombia. Con UTC, cualquier cosa registrada
   después de las 7 p.m. caía al día siguiente (y del mes siguiente el día 31).
-------------------------------------------------------------------------- */

const ZONA = process.env.ZONA_HORARIA || 'America/Bogota';
const fmtDia = new Intl.DateTimeFormat('en-CA', {
  timeZone: ZONA,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const hoy = () => fmtDia.format(new Date());
const mesDe = (f) => String(f).slice(0, 7);
const entero = (v) => Math.round(Number(v) || 0);

// Suma meses a un YYYY-MM-DD sin que la zona horaria mueva el día.
function sumarMeses(fecha, n) {
  const [a, m, d] = String(fecha).split('-').map(Number);
  const base = new Date(Date.UTC(a, m - 1 + n, 1));
  const ultimoDia = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
  base.setUTCDate(Math.min(d, ultimoDia));
  return base.toISOString().slice(0, 10);
}
const mesMas = (mes, n) => sumarMeses(mes + '-01', n).slice(0, 7);
const diasEntre = (desde, hasta) =>
  Math.round((Date.parse(hasta + 'T00:00:00Z') - Date.parse(desde + 'T00:00:00Z')) / 864e5);

function ok(res, fn) {
  try {
    return res.json(fn());
  } catch (e) {
    console.error(e);
    return res.status(400).json({ error: e.message });
  }
}

// req.body es undefined en Express 5 cuando no llega JSON.
const cuerpo = (req) => (req.body && typeof req.body === 'object' ? req.body : {});

/* ------------------------------- bitácora -------------------------------- */

const anotar = db.prepare(
  `INSERT INTO bitacora (fecha, usuario, accion, tabla, registro_id, detalle, creado)
   VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
);
function bitacora(req, accion, tabla, registroId, detalle = '') {
  try {
    anotar.run(hoy(), (req && req.usuario) || 'sistema', accion, tabla, registroId ?? null, String(detalle).slice(0, 500));
  } catch (e) {
    console.error('[crt] no se pudo escribir la bitácora:', e.message);
  }
}

/* ---------------------------------- auth --------------------------------- */

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'desconocida';
  const puerta = auth.loginPermitido(ip);
  if (!puerta.ok) {
    return res.status(429).json({ error: `Demasiados intentos fallidos. Espera ${puerta.esperaSegundos} s.` });
  }
  const { usuario, clave } = cuerpo(req);
  const u = auth.verificar(String(usuario || ''), String(clave || ''));
  if (!u) {
    auth.loginFallido(ip);
    return res.status(401).json({ error: 'Usuario o clave incorrectos.' });
  }
  auth.loginOk(ip);
  auth.darSesion(res, u);
  bitacora({ usuario: u.usuario }, 'entrar', 'usuarios', u.id, ip);
  res.json({ usuario: u.usuario });
});

app.post('/api/logout', (req, res) => {
  auth.cerrarSesion(res);
  res.json({ ok: true });
});

app.get('/api/yo', (req, res) => {
  const s = auth.abrir(auth.cookies(req).crt_sesion);
  if (!s) return res.status(401).json({ error: 'sin sesion' });
  res.json({ usuario: s.u, hoy: hoy(), zona: ZONA });
});

// Tarea programada: no requiere sesión, se autentica con CRON_SECRET.
//   0 7 * * *  curl -s -X POST "http://127.0.0.1:4300/api/cron/suscripciones?key=$CRON_SECRET"
app.post('/api/cron/suscripciones', (req, res) => {
  const key = req.query.key || req.get('x-cron-key');
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'clave de cron inválida' });
  }
  ok(res, () => ({ ...generarVencidas(req), ...generarGastosVencidos(req) }));
});

// Resumen diario de cartera (vencida o por vencer) por Telegram. Mismo patrón de auth.
//   0 8 * * *  curl -s -X POST "http://127.0.0.1:4300/api/cron/recordatorios?key=$CRON_SECRET"
app.post('/api/cron/recordatorios', async (req, res) => {
  const key = req.query.key || req.get('x-cron-key');
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'clave de cron inválida' });
  }
  try {
    res.json(await enviarRecordatorios());
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// Empujón motivacional aparte, en su propio horario. Mismo patrón de auth.
//   0 12 * * *  curl -s -X POST "http://127.0.0.1:4300/api/cron/motivacion?key=$CRON_SECRET"
app.post('/api/cron/motivacion', async (req, res) => {
  const key = req.query.key || req.get('x-cron-key');
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'clave de cron inválida' });
  }
  try {
    res.json(await enviarMotivacion());
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

// Healthcheck sin sesión, para que el deploy y el monitoreo puedan sondearlo.
app.get('/api/salud', (req, res) => res.json({ ok: true, hoy: hoy(), zona: ZONA }));

app.use('/api', auth.requiereSesion);

app.post('/api/cuenta/clave', (req, res) =>
  ok(res, () => {
    const { actual, nueva } = cuerpo(req);
    auth.cambiarClave(req.usuario, String(actual || ''), String(nueva || ''));
    bitacora(req, 'cambiar-clave', 'usuarios', null, '');
    return { ok: true };
  })
);

/* ---------------------- documentos: impuestos y moneda -------------------

   Un ingreso o un gasto se arma así:
     base (en la moneda del documento) × TRM = base en COP
     IVA        = base COP × iva_pct
     retención  = base COP × rete_pct
     monto      = base COP + IVA − retención     ← lo que de verdad se mueve
-------------------------------------------------------------------------- */

const MONEDAS = ['COP', 'USD', 'EUR'];

function calcularDoc(entrada, previo) {
  const antes = previo || {};
  const tomar = (k, def) => {
    if (entrada[k] !== undefined && entrada[k] !== '' && entrada[k] !== null) return entrada[k];
    if (antes[k] !== undefined && antes[k] !== null) return antes[k];
    return def;
  };

  const moneda = String(tomar('moneda', 'COP')).toUpperCase();
  if (!MONEDAS.includes(moneda)) throw new Error(`Moneda no soportada: ${moneda}`);
  let trm = Number(tomar('trm', 1)) || 1;
  if (moneda === 'COP') trm = 1;
  if (trm <= 0) throw new Error('La TRM debe ser mayor que cero');

  // Compatibilidad: quien solo manda "monto" está mandando un total sin impuestos.
  let origen;
  if (entrada.base !== undefined && entrada.base !== '' && entrada.base !== null) {
    origen = Number(entrada.base);
  } else if (entrada.monto !== undefined && entrada.monto !== '' && entrada.monto !== null) {
    origen = Number(entrada.monto) / trm;
  } else {
    origen = Number(antes.monto_origen || antes.base || 0);
  }
  if (!Number.isFinite(origen) || origen < 0) throw new Error('La base del documento no es válida');

  const baseCop = Math.round(origen * trm);
  const iva_pct = Number(tomar('iva_pct', 0)) || 0;
  const rete_pct = Number(tomar('rete_pct', 0)) || 0;
  if (iva_pct < 0 || iva_pct > 100) throw new Error('El IVA debe estar entre 0 y 100');
  if (rete_pct < 0 || rete_pct > 100) throw new Error('La retención debe estar entre 0 y 100');

  const iva = Math.round((baseCop * iva_pct) / 100);
  const rete = Math.round((baseCop * rete_pct) / 100);
  const monto = baseCop + iva - rete;
  if (monto < 0) throw new Error('La retención no puede superar el total del documento');

  return { base: baseCop, monto_origen: Math.round(origen), iva_pct, iva, rete_pct, rete, moneda, trm, monto };
}

/* ------------------------------- abonos ---------------------------------- */

const DOCS = { ingresos: 'ingreso', gastos: 'gasto' };
const TABLA_DE = { ingreso: 'ingresos', gasto: 'gastos' };

function leerDoc(tabla, id) {
  return db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(entero(id));
}

// Deja estado / abonado / fecha_pago del documento acordes a sus abonos,
// y arrastra el estado a la venta si el ingreso viene de una.
function recalcular(tabla, id) {
  const tipo = DOCS[tabla];
  const doc = leerDoc(tabla, id);
  if (!doc) return null;
  const r = db
    .prepare('SELECT COALESCE(SUM(monto),0) t, MAX(fecha) f FROM abonos WHERE tipo = ? AND doc_id = ?')
    .get(tipo, doc.id);
  const abonado = r.t;
  const estado = abonado <= 0 ? 'pendiente' : abonado >= doc.monto ? 'pagado' : 'parcial';
  db.prepare(`UPDATE ${tabla} SET abonado = ?, estado = ?, fecha_pago = ? WHERE id = ?`).run(
    abonado,
    estado,
    estado === 'pagado' ? r.f : null,
    doc.id
  );
  if (tabla === 'ingresos' && doc.venta_id) {
    db.prepare('UPDATE ventas SET estado = ? WHERE id = ?').run(estado, doc.venta_id);
  }
  return leerDoc(tabla, id);
}

function abonar(req, tabla, id, datos) {
  const tipo = DOCS[tabla];
  if (!tipo) throw new Error('Solo se abonan ingresos y gastos');
  const doc = leerDoc(tabla, id);
  if (!doc) throw new Error('Documento no encontrado');
  const saldo = doc.monto - doc.abonado;
  if (saldo <= 0) throw new Error('Ese documento ya está saldado');

  const fecha = datos.fecha || hoy();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new Error('"fecha" debe tener el formato AAAA-MM-DD');
  const monto = datos.monto !== undefined && datos.monto !== '' ? entero(datos.monto) : saldo;
  if (monto <= 0) throw new Error('El abono debe ser mayor que cero');
  if (monto > saldo) throw new Error(`El abono se pasa del saldo: quedan $${saldo.toLocaleString('es-CO')}`);

  db.prepare(
    `INSERT INTO abonos (tipo, doc_id, fecha, monto, metodo, nota, creado)
     VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
  ).run(tipo, doc.id, fecha, monto, datos.metodo || doc.metodo || 'nequi', datos.nota || '');

  const actualizado = recalcular(tabla, doc.id);
  bitacora(req, 'abonar', tabla, doc.id, `${monto} el ${fecha} (${actualizado.estado})`);
  return actualizado;
}

// Aplica el estado pedido desde un formulario: "pagado" salda el documento,
// "pendiente" deshace los abonos que tuviera.
function aplicarEstadoPedido(req, tabla, id, pedido, datos) {
  if (!pedido) return;
  const doc = leerDoc(tabla, id);
  if (!doc) return;
  if (pedido === 'pagado' && doc.abonado < doc.monto) {
    abonar(req, tabla, id, {
      fecha: datos.fecha_pago || datos.fecha || hoy(),
      monto: doc.monto - doc.abonado,
      metodo: datos.metodo || doc.metodo,
      nota: 'saldado desde el formulario',
    });
  } else if (pedido === 'pendiente' && doc.abonado > 0) {
    db.prepare('DELETE FROM abonos WHERE tipo = ? AND doc_id = ?').run(DOCS[tabla], doc.id);
    recalcular(tabla, id);
    bitacora(req, 'anular-abonos', tabla, doc.id, 'marcado como pendiente');
  } else {
    recalcular(tabla, id);
  }
}

app.get('/api/abonos', (req, res) =>
  ok(res, () => {
    const cond = [];
    const args = [];
    if (req.query.tipo) { cond.push('tipo = ?'); args.push(String(req.query.tipo)); }
    if (req.query.doc_id) { cond.push('doc_id = ?'); args.push(entero(req.query.doc_id)); }
    if (req.query.mes) { cond.push('substr(fecha,1,7) = ?'); args.push(String(req.query.mes)); }
    if (req.query.desde) { cond.push('fecha >= ?'); args.push(String(req.query.desde)); }
    if (req.query.hasta) { cond.push('fecha <= ?'); args.push(String(req.query.hasta)); }
    return db
      .prepare(
        `SELECT * FROM abonos ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY fecha DESC, id DESC LIMIT ?`
      )
      .all(...args, Math.min(entero(req.query.limit) || 300, 2000));
  })
);

app.post('/api/abonos', (req, res) =>
  ok(res, () => {
    const b = cuerpo(req);
    const tabla = TABLA_DE[b.tipo];
    if (!tabla) throw new Error('"tipo" debe ser "ingreso" o "gasto"');
    return abonar(req, tabla, b.doc_id, b);
  })
);

app.delete('/api/abonos/:id', (req, res) =>
  ok(res, () => {
    const a = db.prepare('SELECT * FROM abonos WHERE id = ?').get(entero(req.params.id));
    if (!a) throw new Error('Abono no encontrado');
    db.prepare('DELETE FROM abonos WHERE id = ?').run(a.id);
    recalcular(TABLA_DE[a.tipo], a.doc_id);
    bitacora(req, 'borrar', 'abonos', a.id, `${a.tipo} ${a.doc_id} por ${a.monto}`);
    return { ok: true };
  })
);

/* --------------------------------- CRUD ---------------------------------- */

const TABLAS = {
  lineas: {
    campos: ['nombre', 'tipo', 'color', 'activa', 'notas'],
    orden: 'activa DESC, nombre',
  },
  clientes: {
    campos: ['nombre', 'negocio', 'telefono', 'ciudad', 'notas'],
    orden: 'nombre',
  },
  ingresos: {
    campos: ['fecha', 'linea_id', 'cliente_id', 'concepto', 'base', 'iva_pct', 'rete_pct', 'moneda', 'trm', 'monto', 'metodo', 'estado', 'fecha_pago', 'vence', 'suscripcion_id', 'notas'],
    orden: 'fecha DESC, id DESC',
    documento: true,
  },
  gastos: {
    campos: ['fecha', 'linea_id', 'categoria', 'concepto', 'base', 'iva_pct', 'rete_pct', 'moneda', 'trm', 'monto', 'tipo', 'metodo', 'estado', 'fecha_pago', 'vence', 'proveedor', 'notas'],
    orden: 'fecha DESC, id DESC',
    documento: true,
  },
  suscripciones: {
    campos: ['cliente_id', 'linea_id', 'concepto', 'monto', 'iva_pct', 'rete_pct', 'moneda', 'ciclo', 'proxima_fecha', 'activa', 'notas'],
    orden: 'activa DESC, proxima_fecha',
  },
  gastos_recurrentes: {
    campos: ['concepto', 'monto', 'categoria', 'tipo', 'linea_id', 'proveedor', 'metodo', 'iva_pct', 'rete_pct', 'moneda', 'trm', 'ciclo', 'proxima_fecha', 'activa', 'notas'],
    orden: 'activa DESC, proxima_fecha',
  },
  productos: {
    campos: ['nombre', 'linea_id', 'sku', 'costo_unitario', 'precio_venta', 'stock', 'stock_minimo', 'activo'],
    orden: 'activo DESC, nombre',
  },
  ventas: {
    campos: ['fecha', 'cliente_id', 'producto_id', 'linea_id', 'cantidad', 'precio_unitario', 'costo_unitario', 'total', 'metodo', 'estado', 'notas'],
    orden: 'fecha DESC, id DESC',
  },
};

function filtros(tabla, q) {
  const cond = [];
  const args = [];
  const cols = TABLAS[tabla].campos;
  if (q.desde && cols.includes('fecha')) { cond.push('fecha >= ?'); args.push(q.desde); }
  if (q.hasta && cols.includes('fecha')) { cond.push('fecha <= ?'); args.push(q.hasta); }
  if (q.mes && cols.includes('fecha')) { cond.push('substr(fecha,1,7) = ?'); args.push(q.mes); }
  if (q.linea_id && cols.includes('linea_id')) { cond.push('linea_id = ?'); args.push(entero(q.linea_id)); }
  if (q.cliente_id && cols.includes('cliente_id')) { cond.push('cliente_id = ?'); args.push(entero(q.cliente_id)); }
  if (q.estado && cols.includes('estado')) { cond.push('estado = ?'); args.push(q.estado); }
  if (q.tipo && cols.includes('tipo')) { cond.push('tipo = ?'); args.push(q.tipo); }
  if (q.categoria && cols.includes('categoria')) { cond.push('categoria = ?'); args.push(q.categoria); }
  if (q.pendientes === '1' && cols.includes('estado')) cond.push("estado <> 'pagado'");
  if (q.q) {
    const campos = [];
    if (cols.includes('concepto')) campos.push('concepto');
    if (cols.includes('nombre')) campos.push('nombre');
    if (cols.includes('notas')) campos.push('notas');
    if (cols.includes('proveedor')) campos.push('proveedor');
    if (campos.length) {
      cond.push('(' + campos.map((c) => `${c} LIKE ?`).join(' OR ') + ')');
      campos.forEach(() => args.push('%' + q.q + '%'));
    }
  }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', args };
}

const CAMPOS_MONTO = ['monto', 'base', 'costo_unitario', 'precio_venta', 'precio_unitario', 'total', 'cantidad', 'stock', 'stock_minimo', 'trm'];
const ESTADOS_VALIDOS = ['pagado', 'parcial', 'pendiente'];

function revisarComunes(body) {
  for (const k of CAMPOS_MONTO) {
    if (body[k] !== undefined && body[k] !== '' && body[k] !== null) {
      const n = Number(body[k]);
      if (!Number.isFinite(n)) throw new Error(`"${k}" no es un número válido`);
      if (n < 0 && k !== 'cantidad') throw new Error(`"${k}" no puede ser negativo`);
    }
  }
  for (const k of ['fecha', 'fecha_pago', 'proxima_fecha', 'vence']) {
    if (body[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(body[k]))) {
      throw new Error(`"${k}" debe tener el formato AAAA-MM-DD`);
    }
  }
  if (body.estado && !ESTADOS_VALIDOS.includes(String(body.estado))) {
    throw new Error(`"estado" debe ser ${ESTADOS_VALIDOS.join(', ')}`);
  }
}

const resumenDe = (tabla, fila) =>
  String(fila.concepto || fila.nombre || `${tabla} #${fila.id}`).slice(0, 120);

/* ------------------------ papelera y dependencias ------------------------ */

// Lo que se va detrás de cada fila cuando la borras (por FK en cascada o
// porque es suyo). Se guarda entero en la papelera para poder devolverlo.
function recolectar(tabla, fila) {
  const dep = {};
  if (DOCS[tabla]) {
    dep.abonos = db.prepare('SELECT * FROM abonos WHERE tipo = ? AND doc_id = ?').all(DOCS[tabla], fila.id);
  }
  if (tabla === 'ventas') {
    dep.ingresos = db.prepare('SELECT * FROM ingresos WHERE venta_id = ?').all(fila.id);
    dep.movimientos = db.prepare('SELECT * FROM movimientos WHERE venta_id = ?').all(fila.id);
    dep.abonos = dep.ingresos.flatMap((i) =>
      db.prepare("SELECT * FROM abonos WHERE tipo = 'ingreso' AND doc_id = ?").all(i.id)
    );
  }
  if (tabla === 'productos') {
    dep.movimientos = db.prepare('SELECT * FROM movimientos WHERE producto_id = ?').all(fila.id);
  }
  return dep;
}

// El efecto de un movimiento sobre el stock. signo -1 lo revierte.
function aplicarStock(mov, signo) {
  const delta = (mov.tipo === 'salida' ? -mov.cantidad : mov.cantidad) * signo;
  db.prepare('UPDATE productos SET stock = stock + ? WHERE id = ?').run(delta, mov.producto_id);
}

function guardarEnPapelera(req, tabla, fila, dependientes) {
  db.prepare(
    `INSERT INTO papelera (tabla, registro_id, resumen, datos, usuario, creado)
     VALUES (?, ?, ?, ?, ?, datetime('now'))`
  ).run(tabla, fila.id, resumenDe(tabla, fila), JSON.stringify({ principal: fila, dependientes }), req.usuario || '');
}

function insertarFila(tabla, fila) {
  const cols = Object.keys(fila);
  db.prepare(`INSERT INTO ${tabla} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(
    ...cols.map((c) => fila[c])
  );
}

/* ------------------------------ rutas CRUD ------------------------------- */

for (const [tabla, def] of Object.entries(TABLAS)) {
  app.get('/api/' + tabla, (req, res) =>
    ok(res, () => {
      const { where, args } = filtros(tabla, req.query);
      const limite = Math.min(entero(req.query.limit) || 300, 2000);
      const desplazar = Math.max(0, entero(req.query.offset));
      const filas = db
        .prepare(`SELECT * FROM ${tabla} ${where} ORDER BY ${def.orden} LIMIT ? OFFSET ?`)
        .all(...args, limite, desplazar);
      if (req.query.contar === '1') {
        const total = db.prepare(`SELECT COUNT(*) c FROM ${tabla} ${where}`).get(...args).c;
        res.setHeader('X-Total', String(total));
      }
      return filas;
    })
  );

  // Traer una sola fila, para no bajarse la tabla entera al editar.
  app.get(`/api/${tabla}/:id`, (req, res) =>
    ok(res, () => {
      const fila = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(entero(req.params.id));
      if (!fila) throw new Error('No encontrado');
      return fila;
    })
  );

  app.post('/api/' + tabla, (req, res) =>
    ok(res, () => {
      const b = cuerpo(req);
      revisarComunes(b);
      const valores = { ...b };
      if (def.documento) Object.assign(valores, calcularDoc(b, null));

      const usados = def.campos.filter((c) => valores[c] !== undefined && valores[c] !== '');
      const extra = def.documento ? ['iva', 'rete', 'monto_origen'] : [];
      const cols = [...usados, ...extra.filter((c) => valores[c] !== undefined)];
      if (!cols.length) throw new Error('No enviaste ningún dato');

      const tx = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO ${tabla} (${cols.join(',')}, creado)
             VALUES (${cols.map(() => '?').join(',')}, datetime('now'))`
          )
          .run(...cols.map((c) => valores[c]));
        const id = info.lastInsertRowid;
        if (def.documento) {
          // Un documento nace sin abonos; el estado pedido decide si se salda.
          db.prepare(`UPDATE ${tabla} SET abonado = 0, estado = 'pendiente', fecha_pago = NULL WHERE id = ?`).run(id);
          aplicarEstadoPedido(req, tabla, id, b.estado || 'pagado', b);
        }
        return id;
      });
      const id = tx();
      const fila = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(id);
      bitacora(req, 'crear', tabla, id, resumenDe(tabla, fila));
      return fila;
    })
  );

  app.put('/api/' + tabla + '/:id', (req, res) =>
    ok(res, () => {
      const b = cuerpo(req);
      revisarComunes(b);
      const id = entero(req.params.id);
      const previo = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(id);
      if (!previo) throw new Error('No encontrado');

      const valores = { ...b };
      const tocaPlata = def.documento &&
        ['base', 'monto', 'iva_pct', 'rete_pct', 'moneda', 'trm'].some((k) => b[k] !== undefined);
      if (tocaPlata) Object.assign(valores, calcularDoc(b, previo));

      const campos = def.campos.filter((c) => valores[c] !== undefined && c !== 'estado' && c !== 'fecha_pago');
      const extra = tocaPlata ? ['iva', 'rete', 'monto_origen'] : [];
      const cols = [...campos, ...extra];
      if (!cols.length && b.estado === undefined) throw new Error('Nada que actualizar');

      const tx = db.transaction(() => {
        if (cols.length) {
          db.prepare(`UPDATE ${tabla} SET ${cols.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(
            ...cols.map((c) => (valores[c] === '' ? null : valores[c])),
            id
          );
        }
        if (def.documento) aplicarEstadoPedido(req, tabla, id, b.estado, { ...previo, ...b });
      });
      tx();
      const fila = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(id);
      bitacora(req, 'editar', tabla, id, resumenDe(tabla, fila));
      return fila;
    })
  );

  app.delete('/api/' + tabla + '/:id', (req, res) =>
    ok(res, () => {
      const id = entero(req.params.id);
      const fila = db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(id);
      if (!fila) throw new Error('No encontrado');

      // Borrar una línea reescribe el histórico: los movimientos viejos se van
      // a "General" y los reportes de años pasados cambian solos.
      if (tabla === 'lineas' && req.query.forzar !== '1') {
        const usos =
          db.prepare('SELECT COUNT(*) c FROM ingresos WHERE linea_id = ?').get(id).c +
          db.prepare('SELECT COUNT(*) c FROM gastos WHERE linea_id = ?').get(id).c;
        if (usos) {
          throw new Error(
            `Esa línea tiene ${usos} movimientos. Archívala en vez de borrarla para no cambiar los reportes de meses cerrados.`
          );
        }
      }

      const tx = db.transaction(() => {
        const dependientes = recolectar(tabla, fila);
        guardarEnPapelera(req, tabla, fila, dependientes);
        // Devolver el stock que la venta se llevó (si el producto sigue vivo).
        if (tabla === 'ventas') (dependientes.movimientos || []).forEach((m) => aplicarStock(m, -1));
        db.prepare(`DELETE FROM ${tabla} WHERE id = ?`).run(id);
        if (DOCS[tabla]) db.prepare('DELETE FROM abonos WHERE tipo = ? AND doc_id = ?').run(DOCS[tabla], id);
      });
      tx();
      bitacora(req, 'borrar', tabla, id, resumenDe(tabla, fila));
      return { ok: true, papelera: true };
    })
  );
}

/* ------------------------------- papelera -------------------------------- */

app.get('/api/papelera', (req, res) =>
  ok(res, () =>
    db
      .prepare('SELECT id, tabla, registro_id, resumen, usuario, creado FROM papelera ORDER BY id DESC LIMIT ?')
      .all(Math.min(entero(req.query.limit) || 100, 500))
  )
);

app.post('/api/papelera/:id/restaurar', (req, res) =>
  ok(res, () => {
    const p = db.prepare('SELECT * FROM papelera WHERE id = ?').get(entero(req.params.id));
    if (!p) throw new Error('No hay nada que restaurar con ese id');
    const { principal, dependientes } = JSON.parse(p.datos);

    const tx = db.transaction(() => {
      if (db.prepare(`SELECT id FROM ${p.tabla} WHERE id = ?`).get(principal.id)) {
        throw new Error('Ya existe un registro con ese id; no se puede restaurar encima');
      }
      insertarFila(p.tabla, principal);
      for (const [tablaDep, filas] of Object.entries(dependientes || {})) {
        for (const f of filas) {
          if (db.prepare(`SELECT id FROM ${tablaDep} WHERE id = ?`).get(f.id)) continue;
          insertarFila(tablaDep, f);
        }
      }
      // Volver a descontar lo que la venta se había llevado del inventario.
      if (p.tabla === 'ventas') (dependientes.movimientos || []).forEach((m) => aplicarStock(m, 1));
      if (DOCS[p.tabla]) recalcular(p.tabla, principal.id);
      (dependientes.ingresos || []).forEach((i) => recalcular('ingresos', i.id));
      db.prepare('DELETE FROM papelera WHERE id = ?').run(p.id);
    });
    tx();
    bitacora(req, 'restaurar', p.tabla, principal.id, p.resumen);
    return { ok: true, tabla: p.tabla, id: principal.id };
  })
);

app.delete('/api/papelera/:id', (req, res) =>
  ok(res, () => {
    const p = db.prepare('SELECT * FROM papelera WHERE id = ?').get(entero(req.params.id));
    if (!p) throw new Error('No encontrado');
    db.prepare('DELETE FROM papelera WHERE id = ?').run(p.id);
    bitacora(req, 'vaciar-papelera', p.tabla, p.registro_id, p.resumen);
    return { ok: true };
  })
);

app.get('/api/bitacora', (req, res) =>
  ok(res, () => {
    const cond = [];
    const args = [];
    if (req.query.tabla) { cond.push('tabla = ?'); args.push(String(req.query.tabla)); }
    if (req.query.mes) { cond.push('substr(fecha,1,7) = ?'); args.push(String(req.query.mes)); }
    return db
      .prepare(
        `SELECT * FROM bitacora ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY id DESC LIMIT ?`
      )
      .all(...args, Math.min(entero(req.query.limit) || 200, 1000));
  })
);

/* ------------------------- acciones especializadas ------------------------ */

app.post('/api/ingresos/:id/pagar', (req, res) =>
  ok(res, () => abonar(req, 'ingresos', req.params.id, cuerpo(req)))
);

app.post('/api/gastos/:id/pagar', (req, res) =>
  ok(res, () => abonar(req, 'gastos', req.params.id, cuerpo(req)))
);

const avanzar = (fecha, ciclo) => sumarMeses(fecha, ciclo === 'anual' ? 12 : 1);

function generarVencidas(req) {
  const vencidas = db.prepare('SELECT * FROM suscripciones WHERE activa = 1 AND proxima_fecha <= ?').all(hoy());
  let generados = 0;
  const tx = db.transaction((lista) => {
    for (const s of lista) {
      const yaExiste = db
        .prepare('SELECT id FROM ingresos WHERE suscripcion_id = ? AND fecha = ?')
        .get(s.id, s.proxima_fecha);
      if (!yaExiste) {
        const d = calcularDoc({ base: s.monto, iva_pct: s.iva_pct, rete_pct: s.rete_pct, moneda: s.moneda }, null);
        db.prepare(
          `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, base, iva_pct, iva, rete_pct, rete, moneda, trm, monto_origen, monto, metodo, estado, suscripcion_id, notas, creado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'nequi', 'pendiente', ?, '', datetime('now'))`
        ).run(s.proxima_fecha, s.linea_id, s.cliente_id, s.concepto, d.base, d.iva_pct, d.iva, d.rete_pct, d.rete, d.moneda, d.trm, d.monto_origen, d.monto, s.id);
        generados++;
      }
      db.prepare('UPDATE suscripciones SET proxima_fecha = ? WHERE id = ?').run(avanzar(s.proxima_fecha, s.ciclo), s.id);
    }
  });
  tx(vencidas);
  if (generados) bitacora(req, 'generar-cobros', 'suscripciones', null, `${generados} cobros`);
  return { generados };
}

// El espejo: los gastos fijos que se repiten solos (VPS, dominios, APIs).
function generarGastosVencidos(req) {
  const vencidos = db.prepare('SELECT * FROM gastos_recurrentes WHERE activa = 1 AND proxima_fecha <= ?').all(hoy());
  let gastosGenerados = 0;
  const tx = db.transaction((lista) => {
    for (const g of lista) {
      const yaExiste = db
        .prepare('SELECT id FROM gastos WHERE recurrente_id = ? AND fecha = ?')
        .get(g.id, g.proxima_fecha);
      if (!yaExiste) {
        const d = calcularDoc({ base: g.monto, iva_pct: g.iva_pct, rete_pct: g.rete_pct, moneda: g.moneda, trm: g.trm }, null);
        db.prepare(
          `INSERT INTO gastos (fecha, linea_id, categoria, concepto, base, iva_pct, iva, rete_pct, rete, moneda, trm, monto_origen, monto, tipo, metodo, estado, vence, proveedor, recurrente_id, notas, creado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, ?, '', datetime('now'))`
        ).run(g.proxima_fecha, g.linea_id, g.categoria, g.concepto, d.base, d.iva_pct, d.iva, d.rete_pct, d.rete, d.moneda, d.trm, d.monto_origen, d.monto, g.tipo, g.metodo, g.proxima_fecha, g.proveedor, g.id);
        gastosGenerados++;
      }
      db.prepare('UPDATE gastos_recurrentes SET proxima_fecha = ? WHERE id = ?').run(avanzar(g.proxima_fecha, g.ciclo), g.id);
    }
  });
  tx(vencidos);
  if (gastosGenerados) bitacora(req, 'generar-gastos', 'gastos_recurrentes', null, `${gastosGenerados} gastos`);
  return { gastosGenerados };
}

app.post('/api/suscripciones/generar-vencidas', (req, res) => ok(res, () => generarVencidas(req)));
app.post('/api/gastos-recurrentes/generar-vencidos', (req, res) => ok(res, () => generarGastosVencidos(req)));

/* --------------------------- recordatorios -------------------------------
   Resumen diario de cartera (vencida o por vencer) mandado por Telegram.
   Reusa el mismo bot que ya manda el backup off-site (scripts/backup.sh).
-------------------------------------------------------------------------- */

const pesosTxt = (n) => `$${Math.round(n).toLocaleString('es-CO')}`;
const diasAntes = () => Number(process.env.RECORDATORIOS_DIAS_ANTES) || 3;

function construirRecordatorios() {
  const ahora = hoy();
  const ventana = diasAntes();

  const cobrar = db
    .prepare(
      `SELECT i.concepto, (i.monto - i.abonado) AS saldo, i.vence, i.fecha, c.nombre AS cliente
       FROM ingresos i LEFT JOIN clientes c ON c.id = i.cliente_id
       WHERE i.estado <> 'pagado'`
    )
    .all()
    .map((r) => ({ ...r, dias: diasEntre(r.vence || r.fecha, ahora) }))
    .filter((r) => r.dias > 0 || r.dias >= -ventana);

  const pagar = db
    .prepare(
      `SELECT g.concepto, (g.monto - g.abonado) AS saldo, g.vence, g.fecha, g.proveedor
       FROM gastos g WHERE g.estado <> 'pagado'`
    )
    .all()
    .map((r) => ({ ...r, dias: diasEntre(r.vence || r.fecha, ahora) }))
    .filter((r) => r.dias > 0 || r.dias >= -ventana);

  if (!cobrar.length && !pagar.length) return null;

  const linea = (nombre, r) =>
    `• ${nombre || r.concepto} — ${r.concepto} — ${pesosTxt(r.saldo)} — ${
      r.dias > 0 ? `vencida hace ${r.dias} día${r.dias === 1 ? '' : 's'}` : `vence en ${-r.dias} día${-r.dias === 1 ? '' : 's'}`
    }`;

  const bloques = [];
  bloques.push(`📋 Cartera al ${ahora}`);
  if (cobrar.length) {
    bloques.push(`\n🔴 Por cobrar (${pesosTxt(cobrar.reduce((a, b) => a + b.saldo, 0))}):`);
    bloques.push(...cobrar.map((r) => linea(r.cliente, r)));
  }
  if (pagar.length) {
    bloques.push(`\n🟠 Por pagar (${pesosTxt(pagar.reduce((a, b) => a + b.saldo, 0))}):`);
    bloques.push(...pagar.map((r) => linea(r.proveedor, r)));
  }
  return bloques.join('\n');
}

async function enviarTelegram(texto) {
  const token = process.env.TELEGRAM_TOKEN;
  const chat = process.env.TELEGRAM_CHAT;
  if (!token || !chat) return { enviado: false, motivo: 'telegram no configurado' };
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chat, text: texto }),
    });
    if (!r.ok) return { enviado: false, motivo: `telegram respondió ${r.status}` };
    return { enviado: true };
  } catch (e) {
    return { enviado: false, motivo: e.message };
  }
}

// Cuando no hay nada vencido ni por vencer, en vez de quedarse callado manda
// la utilidad del mes: siempre hay algo útil que decir.
function construirResumenAlDia() {
  const mes = mesDe(hoy());
  const t = totalesMes(mes);
  return [
    '✅ Al día: nada pendiente por cobrar ni por pagar.',
    '',
    `${t.utilidad >= 0 ? '📈' : '📉'} Utilidad neta de ${mes}: ${pesosTxt(t.utilidad)}`,
    `Entró ${pesosTxt(t.ingresos)} · Salió ${pesosTxt(t.gastos)}`,
  ].join('\n');
}

async function enviarRecordatorios() {
  const texto = construirRecordatorios() || construirResumenAlDia();
  return enviarTelegram(texto);
}

// Botón "Enviar recordatorios ahora" del panel, para probar sin esperar al cron.
app.post('/api/recordatorios/enviar', async (req, res) => {
  try {
    res.json(await enviarRecordatorios());
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

/* ------------------------------ motivación --------------------------------
   Un empujón aparte de la cartera: vender software, productos, campañas de
   mensajes masivos. Se manda en un horario propio, independiente del de
   cobros/pagos.
-------------------------------------------------------------------------- */

const FRASES_MOTIVACION = [
  'Un cliente que no sabe que existes es una venta que no vas a hacer. Manda ese mensaje masivo hoy.',
  'Cada producto que empaquetas una vez y vendes varias veces es tiempo que recuperas. ¿Qué puedes empaquetar hoy?',
  '¿Ya le escribiste a un cliente viejo para ofrecerle algo nuevo? La venta más fácil es la que ya confía en ti.',
  'GigantYA, Daemon Leads, AgroValor, NFC, webs, reparaciones: cada línea es una palanca. Empuja hoy la que más rápido responda.',
  'El software se vende una vez y cobra todos los meses si es suscripción. ¿Cuál puedes volver recurrente esta semana?',
  'Una campaña de mensajes masivos bien segmentada vale más que diez publicaciones sin dueño. Manda la de hoy.',
  'No esperes a que te compren: ofrece primero. El próximo cliente está a un mensaje de distancia.',
  'Cada gasto fijo que pagas es una razón más para vender hoy, no mañana.',
  'Automatiza lo repetible, vende lo nuevo. Hoy es buen día para lanzar algo.',
  'Un producto sin cliente es una idea. Un producto con un cliente pagando es un negocio. ¿A quién le vendes hoy?',
];

const mensajeMotivacional = () => FRASES_MOTIVACION[Math.floor(Math.random() * FRASES_MOTIVACION.length)];

async function enviarMotivacion() {
  return enviarTelegram(`💪 ${mensajeMotivacional()}`);
}

// Botón/prueba manual, con sesión.
app.post('/api/motivacion/enviar', async (req, res) => {
  try {
    res.json(await enviarMotivacion());
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/suscripciones/:id/cobrar', (req, res) =>
  ok(res, () => {
    const id = entero(req.params.id);
    const s = db.prepare('SELECT * FROM suscripciones WHERE id = ?').get(id);
    if (!s) throw new Error('Suscripción no encontrada');
    if (!s.activa) throw new Error('Esa suscripción está cancelada; actívala antes de cobrarla.');
    const b = cuerpo(req);
    const fecha = b.fecha || s.proxima_fecha;
    const repetido = db
      .prepare('SELECT id FROM ingresos WHERE suscripcion_id = ? AND fecha = ?')
      .get(s.id, fecha);
    if (repetido) throw new Error(`Ya existe un cobro de esa suscripción con fecha ${fecha}.`);

    const tx = db.transaction(() => {
      const d = calcularDoc({ base: s.monto, iva_pct: s.iva_pct, rete_pct: s.rete_pct, moneda: s.moneda }, null);
      db.prepare(
        `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, base, iva_pct, iva, rete_pct, rete, moneda, trm, monto_origen, monto, metodo, estado, suscripcion_id, notas, creado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, '', datetime('now'))`
      ).run(fecha, s.linea_id, s.cliente_id, s.concepto, d.base, d.iva_pct, d.iva, d.rete_pct, d.rete, d.moneda, d.trm, d.monto_origen, d.monto, b.metodo || 'nequi', s.id);
      db.prepare('UPDATE suscripciones SET proxima_fecha = ? WHERE id = ?').run(avanzar(s.proxima_fecha, s.ciclo), s.id);
    });
    tx();
    bitacora(req, 'cobrar', 'suscripciones', id, s.concepto);
    return db.prepare('SELECT * FROM suscripciones WHERE id = ?').get(id);
  })
);

app.post('/api/productos/:id/entrada', (req, res) =>
  ok(res, () => {
    const b = cuerpo(req);
    const id = entero(req.params.id);
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    if (!p) throw new Error('Producto no encontrado');
    const cantidad = entero(b.cantidad);
    if (cantidad <= 0) throw new Error('La cantidad debe ser mayor que cero');
    const costo = b.costo_unitario !== undefined && b.costo_unitario !== '' ? entero(b.costo_unitario) : p.costo_unitario;
    const fecha = b.fecha || hoy();
    const registrarGasto = b.registrar_gasto !== false;

    const tx = db.transaction(() => {
      let gastoId = null;
      if (registrarGasto && costo > 0) {
        const d = calcularDoc({ base: costo * cantidad, iva_pct: b.iva_pct, rete_pct: b.rete_pct }, null);
        gastoId = db
          .prepare(
            `INSERT INTO gastos (fecha, linea_id, categoria, concepto, base, iva_pct, iva, rete_pct, rete, moneda, trm, monto_origen, monto, tipo, metodo, estado, proveedor, notas, creado)
             VALUES (?, ?, 'inventario', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'variable', ?, 'pendiente', ?, '', datetime('now'))`
          )
          .run(fecha, p.linea_id, `Compra ${cantidad} x ${p.nombre}`, d.base, d.iva_pct, d.iva, d.rete_pct, d.rete, d.moneda, d.trm, d.monto_origen, d.monto, b.metodo || 'efectivo', b.proveedor || '')
          .lastInsertRowid;
        aplicarEstadoPedido(req, 'gastos', gastoId, b.estado || 'pagado', { fecha, metodo: b.metodo || 'efectivo' });
      }
      db.prepare(
        `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, gasto_id, creado)
         VALUES (?, ?, 'entrada', ?, ?, ?, ?, datetime('now'))`
      ).run(id, fecha, cantidad, costo, b.nota || '', gastoId);
      db.prepare('UPDATE productos SET stock = stock + ?, costo_unitario = ? WHERE id = ?').run(cantidad, costo, id);
    });
    tx();
    bitacora(req, 'entrada', 'productos', id, `${cantidad} unidades`);
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

app.post('/api/productos/:id/ajuste', (req, res) =>
  ok(res, () => {
    const b = cuerpo(req);
    const id = entero(req.params.id);
    const nuevo = entero(b.stock);
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    if (!p) throw new Error('Producto no encontrado');
    if (nuevo < 0) throw new Error('El stock no puede quedar negativo');
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, creado)
         VALUES (?, ?, 'ajuste', ?, ?, ?, datetime('now'))`
      ).run(id, b.fecha || hoy(), nuevo - p.stock, p.costo_unitario, b.nota || 'Ajuste manual');
      db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevo, id);
    });
    tx();
    bitacora(req, 'ajuste', 'productos', id, `${p.stock} -> ${nuevo}`);
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

app.get('/api/movimientos', (req, res) =>
  ok(res, () => {
    const cond = [];
    const args = [];
    if (req.query.producto_id) { cond.push('m.producto_id = ?'); args.push(entero(req.query.producto_id)); }
    if (req.query.tipo) { cond.push('m.tipo = ?'); args.push(String(req.query.tipo)); }
    if (req.query.mes) { cond.push('substr(m.fecha,1,7) = ?'); args.push(String(req.query.mes)); }
    if (req.query.desde) { cond.push('m.fecha >= ?'); args.push(String(req.query.desde)); }
    if (req.query.hasta) { cond.push('m.fecha <= ?'); args.push(String(req.query.hasta)); }
    return db
      .prepare(
        `SELECT m.*, p.nombre AS producto FROM movimientos m
         LEFT JOIN productos p ON p.id = m.producto_id
         ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY m.fecha DESC, m.id DESC LIMIT ?`
      )
      .all(...args, Math.min(entero(req.query.limit) || 200, 1000));
  })
);

app.post('/api/ventas/registrar', (req, res) =>
  ok(res, () => {
    const b = cuerpo(req);
    revisarComunes(b);
    const cantidad = entero(b.cantidad) || 1;
    if (cantidad <= 0) throw new Error('La cantidad debe ser mayor que cero');
    const fecha = b.fecha || hoy();
    const p = b.producto_id ? db.prepare('SELECT * FROM productos WHERE id = ?').get(entero(b.producto_id)) : null;
    const precio = entero(b.precio_unitario !== undefined && b.precio_unitario !== '' ? b.precio_unitario : p ? p.precio_venta : 0);
    const costo = entero(b.costo_unitario !== undefined && b.costo_unitario !== '' ? b.costo_unitario : p ? p.costo_unitario : 0);
    const estado = b.estado === 'pendiente' ? 'pendiente' : 'pagado';
    const lineaId = b.linea_id ? entero(b.linea_id) : p ? p.linea_id : null;
    if (p && p.stock < cantidad && b.permitir_negativo !== true)
      throw new Error(`Stock insuficiente: quedan ${p.stock} de ${p.nombre}`);

    const d = calcularDoc({ base: precio * cantidad, iva_pct: b.iva_pct, rete_pct: b.rete_pct }, null);

    const tx = db.transaction(() => {
      const ventaId = db
        .prepare(
          `INSERT INTO ventas (fecha, cliente_id, producto_id, linea_id, cantidad, precio_unitario, costo_unitario, total, metodo, estado, notas, creado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(fecha, b.cliente_id || null, p ? p.id : null, lineaId, cantidad, precio, costo, d.monto, b.metodo || 'efectivo', estado, b.notas || '')
        .lastInsertRowid;

      if (p) {
        db.prepare(
          `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, venta_id, creado)
           VALUES (?, ?, 'salida', ?, ?, 'Venta', ?, datetime('now'))`
        ).run(p.id, fecha, cantidad, costo, ventaId);
        db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(cantidad, p.id);
      }

      const ingresoId = db
        .prepare(
          `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, base, iva_pct, iva, rete_pct, rete, moneda, trm, monto_origen, monto, metodo, estado, venta_id, notas, creado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente', ?, ?, datetime('now'))`
        )
        .run(
          fecha, lineaId, b.cliente_id || null,
          `Venta ${cantidad} x ${p ? p.nombre : b.concepto || 'producto'}`,
          d.base, d.iva_pct, d.iva, d.rete_pct, d.rete, d.moneda, d.trm, d.monto_origen, d.monto,
          b.metodo || 'efectivo', ventaId, b.notas || ''
        ).lastInsertRowid;
      aplicarEstadoPedido(req, 'ingresos', ingresoId, estado, { fecha, metodo: b.metodo || 'efectivo' });
      return ventaId;
    });
    const id = tx();
    bitacora(req, 'crear', 'ventas', id, `${cantidad} x ${p ? p.nombre : 'producto'}`);
    return db.prepare('SELECT * FROM ventas WHERE id = ?').get(id);
  })
);

/* -------------------------------- reportes --------------------------------
   Base caja de verdad: la utilidad del mes sale de los ABONOS del mes, no de
   la fecha del documento. Una factura de enero cobrada en marzo es plata de
   marzo. El IVA, en cambio, se causa con la fecha del documento.
-------------------------------------------------------------------------- */

const sumaAbonos = (tipo, mes, extra = '') =>
  db
    .prepare(
      `SELECT COALESCE(SUM(a.monto),0) t FROM abonos a
       JOIN ${TABLA_DE[tipo]} d ON d.id = a.doc_id
       WHERE a.tipo = ? AND substr(a.fecha,1,7) = ? ${extra}`
    )
    .get(tipo, mes).t;

function totalesMes(mes) {
  const ingresos = sumaAbonos('ingreso', mes);
  const gastos = sumaAbonos('gasto', mes);
  const fijos = sumaAbonos('gasto', mes, "AND d.tipo = 'fijo'");
  // Saldo de los documentos fechados en el mes (lo que quedó sin mover caja).
  const pendiente = db
    .prepare(`SELECT COALESCE(SUM(monto - abonado),0) t FROM ingresos WHERE substr(fecha,1,7) = ?`)
    .get(mes).t;
  const porPagarMes = db
    .prepare(`SELECT COALESCE(SUM(monto - abonado),0) t FROM gastos WHERE substr(fecha,1,7) = ?`)
    .get(mes).t;
  return {
    mes,
    ingresos,
    pendiente,
    porPagarMes,
    gastos,
    fijos,
    variables: gastos - fijos,
    utilidad: ingresos - gastos,
  };
}

app.get('/api/reportes/panel', (req, res) =>
  ok(res, () => {
    const mes = String(req.query.mes || mesDe(hoy())).slice(0, 7);
    const mesAnterior = mesMas(mes, -1);
    const ahora = hoy();

    const porLinea = db
      .prepare(
        `SELECT l.id, l.nombre, l.color, l.tipo,
            (SELECT COALESCE(SUM(a.monto),0) FROM abonos a JOIN ingresos i ON i.id = a.doc_id
              WHERE a.tipo='ingreso' AND i.linea_id = l.id AND substr(a.fecha,1,7) = ?) AS ingresos,
            (SELECT COALESCE(SUM(a.monto),0) FROM abonos a JOIN gastos g ON g.id = a.doc_id
              WHERE a.tipo='gasto' AND g.linea_id = l.id AND substr(a.fecha,1,7) = ?) AS gastos
         FROM lineas l WHERE l.activa = 1 ORDER BY ingresos DESC`
      )
      .all(mes, mes)
      .map((r) => ({ ...r, margen: r.ingresos - r.gastos, pct: r.ingresos ? Math.round(((r.ingresos - r.gastos) / r.ingresos) * 100) : 0 }));

    const cxc = db
      .prepare(
        `SELECT i.id, i.fecha, i.concepto, i.monto, i.abonado, (i.monto - i.abonado) AS saldo, i.estado, i.vence,
                c.nombre AS cliente, c.telefono AS telefono, l.nombre AS linea
         FROM ingresos i
         LEFT JOIN clientes c ON c.id = i.cliente_id
         LEFT JOIN lineas l ON l.id = i.linea_id
         WHERE i.estado <> 'pagado' ORDER BY i.fecha LIMIT 50`
      )
      .all()
      .map((r) => ({ ...r, dias: diasEntre(r.fecha, ahora) }));

    const cxp = db
      .prepare(
        `SELECT g.id, g.fecha, g.concepto, g.monto, g.abonado, (g.monto - g.abonado) AS saldo, g.estado, g.vence,
                g.proveedor, l.nombre AS linea
         FROM gastos g
         LEFT JOIN lineas l ON l.id = g.linea_id
         WHERE g.estado <> 'pagado' ORDER BY COALESCE(g.vence, g.fecha) LIMIT 50`
      )
      .all()
      .map((r) => ({ ...r, dias: diasEntre(r.fecha, ahora) }));

    const gastosFijos = db
      .prepare(
        `SELECT g.concepto, g.categoria, g.monto, g.estado, l.nombre AS linea
         FROM gastos g LEFT JOIN lineas l ON l.id = g.linea_id
         WHERE substr(g.fecha,1,7) = ? AND g.tipo = 'fijo' ORDER BY g.monto DESC`
      )
      .all(mes);

    const mrr = db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN ciclo='anual' THEN monto/12.0 ELSE monto END),0) t FROM suscripciones WHERE activa=1`)
      .get().t;
    const gastoFijoRecurrente = db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN ciclo='anual' THEN monto/12.0 ELSE monto END),0) t FROM gastos_recurrentes WHERE activa=1`)
      .get().t;

    const serie = [];
    for (let i = 11; i >= 0; i--) serie.push(totalesMes(mesMas(mes, -i)));

    const alertasStock = db.prepare('SELECT nombre, stock, stock_minimo FROM productos WHERE activo=1 AND stock <= stock_minimo').all();

    const actual = totalesMes(mes);
    const previo = totalesMes(mesAnterior);
    const margenContribucion = actual.ingresos ? (actual.ingresos - actual.variables) / actual.ingresos : 0;

    return {
      mes,
      hoy: ahora,
      actual,
      previo,
      porLinea,
      cxc,
      cxcTotal: cxc.reduce((a, b) => a + b.saldo, 0),
      cxp,
      cxpTotal: cxp.reduce((a, b) => a + b.saldo, 0),
      gastosFijos,
      mrr: Math.round(mrr),
      gastoFijoRecurrente: Math.round(gastoFijoRecurrente),
      serie,
      alertasStock,
      puntoEquilibrio: margenContribucion > 0 ? Math.round(actual.fijos / margenContribucion) : null,
    };
  })
);

app.get('/api/reportes/lineas', (req, res) =>
  ok(res, () => {
    const desde = req.query.desde || '0000-01-01';
    const hasta = req.query.hasta || '9999-12-31';
    return db
      .prepare(
        `SELECT l.id, l.nombre, l.tipo, l.color,
            (SELECT COALESCE(SUM(a.monto),0) FROM abonos a JOIN ingresos i ON i.id = a.doc_id
              WHERE a.tipo='ingreso' AND i.linea_id = l.id AND a.fecha BETWEEN ? AND ?) AS ingresos,
            (SELECT COALESCE(SUM(a.monto),0) FROM abonos a JOIN gastos g ON g.id = a.doc_id
              WHERE a.tipo='gasto' AND g.linea_id = l.id AND a.fecha BETWEEN ? AND ?) AS gastos,
            (SELECT COALESCE(SUM(i.monto - i.abonado),0) FROM ingresos i
              WHERE i.linea_id = l.id AND i.estado <> 'pagado' AND i.fecha BETWEEN ? AND ?) AS por_cobrar,
            (SELECT COALESCE(SUM(g.monto - g.abonado),0) FROM gastos g
              WHERE g.linea_id = l.id AND g.estado <> 'pagado' AND g.fecha BETWEEN ? AND ?) AS por_pagar
         FROM lineas l ORDER BY ingresos DESC`
      )
      .all(desde, hasta, desde, hasta, desde, hasta, desde, hasta)
      .map((r) => ({ ...r, margen: r.ingresos - r.gastos, pct: r.ingresos ? Math.round(((r.ingresos - r.gastos) / r.ingresos) * 100) : 0 }));
  })
);

app.get('/api/reportes/categorias', (req, res) =>
  ok(res, () => {
    const desde = req.query.desde || '0000-01-01';
    const hasta = req.query.hasta || '9999-12-31';
    return db
      .prepare(
        `SELECT categoria, tipo, COUNT(*) n, SUM(monto) total, SUM(monto - abonado) saldo FROM gastos
         WHERE fecha BETWEEN ? AND ? GROUP BY categoria, tipo ORDER BY total DESC`
      )
      .all(desde, hasta);
  })
);

app.get('/api/reportes/productos', (req, res) =>
  ok(res, () =>
    db
      .prepare(
        `SELECT p.id, p.nombre, p.stock, p.costo_unitario, p.precio_venta,
            COALESCE(SUM(v.cantidad),0) AS vendidos,
            COALESCE(SUM(v.total),0) AS facturado,
            COALESCE(SUM((v.precio_unitario - v.costo_unitario) * v.cantidad),0) AS margen
         FROM productos p LEFT JOIN ventas v ON v.producto_id = p.id
         GROUP BY p.id ORDER BY facturado DESC`
      )
      .all()
  )
);

// IVA y retenciones: se causan con la fecha del documento, no con la del pago.
app.get('/api/reportes/impuestos', (req, res) =>
  ok(res, () => {
    const mes = String(req.query.mes || mesDe(hoy())).slice(0, 7);
    const desde = req.query.desde || mes + '-01';
    const hasta = req.query.hasta || sumarMeses(mes + '-01', 1);
    const ventas = db
      .prepare(`SELECT COALESCE(SUM(base),0) base, COALESCE(SUM(iva),0) iva, COALESCE(SUM(rete),0) rete
                FROM ingresos WHERE fecha >= ? AND fecha < ?`)
      .get(desde, hasta);
    const compras = db
      .prepare(`SELECT COALESCE(SUM(base),0) base, COALESCE(SUM(iva),0) iva, COALESCE(SUM(rete),0) rete
                FROM gastos WHERE fecha >= ? AND fecha < ?`)
      .get(desde, hasta);
    return {
      mes,
      desde,
      hasta,
      baseVentas: ventas.base,
      ivaGenerado: ventas.iva,
      reteSufrida: ventas.rete,
      baseCompras: compras.base,
      ivaDescontable: compras.iva,
      retePracticada: compras.rete,
      saldoIva: ventas.iva - compras.iva,
    };
  })
);

// Vencimientos: lo que te deben y lo que debes, por antigüedad.
app.get('/api/reportes/cartera', (req, res) =>
  ok(res, () => {
    const ahora = hoy();
    const tramos = (filas) => {
      const cubos = { alDia: 0, d1a30: 0, d31a60: 0, d61a90: 0, mas90: 0 };
      for (const f of filas) {
        const d = diasEntre(f.vence || f.fecha, ahora);
        if (d <= 0) cubos.alDia += f.saldo;
        else if (d <= 30) cubos.d1a30 += f.saldo;
        else if (d <= 60) cubos.d31a60 += f.saldo;
        else if (d <= 90) cubos.d61a90 += f.saldo;
        else cubos.mas90 += f.saldo;
      }
      return cubos;
    };
    const cobrar = db
      .prepare(`SELECT fecha, vence, (monto - abonado) saldo FROM ingresos WHERE estado <> 'pagado'`)
      .all();
    const pagar = db
      .prepare(`SELECT fecha, vence, (monto - abonado) saldo FROM gastos WHERE estado <> 'pagado'`)
      .all();
    return {
      hoy: ahora,
      porCobrar: { total: cobrar.reduce((a, b) => a + b.saldo, 0), ...tramos(cobrar) },
      porPagar: { total: pagar.reduce((a, b) => a + b.saldo, 0), ...tramos(pagar) },
    };
  })
);

/* -------------------------------- exportar -------------------------------- */

const EXPORTABLES = [...Object.keys(TABLAS), 'movimientos', 'abonos', 'bitacora'];

app.get('/api/export/:tabla.csv', (req, res) => {
  const tabla = req.params.tabla;
  if (!EXPORTABLES.includes(tabla)) return res.status(404).json({ error: 'Tabla desconocida' });
  let where = '';
  const args = [];
  if (TABLAS[tabla]) {
    const f = filtros(tabla, req.query);
    where = f.where;
    args.push(...f.args);
  }
  const filas = db.prepare(`SELECT * FROM ${tabla} ${where} ORDER BY id`).all(...args);
  const cols = filas.length ? Object.keys(filas[0]) : ['id'];
  const escapar = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const csv = [cols.join(','), ...filas.map((f) => cols.map((c) => escapar(f[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${tabla}-${hoy()}.csv"`);
  res.send('﻿' + csv);
});

app.get('/api/backup', (req, res) => {
  const datos = Object.fromEntries(EXPORTABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()]));
  if (req.query.descargar === '1') {
    res.setHeader('Content-Disposition', `attachment; filename="crt-backup-${hoy()}.json"`);
  }
  res.json({ generado: new Date().toISOString(), version: db.pragma('user_version', { simple: true }), tablas: EXPORTABLES, datos });
});

// Restaurar un backup JSON. Reemplaza TODO, por eso pide confirmación explícita.
app.post('/api/restaurar', (req, res) =>
  ok(res, () => {
    const b = cuerpo(req);
    if (b.confirmar !== 'REEMPLAZAR') {
      throw new Error('Para restaurar manda { "confirmar": "REEMPLAZAR" } junto con el backup.');
    }
    const datos = b.datos || (b.backup && b.backup.datos);
    if (!datos || typeof datos !== 'object') throw new Error('El backup no trae la sección "datos".');

    const orden = ['lineas', 'clientes', 'productos', 'suscripciones', 'gastos_recurrentes', 'ventas', 'gastos', 'ingresos', 'movimientos', 'abonos', 'bitacora'];
    const tx = db.transaction(() => {
      db.pragma('foreign_keys = OFF');
      for (const t of [...orden].reverse()) db.prepare(`DELETE FROM ${t}`).run();
      let filas = 0;
      for (const t of orden) {
        for (const f of datos[t] || []) {
          insertarFila(t, f);
          filas++;
        }
      }
      db.pragma('foreign_keys = ON');
      return filas;
    });
    const filas = tx();
    bitacora(req, 'restaurar-backup', 'todas', null, `${filas} filas`);
    return { ok: true, filas };
  })
);

// Una ruta /api que no existe devuelve JSON, no el index.html.
app.use('/api', (req, res) => res.status(404).json({ error: `Ruta desconocida: ${req.method} /api${req.path}` }));

app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'public', 'index.html')));

if (require.main === module) {
  app.listen(PORT, () => console.log(`[crt] Contable arriba en http://localhost:${PORT} (zona ${ZONA}, hoy ${hoy()})`));
}

module.exports = { app, calcularDoc, hoy, sumarMeses, mesMas, diasEntre };
