"""Fair Catch daily refresh: rebuilds the stats and Sleeper league data inside the published page.

usage: python3 -I refresh.py PAGE.html WORKDIR OUT.html
WORKDIR must hold:
  w2026.csv, w2025.csv   nflverse weekly player stats (stats_player release)
  ids.csv                DynastyProcess db_playerids.csv (sleeper_id -> name)
  games.csv              nflverse schedule (week, kickoff, betting lines)       (optional: no start/sit week data if missing)
  inj2026.csv            nflverse injury reports                               (optional)
  rw2026.csv             nflverse weekly rosters (team, IR status, sleeper_id)  (optional)
  rosters.json           https://api.sleeper.app/v1/league/<id>/rosters   (optional: skip league refresh if missing)
  users.json             https://api.sleeper.app/v1/league/<id>/users     (optional)
  rosters.txt / users.txt  the same, as one line per roster / user (preferred over the .json files)
  idmap.txt              optional "sleeper_id|Full Name" lines for ids the other sources do not know (kept in the page)
  team2026.csv, team2025.csv  nflverse weekly team stats (defense/special teams fantasy points)      (optional)
  fc_r1q.txt, fc_rsf.txt, fc_d1q.txt, fc_dsf.txt  FantasyCalc market values, "name|pos|value" lines  (optional: values step)
  fpecr.csv              DynastyProcess db_fpecr_latest.csv (FantasyPros expert rankings)        (needed for the values step)
Exits non-zero, writing nothing, if any sanity check fails."""
import csv, datetime, json, os, re, sys

page_p, wd, out_p = sys.argv[1:4]
html = open(page_p, encoding="utf-8").read()

def block(name):
    m = re.search(r'<script type="application/json" id="%s">(.*?)</script>' % name, html, re.S)
    if not m: sys.exit("missing data block: " + name)
    return m
def put(h, name, obj):
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return re.sub(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % name, lambda m: m.group(1) + s + m.group(3), h, count=1, flags=re.S)

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

def norm(n):
    n = n.lower().replace("’", "'")
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b\.?", "", n)
    return re.sub(r"[^a-z]", "", n)

data = json.loads(block("data").group(1))
leagues = json.loads(block("leaguedata").group(1))
try:
    from zoneinfo import ZoneInfo
    now = datetime.datetime.now(ZoneInfo("Asia/Jerusalem"))
except Exception:
    now = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=3)))
report = []

# ---------- values: FantasyCalc market (top players, refreshed) + FantasyPros rest-of-season / dynasty expert rankings ----------
import math
def fc_lines(name):
    pth = os.path.join(wd, name)
    if not os.path.exists(pth): return None
    out = {}
    for ln in open(pth, encoding="utf-8").read().splitlines():
        f = [x.strip() for x in ln.strip().strip("`").split("|")]
        if len(f) >= 3 and f[2].replace(".", "", 1).isdigit() and f[0]: out.setdefault(norm(f[0]), (float(f[2]), f[1].upper(), f[0]))
    return out if len(out) >= 60 else None
ROS_FIT = {"QB": (0.75, 0.022, 0.98), "RB": (0.95, 0.04, 0.78), "WR": (0.85, 0.046, 0.78), "TE": (0.85, 0.01, 1.1)}  # rank -> value, calibrated Oct 16 2026
def ros_curve(pos, rank):
    A, K, Pp = ROS_FIT[pos]; return A * 10000 * math.exp(-K * max(rank - 1, 0) ** Pp)
def dyn_curve(rank): return 10000 * math.exp(-0.0817 * max(rank - 1, 0) ** 0.596)
fcs = {k: fc_lines(k + ".txt") for k in ("fc_r1q", "fc_rsf", "fc_d1q", "fc_dsf")}
ecr_p = os.path.join(wd, "fpecr.csv")
if os.path.exists(ecr_p):                     # expert rankings always; market prices when the FantasyCalc list came through
    ros, dsf, d1q, scrape = {}, {}, {}, ""
    for r in csv.DictReader(open(ecr_p, encoding="utf-8")):
        if r["pos"] not in ("QB", "RB", "WR", "TE"): continue
        scrape = r.get("scrape_date") or scrape
        k = norm(r["player"])
        if r["fp_page"].endswith("ros-ppr-overall.php"): ros.setdefault(k, float(r["ecr"]))
        elif r["fp_page"].endswith("dynasty-superflex.php"): dsf.setdefault(k, float(r["ecr"]))
        elif r["fp_page"].endswith("dynasty-overall.php"): d1q.setdefault(k, float(r["ecr"]))
    sc = {k: ({n: v / max(x[0] for x in b.values()) * 10000 for n, (v, ps, nm) in b.items()} if b else {}) for k, b in fcs.items()}
    before = {p["id"]: p.get("r1", 0) for p in data["players"]}
    byname = {norm(p["n"]): p for p in data["players"]}
    # market-listed players we do not have yet
    for nk, (v, ps, nm) in (fcs["fc_r1q"] or {}).items():
        if nk not in byname and ps in ("QB", "RB", "WR", "TE"):
            rec = dict(n=nm, p=ps, t="FA", d1=0, d2=0, r1=0, r2=0, id=max(x["id"] for x in data["players"]) + 1)
            data["players"].append(rec); byname[nk] = rec
    changed = 0
    for nk, p in byname.items():
        if p["p"] not in ("QB", "RB", "WR", "TE") or p.get("out"): continue
        f1o, f2o = p.get("f1", 0), p.get("f2", 0)
        f1 = sc["fc_r1q"].get(nk, f1o); f2 = sc["fc_rsf"].get(nk, f2o) if sc["fc_rsf"] else f2o
        ex1 = ros_curve(p["p"], ros[nk]) if nk in ros else max(0, (p.get("r1", 0) - 0.45 * f1o) / 0.55)
        r1 = round(0.45 * f1 + 0.55 * ex1)
        r2 = max(0, round(p.get("r2", 0) + 0.6 * (f2 - f2o)))
        if nk in sc["fc_dsf"] and nk in dsf:
            p["m"] = round(sc["fc_dsf"][nk]); p["x"] = round(dyn_curve(dsf[nk])); p["d2"] = round(0.55 * p["m"] + 0.45 * p["x"])
        if nk in sc["fc_d1q"] and nk in d1q: p["d1"] = round(0.55 * sc["fc_d1q"][nk] + 0.45 * dyn_curve(d1q[nk]))
        if r1 != p.get("r1"): changed += 1
        p["r1"], p["r2"], p["f1"], p["f2"] = r1, r2, round(f1), round(f2)
    mx = max(pp.get("r1", 0) for pp in data["players"] if pp["p"] in ("QB", "RB", "WR", "TE"))
    if mx > 0:                                   # keep the #1 player at 10,000 like the rest of the app
        for pp in data["players"]:
            if pp["p"] in ("QB", "RB", "WR", "TE"): pp["r1"] = round(pp.get("r1", 0) * 10000 / mx)
    top = sorted((pp for pp in data["players"] if before.get(pp["id"], 0) > 300), key=lambda pp: -before[pp["id"]])[:150]
    rel = sorted(abs(pp["r1"] - before[pp["id"]]) / before[pp["id"]] for pp in top)
    med = rel[len(rel) // 2] if rel else 0
    if med > 0.3: sys.exit("values step: median change %.0f%% looks wrong, nothing written" % (med * 100))
    data["updated"] = now.strftime("%Y-%m-%d"); data["expertsScraped"] = scrape or data.get("expertsScraped")
    report.append("values: %d players changed, median change %.1f%% (FantasyCalc market list: %s players%s; expert rankings %s)" % (changed, med * 100, len(fcs["fc_r1q"] or {}), "" if fcs["fc_r1q"] else ", market prices kept from last time", scrape))
else:
    report.append("values: skipped (no expert rankings file)")

# ---------- stats ----------
ALIAS = {"chigoziemokonkwo": "chigokonkwo", "kennethgainwell": "kennygainwell"}
ours = {}
for p in data["players"]:
    if p["p"] in ("QB", "RB", "WR", "TE"):
        ours.setdefault((norm(p["n"]), p["p"]), p["id"]); ours.setdefault((norm(p["n"]), None), p["id"])
def pid(r):
    k = norm(r["player_display_name"]); k = ALIAS.get(k, k)
    return ours.get((k, r["position"])) or ours.get((k, None))
N = lambda v: float(v) if v not in ("", "NA", None) else 0.0
I = lambda v: int(round(N(v)))
g26, g25, ts, lastwk = {}, {}, {}, 0
for r in csv.DictReader(open(os.path.join(wd, "w2026.csv"), encoding="utf-8")):
    if r["season_type"] != "REG": continue
    i = pid(r)
    if not i: continue
    wk = int(r["week"]); lastwk = max(lastwk, wk)
    g26.setdefault(i, []).append([wk, r["opponent_team"], round(N(r["fantasy_points"]), 1), I(r["receptions"]), I(r["targets"]), I(r["receiving_yards"]), I(r["receiving_tds"]),
        I(r["carries"]), I(r["rushing_yards"]), I(r["rushing_tds"]), I(r["completions"]), I(r["attempts"]), I(r["passing_yards"]), I(r["passing_tds"]), I(r["passing_interceptions"])])
    if r["target_share"] not in ("", "NA"): ts.setdefault(i, []).append(N(r["target_share"]))
for r in csv.DictReader(open(os.path.join(wd, "w2025.csv"), encoding="utf-8")):
    if r["season_type"] != "REG": continue
    i = pid(r)
    if i: g25.setdefault(i, []).append((int(r["week"]), round(N(r["fantasy_points"]), 1), I(r["receptions"])))
P = {}
for i in set(g26) | set(g25):
    rec = {}
    if i in g26: rec["g"] = sorted(g26[i])
    if i in g25: rec["h"] = [[s, c] for w, s, c in sorted(g25[i])][-17:]
    if i in ts: rec["ts"] = round(sum(ts[i]) / len(ts[i]), 3)
    P[str(i)] = rec
if len(g26) < 200: sys.exit("too few players matched in 2026 stats: %d" % len(g26))
old_week = json.loads(block("statsdata").group(1) or "{}").get("week")
stats = dict(season=2026, week=lastwk, src="nflverse", synced=now.strftime("%Y-%m-%d %H:%M"), p=P)
report.append("stats: %d players, through week %s (was %s)" % (len(g26), lastwk, old_week))

# ---------- this week: schedule, betting lines, defense vs position, team, IR and injury status ----------
TEAMFIX = {"LAR": "LA", "GBP": "GB", "JAC": "JAX", "KCC": "KC", "LVR": "LV", "NEP": "NE", "NOS": "NO", "SFO": "SF", "TBB": "TB", "WSH": "WAS"}
gp = os.path.join(wd, "games.csv")
rw_sleeper = {}
if os.path.exists(gp):
    games = [r for r in csv.DictReader(open(gp, encoding="utf-8")) if r["season"] == "2026" and r["game_type"] == "REG"]
    open_weeks = sorted({int(r["week"]) for r in games if r["home_score"] in ("", "NA")})
    W = open_weeks[0] if open_weeks else None
    rows = []
    for r in games:
        if W is None or int(r["week"]) != W: continue
        d = datetime.date.fromisoformat(r["gameday"]); hh, mm = map(int, (r["gametime"] or "13:00").split(":"))
        off = -4 if d < datetime.date(2026, 11, 1) else -5          # US Eastern daylight time ends Nov 1, 2026
        ko = datetime.datetime(d.year, d.month, d.day, hh, mm, tzinfo=datetime.timezone(datetime.timedelta(hours=off)))
        done = r["home_score"] not in ("", "NA")
        sp, tot = N(r["spread_line"]), N(r["total_line"])            # spread_line = expected home margin
        rows.append([r["away_team"], r["home_team"], int(ko.timestamp() * 1000), 1 if done else 0,
                     I(r["away_score"]) if done else None, I(r["home_score"]) if done else None,
                     round((tot - sp) / 2, 1) if tot else None, round((tot + sp) / 2, 1) if tot else None])
    # fantasy points each defense allows per game to each position, vs the league average (PPR, 2026 games)
    allowed, posn = {}, {}
    byid = {p["id"]: p for p in data["players"]}
    for i, gl in g26.items():
        pos = byid[i]["p"] if i in byid else None
        if pos not in ("QB", "RB", "WR", "TE"): continue
        for x in gl:
            k = (x[1], pos); allowed.setdefault(k, {}); allowed[k][x[0]] = allowed[k].get(x[0], 0) + x[2] + x[3]
    dvp = {}
    for pos in ("QB", "RB", "WR", "TE"):
        per = {tm: sum(v.values()) / len(v) for (tm, ps), v in allowed.items() if ps == pos and v}
        avg = sum(per.values()) / max(1, len(per))
        for tm, v in per.items(): dvp.setdefault(tm, {})[pos] = round(v / avg, 3) if avg else 1
    stats["sched"] = dict(week=W, games=rows)
    stats["dvp"] = dvp
    report.append("schedule: week %s, %d games, %d done" % (W, len(rows), sum(r[3] for r in rows)))
    # current team and roster status from nflverse weekly rosters
    rwp = os.path.join(wd, "rw2026.csv")
    if os.path.exists(rwp):
        rw = list(csv.DictReader(open(rwp, encoding="utf-8")))
        mw = max(int(r["week"]) for r in rw)
        for r in rw:
            if r["sleeper_id"] not in ("", "NA"): rw_sleeper[r["sleeper_id"]] = r["full_name"]
            if int(r["week"]) != mw or r["position"] not in ("QB", "RB", "WR", "TE"): continue
            i = ours.get((ALIAS.get(norm(r["full_name"]), norm(r["full_name"])), r["position"]))
            if not i: continue
            e = P.setdefault(str(i), {}); e["tm"] = r["team"]
            if r["status"] not in ("ACT", ""): e["st"] = r["status"]       # RES = injured reserve, EXE/RET/CUT/SUS/DEV = not playing
    # this week's injury report (Out / Doubtful / Questionable)
    ip = os.path.join(wd, "inj2026.csv")
    if os.path.exists(ip) and W:
        n_inj = 0
        for r in csv.DictReader(open(ip, encoding="utf-8")):
            if r["week"] != str(W) or r["report_status"] in ("", "NA") or r["position"] not in ("QB", "RB", "WR", "TE"): continue
            i = ours.get((ALIAS.get(norm(r["full_name"]), norm(r["full_name"])), r["position"]))
            if not i: continue
            P.setdefault(str(i), {})["inj"] = [r["report_status"], r["report_primary_injury"] or ""]; n_inj += 1
        report.append("injury report week %s: %d fantasy players listed" % (W, n_inj))

# ---------- kickers and defenses: fantasy points from nflverse (Sleeper default scoring) ----------
KFIX = {"LAR": "LA", "GBP": "GB", "JAC": "JAX", "KCC": "KC", "LVR": "LV", "NEP": "NE", "NOS": "NO", "SFO": "SF", "TBB": "TB", "WSH": "WAS"}
kid = {norm(p["n"]): p["id"] for p in data["players"] if p["p"] == "K"}
did = {KFIX.get(p.get("t", ""), p.get("t", "")): p["id"] for p in data["players"] if p["p"] == "DST"}
def kpts(r):
    fg3 = I(r["fg_made_0_19"]) + I(r["fg_made_20_29"]) + I(r["fg_made_30_39"]); fg4 = I(r["fg_made_40_49"]); fg5 = I(r["fg_made_50_59"]) + I(r["fg_made_60_"])
    return 3 * fg3 + 4 * fg4 + 5 * fg5 + I(r["pat_made"]) - I(r["fg_missed"]) - I(r["pat_missed"])
def pa_pts(pa):
    return 10 if pa == 0 else 7 if pa <= 6 else 4 if pa <= 13 else 1 if pa <= 20 else 0 if pa <= 27 else -1 if pa <= 34 else -4
scores = {}
if os.path.exists(gp):
    for r in csv.DictReader(open(gp, encoding="utf-8")):
        if r["season"] in ("2025", "2026") and r["game_type"] == "REG" and r["home_score"] not in ("", "NA"):
            w = (r["season"], int(r["week"]))
            scores[(w, r["home_team"])] = int(r["away_score"]); scores[(w, r["away_team"])] = int(r["home_score"])   # points allowed
nk = nd = 0
for season, fname in (("2026", "w2026.csv"), ("2025", "w2025.csv")):
    for r in csv.DictReader(open(os.path.join(wd, fname), encoding="utf-8")):
        if r["season_type"] != "REG" or r["position"] != "K": continue
        i = kid.get(norm(r["player_display_name"]))
        if not i: continue
        pts = kpts(r); e = P.setdefault(str(i), {})
        if season == "2026":
            e.setdefault("g", []).append([int(r["week"]), r["opponent_team"], pts, 0, I(r["fg_made"]), I(r["fg_att"]), I(r["pat_made"]), I(r["pat_att"]), I(r["fg_long"]), 0, 0, 0, 0, 0, 0]); nk += 1
        else: e.setdefault("h", []).append([pts, 0])
for season in ("2026", "2025"):
    tp = os.path.join(wd, "team%s.csv" % season)
    if not os.path.exists(tp): continue
    for r in csv.DictReader(open(tp, encoding="utf-8")):
        if r.get("season_type", "REG") != "REG": continue
        i = did.get(r["team"])
        if not i: continue
        wk = int(r["week"]); pa = scores.get(((season, wk), r["team"]))
        if pa is None: continue
        sk, it, fr = N(r["def_sacks"]), I(r["def_interceptions"]), I(r["fumble_recovery_opp"])
        td = I(r["def_tds"]) + I(r["special_teams_tds"]); sf = I(r["def_safeties"]); bl = I(r["def_fg_blocks"]) + I(r["def_punt_blocks"])
        pts = round(sk + 2 * it + 2 * fr + 6 * td + 2 * sf + 2 * bl + pa_pts(pa), 1)
        e = P.setdefault(str(i), {})
        if season == "2026":
            e.setdefault("g", []).append([wk, r["opponent_team"], pts, 0, round(sk, 1), it, fr, td, sf, pa, bl, 0, 0, 0, 0]); nd += 1
        else: e.setdefault("h", []).append([pts, 0])
for i in list(kid.values()) + list(did.values()):
    e = P.get(str(i))
    if e and "g" in e: e["g"].sort()
    if e and "h" in e: e["h"] = e["h"][-17:]
report.append("kickers/defenses: %d kicker games, %d defense games this season" % (nk, nd))

# ---------- Sleeper league ----------
DEF = {"ARI":"Arizona Cardinals","ATL":"Atlanta Falcons","BAL":"Baltimore Ravens","BUF":"Buffalo Bills","CAR":"Carolina Panthers","CHI":"Chicago Bears","CIN":"Cincinnati Bengals","CLE":"Cleveland Browns","DAL":"Dallas Cowboys","DEN":"Denver Broncos","DET":"Detroit Lions","GB":"Green Bay Packers","HOU":"Houston Texans","IND":"Indianapolis Colts","JAX":"Jacksonville Jaguars","KC":"Kansas City Chiefs","LV":"Las Vegas Raiders","LAC":"Los Angeles Chargers","LAR":"Los Angeles Rams","MIA":"Miami Dolphins","MIN":"Minnesota Vikings","NE":"New England Patriots","NO":"New Orleans Saints","NYG":"New York Giants","NYJ":"New York Jets","PHI":"Philadelphia Eagles","PIT":"Pittsburgh Steelers","SF":"San Francisco 49ers","SEA":"Seattle Seahawks","TB":"Tampa Bay Buccaneers","TEN":"Tennessee Titans","WAS":"Washington Commanders"}
LALIAS = {"chigoziemokonkwo": "Chig Okonkwo", "kennethgainwell": "Kenny Gainwell"}
def load_loose(path):
    """JSON from a web fetch, tolerating markdown fences or text around it: take the outermost [...] array."""
    if not os.path.exists(path): return None
    s = open(path, encoding="utf-8").read()
    try: return json.loads(s)
    except ValueError: pass
    a, b = s.find("["), s.rfind("]")
    if a < 0 or b <= a: return None
    try: return json.loads(s[a:b + 1])
    except ValueError: return None
def load_lines(path, league_id):
    """rosters.txt: one line per roster: roster_id|owner_id|wins|losses|ties|fpts|fpts_decimal|players|starters"""
    if not os.path.exists(path): return None
    out = []
    for ln in open(path, encoding="utf-8").read().splitlines():
        f = [x.strip() for x in ln.strip().strip("`").split("|")]
        if len(f) < 9 or not f[0].isdigit(): continue
        try:
            out.append(dict(league_id=league_id, roster_id=int(f[0]), owner_id=f[1], players=[x for x in f[7].split(",") if x], starters=[x for x in f[8].split(",") if x],
                            settings=dict(wins=int(f[2] or 0), losses=int(f[3] or 0), ties=int(f[4] or 0), fpts=int(f[5] or 0), fpts_decimal=int(f[6] or 0))))
        except ValueError: continue
    return out or None
def load_users(path):
    if not os.path.exists(path): return []
    us = []
    for ln in open(path, encoding="utf-8").read().splitlines():
        f = [x.strip() for x in ln.strip().strip("`").split("|")]
        if len(f) >= 2 and f[0].isdigit(): us.append(dict(user_id=f[0], display_name=f[1], metadata=dict(team_name=f[2]) if len(f) > 2 and f[2] else {}))
    return us
SLEEPER_ID = next((str(l.get("id")) for l in leagues if l.get("platform", "Sleeper") == "Sleeper"), "")
rp = os.path.join(wd, "rosters.json")
rosters = load_lines(os.path.join(wd, "rosters.txt"), SLEEPER_ID)
if rosters is None: rosters = load_loose(rp)
elif len(rosters) < 8: report.append("sleeper: rosters.txt had only %d lines" % len(rosters))
if rosters is not None and not (isinstance(rosters, list) and len(rosters) >= 8 and all(isinstance(r, dict) and "roster_id" in r for r in rosters)):
    report.append("sleeper: rosters.json was not a roster list, skipped"); rosters = None
elif rosters is None and (os.path.exists(rp) or os.path.exists(os.path.join(wd, "rosters.txt"))):
    report.append("sleeper: rosters.json could not be parsed, skipped")
if rosters is not None:
    users = load_users(os.path.join(wd, "users.txt")) or load_loose(os.path.join(wd, "users.json")) or []
    if not isinstance(users, list): users = []
    uname = {u["user_id"]: ((u.get("metadata") or {}).get("team_name") or u.get("display_name") or "").strip() for u in users}
    ids = {r["sleeper_id"]: r for r in csv.DictReader(open(os.path.join(wd, "ids.csv"), encoding="utf-8")) if r["sleeper_id"] not in ("", "NA")}
    known = {norm(p["n"]): p["n"] for p in data["players"]}
    lg = next((l for l in leagues if l.get("platform", "Sleeper") == "Sleeper" and str(l.get("id")) == str(rosters[0].get("league_id"))), None)
    if not lg: sys.exit("Sleeper league in rosters.json is not in the page")
    # ids the other sources do not know yet (new rookies): remembered in the page, extended from idmap.txt
    idmap = dict(lg.get("idmap") or {})
    imp = os.path.join(wd, "idmap.txt")
    if os.path.exists(imp):
        for ln in open(imp, encoding="utf-8").read().splitlines():
            f = [x.strip() for x in ln.strip().strip("`").split("|")]
            if len(f) >= 2 and f[0].isdigit() and f[1] and "NOT_FOUND" not in f[1]: idmap[f[0]] = f[1]
    lg["idmap"] = idmap
    if len(rosters) != len(lg["teams"]): sys.exit("roster count changed: %d vs %d" % (len(rosters), len(lg["teams"])))
    unmatched = []; changes = []
    for r in rosters:
        t = next((x for x in lg["teams"] if x["rid"] == r["roster_id"]), None)
        if not t: sys.exit("unknown roster id %s" % r["roster_id"])
        names = []; miss = 0
        for sid in r.get("players") or []:
            if sid in DEF: nm = DEF[sid]
            elif sid in ids: nm = ids[sid]["name"]
            elif sid in rw_sleeper: nm = rw_sleeper[sid]
            elif sid in idmap: nm = idmap[sid]
            else: unmatched.append(sid); miss += 1; continue
            nm = LALIAS.get(norm(nm), nm)
            names.append(known.get(norm(nm), nm))
        if len(names) < 10: sys.exit("roster %s looks incomplete (%d players)" % (r["roster_id"], len(names)))
        added = [n for n in names if n not in t["p"]]; dropped = [n for n in t["p"] if n not in names]
        if added or dropped: report.append("%s: +%s -%s" % (t["name"], added, dropped))
        changes.append((t, added, [] if miss else dropped))  # a player we could not name is not a real drop
        st = r.get("settings") or {}
        t["p"] = names
        # current starting lineup as set in Sleeper (empty slots are "0")
        sts = []
        for sid in r.get("starters") or []:
            nm = DEF.get(sid) or (ids[sid]["name"] if sid in ids else rw_sleeper.get(sid) or idmap.get(sid))
            sts.append(known.get(norm(LALIAS.get(norm(nm), nm)), nm) if nm else "")
        t["st"] = sts
        t["rec"] = "%d-%d%s" % (st.get("wins", 0), st.get("losses", 0), ("-%d" % st["ties"]) if st.get("ties") else "")
        t["pf"] = round(st.get("fpts", 0) + st.get("fpts_decimal", 0) / 100, 2)
        nm = uname.get(r.get("owner_id"))
        if nm: t["name"] = nm
    lg["fetched"] = now.strftime("%Y-%m-%d"); lg["synced"] = now.strftime("%Y-%m-%d %H:%M")
    log_moves(lg, changes, lg["synced"])
    if lastwk: lg["week"] = lastwk
    report.append("sleeper: %d rosters synced; unmatched ids: %s" % (len(rosters), sorted(set(unmatched))))
    open(os.path.join(wd, "unmatched.txt"), "w").write("\n".join(sorted(set(unmatched))))
    # rostered players the value data does not have yet (e.g. a rookie kicker): add them so they show up in the app
    rwpos = {}
    if os.path.exists(os.path.join(wd, "rw2026.csv")):
        for r in csv.DictReader(open(os.path.join(wd, "rw2026.csv"), encoding="utf-8")): rwpos[norm(r["full_name"])] = (r["position"], r["team"])
    known_now = {norm(p["n"]) for p in data["players"]}
    added_p = []
    for l in leagues:
        for tm in l["teams"]:
            for n in tm["p"]:
                k = norm(n)
                if k in known_now or k not in rwpos: continue
                pos, team = rwpos[k]; pos = {"PK": "K"}.get(pos, pos)
                if pos not in ("QB", "RB", "WR", "TE", "K"): continue
                base = sorted(p.get("r1", 0) for p in data["players"] if p["p"] == pos)
                v = base[len(base) // 4] if base else 20            # a low default until the markets list him
                data["players"].append(dict(n=n, p=pos, t=team, d1=0 if pos == "K" else 20, d2=0 if pos == "K" else 20, r1=v, r2=v, id=max(x["id"] for x in data["players"] if x["id"] < 1000) + 1))
                known_now.add(k); added_p.append(n)
    if added_p: report.append("added players to the value list: %s" % added_p)
elif not os.path.exists(rp) and not os.path.exists(os.path.join(wd, "rosters.txt")):
    report.append("sleeper: skipped (no rosters.txt or rosters.json)")

npth = os.path.join(wd, "notes.txt")
if os.path.exists(npth): report.append("notes from the run: " + " / ".join(x.strip() for x in open(npth, encoding="utf-8").read().splitlines() if x.strip())[:600])
files = sorted(f for f in os.listdir(wd))
report.append("files in work folder: %s" % files)
stats["log"] = report                     # what this refresh did, readable later from the page data
out = put(put(put(html, "statsdata", stats), "leaguedata", leagues), "data", data)
open(out_p, "w", encoding="utf-8").write(out)
print("\n".join(report))
