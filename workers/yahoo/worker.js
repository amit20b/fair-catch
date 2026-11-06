/* Fair Catch: accounts, Yahoo Fantasy sign-in and read-only proxy (Cloudflare Worker).
   Settings in Cloudflare (Settings > Variables and Secrets):
     YAHOO_CLIENT_ID      text
     YAHOO_CLIENT_SECRET  secret (type it there yourself; it never goes in this file)
     GOOGLE_CLIENT_ID     text    (optional: turns on "Continue with Google")
     GOOGLE_CLIENT_SECRET secret  (optional, type it there yourself)
     OWNER_EMAILS         text    (optional: comma separated; always Pro, never use a free-month spot)
   Bindings (Settings > Bindings):
     DB                   a D1 database (accounts). Tables are created on first use.
   Account routes (JSON, called from the app; the session token goes in "Authorization: Bearer"):
     GET  /auth/config               {google, spots}  spots = free Pro months left for new sign-ups
     POST /auth/signup {email,password}  ->  {token, user}
     POST /auth/login  {email,password}  ->  {token, user}
     GET  /auth/me                   ->  {user}
     POST /auth/logout
     POST /auth/password {old,new}
     POST /auth/delete               deletes the account and its sessions
     GET  /auth/google?return=<app url>   Google sign-in; comes back to the app with #fc_tok=<token>
   Yahoo routes:
     GET  /login?return=<app url>   sends the user to Yahoo's own sign-in page
     GET  /callback                 Yahoo sends the user back here; we swap the code for tokens
                                    and return to the app with them in the #fragment (never sent to a server)
     POST /refresh  {refresh_token} a fresh access token
     GET  /api/<fantasy path>       read-only Yahoo Fantasy API, e.g. /api/users;use_login=1/games;game_keys=nfl/leagues
*/
const APP_ORIGINS = ['https://amit20b.github.io', 'http://localhost:8000'];
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
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...cors(req) } });
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
    ]);
    READY = true;
  }
  return env.DB;
}
const userOut = (u, env) => {
  const own = owners(env).includes(u.email);
  return { email: u.email, created: u.created, pro_until: own ? 4102444800000 : (u.pro_until || 0), promo: !!u.promo, owner: own, google: !!u.google_sub, password: !!u.pw };
};
async function newSession(D, uid) {
  const tok = b64u(rand(32)), now = Date.now();
  await D.prepare('INSERT INTO sessions (hash, user_id, created, expires) VALUES (?1, ?2, ?3, ?4)').bind(await sha(tok), uid, now, now + SESSION_DAYS * 864e5).run();
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
async function createUser(D, env, email, fields) {
  const r = await D.prepare('INSERT INTO users (email, pw, salt, google_sub, created) VALUES (?1, ?2, ?3, ?4, ?5) RETURNING *').bind(email, fields.pw || null, fields.salt || null, fields.google_sub || null, Date.now()).first();
  await givePromo(D, env, r);
  return await D.prepare('SELECT * FROM users WHERE id = ?1').bind(r.id).first();
}
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
  if (p === '/auth/config' && req.method === 'GET') {
    const c = await D.prepare('SELECT COUNT(*) AS n FROM promo_used').first();
    return json(req, { google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET), spots: Math.max(0, PROMO_SLOTS - (c ? c.n : 0)), days: PROMO_DAYS });
  }
  if ((p === '/auth/signup' || p === '/auth/login') && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    const email = cleanEmail(b.email), pw = String(b.password || '');
    if (!okEmail(email)) return json(req, { error: 'Enter a valid email address.' }, 400);
    if (p === '/auth/signup') {
      if (pw.length < 8 || pw.length > 200) return json(req, { error: 'Use a password of at least 8 characters.' }, 400);
      if (await D.prepare('SELECT id FROM users WHERE email = ?1').bind(email).first()) return json(req, { error: 'That email already has an account. Sign in instead.' }, 409);
      const salt = hex(rand(16)), u = await createUser(D, env, email, { pw: await hashPw(pw, salt), salt });
      return json(req, { token: await newSession(D, u.id), user: userOut(u, env), welcome: true });
    }
    const u = await D.prepare('SELECT * FROM users WHERE email = ?1').bind(email).first();
    if (!u || !u.pw) { if (u && u.google_sub) return json(req, { error: 'This account uses Google. Tap "Continue with Google".' }, 401); await hashPw(pw || 'x', '00'.repeat(16)); return json(req, { error: 'Wrong email or password.' }, 401); }
    if (!same(await hashPw(pw, u.salt), u.pw)) return json(req, { error: 'Wrong email or password.' }, 401);
    return json(req, { token: await newSession(D, u.id), user: userOut(u, env) });
  }
  const u = await sessionUser(req, D);
  if (!u) return json(req, { error: 'Signed out. Sign in again.' }, 401);
  if (p === '/auth/me' && req.method === 'GET') return json(req, { user: userOut(u, env) });
  if (p === '/auth/logout' && req.method === 'POST') {
    await D.prepare('DELETE FROM sessions WHERE hash = ?1').bind(await sha((req.headers.get('Authorization') || '').slice(7).trim())).run();
    return json(req, { ok: true });
  }
  if (p === '/auth/password' && req.method === 'POST') {
    if (authTooMany(req)) return json(req, { error: 'Too many tries. Wait a minute and try again.' }, 429);
    const b = await req.json().catch(() => ({}));
    const nw = String(b.new || '');
    if (nw.length < 8 || nw.length > 200) return json(req, { error: 'Use a new password of at least 8 characters.' }, 400);
    if (u.pw && !same(await hashPw(String(b.old || ''), u.salt), u.pw)) return json(req, { error: 'Your current password is not right.' }, 401);
    const salt = hex(rand(16));
    await D.prepare('UPDATE users SET pw = ?1, salt = ?2 WHERE id = ?3').bind(await hashPw(nw, salt), salt, u.id).run();
    return json(req, { ok: true });
  }
  if (p === '/auth/delete' && req.method === 'POST') {
    await D.batch([D.prepare('DELETE FROM sessions WHERE user_id = ?1').bind(u.id), D.prepare('DELETE FROM users WHERE id = ?1').bind(u.id)]);
    return json(req, { ok: true });
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

    if ((url.pathname === '/refresh' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) && !fromApp(req)) { console.warn('blocked: origin not allowed', req.headers.get('Origin') || 'none'); return json(req, { error: 'not allowed' }, 403); }
    if (await tooMany(req, env)) { console.warn('rate limited'); return json(req, { error: 'too many requests, try again in a minute' }, 429); }


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
