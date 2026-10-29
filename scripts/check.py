"""Safety check before the new page goes live: the data blocks must be valid JSON and the app script must exist.
  python scripts/check.py <page.html> <out.js>     (then: node --check <out.js>)
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
open(sys.argv[2], "w", encoding="utf-8").write(scripts[-1])
print("page ok: %d KB" % (len(h) // 1024))
