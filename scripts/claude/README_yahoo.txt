Fair Catch Yahoo refresh (every 6 hours; needs the user's computer with the Claude desktop app and its built-in browser,
signed in to Yahoo). Yahoo league id: 1260599
Repository: amit20b/fair-catch (the live site is https://amit20b.github.io/fair-catch/). Get it first: call the add_repo
tool with owner "amit20b", repo "fair-catch", access "push", then git clone --depth 1 https://github.com/amit20b/fair-catch into
a folder R in your scratchpad. The page is R/site/index.html; the scripts are in R/scripts/claude/.

1. Work folder W (empty, in your scratchpad). cp R/site/index.html $W/page.html. The script is R/scripts/claude/yahoo.py.
2. Built-in browser: open https://football.fantasysports.yahoo.com/f1/1260599 (preview_start or navigate). If the site
   needs approval, request it (scope "site") and wait for the user's answer. If the page shows a Yahoo sign-in screen,
   stop: do not sign in or type anything; report that the user needs to sign in to Yahoo in the built-in browser.
3. On that page run ONE javascript_tool call with exactly this code, and Write the returned string to $W/yahoo.json:
   const out={teams:[],errors:[]};
   const parse=(html)=>{const d=new DOMParser().parseFromString(html,'text/html');
     const names=[...d.querySelectorAll('table[id^="statTable"] a.name, table[id^="statTable"] .ysf-player-name a')].map(a=>a.textContent.trim()).filter(Boolean);
     const txt=(d.body&&d.body.innerText)||d.body.textContent||'';
     return {names:[...new Set(names)],tt:d.title||'',rank:(txt.match(/(\d+)(?:st|nd|rd|th) Place/)||[])[0]||''};};
   for(let rid=1;rid<=12;rid++){
     try{const r=await fetch(`https://football.fantasysports.yahoo.com/f1/1260599/${rid}`,{credentials:'include'});out.teams.push({rid,status:r.status,...parse(await r.text())});}
     catch(e){out.errors.push(rid+':'+e.message);}
   }
   JSON.stringify(out)
4. python3 -I R/scripts/claude/yahoo.py $W/page.html $W/yahoo.json $W/out.html   (non-zero exit = do NOT publish; report it)
5. Extract the last <script>...</script> block without attributes from $W/out.html; node --check it. Do not publish if it fails.
6. Publish: cp $W/out.html R/site/index.html; git -C R add site/index.html; git -C R -c user.name="Claude" -c
   user.email="noreply@anthropic.com" commit -m "Yahoo refresh <date time>"; git -C R push origin HEAD:main. The site redeploys by itself.
   If the push is rejected (the 6-hourly refresh pushed first): git -C R fetch origin main; git -C R reset --hard origin/main;
   copy R/site/index.html to $W/page.html, run step 4 and 5 again with the same yahoo.json, copy, commit and push again (once).
7. Summary in two lines: what the script printed. Never edit code, styles or values by hand; never touch scheduled tasks.
