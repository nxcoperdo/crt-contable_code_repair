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

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1h' }));

auth.asegurarAdmin();

const hoy = () => new Date().toISOString().slice(0, 10);
const mesDe = (f) => String(f).slice(0, 7);
const entero = (v) => Math.round(Number(v) || 0);

function ok(res, fn) {
  try {
    return res.json(fn());
  } catch (e) {
    console.error(e);
    return res.status(400).json({ error: e.message });
  }
}

/* ---------------------------------- auth --------------------------------- */

app.post('/api/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'desconocida';
  const puerta = auth.loginPermitido(ip);
  if (!puerta.ok) {
    return res.status(429).json({ error: `Demasiados intentos fallidos. Espera ${puerta.esperaSegundos} s.` });
  }
  const { usuario, clave } = req.body || {};
  const u = auth.verificar(String(usuario || ''), String(clave || ''));
  if (!u) {
    auth.loginFallido(ip);
    return res.status(401).json({ error: 'Usuario o clave incorrectos.' });
  }
  auth.loginOk(ip);
  auth.darSesion(res, u);
  res.json({ usuario: u.usuario });
});

app.post('/api/logout', (req, res) => {
  auth.cerrarSesion(res);
  res.json({ ok: true });
});

app.get('/api/yo', (req, res) => {
  const s = auth.abrir(auth.cookies(req).crt_sesion);
  if (!s) return res.status(401).json({ error: 'sin sesion' });
  res.json({ usuario: s.u });
});

// Tarea programada: no requiere sesión, se autentica con CRON_SECRET.
//   0 7 * * *  curl -s -X POST "http://127.0.0.1:4300/api/cron/suscripciones?key=$CRON_SECRET"
app.post('/api/cron/suscripciones', (req, res) => {
  const key = req.query.key || req.get('x-cron-key');
  if (!process.env.CRON_SECRET || key !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'clave de cron inválida' });
  }
  ok(res, generarVencidas);
});

app.use('/api', auth.requiereSesion);

app.post('/api/cuenta/clave', (req, res) =>
  ok(res, () => {
    const { actual, nueva } = req.body || {};
    auth.cambiarClave(req.usuario, String(actual || ''), String(nueva || ''));
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
    campos: ['fecha', 'linea_id', 'cliente_id', 'concepto', 'monto', 'metodo', 'estado', 'fecha_pago', 'suscripcion_id', 'notas'],
    orden: 'fecha DESC, id DESC',
  },
  gastos: {
    campos: ['fecha', 'linea_id', 'categoria', 'concepto', 'monto', 'tipo', 'metodo', 'proveedor', 'notas'],
    orden: 'fecha DESC, id DESC',
  },
  suscripciones: {
    campos: ['cliente_id', 'linea_id', 'concepto', 'monto', 'ciclo', 'proxima_fecha', 'activa', 'notas'],
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
  if (q.q) {
    const campo = cols.includes('concepto') ? 'concepto' : 'nombre';
    cond.push(campo + ' LIKE ?');
    args.push('%' + q.q + '%');
  }
  return { where: cond.length ? 'WHERE ' + cond.join(' AND ') : '', args };
}

// Validaciones comunes antes de insertar/actualizar cualquier tabla.
const CAMPOS_MONTO = ['monto', 'costo_unitario', 'precio_venta', 'precio_unitario', 'total', 'cantidad', 'stock', 'stock_minimo'];
function revisarComunes(body) {
  for (const k of CAMPOS_MONTO) {
    if (body[k] !== undefined && body[k] !== '' && body[k] !== null) {
      const n = Number(body[k]);
      if (!Number.isFinite(n)) throw new Error(`"${k}" no es un número válido`);
      if (n < 0 && k !== 'cantidad') throw new Error(`"${k}" no puede ser negativo`);
    }
  }
  for (const k of ['fecha', 'fecha_pago', 'proxima_fecha']) {
    if (body[k] && !/^\d{4}-\d{2}-\d{2}$/.test(String(body[k]))) {
      throw new Error(`"${k}" debe tener el formato AAAA-MM-DD`);
    }
  }
}

for (const [tabla, def] of Object.entries(TABLAS)) {
  app.get('/api/' + tabla, (req, res) =>
    ok(res, () => {
      const { where, args } = filtros(tabla, req.query);
      const limite = Math.min(entero(req.query.limit) || 300, 2000);
      return db.prepare(`SELECT * FROM ${tabla} ${where} ORDER BY ${def.orden} LIMIT ${limite}`).all(...args);
    })
  );

  app.post('/api/' + tabla, (req, res) =>
    ok(res, () => {
      revisarComunes(req.body || {});
      const usados = def.campos.filter((c) => req.body[c] !== undefined && req.body[c] !== '');
      if (!usados.length) throw new Error('No enviaste ningún dato');
      const info = db
        .prepare(
          `INSERT INTO ${tabla} (${usados.join(',')}, creado)
           VALUES (${usados.map(() => '?').join(',')}, datetime('now'))`
        )
        .run(...usados.map((c) => req.body[c]));
      return db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(info.lastInsertRowid);
    })
  );

  app.put('/api/' + tabla + '/:id', (req, res) =>
    ok(res, () => {
      revisarComunes(req.body || {});
      const campos = def.campos.filter((c) => req.body[c] !== undefined);
      if (!campos.length) throw new Error('Nada que actualizar');
      db.prepare(`UPDATE ${tabla} SET ${campos.map((c) => c + ' = ?').join(', ')} WHERE id = ?`).run(
        ...campos.map((c) => (req.body[c] === '' ? null : req.body[c])),
        entero(req.params.id)
      );
      return db.prepare(`SELECT * FROM ${tabla} WHERE id = ?`).get(entero(req.params.id));
    })
  );

  app.delete('/api/' + tabla + '/:id', (req, res) =>
    ok(res, () => {
      db.prepare(`DELETE FROM ${tabla} WHERE id = ?`).run(entero(req.params.id));
      return { ok: true };
    })
  );
}

/* ------------------------- acciones especializadas ------------------------ */

app.post('/api/ingresos/:id/pagar', (req, res) =>
  ok(res, () => {
    const fecha = req.body.fecha || hoy();
    db.prepare(`UPDATE ingresos SET estado='pagado', fecha_pago=? WHERE id=?`).run(fecha, entero(req.params.id));
    return db.prepare('SELECT * FROM ingresos WHERE id = ?').get(entero(req.params.id));
  })
);

function avanzar(fecha, ciclo) {
  const d = new Date(fecha + 'T12:00:00');
  if (ciclo === 'anual') d.setFullYear(d.getFullYear() + 1);
  else d.setMonth(d.getMonth() + 1);
  return d.toISOString().slice(0, 10);
}

function generarVencidas() {
  const vencidas = db.prepare('SELECT * FROM suscripciones WHERE activa = 1 AND proxima_fecha <= ?').all(hoy());
  let generados = 0;
  const tx = db.transaction((lista) => {
    for (const s of lista) {
      const yaExiste = db
        .prepare('SELECT id FROM ingresos WHERE suscripcion_id = ? AND fecha = ?')
        .get(s.id, s.proxima_fecha);
      if (!yaExiste) {
        db.prepare(
          `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, monto, metodo, estado, suscripcion_id, notas, creado)
           VALUES (?, ?, ?, ?, ?, 'nequi', 'pendiente', ?, '', datetime('now'))`
        ).run(s.proxima_fecha, s.linea_id, s.cliente_id, s.concepto, s.monto, s.id);
        generados++;
      }
      db.prepare('UPDATE suscripciones SET proxima_fecha = ? WHERE id = ?').run(avanzar(s.proxima_fecha, s.ciclo), s.id);
    }
  });
  tx(vencidas);
  return { generados };
}

app.post('/api/suscripciones/generar-vencidas', (req, res) => ok(res, generarVencidas));

app.post('/api/suscripciones/:id/cobrar', (req, res) =>
  ok(res, () => {
    const id = entero(req.params.id);
    const s = db.prepare('SELECT * FROM suscripciones WHERE id = ?').get(id);
    if (!s) throw new Error('Suscripción no encontrada');
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, monto, metodo, estado, suscripcion_id, notas, creado)
         VALUES (?, ?, ?, ?, ?, ?, 'pendiente', ?, '', datetime('now'))`
      ).run(s.proxima_fecha, s.linea_id, s.cliente_id, s.concepto, s.monto, req.body.metodo || 'nequi', s.id);
      db.prepare('UPDATE suscripciones SET proxima_fecha = ? WHERE id = ?').run(avanzar(s.proxima_fecha, s.ciclo), s.id);
    });
    tx();
    return db.prepare('SELECT * FROM suscripciones WHERE id = ?').get(id);
  })
);

app.post('/api/productos/:id/entrada', (req, res) =>
  ok(res, () => {
    const id = entero(req.params.id);
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    if (!p) throw new Error('Producto no encontrado');
    const cantidad = entero(req.body.cantidad);
    if (cantidad <= 0) throw new Error('La cantidad debe ser mayor que cero');
    const costo =
      req.body.costo_unitario !== undefined && req.body.costo_unitario !== ''
        ? entero(req.body.costo_unitario)
        : p.costo_unitario;
    const fecha = req.body.fecha || hoy();
    const registrarGasto = req.body.registrar_gasto !== false;

    const tx = db.transaction(() => {
      let gastoId = null;
      if (registrarGasto && costo > 0) {
        gastoId = db
          .prepare(
            `INSERT INTO gastos (fecha, linea_id, categoria, concepto, monto, tipo, metodo, proveedor, notas, creado)
             VALUES (?, ?, 'inventario', ?, ?, 'variable', ?, ?, '', datetime('now'))`
          )
          .run(fecha, p.linea_id, `Compra ${cantidad} x ${p.nombre}`, costo * cantidad, req.body.metodo || 'efectivo', req.body.proveedor || '')
          .lastInsertRowid;
      }
      db.prepare(
        `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, gasto_id, creado)
         VALUES (?, ?, 'entrada', ?, ?, ?, ?, datetime('now'))`
      ).run(id, fecha, cantidad, costo, req.body.nota || '', gastoId);
      db.prepare('UPDATE productos SET stock = stock + ?, costo_unitario = ? WHERE id = ?').run(cantidad, costo, id);
    });
    tx();
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

app.post('/api/productos/:id/ajuste', (req, res) =>
  ok(res, () => {
    const id = entero(req.params.id);
    const nuevo = entero(req.body.stock);
    const p = db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
    if (!p) throw new Error('Producto no encontrado');
    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, creado)
         VALUES (?, ?, 'ajuste', ?, ?, ?, datetime('now'))`
      ).run(id, hoy(), nuevo - p.stock, p.costo_unitario, req.body.nota || 'Ajuste manual');
      db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevo, id);
    });
    tx();
    return db.prepare('SELECT * FROM productos WHERE id = ?').get(id);
  })
);

app.get('/api/movimientos', (req, res) =>
  ok(res, () => {
    const cond = [];
    const args = [];
    if (req.query.producto_id) {
      cond.push('m.producto_id = ?');
      args.push(entero(req.query.producto_id));
    }
    return db
      .prepare(
        `SELECT m.*, p.nombre AS producto FROM movimientos m
         LEFT JOIN productos p ON p.id = m.producto_id
         ${cond.length ? 'WHERE ' + cond.join(' AND ') : ''}
         ORDER BY m.fecha DESC, m.id DESC LIMIT 200`
      )
      .all(...args);
  })
);

app.post('/api/ventas/registrar', (req, res) =>
  ok(res, () => {
    const b = req.body || {};
    revisarComunes(b);
    const cantidad = entero(b.cantidad) || 1;
    const fecha = b.fecha || hoy();
    const p = b.producto_id ? db.prepare('SELECT * FROM productos WHERE id = ?').get(entero(b.producto_id)) : null;
    const precio = entero(b.precio_unitario !== undefined && b.precio_unitario !== '' ? b.precio_unitario : p ? p.precio_venta : 0);
    const costo = entero(b.costo_unitario !== undefined && b.costo_unitario !== '' ? b.costo_unitario : p ? p.costo_unitario : 0);
    const total = precio * cantidad;
    const estado = b.estado === 'pendiente' ? 'pendiente' : 'pagado';
    const lineaId = b.linea_id ? entero(b.linea_id) : p ? p.linea_id : null;
    if (p && p.stock < cantidad && b.permitir_negativo !== true)
      throw new Error(`Stock insuficiente: quedan ${p.stock} de ${p.nombre}`);

    const tx = db.transaction(() => {
      const ventaId = db
        .prepare(
          `INSERT INTO ventas (fecha, cliente_id, producto_id, linea_id, cantidad, precio_unitario, costo_unitario, total, metodo, estado, notas, creado)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .run(fecha, b.cliente_id || null, p ? p.id : null, lineaId, cantidad, precio, costo, total, b.metodo || 'efectivo', estado, b.notas || '')
        .lastInsertRowid;

      if (p) {
        db.prepare(
          `INSERT INTO movimientos (producto_id, fecha, tipo, cantidad, costo_unitario, nota, venta_id, creado)
           VALUES (?, ?, 'salida', ?, ?, 'Venta', ?, datetime('now'))`
        ).run(p.id, fecha, cantidad, costo, ventaId);
        db.prepare('UPDATE productos SET stock = stock - ? WHERE id = ?').run(cantidad, p.id);
      }

      db.prepare(
        `INSERT INTO ingresos (fecha, linea_id, cliente_id, concepto, monto, metodo, estado, fecha_pago, venta_id, notas, creado)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
      ).run(
        fecha,
        lineaId,
        b.cliente_id || null,
        `Venta ${cantidad} x ${p ? p.nombre : b.concepto || 'producto'}`,
        total,
        b.metodo || 'efectivo',
        estado,
        estado === 'pagado' ? fecha : null,
        ventaId,
        b.notas || ''
      );
      return ventaId;
    });
    const id = tx();
    return db.prepare('SELECT * FROM ventas WHERE id = ?').get(id);
  })
);

/* -------------------------------- reportes -------------------------------- */

function totalesMes(mes) {
  const ingresos = db.prepare(`SELECT COALESCE(SUM(monto),0) t FROM ingresos WHERE substr(fecha,1,7)=? AND estado='pagado'`).get(mes).t;
  const pendiente = db.prepare(`SELECT COALESCE(SUM(monto),0) t FROM ingresos WHERE substr(fecha,1,7)=? AND estado='pendiente'`).get(mes).t;
  const gastos = db.prepare('SELECT COALESCE(SUM(monto),0) t FROM gastos WHERE substr(fecha,1,7)=?').get(mes).t;
  const fijos = db.prepare(`SELECT COALESCE(SUM(monto),0) t FROM gastos WHERE substr(fecha,1,7)=? AND tipo='fijo'`).get(mes).t;
  return { mes, ingresos, pendiente, gastos, fijos, variables: gastos - fijos, utilidad: ingresos - gastos };
}

app.get('/api/reportes/panel', (req, res) =>
  ok(res, () => {
    const mes = req.query.mes || mesDe(hoy());
    const d = new Date(mes + '-01T12:00:00');
    d.setMonth(d.getMonth() - 1);
    const mesAnterior = d.toISOString().slice(0, 7);

    const porLinea = db
      .prepare(
        `SELECT l.id, l.nombre, l.color, l.tipo,
            (SELECT COALESCE(SUM(monto),0) FROM ingresos i WHERE i.linea_id=l.id AND substr(i.fecha,1,7)=? AND i.estado='pagado') AS ingresos,
            (SELECT COALESCE(SUM(monto),0) FROM gastos g WHERE g.linea_id=l.id AND substr(g.fecha,1,7)=?) AS gastos
         FROM lineas l WHERE l.activa=1 ORDER BY ingresos DESC`
      )
      .all(mes, mes)
      .map((r) => ({ ...r, margen: r.ingresos - r.gastos, pct: r.ingresos ? Math.round(((r.ingresos - r.gastos) / r.ingresos) * 100) : 0 }));

    const cxc = db
      .prepare(
        `SELECT i.id, i.fecha, i.concepto, i.monto, c.nombre AS cliente, l.nombre AS linea,
                CAST(julianday('now') - julianday(i.fecha) AS INTEGER) AS dias
         FROM ingresos i
         LEFT JOIN clientes c ON c.id=i.cliente_id
         LEFT JOIN lineas l ON l.id=i.linea_id
         WHERE i.estado='pendiente' ORDER BY i.fecha LIMIT 50`
      )
      .all();

    const gastosFijos = db
      .prepare(
        `SELECT g.concepto, g.categoria, g.monto, l.nombre AS linea
         FROM gastos g LEFT JOIN lineas l ON l.id=g.linea_id
         WHERE substr(g.fecha,1,7)=? AND g.tipo='fijo' ORDER BY g.monto DESC`
      )
      .all(mes);

    const mrr = db
      .prepare(`SELECT COALESCE(SUM(CASE WHEN ciclo='anual' THEN monto/12 ELSE monto END),0) t FROM suscripciones WHERE activa=1`)
      .get().t;

    const serie = [];
    for (let i = 11; i >= 0; i--) {
      const x = new Date(mes + '-01T12:00:00');
      x.setMonth(x.getMonth() - i);
      serie.push(totalesMes(x.toISOString().slice(0, 7)));
    }

    const alertasStock = db.prepare('SELECT nombre, stock, stock_minimo FROM productos WHERE activo=1 AND stock <= stock_minimo').all();

    const actual = totalesMes(mes);
    const previo = totalesMes(mesAnterior);
    const margenContribucion = actual.ingresos ? (actual.ingresos - actual.variables) / actual.ingresos : 0;

    return {
      mes,
      actual,
      previo,
      porLinea,
      cxc,
      cxcTotal: cxc.reduce((a, b) => a + b.monto, 0),
      gastosFijos,
      mrr,
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
            (SELECT COALESCE(SUM(monto),0) FROM ingresos i WHERE i.linea_id=l.id AND i.estado='pagado' AND i.fecha BETWEEN ? AND ?) AS ingresos,
            (SELECT COALESCE(SUM(monto),0) FROM gastos g WHERE g.linea_id=l.id AND g.fecha BETWEEN ? AND ?) AS gastos,
            (SELECT COALESCE(SUM(monto),0) FROM ingresos i WHERE i.linea_id=l.id AND i.estado='pendiente' AND i.fecha BETWEEN ? AND ?) AS por_cobrar
         FROM lineas l ORDER BY ingresos DESC`
      )
      .all(desde, hasta, desde, hasta, desde, hasta)
      .map((r) => ({ ...r, margen: r.ingresos - r.gastos, pct: r.ingresos ? Math.round(((r.ingresos - r.gastos) / r.ingresos) * 100) : 0 }));
  })
);

app.get('/api/reportes/categorias', (req, res) =>
  ok(res, () => {
    const desde = req.query.desde || '0000-01-01';
    const hasta = req.query.hasta || '9999-12-31';
    return db
      .prepare(
        `SELECT categoria, tipo, COUNT(*) n, SUM(monto) total FROM gastos
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

/* -------------------------------- exportar -------------------------------- */

app.get('/api/export/:tabla.csv', (req, res) => {
  const tabla = req.params.tabla;
  if (!TABLAS[tabla]) return res.status(404).json({ error: 'Tabla desconocida' });
  const filas = db.prepare(`SELECT * FROM ${tabla} ORDER BY id`).all();
  const cols = filas.length ? Object.keys(filas[0]) : ['id'];
  const escapar = (v) => '"' + String(v === null || v === undefined ? '' : v).replace(/"/g, '""') + '"';
  const csv = [cols.join(','), ...filas.map((f) => cols.map((c) => escapar(f[c])).join(','))].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${tabla}-${hoy()}.csv"`);
  res.send('\uFEFF' + csv);
});

app.get('/api/backup', (req, res) =>
  res.json({
    generado: new Date().toISOString(),
    datos: Object.fromEntries(Object.keys(TABLAS).map((t) => [t, db.prepare(`SELECT * FROM ${t}`).all()])),
  })
);

app.use((req, res) => res.status(200).sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log('[crt] Contable arriba en http://localhost:' + PORT));
