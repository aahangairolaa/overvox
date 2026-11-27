// OVERVOX accounts: username + password, stay signed in, profile follows you to any device.
// Storage: one Workers KV namespace bound as ACCOUNTS.
//   u:<name lowercased>  -> { name, salt, hash, it, profile, updated, created }
//   s:<token>            -> name lowercased   (session, 180 days, renewed when used)
//   rl:<ip>              -> failed sign-in attempts in the last 10 minutes
// Routes (JSON in, JSON out):
//   POST /api/signup  { username, password, profile? }   -> { token, name, profile, updated }
//   POST /api/login   { username, password }             -> { token, name, profile, updated }
//   GET  /api/me      (Authorization: Bearer <token>)    -> { name, profile, updated }
//   PUT  /api/profile { profile, updated }               -> { updated }
//   POST /api/logout                                     -> { ok: true }
//   POST /api/order   { item, utr }  (signed in)         -> { ok, id }      v2.9: UPI QR purchase, waits for Aahan
//   GET  /api/orders  (signed in)                        -> { orders: [{ item, status }] }
//   GET  /api/admin/orders   (header x-admin-key)        -> { orders: [...] }   ADMIN_KEY = a Worker secret
//   POST /api/admin/order { id, ok }  (x-admin-key)      -> { ok }  approve adds the item to the buyer's account
//   o:<id> -> { id, user, name, item, utr, t, status }   orders (pending | approved | rejected)
// Items an admin approved are kept in u.grants and always re-added to profile.owned, so a device
// that saves an older profile can never lose a paid item.
// Passwords are never stored: only a salted PBKDF2-SHA256 hash (100k rounds, the Workers maximum).

const SESSION_TTL = 180 * 86400, PROFILE_MAX = 64 * 1024, IT = 100000;
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type, authorization, x-admin-key', 'access-control-allow-methods': 'GET, POST, PUT, OPTIONS' };
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
const err = (msg, status = 400) => json({ error: msg }, status);
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const randB64 = (n) => b64(crypto.getRandomValues(new Uint8Array(n))).replace(/[+/=]/g, (c) => ({ '+': '-', '/': '_', '=': '' })[c]);

async function hashPw(pw, saltB64, it = IT) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return b64(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: it }, key, 256));
}
// constant-time compare so the time taken doesn't leak how much of a hash matched
function same(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }

function withGrants(p, g) { if (!g || !g.length || !p) return p; p.owned = [...new Set([...(p.owned || []), ...g])]; return p; }
const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;
function checkName(n) { n = String(n || '').trim().replace(/\s+/g, ' '); return NAME_RE.test(n) ? n : null; }
function checkProfile(p) { if (p == null) return null; const s = JSON.stringify(p); return s.length <= PROFILE_MAX ? p : undefined; }

async function newSession(env, key) { const token = randB64(32); await env.ACCOUNTS.put('s:' + token, key, { expirationTtl: SESSION_TTL }); return token; }
async function userFromReq(req, env) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([A-Za-z0-9_-]{20,})$/); if (!m) return null;
  const key = await env.ACCOUNTS.get('s:' + m[1]); if (!key) return null;
  const u = await env.ACCOUNTS.get('u:' + key, 'json'); if (!u) return null;
  await env.ACCOUNTS.put('s:' + m[1], key, { expirationTtl: SESSION_TTL });   // stay signed in while you keep playing
  return { u, key, token: m[1] };
}
async function limited(req, env) {
  const ip = req.headers.get('cf-connecting-ip') || 'x', k = 'rl:' + ip, n = +(await env.ACCOUNTS.get(k)) || 0;
  return { over: n >= 20, bump: () => env.ACCOUNTS.put(k, String(n + 1), { expirationTtl: 600 }) };
}

export async function handleAccounts(req, env) {
  const url = new URL(req.url), path = url.pathname;
  if (!path.startsWith('/api/')) return null;
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env.ACCOUNTS) return err('accounts are not set up on the server yet', 503);
  let body = {}; if (req.method === 'POST' || req.method === 'PUT') { try { body = await req.json(); } catch (e) { return err('bad request'); } }

  if (path === '/api/signup' && req.method === 'POST') {
    const name = checkName(body.username); if (!name) return err('Username: 3–16 letters, numbers, spaces, _ or -');
    const pw = String(body.password || ''); if (pw.length < 6 || pw.length > 100) return err('Password: at least 6 characters');
    const profile = checkProfile(body.profile); if (profile === undefined) return err('profile too large');
    const key = name.toLowerCase(); if (await env.ACCOUNTS.get('u:' + key)) return err('That username is taken', 409);
    const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
    const now = Date.now(), u = { name, salt, hash: await hashPw(pw, salt), it: IT, profile: profile || null, updated: now, created: now };
    await env.ACCOUNTS.put('u:' + key, JSON.stringify(u));
    return json({ token: await newSession(env, key), name, profile: u.profile, updated: now });
  }
  if (path === '/api/login' && req.method === 'POST') {
    const rl = await limited(req, env); if (rl.over) return err('Too many tries. Wait 10 minutes.', 429);
    const name = checkName(body.username), pw = String(body.password || '');
    const u = name && await env.ACCOUNTS.get('u:' + name.toLowerCase(), 'json');
    if (!u || !same(await hashPw(pw, u.salt, u.it || IT), u.hash)) { await rl.bump(); return err('Wrong username or password', 401); }
    return json({ token: await newSession(env, u.name.toLowerCase()), name: u.name, profile: u.profile, updated: u.updated });
  }
  if (path.startsWith('/api/admin/')) {
    const k = req.headers.get('x-admin-key') || ''; if (!env.ADMIN_KEY || !same(k, env.ADMIN_KEY)) { await new Promise(r => setTimeout(r, 400)); return err('wrong admin key', 403); }
    if (path === '/api/admin/orders' && req.method === 'GET') { const l = await env.ACCOUNTS.list({ prefix: 'o:' }), out = [];
      for (const x of l.keys) { const o = await env.ACCOUNTS.get(x.name, 'json'); if (o) out.push(o); } out.sort((a, b) => b.t - a.t); return json({ orders: out.slice(0, 100) }); }
    if (path === '/api/admin/order' && req.method === 'POST') { const o = await env.ACCOUNTS.get('o:' + String(body.id || ''), 'json'); if (!o) return err('no such order', 404);
      if (o.status !== 'pending') return err('already ' + o.status, 409);
      o.status = body.ok ? 'approved' : 'rejected'; o.done = Date.now();
      if (body.ok) { const u = await env.ACCOUNTS.get('u:' + o.user, 'json'); if (!u) return err('buyer account is gone', 404);
        u.grants = [...new Set([...(u.grants || []), o.item])]; u.profile = withGrants(u.profile || {}, u.grants); u.updated = Date.now(); await env.ACCOUNTS.put('u:' + o.user, JSON.stringify(u)); }
      await env.ACCOUNTS.put('o:' + o.id, JSON.stringify(o), { expirationTtl: 90 * 86400 }); return json({ ok: true }); }
    return err('not found', 404);
  }
  const me = await userFromReq(req, env);
  if (!me) return err('Signed out. Please sign in again.', 401);
  if (path === '/api/me' && req.method === 'GET') return json({ name: me.u.name, profile: me.u.profile && withGrants(me.u.profile, me.u.grants), updated: me.u.updated });
  if (path === '/api/order' && req.method === 'POST') {
    const item = String(body.item || ''), utr = String(body.utr || '').replace(/\s/g, '');
    if (!/^[a-z0-9_:-]{3,40}$/.test(item)) return err('bad item'); if (!/^[0-9A-Za-z]{10,22}$/.test(utr)) return err('Enter the UPI reference number (12 digits) from your payment app');
    const mine = await env.ACCOUNTS.list({ prefix: 'o:' }); let open = 0; for (const x of mine.keys) { const o = await env.ACCOUNTS.get(x.name, 'json'); if (o && o.user === me.key && o.status === 'pending') open++; }
    if (open >= 5) return err('You already have 5 orders waiting. Wait for them to be checked.', 429);
    const id = randB64(9), o = { id, user: me.key, name: me.u.name, item, utr, t: Date.now(), status: 'pending' };
    await env.ACCOUNTS.put('o:' + id, JSON.stringify(o), { expirationTtl: 90 * 86400 }); return json({ ok: true, id });
  }
  if (path === '/api/orders' && req.method === 'GET') { const l = await env.ACCOUNTS.list({ prefix: 'o:' }), out = [];
    for (const x of l.keys) { const o = await env.ACCOUNTS.get(x.name, 'json'); if (o && o.user === me.key) out.push({ item: o.item, status: o.status, t: o.t }); } return json({ orders: out }); }
  if (path === '/api/profile' && req.method === 'PUT') {
    const profile = checkProfile(body.profile); if (!profile) return err('profile missing or too large');
    me.u.profile = withGrants(profile, me.u.grants); me.u.updated = Date.now(); await env.ACCOUNTS.put('u:' + me.key, JSON.stringify(me.u));
    return json({ updated: me.u.updated });
  }
  if (path === '/api/logout' && req.method === 'POST') { await env.ACCOUNTS.delete('s:' + me.token); return json({ ok: true }); }
  return err('not found', 404);
}
