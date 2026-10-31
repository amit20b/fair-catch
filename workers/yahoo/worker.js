/* Fair Catch: Yahoo Fantasy sign-in and read-only proxy (Cloudflare Worker).
   Settings in Cloudflare (Settings > Variables and Secrets):
     YAHOO_CLIENT_ID      text
     YAHOO_CLIENT_SECRET  secret (type it there yourself; it never goes in this file)
   Routes:
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
      const state = b64(JSON.stringify({ r: safeReturn(url.searchParams.get('return') || ''), n: crypto.randomUUID() }));
      const q = new URLSearchParams({ client_id: env.YAHOO_CLIENT_ID, redirect_uri, response_type: 'code', state });
      return Response.redirect(AUTH + '?' + q, 302);
    }

    if (url.pathname === '/callback') {
      let back = DEFAULT_RETURN;
      try { back = safeReturn(JSON.parse(atob(url.searchParams.get('state').replace(/-/g, '+').replace(/_/g, '/'))).r); } catch {}
      const code = url.searchParams.get('code');
      if (!code) return Response.redirect(back + '#yahoo_error=' + encodeURIComponent(url.searchParams.get('error') || 'cancelled'), 302);
      try {
        const t = await token(env, { grant_type: 'authorization_code', code, redirect_uri });
        const frag = new URLSearchParams({ yahoo_at: t.access_token, yahoo_rt: t.refresh_token || '', yahoo_exp: String(t.expires_in) });
        return Response.redirect(back + '#' + frag, 302);
      } catch (e) {
        return Response.redirect(back + '#yahoo_error=' + encodeURIComponent(e.message), 302);
      }
    }

    if ((url.pathname === '/refresh' || url.pathname.startsWith('/api/')) && !fromApp(req)) return json(req, { error: 'not allowed' }, 403);
    if (await tooMany(req, env)) return json(req, { error: 'too many requests, try again in a minute' }, 429);

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
