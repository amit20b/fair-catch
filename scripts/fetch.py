"""Download everything the refresh needs into a work folder.

  python scripts/fetch.py data  <work folder>    stats, schedule, injuries, rankings, Sleeper league, FantasyCalc values
  python scripts/fetch.py names <work folder>    names for Sleeper ids the page does not know yet (reads unmatched.txt)

Optional files that fail to download are skipped and noted in notes.txt; refresh.py works without them.
"""
import json, os, sys, time, urllib.request

LEAGUE = os.environ.get("SLEEPER_LEAGUE", "1389331972198760448")
TEAMS = os.environ.get("LEAGUE_TEAMS", "14")
NFL = "https://github.com/nflverse/nflverse-data/releases/download/"
DP = "https://raw.githubusercontent.com/dynastyprocess/data/master/files/"
SEASON = os.environ.get("SEASON", "2026")
PREV = str(int(SEASON) - 1)

FILES = [  # (file name, url, required)
    ("w2026.csv", NFL + "stats_player/stats_player_week_%s.csv" % SEASON, True),
    ("w2025.csv", NFL + "stats_player/stats_player_week_%s.csv" % PREV, True),
    ("ids.csv", DP + "db_playerids.csv", True),
    ("games.csv", NFL + "schedules/games.csv", False),
    ("inj2026.csv", NFL + "injuries/injuries_%s.csv" % SEASON, False),
    ("rw2026.csv", NFL + "weekly_rosters/roster_weekly_%s.csv" % SEASON, False),
    ("team2026.csv", NFL + "stats_team/stats_team_week_%s.csv" % SEASON, False),
    ("team2025.csv", NFL + "stats_team/stats_team_week_%s.csv" % PREV, False),
    ("fpecr.csv", DP + "db_fpecr_latest.csv", False),
]
FC = {  # FantasyCalc market values: redraft / dynasty, 1QB / superflex
    "fc_r1q": "isDynasty=false&numQbs=1",
    "fc_rsf": "isDynasty=false&numQbs=2",
    "fc_d1q": "isDynasty=true&numQbs=1",
    "fc_dsf": "isDynasty=true&numQbs=2",
}
UA = {"User-Agent": "FairCatch/1.0 (personal fantasy trade calculator)"}


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120) as r:
                return r.read()
        except Exception as e:  # network hiccup: wait and retry
            last = e
            time.sleep(4 * (i + 1))
    raise last


def note(wd, line):
    with open(os.path.join(wd, "notes.txt"), "a", encoding="utf-8") as f:
        f.write(line + "\n")
    print("note:", line)


def data(wd):
    for name, url, required in FILES:
        try:
            open(os.path.join(wd, name), "wb").write(get(url))
            print("ok  ", name)
        except Exception as e:
            if required:
                sys.exit("could not download %s: %s" % (name, e))
            note(wd, "download skipped: %s (%s)" % (name, e))
    # Sleeper league rosters and users (public read-only API)
    try:
        ro = json.loads(get("https://api.sleeper.app/v1/league/%s/rosters" % LEAGUE))
        for r in ro:
            r.setdefault("league_id", LEAGUE)
        us = json.loads(get("https://api.sleeper.app/v1/league/%s/users" % LEAGUE))
        json.dump(ro, open(os.path.join(wd, "rosters.json"), "w"))
        json.dump(us, open(os.path.join(wd, "users.json"), "w"))
        print("ok   sleeper: %d rosters, %d users" % (len(ro), len(us)))
    except Exception as e:
        note(wd, "sleeper league not refreshed (%s)" % e)
    # FantasyCalc values, all players, as "name|position|value" lines
    for key, q in FC.items():
        try:
            arr = json.loads(get("https://api.fantasycalc.com/values/current?%s&numTeams=%s&ppr=1" % (q, TEAMS)))
            lines = ["%s|%s|%s" % (x["player"]["name"], x["player"]["position"], x["value"]) for x in arr if x.get("player")]
            open(os.path.join(wd, key + ".txt"), "w", encoding="utf-8").write("\n".join(lines))
            print("ok   %s: %d players" % (key, len(lines)))
        except Exception as e:
            note(wd, "FantasyCalc %s not refreshed (%s)" % (key, e))


def names(wd):
    p = os.path.join(wd, "unmatched.txt")
    ids = [x.strip() for x in open(p).read().split() if x.strip()] if os.path.exists(p) else []
    if not ids:
        print("no unknown ids")
        return
    allp = json.loads(get("https://api.sleeper.app/v1/players/nfl"))
    out = []
    for i in ids:
        q = allp.get(i) or {}
        nm = (q.get("full_name") or ("%s %s" % (q.get("first_name", ""), q.get("last_name", ""))).strip())
        out.append("%s|%s" % (i, nm or "NOT_FOUND"))
    with open(os.path.join(wd, "idmap.txt"), "a", encoding="utf-8") as f:
        f.write("\n".join(out) + "\n")
    print("names for %d new ids" % len(out))


if __name__ == "__main__":
    mode, wd = sys.argv[1], sys.argv[2]
    os.makedirs(wd, exist_ok=True)
    {"data": data, "names": names}[mode](wd)
