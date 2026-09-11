'use strict';

/* ------------------------------- utilidades ------------------------------- */

const $ = (s, ctx = document) => ctx.querySelector(s);
const $$ = (s, ctx = document) => Array.from(ctx.querySelectorAll(s));

// Hora de Colombia, no UTC: si no, todo lo registrado después de las 7 p.m.
// se fechaba al día siguiente.
const ZONA = 'America/Bogota';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: ZONA, year: 'numeric', month: '2-digit', day: '2-digit' });
const hoy = () => fmtDia.format(new Date());
const mesActual = () => hoy().slice(0, 7);

const pesos = (n) => '$' + new Intl.NumberFormat('es-CO').format(Math.round(n || 0));
const corto = (n) => {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1).replace('.', ',') + ' M';
  if (a >= 1000) return Math.round(n / 1000) + ' k';
  return String(Math.round(n));
};
const nombreMes = (m) => {
  const d = new Date(m + '-01T12:00:00');
  return d.toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
};
// porcentaje con hasta 1 decimal, coma decimal (es-CO). pct1(40) -> "40", pct1(66.666) -> "66,7"
const pct1 = (n) => {
  const r = Math.round((Number(n) || 0) * 10) / 10;
  return (Number.isInteger(r) ? String(r) : r.toFixed(1)).replace('.', ',');
};
// margen de ganancia = sobre el precio de venta;  rentabilidad = sobre el costo
const margenSobreVenta = (venta, costo) => (venta > 0 ? ((venta - costo) / venta) * 100 : 0);
const margenSobreCosto = (venta, costo) => (costo > 0 ? ((venta - costo) / costo) * 100 : 0);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const ETIQUETA_ESTADO = { pagado: 'pagado', parcial: 'abonado', pendiente: 'por cobrar' };
const ETIQUETA_ESTADO_GASTO = { pagado: 'pagado', parcial: 'abonado', pendiente: 'por pagar' };
const marcaEstado = (estado, mapa = ETIQUETA_ESTADO) =>
  `<span class="marca-estado estado-${esc(estado)}">${esc(mapa[estado] || estado)}</span>`;

function aviso(texto) {
  const el = $('#aviso');
  el.textContent = texto;
  el.hidden = false;
  clearTimeout(aviso.t);
  aviso.t = setTimeout(() => (el.hidden = true), 2600);
}

const sinMovimiento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Cuenta ascendente para los elementos [data-contar] recién pintados.
function animarCifras(root) {
  if (sinMovimiento()) return;
  root.querySelectorAll('[data-contar]').forEach((el) => {
    const fin = Number(el.dataset.contar) || 0;
    if (!fin) return;
    const texto = el.textContent;
    const ini = performance.now();
    const dur = 650;
    const paso = (t) => {
      const k = Math.min(1, (t - ini) / dur);
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = pesos(fin * e);
      if (k < 1) requestAnimationFrame(paso);
      else el.textContent = texto;
    };
    requestAnimationFrame(paso);
  });
}

async function api(metodo, ruta, cuerpo) {
  const r = await fetch('/api' + ruta, {
    method: metodo,
    headers: cuerpo ? { 'Content-Type': 'application/json' } : {},
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (r.status === 401 && ruta !== '/login') {
    estado.usuario = null;
    mostrarEntrada();
    throw new Error('Sesión expirada');
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Algo falló en el servidor');
  return data;
}

/* --------------------------------- estado --------------------------------- */

const estado = {
  usuario: null,
  vista: 'panel',
  mes: mesActual(),
  lineas: [],
  clientes: [],
  productos: [],
  filtro: { linea_id: '', estado: '', q: '', producto_id: '', categoria: '' },
};

const VISTAS = [
  ['panel', 'Panel'],
  ['ingresos', 'Ingresos'],
  ['gastos', 'Gastos'],
  ['ventas', 'Ventas'],
  ['inventario', 'Inventario'],
  ['suscripciones', 'Cobros'],
  ['recurrentes', 'Pagos fijos'],
  ['clientes', 'Clientes'],
  ['lineas', 'Líneas'],
  ['reportes', 'Reportes'],
  ['papelera', 'Papelera'],
];

const nombreLinea = (id) => (estado.lineas.find((l) => l.id === id) || {}).nombre || 'General';
const colorLinea = (id) => (estado.lineas.find((l) => l.id === id) || {}).color || '#5F6E67';
const nombreCliente = (id) => (estado.clientes.find((c) => c.id === id) || {}).nombre || '';
const nombreProducto = (id) => (estado.productos.find((p) => p.id === id) || {}).nombre || '';

const opcionesLinea = () => [{ v: '', t: 'General (sin línea)' }, ...estado.lineas.map((l) => ({ v: l.id, t: l.nombre }))];
const opcionesCliente = () => [{ v: '', t: 'Sin cliente' }, ...estado.clientes.map((c) => ({ v: c.id, t: c.nombre + (c.negocio ? ' · ' + c.negocio : '') }))];
const opcionesProducto = () => estado.productos.map((p) => ({ v: p.id, t: `${p.nombre} (${p.stock} en stock)` }));

const METODOS = ['nequi', 'daviplata', 'bre-b', 'mercadopago', 'transferencia', 'efectivo', 'otro'].map((v) => ({ v, t: v }));
const CATEGORIAS = ['servidores', 'apis', 'dominios', 'whatsapp api', 'inventario', 'materiales', 'transporte', 'publicidad', 'herramientas', 'impuestos', 'otros'].map((v) => ({ v, t: v }));
const MONEDAS = [{ v: 'COP', t: 'COP · pesos' }, { v: 'USD', t: 'USD · dólares' }, { v: 'EUR', t: 'EUR · euros' }];
const IVAS = [{ v: 0, t: 'Sin IVA (0%)' }, { v: 5, t: '5%' }, { v: 19, t: '19%' }];
const CICLOS = [{ v: 'mensual', t: 'Mensual' }, { v: 'anual', t: 'Anual' }];

/* --------------------------- campos de documento --------------------------
   Ingresos y gastos comparten la parte fiscal: base, IVA, retención y moneda.
   El total sale calculado; no se escribe a mano.
-------------------------------------------------------------------------- */

const camposFiscales = () => [
  { k: 'base', l: 'Base (antes de IVA)', t: 'number', req: true },
  { k: 'iva_pct', l: 'IVA', t: 'select', opts: () => IVAS, def: 0 },
  { k: 'rete_pct', l: 'Retención %', t: 'number', def: 0, paso: '0.1' },
  { k: 'moneda', l: 'Moneda', t: 'select', opts: () => MONEDAS, def: 'COP' },
  { k: 'trm', l: 'TRM (pesos por unidad)', t: 'number', def: 1, soloSi: (d) => d.moneda && d.moneda !== 'COP' },
];

// Rehace la cuenta del documento igual que el servidor, para el previo en vivo.
function totalDocumento(d) {
  const moneda = d.moneda || 'COP';
  const trm = moneda === 'COP' ? 1 : Number(d.trm) || 1;
  const base = Math.round((Number(d.base) || 0) * trm);
  const iva = Math.round((base * (Number(d.iva_pct) || 0)) / 100);
  const rete = Math.round((base * (Number(d.rete_pct) || 0)) / 100);
  return { base, iva, rete, total: base + iva - rete, moneda, trm };
}

function resumenDocumento(d) {
  const c = totalDocumento(d);
  const partes = [`Base ${pesos(c.base)}`];
  if (c.iva) partes.push(`IVA ${pesos(c.iva)}`);
  if (c.rete) partes.push(`− retención ${pesos(c.rete)}`);
  if (c.moneda !== 'COP') partes.push(`${Number(d.base) || 0} ${c.moneda} × ${c.trm}`);
  return `${partes.join(' · ')} = <b class="num">${pesos(c.total)}</b>`;
}

/* ------------------------------ formularios ------------------------------- */

const FORMULARIOS = {
  ingresos: () => [
    { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
    ...camposFiscales(),
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'cliente_id', l: 'Cliente', t: 'select', opts: opcionesCliente },
    { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'nequi' },
    { k: 'estado', l: 'Estado', t: 'select', opts: () => [{ v: 'pagado', t: 'Ya me lo pagaron' }, { v: 'pendiente', t: 'Por cobrar' }], def: 'pagado' },
    { k: 'vence', l: 'Vence el', t: 'date', soloSi: (d) => d.estado === 'pendiente' },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
  ],
  gastos: () => [
    { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
    ...camposFiscales(),
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'categoria', l: 'Categoría', t: 'select', opts: () => CATEGORIAS, def: 'servidores' },
    { k: 'tipo', l: 'Tipo', t: 'select', opts: () => [{ v: 'fijo', t: 'Fijo (todos los meses)' }, { v: 'variable', t: 'Variable' }], def: 'variable' },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'nequi' },
    { k: 'estado', l: 'Estado', t: 'select', opts: () => [{ v: 'pagado', t: 'Ya lo pagué' }, { v: 'pendiente', t: 'Lo debo' }], def: 'pagado' },
    { k: 'vence', l: 'Vence el', t: 'date', soloSi: (d) => d.estado === 'pendiente' },
    { k: 'proveedor', l: 'Proveedor', t: 'text', ancho: true },
  ],
  suscripciones: () => [
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'monto', l: 'Monto (base)', t: 'number', req: true },
    { k: 'iva_pct', l: 'IVA', t: 'select', opts: () => IVAS, def: 0 },
    { k: 'rete_pct', l: 'Retención %', t: 'number', def: 0, paso: '0.1' },
    { k: 'ciclo', l: 'Ciclo', t: 'select', opts: () => CICLOS, def: 'mensual' },
    { k: 'cliente_id', l: 'Cliente', t: 'select', opts: opcionesCliente },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'proxima_fecha', l: 'Próximo cobro', t: 'date', def: hoy(), req: true },
    { k: 'activa', l: 'Estado', t: 'select', opts: () => [{ v: 1, t: 'Activa' }, { v: 0, t: 'Cancelada' }], def: 1 },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
  ],
  gastos_recurrentes: () => [
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'monto', l: 'Monto (base)', t: 'number', req: true },
    { k: 'moneda', l: 'Moneda', t: 'select', opts: () => MONEDAS, def: 'COP' },
    { k: 'trm', l: 'TRM (pesos por unidad)', t: 'number', def: 1, soloSi: (d) => d.moneda && d.moneda !== 'COP' },
    { k: 'iva_pct', l: 'IVA', t: 'select', opts: () => IVAS, def: 0 },
    { k: 'categoria', l: 'Categoría', t: 'select', opts: () => CATEGORIAS, def: 'servidores' },
    { k: 'tipo', l: 'Tipo', t: 'select', opts: () => [{ v: 'fijo', t: 'Fijo' }, { v: 'variable', t: 'Variable' }], def: 'fijo' },
    { k: 'ciclo', l: 'Ciclo', t: 'select', opts: () => CICLOS, def: 'mensual' },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'nequi' },
    { k: 'proxima_fecha', l: 'Próximo pago', t: 'date', def: hoy(), req: true },
    { k: 'activa', l: 'Estado', t: 'select', opts: () => [{ v: 1, t: 'Activo' }, { v: 0, t: 'Pausado' }], def: 1 },
    { k: 'proveedor', l: 'Proveedor', t: 'text', ancho: true },
  ],
  clientes: () => [
    { k: 'nombre', l: 'Nombre', t: 'text', req: true, ancho: true },
    { k: 'negocio', l: 'Negocio', t: 'text' },
    { k: 'telefono', l: 'Teléfono', t: 'text' },
    { k: 'ciudad', l: 'Ciudad', t: 'text', def: 'Gigante' },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
  ],
  lineas: () => [
    { k: 'nombre', l: 'Nombre', t: 'text', req: true, ancho: true },
    { k: 'tipo', l: 'Tipo', t: 'select', opts: () => ['app', 'servicio', 'producto', 'reparacion'].map((v) => ({ v, t: v })), def: 'app' },
    { k: 'color', l: 'Color', t: 'color', def: '#12704B' },
    { k: 'activa', l: 'Estado', t: 'select', opts: () => [{ v: 1, t: 'Activa' }, { v: 0, t: 'Archivada' }], def: 1 },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
  ],
  productos: () => [
    { k: 'nombre', l: 'Producto', t: 'text', req: true, ancho: true },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'sku', l: 'Código', t: 'text' },
    { k: 'costo_unitario', l: 'Costo unitario', t: 'number', def: 0 },
    { k: 'precio_venta', l: 'Precio de venta', t: 'number', def: 0 },
    { k: 'stock', l: 'Stock inicial', t: 'number', def: 0 },
    { k: 'stock_minimo', l: 'Aviso bajo stock', t: 'number', def: 0 },
  ],
};

// Ingresos y gastos llevan el previo del total en vivo.
const RESUMEN_FORM = { ingresos: resumenDocumento, gastos: resumenDocumento };

let formActual = null;

function valoresForm() {
  const datos = {};
  if (!formActual) return datos;
  for (const c of formActual.campos) {
    const el = $(`[data-k="${c.k}"]`, $('#modal-campos'));
    if (el) datos[c.k] = el.value;
  }
  return datos;
}

// Aplica las reglas soloSi y repinta el previo del total.
function refrescarForm() {
  if (!formActual) return;
  const datos = valoresForm();
  for (const c of formActual.campos) {
    if (!c.soloSi) continue;
    const el = $(`[data-k="${c.k}"]`, $('#modal-campos'));
    if (el && el.closest('label')) el.closest('label').hidden = !c.soloSi(datos);
  }
  const caja = $('#modal-resumen');
  if (caja) {
    if (formActual.resumen) {
      caja.innerHTML = formActual.resumen(datos);
      caja.hidden = false;
    } else {
      caja.hidden = true;
    }
  }
}

function campoHtml(c, valores) {
  const val = valores[c.k] !== undefined && valores[c.k] !== null ? valores[c.k] : c.def !== undefined ? c.def : '';
  const clase = 'campo' + (c.ancho ? ' ancho' : '');
  if (c.t === 'select') {
    const opciones = (typeof c.opts === 'function' ? c.opts() : c.opts)
      .map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(val) ? ' selected' : ''}>${esc(o.t)}</option>`)
      .join('');
    return `<label class="${clase}"><span>${esc(c.l)}</span><select data-k="${c.k}">${opciones}</select></label>`;
  }
  const extra = c.t === 'number' ? ` inputmode="decimal" step="${c.paso || '1'}"` : '';
  return `<label class="${clase}"><span>${esc(c.l)}</span><input data-k="${c.k}" type="${c.t}" value="${esc(val)}"${extra}></label>`;
}

function abrirFormulario({ titulo, campos, valores = {}, alGuardar, resumen, encabezado = '', textoGuardar = 'Guardar' }) {
  formActual = { campos, alGuardar, resumen };
  $('#modal-titulo').textContent = titulo;
  $('#modal-error').hidden = true;
  const cont = $('#modal-campos');
  cont.innerHTML =
    (encabezado ? `<div class="modal-encabezado ancho">${encabezado}</div>` : '') +
    campos.map((c) => campoHtml(c, valores)).join('') +
    `<p class="modal-resumen ancho" id="modal-resumen" hidden></p>`;
  const guardar = $('#modal-guardar');
  guardar.hidden = !campos.length && !alGuardar;
  guardar.textContent = textoGuardar;
  $('#modal').hidden = false;
  refrescarForm();
  const primero = cont.querySelector('input:not([hidden]),select');
  if (primero && window.innerWidth > 760) primero.focus();
}

function cerrarFormulario() {
  $('#modal').hidden = true;
  formActual = null;
}

async function guardarFormulario() {
  if (!formActual) return;
  const datos = {};
  for (const c of formActual.campos) {
    const el = $(`[data-k="${c.k}"]`, $('#modal-campos'));
    if (!el) continue;
    const oculto = el.closest('label') && el.closest('label').hidden;
    let v = el.value;
    if (c.req && !oculto && !String(v).trim()) {
      $('#modal-error').textContent = `Falta ${c.l.toLowerCase()}.`;
      $('#modal-error').hidden = false;
      el.focus();
      return;
    }
    if (oculto) continue;
    if (c.t === 'number' && v !== '') v = Number(v);
    datos[c.k] = v;
  }
  try {
    await formActual.alGuardar(datos);
    cerrarFormulario();
    aviso('Guardado');
    await cargarCatalogos();
    render();
  } catch (e) {
    $('#modal-error').textContent = e.message;
    $('#modal-error').hidden = false;
  }
}

const TITULOS_NUEVO = {
  ingresos: 'Nuevo ingreso',
  gastos: 'Nuevo gasto',
  suscripciones: 'Nuevo cobro recurrente',
  gastos_recurrentes: 'Nuevo pago fijo',
  clientes: 'Nuevo cliente',
  lineas: 'Nueva línea',
  productos: 'Nuevo producto',
};

function nuevo(tabla) {
  abrirFormulario({
    titulo: TITULOS_NUEVO[tabla] || 'Nuevo registro',
    campos: FORMULARIOS[tabla](),
    resumen: RESUMEN_FORM[tabla],
    alGuardar: (d) => api('POST', '/' + tabla, d),
  });
}

async function editar(tabla, id) {
  // Una sola fila, no la tabla entera.
  const fila = await api('GET', `/${tabla}/${id}`);
  if (fila.monto_origen !== undefined && fila.moneda && fila.moneda !== 'COP') fila.base = fila.monto_origen;
  abrirFormulario({
    titulo: 'Editar',
    campos: FORMULARIOS[tabla](),
    valores: fila,
    resumen: RESUMEN_FORM[tabla],
    alGuardar: (d) => api('PUT', `/${tabla}/${id}`, d),
  });
}

async function borrar(tabla, id) {
  if (!confirm('¿Borrar este registro? Queda en la Papelera por si te arrepientes.')) return;
  await api('DELETE', `/${tabla}/${id}`);
  aviso('Borrado — está en la Papelera');
  await cargarCatalogos();
  render();
}

/* --------------------------------- abonos --------------------------------- */

async function abrirAbonos(tipo, id) {
  const tabla = tipo === 'ingreso' ? 'ingresos' : 'gastos';
  const doc = await api('GET', `/${tabla}/${id}`);
  const abonos = await api('GET', `/abonos?tipo=${tipo}&doc_id=${id}`);
  const saldo = doc.monto - doc.abonado;
  const mapa = tipo === 'ingreso' ? ETIQUETA_ESTADO : ETIQUETA_ESTADO_GASTO;

  const listado = abonos.length
    ? abonos
        .map(
          (a) => `<div class="fila fila-compacta">
            <span class="fila-principal">${esc(a.fecha)} · ${esc(a.metodo || '')}</span>
            <span class="fila-monto num">${pesos(a.monto)}</span>
            ${a.nota ? `<span class="fila-detalle">${esc(a.nota)}</span>` : ''}
            <span class="fila-acciones"><button class="btn-mini" data-borrar-abono="${a.id}:${tipo}:${id}">Quitar</button></span>
          </div>`
        )
        .join('')
    : '<p class="vacio">Todavía no hay abonos.</p>';

  const encabezado = `
    <p class="modal-doc"><b>${esc(doc.concepto)}</b> · ${esc(doc.fecha)} ${marcaEstado(doc.estado, mapa)}</p>
    <p class="sub num">Total ${pesos(doc.monto)} · abonado ${pesos(doc.abonado)} · <b class="${saldo > 0 ? 'monto-negativo' : 'monto-positivo'}">saldo ${pesos(saldo)}</b></p>
    <div class="progreso"><span style="width:${Math.min(100, doc.monto ? (doc.abonado / doc.monto) * 100 : 0)}%"></span></div>
    <div class="filas filas-abonos">${listado}</div>
    ${saldo > 0 ? '<p class="sub">Registrar un abono nuevo:</p>' : ''}`;

  abrirFormulario({
    titulo: tipo === 'ingreso' ? 'Abonos del cobro' : 'Abonos del pago',
    encabezado,
    campos: saldo > 0
      ? [
          { k: 'fecha', l: 'Fecha del abono', t: 'date', def: hoy() },
          { k: 'monto', l: 'Monto', t: 'number', def: saldo, req: true },
          { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: doc.metodo || 'nequi' },
          { k: 'nota', l: 'Nota', t: 'text', ancho: true },
        ]
      : [],
    textoGuardar: 'Registrar abono',
    alGuardar: saldo > 0 ? (d) => api('POST', '/abonos', { ...d, tipo, doc_id: id }) : null,
  });
  if (saldo <= 0) $('#modal-guardar').hidden = true;
}

/* --------------------------------- gráfica -------------------------------- */

function graficaUtilidad(serie) {
  const w = 700, h = 220, padX = 30, padY = 22;
  const max = Math.max(1, ...serie.map((s) => Math.max(Math.abs(s.utilidad), s.ingresos)));
  const anchoCol = (w - padX * 2) / serie.length;
  const cero = padY + (h - padY * 2) * 0.5;
  const escala = (v) => ((h - padY * 2) / 2) * (v / max);

  const semialto = (h - padY * 2) / 2;
  const rejilla = [1, 0.5, -0.5, -1]
    .map((f) => {
      const y = (cero - semialto * f).toFixed(1);
      return `<line class="rejilla" x1="${padX}" y1="${y}" x2="${w - padX}" y2="${y}"/>`;
    })
    .join('');

  const barras = serie
    .map((s, i) => {
      const x = padX + i * anchoCol + anchoCol * 0.2;
      const ancho = anchoCol * 0.6;
      const alto = Math.max(2, Math.abs(escala(s.utilidad)));
      const y = s.utilidad >= 0 ? cero - alto : cero;
      const grad = s.utilidad >= 0 ? 'url(#gUp)' : 'url(#gDown)';
      const etiqueta = new Date(s.mes + '-01T12:00:00').toLocaleDateString('es-CO', { month: 'short' }).replace('.', '');
      return `<rect class="barra" style="--i:${i}" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${ancho.toFixed(1)}" height="${alto.toFixed(1)}" rx="3" fill="${grad}"><title>${etiqueta} ${pesos(s.utilidad)}</title></rect>
        <text x="${(x + ancho / 2).toFixed(1)}" y="${h - 4}" text-anchor="middle">${etiqueta}</text>`;
    })
    .join('');

  return `<svg class="grafica" viewBox="0 0 ${w} ${h}" role="img" aria-label="Utilidad de los últimos 12 meses">
    <defs>
      <linearGradient id="gUp" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--verde);stop-opacity:1"/>
        <stop offset="1" style="stop-color:var(--verde);stop-opacity:.4"/>
      </linearGradient>
      <linearGradient id="gDown" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" style="stop-color:var(--rojo);stop-opacity:.45"/>
        <stop offset="1" style="stop-color:var(--rojo);stop-opacity:1"/>
      </linearGradient>
    </defs>
    ${rejilla}
    <line class="eje" x1="${padX}" y1="${cero}" x2="${w - padX}" y2="${cero}"/>
    <text x="4" y="${cero - 6}">${corto(max)}</text>
    <text x="4" y="${cero + 14}">-${corto(max)}</text>
    ${barras}
  </svg>`;
}

/* -------------------------------- filtros --------------------------------- */

// Arma la consulta con los filtros que el usuario dejó puestos.
function consulta(extra = {}) {
  const p = new URLSearchParams();
  if (extra.mes !== null) p.set('mes', estado.mes);
  for (const [k, v] of Object.entries(estado.filtro)) if (v) p.set(k, v);
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined) p.set(k, v);
  p.delete('undefined');
  return p.toString();
}

function filtrosHtml({ mes = true, linea = true, estados = null, buscar = true, extra = '' } = {}) {
  const f = estado.filtro;
  return `<div class="filtros">
    ${mes ? `<input type="month" data-filtro="mes" value="${estado.mes}" aria-label="Mes">` : ''}
    ${linea ? `<select data-filtro="linea_id" aria-label="Línea">
        <option value="">Todas las líneas</option>
        ${estado.lineas.map((l) => `<option value="${l.id}"${String(f.linea_id) === String(l.id) ? ' selected' : ''}>${esc(l.nombre)}</option>`).join('')}
      </select>` : ''}
    ${estados ? `<select data-filtro="estado" aria-label="Estado">
        <option value="">Todos los estados</option>
        ${estados.map((o) => `<option value="${o.v}"${f.estado === o.v ? ' selected' : ''}>${esc(o.t)}</option>`).join('')}
      </select>` : ''}
    ${buscar ? `<input type="search" data-filtro="q" value="${esc(f.q)}" placeholder="Buscar concepto…" aria-label="Buscar">` : ''}
    ${f.linea_id || f.estado || f.q ? '<button class="btn-linea" id="btn-limpiar">Limpiar filtros</button>' : ''}
    ${extra}
  </div>`;
}

/* ---------------------------------- vistas -------------------------------- */

async function vistaPanel() {
  const d = await api('GET', '/reportes/panel?mes=' + estado.mes);
  const u = d.actual;
  const total = Math.max(u.ingresos, u.gastos, 1);
  const dif = u.utilidad - d.previo.utilidad;
  const maxLinea = Math.max(1, ...d.porLinea.map((l) => Math.max(l.ingresos, l.gastos)));

  const lineasHtml = d.porLinea.filter((l) => l.ingresos || l.gastos).length
    ? d.porLinea
        .filter((l) => l.ingresos || l.gastos)
        .map(
          (l) => `<div class="linea-fila">
            <div class="linea-encabezado">
              <span class="linea-nombre"><i class="punto" style="background:${esc(l.color)}"></i>${esc(l.nombre)}</span>
              <strong class="num ${l.margen >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(l.margen)}</strong>
            </div>
            <div class="linea-barra">
              <span style="width:${(l.ingresos / maxLinea) * 100}%;background:${esc(l.color)}"></span>
            </div>
            <div class="linea-datos num">
              <span>Entró ${pesos(l.ingresos)}</span><span>Gastó ${pesos(l.gastos)}</span><span>${
                l.gastos > 0 ? `${l.pct}% margen` : l.ingresos > 0 ? 'sin costos cargados' : '—'
              }</span>
            </div>
          </div>`
        )
        .join('')
    : '<p class="vacio">Sin movimientos de caja este mes. Registra un ingreso para empezar.</p>';

  const filaPendiente = (c, tipo) => `<div class="fila">
      <span class="fila-principal">${esc(c.cliente || c.proveedor || c.concepto)}</span>
      <span class="fila-monto num">${pesos(c.saldo)}</span>
      <span class="fila-detalle">${esc(c.linea || 'General')} · ${c.dias} días · ${esc(c.fecha)}${
        c.abonado ? ` · abonado ${pesos(c.abonado)} de ${pesos(c.monto)}` : ''
      } ${c.estado === 'parcial' ? marcaEstado('parcial') : ''}</span>
      <span class="fila-acciones">
        <button class="btn-mini" data-abonos="${tipo}:${c.id}">Abonos</button>
        <button class="btn-mini" data-pagar="${tipo}:${c.id}">${tipo === 'ingreso' ? 'Cobrado' : 'Pagado'}</button>
      </span>
    </div>`;

  const cxcHtml = d.cxc.length
    ? d.cxc.map((c) => filaPendiente(c, 'ingreso')).join('')
    : '<p class="vacio">Nadie te debe plata. Bien ahí.</p>';

  const cxpHtml = d.cxp.length
    ? d.cxp.map((c) => filaPendiente(c, 'gasto')).join('')
    : '<p class="vacio">No le debes nada a nadie.</p>';

  const fijosHtml = d.gastosFijos.length
    ? d.gastosFijos
        .map(
          (g) => `<div class="fila"><span class="fila-principal">${esc(g.concepto)}</span>
            <span class="fila-monto num">${pesos(g.monto)}</span>
            <span class="fila-detalle">${esc(g.categoria)} · ${esc(g.linea || 'General')} ${g.estado !== 'pagado' ? marcaEstado(g.estado, ETIQUETA_ESTADO_GASTO) : ''}</span></div>`
        )
        .join('')
    : '<p class="vacio">No has marcado gastos fijos este mes. Si se repiten, créalos en <b>Pagos fijos</b> y se registran solos.</p>';

  const alertas = d.alertasStock.length
    ? `<div class="bloque"><div class="bloque-titulo"><h2>Stock bajo</h2></div>
        ${d.alertasStock.map((a) => `<div class="fila"><span class="fila-principal">${esc(a.nombre)}</span><span class="fila-monto"><span class="marca-estado estado-alerta">${a.stock} restantes</span></span></div>`).join('')}
      </div>`
    : '';

  return `
    <div class="bloque utilidad">
      <div class="bloque-titulo">
        <span class="utilidad-etiqueta">Utilidad neta · ${esc(nombreMes(estado.mes))}</span>
        <input class="mes-select" type="month" data-filtro="mes" value="${estado.mes}">
      </div>
      <p class="utilidad-cifra num ${u.utilidad >= 0 ? 'positiva' : 'negativa'}" data-contar="${u.utilidad}">${pesos(u.utilidad)}</p>
      <p class="sub num">${dif >= 0 ? '+' : ''}${pesos(dif)} frente a ${esc(nombreMes(d.previo.mes))}</p>
      <div class="balanza">
        <div class="balanza-fila"><span>Entró</span><span class="balanza-pista"><span class="balanza-barra" style="width:${(u.ingresos / total) * 100}%;background:var(--verde)"></span></span><strong class="num">${pesos(u.ingresos)}</strong></div>
        <div class="balanza-fila"><span>Salió</span><span class="balanza-pista"><span class="balanza-barra" style="width:${(u.gastos / total) * 100}%;background:var(--rojo)"></span></span><strong class="num">${pesos(u.gastos)}</strong></div>
      </div>
      <p class="sub">Plata que de verdad se movió este mes. Lo facturado y no cobrado está abajo.</p>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Rentabilidad por línea</h2><span class="sub">este mes</span></div>
      ${lineasHtml}
    </div>

    <div class="dos-columnas">
      <div class="bloque">
        <div class="bloque-titulo"><h2>Quién te debe</h2><strong class="num monto-positivo">${pesos(d.cxcTotal)}</strong></div>
        <div class="filas">${cxcHtml}</div>
      </div>
      <div class="bloque">
        <div class="bloque-titulo"><h2>Lo que debes</h2><strong class="num monto-negativo">${pesos(d.cxpTotal)}</strong></div>
        <div class="filas">${cxpHtml}</div>
      </div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos fijos del mes</h2><strong class="num">${pesos(u.fijos)}</strong></div>
      <div class="filas">${fijosHtml}</div>
      <p class="sub num" style="margin-top:12px">Entra fijo ${pesos(d.mrr)}/mes · sale fijo ${pesos(d.gastoFijoRecurrente)}/mes${
        d.puntoEquilibrio ? ` · necesitas vender ${pesos(d.puntoEquilibrio)} para no perder` : ''
      }</p>
    </div>

    ${alertas}

    <div class="bloque">
      <div class="bloque-titulo"><h2>Utilidad, últimos 12 meses</h2></div>
      ${graficaUtilidad(d.serie)}
    </div>`;
}

async function vistaIngresos() {
  const filas = await api('GET', '/ingresos?' + consulta());
  const cobrado = filas.reduce((a, b) => a + b.abonado, 0);
  const porCobrar = filas.reduce((a, b) => a + (b.monto - b.abonado), 0);
  return `
    ${filtrosHtml({ estados: [{ v: 'pagado', t: 'Pagados' }, { v: 'parcial', t: 'Abonados' }, { v: 'pendiente', t: 'Por cobrar' }] })}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Ingresos de ${esc(nombreMes(estado.mes))}</h2><strong class="num monto-positivo">${pesos(cobrado)}</strong></div>
      <p class="sub num">Cobrado ${pesos(cobrado)} · por cobrar ${pesos(porCobrar)} · facturado ${pesos(cobrado + porCobrar)}</p>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(nombreLinea(f.linea_id))}${f.cliente_id ? ' · ' + esc(nombreCliente(f.cliente_id)) : ''} ${marcaEstado(f.estado)}${
                    f.estado === 'parcial' ? ` <span class="num">${pesos(f.abonado)} de ${pesos(f.monto)}</span>` : ''
                  }${f.iva ? ` · IVA ${pesos(f.iva)}` : ''}${f.rete ? ` · ret. ${pesos(f.rete)}` : ''}${
                    f.moneda && f.moneda !== 'COP' ? ` · ${f.monto_origen} ${esc(f.moneda)}` : ''
                  }</span>
                  <span class="fila-acciones">
                    ${f.estado !== 'pagado' ? `<button class="btn-mini" data-pagar="ingreso:${f.id}">Cobrado</button>` : ''}
                    <button class="btn-mini" data-abonos="ingreso:${f.id}">Abonos</button>
                    <button class="btn-mini" data-editar="ingresos:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="ingresos:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Nada que mostrar con esos filtros.</p>'
      }</div>
    </div>`;
}

async function vistaGastos() {
  const filas = await api('GET', '/gastos?' + consulta());
  const total = filas.reduce((a, b) => a + b.monto, 0);
  const fijos = filas.filter((f) => f.tipo === 'fijo').reduce((a, b) => a + b.monto, 0);
  const debes = filas.reduce((a, b) => a + (b.monto - b.abonado), 0);
  return `
    ${filtrosHtml({ estados: [{ v: 'pagado', t: 'Pagados' }, { v: 'parcial', t: 'Abonados' }, { v: 'pendiente', t: 'Por pagar' }] })}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos de ${esc(nombreMes(estado.mes))}</h2><strong class="num monto-negativo">${pesos(total)}</strong></div>
      <p class="sub num">Fijos ${pesos(fijos)} · variables ${pesos(total - fijos)} · sin pagar ${pesos(debes)}</p>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(f.categoria)} · ${esc(nombreLinea(f.linea_id))} · ${esc(f.tipo)} ${marcaEstado(f.estado, ETIQUETA_ESTADO_GASTO)}${
                    f.estado === 'parcial' ? ` <span class="num">${pesos(f.abonado)} de ${pesos(f.monto)}</span>` : ''
                  }${f.iva ? ` · IVA ${pesos(f.iva)}` : ''}${f.moneda && f.moneda !== 'COP' ? ` · ${f.monto_origen} ${esc(f.moneda)}` : ''}</span>
                  <span class="fila-acciones">
                    ${f.estado !== 'pagado' ? `<button class="btn-mini" data-pagar="gasto:${f.id}">Pagado</button>` : ''}
                    <button class="btn-mini" data-abonos="gasto:${f.id}">Abonos</button>
                    <button class="btn-mini" data-editar="gastos:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="gastos:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Nada que mostrar con esos filtros.</p>'
      }</div>
    </div>`;
}

async function vistaSuscripciones() {
  const filas = await api('GET', '/suscripciones');
  const mrr = filas.filter((f) => f.activa).reduce((a, b) => a + (b.ciclo === 'anual' ? b.monto / 12 : b.monto), 0);
  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Lo que te entra fijo</h2><strong class="num monto-positivo">${pesos(mrr)}/mes</strong></div>
      <p class="sub">Las mensualidades de tus clientes. Cuando se vencen se convierten solas en cuentas por cobrar.</p>
      <div class="filtros">
        <button class="btn-linea" id="btn-generar">Generar cobros vencidos</button>
        <button class="btn-linea" data-nuevo="suscripciones">Nuevo cobro recurrente</button>
      </div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(nombreCliente(f.cliente_id) || 'Sin cliente')} · ${esc(nombreLinea(f.linea_id))} · ${esc(f.ciclo)} · próximo ${esc(f.proxima_fecha)}${
                    f.iva_pct ? ` · IVA ${pct1(f.iva_pct)}%` : ''
                  } ${f.activa ? '' : '<span class="marca-estado estado-alerta">cancelada</span>'}</span>
                  <span class="fila-acciones">
                    ${f.activa ? `<button class="btn-mini" data-cobrar="${f.id}">Cobrar</button>` : ''}
                    <button class="btn-mini" data-editar="suscripciones:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="suscripciones:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Registra aquí las mensualidades de tus clientes para que el sistema te avise cuándo cobrar.</p>'
      }</div>
    </div>`;
}

async function vistaRecurrentes() {
  const filas = await api('GET', '/gastos_recurrentes');
  const fijo = filas.filter((f) => f.activa).reduce((a, b) => a + (b.ciclo === 'anual' ? b.monto / 12 : b.monto), 0);
  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Lo que te sale fijo</h2><strong class="num monto-negativo">${pesos(fijo)}/mes</strong></div>
      <p class="sub">El VPS, los dominios, las APIs. Se registran solos cada mes como cuentas por pagar, así el punto de equilibrio no se te queda corto por olvido.</p>
      <div class="filtros">
        <button class="btn-linea" id="btn-generar-gastos">Generar pagos vencidos</button>
        <button class="btn-linea" data-nuevo="gastos_recurrentes">Nuevo pago fijo</button>
      </div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}${f.moneda !== 'COP' ? ` <span class="sub">${esc(f.moneda)}</span>` : ''}</span>
                  <span class="fila-detalle">${esc(f.categoria)} · ${esc(nombreLinea(f.linea_id))} · ${esc(f.ciclo)} · próximo ${esc(f.proxima_fecha)}${
                    f.proveedor ? ' · ' + esc(f.proveedor) : ''
                  } ${f.activa ? '' : '<span class="marca-estado estado-alerta">pausado</span>'}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-editar="gastos_recurrentes:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="gastos_recurrentes:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Agrega el VPS, los dominios y las APIs que pagas todos los meses.</p>'
      }</div>
    </div>`;
}

async function vistaVentas() {
  const filas = await api('GET', '/ventas?' + consulta());
  const total = filas.reduce((a, b) => a + b.total, 0);
  const costoTotal = filas.reduce((a, b) => a + b.costo_unitario * b.cantidad, 0);
  const margen = total - costoTotal;
  return `
    ${filtrosHtml({ buscar: false, estados: [{ v: 'pagado', t: 'Pagadas' }, { v: 'parcial', t: 'Abonadas' }, { v: 'pendiente', t: 'Por cobrar' }] })}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Ventas de ${esc(nombreMes(estado.mes))}</h2><strong class="num">${pesos(total)}</strong></div>
      <p class="sub num">Costo ${pesos(costoTotal)} · Utilidad <b class="${margen >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(margen)}</b>${total ? ` · margen ${pct1((margen / total) * 100)}% sobre venta` : ''}</p>
      <div class="filtros"><button class="btn-linea" id="btn-venta">Registrar venta</button></div>
      <div class="filas">${
        filas.length
          ? filas
              .map((f) => {
                const util = (f.precio_unitario - f.costo_unitario) * f.cantidad;
                return `<div class="fila">
                  <span class="fila-principal">${f.cantidad} × ${esc(nombreProducto(f.producto_id) || 'producto')}</span>
                  <span class="fila-monto num">${pesos(f.total)}</span>
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(nombreCliente(f.cliente_id) || 'mostrador')} · ${esc(f.metodo)} ${marcaEstado(f.estado)}</span>
                  <span class="fila-detalle num" style="grid-column:1/-1">Costo unit. ${pesos(f.costo_unitario)} · Venta unit. ${pesos(f.precio_unitario)} · Utilidad <b class="${util >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(util)}</b>${f.precio_unitario ? ` · ${pct1(margenSobreVenta(f.precio_unitario, f.costo_unitario))}% margen` : ''}</span>
                  <span class="fila-acciones"><button class="btn-mini" data-borrar="ventas:${f.id}">Borrar</button></span>
                </div>`;
              })
              .join('')
          : '<p class="vacio">Sin ventas físicas con esos filtros.</p>'
      }</div>
    </div>`;
}

async function vistaInventario() {
  const [filas, movs] = await Promise.all([
    api('GET', '/productos'),
    api('GET', '/movimientos?limit=60' + (estado.filtro.producto_id ? '&producto_id=' + estado.filtro.producto_id : '')),
  ]);
  const valor = filas.reduce((a, b) => a + b.stock * b.costo_unitario, 0);
  const signo = { entrada: '+', salida: '−', ajuste: '=' };

  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Inventario</h2><strong class="num">${pesos(valor)} en stock</strong></div>
      <div class="filtros"><button class="btn-linea" data-nuevo="productos">Nuevo producto</button></div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (p) => `<div class="fila">
                  <span class="fila-principal">${esc(p.nombre)}</span>
                  <span class="fila-monto num">${p.stock} <span class="sub">u.</span></span>
                  <span class="fila-detalle num">Costo ${pesos(p.costo_unitario)} · venta ${pesos(p.precio_venta)} · margen ${pesos(p.precio_venta - p.costo_unitario)} (${pct1(margenSobreVenta(p.precio_venta, p.costo_unitario))}% s/venta · ${pct1(margenSobreCosto(p.precio_venta, p.costo_unitario))}% s/costo) ${p.stock <= p.stock_minimo ? '<span class="marca-estado estado-alerta">bajo</span>' : ''}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-entrada="${p.id}">Entrada</button>
                    <button class="btn-mini" data-ajuste="${p.id}">Ajustar</button>
                    <button class="btn-mini" data-kardex="${p.id}">Kardex</button>
                    <button class="btn-mini" data-editar="productos:${p.id}">Editar</button>
                    <button class="btn-mini" data-borrar="productos:${p.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Agrega tus tarjetas NFC, standees o repuestos para controlar el stock.</p>'
      }</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo">
        <h2>Kardex${estado.filtro.producto_id ? ' · ' + esc(nombreProducto(Number(estado.filtro.producto_id))) : ''}</h2>
        ${estado.filtro.producto_id ? '<button class="btn-linea" id="btn-todo-kardex">Ver todo</button>' : ''}
      </div>
      <p class="sub">Cada entrada, salida y ajuste del inventario, con su rastro.</p>
      <div class="filas">${
        movs.length
          ? movs
              .map(
                (m) => `<div class="fila fila-compacta">
                  <span class="fila-principal">${esc(m.producto || 'producto borrado')}</span>
                  <span class="fila-monto num">${signo[m.tipo] || ''}${Math.abs(m.cantidad)} <span class="sub">u.</span></span>
                  <span class="fila-detalle">${esc(m.fecha)} · ${esc(m.tipo)} · costo ${pesos(m.costo_unitario)}${m.nota ? ' · ' + esc(m.nota) : ''}${
                    m.venta_id ? ` · venta #${m.venta_id}` : ''
                  }${m.gasto_id ? ` · gasto #${m.gasto_id}` : ''}</span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Sin movimientos de inventario todavía.</p>'
      }</div>
    </div>`;
}

async function vistaClientes() {
  const filas = await api('GET', '/clientes' + (estado.filtro.q ? '?q=' + encodeURIComponent(estado.filtro.q) : ''));
  return `
    ${filtrosHtml({ mes: false, linea: false })}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Clientes</h2><span class="sub">${filas.length}</span></div>
      <div class="filtros"><button class="btn-linea" data-nuevo="clientes">Nuevo cliente</button></div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (c) => `<div class="fila">
                  <span class="fila-principal">${esc(c.nombre)}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-editar="clientes:${c.id}">Editar</button>
                    <button class="btn-mini" data-borrar="clientes:${c.id}">Borrar</button>
                  </span>
                  <span class="fila-detalle">${esc([c.negocio, c.telefono, c.ciudad].filter(Boolean).join(' · '))}</span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Sin clientes todavía.</p>'
      }</div>
    </div>`;
}

async function vistaLineas() {
  const filas = await api('GET', '/lineas');
  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Líneas de negocio</h2></div>
      <p class="sub">Cada app, servicio o producto que vendes. Todo ingreso y gasto se cuelga de una línea para saber cuál te deja plata. <b>Archiva</b> en vez de borrar: borrar una línea con movimientos cambiaría los reportes de meses que ya diste por cerrados.</p>
      <div class="filtros"><button class="btn-linea" data-nuevo="lineas">Nueva línea</button></div>
      <div class="filas">${filas
        .map(
          (l) => `<div class="fila">
            <span class="fila-principal"><i class="punto" style="background:${esc(l.color)};display:inline-block;margin-right:8px"></i>${esc(l.nombre)}</span>
            <span class="fila-acciones">
              <button class="btn-mini" data-archivar="${l.id}:${l.activa ? 0 : 1}">${l.activa ? 'Archivar' : 'Reactivar'}</button>
              <button class="btn-mini" data-editar="lineas:${l.id}">Editar</button>
              <button class="btn-mini" data-borrar="lineas:${l.id}">Borrar</button>
            </span>
            <span class="fila-detalle">${esc(l.tipo)}${l.activa ? '' : ' · archivada'}</span>
          </div>`
        )
        .join('')}</div>
    </div>`;
}

async function vistaReportes() {
  const desde = estado.mes + '-01';
  const hasta = new Date(new Date(estado.mes + '-01T12:00:00').setMonth(new Date(estado.mes + '-01T12:00:00').getMonth() + 1) - 864e5)
    .toISOString()
    .slice(0, 10);
  const [anio, cat, prod, imp, cartera] = await Promise.all([
    api('GET', `/reportes/lineas?desde=${estado.mes.slice(0, 4)}-01-01&hasta=${estado.mes.slice(0, 4)}-12-31`),
    api('GET', `/reportes/categorias?desde=${desde}&hasta=${hasta}`),
    api('GET', '/reportes/productos'),
    api('GET', `/reportes/impuestos?mes=${estado.mes}`),
    api('GET', '/reportes/cartera'),
  ]);
  const totalAnio = anio.reduce((a, b) => a + b.ingresos, 0);

  const tramos = (c) => `
    <div class="tramos">
      <div><span>Al día</span><b class="num">${pesos(c.alDia)}</b></div>
      <div><span>1–30 d</span><b class="num">${pesos(c.d1a30)}</b></div>
      <div><span>31–60 d</span><b class="num">${pesos(c.d31a60)}</b></div>
      <div><span>61–90 d</span><b class="num">${pesos(c.d61a90)}</b></div>
      <div><span>+90 d</span><b class="num monto-negativo">${pesos(c.mas90)}</b></div>
    </div>`;

  return `
    ${filtrosHtml({ linea: false, buscar: false })}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Año ${esc(estado.mes.slice(0, 4))} por línea</h2><strong class="num">${pesos(totalAnio)}</strong></div>
      <div class="filas">${anio
        .map(
          (l) => `<div class="fila">
            <span class="fila-principal">${esc(l.nombre)}</span>
            <span class="fila-monto num ${l.margen >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(l.margen)}</span>
            <span class="fila-detalle num">Entró ${pesos(l.ingresos)} · gastó ${pesos(l.gastos)} · por cobrar ${pesos(l.por_cobrar)} · por pagar ${pesos(l.por_pagar)}${l.gastos > 0 ? ` · ${l.pct}% margen` : ''}</span>
          </div>`
        )
        .join('')}</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>IVA y retenciones</h2><span class="sub">${esc(nombreMes(estado.mes))}</span></div>
      <p class="sub">Se causan con la fecha del documento, no con la del pago.</p>
      <div class="filas">
        <div class="fila"><span class="fila-principal">IVA generado (ventas)</span><span class="fila-monto num">${pesos(imp.ivaGenerado)}</span><span class="fila-detalle num">sobre base ${pesos(imp.baseVentas)}</span></div>
        <div class="fila"><span class="fila-principal">IVA descontable (compras)</span><span class="fila-monto num">${pesos(imp.ivaDescontable)}</span><span class="fila-detalle num">sobre base ${pesos(imp.baseCompras)}</span></div>
        <div class="fila"><span class="fila-principal"><b>Saldo de IVA</b></span><span class="fila-monto num ${imp.saldoIva >= 0 ? 'monto-negativo' : 'monto-positivo'}">${pesos(imp.saldoIva)}</span><span class="fila-detalle">${imp.saldoIva >= 0 ? 'te toca pagarlo' : 'queda a tu favor'}</span></div>
        <div class="fila"><span class="fila-principal">Retención que te practicaron</span><span class="fila-monto num">${pesos(imp.reteSufrida)}</span><span class="fila-detalle">la descuentas en tu declaración de renta</span></div>
        <div class="fila"><span class="fila-principal">Retención que practicaste</span><span class="fila-monto num">${pesos(imp.retePracticada)}</span><span class="fila-detalle">se la debes a la DIAN</span></div>
      </div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Cartera por antigüedad</h2><span class="sub">al ${esc(cartera.hoy)}</span></div>
      <p class="sub">Te deben <b class="num monto-positivo">${pesos(cartera.porCobrar.total)}</b></p>
      ${tramos(cartera.porCobrar)}
      <p class="sub" style="margin-top:14px">Debes <b class="num monto-negativo">${pesos(cartera.porPagar.total)}</b></p>
      ${tramos(cartera.porPagar)}
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos por categoría</h2><span class="sub">${esc(nombreMes(estado.mes))}</span></div>
      <div class="filas">${
        cat.length
          ? cat
              .map(
                (c) => `<div class="fila"><span class="fila-principal">${esc(c.categoria)}</span>
                  <span class="fila-monto num">${pesos(c.total)}</span>
                  <span class="fila-detalle">${c.n} registros · ${esc(c.tipo)}${c.saldo ? ` · sin pagar ${pesos(c.saldo)}` : ''}</span></div>`
              )
              .join('')
          : '<p class="vacio">Sin gastos en el mes.</p>'
      }</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Productos físicos, histórico</h2></div>
      <div class="filas">${
        prod.length
          ? prod
              .map(
                (p) => `<div class="fila"><span class="fila-principal">${esc(p.nombre)}</span>
                  <span class="fila-monto num">${pesos(p.facturado)}</span>
                  <span class="fila-detalle num">${p.vendidos} vendidos · margen ${pesos(p.margen)}${p.facturado ? ` (${pct1((p.margen / p.facturado) * 100)}%)` : ''} · quedan ${p.stock}</span></div>`
              )
              .join('')
          : '<p class="vacio">Sin productos registrados.</p>'
      }</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Descargar datos</h2></div>
      <p class="sub">Los CSV salen con los filtros de mes y línea que tengas puestos. El respaldo completo se lo puedes volver a cargar al sistema.</p>
      <div class="filtros">
        ${['ingresos', 'gastos', 'abonos', 'ventas', 'movimientos', 'clientes', 'suscripciones', 'gastos_recurrentes', 'productos', 'bitacora']
          .map((t) => `<a class="btn-linea" href="/api/export/${t}.csv?${consulta()}" download>${t}.csv</a>`)
          .join('')}
        <a class="btn-linea" href="/api/backup?descargar=1" download>respaldo completo .json</a>
      </div>
    </div>`;
}

async function vistaPapelera() {
  const [filas, log] = await Promise.all([api('GET', '/papelera'), api('GET', '/bitacora?limit=80')]);
  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Papelera</h2><span class="sub">${filas.length}</span></div>
      <p class="sub">Lo que borras cae aquí con todo lo que colgaba de ello. Restaurar una venta devuelve su ingreso, sus abonos y vuelve a descontar el stock.</p>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (p) => `<div class="fila">
                  <span class="fila-principal">${esc(p.resumen)}</span>
                  <span class="fila-monto"><span class="marca-estado estado-pendiente">${esc(p.tabla)}</span></span>
                  <span class="fila-detalle">#${p.registro_id} · borrado por ${esc(p.usuario || '—')} · ${esc(p.creado)}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-restaurar="${p.id}">Restaurar</button>
                    <button class="btn-mini" data-purgar="${p.id}">Borrar del todo</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">La papelera está vacía.</p>'
      }</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Bitácora</h2><span class="sub">últimos ${log.length}</span></div>
      <p class="sub">Quién tocó qué y cuándo.</p>
      <div class="filas">${
        log.length
          ? log
              .map(
                (b) => `<div class="fila fila-compacta">
                  <span class="fila-principal">${esc(b.accion)} · ${esc(b.tabla)}${b.registro_id ? ' #' + b.registro_id : ''}</span>
                  <span class="fila-detalle">${esc(b.creado)} · ${esc(b.usuario || '—')}${b.detalle ? ' · ' + esc(b.detalle) : ''}</span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Sin movimientos registrados.</p>'
      }</div>
    </div>`;
}

const VISTA_FN = {
  panel: vistaPanel,
  ingresos: vistaIngresos,
  gastos: vistaGastos,
  suscripciones: vistaSuscripciones,
  recurrentes: vistaRecurrentes,
  ventas: vistaVentas,
  inventario: vistaInventario,
  clientes: vistaClientes,
  lineas: vistaLineas,
  reportes: vistaReportes,
  papelera: vistaPapelera,
};

/* --------------------------------- render --------------------------------- */

function pintarNav() {
  $('#nav').innerHTML = VISTAS.map(
    ([v, t]) => `<a href="#${v}" class="${v === estado.vista ? 'activo' : ''}">${t}</a>`
  ).join('');
}

async function cargarCatalogos() {
  const [lineas, clientes, productos] = await Promise.all([
    api('GET', '/lineas?limit=2000'),
    api('GET', '/clientes?limit=2000'),
    api('GET', '/productos?limit=2000'),
  ]);
  estado.lineas = lineas;
  estado.clientes = clientes;
  estado.productos = productos;
}

let temporizadorBusqueda = null;

// Deja vivos los controles de filtro recién pintados.
function cablearFiltros(cont) {
  $$('[data-filtro]', cont).forEach((el) => {
    const clave = el.dataset.filtro;
    if (el.type === 'search') {
      el.addEventListener('input', () => {
        clearTimeout(temporizadorBusqueda);
        temporizadorBusqueda = setTimeout(() => {
          estado.filtro.q = el.value;
          render({ devolverFoco: 'q' });
        }, 350);
      });
    } else {
      el.addEventListener('change', () => {
        if (clave === 'mes') estado.mes = el.value || mesActual();
        else estado.filtro[clave] = el.value;
        render();
      });
    }
  });
  const limpiar = $('#btn-limpiar', cont);
  if (limpiar)
    limpiar.onclick = () => {
      estado.filtro = { linea_id: '', estado: '', q: '', producto_id: '', categoria: '' };
      render();
    };
}

async function render(opciones = {}) {
  pintarNav();
  const cont = $('#vista');
  let hecho = false;
  const pintar = async () => {
    try {
      cont.innerHTML = await (VISTA_FN[estado.vista] || vistaPanel)();
      animarCifras(cont);
      cablearFiltros(cont);
    } catch (e) {
      cont.innerHTML = `<div class="bloque"><p class="error">${esc(e.message)}</p></div>`;
    }
    hecho = true;
  };

  const conTransicion =
    render.animar && document.startViewTransition && !sinMovimiento() && !render._activa && !$('#app').hidden;
  render.animar = false;

  if (conTransicion) {
    render._activa = true;
    try {
      const t = document.startViewTransition(pintar);
      t.ready.catch(() => {});
      t.finished.catch(() => {}).finally(() => { render._activa = false; });
      await t.updateCallbackDone.catch(() => {});
    } catch (_) {}
    render._activa = false;
  } else {
    await pintar();
  }
  if (!hecho) await pintar();

  // Al filtrar escribiendo, el cuadro se repinta: hay que devolver el cursor.
  if (opciones.devolverFoco === 'q') {
    const caja = $('[data-filtro="q"]', cont);
    if (caja) {
      caja.focus();
      caja.setSelectionRange(caja.value.length, caja.value.length);
    }
  }
}

/* --------------------------- acciones especiales -------------------------- */

function formularioVenta() {
  if (!estado.productos.length) {
    aviso('Primero crea un producto en Inventario');
    return;
  }
  abrirFormulario({
    titulo: 'Registrar venta',
    campos: [
      { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
      { k: 'producto_id', l: 'Producto', t: 'select', opts: opcionesProducto, req: true },
      { k: 'cantidad', l: 'Cantidad', t: 'number', def: 1, req: true },
      { k: 'precio_unitario', l: 'Precio de venta unit.', t: 'number' },
      { k: 'costo_unitario', l: 'Costo unit. (vacío = del producto)', t: 'number' },
      { k: 'iva_pct', l: 'IVA', t: 'select', opts: () => IVAS, def: 0 },
      { k: 'cliente_id', l: 'Cliente', t: 'select', opts: opcionesCliente },
      { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'efectivo' },
      { k: 'estado', l: 'Estado', t: 'select', opts: () => [{ v: 'pagado', t: 'Pagada' }, { v: 'pendiente', t: 'Por cobrar' }], def: 'pagado' },
      { k: 'notas', l: 'Notas', t: 'text', ancho: true },
    ],
    alGuardar: (d) => api('POST', '/ventas/registrar', d),
  });
}

function formularioEntrada(id) {
  const p = estado.productos.find((x) => x.id === Number(id));
  abrirFormulario({
    titulo: 'Entrada de ' + (p ? p.nombre : 'inventario'),
    campos: [
      { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
      { k: 'cantidad', l: 'Cantidad', t: 'number', req: true },
      { k: 'costo_unitario', l: 'Costo unitario', t: 'number', def: p ? p.costo_unitario : 0 },
      { k: 'iva_pct', l: 'IVA de la compra', t: 'select', opts: () => IVAS, def: 0 },
      { k: 'estado', l: '¿Ya la pagaste?', t: 'select', opts: () => [{ v: 'pagado', t: 'Sí, ya la pagué' }, { v: 'pendiente', t: 'No, la debo' }], def: 'pagado' },
      { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'efectivo' },
      { k: 'proveedor', l: 'Proveedor', t: 'text', ancho: true },
      { k: 'nota', l: 'Nota', t: 'text', ancho: true },
    ],
    alGuardar: (d) => api('POST', `/productos/${id}/entrada`, d),
  });
}

function formularioAjuste(id) {
  const p = estado.productos.find((x) => x.id === Number(id));
  abrirFormulario({
    titulo: 'Ajustar stock de ' + (p ? p.nombre : 'producto'),
    encabezado: `<p class="sub">El sistema dice que tienes <b>${p ? p.stock : '?'}</b>. Escribe lo que contaste de verdad y queda el ajuste en el kardex.</p>`,
    campos: [
      { k: 'stock', l: 'Stock contado', t: 'number', def: p ? p.stock : 0, req: true },
      { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
      { k: 'nota', l: 'Motivo', t: 'text', ancho: true, def: 'Conteo físico' },
    ],
    alGuardar: (d) => api('POST', `/productos/${id}/ajuste`, d),
  });
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest(
    '[data-nuevo],[data-editar],[data-borrar],[data-pagar],[data-cobrar],[data-entrada],[data-ajuste],[data-kardex],[data-abonos],[data-borrar-abono],[data-archivar],[data-restaurar],[data-purgar],#btn-venta,#btn-generar,#btn-generar-gastos,#btn-todo-kardex'
  );
  if (!t) return;
  try {
    if (t.dataset.nuevo) return nuevo(t.dataset.nuevo);
    if (t.id === 'btn-venta') return formularioVenta();
    if (t.dataset.entrada) return formularioEntrada(t.dataset.entrada);
    if (t.dataset.ajuste) return formularioAjuste(t.dataset.ajuste);
    if (t.dataset.kardex) {
      estado.filtro.producto_id = t.dataset.kardex;
      return render();
    }
    if (t.id === 'btn-todo-kardex') {
      estado.filtro.producto_id = '';
      return render();
    }
    if (t.dataset.editar) {
      const [tabla, id] = t.dataset.editar.split(':');
      return editar(tabla, id);
    }
    if (t.dataset.borrar) {
      const [tabla, id] = t.dataset.borrar.split(':');
      return borrar(tabla, id);
    }
    if (t.dataset.abonos) {
      const [tipo, id] = t.dataset.abonos.split(':');
      return abrirAbonos(tipo, id);
    }
    if (t.dataset.borrarAbono) {
      const [abonoId, tipo, docId] = t.dataset.borrarAbono.split(':');
      await api('DELETE', `/abonos/${abonoId}`);
      aviso('Abono quitado');
      await abrirAbonos(tipo, docId);
      return render();
    }
    if (t.dataset.pagar) {
      const [tipo, id] = t.dataset.pagar.split(':');
      const tabla = tipo === 'ingreso' ? 'ingresos' : 'gastos';
      await api('POST', `/${tabla}/${id}/pagar`, { fecha: hoy() });
      aviso(tipo === 'ingreso' ? 'Cobrado' : 'Pagado');
      return render();
    }
    if (t.dataset.archivar) {
      const [id, activa] = t.dataset.archivar.split(':');
      await api('PUT', `/lineas/${id}`, { activa: Number(activa) });
      aviso(Number(activa) ? 'Línea reactivada' : 'Línea archivada');
      await cargarCatalogos();
      return render();
    }
    if (t.dataset.restaurar) {
      await api('POST', `/papelera/${t.dataset.restaurar}/restaurar`, {});
      aviso('Restaurado');
      await cargarCatalogos();
      return render();
    }
    if (t.dataset.purgar) {
      if (!confirm('Esto sí es definitivo. ¿Borrarlo para siempre?')) return;
      await api('DELETE', `/papelera/${t.dataset.purgar}`);
      aviso('Borrado definitivo');
      return render();
    }
    if (t.dataset.cobrar) {
      await api('POST', `/suscripciones/${t.dataset.cobrar}/cobrar`, {});
      aviso('Cobro generado en ingresos');
      return render();
    }
    if (t.id === 'btn-generar') {
      const r = await api('POST', '/suscripciones/generar-vencidas', {});
      aviso(r.generados ? `${r.generados} cobros generados` : 'No había cobros vencidos');
      return render();
    }
    if (t.id === 'btn-generar-gastos') {
      const r = await api('POST', '/gastos-recurrentes/generar-vencidos', {});
      aviso(r.gastosGenerados ? `${r.gastosGenerados} pagos generados` : 'No había pagos vencidos');
      return render();
    }
  } catch (e) {
    aviso(e.message);
  }
});

// El previo del total y las reglas de visibilidad del formulario, en vivo.
document.addEventListener('input', (ev) => {
  if (ev.target.closest('#modal-campos')) refrescarForm();
});
document.addEventListener('change', (ev) => {
  if (ev.target.closest('#modal-campos')) refrescarForm();
});

/* --------------------------------- arranque ------------------------------- */

function mostrarEntrada() {
  $('#entrada').hidden = false;
  $('#app').hidden = true;
}

async function iniciar() {
  $('#entrada').hidden = true;
  $('#app').hidden = false;
  await cargarCatalogos();
  await render();
}

// Onda al pulsar cualquier botón.
document.addEventListener('pointerdown', (ev) => {
  const b = ev.target.closest && ev.target.closest('.btn');
  if (!b || b.disabled || sinMovimiento()) return;
  const r = b.getBoundingClientRect();
  const d = Math.max(r.width, r.height);
  const o = document.createElement('span');
  o.className = 'onda';
  o.style.width = o.style.height = d + 'px';
  o.style.left = ev.clientX - r.left - d / 2 + 'px';
  o.style.top = ev.clientY - r.top - d / 2 + 'px';
  b.appendChild(o);
  setTimeout(() => o.remove(), 550);
});

// Estado "cargando" en un botón mientras corre una promesa.
async function conCarga(btn, fn) {
  if (!btn || btn.classList.contains('cargando')) return;
  btn.classList.add('cargando');
  try {
    return await fn();
  } finally {
    btn.classList.remove('cargando');
  }
}

$('#btn-entrar').onclick = () =>
  conCarga($('#btn-entrar'), async () => {
    const err = $('#entrada-error');
    err.hidden = true;
    try {
      await api('POST', '/login', { usuario: $('#in-usuario').value.trim(), clave: $('#in-clave').value });
      await iniciar();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    }
  });
$('#in-clave').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-entrar').click());

$('#btn-salir').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
  if (navigator.serviceWorker && navigator.serviceWorker.controller) {
    navigator.serviceWorker.controller.postMessage('limpiar-cache');
  }
  location.reload();
};

function temaActual() {
  return document.documentElement.dataset.tema === 'claro' ? 'claro' : 'oscuro';
}
$('#btn-tema').onclick = () => {
  const nuevo = temaActual() === 'oscuro' ? 'claro' : 'oscuro';
  document.documentElement.dataset.tema = nuevo;
  try {
    localStorage.setItem('tema', nuevo);
  } catch (e) {}
  const meta = $('#meta-tema');
  if (meta) meta.content = nuevo === 'claro' ? '#EEF2F7' : '#080B11';
};

$('#btn-cuenta').onclick = () =>
  abrirFormulario({
    titulo: 'Cambiar contraseña',
    campos: [
      { k: 'actual', l: 'Clave actual', t: 'password', req: true, ancho: true },
      { k: 'nueva', l: 'Clave nueva (mínimo 8)', t: 'password', req: true, ancho: true },
    ],
    alGuardar: async (d) => {
      await api('POST', '/cuenta/clave', d);
    },
  });

$('#modal-cerrar').onclick = cerrarFormulario;
$('#modal-guardar').onclick = () => conCarga($('#modal-guardar'), guardarFormulario);
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && cerrarFormulario());
document.addEventListener('keydown', (e) => e.key === 'Escape' && cerrarFormulario());

/* --------------------------------- PWA ---------------------------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  // Si el SW trae una versión nueva del panel, recargar una sola vez.
  // Solo si la página YA estaba controlada: en la primera visita el cambio
  // de controlador es la instalación, no un despliegue nuevo.
  const yaControlado = !!navigator.serviceWorker.controller;
  let recargando = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!yaControlado || recargando) return;
    recargando = true;
    location.reload();
  });
}

let promptInstalar = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  promptInstalar = e;
  $('#btn-instalar').hidden = false;
});
$('#btn-instalar').onclick = async () => {
  if (!promptInstalar) return;
  promptInstalar.prompt();
  await promptInstalar.userChoice;
  promptInstalar = null;
  $('#btn-instalar').hidden = true;
};
window.addEventListener('appinstalled', () => ($('#btn-instalar').hidden = true));

function pintarConexion() {
  const el = $('#offline');
  if (el) el.hidden = navigator.onLine;
}
window.addEventListener('online', () => {
  pintarConexion();
  if (!$('#app').hidden) render();
});
window.addEventListener('offline', pintarConexion);
pintarConexion();

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  estado.vista = VISTA_FN[v] ? v : 'panel';
  render.animar = true;
  render();
});

(async () => {
  const v = location.hash.slice(1);
  if (VISTA_FN[v]) estado.vista = v;
  try {
    await api('GET', '/yo');
    await iniciar();
  } catch {
    mostrarEntrada();
  }
})();
