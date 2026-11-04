/**
 * MiyeeFit Pro: Cloud API Worker
 * Engineered by Miyee Tech Labs • miyeetechlabs.com
 *
 * Serves the static app (index.html) and a JSON API under /api/*.
 *
 * Accounts
 *   POST   /api/auth/signup        { name, email, password, role, specialization?, trainerCode? }
 *   POST   /api/auth/login         { email, password }
 *   POST   /api/auth/logout
 *   GET    /api/auth/me
 *   POST   /api/auth/password      { currentPassword, newPassword }
 *   DELETE /api/account            { password }
 *
 * Member data
 *   GET    /api/vault              → { rev, updatedAt, data }
 *   PUT    /api/vault              { baseRev, updatedAt, data, force }
 *
 * Trainers & coaching
 *   GET    /api/trainers                         listed trainer profiles
 *   GET    /api/trainer/profile                  (trainer) own profile
 *   PUT    /api/trainer/profile                  (trainer) update profile
 *   PUT    /api/me/trainer      { trainerId }    (member) choose or remove a trainer (null)
 *   GET    /api/coach?read=1                     (member) trainer, plan and messages
 *   POST   /api/coach/messages  { text }         (member) message the trainer
 *   GET    /api/trainer/clients                  (trainer) list of members who chose this trainer
 *   GET    /api/trainer/clients/:id?read=1       (trainer) member progress data, plan and messages
 *   PUT    /api/trainer/clients/:id/plan         (trainer) { targets, exercises, note }
 *   POST   /api/trainer/clients/:id/messages     (trainer) { text }
 *
 * KV layout (binding MIYEEFIT_KV)
 *   email:<email>            → user id
 *   user:<id>                → { id, email, name, role, trainerId, salt, hash, iter, created, sessions[] }
 *   session:<sha256>         → { uid, created }                         (30-day TTL)
 *   vault:<memberId>         → { rev, updatedAt, savedAt, data }
 *   tprofile:<trainerId>     → trainer profile   (list metadata = public card)
 *   client:<trainerId>:<mid> → ""                (list metadata = { name, email, since, lastMsgAt, lastFrom, trainerRead })
 *   plan:<memberId>          → { trainerId, targets, exercises[], note, updatedAt }
 *   thread:<memberId>        → { trainerId, messages[], memberRead, trainerRead }
 *   rl:<email>               → failed sign-in counter                   (15-minute TTL)
 *
 * Optional secret TRAINER_SIGNUP_CODE: when set, trainer sign-up requires this code.
 */

const SESSION_TTL = 60 * 60 * 24 * 30;
const RATE_WINDOW = 60 * 15;
const MAX_FAILED = 10;
const MAX_VAULT_BYTES = 5 * 1024 * 1024;
const PBKDF2_ITER = 100000;
const MAX_SESSIONS = 20;
const MAX_MESSAGES = 300;

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
const now = () => new Date().toISOString();
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const numOrNull = (v, min, max) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null; };

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
const roleOf = (u) => (u.role === 'trainer' ? 'trainer' : 'member');
const publicUser = (u) => ({ id: u.id, email: u.email, name: u.name, role: roleOf(u), trainerId: u.trainerId || null, created: u.created });

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

async function getJson(env, key) { const raw = await env.MIYEEFIT_KV.get(key); return raw ? JSON.parse(raw) : null; }
const putJson = (env, key, value, opts) => env.MIYEEFIT_KV.put(key, JSON.stringify(value), opts);
const getUser = (env, id) => getJson(env, 'user:' + id);
const putUser = (env, u) => putJson(env, 'user:' + u.id, u);

async function createSession(env, user) {
  const token = randomHex(32);
  const key = await sha256(token);
  await putJson(env, 'session:' + key, { uid: user.id, created: now() }, { expirationTtl: SESSION_TTL });
  user.sessions = [key, ...(user.sessions || []).filter((k) => k !== key)];
  const dropped = user.sessions.slice(MAX_SESSIONS);
  user.sessions = user.sessions.slice(0, MAX_SESSIONS);
  await Promise.all(dropped.map((k) => env.MIYEEFIT_KV.delete('session:' + k)));
  await putUser(env, user);
  return token;
}

async function authenticate(request, env, role) {
  const auth = request.headers.get('Authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, 'Please sign in');
  const key = await sha256(token);
  const session = await getJson(env, 'session:' + key);
  if (!session) throw new HttpError(401, 'Your session has expired. Please sign in again');
  const user = await getUser(env, session.uid);
  if (!user) throw new HttpError(401, 'Account not found');
  if (role && roleOf(user) !== role) throw new HttpError(403, role === 'trainer' ? 'This action is only for trainer accounts' : 'This action is only for member accounts');
  return { user, key };
}

async function verifyPassword(user, password) {
  const hash = await pbkdf2(password, user.salt, user.iter || PBKDF2_ITER);
  return safeEqual(hash, user.hash);
}

/* ---------- Trainer profiles ---------- */
function cleanTrainerProfile(body, prev = {}) {
  const langs = Array.isArray(body.languages) ? body.languages : String(body.languages ?? prev.languages ?? '').split(',');
  return {
    id: prev.id, name: prev.name,
    specialization: clip(body.specialization ?? prev.specialization ?? 'Fitness & Weight Loss', 80) || 'Fitness & Weight Loss',
    experience: numOrNull(body.experience ?? prev.experience, 0, 60) ?? 0,
    bio: clip(body.bio ?? prev.bio ?? '', 600),
    certifications: clip(body.certifications ?? prev.certifications ?? '', 160),
    languages: langs.map((l) => clip(l, 24)).filter(Boolean).slice(0, 6),
    city: clip(body.city ?? prev.city ?? '', 60),
    accepting: body.accepting === undefined ? (prev.accepting ?? true) : !!body.accepting,
    updatedAt: now()
  };
}
function trainerCard(p) {
  // KV list metadata is limited to 1024 bytes, so the public card is trimmed to fit.
  const card = { id: p.id, name: p.name, specialization: p.specialization, experience: p.experience, bio: p.bio.slice(0, 260), certifications: p.certifications.slice(0, 100), languages: p.languages, city: p.city, accepting: p.accepting };
  while (enc.encode(JSON.stringify(card)).length > 1000 && card.bio.length) card.bio = card.bio.slice(0, Math.max(0, card.bio.length - 40));
  return card;
}
const putTrainerProfile = (env, p) => env.MIYEEFIT_KV.put('tprofile:' + p.id, JSON.stringify(p), { metadata: trainerCard(p) });

async function listTrainers(env) {
  const out = []; let cursor;
  do {
    const page = await env.MIYEEFIT_KV.list({ prefix: 'tprofile:', cursor });
    page.keys.forEach((k) => { if (k.metadata) out.push(k.metadata); });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && out.length < 1000);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------- Coaching helpers ---------- */
const clientKey = (tid, mid) => `client:${tid}:${mid}`;
async function getClientMeta(env, tid, mid) {
  const r = await env.MIYEEFIT_KV.getWithMetadata(clientKey(tid, mid));
  return r && r.value !== null ? (r.metadata || {}) : null;
}
const putClientMeta = (env, tid, mid, meta) => env.MIYEEFIT_KV.put(clientKey(tid, mid), '', { metadata: meta });

async function loadThread(env, memberId, trainerId) {
  const t = await getJson(env, 'thread:' + memberId);
  if (!t || t.trainerId !== trainerId) return { trainerId, messages: [], memberRead: null, trainerRead: null };
  return t;
}
const unreadFor = (thread, who) => thread.messages.filter((m) => m.from !== who && (!thread[who + 'Read'] || m.at > thread[who + 'Read'])).length;

function cleanPlan(body, trainerId) {
  const t = body.targets || {};
  const targets = {
    steps: numOrNull(t.steps, 1000, 50000), cardio: numOrNull(t.cardio, 0, 300), water: numOrNull(t.water, 500, 8000),
    calories: numOrNull(t.calories, 1000, 5000), protein: numOrNull(t.protein, 20, 400)
  };
  const exercises = (Array.isArray(body.exercises) ? body.exercises : []).slice(0, 40).map((e) => ({
    id: /^[a-z0-9]{6,24}$/.test(e.id || '') ? e.id : randomHex(6),
    name: clip(e.name, 60), detail: clip(e.detail, 80), notes: clip(e.notes, 160),
    days: (Array.isArray(e.days) ? e.days : []).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  })).filter((e) => e.name);
  return { trainerId, targets, exercises, note: clip(body.note, 1500), updatedAt: now() };
}

/* ---------- Handlers ---------- */
async function signup(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  const name = String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const role = body.role === 'trainer' ? 'trainer' : 'member';
  if (!name) throw new HttpError(400, 'Please enter your name');
  if (!validEmail(email)) throw new HttpError(400, 'Please enter a valid email address');
  checkPassword(body.password);
  if (role === 'trainer' && env.TRAINER_SIGNUP_CODE && !safeEqual(String(body.trainerCode || '').trim(), env.TRAINER_SIGNUP_CODE)) throw new HttpError(403, 'Invalid trainer sign-up code');
  if (await env.MIYEEFIT_KV.get('email:' + email)) throw new HttpError(409, 'An account with this email already exists. Sign in instead');
  const salt = randomHex(16);
  const user = { id: randomHex(12), email, name, role, trainerId: null, salt, hash: await pbkdf2(body.password, salt, PBKDF2_ITER), iter: PBKDF2_ITER, created: now(), sessions: [] };
  await env.MIYEEFIT_KV.put('email:' + email, user.id);
  if (role === 'trainer') await putTrainerProfile(env, cleanTrainerProfile(body, { id: user.id, name }));
  const token = await createSession(env, user);
  return json({ ok: true, token, user: publicUser(user) }, 201);
}

async function login(request, env) {
  const body = await readJson(request);
  const email = normEmail(body.email);
  if (!validEmail(email) || typeof body.password !== 'string' || !body.password) throw new HttpError(400, 'Enter your email and password');
  const rlKey = 'rl:' + email;
  const failed = parseInt((await env.MIYEEFIT_KV.get(rlKey)) || '0', 10);
  if (failed >= MAX_FAILED) throw new HttpError(429, 'Too many failed attempts. Please wait 15 minutes and try again');
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
  const jobs = [
    ...(user.sessions || []).map((k) => env.MIYEEFIT_KV.delete('session:' + k)),
    env.MIYEEFIT_KV.delete('email:' + user.email),
    env.MIYEEFIT_KV.delete('user:' + user.id)
  ];
  if (roleOf(user) === 'trainer') {
    jobs.push(env.MIYEEFIT_KV.delete('tprofile:' + user.id));
    let cursor;
    do {
      const page = await env.MIYEEFIT_KV.list({ prefix: `client:${user.id}:`, cursor });
      page.keys.forEach((k) => jobs.push(env.MIYEEFIT_KV.delete(k.name)));
      cursor = page.list_complete ? undefined : page.cursor;
    } while (cursor);
  } else {
    jobs.push(env.MIYEEFIT_KV.delete('vault:' + user.id), env.MIYEEFIT_KV.delete('plan:' + user.id), env.MIYEEFIT_KV.delete('thread:' + user.id));
    if (user.trainerId) jobs.push(env.MIYEEFIT_KV.delete(clientKey(user.trainerId, user.id)));
  }
  await Promise.all(jobs);
  return json({ ok: true, deleted: true });
}

async function getVault(request, env) {
  const { user } = await authenticate(request, env, 'member');
  const raw = await env.MIYEEFIT_KV.get('vault:' + user.id);
  if (!raw) return json({ ok: true, rev: 0, updatedAt: null, data: null });
  return new Response(raw.replace(/^\{/, '{"ok":true,'), { status: 200, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS } });
}

async function putVault(request, env) {
  const { user } = await authenticate(request, env, 'member');
  const body = await readJson(request, MAX_VAULT_BYTES);
  if (!body.data || typeof body.data !== 'object' || !body.data.profile) throw new HttpError(400, 'Expected { data } with a profile');
  const current = (await getJson(env, 'vault:' + user.id)) || { rev: 0, updatedAt: null };
  if (!body.force && Number(body.baseRev || 0) !== current.rev) {
    throw new HttpError(409, 'Your cloud data was changed on another device', { conflict: true, rev: current.rev, updatedAt: current.updatedAt });
  }
  const savedAt = now();
  const record = { rev: current.rev + 1, updatedAt: String(body.updatedAt || savedAt), savedAt, data: body.data };
  await putJson(env, 'vault:' + user.id, record);
  return json({ ok: true, rev: record.rev, savedAt });
}

async function trainersList(request, env) {
  await authenticate(request, env);
  return json({ ok: true, trainers: await listTrainers(env) });
}

async function trainerProfileGet(request, env) {
  const { user } = await authenticate(request, env, 'trainer');
  const p = (await getJson(env, 'tprofile:' + user.id)) || cleanTrainerProfile({}, { id: user.id, name: user.name });
  return json({ ok: true, profile: p });
}

async function trainerProfilePut(request, env) {
  const { user } = await authenticate(request, env, 'trainer');
  const body = await readJson(request);
  const prev = (await getJson(env, 'tprofile:' + user.id)) || { id: user.id, name: user.name };
  const newName = clip(body.name, 60);
  if (newName && newName !== user.name) { user.name = newName; await putUser(env, user); }
  const p = cleanTrainerProfile(body, { ...prev, id: user.id, name: user.name });
  await putTrainerProfile(env, p);
  return json({ ok: true, profile: p, user: publicUser(user) });
}

async function chooseTrainer(request, env) {
  const { user } = await authenticate(request, env, 'member');
  const body = await readJson(request);
  const tid = body.trainerId ? String(body.trainerId) : null;
  let profile = null;
  if (tid) {
    profile = await getJson(env, 'tprofile:' + tid);
    if (!profile) throw new HttpError(404, 'That trainer is no longer available');
    if (!profile.accepting && user.trainerId !== tid) throw new HttpError(409, `${profile.name} is not accepting new clients right now`);
  }
  if (user.trainerId && user.trainerId !== tid) await env.MIYEEFIT_KV.delete(clientKey(user.trainerId, user.id));
  if (tid && user.trainerId !== tid) await putClientMeta(env, tid, user.id, { name: user.name, email: user.email, since: now(), lastMsgAt: null, lastFrom: null, trainerRead: null });
  user.trainerId = tid;
  await putUser(env, user);
  return json({ ok: true, user: publicUser(user), trainer: profile ? trainerCard(profile) : null });
}

async function coachGet(request, env, url) {
  const { user } = await authenticate(request, env, 'member');
  if (!user.trainerId) return json({ ok: true, trainer: null, plan: null, messages: [], unread: 0 });
  const profile = await getJson(env, 'tprofile:' + user.trainerId);
  if (!profile) return json({ ok: true, trainer: null, plan: null, messages: [], unread: 0, trainerRemoved: true });
  const plan = await getJson(env, 'plan:' + user.id);
  const thread = await loadThread(env, user.id, user.trainerId);
  if (url.searchParams.get('read') === '1' && thread.messages.length) { thread.memberRead = now(); await putJson(env, 'thread:' + user.id, thread); }
  return json({ ok: true, trainer: trainerCard(profile), plan: plan && plan.trainerId === user.trainerId ? plan : null, messages: thread.messages, unread: unreadFor(thread, 'member') });
}

async function addMessage(env, memberId, trainerId, from, text) {
  const body = clip(text, 2000);
  if (!body) throw new HttpError(400, 'Message is empty');
  const thread = await loadThread(env, memberId, trainerId);
  const msg = { id: randomHex(6), from, text: body, at: now() };
  thread.messages = [...thread.messages, msg].slice(-MAX_MESSAGES);
  thread[from + 'Read'] = msg.at;
  await putJson(env, 'thread:' + memberId, thread);
  const meta = (await getClientMeta(env, trainerId, memberId)) || {};
  await putClientMeta(env, trainerId, memberId, { ...meta, lastMsgAt: msg.at, lastFrom: from, trainerRead: from === 'trainer' ? msg.at : (meta.trainerRead || null) });
  return { msg, thread };
}

async function coachMessage(request, env) {
  const { user } = await authenticate(request, env, 'member');
  if (!user.trainerId) throw new HttpError(400, 'Choose a trainer first');
  const body = await readJson(request);
  const { msg, thread } = await addMessage(env, user.id, user.trainerId, 'member', body.text);
  return json({ ok: true, message: msg, messages: thread.messages });
}

async function assertClient(env, trainer, memberId) {
  const member = await getUser(env, memberId);
  if (!member || roleOf(member) !== 'member' || member.trainerId !== trainer.id) throw new HttpError(404, 'This member is not your client');
  return member;
}

async function trainerClients(request, env) {
  const { user } = await authenticate(request, env, 'trainer');
  const clients = []; let cursor;
  do {
    const page = await env.MIYEEFIT_KV.list({ prefix: `client:${user.id}:`, cursor });
    page.keys.forEach((k) => {
      const m = k.metadata || {};
      clients.push({ id: k.name.split(':')[2], name: m.name, email: m.email, since: m.since, lastMsgAt: m.lastMsgAt, unread: m.lastFrom === 'member' && (!m.trainerRead || m.lastMsgAt > m.trainerRead) });
    });
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor && clients.length < 1000);
  clients.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return json({ ok: true, clients });
}

async function trainerClientGet(request, env, url, memberId) {
  const { user } = await authenticate(request, env, 'trainer');
  const member = await assertClient(env, user, memberId);
  const [vault, plan, thread] = await Promise.all([getJson(env, 'vault:' + memberId), getJson(env, 'plan:' + memberId), loadThread(env, memberId, user.id)]);
  if (url.searchParams.get('read') === '1' && thread.messages.length) {
    thread.trainerRead = now(); await putJson(env, 'thread:' + memberId, thread);
    const meta = (await getClientMeta(env, user.id, memberId)) || {};
    await putClientMeta(env, user.id, memberId, { ...meta, name: member.name, email: member.email, trainerRead: thread.trainerRead });
  }
  return json({ ok: true, client: publicUser(member), vault: vault ? { updatedAt: vault.updatedAt, savedAt: vault.savedAt, data: vault.data } : null, plan: plan && plan.trainerId === user.id ? plan : null, messages: thread.messages, unread: unreadFor(thread, 'trainer') });
}

async function trainerPlanPut(request, env, memberId) {
  const { user } = await authenticate(request, env, 'trainer');
  await assertClient(env, user, memberId);
  const prev = await getJson(env, 'plan:' + memberId);
  const plan = cleanPlan(await readJson(request), user.id);
  plan.startedAt = prev && prev.trainerId === user.id && prev.startedAt ? prev.startedAt : plan.updatedAt;
  await putJson(env, 'plan:' + memberId, plan);
  return json({ ok: true, plan });
}

async function trainerMessage(request, env, memberId) {
  const { user } = await authenticate(request, env, 'trainer');
  await assertClient(env, user, memberId);
  const body = await readJson(request);
  const { msg, thread } = await addMessage(env, memberId, user.id, 'trainer', body.text);
  return json({ ok: true, message: msg, messages: thread.messages });
}

async function route(request, env, url) {
  if (!env.MIYEEFIT_KV) throw new HttpError(500, 'Cloud storage is not configured (missing MIYEEFIT_KV binding)');
  const path = url.pathname.replace(/\/+$/, '');
  const m = request.method;
  if (path === '/api/health' && m === 'GET') return json({ ok: true, service: 'miyeefit-pro', time: now(), trainerCodeRequired: !!env.TRAINER_SIGNUP_CODE });
  if (path === '/api/auth/signup' && m === 'POST') return signup(request, env);
  if (path === '/api/auth/login' && m === 'POST') return login(request, env);
  if (path === '/api/auth/logout' && m === 'POST') return logout(request, env);
  if (path === '/api/auth/me' && m === 'GET') { const { user } = await authenticate(request, env); return json({ ok: true, user: publicUser(user) }); }
  if (path === '/api/auth/password' && m === 'POST') return changePassword(request, env);
  if (path === '/api/account' && m === 'DELETE') return deleteAccount(request, env);
  if (path === '/api/vault' && m === 'GET') return getVault(request, env);
  if (path === '/api/vault' && m === 'PUT') return putVault(request, env);
  if (path === '/api/trainers' && m === 'GET') return trainersList(request, env);
  if (path === '/api/trainer/profile' && m === 'GET') return trainerProfileGet(request, env);
  if (path === '/api/trainer/profile' && m === 'PUT') return trainerProfilePut(request, env);
  if (path === '/api/me/trainer' && m === 'PUT') return chooseTrainer(request, env);
  if (path === '/api/coach' && m === 'GET') return coachGet(request, env, url);
  if (path === '/api/coach/messages' && m === 'POST') return coachMessage(request, env);
  if (path === '/api/trainer/clients' && m === 'GET') return trainerClients(request, env);
  const cm = path.match(/^\/api\/trainer\/clients\/([0-9a-f]{24})(\/plan|\/messages)?$/);
  if (cm) {
    if (!cm[2] && m === 'GET') return trainerClientGet(request, env, url, cm[1]);
    if (cm[2] === '/plan' && m === 'PUT') return trainerPlanPut(request, env, cm[1]);
    if (cm[2] === '/messages' && m === 'POST') return trainerMessage(request, env, cm[1]);
  }
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
