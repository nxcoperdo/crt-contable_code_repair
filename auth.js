'use strict';
const crypto = require('crypto');
const db = require('./db');

const SECRET =
  process.env.SESSION_SECRET ||
  (() => {
    console.warn('[crt] SESSION_SECRET no definido: usando uno temporal (las sesiones se caen al reiniciar)');
    return crypto.randomBytes(32).toString('hex');
  })();

const DIAS = 30;

function hashPass(pass, salt) {
  return crypto.scryptSync(pass, salt, 64).toString('hex');
}

function crearUsuario(usuario, pass) {
  const salt = crypto.randomBytes(16).toString('hex');
  db.prepare(
    `INSERT INTO usuarios (usuario, hash, salt, creado) VALUES (?, ?, ?, datetime('now'))`
  ).run(usuario, hashPass(pass, salt), salt);
}

function verificar(usuario, pass) {
  const u = db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(usuario);
  if (!u) return null;
  const intento = Buffer.from(hashPass(pass, u.salt), 'hex');
  const guardado = Buffer.from(u.hash, 'hex');
  if (intento.length !== guardado.length) return null;
  return crypto.timingSafeEqual(intento, guardado) ? u : null;
}

function firmar(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function abrir(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== esperado.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(esperado))) return null;
  try {
    const data = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (data.exp < Date.now()) return null;
    return data;
  } catch {
    return null;
  }
}

function cookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function darSesion(res, usuario) {
  const token = firmar({ u: usuario.usuario, exp: Date.now() + DIAS * 864e5 });
  const seguro = process.env.NODE_ENV === 'production' ? ' Secure;' : '';
  res.setHeader(
    'Set-Cookie',
    `crt_sesion=${token}; HttpOnly; SameSite=Lax; Path=/;${seguro} Max-Age=${DIAS * 86400}`
  );
}

function cerrarSesion(res) {
  res.setHeader('Set-Cookie', 'crt_sesion=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
}

function requiereSesion(req, res, next) {
  const sesion = abrir(cookies(req).crt_sesion);
  if (!sesion) return res.status(401).json({ error: 'Sesión expirada. Entra de nuevo.' });
  req.usuario = sesion.u;
  next();
}

// Usuario inicial desde variables de entorno
function asegurarAdmin() {
  const total = db.prepare('SELECT COUNT(*) c FROM usuarios').get().c;
  if (total) return;
  const usuario = process.env.ADMIN_USER || 'nico';
  const pass = process.env.ADMIN_PASS || 'cambiar-esta-clave';
  crearUsuario(usuario, pass);
  console.log(`[crt] Usuario inicial creado: ${usuario}`);
}

module.exports = { verificar, darSesion, cerrarSesion, requiereSesion, asegurarAdmin, crearUsuario, cookies, abrir };
