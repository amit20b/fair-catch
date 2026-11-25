/* fair-catch-push: phone notifications for the Fair Catch app.
   A separate small server, so the main account server (fair-catch-yahoo) is never touched by it.

   Routes (called from the app, the session token from the main server in "Authorization: Bearer"):
     GET  /push/key          the public key the phone needs to subscribe
     POST /push/subscribe    { sub }  save this phone for the signed-in user
     POST /push/unsubscribe  { endpoint }
     POST /push/test         send a test notification to the signed-in user's phones
   Every hour (cron):
     - a player on your Scouting list moved 10% or more in value this week
     - a trade went through in one of your Sleeper leagues
   It reads the same database as the main server: the sessions table to know who is signed in, and user_data
   (the settings the app syncs) to know each user's Scouting list and leagues. Its own tables start with push_. */

const SITE = 'https://amit20b.github.io/fair-catch/';
const APP_ORIGINS = ['https://amit20b.github.io', 'https://faircatchapp.com', 'https://www.faircatchapp.com', 'https://faircatch.app'];
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const sha = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let i = 0; for (const x of a) { o.set(x, i); i += x.length; } return o; };

const cors = (req) => { const o = req.headers.get('Origin') || ''; return APP_ORIGINS.includes(o) ? { 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Vary': 'Origin' } : {}; };
const json = (req, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors(req) } });

async function tables(D) {
  await D.batch([
    D.prepare('CREATE TABLE IF NOT EXISTS push_keys (id INTEGER PRIMARY KEY, pub TEXT NOT NULL, priv TEXT NOT NULL)'),
    D.prepare('CREATE TABLE IF NOT EXISTS push_subs (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL)'),
    D.prepare('CREATE TABLE IF NOT EXISTS push_sent (user_id INTEGER NOT NULL, k TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user_id, k))'),
  ]);
}
// the signing keys are made once, on this server, and the private one never leaves the database
async function vapid(D) {
  const row = await D.prepare('SELECT pub, priv FROM push_keys WHERE id = 1').first();
  if (row) return { pub: row.pub, priv: await crypto.subtle.importKey('jwk', JSON.parse(row.priv), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']) };
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const pub = b64u(await crypto.subtle.exportKey('raw', kp.publicKey)), priv = JSON.stringify(await crypto.subtle.exportKey('jwk', kp.privateKey));
  await D.prepare('INSERT OR IGNORE INTO push_keys (id, pub, priv) VALUES (1, ?1, ?2)').bind(pub, priv).run();
  return vapid(D);
}
async function userOf(req, D) {
  const a = req.headers.get('Authorization') || ''; if (!a.startsWith('Bearer ')) return null;
  const s = await D.prepare('SELECT user_id FROM sessions WHERE hash = ?1 AND expires > ?2').bind(await sha(a.slice(7).trim()), Date.now()).first();
  return s ? s.user_id : null;
}

/* ---------- sending: RFC 8291 encryption (aes128gcm) and RFC 8292 VAPID ---------- */
async function hmac(key, data) { const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return new Uint8Array(await crypto.subtle.sign('HMAC', k, data)); }
async function encrypt(sub, payload) {
  const uaPub = unb64u(sub.p256dh), auth = unb64u(sub.auth);
  const eph = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', eph.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, eph.privateKey, 256));
  const prkKey = await hmac(auth, secret);
  const ikm = (await hmac(prkKey, cat(enc.encode('WebPush: info\0'), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, cat(enc.encode('Content-Encoding: aes128gcm\0'), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, cat(enc.encode('Content-Encoding: nonce\0'), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, key, cat(enc.encode(payload), new Uint8Array([2]))));
  const rs = new Uint8Array([0, 0, 16, 0]);
  return cat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
async function jwt(aud, priv) {
  const h = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const c = b64u(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(h + '.' + c));
  return h + '.' + c + '.' + b64u(sig);
}
async function send(D, keys, sub, msg) {
  const body = await encrypt(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, { method: 'POST', headers: { 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', TTL: '86400', Urgency: 'normal', Authorization: `vapid t=${await jwt(new URL(sub.endpoint).origin, keys.priv)}, k=${keys.pub}` }, body });
  if (r.status === 404 || r.status === 410) await D.prepare('DELETE FROM push_subs WHERE endpoint = ?1').bind(sub.endpoint).run();
  return r.status;
}
async function sendUser(D, keys, uid, msg) {
  const subs = (await D.prepare('SELECT endpoint, p256dh, auth FROM push_subs WHERE user_id = ?1').bind(uid).all()).results || [];
  let ok = 0; for (const s of subs) { try { const st = await send(D, keys, s, msg); if (st >= 200 && st < 300) ok++; } catch (e) {} }
  return ok;
}

/* ---------- the hourly check ---------- */
async function once(D, uid, k) {
  const r = await D.prepare('INSERT OR IGNORE INTO push_sent (user_id, k, at) VALUES (?1, ?2, ?3)').bind(uid, k, Date.now()).run();
  return !!(r.meta && r.meta.changes);
}
const sj = (path) => fetch('https://api.sleeper.app/v1' + path).then((r) => (r.ok ? r.json() : null)).catch(() => null);
async function hourly(env) {
  const D = env.DB; await tables(D); const keys = await vapid(D);
  const users = ((await D.prepare('SELECT DISTINCT user_id FROM push_subs').all()).results || []).map((r) => r.user_id);
  if (!users.length) return;
  const hist = await fetch(SITE + 'history.json', { cf: { cacheTtl: 600 } }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const state = await sj('/state/nfl'), week = Math.max(1, +((state && (state.week || state.display_week)) || 1));
  const txCache = {};
  await D.prepare('DELETE FROM push_sent WHERE at < ?1').bind(Date.now() - 60 * 864e5).run();
  for (const uid of users) {
    const row = await D.prepare('SELECT data FROM user_data WHERE user_id = ?1').bind(uid).first();
    let data = {}; try { data = row ? JSON.parse(row.data) : {}; } catch (e) {}
    const get = (k) => { try { return JSON.parse(data[k] || 'null'); } catch (e) { return null; } };
    const msgs = [];
    // 1. scouting: big moves in value this week
    const scout = get('faircatch-scout') || [], st = (get('faircatch-v4') || {}).S || {};
    if (hist && hist.p && scout.length) {
      const col = st.mode === 'redraft' || !st.mode ? (st.qb === 'sf' ? 1 : 0) : (st.qb === 'sf' ? 3 : 2), D0 = hist.dates || [], n = D0.length;
      const cut = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10), i0 = D0.findIndex((d) => d >= cut);
      for (const name of scout.slice(0, 30)) {
        const p = hist.p[name]; if (!p || n < 2 || i0 < 0) continue;
        const a = (p[i0] || [])[col], b = (p[n - 1] || [])[col]; if (!a || !b) continue;
        const pct = (b - a) / a; if (Math.abs(pct) < 0.1) continue;
        const k = `scout|${name}|${pct < 0 ? 'dn' : 'up'}|${D0[n - 1].slice(0, 7)}-${Math.floor(+D0[n - 1].slice(8) / 7)}`;
        if (await once(D, uid, k)) msgs.push(pct < 0
          ? { title: `${name} is ${Math.round(-pct * 100)}% cheaper this week`, body: 'A player on your Scouting list dropped in value. Could be the moment to make an offer.', url: SITE + '#scout' }
          : { title: `${name} is up ${Math.round(pct * 100)}% this week`, body: 'A player on your Scouting list is getting pricier. If you want him, move soon.', url: SITE + '#scout' });
      }
    }
    // 2. a new trade in one of your Sleeper leagues
    const conn = get('faircatch-connected') || [];
    for (const l of (Array.isArray(conn) ? conn : []).filter((x) => x && x.id && (!x.platform || x.platform === 'Sleeper')).slice(0, 4)) {
      const key = l.id + '|' + week;
      if (!(key in txCache)) txCache[key] = await sj(`/league/${encodeURIComponent(l.id)}/transactions/${week}`);
      for (const t of (txCache[key] || []).filter((x) => x.type === 'trade' && x.status === 'complete' && Date.now() - (+x.status_updated || 0) < 3 * 3600e3)) {
        if (await once(D, uid, 'trade|' + t.transaction_id)) msgs.push({ title: `A trade just went through in ${l.name || 'your league'}`, body: 'See who won it in Trade grades.', url: SITE + '#grades' });
      }
    }
    for (const m of msgs.slice(0, 3)) await sendUser(D, keys, uid, m);
  }
}

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
    const url = new URL(req.url), p = url.pathname, D = env.DB;
    try {
      await tables(D);
      if (p === '/push/key' && req.method === 'GET') return json(req, { key: (await vapid(D)).pub });
      const uid = await userOf(req, D);
      if (!uid) return json(req, { error: 'Please sign in first.' }, 401);
      const body = req.method === 'POST' ? await req.json().catch(() => ({})) : {};
      if (p === '/push/subscribe' && req.method === 'POST') {
        const s = body.sub || {}, k = s.keys || {};
        if (!/^https:\/\//.test(s.endpoint || '') || !k.p256dh || !k.auth || s.endpoint.length > 1000) return json(req, { error: 'Bad subscription.' }, 400);
        await D.prepare('INSERT OR REPLACE INTO push_subs (endpoint, user_id, p256dh, auth, created) VALUES (?1, ?2, ?3, ?4, ?5)').bind(s.endpoint, uid, k.p256dh, k.auth, Date.now()).run();
        const n = (await D.prepare('SELECT COUNT(*) AS n FROM push_subs WHERE user_id = ?1').bind(uid).first()).n;
        if (n > 5) await D.prepare('DELETE FROM push_subs WHERE user_id = ?1 AND endpoint IN (SELECT endpoint FROM push_subs WHERE user_id = ?1 ORDER BY created LIMIT ?2)').bind(uid, n - 5).run();
        return json(req, { ok: true });
      }
      if (p === '/push/unsubscribe' && req.method === 'POST') {
        await D.prepare('DELETE FROM push_subs WHERE endpoint = ?1 AND user_id = ?2').bind(String(body.endpoint || ''), uid).run();
        return json(req, { ok: true });
      }
      if (p === '/push/test' && req.method === 'POST') {
        const n = await sendUser(D, await vapid(D), uid, { title: 'Alerts are on', body: "You'll hear from Fair Catch when a player you scout moves, or a trade happens in your league.", url: SITE });
        return json(req, { ok: n > 0, sent: n });
      }
      return json(req, { error: 'Not found' }, 404);
    } catch (e) { return json(req, { error: 'Server error' }, 500); }
  },
  async scheduled(ev, env, ctx) { ctx.waitUntil(hourly(env)); },
};
