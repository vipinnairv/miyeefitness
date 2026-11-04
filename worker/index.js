/**
 * MiyeeFit Pro — Cloud API Worker
 * Engineered by Miyee Tech Labs • miyeetechlabs.com
 *
 * Serves the static app (index.html) and a small JSON API under /api/*:
 *   GET    /api/health             service status
 *   POST   /api/auth/signup        { name, email, password }        → { token, user }
 *   POST   /api/auth/login         { email, password }              → { token, user }
 *   POST   /api/auth/logout        (Bearer)                         → { ok }
 *   GET    /api/auth/me            (Bearer)                         → { user }
 *   POST   /api/auth/password      (Bearer) { currentPassword, newPassword }
 *   DELETE /api/account            (Bearer) { password }            → deletes account + data
 *   GET    /api/vault              (Bearer)                         → { rev, updatedAt, data }
 *   PUT    /api/vault              (Bearer) { baseRev, updatedAt, data, force }
 *
 * Storage: one KV namespace bound as MIYEEFIT_KV
 *   email:<email>        → user id
 *   user:<id>            → { id, email, name, salt, hash, iter, created, sessions[] }
 *   session:<sha256>     → { uid, created }            (expires after 30 days)
 *   vault:<id>           → { rev, updatedAt, savedAt, data }
 *   rl:<email>           → failed sign-in counter       (expires after 15 minutes)
 */

const SESSION_TTL = 60 * 60 * 24 * 30;
const RATE_WINDOW = 60 * 15;
const MAX_FAILED = 10;
const MAX_VAULT_BYTES = 5 * 1024 * 1024;
const PBKDF2_ITER = 100000;
const MAX_SESSIONS = 20;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400'
};

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS }
  });
}

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const randomHex = (n) => toHex(crypto.getRandomValues(new Uint8Array(n)));
const sha256 = async (text) => toHex(await crypto.subtle.digest('SHA-256', enc.encode(text)));

async function pbkdf2(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return toHex(bits);
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const normEmail = (e) => String(e || '').trim().toLowerCase();
const validEmail = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e) && e.length <= 254;
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, created: u.created });

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
  if (pw.length > 200) throw new HttpError(400, 'Password is too long');
}

async function readJson(request, limit = 64 * 1024) {
  const text = await request.text();
  if (text.length > limit) throw new HttpError(413, 'Request is too large');
  if (!text) return {};
  try { return JSON.parse(text); } catch (e) { throw new HttpError(400, 'Invalid JSON body'); }
}

async function getUser(env, id) {
  const raw = await env.MIYEEFIT_KV.get('user:' + id);
  return raw ? JSON.parse(raw) : null;
}
const putUser = (env, u) => env.MIYEEFIT_KV.put('user:' + u.id, JSON.stringify(u));

async function createSession(env, user) {
  const token = randomHex(32);
  const key = await sha256(token);
  await env.MIYEEFIT_KV.put('session:' + key, JSON.stringify({ uid: user.id, created: new Date().toISOString() }), { expirationTtl: SESSION_TTL });
  user.sessions = [key, ...(user.sessions || []).filter((k) => k !== key)];
  const dropped = user.sessions.slice(MAX_SESSIONS);
  user.sessions = user.sessions.slice(0, MAX_SESSIONS);
  await Promise.all(dropped.map((k) => env.MIYEEFIT_KV.delete('session:' + k)));
  await putUser(env, user);
  return token;
}

async function authenticate(request, env) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, 'Please sign in');
  const key = await sha256(token);
  const raw = await env.MIYEEFIT_KV.get('session:' + key);
  if (!raw) throw new HttpError(401, 'Your session has expired — please sign in again');
  const session = JSON.parse(raw);
  const user = await getUser(env, session.uid);
  if (!user) throw new HttpError(401, 'Account not found');
  return { user, key };
}

async function verifyPassword(user, password) {
  const hash = await pbkdf2(password, user.salt, user.iter || PBKDF2_ITER);
  return safeEqual(hash, user.hash);
}

async function signup(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address');
  checkPassword(body.password);
  if (await env.MIYEEFIT_KV.get('email:' + email)) throw new HttpError(409, 'An account with this email already exists — sign in instead');
  const salt = randomHex(16);
  const user = { id: randomHex(12), email, name, salt, hash: await pbkdf2(body.password, salt, PBKDF2_ITER), iter: PBKDF2_ITER, created: new Date().toISOString(), sessions: [] };
  await env.MIYEEFIT_KV.put('email:' + email, user.id);
  const token = await createSession(env, user);
  return json({ ok: true, token, user: publicUser(user) }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!validEmail(email) || typeof body.password !== 'string' || !body.password) throw new HttpError(400, 'Enter your email and password');
  const rlKey = 'rl:' + email;
  const failed = parseInt((await env.MIYEEFIT_KV.get(rlKey)) || '0', 10);
  if (failed >= MAX_FAILED) throw new HttpError(429, 'Too many failed attempts — please wait 15 minutes and try again');
  const id = await env.MIYEEFIT_KV.get('email:' + email);
  const user = id ? await getUser(env, id) : null;
  const ok = user ? await verifyPassword(user, body.password) : (await pbkdf2(body.password, '00'.repeat(16), PBKDF2_ITER), false);
  if (!ok) {
    await env.MIYEEFIT_KV.put(rlKey, String(failed + 1), { expirationTtl: RATE_WINDOW });
    throw new HttpError(401, 'Incorrect email or password');
  }
  if (failed) await env.MIYEEFIT_KV.delete(rlKey);
  const token = await createSession(env, user);
  return json({ ok: true, token, user: publicUser(user) });
}

async function logout(request, env) {
  const { user, key } = await authenticate(request, env);
  await env.MIYEEFIT_KV.delete('session:' + key);
  user.sessions = (user.sessions || []).filter((k) => k !== key);
  await putUser(env, user);
  return json({ ok: true });
}

async function changePassword(request, env) {
  const { user, key } = await authenticate(request, env);
  const body = await readJson(request);
  if (!(await verifyPassword(user, String(body.currentPassword || '')))) throw new HttpError(403, 'Current password is incorrect');
  checkPassword(body.newPassword);
  user.salt = randomHex(16);
  user.iter = PBKDF2_ITER;
  user.hash = await pbkdf2(body.newPassword, user.salt, PBKDF2_ITER);
  const others = (user.sessions || []).filter((k) => k !== key);
  await Promise.all(others.map((k) => env.MIYEEFIT_KV.delete('session:' + k)));
  user.sessions = [key];
  await putUser(env, user);
  return json({ ok: true, signedOutOtherDevices: others.length });
}

async function deleteAccount(request, env) {
  const { user } = await authenticate(request, env);
  const body = await readJson(request);
  if (!(await verifyPassword(user, String(body.password || '')))) throw new HttpError(403, 'Password is incorrect');
  await Promise.all([
    ...(user.sessions || []).map((k) => env.MIYEEFIT_KV.delete('session:' + k)),
    env.MIYEEFIT_KV.delete('vault:' + user.id),
    env.MIYEEFIT_KV.delete('email:' + user.email),
    env.MIYEEFIT_KV.delete('user:' + user.id)
  ]);
  return json({ ok: true, deleted: true });
}

async function getVault(request, env) {
  const { user } = await authenticate(request, env);
  const raw = await env.MIYEEFIT_KV.get('vault:' + user.id);
  if (!raw) return json({ ok: true, rev: 0, updatedAt: null, data: null });
  return new Response(raw.replace(/^\{/, '{"ok":true,'), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
}

async function putVault(request, env) {
  const { user } = await authenticate(request, env);
  const body = await readJson(request, MAX_VAULT_BYTES);
  if (!body.data || typeof body.data !== 'object' || !body.data.profile) throw new HttpError(400, 'Expected { data } with a profile');
  const raw = await env.MIYEEFIT_KV.get('vault:' + user.id);
  const current = raw ? JSON.parse(raw) : { rev: 0, updatedAt: null };
  if (!body.force && Number(body.baseRev || 0) !== current.rev) {
    throw new HttpError(409, 'Your cloud data was changed on another device', { conflict: true, rev: current.rev, updatedAt: current.updatedAt });
  }
  const savedAt = new Date().toISOString();
  const record = { rev: current.rev + 1, updatedAt: String(body.updatedAt || savedAt), savedAt, data: body.data };
  await env.MIYEEFIT_KV.put('vault:' + user.id, JSON.stringify(record));
  return json({ ok: true, rev: record.rev, savedAt });
}

async function route(request, env, url) {
  if (!env.MIYEEFIT_KV) throw new HttpError(500, 'Cloud storage is not configured (missing MIYEEFIT_KV binding)');
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  if (path === '/api/health' && m === 'GET') return json({ ok: true, service: 'miyeefit-pro', time: new Date().toISOString() });
  if (path === '/api/auth/signup' && m === 'POST') return signup(request, env);
  if (path === '/api/auth/login' && m === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && m === 'POST') return logout(request, env);
  if (path === '/api/auth/me' && m === 'GET') { const { user } = await authenticate(request, env); return json({ ok: true, user: publicUser(user) }); }
  if (path === '/api/auth/password' && m === 'POST') return changePassword(request, env);
  if (path === '/api/account' && m === 'DELETE') return deleteAccount(request, env);
  if (path === '/api/vault' && m === 'GET') return getVault(request, env);
  if (path === '/api/vault' && m === 'PUT') return putVault(request, env);
  throw new HttpError(404, 'Not found');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    try {
      return await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) return json({ ok: false, error: e.message, ...e.extra }, e.status);
      console.error('Unhandled API error', e && e.stack ? e.stack : e);
      return json({ ok: false, error: 'Something went wrong on the server' }, 500);
    }
  }
};
