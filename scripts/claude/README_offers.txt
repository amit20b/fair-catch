Fair Catch trade-offer alert (every 2 hours; needs the user's computer with the Claude desktop app and its built-in
browser, signed in to Sleeper and Yahoo).
Repository: amit20b/fair-catch (the live site is https://amit20b.github.io/fair-catch/). Get it first: call the add_repo
tool with owner "amit20b", repo "fair-catch", access "push", then git clone --depth 1 https://github.com/amit20b/fair-catch into
a folder R in your scratchpad. The page is R/site/index.html; the scripts are in R/scripts/claude/.
Goal: find trade offers OTHER managers sent to the user that are still pending, and send him the app's analysis of each
NEW one. Read-only on Sleeper and Yahoo: never accept, reject, counter or click anything that changes a trade; never
sign in or type credentials; on cookie pop-ups choose "Reject all".

Sleeper league 1389331972198760448, the user's roster_id 4 ("Brock Paper Scissors").
Yahoo league 1260599, the user's team id 11 ("You've Been TylerShoughed").

1. Work folder W (empty, in your scratchpad), separate scripts folder X. cp R/site/index.html $W/page.html;
   cp R/scripts/claude/offers.mjs $X/offers.mjs. In $X run: npm init -y >/dev/null;
   npm i playwright@1 (PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set; never run "playwright install").
2. Sleeper. Built-in browser: open https://sleeper.com/leagues/1389331972198760448 . If the site needs approval, request it
   (scope "site"). If it shows a sign-in screen: record {"ok":false,"note":"not signed in to Sleeper"} and go to step 3.
   Otherwise run ONE javascript_tool call with exactly this code and keep the returned string:
   const LG='1389331972198760448', ME=4, out={ok:false,offers:[],note:''};
   try{
     const scan=v=>{const m=String(v||'').match(/eyJ[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}/);return m?m[0]:null;};
     let tok=null; for(let i=0;i<localStorage.length&&!tok;i++) tok=scan(localStorage.getItem(localStorage.key(i)));
     if(!tok) tok=scan(document.cookie);
     if(!tok) out.note='no Sleeper session token found';
     else{
       const q='query league_transactions_filtered {league_transactions_filtered(league_id: "'+LG+'", roster_id_filters: [], type_filters: ["trade"], leg_filters: [], status_filters: ["proposed"]){adds drops draft_picks creator created roster_ids status transaction_id type}}';
       const r=await fetch('https://sleeper.com/graphql',{method:'POST',headers:{'content-type':'application/json',authorization:tok},body:JSON.stringify({operationName:'league_transactions_filtered',variables:{},query:q})});
       const j=await r.json(), L=j&&j.data&&j.data.league_transactions_filtered;
       if(!Array.isArray(L)) out.note='graphql '+r.status+': '+JSON.stringify(j&&j.errors||j).slice(0,300);
       else{
         const tx=L.filter(t=>t.status==='proposed'&&(t.roster_ids||[]).map(Number).includes(ME));
         const ro=await (await fetch('https://api.sleeper.app/v1/league/'+LG+'/rosters')).json(), rOf={};
         ro.forEach(x=>{rOf[x.owner_id]=x.roster_id;(x.co_owners||[]).forEach(c=>{rOf[c]=x.roster_id;});});
         const P=tx.length?await (await fetch('https://api.sleeper.app/v1/players/nfl')).json():{};
         const nm=id=>{const p=P[id];return !p?String(id):p.position==='DEF'?String(id):(p.full_name||((p.first_name||'')+' '+(p.last_name||'')).trim());};
         for(const t of tx){
           const cr=rOf[t.creator]; if(cr===ME) continue; // offers the user sent are not alerts
           const ad=t.adds||{}, dr=t.drops||{}, other=(t.roster_ids||[]).map(Number).find(x=>x!==ME);
           const pk=(t.draft_picks||[]).map(d=>typeof d==='string'?d.split(','):[d.season,d.round,d.roster_id,d.previous_owner_id,d.owner_id]);
           out.offers.push({id:String(t.transaction_id),from:cr!=null?cr:other,
             get:Object.keys(ad).filter(k=>+ad[k]===ME).map(nm),give:Object.keys(dr).filter(k=>+dr[k]===ME).map(nm),
             picksGet:pk.filter(d=>+d[4]===ME).map(d=>d[0]+' round '+d[1]+' pick'),picksGive:pk.filter(d=>+d[3]===ME).map(d=>d[0]+' round '+d[1]+' pick'),
             created:new Date(+t.created).toLocaleString('en-GB',{timeZone:'Asia/Jerusalem',day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'})});
         }
         out.ok=true;
       }
     }
   }catch(e){out.note='error: '+e.message;}
   JSON.stringify(out)
   If it returns ok:false with a graphql/token note, fall back to reading the page: in the Sleeper web app find the
   league's trades / pending offers view, read it (get_page_text / screenshot), and build the same shape by hand:
   {"ok":true,"offers":[{"id":"<transaction id if visible, else empty>","from":"<their team name>","get":[names the user
   receives],"give":[names the user gives],"picksGet":[],"picksGive":[],"created":"<when>"}]}. Only offers sent TO the user
   and still pending. If you cannot tell for sure, keep ok:false with a note: a wrong "no offers" is worse than "not checked".
3. Yahoo. Built-in browser: open https://football.fantasysports.yahoo.com/f1/1260599/11 (approval scope "site" if asked;
   sign-in screen -> {"ok":false,"note":"not signed in to Yahoo"}). Run ONE javascript_tool call:
   const out={links:[],snips:[]};
   for(const u of ['https://football.fantasysports.yahoo.com/f1/1260599','https://football.fantasysports.yahoo.com/f1/1260599/11']){
     const h=await (await fetch(u,{credentials:'include'})).text(), d=new DOMParser().parseFromString(h,'text/html');
     d.querySelectorAll('a[href]').forEach(a=>{const href=a.getAttribute('href')||'';if(/trade/i.test(href)||/trade/i.test(a.textContent))out.links.push([a.textContent.trim().slice(0,80),new URL(href,u).href]);});
     const t=(d.body&&d.body.textContent||'').replace(/\s+/g,' '), i=t.search(/pending trade|trade offer|trade proposal|proposed trade/i);
     if(i>=0) out.snips.push(t.slice(Math.max(0,i-150),i+900));
   }
   JSON.stringify(out)
   Known pattern (verified Oct 17): the team page shows "<Team> has proposed a trade to you" with a link
   .../f1/1260599/11/viewtrade?trid=<n>. Fetch that page (credentials:'include'), drop script/style, and read the
   text: "Players to Trade from... <their team>" lists what the user GETS, "Players to Trade from... You've Been
   TylerShoughed" lists what he GIVES (player names are the a.name links, in that order). Use id "yahoo-<trid>".
   From the links, open the ones that show a pending trade the user received (not "propose trade", not the league
   transactions log, not trades between two other teams), read each page and build:
   {"ok":true,"offers":[{"id":"<trade id from the URL>","from":"<proposing team name>","get":[...],"give":[...],
   "picksGet":[],"picksGive":[],"created":"<when>"}]}. No pending offers to the user -> {"ok":true,"offers":[]}.
   Player names exactly as Yahoo shows them; defenses as the team name (e.g. "Houston").
4. Write $W/found.json: {"leagues":{"1389331972198760448":<Sleeper result>,"1260599":<Yahoo result>}}
   (keep only ok, note, offers in each). In $X: node offers.mjs $W/page.html $W/found.json $W/out.html $W/report.json
   Non-zero exit or PAGE ERRORS -> do not publish; report it in one line.
5. If the first output line starts with PUBLISH: Publish: cp $W/out.html R/site/index.html; git -C R add site/index.html; git -C R -c user.name="Claude" -c
   user.email="noreply@anthropic.com" commit -m "Offer check <date time>"; git -C R push origin HEAD:main. The site redeploys by itself.
   If the push is rejected (the 6-hourly refresh pushed first): git -C R fetch origin main; git -C R reset --hard origin/main;
   copy R/site/index.html to $W/page.html, rerun step 4 with the same found.json (the alert text stays the one from the first run), copy, commit and push again (once).
6. Alerts. For every entry in report.json "fresh": if a PushNotification tool exists, send one push (under 200 chars):
   "Trade offer from <from> (<league>): <verdict>". Then your final message is the "text" of each fresh offer, verbatim,
   separated by a blank line, followed by one line: "Open Fair Catch (https://amit20b.github.io/fair-catch/) > My League > Overview for the full card."
   When "fresh" is empty, your whole final message is exactly: "No new trade offers." plus the notes from the first
   output line if a league was not checked. Never edit code, styles or values by hand; never touch scheduled tasks.
