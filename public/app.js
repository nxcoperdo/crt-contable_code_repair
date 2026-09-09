'use strict';

/* ------------------------------- utilidades ------------------------------- */

const $ = (s, ctx = document) => ctx.querySelector(s);
const hoy = () => new Date().toISOString().slice(0, 10);
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
};

const VISTAS = [
  ['panel', 'Panel'],
  ['ingresos', 'Ingresos'],
  ['gastos', 'Gastos'],
  ['suscripciones', 'Suscripciones'],
  ['ventas', 'Ventas'],
  ['inventario', 'Inventario'],
  ['clientes', 'Clientes'],
  ['lineas', 'Líneas'],
  ['reportes', 'Reportes'],
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

/* ------------------------------ formularios ------------------------------- */

const FORMULARIOS = {
  ingresos: () => [
    { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
    { k: 'monto', l: 'Monto', t: 'number', req: true },
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'cliente_id', l: 'Cliente', t: 'select', opts: opcionesCliente },
    { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'nequi' },
    { k: 'estado', l: 'Estado', t: 'select', opts: () => [{ v: 'pagado', t: 'Pagado' }, { v: 'pendiente', t: 'Por cobrar' }], def: 'pagado' },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
  ],
  gastos: () => [
    { k: 'fecha', l: 'Fecha', t: 'date', def: hoy() },
    { k: 'monto', l: 'Monto', t: 'number', req: true },
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'categoria', l: 'Categoría', t: 'select', opts: () => CATEGORIAS, def: 'servidores' },
    { k: 'tipo', l: 'Tipo', t: 'select', opts: () => [{ v: 'fijo', t: 'Fijo (todos los meses)' }, { v: 'variable', t: 'Variable' }], def: 'variable' },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'metodo', l: 'Método', t: 'select', opts: () => METODOS, def: 'nequi' },
    { k: 'proveedor', l: 'Proveedor', t: 'text', ancho: true },
  ],
  suscripciones: () => [
    { k: 'concepto', l: 'Concepto', t: 'text', req: true, ancho: true },
    { k: 'monto', l: 'Monto', t: 'number', req: true },
    { k: 'ciclo', l: 'Ciclo', t: 'select', opts: () => [{ v: 'mensual', t: 'Mensual' }, { v: 'anual', t: 'Anual' }], def: 'mensual' },
    { k: 'cliente_id', l: 'Cliente', t: 'select', opts: opcionesCliente },
    { k: 'linea_id', l: 'Línea', t: 'select', opts: opcionesLinea },
    { k: 'proxima_fecha', l: 'Próximo cobro', t: 'date', def: hoy(), req: true },
    { k: 'activa', l: 'Estado', t: 'select', opts: () => [{ v: 1, t: 'Activa' }, { v: 0, t: 'Cancelada' }], def: 1 },
    { k: 'notas', l: 'Notas', t: 'text', ancho: true },
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

let formActual = null;

function abrirFormulario({ titulo, campos, valores = {}, alGuardar }) {
  formActual = { campos, alGuardar };
  $('#modal-titulo').textContent = titulo;
  $('#modal-error').hidden = true;
  const cont = $('#modal-campos');
  cont.innerHTML = campos
    .map((c) => {
      const val = valores[c.k] !== undefined && valores[c.k] !== null ? valores[c.k] : c.def !== undefined ? c.def : '';
      const clase = 'campo' + (c.ancho ? ' ancho' : '');
      if (c.t === 'select') {
        const opciones = (typeof c.opts === 'function' ? c.opts() : c.opts)
          .map((o) => `<option value="${esc(o.v)}"${String(o.v) === String(val) ? ' selected' : ''}>${esc(o.t)}</option>`)
          .join('');
        return `<label class="${clase}"><span>${esc(c.l)}</span><select data-k="${c.k}">${opciones}</select></label>`;
      }
      const extra = c.t === 'number' ? ' inputmode="numeric" step="1"' : '';
      return `<label class="${clase}"><span>${esc(c.l)}</span><input data-k="${c.k}" type="${c.t}" value="${esc(val)}"${extra}></label>`;
    })
    .join('');
  $('#modal').hidden = false;
  const primero = cont.querySelector('input,select');
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
    let v = el.value;
    if (c.req && !String(v).trim()) {
      $('#modal-error').textContent = `Falta ${c.l.toLowerCase()}.`;
      $('#modal-error').hidden = false;
      el.focus();
      return;
    }
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

function nuevo(tabla) {
  const nombres = { ingresos: 'Nuevo ingreso', gastos: 'Nuevo gasto', suscripciones: 'Nueva suscripción', clientes: 'Nuevo cliente', lineas: 'Nueva línea', productos: 'Nuevo producto' };
  abrirFormulario({
    titulo: nombres[tabla] || 'Nuevo registro',
    campos: FORMULARIOS[tabla](),
    alGuardar: (d) => api('POST', '/' + tabla, d),
  });
}

function editar(tabla, fila) {
  abrirFormulario({
    titulo: 'Editar',
    campos: FORMULARIOS[tabla](),
    valores: fila,
    alGuardar: (d) => api('PUT', `/${tabla}/${fila.id}`, d),
  });
}

async function borrar(tabla, id) {
  if (!confirm('¿Borrar este registro? No se puede deshacer.')) return;
  await api('DELETE', `/${tabla}/${id}`);
  aviso('Borrado');
  await cargarCatalogos();
  render();
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
    : '<p class="vacio">Sin movimientos en este mes. Registra un ingreso para empezar.</p>';

  const cxcHtml = d.cxc.length
    ? d.cxc
        .map(
          (c) => `<div class="fila">
            <span class="fila-principal">${esc(c.cliente || c.concepto)}</span>
            <span class="fila-monto num">${pesos(c.monto)}</span>
            <span class="fila-detalle">${esc(c.linea || 'General')} · ${c.dias} días · ${esc(c.fecha)}</span>
            <span class="fila-acciones"><button class="btn-mini" data-pagar="${c.id}">Marcar pagado</button></span>
          </div>`
        )
        .join('')
    : '<p class="vacio">Nadie te debe plata. Bien ahí.</p>';

  const fijosHtml = d.gastosFijos.length
    ? d.gastosFijos
        .map(
          (g) => `<div class="fila"><span class="fila-principal">${esc(g.concepto)}</span>
            <span class="fila-monto num">${pesos(g.monto)}</span>
            <span class="fila-detalle">${esc(g.categoria)} · ${esc(g.linea || 'General')}</span></div>`
        )
        .join('')
    : '<p class="vacio">No has marcado gastos fijos este mes.</p>';

  const alertas = d.alertasStock.length
    ? `<div class="bloque"><div class="bloque-titulo"><h2>Stock bajo</h2></div>
        ${d.alertasStock.map((a) => `<div class="fila"><span class="fila-principal">${esc(a.nombre)}</span><span class="fila-monto"><span class="marca-estado estado-alerta">${a.stock} restantes</span></span></div>`).join('')}
      </div>`
    : '';

  return `
    <div class="bloque utilidad">
      <div class="bloque-titulo">
        <span class="utilidad-etiqueta">Utilidad neta · ${esc(nombreMes(estado.mes))}</span>
        <input class="mes-select" type="month" id="mes" value="${estado.mes}">
      </div>
      <p class="utilidad-cifra num ${u.utilidad >= 0 ? 'positiva' : 'negativa'}" data-contar="${u.utilidad}">${pesos(u.utilidad)}</p>
      <p class="sub num">${dif >= 0 ? '+' : ''}${pesos(dif)} frente a ${esc(nombreMes(d.previo.mes))}</p>
      <div class="balanza">
        <div class="balanza-fila"><span>Entró</span><span class="balanza-pista"><span class="balanza-barra" style="width:${(u.ingresos / total) * 100}%;background:var(--verde)"></span></span><strong class="num">${pesos(u.ingresos)}</strong></div>
        <div class="balanza-fila"><span>Salió</span><span class="balanza-pista"><span class="balanza-barra" style="width:${(u.gastos / total) * 100}%;background:var(--rojo)"></span></span><strong class="num">${pesos(u.gastos)}</strong></div>
      </div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Rentabilidad por línea</h2><span class="sub">este mes</span></div>
      ${lineasHtml}
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Quién te debe</h2><strong class="num">${pesos(d.cxcTotal)}</strong></div>
      <div class="filas">${cxcHtml}</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos fijos del mes</h2><strong class="num">${pesos(u.fijos)}</strong></div>
      <div class="filas">${fijosHtml}</div>
      <p class="sub num" style="margin-top:12px">Ingresos recurrentes activos: ${pesos(d.mrr)} al mes${d.puntoEquilibrio ? ` · necesitas vender ${pesos(d.puntoEquilibrio)} para no perder` : ''}</p>
    </div>

    ${alertas}

    <div class="bloque">
      <div class="bloque-titulo"><h2>Utilidad, últimos 12 meses</h2></div>
      ${graficaUtilidad(d.serie)}
    </div>`;
}

function filtrosHtml(extra = '') {
  return `<div class="filtros">
    <input type="month" id="f-mes" value="${estado.mes}">
    <select id="f-linea">${opcionesLinea().map((o) => `<option value="${o.v}">${esc(o.t)}</option>`).join('')}</select>
    ${extra}
  </div>`;
}

async function vistaIngresos() {
  const filas = await api('GET', `/ingresos?mes=${estado.mes}`);
  const total = filas.filter((f) => f.estado === 'pagado').reduce((a, b) => a + b.monto, 0);
  return `
    ${filtrosHtml()}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Ingresos de ${esc(nombreMes(estado.mes))}</h2><strong class="num monto-positivo">${pesos(total)}</strong></div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(nombreLinea(f.linea_id))}${f.cliente_id ? ' · ' + esc(nombreCliente(f.cliente_id)) : ''} <span class="marca-estado estado-${f.estado}">${f.estado === 'pagado' ? 'pagado' : 'por cobrar'}</span></span>
                  <span class="fila-acciones">
                    ${f.estado === 'pendiente' ? `<button class="btn-mini" data-pagar="${f.id}">Cobrado</button>` : ''}
                    <button class="btn-mini" data-editar="ingresos:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="ingresos:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Aún no hay ingresos este mes.</p>'
      }</div>
    </div>`;
}

async function vistaGastos() {
  const filas = await api('GET', `/gastos?mes=${estado.mes}`);
  const total = filas.reduce((a, b) => a + b.monto, 0);
  const fijos = filas.filter((f) => f.tipo === 'fijo').reduce((a, b) => a + b.monto, 0);
  return `
    ${filtrosHtml()}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos de ${esc(nombreMes(estado.mes))}</h2><strong class="num monto-negativo">${pesos(total)}</strong></div>
      <p class="sub num">Fijos ${pesos(fijos)} · variables ${pesos(total - fijos)}</p>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(f.categoria)} · ${esc(nombreLinea(f.linea_id))} · ${esc(f.tipo)}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-editar="gastos:${f.id}">Editar</button>
                    <button class="btn-mini" data-borrar="gastos:${f.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Ningún gasto registrado este mes.</p>'
      }</div>
    </div>`;
}

async function vistaSuscripciones() {
  const filas = await api('GET', '/suscripciones');
  const mrr = filas.filter((f) => f.activa).reduce((a, b) => a + (b.ciclo === 'anual' ? b.monto / 12 : b.monto), 0);
  return `
    <div class="bloque">
      <div class="bloque-titulo"><h2>Cobros recurrentes</h2><strong class="num">${pesos(mrr)}/mes</strong></div>
      <div class="filtros">
        <button class="btn-linea" id="btn-generar">Generar cobros vencidos</button>
        <button class="btn-linea" data-nuevo="suscripciones">Nueva suscripción</button>
      </div>
      <div class="filas">${
        filas.length
          ? filas
              .map(
                (f) => `<div class="fila">
                  <span class="fila-principal">${esc(f.concepto)}</span>
                  <span class="fila-monto num">${pesos(f.monto)}</span>
                  <span class="fila-detalle">${esc(nombreCliente(f.cliente_id) || 'Sin cliente')} · ${esc(nombreLinea(f.linea_id))} · ${esc(f.ciclo)} · próximo ${esc(f.proxima_fecha)} ${f.activa ? '' : '<span class="marca-estado estado-alerta">cancelada</span>'}</span>
                  <span class="fila-acciones">
                    <button class="btn-mini" data-cobrar="${f.id}">Cobrar</button>
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

async function vistaVentas() {
  const filas = await api('GET', `/ventas?mes=${estado.mes}`);
  const total = filas.reduce((a, b) => a + b.total, 0);
  const costoTotal = filas.reduce((a, b) => a + b.costo_unitario * b.cantidad, 0);
  const margen = total - costoTotal;
  return `
    ${filtrosHtml()}
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
                  <span class="fila-detalle">${esc(f.fecha)} · ${esc(nombreCliente(f.cliente_id) || 'mostrador')} · ${esc(f.metodo)} <span class="marca-estado estado-${f.estado}">${f.estado === 'pagado' ? 'pagada' : 'por cobrar'}</span></span>
                  <span class="fila-detalle num" style="grid-column:1/-1">Costo unit. ${pesos(f.costo_unitario)} · Venta unit. ${pesos(f.precio_unitario)} · Utilidad <b class="${util >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(util)}</b>${f.precio_unitario ? ` · ${pct1(margenSobreVenta(f.precio_unitario, f.costo_unitario))}% margen` : ''}</span>
                  <span class="fila-acciones"><button class="btn-mini" data-borrar="ventas:${f.id}">Borrar</button></span>
                </div>`;
              })
              .join('')
          : '<p class="vacio">Sin ventas físicas este mes.</p>'
      }</div>
    </div>`;
}

async function vistaInventario() {
  const filas = await api('GET', '/productos');
  const valor = filas.reduce((a, b) => a + b.stock * b.costo_unitario, 0);
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
                    <button class="btn-mini" data-editar="productos:${p.id}">Editar</button>
                    <button class="btn-mini" data-borrar="productos:${p.id}">Borrar</button>
                  </span>
                </div>`
              )
              .join('')
          : '<p class="vacio">Agrega tus tarjetas NFC, standees o repuestos para controlar el stock.</p>'
      }</div>
    </div>`;
}

async function vistaClientes() {
  const filas = await api('GET', '/clientes');
  return `
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
      <p class="sub">Cada app, servicio o producto que vendes. Todo ingreso y gasto se cuelga de una línea para saber cuál te deja plata.</p>
      <div class="filtros"><button class="btn-linea" data-nuevo="lineas">Nueva línea</button></div>
      <div class="filas">${filas
        .map(
          (l) => `<div class="fila">
            <span class="fila-principal"><i class="punto" style="background:${esc(l.color)};display:inline-block;margin-right:8px"></i>${esc(l.nombre)}</span>
            <span class="fila-acciones">
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
  const [anio, cat, prod] = await Promise.all([
    api('GET', `/reportes/lineas?desde=${estado.mes.slice(0, 4)}-01-01&hasta=${estado.mes.slice(0, 4)}-12-31`),
    api('GET', `/reportes/categorias?desde=${desde}&hasta=${hasta}`),
    api('GET', '/reportes/productos'),
  ]);
  const totalAnio = anio.reduce((a, b) => a + b.ingresos, 0);

  return `
    ${filtrosHtml()}
    <div class="bloque">
      <div class="bloque-titulo"><h2>Año ${esc(estado.mes.slice(0, 4))} por línea</h2><strong class="num">${pesos(totalAnio)}</strong></div>
      <div class="filas">${anio
        .map(
          (l) => `<div class="fila">
            <span class="fila-principal">${esc(l.nombre)}</span>
            <span class="fila-monto num ${l.margen >= 0 ? 'monto-positivo' : 'monto-negativo'}">${pesos(l.margen)}</span>
            <span class="fila-detalle num">Entró ${pesos(l.ingresos)} · gastó ${pesos(l.gastos)} · por cobrar ${pesos(l.por_cobrar)}${l.gastos > 0 ? ` · ${l.pct}% margen` : ''}</span>
          </div>`
        )
        .join('')}</div>
    </div>

    <div class="bloque">
      <div class="bloque-titulo"><h2>Gastos por categoría</h2><span class="sub">${esc(nombreMes(estado.mes))}</span></div>
      <div class="filas">${
        cat.length
          ? cat
              .map(
                (c) => `<div class="fila"><span class="fila-principal">${esc(c.categoria)}</span>
                  <span class="fila-monto num">${pesos(c.total)}</span>
                  <span class="fila-detalle">${c.n} registros · ${esc(c.tipo)}</span></div>`
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
      <div class="filtros">
        ${['ingresos', 'gastos', 'ventas', 'clientes', 'suscripciones', 'productos']
          .map((t) => `<a class="btn-linea" href="/api/export/${t}.csv">${t}.csv</a>`)
          .join('')}
      </div>
    </div>`;
}

const VISTA_FN = {
  panel: vistaPanel,
  ingresos: vistaIngresos,
  gastos: vistaGastos,
  suscripciones: vistaSuscripciones,
  ventas: vistaVentas,
  inventario: vistaInventario,
  clientes: vistaClientes,
  lineas: vistaLineas,
  reportes: vistaReportes,
};

/* --------------------------------- render --------------------------------- */

function pintarNav() {
  $('#nav').innerHTML = VISTAS.map(
    ([v, t]) => `<a href="#${v}" class="${v === estado.vista ? 'activo' : ''}">${t}</a>`
  ).join('');
}

async function cargarCatalogos() {
  const [lineas, clientes, productos] = await Promise.all([
    api('GET', '/lineas'),
    api('GET', '/clientes'),
    api('GET', '/productos'),
  ]);
  estado.lineas = lineas;
  estado.clientes = clientes;
  estado.productos = productos;
}

async function render() {
  pintarNav();
  const cont = $('#vista');
  try {
    cont.innerHTML = await (VISTA_FN[estado.vista] || vistaPanel)();
    animarCifras(cont);
  } catch (e) {
    cont.innerHTML = `<div class="bloque"><p class="error">${esc(e.message)}</p></div>`;
  }
  const mes = $('#mes') || $('#f-mes');
  if (mes)
    mes.onchange = (ev) => {
      estado.mes = ev.target.value || mesActual();
      render();
    };
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
      { k: 'proveedor', l: 'Proveedor', t: 'text', ancho: true },
      { k: 'nota', l: 'Nota', t: 'text', ancho: true },
    ],
    alGuardar: (d) => api('POST', `/productos/${id}/entrada`, d),
  });
}

document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-nuevo],[data-editar],[data-borrar],[data-pagar],[data-cobrar],[data-entrada],#btn-venta,#btn-generar');
  if (!t) return;
  try {
    if (t.dataset.nuevo) return nuevo(t.dataset.nuevo);
    if (t.id === 'btn-venta') return formularioVenta();
    if (t.dataset.entrada) return formularioEntrada(t.dataset.entrada);
    if (t.dataset.editar) {
      const [tabla, id] = t.dataset.editar.split(':');
      const fila = (await api('GET', `/${tabla}?limit=2000`)).find((x) => x.id === Number(id));
      return editar(tabla, fila);
    }
    if (t.dataset.borrar) {
      const [tabla, id] = t.dataset.borrar.split(':');
      return borrar(tabla, id);
    }
    if (t.dataset.pagar) {
      await api('POST', `/ingresos/${t.dataset.pagar}/pagar`, { fecha: hoy() });
      aviso('Marcado como pagado');
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
  } catch (e) {
    aviso(e.message);
  }
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

$('#btn-entrar').onclick = async () => {
  const err = $('#entrada-error');
  err.hidden = true;
  try {
    await api('POST', '/login', { usuario: $('#in-usuario').value.trim(), clave: $('#in-clave').value });
    await iniciar();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
  }
};
$('#in-clave').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-entrar').click());

$('#btn-salir').onclick = async () => {
  await fetch('/api/logout', { method: 'POST' });
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
$('#modal-guardar').onclick = guardarFormulario;
$('#modal').addEventListener('click', (e) => e.target.id === 'modal' && cerrarFormulario());
document.addEventListener('keydown', (e) => e.key === 'Escape' && cerrarFormulario());

window.addEventListener('hashchange', () => {
  const v = location.hash.slice(1);
  estado.vista = VISTA_FN[v] ? v : 'panel';
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
