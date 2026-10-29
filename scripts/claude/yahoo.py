"""Fair Catch Yahoo refresh: puts fresh Yahoo rosters and standings into the published page.
usage: python3 -I yahoo.py PAGE.html YAHOO.json OUT.html
YAHOO.json = the JSON string returned by the browser snippet in README_yahoo.txt"""
import json, re, sys, datetime
page_p, y_p, out_p = sys.argv[1:4]
html = open(page_p, encoding="utf-8").read()
def block(n): return re.search(r'<script type="application/json" id="%s">(.*?)</script>' % n, html, re.S)
def put(h, n, obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return re.sub(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % n, lambda m: m.group(1) + s + m.group(3), h, count=1, flags=re.S)
def norm(n):
    n = n.lower().replace("’", "'"); n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n); return re.sub(r"[^a-z]", "", n)
def log_moves(lg, changes, stamp):
    """keep a short history of roster moves: adds, drops, and trades (a player who left one team and joined another in the same sync)"""
    left = {}
    for t, add, drop in changes:
        for n in drop: left[n] = t
    moves = lg.get("moves") or []
    for t, add, drop in changes:
        if not add and not drop: continue
        moves.append({"t": stamp, "rid": t["rid"], "team": t["name"],
                      "add": [[n, left[n]["name"]] if n in left and left[n] is not t else [n, ""] for n in add], "drop": drop})
    lg["moves"] = moves[-80:]
NICK = {"Cardinals":"Arizona Cardinals","Falcons":"Atlanta Falcons","Ravens":"Baltimore Ravens","Bills":"Buffalo Bills","Panthers":"Carolina Panthers","Bears":"Chicago Bears","Bengals":"Cincinnati Bengals","Browns":"Cleveland Browns","Cowboys":"Dallas Cowboys","Broncos":"Denver Broncos","Lions":"Detroit Lions","Packers":"Green Bay Packers","Texans":"Houston Texans","Colts":"Indianapolis Colts","Jaguars":"Jacksonville Jaguars","Chiefs":"Kansas City Chiefs","Raiders":"Las Vegas Raiders","Chargers":"Los Angeles Chargers","Rams":"Los Angeles Rams","Dolphins":"Miami Dolphins","Vikings":"Minnesota Vikings","Patriots":"New England Patriots","Saints":"New Orleans Saints","Giants":"New York Giants","Jets":"New York Jets","Eagles":"Philadelphia Eagles","Steelers":"Pittsburgh Steelers","49ers":"San Francisco 49ers","Seahawks":"Seattle Seahawks","Buccaneers":"Tampa Bay Buccaneers","Titans":"Tennessee Titans","Commanders":"Washington Commanders"}
CITY = {}
for full in NICK.values():
    c = full.rsplit(" ", 1)[0]; CITY.setdefault(c, []).append(full)  # "Los Angeles" -> Rams and Chargers
def defense(n, before):
    """Yahoo sometimes names a defense by city ("Denver"); two-team cities keep whichever one the team had"""
    opts = CITY.get(n)
    if not opts: return n
    if len(opts) == 1: return opts[0]
    had = [o for o in opts if o in before]
    return had[0] if had else n
JUNK = {"video forecast", "player note", "new player note", "no new player notes"}
raw = open(y_p, encoding="utf-8").read().strip()
y = json.loads(raw)
if isinstance(y, str): y = json.loads(y)
leagues = json.loads(block("leaguedata").group(1)); data = json.loads(block("data").group(1))
known = {norm(p["n"]): p["n"] for p in data["players"]}
lg = next(l for l in leagues if l.get("platform") == "Yahoo")
teams = {t["rid"]: t for t in lg["teams"]}
if len(y.get("teams", [])) != len(teams): sys.exit("expected %d Yahoo teams, got %d" % (len(teams), len(y.get("teams", []))))
report = []; changes = []
for yt in y["teams"]:
    t = teams.get(yt["rid"])
    if not t: sys.exit("unknown Yahoo team %s" % yt["rid"])
    names = []
    for n in yt["names"]:
        if n.strip().lower() in JUNK: continue
        n = NICK.get(n, n); n = defense(n, t["p"]); names.append(known.get(norm(n), n))
    if len(names) < 10: sys.exit("Yahoo team %s looks incomplete (%d players)" % (yt["rid"], len(names)))
    add = [n for n in names if n not in t["p"]]; drop = [n for n in t["p"] if n not in names]
    if add or drop: report.append("%s: +%s -%s" % (t["name"], add, drop))
    changes.append((t, add, drop))
    t["p"] = names
    m = re.search(r"(\d+)(st|nd|rd|th) Place", yt.get("rank", "")); 
    if m: t["place"] = str(int(m.group(1))) + m.group(2)
    tt = re.match(r".*? - (.*) \| Fantasy Football", yt.get("tt", ""))
    if tt and tt.group(1).strip() and not re.fullmatch(r"\d+-\d+(-\d+)?", tt.group(1).strip()): t["name"] = tt.group(1).strip()
me = teams.get(lg.get("me"))
if me and me.get("place"): lg["standing"] = me["place"]
try:
    from zoneinfo import ZoneInfo; now = datetime.datetime.now(ZoneInfo("Asia/Jerusalem"))
except Exception: now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
lg["fetched"] = now.strftime("%Y-%m-%d"); lg["synced"] = now.strftime("%Y-%m-%d %H:%M")
log_moves(lg, changes, lg["synced"])
open(out_p, "w", encoding="utf-8").write(put(html, "leaguedata", leagues))
print("yahoo: %d teams synced, standing %s" % (len(teams), lg.get("standing")))
print("\n".join(report) or "no roster changes")
