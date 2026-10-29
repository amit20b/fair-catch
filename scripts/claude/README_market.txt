Fair Catch weekly expert buy/sell update.
Repository: amit20b/fair-catch (the live site is https://amit20b.github.io/fair-catch/). Get it first: call the add_repo
tool with owner "amit20b", repo "fair-catch", access "push", then git clone --depth 1 https://github.com/amit20b/fair-catch into
a folder R in your scratchpad. The page is R/site/index.html; the scripts are in R/scripts/claude/.

Goal: refresh the app's "Buy/Sell" tab with this week's expert calls (buy low, buy high, sell high, sell low, hold).

1. Work folder W (empty, in your scratchpad). cp R/site/index.html $W/page.html. The script is R/scripts/claude/market.py.
2. Work out the current NFL week (the upcoming week's games). Use WebSearch (send several searches in one turn) for
   this week's articles, for example: "fantasy football buy low sell high week N 2026", "fantasy football trade
   advice buy sell hold week N 2026", "sell high candidates week N 2026 fantasy". Prefer, in this order: FantasyPros,
   Footballguys, PFF, Sports Illustrated (Michael Fabiano), 4for4, ESPN, CBS Sports, Yahoo, The Athletic, RotoBaller,
   FanDuel Research, Fantasy Footballers, JHEN Fantasy, TWSN, Fantasy Six Pack. Only articles published in the last
   8 days. Skip pages that are paywalled or don't load.
3. WebFetch 6 to 12 of them with a prompt like: "List every player in this article with the category (buy low, buy
   high, sell high, sell low, buy, sell, hold) and a one-sentence reason in your own words. Format:
   Player | category | reason | expert. Also give the publish date and author."
4. Write $W/market.json (UTF-8) in exactly this shape:
   {"week": N, "updated": "YYYY-MM-DD",
    "sources": [{"k":"short-key","site":"FantasyPros","title":"...","author":"...","date":"YYYY-MM-DD","url":"https://..."}, ...],
    "players": [["Full Player Name", [["short-key","BL"], ["other-key","SH"]], "One short reason, max 25 words, in your own words"], ...]}
   Labels: BL buy low, BH buy high, B buy (no low/high given), SH sell high, SL sell low, S sell (no high/low given),
   H hold. One entry per player, combining every source that mentions him. Reasons must be your own summary: never copy
   sentences from the articles. Use full NFL names (e.g. "Kenneth Walker III", "Kyle Pitts Sr.").
5. python3 -I R/scripts/claude/market.py $W/page.html $W/market.json $W/out.html   (non-zero exit = do NOT publish; report)
6. Extract the last <script>...</script> block without attributes from $W/out.html; node --check it. Do not publish if it fails.
7. Publish: cp $W/out.html R/site/index.html; git -C R add site/index.html; git -C R -c user.name="Claude" -c
   user.email="noreply@anthropic.com" commit -m "Expert buy/sell update week N"; git -C R push origin HEAD:main. The site redeploys by itself.
   If the push is rejected (the 6-hourly refresh pushed first): git -C R fetch origin main; git -C R reset --hard origin/main;
   copy R/site/index.html to $W/page.html, run steps 5 and 6 again with the same market.json, copy, commit and push again (once).
8. Summary in two lines: number of sources and players, and the 3 strongest consensus calls.
Never edit code, styles or values by hand; never create, change or delete scheduled tasks.
