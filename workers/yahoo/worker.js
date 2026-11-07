/* Fair Catch: accounts, Yahoo Fantasy sign-in and read-only proxy (Cloudflare Worker).
   Settings in Cloudflare (Settings > Variables and Secrets):
     YAHOO_CLIENT_ID      text
     YAHOO_CLIENT_SECRET  secret (type it there yourself; it never goes in this file)
     GOOGLE_CLIENT_ID     text    (optional: turns on "Continue with Google")
     GOOGLE_CLIENT_SECRET secret  (optional, type it there yourself)
     OWNER_EMAILS         text    (optional: comma separated; always Pro, never use a free-month spot)
     MAIL_FROM            text    (optional, e.g. "Fair Catch <hello@faircatch.com>"; turns on email: verify + password reset)
     RESEND_API_KEY       secret  (optional; or bind Cloudflare Email Service as EMAIL). Sending needs a verified domain.
   Bindings (Settings > Bindings):
     DB                   a D1 database (accounts). Tables are created on first use.
   Account routes (JSON, called from the app; the session token goes in "Authorization: Bearer"):
     GET  /auth/config               {google, spots}  spots = free Pro months left for new sign-ups
     POST /auth/signup {email,password}  ->  {token, user}
     POST /auth/login  {email,password}  ->  {token, user}
     GET  /auth/me                   ->  {user}
     POST /auth/logout
     POST /auth/password {old,new}
     POST /auth/delete {password}    deletes the account, its data and its sessions (a password account must type its password)
     POST /auth/logout_all           signs the account out on every device
     GET  /auth/sync                 ->  {data, updated}   the account's saved leagues and settings
     POST /auth/sync {data}          saves them (a JSON string, up to 512 KB)
     POST /auth/forgot {email, app}  emails a reset link (always answers ok, so it never tells who has an account)
     POST /auth/reset {token, new}   sets a new password from the link, signs out everywhere else
     POST /auth/verify/send {app}    emails a verification link again
     GET  /auth/verify?t=&r=         the link in that email; marks the email verified and returns to the app
     GET  /auth/google?return=<app url>   Google sign-in; comes back to the app with #fc_tok=<token>
   Stats:
     POST /stats/ping {vid}          an anonymous visit heartbeat (vid = random id kept on the device), about once a minute
     GET  /admin/stats               owner only (a session of an OWNER_EMAILS account): sign-ups, emails, who is online, visits
   Yahoo routes:
     GET  /login?return=<app url>   sends the user to Yahoo's own sign-in page
     GET  /callback                 Yahoo sends the user back here; we swap the code for tokens
                                    and return to the app with them in the #fragment (never sent to a server)
     POST /refresh  {refresh_token} a fresh access token
     GET  /api/<fantasy path>       read-only Yahoo Fantasy API, e.g. /api/users;use_login=1/games;game_keys=nfl/leagues
*/
const APP_ORIGINS = ['https://amit20b.github.io', 'https://faircatch.com', 'https://www.faircatch.com', 'http://localhost:8000'];
const DEFAULT_RETURN = 'https://amit20b.github.io/fair-catch/';
const AUTH = 'https://api.login.yahoo.com/oauth2/request_auth';
const TOKEN = 'https://api.login.yahoo.com/oauth2/get_token';
const FANTASY = 'https://fantasysports.yahooapis.com/fantasy/v2/';

const cors = (req) => {
  const o = req.headers.get('Origin') || '';
  return APP_ORIGINS.includes(o)
    ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' }
    : {};
};
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...cors(req) } });
const safeReturn = (u) => { try { const x = new URL(u); return APP_ORIGINS.includes(x.origin) ? x.origin + x.pathname : DEFAULT_RETURN; } catch { return DEFAULT_RETURN; } };
// a light brake on misuse: per visitor address, a minute window (Cloudflare's rate limiter when bound, else per instance)
const MEM = new Map();
async function tooMany(req, env) {
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (env.RL && env.RL.limit) { try { const { success } = await env.RL.limit({ key: ip }); return !success; } catch {} }
  const now = Date.now(), w = MEM.get(ip) || { t: now, n: 0 };
  if (now - w.t > 60000) { w.t = now; w.n = 0; }
  w.n++; MEM.set(ip, w); if (MEM.size > 5000) MEM.clear();
  return w.n > 120;
}
const fromApp = (req) => APP_ORIGINS.includes(req.headers.get('Origin') || '');
const b64 = (s) => btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/* ---------- accounts ---------- */
const PROMO_SLOTS = 10, PROMO_DAYS = 30, SESSION_DAYS = 60, PBKDF2_ITER = 100000;
const enc = new TextEncoder();
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const rand = (n) => { const a = new Uint8Array(n); crypto.getRandomValues(a); return a; };
const b64u = (a) => btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hashPw(pw, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const salt = new Uint8Array(saltHex.match(/../g).map((x) => parseInt(x, 16)));
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
const same = (a, b) => { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; };
const cleanEmail = (e) => String(e || '').trim().toLowerCase();
const okEmail = (e) => e.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
const owners = (env) => String(env.OWNER_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
let READY = false;
async function db(env) {
  if (!env.DB) throw Object.assign(new Error('accounts are not set up yet'), { status: 503 });
  if (!READY) {
    await env.DB.batch([
      env.DB.prepare('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, pw TEXT, salt TEXT, google_sub TEXT UNIQUE, created INTEGER NOT NULL, pro_until INTEGER, promo INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS promo_used (h TEXT PRIMARY KEY, at INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS visits (vid TEXT PRIMARY KEY, first INTEGER NOT NULL, last INTEGER NOT NULL, uid INTEGER, pings INTEGER NOT NULL DEFAULT 0)'),
      env.DB.prepare('CREATE INDEX IF NOT EXISTS visits_last ON visits(last)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS visit_days (day TEXT NOT NULL, vid TEXT NOT NULL, PRIMARY KEY (day, vid))'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS user_data (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS tokens (hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL, kind TEXT NOT NULL, expires INTEGER NOT NULL)'),
      env.DB.prepare('CREATE TABLE IF NOT EXISTS limits (k TEXT PRIMARY KEY, n INTEGER NOT NULL, first INTEGER NOT NULL)'),
    ]);
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN last_seen INTEGER').run(); } catch {}   // already there
    try { await env.DB.prepare('ALTER TABLE users ADD COLUMN verified INTEGER NOT NULL DEFAULT 0').run(); } catch {}
    READY = true;
  }
  return env.DB;
}
const userOut = (u, env) => {
  const own = owners(env).includes(u.email);
  return { email: u.email, created: u.created, pro_until: own ? 4102444800000 : (u.pro_until || 0), promo: !!u.promo, owner: own, google: !!u.google_sub, password: !!u.pw, verified: !!(u.verified || u.google_sub) };
};
/* ---------- email (verify + password reset) ---------- */
const mailOn = (env) => !!(env.MAIL_FROM && (env.EMAIL || env.RESEND_API_KEY));
async function sendMail(env, to, subject, text, html) {
  if (env.EMAIL && env.EMAIL.send) { await env.EMAIL.send({ to, from: env.MAIL_FROM, subject, text, html }); return; }
  const r = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM, to: [to], subject, text, html }) });
  if (!r.ok) throw new Error('email failed ' + r.status);
}
const mailHtml = (title, body, btn, link) => `<div style="background:#070B1A;padding:32px 16px;font-family:Arial,sans-serif"><div style="max-width:480px;margin:0 auto;background:#0F1630;border:1px solid #25305A;border-radius:16px;padding:28px;color:#EEF2FF">
<div style="font-weight:900;font-size:22px;letter-spacing:.04em">FAIR CATCH</div><h1 style="font-size:22px;margin:22px 0 10px">${title}</h1><p style="color:#B6C0E0;font-size:15px;line-height:1.5;margin:0 0 22px">${body}</p>
<a href="${link}" style="display:inline-block;background:#C6FF3D;color:#0A1200;font-weight:800;text-decoration:none;padding:13px 22px;border-radius:12px">${btn}</a>
<p style="color:#7480A3;font-size:12.5px;line-height:1.5;margin:22px 0 0">If the button does not work, copy this link:<br><span style="word-break:break-all">${link}</span></p>
<p style="color:#7480A3;font-size:12.5px;margin:16px 0 0">If you did not ask for this, ignore this email.</p></div></div>`;
async function newToken(D, uid, kind, minutes) {
  const t = b64u(rand(32));
  await D.prepare('DELETE FROM tokens WHERE (user_id = ?1 AND kind = ?2) OR expires < ?3').bind(uid, kind, Date.now()).run();
  await D.prepare('INSERT INTO tokens (hash, user_id, kind, expires) VALUES (?1, ?2, ?3, ?4)').bind(await sha(t), uid, kind, Date.now() + minutes * 60000).run();
  return t;
}
async function useToken(D, t, kind) {
  const h = await sha(String(t || ''));
  const row = await D.prepare('SELECT user_id FROM tokens WHERE hash = ?1 AND kind = ?2 AND expires > ?3').bind(h, kind, Date.now()).first();
  if (row) await D.prepare('DELETE FROM tokens WHERE hash = ?1').bind(h).run();
  return row ? row.user_id : null;
}
async function sendVerify(req, env, D, u, app) {
  const t = await newToken(D, u.id, 'verify', 60 * 48);
  const link = new URL(req.url).origin + '/auth/verify?' + new URLSearchParams({ t, r: safeReturn(app || '') });
  await sendMail(env, u.email, 'Confirm your email for Fair Catch', 'Confirm your email for Fair Catch: ' + link,
    mailHtml('Confirm your email', 'Tap the button to confirm this is your email.' + (PROMO_SLOTS ? ' If you are one of the first sign-ups, this also starts your free month of Pro.' : ''), 'Confirm email', link));
}
async function newSession(D, uid) {
  const tok = b64u(rand(32)), now = Date.now();
  await D.prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?1, ?2, ?3, ?4)').bind(await sha(tok), uid, now, now + SESSION_DAYS * 864e5).run();
  await D.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now, uid).run();
  await D.prepare('DELETE FROM sessions WHERE expires < ?1').bind(now).run();
  return tok;
}
async function sessionUser(req, D) {
  const a = req.headers.get('Authorization') || '';
  if (!a.startsWith('Bearer ')) return null;
  const s = await D.prepare('SELECT user_id FROM sessions WHERE hash = ?1 AND expires > ?2').bind(await sha(a.slice(7).trim()), Date.now()).first();
  return s ? await D.prepare('SELECT * FROM users WHERE id = ?1').bind(s.user_id).first() : null;
}
// the first PROMO_SLOTS accounts (owners excluded) get Pro for PROMO_DAYS.
// A spot is recorded by a hash of the email and kept even if the account is deleted, so a spot is never handed out twice.
// The claim is one conditional insert, so two sign-ups at once cannot both take the last spot.
async function givePromo(D, env, u) {
  if (owners(env).includes(u.email)) return;
  const r = await D.prepare('INSERT OR IGNORE INTO promo_used (h, at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM promo_used) < ?3').bind(await sha('promo:' + u.email), Date.now(), PROMO_SLOTS).run();
  if (r && r.meta ? r.meta.changes : r.changes) await D.prepare('UPDATE users SET promo = 1, pro_until = ?1 WHERE id = ?2').bind(Date.now() + PROMO_DAYS * 864e5, u.id).run();
}
// with email on, a password account gets its free month only once the email is confirmed (stops fake accounts taking the spots)
async function createUser(D, env, email, fields) {
  const r = await D.prepare('INSERT INTO users (email, pw, salt, google_sub, created) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *').bind(email, fields.pw || null, fields.salt || null, fields.google_sub || null, Date.now()).first();
  if (!mailOn(env) || fields.google_sub) await givePromo(D, env, r);
  return await D.prepare('SELECT * FROM users WHERE id = ?1').bind(r.id).first();
}
/* ---------- brakes that hold across all servers (kept in the database) ----------
   per account: 8 wrong passwords in 15 minutes locks sign-in for that account for 15 minutes
   per address: 5 new accounts a day */
async function hit(D, k, windowMs) {
  const now = Date.now();
  await D.prepare('INSERT INTO limits (k, n, first) VALUES (?1, 1, ?2) ON CONFLICT(k) DO UPDATE SET n = CASE WHEN first < ?3 THEN 1 ELSE n + 1 END, first = CASE WHEN first < ?3 THEN ?2 ELSE first END').bind(k, now, now - windowMs).run();
  const r = await D.prepare('SELECT n FROM limits WHERE k = ?1').bind(k).first();
  if (Math.random() < 0.02) await D.prepare('DELETE FROM limits WHERE first < ?1').bind(now - 2 * 864e5).run();
  return r ? r.n : 1;
}
async function count(D, k, windowMs) {
  const r = await D.prepare('SELECT n, first FROM limits WHERE k = ?1').bind(k).first();
  return r && r.first >= Date.now() - windowMs ? r.n : 0;
}
const LOCK_N = 8, LOCK_MS = 15 * 60000, SIGNUPS_PER_DAY = 5;
const WEAK = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop', '11111111', '00000000', 'iloveyou', 'football', 'football1', 'fantasy1', 'abcd1234', 'letmein1', '87654321', 'aaaaaaaa', 'passw0rd', 'welcome1']);
const pwProblem = (pw) => pw.length < 8 || pw.length > 200 ? 'Use a password of at least 8 characters.' : WEAK.has(pw.toLowerCase()) ? 'That password is too easy to guess. Pick another one.' : '';
// stricter brake for password guesses: 10 tries a minute per address, per instance
const AMEM = new Map();
function authTooMany(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'x', now = Date.now(), w = AMEM.get(ip) || { t: now, n: 0 };
  if (now - w.t > 60000) { w.t = now; w.n = 0; }
  w.n++; AMEM.set(ip, w); if (AMEM.size > 5000) AMEM.clear();
  return w.n > 10;
}
async function authRoute(req, env, url) {
  const p = url.pathname, D = await db(env);
  const len = +(req.headers.get('Content-Length') || 0);
  if (len > (p === '/auth/sync' ? 600 * 1024 : 16 * 1024)) return json(req, { error: 'Too much data.' }, 413);
  if (p === '/auth/config' && req.method === 'GET') {
    const c = await D.prepare('SELECT COUNT(*) AS n FROM promo_used').first();
    return json(req, { google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), spots: Math.max(0, PROMO_SLOTS - (c ? c.n : 0)), days: PROMO_DAYS, email: mailOn(env) });
  }
  if ((p === '/auth/signup' || p === '/auth/login') && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    const email = cleanEmail(b.email), pw = String(b.password || '');
    if (!okEmail(email)) return json(req, { error: 'Enter a valid email address.' }, 400);
    if (p === '/auth/signup') {
      const bad = pwProblem(pw); if (bad) return json(req, { error: bad }, 400);
      if (await D.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first()) return json(req, { error: 'That email already has an account. Sign in instead.' }, 409);
      const ipk = 'su:' + await sha((req.headers.get('CF-Connecting-IP') || 'x') + day(Date.now()));
      if (await count(D, ipk, 864e5) >= SIGNUPS_PER_DAY) return json(req, { error: 'Too many new accounts from this connection today. Try again tomorrow.' }, 429);
      await hit(D, ipk, 864e5);
      const salt = hex(rand(16)), u = await createUser(D, env, email, { pw: await hashPw(pw, salt), salt });
      let sent = false;
      if (mailOn(env)) { try { await sendVerify(req, env, D, u, b.app); sent = true; } catch (e) { console.warn('verify mail failed', e.message); } }
      return json(req, { token: await newSession(D, u.id), user: userOut(u, env), welcome: true, verify_sent: sent });
    }
    const lk = 'lf:' + await sha(email);
    if (await count(D, lk, LOCK_MS) >= LOCK_N) return json(req, { error: 'Too many wrong passwords for this account. Wait 15 minutes' + (mailOn(env) ? ', or reset your password.' : '.') }, 429);
    const u = await D.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
    if (!u || !u.pw) { await hit(D, lk, LOCK_MS); if (u && u.google_sub) return json(req, { error: 'This account uses Google. Tap "Continue with Google".' }, 401); await hashPw(pw || 'x', '00'.repeat(16)); return json(req, { error: 'Wrong email or password.' }, 401); }
    if (!same(await hashPw(pw, u.salt), u.pw)) { await hit(D, lk, LOCK_MS); return json(req, { error: 'Wrong email or password.' }, 401); }
    await D.prepare('DELETE FROM limits WHERE k = ?1').bind(lk).run();
    return json(req, { token: await newSession(D, u.id), user: userOut(u, env) });
  }
  if (p === '/auth/forgot' && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    if (!mailOn(env)) return json(req, { error: 'Password reset by email is not available yet. Write to support.' }, 503);
    const b = await req.json().catch(() => ({}));
    const email = cleanEmail(b.email);
    const u = okEmail(email) ? await D.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first() : null;
    if (u) {
      const t = await newToken(D, u.id, 'reset', 30);
      const link = safeReturn(b.app || '') + '#fc_reset=' + t;
      try { await sendMail(env, u.email, 'Reset your Fair Catch password', 'Reset your Fair Catch password (the link works for 30 minutes): ' + link, mailHtml('Reset your password', 'Tap the button to choose a new password. The link works for 30 minutes.', 'Choose a new password', link)); }
      catch (e) { console.warn('reset mail failed', e.message); }
    }
    return json(req, { ok: true });
  }
  if (p === '/auth/reset' && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    const nw = String(b.new || '');
    const bad = pwProblem(nw); if (bad) return json(req, { error: bad }, 400);
    const uid = await useToken(D, b.token, 'reset');
    if (!uid) return json(req, { error: 'This reset link has expired or was already used. Ask for a new one.' }, 400);
    const salt = hex(rand(16));
    await D.prepare('UPDATE users SET pw = ?1, salt = ?2, verified = 1 WHERE id = ?3').bind(await hashPw(nw, salt), salt, uid).run();
    await D.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(uid).run();
    const u = await D.prepare('SELECT * FROM users WHERE id = ?1').bind(uid).first();
    return json(req, { token: await newSession(D, uid), user: userOut(u, env) });
  }
  const u = await sessionUser(req, D);
  if (!u) return json(req, { error: 'Signed out. Sign in again.' }, 401);
  if (p === '/auth/sync' && req.method === 'GET') {
    const r = await D.prepare('SELECT data, updated FROM user_data WHERE user_id = ?1').bind(u.id).first();
    return json(req, r ? { data: r.data, updated: r.updated } : { data: null, updated: 0 });
  }
  if (p === '/auth/sync' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const data = typeof b.data === 'string' ? b.data : '';
    if (!data || data.length > 512 * 1024) return json(req, { error: 'Too much to save.' }, 413);
    try { const o = JSON.parse(data); if (!o || typeof o !== 'object' || Array.isArray(o)) throw 0; } catch { return json(req, { error: 'bad data' }, 400); }
    const now = Date.now();
    await D.prepare('INSERT INTO user_data (user_id, data, updated) VALUES (?1, ?2, ?3) ON CONFLICT(user_id) DO UPDATE SET data = ?2, updated = ?3').bind(u.id, data, now).run();
    return json(req, { ok: true, updated: now });
  }
  if (p === '/auth/verify/send' && req.method === 'POST') {
    if (!mailOn(env)) return json(req, { error: 'Email is not set up yet.' }, 503);
    if (u.verified) return json(req, { ok: true, already: true });
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    try { await sendVerify(req, env, D, u, b.app); } catch (e) { return json(req, { error: 'Could not send the email. Try again later.' }, 502); }
    return json(req, { ok: true });
  }
  if (p === '/auth/me' && req.method === 'GET') { await D.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(Date.now(), u.id).run(); return json(req, { user: userOut(u, env) }); }
  if (p === '/auth/logout' && req.method === 'POST') {
    await D.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha((req.headers.get('Authorization') || '').slice(7).trim())).run();
    return json(req, { ok: true });
  }
  if (p === '/auth/password' && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    const nw = String(b.new || '');
    const bad = pwProblem(nw); if (bad) return json(req, { error: bad }, 400);
    if (u.pw && !same(await hashPw(String(b.old || ''), u.salt), u.pw)) return json(req, { error: 'Your current password is not right.' }, 401);
    const salt = hex(rand(16));
    await D.prepare('UPDATE users SET pw = ?1, salt = ?2 WHERE id = ?3').bind(await hashPw(nw, salt), salt, u.id).run();
    await D.prepare('DELETE FROM sessions WHERE user_id = ?1 AND hash != ?2').bind(u.id, await sha((req.headers.get('Authorization') || '').slice(7).trim())).run();
    return json(req, { ok: true, others_signed_out: true });
  }
  if (p === '/auth/logout_all' && req.method === 'POST') {
    await D.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id).run();
    return json(req, { ok: true });
  }
  if (p === '/auth/delete' && req.method === 'POST') {
    if (u.pw) {
      if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
      const b = await req.json().catch(() => ({}));
      if (!same(await hashPw(String(b.password || ''), u.salt), u.pw)) return json(req, { error: 'Type your password to delete the account.' }, 401);
    }
    await D.batch([D.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id), D.prepare('DELETE FROM user_data WHERE user_id = ?1').bind(u.id), D.prepare('DELETE FROM tokens WHERE user_id = ?1').bind(u.id), D.prepare('DELETE FROM users WHERE id = ?1').bind(u.id)]);
    return json(req, { ok: true });
  }
  return json(req, { error: 'not found' }, 404);
}
/* ---------- stats ---------- */
const ONLINE_MS = 150000;   // a visitor counts as online if the app pinged within the last 2.5 minutes (it pings every minute while open)
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
async function statsRoute(req, env, url) {
  const D = await db(env), now = Date.now();
  if (url.pathname === '/stats/ping' && req.method === 'POST') {
    const b = await req.json().catch(() => ({}));
    const vid = String(b.vid || '');
    if (!/^[A-Za-z0-9_-]{16,48}$/.test(vid)) return json(req, { error: 'bad id' }, 400);
    const u = await sessionUser(req, D);
    await D.batch([
      D.prepare('INSERT INTO visits (vid, first, last, uid, pings) VALUES (?1, ?2, ?2, ?3, 1) ON CONFLICT(vid) DO UPDATE SET last = ?2, uid = COALESCE(?3, uid), pings = pings + 1').bind(vid, now, u ? u.id : null),
      D.prepare('INSERT OR IGNORE INTO visit_days (day, vid) VALUES (?1, ?2)').bind(day(now), vid),
      ...(u ? [D.prepare('UPDATE users SET last_seen = ?1 WHERE id = ?2').bind(now, u.id)] : []),
    ]);
    return json(req, { ok: true });
  }
  if (url.pathname === '/admin/stats' && req.method === 'GET') {
    const u = await sessionUser(req, D);
    if (!u || !owners(env).includes(u.email)) return json(req, { error: 'Owner only. Sign in with the owner account.' }, 403);
    const since = day(now - 29 * 864e5);
    const [users, online, onlineSigned, vToday, v7, vAll, sess, promo, daysV, daysU] = await Promise.all([
      D.prepare('SELECT id, email, created, pro_until, promo, google_sub IS NOT NULL AS google, pw IS NOT NULL AS password, last_seen, verified, (SELECT updated FROM user_data WHERE user_id = users.id) AS synced FROM users ORDER BY created DESC').all(),
      D.prepare('SELECT COUNT(*) AS n FROM visits WHERE last > ?1').bind(now - ONLINE_MS).first(),
      D.prepare('SELECT COUNT(DISTINCT uid) AS n FROM visits WHERE last > ?1 AND uid IS NOT NULL').bind(now - ONLINE_MS).first(),
      D.prepare('SELECT COUNT(*) AS n FROM visit_days WHERE day = ?1').bind(day(now)).first(),
      D.prepare('SELECT COUNT(DISTINCT vid) AS n FROM visit_days WHERE day >= ?1').bind(day(now - 6 * 864e5)).first(),
      D.prepare('SELECT COUNT(*) AS n FROM visits').first(),
      D.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires > ?1').bind(now).first(),
      D.prepare('SELECT COUNT(*) AS n FROM promo_used').first(),
      D.prepare('SELECT day, COUNT(*) AS n FROM visit_days WHERE day >= ?1 GROUP BY day ORDER BY day').bind(since).all(),
      D.prepare("SELECT strftime('%Y-%m-%d', created / 1000, 'unixepoch') AS day, COUNT(*) AS n FROM users WHERE created >= ?1 GROUP BY day ORDER BY day").bind(Date.parse(since)).all(),
    ]);
    const own = owners(env);
    return json(req, {
      now, online_ms: ONLINE_MS,
      online: online.n, online_signed_in: onlineSigned.n,
      visitors_today: vToday.n, visitors_7d: v7.n, visitors_all: vAll.n,
      sessions_active: sess.n, promo_used: promo.n, promo_slots: PROMO_SLOTS,
      users: users.results.map((x) => ({ email: x.email, created: x.created, last_seen: x.last_seen || null, method: x.google ? (x.password ? 'Google + email' : 'Google') : 'Email', promo: !!x.promo, owner: own.includes(x.email), pro: own.includes(x.email) || (x.pro_until || 0) > now, pro_until: x.pro_until || null, verified: !!(x.verified || x.google), synced: x.synced || null })),
      days_visitors: daysV.results, days_signups: daysU.results,
    });
  }
  return json(req, { error: 'not found' }, 404);
}

async function googleRoute(req, env, url) {
  const redirect_uri = url.origin + '/auth/google/callback';
  if (url.pathname === '/auth/google') {
    if (!env.GOOGLE_CLIENT_ID) return new Response('Google sign-in is not set up.', { status: 503 });
    const nonce = crypto.randomUUID();
    const state = b64(JSON.stringify({ r: safeReturn(url.searchParams.get('return') || ''), n: nonce }));
    const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri, response_type: 'code', scope: 'openid email', state, prompt: 'select_account' });
    return new Response(null, { status: 302, headers: { Location: 'https://accounts.google.com/o/oauth2/v2/auth?' + q, 'Set-Cookie': 'fc_g=' + nonce + '; Max-Age=600; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax' } });
  }
  let back = DEFAULT_RETURN, nonce = '';
  try { const st = JSON.parse(atob(url.searchParams.get('state').replace(/-/g, '+').replace(/_/g, '/'))); back = safeReturn(st.r); nonce = String(st.n || ''); } catch {}
  const go = (frag) => new Response(null, { status: 302, headers: { Location: back + '#' + frag, 'Set-Cookie': 'fc_g=; Max-Age=0; Path=/auth/google/callback; HttpOnly; Secure; SameSite=Lax' } });
  const mine = ((req.headers.get('Cookie') || '').match(/(?:^|;\s*)fc_g=([^;]+)/) || [])[1] || '';
  if (!nonce || nonce !== mine) { console.warn('google callback refused: state mismatch'); return go('fc_err=' + encodeURIComponent('Sign-in expired, try again.')); }
  const code = url.searchParams.get('code');
  if (!code) return go('fc_err=' + encodeURIComponent('Google sign-in was cancelled.'));
  try {
    const t = await (await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code, client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, redirect_uri, grant_type: 'authorization_code' }) })).json();
    if (!t.access_token) throw new Error('Google did not sign you in.');
    const info = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
    if (!info.sub || !info.email || info.email_verified === false) throw new Error('Your Google email is not verified.');
    const D = await db(env), email = cleanEmail(info.email);
    let u = await D.prepare('SELECT * FROM users WHERE google_sub = ?1').bind(info.sub).first();
    let welcome = false;
    if (!u) {
      u = await D.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
      if (u) await D.prepare('UPDATE users SET google_sub = ?1 WHERE id = ?2').bind(info.sub, u.id).run();
      else { u = await createUser(D, env, email, { google_sub: info.sub }); welcome = true; }
    }
    return go(new URLSearchParams({ fc_tok: await newSession(D, u.id), ...(welcome ? { fc_new: '1' } : {}) }).toString());
  } catch (e) { return go('fc_err=' + encodeURIComponent(e.message || 'Google sign-in failed.')); }
}

async function token(env, params) {
  const r = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + btoa(env.YAHOO_CLIENT_ID + ':' + env.YAHOO_CLIENT_SECRET) },
    body: new URLSearchParams(params),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || 'Yahoo sign-in failed');
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in || 3600 };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const redirect_uri = url.origin + '/callback';
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });

    if (url.pathname === '/login') {
      // a one-time code is put in the state AND in a short cookie; /callback only continues when both match (stops forged sign-ins)
      const nonce = crypto.randomUUID();
      const state = b64(JSON.stringify({ r: safeReturn(url.searchParams.get('return') || ''), n: nonce }));
      const q = new URLSearchParams({ client_id: env.YAHOO_CLIENT_ID, redirect_uri, response_type: 'code', scope: 'fspt-r', state });   // fspt-r = Fantasy Sports, read only (without it Yahoo answers 403 to every API call)
      return new Response(null, { status: 302, headers: { Location: AUTH + '?' + q, 'Set-Cookie': 'fc_n=' + nonce + '; Max-Age=600; Path=/callback; HttpOnly; Secure; SameSite=Lax' } });
    }

    if (url.pathname === '/callback') {
      let back = DEFAULT_RETURN, nonce = '';
      try { const st = JSON.parse(atob(url.searchParams.get('state').replace(/-/g, '+').replace(/_/g, '/'))); back = safeReturn(st.r); nonce = String(st.n || ''); } catch {}
      const clear = { 'Set-Cookie': 'fc_n=; Max-Age=0; Path=/callback; HttpOnly; Secure; SameSite=Lax' };
      const go = (frag) => new Response(null, { status: 302, headers: { Location: back + '#' + frag, ...clear } });
      const mine = ((req.headers.get('Cookie') || '').match(/(?:^|;\s*)fc_n=([^;]+)/) || [])[1] || '';
      if (!nonce || nonce !== mine) { console.warn('callback refused: state does not match the browser that started the sign-in'); return go('yahoo_error=' + encodeURIComponent('sign-in expired, try again')); }
      const code = url.searchParams.get('code');
      if (!code) return go('yahoo_error=' + encodeURIComponent(url.searchParams.get('error') || 'cancelled'));
      try {
        const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri });
        return go(new URLSearchParams({ yahoo_at: t.access_token, yahoo_rt: t.refresh_token || '', yahoo_exp: String(t.expires_in) }).toString());
      } catch (e) {
        return go('yahoo_error=' + encodeURIComponent(e.message));
      }
    }

    if (url.pathname === '/auth/google' || url.pathname === '/auth/google/callback') return googleRoute(req, env, url);
    if (url.pathname === '/auth/verify' && req.method === 'GET') {
      const back = safeReturn(url.searchParams.get('r') || '');
      try {
        const D = await db(env), uid = await useToken(D, url.searchParams.get('t'), 'verify');
        if (!uid) return Response.redirect(back + '#fc_err=' + encodeURIComponent('That link has expired. Open Account and send a new one.'), 302);
        await D.prepare('UPDATE users SET verified = 1 WHERE id = ?1').bind(uid).run();
        const u = await D.prepare('SELECT * FROM users WHERE id = ?1').bind(uid).first();
        if (u && !u.promo) await givePromo(D, env, u);
        return Response.redirect(back + '#fc_verified=1', 302);
      } catch (e) { return Response.redirect(back + '#fc_err=' + encodeURIComponent('Could not confirm right now. Try the link again.'), 302); }
    }

    if ((url.pathname === '/refresh' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/stats/') || url.pathname.startsWith('/admin/')) && !fromApp(req)) { console.warn('blocked: origin not allowed', req.headers.get('Origin') || 'none'); return json(req, { error: 'not allowed' }, 403); }
    if (await tooMany(req, env)) { console.warn('rate limited'); return json(req, { error: 'too many requests, try again in a minute' }, 429); }


    if (url.pathname.startsWith('/stats/') || url.pathname.startsWith('/admin/')) {
      try { return await statsRoute(req, env, url); }
      catch (e) { console.warn('stats error', e && e.message); return json(req, { error: e.status ? e.message : 'Something went wrong.' }, e.status || 500); }
    }
    if (url.pathname.startsWith('/auth/')) {
      try { return await authRoute(req, env, url); }
      catch (e) { console.warn('auth error', e && e.message); return json(req, { error: e.status ? e.message : 'Something went wrong. Try again.' }, e.status || 500); }
    }

    if (url.pathname === '/refresh' && req.method === 'POST') {
      const { refresh_token } = await req.json().catch(() => ({}));
      if (!refresh_token) return json(req, { error: 'missing refresh_token' }, 400);
      try { return json(req, await token(env, { grant_type: 'refresh_token', refresh_token, redirect_uri })); }
      catch (e) { return json(req, { error: e.message }, 401); }
    }

    if (url.pathname.startsWith('/api/') && req.method === 'GET') {
      const auth = req.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return json(req, { error: 'not signed in' }, 401);
      const path = url.pathname.slice(5) + url.search;
      if (/\.\.|^\/|:\/\//.test(path) || !/^(users;use_login=1|league\/|team\/)/.test(path)) return json(req, { error: 'bad path' }, 400);
      const target = FANTASY + path + (url.search ? '&' : '?') + 'format=json';
      const r = await fetch(target, { headers: { Authorization: auth } });
      return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
    }

    return new Response('Fair Catch Yahoo helper is running.', { headers: { 'Content-Type': 'text/plain' } });
  },
};
