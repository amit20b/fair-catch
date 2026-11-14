"""Keep a day-by-day record of every player's base values, for the value-history chart.

    python scripts/history.py site/index.html site/history.json            add today's values
    python scripts/history.py --backfill site/history.json                 rebuild from the git history of site/index.html

One entry per day (the last refresh of the day wins). Keeps the last 180 days.
Each day stores the four base values the app builds every format from: redraft 1QB, redraft SF, dynasty 1QB, dynasty SF.
"""
import json, re, subprocess, sys, datetime

KEEP = 180
# redraft values before this day were inflated by a fixed bug (missing players' expert value compounded), so they are not kept
REDRAFT_FROM = '2026-11-07'
RX = re.compile(r'<script type="application/json" id="data">(.*?)</script>', re.S)

def snap(html):
    m = RX.search(html)
    if not m:
        return None, None
    d = json.loads(m.group(1))
    day = str(d.get('updated') or '')[:10] or datetime.date.today().isoformat()
    vals = {}
    for p in d.get('players', []) + d.get('picks', []):
        n = p.get('n')
        if not n:
            continue
        v = [int(round(p.get(k) or 0)) for k in ('r1', 'r2', 'd1', 'd2')]
        # same guard the publish check uses: a redraft value far above what the trade market says is a glitch
        mk = max(p.get('m') or 0, p.get('x') or 0)
        if mk:
            v = [0 if (i < 2 and x > 3000 and x > 2.2 * mk + 600) else x for i, x in enumerate(v)]
        if any(v):
            vals[n] = v
    if day < REDRAFT_FROM:
        vals = {n: [0, 0, v[2], v[3]] for n, v in vals.items()}
    return day, vals

def load(path):
    try:
        with open(path, encoding='utf-8') as f:
            h = json.load(f)
        if h.get('v') == 1:
            return h
    except Exception:
        pass
    return {'v': 1, 'dates': [], 'p': {}}

def put(h, day, vals):
    if day in h['dates']:
        i = h['dates'].index(day)
    else:
        h['dates'].append(day)
        order = sorted(range(len(h['dates'])), key=lambda k: h['dates'][k])
        h['dates'] = [h['dates'][k] for k in order]
        for n in h['p']:
            row = h['p'][n] + [0]
            h['p'][n] = [row[k] for k in order]
        i = h['dates'].index(day)
    for n, v in vals.items():
        row = h['p'].setdefault(n, [0] * len(h['dates']))
        while len(row) < len(h['dates']):
            row.append(0)
        row[i] = v
    # trim old days and players that no longer have any value
    if len(h['dates']) > KEEP:
        cut = len(h['dates']) - KEEP
        h['dates'] = h['dates'][cut:]
        for n in list(h['p']):
            h['p'][n] = h['p'][n][cut:]
    for n in list(h['p']):
        if not any(h['p'][n]):
            del h['p'][n]

def clean(h):
    # a one-off spike that came back down (a data glitch, not a real move) is dropped from the record
    for n, row in h['p'].items():
        for k in range(4):
            for i in range(len(row)):
                v = row[i][k] if row[i] else 0
                if not v:
                    continue
                prev = next((row[j][k] for j in range(i - 1, -1, -1) if row[j] and row[j][k]), 0)
                nxt = next((row[j][k] for j in range(i + 1, len(row)) if row[j] and row[j][k]), 0)
                if prev and nxt and v > 3000 and v > 2 * max(prev, nxt):
                    row[i] = row[i][:k] + [0] + row[i][k + 1:]

def save(h, path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(h, f, separators=(',', ':'), ensure_ascii=False)

def main(a):
    if a and a[0] == '--backfill':
        out = a[1]
        h = {'v': 1, 'dates': [], 'p': {}}
        log = subprocess.run(['git', 'log', '--format=%H', '--reverse', '--', 'site/index.html'], capture_output=True, text=True, check=True).stdout.split()
        for c in log:
            html = subprocess.run(['git', 'show', f'{c}:site/index.html'], capture_output=True, text=True).stdout
            day, vals = snap(html)
            if day and vals:
                put(h, day, vals)
        clean(h)
        save(h, out)
        print('days', len(h['dates']), 'players', len(h['p']))
        return
    page, out = a[0], a[1]
    with open(page, encoding='utf-8') as f:
        day, vals = snap(f.read())
    if not vals:
        print('no values found, history left as is')
        return
    h = load(out)
    put(h, day, vals)
    save(h, out)
    print('history', day, 'days', len(h['dates']), 'players', len(h['p']))

if __name__ == '__main__':
    main(sys.argv[1:])
