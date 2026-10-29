"""Fair Catch weekly expert buy/sell update: validates market.json and puts it into the published page.
usage: python3 -I market.py PAGE.html MARKET.json OUT.html
MARKET.json = {"week":N,"updated":"YYYY-MM-DD","sources":[{"k","site","title","author","date","url"}...],
               "players":[["Player Name",[["sourceKey","BL|BH|B|SH|SL|S|H"],...],"short reason in your own words"],...]}"""
import json, re, sys
page_p, m_p, out_p = sys.argv[1:4]
html = open(page_p, encoding="utf-8").read()
def block(n):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % n, html, re.S)
    if not m: sys.exit("page has no %s block" % n)
    return m
def put(h, n, obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return re.sub(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % n, lambda m: m.group(1) + s + m.group(3), h, count=1, flags=re.S)
def norm(n):
    n = n.lower().replace("’", "'"); n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n); return re.sub(r"[^a-z]", "", n)
m = json.load(open(m_p, encoding="utf-8"))
data = json.loads(block("data").group(1)); block("marketdata")
known = {norm(p["n"]): p["n"] for p in data["players"]}
srcs = [s for s in m.get("sources", []) if all(s.get(k) for k in ("k", "site", "title", "date", "url"))]
keys = {s["k"] for s in srcs}
if len(srcs) < 4: sys.exit("need at least 4 sources, got %d" % len(srcs))
OK = {"BL", "BH", "B", "SH", "SL", "S", "H"}
players, dropped = [], []
for row in m.get("players", []):
    if not (isinstance(row, list) and len(row) == 3): continue
    n, calls, why = row
    k = norm(n)
    if k not in known: dropped.append(n); continue
    calls = [[c[0], c[1]] for c in calls if isinstance(c, list) and len(c) == 2 and c[0] in keys and c[1] in OK]
    if not calls: dropped.append(n); continue
    why = re.sub(r"\s+", " ", str(why)).strip()[:220]
    players.append([known[k], calls, why])
if len(players) < 20: sys.exit("only %d usable players, not publishing" % len(players))
out = put(html, "marketdata", dict(week=m.get("week"), updated=m.get("updated"), sources=srcs, players=players))
open(out_p, "w", encoding="utf-8").write(out)
print("market: %d players from %d sources (week %s); dropped: %s" % (len(players), len(srcs), m.get("week"), dropped))
