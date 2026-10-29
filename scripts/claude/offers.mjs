// Fair Catch trade-offer check: merges the offers found in the browser into the page and writes the alert text.
// usage: node offers.mjs page.html found.json out.html report.json
// found.json: {"leagues":{"<league id>":{"ok":true|false,"note":"...","offers":[{"id","from","get":[names],"give":[names],"picksGet":[],"picksGive":[],"created"}]}}}
import fs from 'fs';
import { chromium } from 'playwright';
const [pagePath, foundPath, outPath, reportPath] = process.argv.slice(2);
let html = fs.readFileSync(pagePath, 'utf8');
const found = JSON.parse(fs.readFileSync(foundPath, 'utf8'));
const RX = n => new RegExp(`(<script type="application/json" id="${n}">)([\\s\\S]*?)(</script>)`);
const blk = n => { const m = html.match(RX(n)); return m ? m[2] : null; };
const leagues = JSON.parse(blk('leaguedata').replace(/<\\\//g, '</'));
const lgIds = (Array.isArray(leagues) ? leagues : [leagues]).map(l => String(l.id));
let prev = { offers: [], notified: [] };
const pb = blk('offerdata');
if (pb == null) { console.error('page has no offerdata block: the app code is older than the offer feature'); process.exit(2); }
try { const o = JSON.parse(pb.replace(/<\\\//g, '</')); if (o && Array.isArray(o.offers)) prev = { notified: [], ...o }; } catch (e) {}
const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jerusalem' }).slice(0, 16);
const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const offers = [], notes = [];
for (const id of lgIds) {
  const f = found.leagues && found.leagues[id];
  if (f && f.ok) {
    for (const o of f.offers || []) {
      const oid = String(o.id || [id, o.from, ...(o.get || []), '|', ...(o.give || [])].map(norm).join('-'));
      offers.push({ ...o, lg: id, id: oid });
    }
    notes.push(`${id}: ${(f.offers || []).length} pending`);
  } else {
    prev.offers.filter(o => String(o.lg) === id).forEach(o => offers.push(o)); // could not check: keep what we knew
    notes.push(`${id}: not checked (${f ? f.note || 'error' : 'missing'})`);
  }
}
const seen = new Set(prev.notified || []);
const fresh = offers.filter(o => !seen.has(o.id));
const notified = [...(prev.notified || []), ...fresh.map(o => o.id)].slice(-300);
const key = l => JSON.stringify(l.map(o => o.id).sort());
const ageH = prev.checked ? (Date.parse(now.replace(' ', 'T') + ':00Z') - Date.parse(String(prev.checked).replace(' ', 'T') + ':00Z')) / 36e5 : 999;
const publish = key(offers) !== key(prev.offers || []) || fresh.length > 0 || !(ageH < 20);
const data = { checked: now, offers, notified };
html = html.replace(RX('offerdata'), (m, a, b, c) => a + JSON.stringify(data).replace(/<\//g, '<\\/') + c);
fs.writeFileSync(outPath, html);
// analyze the new offers with the page's own code
let browser, lastErr;
const cands = [undefined, ...(fs.existsSync('/opt/pw-browsers') ? fs.readdirSync('/opt/pw-browsers').map(d => `/opt/pw-browsers/${d}/chrome-linux/headless_shell`) : []), '/opt/pw-browsers/chromium']
  .filter(f => f === undefined || (() => { try { return fs.statSync(f).isFile(); } catch (e) { return false; } })());
for (const exe of cands) {
  try { browser = await chromium.launch(exe ? { executablePath: exe, ...(exe.endsWith('/chromium') ? { args: ['--headless=new'] } : {}) } : {}); break; }
  catch (e) { lastErr = e; }
}
if (!browser) throw lastErr;
const page = await browser.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.route(/^https?:\/\//, r => r.abort());
await page.goto('file://' + fs.realpathSync(outPath), { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.FC && window.FC.analyzeOffer, null, { timeout: 15000 });
const texts = [];
for (const o of fresh) {
  const t = await page.evaluate(o => { const x = window.FC.analyzeOffer(o); return { ok: x.ok, verdict: x.verdict ? x.verdict.t : '', from: x.from, league: x.league, text: window.FC.offerText(x) }; }, o);
  texts.push(t);
}
await browser.close();
const report = { checked: now, publish, pending: offers.length, fresh: texts, notes, pageErrors: errs };
fs.writeFileSync(reportPath, JSON.stringify(report, null, 1));
console.log(`${publish ? 'PUBLISH' : 'NO-PUBLISH (nothing changed)'} · checked ${now} · ${offers.length} pending · ${texts.length} new · ${notes.join(' · ')}${errs.length ? ' · PAGE ERRORS: ' + errs.join(' | ') : ''}`);
for (const t of texts) console.log('\n' + t.text);
