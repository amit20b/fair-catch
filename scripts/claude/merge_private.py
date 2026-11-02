"""Builds the page the private checks work on: the public page (fresh stats, values, market) with the owner's private
league and offers blocks put in. Usage: merge_private.py <public page> <private page> <out page>
The private page is never published anywhere public; only the owner's private artifact holds it."""
import re, sys
pub, prv, out = sys.argv[1:4]
H = open(pub, encoding="utf-8").read()
P = open(prv, encoding="utf-8").read()
def block(h, k):
    m = re.search(r'(<script type="application/json" id="%s">)(.*?)(</script>)' % k, h, re.S)
    if not m: sys.exit("block %s missing" % k)
    return m
for k in ("leaguedata", "offerdata"):
    src = block(P, k).group(2)
    m = block(H, k)
    H = H[:m.start(2)] + src + H[m.end(2):]
open(out, "w", encoding="utf-8").write(H)
print("merged", out, len(H))
