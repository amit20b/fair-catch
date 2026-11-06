"""Puts the sha256 of admin.html's inline script into its CSP. Usage: build_admin.py <in> <out> [api url to use instead]"""
import re, sys, hashlib, base64
src, out = sys.argv[1:3]
h = open(src, encoding="utf-8").read()
if len(sys.argv) > 3:
    h = h.replace("https://fair-catch-yahoo.amitibaum.workers.dev", sys.argv[3])
js = re.findall(r"<script>(.*?)</script>", h, re.S)[0]
d = base64.b64encode(hashlib.sha256(js.encode()).digest()).decode()
h = h.replace("__HASH__", "'sha256-%s'" % d)
open(out, "w", encoding="utf-8").write(h)
print("admin ok")
