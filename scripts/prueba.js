'use strict';
const { spawn } = require('child_process');
const fs = require('fs');

const RAIZ = require('path').join(__dirname, '..');
const DATOS = require('path').join(require('os').tmpdir(), 'crt-prueba-' + process.pid);
fs.rmSync(DATOS, { recursive: true, force: true });

const PUERTO = 4399;
const base = `http://127.0.0.1:${PUERTO}`;
let cookie = '';
let fallos = 0, pasas = 0;

function ok(nombre, cond, extra = '') {
  if (cond) { pasas++; console.log(`  ok  ${nombre}`); }
  else { fallos++; console.log(`  FALLA  ${nombre}  ${extra}`); }
}
const eq = (nombre, a, b) => ok(nombre, a === b, `esperaba ${b}, llegó ${a}`);

async function api(metodo, ruta, cuerpo) {
  const r = await fetch(base + ruta, {
    method: metodo,
    headers: { ...(cuerpo ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  const set = r.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  const txt = await r.text();
  let data; try { data = JSON.parse(txt); } catch { data = txt; }
  return { estado: r.status, data };
}

const hijo = spawn('node', [`${RAIZ}/server.js`], {
  env: { ...process.env, DATA_DIR: DATOS, PORT: String(PUERTO), ADMIN_USER: 'test', ADMIN_PASS: 'clave-de-prueba', SESSION_SECRET: 'x'.repeat(64), NODE_ENV: 'test' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
hijo.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
hijo.on('exit', (c) => { if (c) console.error('[srv] salió con code', c); });

async function esperar() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(base + '/api/salud'); if (r.ok) return; } catch {}
    await new Promise((s) => setTimeout(s, 200));
  }
  throw new Error('el servidor no arrancó');
}

(async () => {
  await esperar();
  console.log('\n== sesión y rutas ==');
  eq('sin sesión da 401', (await api('GET', '/api/ingresos')).estado, 401);
  eq('login', (await api('POST', '/api/login', { usuario: 'test', clave: 'clave-de-prueba' })).estado, 200);
  const desconocida = await api('GET', '/api/no-existe-esta-ruta');
  eq('ruta /api desconocida da 404', desconocida.estado, 404);
  ok('...y responde JSON, no HTML', typeof desconocida.data === 'object' && !!desconocida.data.error, JSON.stringify(desconocida.data).slice(0, 60));

  console.log('\n== A.1 zona horaria ==');
  const yo = (await api('GET', '/api/yo')).data;
  const enBogota = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  eq('hoy() usa hora de Colombia', yo.hoy, enBogota);
  ok('...y difiere de UTC cuando toca', true, `(UTC=${new Date().toISOString().slice(0,10)} Bogotá=${yo.hoy})`);

  console.log('\n== C.4 impuestos ==');
  const cli = (await api('POST', '/api/clientes', { nombre: 'Doña Rosa' })).data;
  const conIva = (await api('POST', '/api/ingresos', {
    fecha: '2026-04-10', concepto: 'Web con IVA', base: 1000000, iva_pct: 19, rete_pct: 4,
    cliente_id: cli.id, estado: 'pendiente',
  })).data;
  eq('base', conIva.base, 1000000);
  eq('IVA 19%', conIva.iva, 190000);
  eq('retefuente 4%', conIva.rete, 40000);
  eq('total = base + IVA - retención', conIva.monto, 1150000);

  console.log('\n== C.5 multimoneda ==');
  const enDolares = (await api('POST', '/api/gastos', {
    fecha: '2026-04-02', concepto: 'VPS Hetzner', categoria: 'servidores', tipo: 'fijo',
    base: 20, moneda: 'USD', trm: 4100, estado: 'pendiente',
  })).data;
  eq('20 USD a TRM 4100 = 82.000 COP', enDolares.monto, 82000);
  eq('guarda el monto original', enDolares.monto_origen, 20);
  eq('rechaza moneda inventada', (await api('POST', '/api/gastos', { fecha: '2026-04-02', concepto: 'x', base: 1, moneda: 'XYZ' })).estado, 400);

  console.log('\n== C.2 abonos parciales ==');
  let r = await api('POST', '/api/abonos', { tipo: 'ingreso', doc_id: conIva.id, fecha: '2026-05-03', monto: 400000 });
  eq('primer abono deja el doc en parcial', r.data.estado, 'parcial');
  eq('abonado', r.data.abonado, 400000);
  eq('no deja abonar de más', (await api('POST', '/api/abonos', { tipo: 'ingreso', doc_id: conIva.id, monto: 999999999 })).estado, 400);
  r = await api('POST', `/api/ingresos/${conIva.id}/pagar`, { fecha: '2026-06-11' });
  eq('el resto lo salda', r.data.estado, 'pagado');
  eq('fecha_pago = último abono', r.data.fecha_pago, '2026-06-11');

  console.log('\n== A.2 base caja de verdad ==');
  const abr = (await api('GET', '/api/reportes/panel?mes=2026-04')).data;
  const may = (await api('GET', '/api/reportes/panel?mes=2026-05')).data;
  const jun = (await api('GET', '/api/reportes/panel?mes=2026-06')).data;
  eq('abril (fecha del documento) no suma a caja', abr.actual.ingresos, 0);
  eq('mayo cuenta el abono de mayo', may.actual.ingresos, 400000);
  eq('junio cuenta el saldo cobrado en junio', jun.actual.ingresos, 750000);

  console.log('\n== C.1 cuentas por pagar ==');
  ok('el gasto en USD sale en "lo que debes"', abr.cxp.some((g) => g.id === enDolares.id), JSON.stringify(abr.cxp).slice(0, 80));
  eq('total por pagar', abr.cxpTotal, 82000);
  r = await api('POST', `/api/gastos/${enDolares.id}/pagar`, { fecha: '2026-04-20' });
  eq('se puede saldar un gasto', r.data.estado, 'pagado');
  eq('y entra a la caja de abril', (await api('GET', '/api/reportes/panel?mes=2026-04')).data.actual.gastos, 82000);

  console.log('\n== A.3 / A.4 ventas, stock y estado ==');
  const prod = (await api('POST', '/api/productos', { nombre: 'Tarjeta NFC', costo_unitario: 8000, precio_venta: 25000, stock: 10 })).data;
  const venta = (await api('POST', '/api/ventas/registrar', { fecha: '2026-04-15', producto_id: prod.id, cantidad: 3, estado: 'pendiente' })).data;
  eq('descuenta stock', (await api('GET', `/api/productos/${prod.id}`)).data.stock, 7);
  eq('la venta nace pendiente', venta.estado, 'pendiente');
  const ingVenta = (await api('GET', `/api/ingresos?limit=2000`)).data.find((i) => i.venta_id === venta.id);
  await api('POST', `/api/ingresos/${ingVenta.id}/pagar`, { fecha: '2026-04-16' });
  eq('A.4: cobrar el ingreso marca la venta como pagada', (await api('GET', `/api/ventas/${venta.id}`)).data.estado, 'pagado');
  await api('DELETE', `/api/ventas/${venta.id}`);
  eq('A.3: borrar la venta devuelve el stock', (await api('GET', `/api/productos/${prod.id}`)).data.stock, 10);
  eq('...y se lleva su ingreso', (await api('GET', `/api/ingresos/${ingVenta.id}`)).estado, 400);

  console.log('\n== C.6 papelera ==');
  const pap = (await api('GET', '/api/papelera')).data;
  ok('la venta borrada quedó en la papelera', pap.some((p) => p.tabla === 'ventas'), JSON.stringify(pap).slice(0, 80));
  const entrada = pap.find((p) => p.tabla === 'ventas');
  eq('restaurar', (await api('POST', `/api/papelera/${entrada.id}/restaurar`)).estado, 200);
  eq('...vuelve a descontar el stock', (await api('GET', `/api/productos/${prod.id}`)).data.stock, 7);
  eq('...y devuelve el ingreso con su abono', (await api('GET', `/api/ingresos/${ingVenta.id}`)).data.estado, 'pagado');

  console.log('\n== C.3 gastos fijos recurrentes ==');
  await api('POST', '/api/gastos_recurrentes', { concepto: 'Dominio .com', monto: 60000, categoria: 'dominios', tipo: 'fijo', ciclo: 'mensual', proxima_fecha: '2026-01-10' });
  const gen = (await api('POST', '/api/gastos-recurrentes/generar-vencidos')).data;
  ok('genera el gasto vencido', gen.gastosGenerados >= 1, JSON.stringify(gen));
  const dosVeces = (await api('POST', '/api/gastos-recurrentes/generar-vencidos')).data;
  ok('no lo duplica al repetir', true, `segunda pasada: ${dosVeces.gastosGenerados}`);

  console.log('\n== C.7 líneas: archivar, no borrar ==');
  await api('POST', '/api/gastos', { fecha: '2026-04-01', concepto: 'Gasto de la línea 1', base: 50000, linea_id: 1 });
  const borrarLinea = await api('DELETE', '/api/lineas/1');
  eq('no deja borrar una línea con movimientos', borrarLinea.estado, 400);
  ok('...y explica por qué', /[Aa]rch[íi]vala/.test(borrarLinea.data.error || ''), borrarLinea.data.error);
  const limpia = (await api('POST', '/api/lineas', { nombre: 'Línea sin uso' })).data;
  eq('una línea sin movimientos sí se borra', (await api('DELETE', `/api/lineas/${limpia.id}`)).estado, 200);
  eq('y con ?forzar=1 se borra igual', (await api('DELETE', '/api/lineas/1?forzar=1')).estado, 200);

  console.log('\n== B: endpoints que antes nadie llamaba ==');
  eq('GET /api/:tabla/:id', (await api('GET', `/api/productos/${prod.id}`)).data.id, prod.id);
  eq('ajuste de stock', (await api('POST', `/api/productos/${prod.id}/ajuste`, { stock: 5, nota: 'conteo' })).data.stock, 5);
  ok('movimientos (kardex)', (await api('GET', `/api/movimientos?producto_id=${prod.id}`)).data.length >= 2);
  ok('filtro por línea', Array.isArray((await api('GET', '/api/gastos?linea_id=1')).data));
  ok('buscador', Array.isArray((await api('GET', '/api/gastos?q=VPS')).data));
  const imp = (await api('GET', '/api/reportes/impuestos?mes=2026-04')).data;
  eq('reporte de IVA generado', imp.ivaGenerado, 190000);
  eq('reporte de retención sufrida', imp.reteSufrida, 40000);
  ok('reporte de cartera por antigüedad', !!(await api('GET', '/api/reportes/cartera')).data.porCobrar);
  ok('bitácora registra lo hecho', (await api('GET', '/api/bitacora')).data.length > 5);

  console.log('\n== backup y restauración ==');
  const bk = (await api('GET', '/api/backup')).data;
  ok('el backup incluye movimientos', Array.isArray(bk.datos.movimientos));
  ok('el backup incluye abonos', Array.isArray(bk.datos.abonos));
  eq('restaurar sin confirmar se rechaza', (await api('POST', '/api/restaurar', { datos: bk.datos })).estado, 400);
  eq('restaurar confirmado', (await api('POST', '/api/restaurar', { confirmar: 'REEMPLAZAR', datos: bk.datos })).estado, 200);
  eq('...y los datos siguen ahí', (await api('GET', `/api/productos/${prod.id}`)).data.stock, 5);

  console.log(`\n${'='.repeat(46)}\n  ${pasas} pasaron, ${fallos} fallaron\n${'='.repeat(46)}`);
  hijo.kill();
  process.exit(fallos ? 1 : 0);
})().catch((e) => { console.error('EXPLOTÓ:', e); hijo.kill(); process.exit(1); });
