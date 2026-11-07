"""Safety check before the new page goes live: the data blocks must be valid JSON and the app script must exist.
  python scripts/check.py <page.html> <out.js> [<live page.html>]     (then: node --check <out.js>)
It also checks the values: no player far above his market price, nothing above 10,000, and (given the live page)
no top-50 player jumping 25+ places in one run without the market moving. Any of these stops the run.
"""
import json, re, sys

h = open(sys.argv[1], encoding="utf-8").read()
for name in ("data", "leaguedata", "statsdata", "marketdata", "offerdata"):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % name, h, re.S)
    if not m:
        sys.exit("missing data block: " + name)
    json.loads(m.group(1).replace("<\\/", "</"))
scripts = re.findall(r"<script>(.*?)</script>", h, re.S)
if not scripts or len(scripts[-1]) < 50000:
    sys.exit("app script missing or too short")
m = re.search(r'<meta http-equiv="Content-Security-Policy" content="[^"]*\'sha256-([^\']+)\'', h)
if m:
    import hashlib, base64
    if base64.b64encode(hashlib.sha256(scripts[-1].encode("utf-8")).digest()).decode() != m.group(1):
        sys.exit("security policy does not match the app script (rebuild the page)")
# ---------- value sanity: a broken value never goes live ----------
def block(html, name):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % name, html, re.S)
    return json.loads(m.group(1).replace("<\\/", "</"))
players = [p for p in block(h, "data")["players"] if p.get("p") in ("QB", "RB", "WR", "TE") and not p.get("out")]
problems = []
if len(players) < 250: problems.append("only %d players" % len(players))
for key, mkt in (("r1", "f1"), ("r2", "f2"), ("d2", "m")):
    vals = [p for p in players if p.get(key, 0) > 0]
    if not vals: continue
    top = max(p[key] for p in vals)
    if top > 10050: problems.append("%s above 10,000 (%d)" % (key, top))
    # every top-40 player must sit near his market price: more than 2.2 times it plus 600 means the math broke
    for p in sorted(vals, key=lambda p: -p[key])[:40]:
        m = p.get(mkt) or 0
        if m and p[key] > 2.2 * m + 600: problems.append("%s %s is %d but its market price is %d" % (key, p["n"], p[key], m))
# compare with the page that is live now: a big jump in rank needs a big move in the market
if len(sys.argv) > 3:
    try:
        old = {p["id"]: p for p in block(open(sys.argv[3], encoding="utf-8").read(), "data")["players"]}
        rank = lambda ps, k: {p["id"]: i for i, p in enumerate(sorted(ps, key=lambda p: -p.get(k, 0)))}
        rn, ro = rank(players, "r1"), rank([p for p in old.values() if p.get("p") in ("QB", "RB", "WR", "TE") and not p.get("out")], "r1")
        for p in players:
            o = old.get(p["id"])
            if not o or p["id"] not in ro or rn[p["id"]] > 50: continue
            jump = ro[p["id"]] - rn[p["id"]]
            mk = (p.get("f1") or 1) / max(o.get("f1") or 1, 1)
            if jump > 25 and mk < 1.25: problems.append("r1 %s jumped %d places (#%d to #%d) without the market moving" % (p["n"], jump, ro[p["id"]] + 1, rn[p["id"]] + 1))
        if len(players) < 0.9 * len(ro): problems.append("lost more than 10%% of players (%d to %d)" % (len(ro), len(players)))
    except FileNotFoundError:
        pass
if problems:
    sys.exit("values look wrong, nothing published:\n- " + "\n- ".join(problems[:20]))
open(sys.argv[2], "w", encoding="utf-8").write(scripts[-1])
print("page ok: %d KB" % (len(h) // 1024))
