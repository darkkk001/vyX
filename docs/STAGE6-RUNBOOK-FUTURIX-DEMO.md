# Stage 6 runbook: Futurix, demo first (the engine becomes authoritative for risk)

_Written 2026-10-06 on branch `engine/stage6` (worktree `D:\vyx-stage6`). **NOTHING in this document has been run on production.** No merge,
no deploy (VPS or Vercel), no migration on any production or Neon database until the owner has reviewed `docs/STAGE6-PLAN.md` and says go.
Every command below was written to be copied; every step ends with a verification. If a verification fails, STOP and use the rollback of that step (section 8)._

The order is fixed: **pre-checks, migration, web, engine (shadow), flip, watch, drill**, then much later `riskAuthorityDemoOnly = false`.
The migration must precede the web (the web's Prisma client reads every `Broker` column), and the web must precede the engine (an engine in
risk mode with a web that still acts on everything would double-act).

**The order, explicit (updated 2026-10-07 after the merge of `newrepo/main`; nothing may be reordered):**

1. **Migration `20261007090000_broker_risk_authority`** (`riskAuthority`, `riskAuthorityDemoOnly`).
2. **Migration `20261007100000_risk_engine_heartbeat`** (the heartbeat table). Both with `prisma migrate deploy` (section 2): `migrate status` FIRST (it must list them, after main's `20261006120000_credit_and_trading_rights` if that one is still pending), BOTH `DATABASE_URL` and `DIRECT_URL` set to the live database, never `migrate dev`. Prisma applies pending migrations in timestamp order, so 1 then 2 is guaranteed; 2.3 proves it from `_prisma_migrations`.
3. **Web** (section 3): merge, push, Vercel Ready. This ships the 5-minute margin-monitor cron unchanged AND the new 1-minute `risk-fallback` cron, and the ops alert (needs `OPS_ALERT_EMAIL`, 3.1).
4. **Engine on the VPS, still shadow** (section 4).
5. **Live bot sweep** (5.3 / 10.2): zzshadowbot, the 7 paths, on the exact build.
6. **The flip** (5.4): Futurix RUST + demo-only.

Verification of the 1-minute fallback cron and of the stale-heartbeat alert is part of 3.3 (the cron is registered and cheap), 6 (what to watch) and 7.B (the alert fires on the drill and recovers).

| Step | Where | What | Undo |
|---|---|---|---|
| 1 | read-only | pre-checks: soak gate, migration status, engine version | nothing to undo |
| 2 | owner PC, live DB | `prisma migrate deploy`: 2 additive migrations, every broker stays WEB | none needed (additive) |
| 3 | owner PC, Vercel | merge to `main`, web goes live; nothing changes (every broker WEB) | promote the previous deployment |
| 4 | VPS | engine build with the Stage 6 code, still `ENGINE_ORDER_MANAGEMENT=shadow` | script restores the old exe |
| 5 | VPS + live DB | engine to risk mode (owns nothing), zzshadowbot canary + sweep (10.2), then the Futurix flip: RUST + demo-only | back to WEB, one statement |
| 6 | read-only | watch, how long, what a failure looks like | step 5 undo |
| 7 | VPS + live DB | the WEB-fallback drills (manual flip, and the watchdog with the pause file) | n/a |
| 8 | - | rollback at every step | |
| 9 | live DB | much later: `riskAuthorityDemoOnly = false`, gated on the watchdog | back to `true` or WEB |
| 10 | local + bot machine | the final 7-path sweep on the exact cutover build | |

## Conventions

* **psql on Windows ignores every option placed AFTER the connection URL.** Options first, `-d <url>` last (`psql -X -q -d $url`).
* Nothing below prints a secret. URLs are read into variables; only host names, lengths and counts are shown.
* `nssm` is not on the VPS PATH. Always `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`.
* `prisma migrate` uses **`DIRECT_URL`**: set BOTH `DATABASE_URL` and `DIRECT_URL`, or it migrates whatever `.env` points at (a dead production). **Never `migrate dev`** on this database.
* The live database is `ep-morning-glade`, credentials in `D:\VyXTrader-Tauri\vyX\.env.live`. `ep-flat-boat` is dead; `ep-old-night` is dev. Every step that touches the live database starts with the host check of 2.1.
* Run SQL in this document against the live database through `$Live` (defined in 2.1).
* Times are UTC. The earliest flip is **after the 2nd weekend reopen, Sun 2026-10-11 21:00-22:00 UTC** (Sunday 17:00 New York; until 1 Nov US daylight time is in force), on a weekday with the market open and the owner present: **Mon 2026-10-12 or later**.

## 1. Pre-checks (read-only)

### 1.1 The soak gate

The gate is the owner's, unchanged: **7 clean days + 2 weekend reopens (the 2nd = Sun 2026-10-11 21:00-22:00 UTC) + 1 NFP + the final 7-path sweep on the exact cutover build (section 10).**
`exit_met` in the engine's own report is informational only (the owner's 2026-10-05 ruling: "verification is enough"). On the VPS:

```powershell
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
function Get-CmdVar([string]$Path, [string]$Name) { $l = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1; if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() } }
$u = Get-CmdVar $EngineCmd "VYX_SHADOW_STORE_URL"; if (-not $u) { $u = Get-CmdVar $EngineCmd "MARKET_DATA_DATABASE_URL" }
"store url length: $($u.Length)"
$sql = @'
SET default_transaction_read_only = on;
SELECT day, clock_days, weekend_opens, nfp_windows, paired_real, paired_bot, excused, exit_met FROM shadow_daily ORDER BY day DESC LIMIT 3;
-- unexplained pairs since the soak clock restarted (2026-09-29 10:56 UTC): must be 0
SELECT count(*) AS unexplained FROM shadow_pair p
 WHERE p.class IN ('VALUE','ENGINE_ONLY','WEB_ONLY') AND p.created_at > '2026-09-29 10:56:00+00'
   AND NOT EXISTS (SELECT 1 FROM shadow_excuse e WHERE e.pair_id = p.id);
'@
$sql | psql -X -q -d $u
```

**Verify:** the newest `shadow_daily` row has `clock_days >= 7`, `weekend_opens >= 2` (only true after the Sun 2026-10-11 reopen has been recorded, usually the next morning),
`nfp_windows >= 1`; `unexplained` is `0`. **If `weekend_opens` is still 1, STOP: the flip waits for 2026-10-11 21:00-22:00 UTC.**
The last item, the final sweep, is section 10 (local first, then the live one in 5.3).

### 1.2 `prisma migrate status` on production

On the owner PC (the live checkout, `D:\VyXTrader-Tauri\vyX`):

```powershell
cd D:\VyXTrader-Tauri\vyX
# load the live connection into THIS process only (nothing is printed except host names)
foreach ($l in Get-Content .env.live) { if ($l -match '^\s*(DATABASE_URL|DIRECT_URL)\s*=\s*"?([^"]+?)"?\s*$') { Set-Item -Path "Env:$($Matches[1])" -Value $Matches[2] } }
foreach ($n in 'DATABASE_URL','DIRECT_URL') { $v = (Get-Item "Env:$n").Value; "$n host: $((([uri]($v -replace '^postgres(ql)?://','http://')).Host))" }
if ($env:DATABASE_URL -notmatch 'ep-morning-glade' -or $env:DIRECT_URL -notmatch 'ep-morning-glade') { throw "not the live database (ep-morning-glade): stop" }
$Live = $env:DIRECT_URL
function Q([string]$sql) { $sql | psql -X -q -d $Live }     # run SQL against the live database
npx prisma migrate status
```

**Verify:** both hosts contain `ep-morning-glade`. `migrate status` lists exactly two pending migrations, `20261007090000_broker_risk_authority` and
`20261007100000_risk_engine_heartbeat`, and nothing else (no failed migration, no drift message). **If anything else is pending or failed, STOP** and send me the output: some other
migration is in front of this one and must be understood first. (Never answer a drift message with `migrate dev` or `migrate reset`.)

### 1.3 The engine version on the VPS

On the VPS:

```powershell
cd C:\vyxtrader\repo
"HEAD: $(git log -1 --format='%h %s')"
"exe sha256: $((Get-FileHash C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Algorithm SHA256).Hash.Substring(0,16))  written: $((Get-Item C:\vyxtrader\repo\engine\target\release\trading-core-server.exe).LastWriteTime)"
"health: $((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health -TimeoutSec 8).StatusCode)"
Get-Content C:\vyxtrader\scripts\start-engine.cmd | Select-String 'ENGINE_ORDER_MANAGEMENT|VYX_RISK_FLIP_INTENT|VYX_POST_CLOSE' | ForEach-Object { $_.Line -replace '(SECRET=).*','$1<hidden>' }
```

**Verify:** `HEAD` is the 2026-10-05 deploy (main `60ddf36`, engine = `b5c1a2a`, pin `44f7a51`) or a later main whose `engine\` is unchanged; `health: 200`; the only matching line is `set "ENGINE_ORDER_MANAGEMENT=shadow"`
(no `VYX_RISK_FLIP_INTENT`, no `VYX_POST_CLOSE_*` yet). The service is healthy and in shadow: that is the starting state the rollback of section 8 returns to.

### 1.4 Futurix as it is now (read-only, works before the migration)

```powershell
$q = @'
SELECT b.id, b.subdomain, b.name, count(a.id) AS accounts,
       count(a.id) FILTER (WHERE a."accountMode" = 'DEMO') AS demo, count(a.id) FILTER (WHERE a."accountMode" = 'LIVE') AS live,
       (SELECT count(*) FROM "Position" p WHERE p."brokerId" = b.id AND p.status = 'OPEN') AS open_positions
FROM "Broker" b LEFT JOIN "Account" a ON a."brokerId" = b.id WHERE b.subdomain = 'futurixglobal' GROUP BY b.id;
'@
$q | psql -X -q -d $Live
```

**Verify:** one row, `subdomain = futurixglobal`. Write down `demo`, `live` and `open_positions`: step 5 flips the `demo` accounts only.

## 2. Migration FIRST (owner PC, live database)

Two migrations, both additive and idempotent: `20261007090000_broker_risk_authority` (the `RiskAuthority` enum, `Broker.riskAuthority` default `WEB`, `Broker.riskAuthorityDemoOnly` default `true`)
and `20261007100000_risk_engine_heartbeat` (the `RiskEngineHeartbeat` table, one seed row `risk`, born stale). Constant defaults are metadata-only on Postgres 11+: no table rewrite, no long lock.
The running (old) web and the running engine ignore the new columns and the new table, so this step changes nothing by itself. **The migration MUST precede the web:** the web's Prisma client selects every `Broker` column, so a web built from this branch against a database without them fails on those queries.

### 2.1 Same shell as 1.2 (so `DATABASE_URL`, `DIRECT_URL` and `$Live` are the live ones; re-run the host check if you opened a new shell)

```powershell
cd D:\VyXTrader-Tauri\vyX
if ($env:DATABASE_URL -notmatch 'ep-morning-glade' -or $env:DIRECT_URL -notmatch 'ep-morning-glade') { throw "not the live database: stop" }
"BOTH set, both ep-morning-glade: $([bool]$env:DATABASE_URL) $([bool]$env:DIRECT_URL)"
```

### 2.2 Status first, then deploy

`migrate status` BEFORE `migrate deploy`, every time: it must list exactly the pending migrations you expect (the two above, plus `20261006120000_credit_and_trading_rights` only if main's release has not reached this database yet) and report nothing "not found locally" or failed.
If it lists anything else, STOP.

The checkout must contain the two migration folders (they come with the merge of step 3 if you merge first; for the migration alone, check out `engine/stage6` in a separate worktree, **never** in a checkout with uncommitted work):

```powershell
git fetch newrepo
git worktree add D:\vyx-stage6-migrate newrepo/engine/stage6 --detach
cd D:\vyx-stage6-migrate
npm ci
npx prisma migrate status      # first: the pending list must be what 2 says
npx prisma migrate deploy
```

(`migrate deploy` applies only the pending migrations, in order, each in its own transaction. `DATABASE_URL` and `DIRECT_URL` are inherited from the shell.)

### 2.3 Verify

```powershell
npx prisma migrate status      # "Database schema is up to date!"
$q = @'
SELECT subdomain, "riskAuthority", "riskAuthorityDemoOnly" FROM "Broker" ORDER BY subdomain;
SELECT name, "beatAt", "staleAfterSecs", "engineVersion" FROM "RiskEngineHeartbeat";
SELECT t.typname, string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder) FROM pg_type t JOIN pg_enum e ON e.enumtypid = t.oid WHERE t.typname = 'RiskAuthority' GROUP BY 1;
'@
$q | psql -X -q -d $Live
```

```powershell
@'
SELECT migration_name, finished_at FROM _prisma_migrations WHERE migration_name >= '20261006' ORDER BY finished_at, migration_name;
'@ | psql -X -q -d $Live
```

**Verify the order:** `20261006120000_credit_and_trading_rights` (if it was pending) then `20261007090000_broker_risk_authority` then `20261007100000_risk_engine_heartbeat`, `finished_at` increasing, none with a null `finished_at`.
(Proven on a scratch database in the Stage 6 verification record: plan section 13.2.)

**Verify:** every broker row reads `WEB | t`; one heartbeat row `risk` with `beatAt = 1970-01-01` and `staleAfterSecs = 30` (born stale: nobody counts an engine as alive yet); the enum is `WEB,RUST`.
`migrate status` says up to date. The old web and the old engine keep working (check `https://<web>/api/trade/prices` or the site as usual).

### 2.4 The engine's database role may write the heartbeat

The engine writes `RiskEngineHeartbeat` and the web locks it (`SELECT ... FOR SHARE` needs UPDATE privilege): both roles need `SELECT, INSERT, UPDATE` on it. If the engine and the web use the table owner this holds already.
Check it, with the role names from the two connection strings (`$EngineRole` = the user in the VPS `DATABASE_URL`, `$WebRole` = the user in Vercel's `DATABASE_URL`; read them, do not print the URLs):

```powershell
$EngineRole = "<engine role>"; $WebRole = "<web role>"
@"
SELECT r AS role, has_table_privilege(r, '"RiskEngineHeartbeat"', 'SELECT') AS sel, has_table_privilege(r, '"RiskEngineHeartbeat"', 'INSERT') AS ins, has_table_privilege(r, '"RiskEngineHeartbeat"', 'UPDATE') AS upd
FROM (VALUES ('$EngineRole'), ('$WebRole')) v(r);
"@ | psql -X -q -d $Live
```

**Verify:** `sel`, `ins`, `upd` all `t` for both roles. If not, as the database owner: `GRANT SELECT, INSERT, UPDATE ON "RiskEngineHeartbeat" TO <role>;` and re-run. (The engine also refuses risk mode at startup with a clear message when this is missing: `RISK MODE REFUSED`.)

## 3. Web deploy (merge order, Vercel Ready check)

Nothing here changes behaviour yet: every broker is WEB, so the web acts on every account exactly as before. The new code is the skip and the in-transaction check, both inert for WEB brokers.

### 3.1 The post-close secret (before the merge, so the new deployment already has it)

An engine close queues a follow-up row that the engine hands to the web's `/api/internal/post-close`; that route authenticates with `POST_CLOSE_SECRET`. The VPS gets the same value in 5.2.

```powershell
cd D:\VyXTrader-Tauri\vyX
npx vercel env ls production | Select-String 'POST_CLOSE_SECRET'
```

If the line is missing (add it; the value is generated and piped, never shown, and kept for 5.2 in `$PostCloseSecret`):

```powershell
$PostCloseSecret = (node -e "console.log(require('crypto').randomBytes(24).toString('hex'))").Trim()
$PostCloseSecret | npx vercel env add POST_CLOSE_SECRET production
"length $($PostCloseSecret.Length)"      # 48; keep this shell open until 5.2, or store the value in the owner's password manager now
```

Also needed (the stale-heartbeat alert of plan section 14.3 goes here, ops only, never to a broker): `npx vercel env ls production | Select-String 'OPS_ALERT_EMAIL'` must show it
(the Caddy check already uses it). Without it the alert is logged and not e-mailed.

If `POST_CLOSE_SECRET` already exists, you must be able to give the VPS the same value in 5.2; if you cannot, remove and re-add it here with a new value (and the engine gets that one).

### 3.2 Merge

```powershell
cd D:\VyXTrader-Tauri\vyX
git status --short                      # must be clean
git fetch newrepo
git checkout main; git merge --ff-only newrepo/main
git merge --no-ff newrepo/engine/stage6 -m "Merge engine/stage6: Stage 6 risk authority, engine-down watchdog (reviewed by the owner)"
$env:REDIS_URL = "redis://localhost:6379"
npx tsc --noEmit
npm run build
npx vitest run
```

**Verify:** the merge has no conflicts; `tsc` clean; `npm run build` passes (tsc and tests alone are not enough: Vercel failed once on an optional route argument); vitest green.
Note the merge commit: `git rev-parse HEAD` (call it `<MERGE>`). It is the engine pin of section 4. Push (**`newrepo/main` is Vercel production**):

```powershell
git push newrepo main
```

### 3.3 Vercel Ready check

```powershell
npx vercel ls | Select-Object -First 6        # the newest production deployment must say "Ready" (not Building / Error)
$Web = "https://<production origin>"           # any host served by this deployment
foreach ($p in '/api/internal/pending-trigger', '/api/internal/post-close') { "$p -> $((try { (Invoke-WebRequest -UseBasicParsing -Method Get -Uri ($Web + $p) -TimeoutSec 15).StatusCode } catch { [int]$_.Exception.Response.StatusCode }))" }
```

**Verify:** the deployment is `Ready` and built from `<MERGE>`; `/api/internal/pending-trigger` answers **401** (the new route exists and wants its bearer), `/api/internal/post-close` answers 401/405 (not 404/500). Within 5 minutes the cron `margin-monitor` shows `200` in `npx vercel logs <deployment-url>`.
**The 1-minute fallback cron:** Vercel project, Settings, Cron Jobs must list `/api/internal/risk-fallback` with `* * * * *` next to `/api/internal/margin-monitor` `*/5 * * * *`. (Vercel allows a 1-minute cron on the Pro plan; the existing `*/5` entries show the project is not on Hobby, where only daily crons deploy.)
Within 2 minutes `npx vercel logs <deployment-url>` shows `GET /api/internal/risk-fallback 200` once a minute. With no broker RUST yet it must return at once and cost no database read (it answers "no broker is on the engine"), and over a quiet weekend it returns at the idle gate before any database read.
The site works (login page loads, a trader can see prices). Check the migration-first rule held: no `riskAuthority` errors in the logs (`npx vercel logs <deployment-url> | Select-String 'riskAuthority|risk-owner'` returns nothing).

## 4. Engine deploy on the VPS (shadow mode, risk mode NOT active)

Same procedure as `deploy/engine-2026-10-05.ps1`: pinned commit, `engine\` byte-identical to the pin, markers of the reviewed code, build in a separate target dir, swap, `/health`, startup-log checks, automatic restore on any failure. The new script is `deploy/engine-stage6.ps1`.
It refuses to run unless `start-engine.cmd` says `ENGINE_ORDER_MANAGEMENT=shadow` and carries no `VYX_RISK_FLIP_INTENT`, and it fails (and restores the old exe) if the new build starts in risk mode or prints the flip-marker warning.

### 4.1 Pin the script (owner PC, in the merge worktree), push, then run on the VPS

```powershell
cd D:\VyXTrader-Tauri\vyX
(Get-Content deploy\engine-stage6.ps1 -Raw) -replace '<FILL IN: the commit of main that merged engine/stage6>', (git rev-parse HEAD) | Set-Content deploy\engine-stage6.ps1 -NoNewline
git add deploy/engine-stage6.ps1; git commit -m "Pin deploy/engine-stage6.ps1 to the Stage 6 merge"; git push newrepo main
```

On the VPS (elevated PowerShell):

```powershell
cd C:\vyxtrader\repo; git fetch --all; git checkout --detach newrepo/main
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-stage6.ps1
```

(The pin of the script is the merge commit; a later commit on `main` that changes `engine\` makes the script stop with "differs from the pin": re-pin first.)

**Verify:** the last line is `DEPLOY OK (shadow mode, risk mode NOT active)`; every `OK  ...` check line printed; no `RISK MODE`, no `risk heartbeat`, no `WARNING` line in the startup lines. Then:

```powershell
"health: $((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health).StatusCode)"
Q @'
SELECT name, "beatAt" FROM "RiskEngineHeartbeat";
'@     # from the owner PC: still 1970-01-01 (shadow never beats)
```

and watch `Get-Content <engine log> -Tail 50` for 10 minutes: `idle gate:` lines and shadow passes as before, no `ERROR`. The shadow soak continues exactly as before (the engine is the same code path in shadow mode).

## 5. The flip

### 5.0 Go / no-go (every line must be yes; otherwise stop)

* [ ] 1.1 soak gate met (7 clean days, 2 weekend reopens, 1 NFP, 0 unexplained) and the local sweep of 10.1 recorded PASS on this exact commit.
* [ ] Sections 2, 3 and 4 done and verified; the engine is healthy in shadow.
* [ ] A weekday, market open, the owner present, 3 uninterrupted hours; Futurix's `demo` account count and `open_positions` noted (1.4).
* [ ] Rollback statement (8, "per broker") open in a second window, ready to paste.

### 5.1 Prepare the VPS environment (the engine is still shadow; nothing is read until the restart)

On the VPS. Four variables are added or changed; a backup of `start-engine.cmd` is kept:

| Variable | Value | Why |
|---|---|---|
| `ENGINE_ORDER_MANAGEMENT` | `risk` | risk mode (replaces the shadow in the same process) |
| `VYX_RISK_FLIP_INTENT` | `futurixglobal:<YYYY-MM-DD of today>` | the flip marker: without it the engine logs a WARNING (a live mode must be meant) |
| `VYX_POST_CLOSE_URL` | `<web>/api/internal/post-close` | where engine closes are delivered |
| `VYX_POST_CLOSE_SECRET` | the secret of 3.1 | the same value as Vercel's `POST_CLOSE_SECRET` |
| `VYX_RISK_HEARTBEAT_PAUSE_FILE` | `C:\vyxtrader\risk-heartbeat.pause` | the drill switch of section 7 (inert while the file does not exist) |

```powershell
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
Copy-Item $EngineCmd "$EngineCmd.pre-stage6-$(Get-Date -Format yyyyMMdd-HHmmss)"
function Set-CmdVar([string]$Path, [string]$Name, [string]$Value) {
  $lines = @(Get-Content $Path); $pat = '^\s*set\s+"?' + [regex]::Escape($Name) + '='; $new = 'set "' + $Name + '=' + $Value + '"'
  if ($lines -match $pat) { $lines = $lines | ForEach-Object { if ($_ -match $pat) { $new } else { $_ } } }
  else { $i = ($lines | Select-String '^\s*set\s' | Select-Object -Last 1).LineNumber; $list = [System.Collections.ArrayList]@($lines); $list.Insert($i, $new); $lines = $list.ToArray() }   # a new line right after the last `set` line
  Set-Content -Path $Path -Value $lines -Encoding ASCII
}
$sec = Read-Host "POST_CLOSE_SECRET (the value of 3.1)" -AsSecureString
$plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
Set-CmdVar $EngineCmd "ENGINE_ORDER_MANAGEMENT" "risk"
Set-CmdVar $EngineCmd "VYX_RISK_FLIP_INTENT" "futurixglobal:$(Get-Date -Format yyyy-MM-dd)"
Set-CmdVar $EngineCmd "VYX_POST_CLOSE_URL" "https://<production origin>/api/internal/post-close"
Set-CmdVar $EngineCmd "VYX_POST_CLOSE_SECRET" $plain
Set-CmdVar $EngineCmd "VYX_RISK_HEARTBEAT_PAUSE_FILE" "C:\vyxtrader\risk-heartbeat.pause"
$plain = $null
Get-Content $EngineCmd | Select-String 'ENGINE_ORDER_MANAGEMENT|VYX_RISK_FLIP_INTENT|VYX_POST_CLOSE|VYX_RISK_HEARTBEAT' | ForEach-Object { $_.Line -replace '(SECRET=).*','$1<hidden>' }
```

**Verify:** the printout shows the five variables (secret hidden). `VYX_SHADOW_DATABASE_URL` stays as it is (risk mode ignores it and says so in the log).

### 5.2 Restart in risk mode (no broker is RUST yet: the engine owns nothing)

```powershell
$Nssm = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$log = ((& $Nssm get vyxtrader-engine AppStdout) -join "" -replace "`0","").Trim()
$from = @(Get-Content $log).Count
& $Nssm restart vyxtrader-engine
Start-Sleep 25
"health: $((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health).StatusCode)"
Get-Content $log | Select-Object -Skip $from | Select-String 'RISK MODE|risk mode|risk heartbeat|post-close outbox|risk authority|flip marker|WARNING: ENGINE_ORDER' | ForEach-Object { $_.Line -replace "$([char]27)\[[0-9;]*m",'' }
```

**Verify (all of these, in this start's lines):**

* `risk mode: the pool is writable`
* `risk heartbeat: written; the engine counts as down for the web when it is older than staleAfterSecs`
* `post-close outbox dispatcher running`
* `risk mode: the hook sends SL / TP touches and crossings of engine-owned accounts to the engine; the web call skips them`
* `risk mode: margin fires of engine-owned accounts are evaluated by the engine on the tick (unpinned, live)`
* `RISK MODE ACTIVE: ...`
* `flip marker present: a live mode is intended for this process` and **no** `WARNING: ENGINE_ORDER_MANAGEMENT=` line
* **no** `RISK MODE REFUSED` line. If it is there, nobody is harmed (no broker is RUST); fix the reason it prints, or go to the rollback of step 5.

Heartbeat check (owner PC): run `Q 'SELECT now() - "beatAt" AS age, "staleAfterSecs", "engineVersion", instance FROM "RiskEngineHeartbeat";'` (defined in 2.1): `age` is a few seconds.
(While the idle gate is closed, i.e. weekend, flat book or no fresh tick on a held symbol, the timer does not beat on purpose: see the plan, section 14. `age` can then be large and that is expected. The first fire or pass touches it.)

**Consequence to accept (owner answer (a), 2026-10-06):** risk mode REPLACES the shadow in the process. The soak instrumentation for WEB-owned accounts stops at this restart; the bot sweep is the regression check from here on. See the plan, section 15, for what running the shadow alongside would cost.

### 5.3 The canary: zzshadowbot first, then the sweep (section 10.2)

Before Futurix, flip the bot's tenant (its accounts are demo or are checked to be) and run the live 7-path sweep on this exact build in RUST mode. Same statement as 5.4 with `zzshadowbot` instead of `futurixglobal`
(verify first that the bot accounts are DEMO: the 5.4 ownership query with `WHERE b.subdomain = 'zzshadowbot'`). When 10.2 PASSES, continue; when it fails, set `zzshadowbot` back to WEB (8) and stop.

### 5.4 The flip (Futurix, RUST + demo-only), audited

One statement, one transaction, with its audit row (`action = RISK_AUTHORITY_CHANGE`, the old and new values). Only the broker's DEMO accounts move to the engine; LIVE accounts stay with the web.

```powershell
$flip = @'
WITH old AS (SELECT id, "riskAuthority"::text AS authority, "riskAuthorityDemoOnly" AS demo_only FROM "Broker" WHERE subdomain = 'futurixglobal' FOR UPDATE),
     upd AS (UPDATE "Broker" b SET "riskAuthority" = 'RUST', "riskAuthorityDemoOnly" = true FROM old WHERE b.id = old.id
             RETURNING b.id, b.subdomain, b."riskAuthority", b."riskAuthorityDemoOnly")
INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "oldValue", "newValue", "createdAt")
SELECT 'stage6-' || replace(gen_random_uuid()::text, '-', ''), old.id, 'RISK_AUTHORITY_CHANGE', 'Broker', old.id,
       jsonb_build_object('riskAuthority', old.authority, 'riskAuthorityDemoOnly', old.demo_only),
       jsonb_build_object('riskAuthority', 'RUST', 'riskAuthorityDemoOnly', true, 'runbook', 'STAGE6-RUNBOOK-FUTURIX-DEMO 5.4'), now()
FROM old JOIN upd ON upd.id = old.id
RETURNING "brokerId", action, "newValue";
'@
$flip | psql -X -q -d $Live
```

**Verify:** exactly one row returned (`RISK_AUTHORITY_CHANGE`). Within about 5 s the engine log says `risk authority: 1 broker(s) are RUST-owned (...)` (the zzshadowbot canary counts as one more if it is still RUST: then `2 broker(s)`).
Who owns what, by the database's own rule, with the engine's liveness counted:

```powershell
$own = @'
WITH alive AS (SELECT COALESCE((SELECT clock_timestamp() - h."beatAt" <= make_interval(secs => h."staleAfterSecs") FROM "RiskEngineHeartbeat" h WHERE h.name = 'risk'), false) AS ok)
SELECT a."accountMode", b."riskAuthority", b."riskAuthorityDemoOnly", (SELECT ok FROM alive) AS engine_alive,
       CASE WHEN b."riskAuthority" = 'RUST' AND (b."riskAuthorityDemoOnly" = false OR a."accountMode" = 'DEMO') AND (SELECT ok FROM alive) THEN 'ENGINE' ELSE 'WEB' END AS owner,
       count(*) AS accounts,
       count(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Position" p WHERE p."accountId" = a.id AND p.status = 'OPEN')) AS with_open_positions
FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" WHERE b.subdomain = 'futurixglobal' GROUP BY 1, 2, 3, 4, 5;
'@
$own | psql -X -q -d $Live
```

**Verify:** `DEMO` rows `owner = ENGINE`, `LIVE` rows `owner = WEB`, `engine_alive = t`. If a LIVE row says ENGINE, or a DEMO row says WEB while `engine_alive = t`, **STOP and set the broker back to WEB (8).**

### 5.5 First verification: who closed what (run it again after every trigger you can see)

An engine close always queues a follow-up row (`PostCloseEffect`) in the same transaction; a web close never does. So the side of every automatic close is visible in the database:

```powershell
$who = @'
SELECT t."createdAt", acc."accountNumber", acc."accountMode", t."referenceId" AS position, left(t.note, 40) AS note,
       CASE WHEN e.id IS NULL THEN 'WEB' ELSE 'ENGINE' END AS closed_by
FROM "Transaction" t
JOIN "Account" acc ON acc.id = t."accountId"
JOIN "Broker" b ON b.id = t."brokerId"
LEFT JOIN "PostCloseEffect" e ON e."positionId" = t."referenceId" AND e.kind = 'POSITION_CLOSED'
WHERE b.subdomain = 'futurixglobal' AND t.type = 'TRADE_PNL'
  AND (t.note LIKE 'Stop-out%' OR t.note LIKE 'Stop loss%' OR t.note LIKE 'Take profit%')
  AND t."createdAt" > now() - interval '1 day'
ORDER BY t."createdAt" DESC;
'@
$who | psql -X -q -d $Live
```

**Verify:** every automatic close of a DEMO account created AFTER the flip is `ENGINE`; every LIVE account's is `WEB`. An `ENGINE` row on a LIVE account, or a `WEB` row on a DEMO account created after the flip while `engine_alive = t`, means **STOP: set the broker back to WEB (8) and keep the row.**
The follow-ups must all end `DONE`, none `DEAD`:

```powershell
Q @'
SELECT kind, status, count(*), max("createdAt") AS newest FROM "PostCloseEffect" WHERE "createdAt" > now() - interval '1 day' GROUP BY 1, 2 ORDER BY 1, 2;
'@
```

Margin calls of engine-owned accounts arrive as `MARGIN_CALL` / `MARGIN_CALL_CLEARED` rows (the notification follows when the row is `DONE`).

## 6. What to watch, and for how long

**First 15 minutes (every minute), then the first hour (every 5 minutes), then hourly through the trading day:**

| Watch | Query / place | Healthy |
|---|---|---|
| heartbeat age | `SELECT now() - "beatAt" AS age FROM "RiskEngineHeartbeat" WHERE name = 'risk';` | under 10 s while the market is open and a demo account holds a position |
| who closed what | 5.5 | DEMO = ENGINE, LIVE = WEB |
| nobody closed twice | `SELECT "referenceId", count(*) FROM "Transaction" WHERE type = 'TRADE_PNL' AND "createdAt" > now() - interval '1 day' GROUP BY 1 HAVING count(*) > 1;` | **no rows, ever** |
| follow-ups delivered | the `PostCloseEffect` query of 5.5 | all `DONE`, none `DEAD`, `newest` recent after a close |
| engine errors | `Get-Content $log -Tail 600 \| Select-String 'ERROR\|panicked\|live fire: evaluation failed\|heartbeat'` | nothing new; a `risk heartbeat: beat failed` line means the engine is about to count as down |
| web still healthy | `npx vercel logs <deployment-url>`: `margin-monitor` 200 every 5 min, no `risk-owner` errors | |
| margin calls | the `MARGIN_CALL` rows and the demo trader's notification | one call per episode, one "over" notice |
| the engine's own view | log lines `risk authority: N broker(s)`, `idle gate:` | |
| the 1-minute fallback | Vercel log `risk-fallback`: 200 every minute | while the heartbeat is fresh it answers "engine heartbeat fresh" and runs no pass; a `ran: true` line means the engine was counted as down at that minute |
| the ops alert | the ops mailbox (`OPS_ALERT_EMAIL`) | silence while healthy; ONE "Risk engine heartbeat is STALE" mail per outage and ONE "back" mail after a minute of fresh beats; never any broker notification |

**How long:** the whole first trading day closely; then a full trading week of demo that includes a Friday close and the Sunday reopen, before step 9 is even discussed. **Failure signs, any one of which means: set the broker back to WEB (8), keep the evidence, tell me:**
a duplicate `TRADE_PNL`; a close by the wrong side; a `DEAD` follow-up; a position that stayed open while its price was past its SL / stop-out for more than a few seconds (backoffice Risk Radar); `RISK MODE REFUSED` or `risk heartbeat: beat failed` in the log; a heartbeat older than 60 s during market hours with a position held.

## 7. The WEB-fallback drills (run both before the week of watching is over)

### 7.A The manual drill: RUST -> WEB by the owner

The statement of section 8, "per broker" (audited). **Confirm the web picks up the next stop-out** (use the drill account of 7.0; this is the drill on the live system):

1. within one backstop interval (5 s) the web's `margin-monitor` pass evaluates the account (Vercel log: `margin-monitor` 200);
2. run 5.5: the new close shows `closed_by = WEB` (no `PostCloseEffect` row), exactly one `TRADE_PNL` per position;
3. nothing doubled and nothing missed:

```powershell
Q @'
SELECT "referenceId", count(*) FROM "Transaction" WHERE type = 'TRADE_PNL' AND "createdAt" > now() - interval '15 minutes' GROUP BY 1 HAVING count(*) > 1;
'@   # must return no rows
Q @'
SELECT count(*) AS still_open FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Broker" b ON b.id = a."brokerId" WHERE p.status = 'OPEN' AND b.subdomain = 'futurixglobal' AND a."accountMode" = 'DEMO';
'@
```

Going back to the engine afterwards is the 5.4 statement again.

### 7.0 The drill account

A dedicated Futurix DEMO account (`<DRILL_ACCT>`, an account number of 1.4's demo accounts) with a small balance. The controllable trigger is an **SL touch**: open a position on gold and set its stop-loss
a very small distance from the market so it is hit within a minute or two (a stop-out works the same way if you size the balance so that the margin level crosses the group's stop-out on a 2 to 5 USD move; an SL is easier to time). Note the position ids.

### 7.B The watchdog drill: the engine is alive but counts as DOWN (the heartbeat stops)

This is the drill for the hard gate of step 9. The pause file makes the engine stop writing its heartbeat (the timer and the touches both go through the same switch) while market data, the hook and the backstop keep running, so prices stay fresh. After `staleAfterSecs` (30 s) the engine counts as down: the web owns every RUST account and the engine refuses to act inside its own transactions.

```powershell
# VPS: the engine stalls
New-Item C:\vyxtrader\risk-heartbeat.pause -ItemType File -Force | Out-Null
```

1. **Baseline** (before the file): the 5.4 ownership query says `ENGINE`, `engine_alive = t`; the heartbeat `age` is a few seconds.
2. **Stale:** after about 35 s the ownership query says `engine_alive = f` and every account `WEB`; the engine log shows `risk heartbeat PAUSED by the drill file`.
3. **The web handles the next stop-out:** open the drill position (7.0) with its tight SL. Within one backstop interval (5 s) of the touch the web's `margin-monitor` pass closes it. Evidence, all three:
   * Vercel log: `margin-monitor` 200 at that time;
   * DB: the 5.5 query shows `closed_by = WEB` for it (a `TRADE_PNL` row, a note starting `Stop loss`, and **no** `PostCloseEffect` row for the position);
   * the engine took no action: `SELECT count(*) FROM "PostCloseEffect" WHERE "positionId" = '<position id>';` is `0`.
4. **Nothing doubled:** the "nobody closed twice" query of section 6 returns no rows; `SELECT count(*) FROM "Transaction" WHERE "referenceId" = '<position id>' AND type = 'TRADE_PNL';` is exactly `1`.
5. **The engine returns:**

```powershell
Remove-Item C:\vyxtrader\risk-heartbeat.pause
```

   Within a few seconds the heartbeat `age` drops (the timer beats again while the idle gate is open; a fire or a pass touches it) and the ownership query says `ENGINE` again.
6. **No duplicate after the return:** open a SECOND drill position with a tight SL: it is closed by the **engine** (`closed_by = ENGINE`, a `PostCloseEffect` row, delivered `DONE`), and the duplicate query still returns no rows. Both sides handled one stop-out each, once.

7. **The ops alert (plan 14.3):** the web evaluates the heartbeat once a minute while a broker is RUST and trading is active. After the pause file has held the heartbeat stale for two consecutive minute-checks (about 2 minutes) exactly ONE mail arrives at `OPS_ALERT_EMAIL`, subject "Risk engine heartbeat is STALE: the web has taken over"; no second mail while it stays stale; the broker's backoffice shows nothing new.
   After step 5 (the file removed) a minute of fresh checks later exactly ONE "Risk engine heartbeat is back" mail arrives. A pause shorter than 2 minutes raises nothing (debounce).
8. **The 1-minute fallback in the same drill:** the Vercel log shows `risk-fallback` answering `ran: true` while the heartbeat is stale (that pass is what took the stop-out in step 3 if the touch came between two backstop calls) and `skipped: engine heartbeat fresh` after the return.

**PASS** = steps 3, 4, 6, 7 and 8 hold. **FAIL** (any duplicate, an engine close while stale, a stop-out nobody closed for more than ~40 s after the touch) = set the broker WEB (8) and tell me.

Latency note, honestly: the web's fallback reaches the account at the next web risk evaluation. While the engine's process is alive that is the engine's own 5 s backstop calling the web's full pass (as in this drill). If the whole engine
process is dead, its backstop is dead too and the only web trigger left is the Vercel cron (every 5 minutes), and its price feed is dead as well (the engine hosts the price ingest, so no fresh price reaches anyone). See plan section 14.

## 8. Rollback at every step

| Step | Rollback | How | Note |
|---|---|---|---|
| 1 | none | nothing was changed | |
| 2 migration | none needed | the columns and the table are additive and idempotent; leave them, every broker is WEB | never drop them while any code reads them. If `migrate deploy` stops half way, re-run it (idempotent); a migration recorded as failed: `npx prisma migrate resolve --rolled-back <name>`, then re-run |
| 3 web | the previous Vercel deployment | `npx vercel ls`, then `npx vercel promote <previous Ready deployment url>` (or the dashboard's "Promote to Production") | safe only while **every broker is WEB**: a web without this change does not skip engine-owned accounts and would double-act. Flip every broker to WEB first if any is RUST |
| 4 engine | the old exe | the script restores it by itself on a failed check; manually: `nssm stop vyxtrader-engine`, copy `C:\vyxtrader\backup\engine-stage6-<stamp>\trading-core-server.pre.exe` over `C:\vyxtrader\repo\engine\target\release\trading-core-server.exe`, `nssm start vyxtrader-engine` | no schema change involved |
| 5 flip (per broker) | back to WEB | the statement below | seconds, no restart; a transaction the engine had in flight finishes first, everything after is the web's |
| 5.2 risk mode (engine) | back to shadow | **first** every broker to WEB (statement below), **then** restore `start-engine.cmd.pre-stage6-*` and `nssm restart vyxtrader-engine` | the other order leaves RUST brokers with NO owner |
| 9 demo-only off | back to demo-only, or WEB | the statements below | |

Per broker, audited (Futurix; for zzshadowbot replace the subdomain):

```powershell
$web = @'
WITH old AS (SELECT id, "riskAuthority"::text AS authority, "riskAuthorityDemoOnly" AS demo_only FROM "Broker" WHERE subdomain = 'futurixglobal' FOR UPDATE),
     upd AS (UPDATE "Broker" b SET "riskAuthority" = 'WEB' FROM old WHERE b.id = old.id RETURNING b.id)
INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "oldValue", "newValue", "createdAt")
SELECT 'stage6-' || replace(gen_random_uuid()::text, '-', ''), old.id, 'RISK_AUTHORITY_CHANGE', 'Broker', old.id,
       jsonb_build_object('riskAuthority', old.authority, 'riskAuthorityDemoOnly', old.demo_only),
       jsonb_build_object('riskAuthority', 'WEB', 'riskAuthorityDemoOnly', old.demo_only, 'runbook', 'STAGE6-RUNBOOK-FUTURIX-DEMO 8'), now()
FROM old JOIN upd ON upd.id = old.id
RETURNING "brokerId", action, "newValue";
'@
$web | psql -X -q -d $Live
```

Demo-only back on (step 9's undo): the 9.2 statement with `'riskAuthorityDemoOnly' = true`. If the owner needs the fastest possible fallback and psql is not at hand: `UPDATE "Broker" SET "riskAuthority" = 'WEB' WHERE subdomain = 'futurixglobal';` from any SQL console (no audit row: write one by hand afterwards).

## 9. Later: `riskAuthorityDemoOnly = false` (the engine owns Futurix's LIVE accounts too)

**Gated on the watchdog (the owner's hard gate, answer (b), 2026-10-06).** All of these must be true; the demo phase itself may use manual monitoring, this step may not:

* [ ] The watchdog code is live on the VPS and the web (steps 3 and 4 of this runbook): the heartbeat row, the stale-means-WEB rule on both sides, the in-transaction heartbeat check on both sides.
* [ ] The 7.B drill PASSED on the live system in demo, once, and 7.A too.
* [ ] A full trading week of demo (including a Friday close and the Sunday reopen) with the section 6 checks clean: no duplicate, no wrong-side close, no `DEAD` follow-up.
* [ ] The final 7-path sweep (10.2) is clean on the build that is running now.
* [ ] An alert exists for a stale heartbeat during market hours (it is not built: the plan lists it as an open decision; until then someone watches `age` every few minutes on the day of the flip and the first week).
* [ ] The owner has decided the Vercel cron cadence while any broker is RUST (plan, section 14: every 5 minutes today; the fallback latency when the whole engine process is down).

### 9.1 The statement

```powershell
$all = @'
WITH old AS (SELECT id, "riskAuthority"::text AS authority, "riskAuthorityDemoOnly" AS demo_only FROM "Broker" WHERE subdomain = 'futurixglobal' AND "riskAuthority" = 'RUST' FOR UPDATE),
     upd AS (UPDATE "Broker" b SET "riskAuthorityDemoOnly" = false FROM old WHERE b.id = old.id RETURNING b.id)
INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "oldValue", "newValue", "createdAt")
SELECT 'stage6-' || replace(gen_random_uuid()::text, '-', ''), old.id, 'RISK_AUTHORITY_CHANGE', 'Broker', old.id,
       jsonb_build_object('riskAuthority', old.authority, 'riskAuthorityDemoOnly', old.demo_only),
       jsonb_build_object('riskAuthority', 'RUST', 'riskAuthorityDemoOnly', false, 'runbook', 'STAGE6-RUNBOOK-FUTURIX-DEMO 9.1'), now()
FROM old JOIN upd ON upd.id = old.id
RETURNING "brokerId", action, "newValue";
'@
$all | psql -X -q -d $Live
```

**Verify:** one row; the 5.4 ownership query now says `ENGINE` for DEMO and LIVE; repeat 5.5 and section 6: every automatic close of the broker is now `ENGINE`. Run 7.B once more on the first day (LIVE accounts now fall back to the web on a stale heartbeat as well).
**Undo:** section 8 ("demo-only back on", or WEB).

## 10. The final 7-path sweep on the exact cutover build, RUST mode

The shadow bot (branch `shadow-bot`, `tools/shadow-bot`, machine `DESKTOP-JQ2J7SM`) drives seven scenarios against the `zzshadowbot` tenant: S1 single stop-out, S2 fan-in, S3 hedge break, S4 hedged + NBP, S5 coverage, S6 mirror, S7 FX. It cannot be pointed at a scratch database (its hosts are hard-coded in `src/guards.ts`), so there are two runs of the same seven paths.

### 10.1 Local first, on the scratch harness DBs (`D:\pg-scratch`, port 5499), on the commit that will be merged

```bash
cd /d/vyx-stage6
bash scripts/stage6/sweep-7path.sh            # about 15 minutes; accounts 150, walkers 2
```

It runs the real web risk routines and the real engine passes and post-close dispatcher against one database, `run-split.sh` variants `rust-all` (seeds 1 to 3: every account engine-owned), `mixed`, the WEB-fallback drill and the engine-stall drill, and for each run prints the seven paths with the number of times the ENGINE took each one (`scripts/stage6/sweep-paths.mjs`).
**PASS** = every run `PASS` and, per run, all seven path lines `PASS` (count above zero), the end state equal to the web-only reference id by id, exactly-once held (one `TRADE_PNL` per position, every outbox row `DONE` once), no action by the wrong side, and ZERO web actions in the all-engine runs. The recorded results are in `docs/STAGE6-PLAN.md`, section 13.

### 10.2 Live, with the real bot (between 5.2 and the Futurix flip)

On the exact cutover build: the engine in risk mode (5.2), zzshadowbot RUST + demo-only (5.3). First verify that the bot accounts are DEMO accounts of the flipped tenant (5.4's ownership query with `zzshadowbot`: `49990001`-`49990013` must show `ENGINE`; the hedge account `49990099` is the broker's and the bot never signs into it).

```powershell
cd C:\shadow-bot
$env:SHADOWBOT_PASSWORD = "<held by the owner>"; $env:SYNTH_FEED_SECRET_FILE = "<path to the copied synth-feed-secret.txt>"
foreach ($s in 's1-single-stopout','s2-fan-in','s3-hedge-break','s4-hedged-nbp','s5-coverage','s6-mirror','s7-fx') {
  npx tsx tools/shadow-bot/bot.ts run $s --flatten-first
  "$s exit code: $LASTEXITCODE"
}
```

Each scenario ends with a 90 s settle (so the sweep is about 15 minutes). **PASS** = all seven exit `0` (the journal `logs\run-<UTC>.jsonl` ends `run.end ... PASS`), and, from the database (5.5 with `WHERE b.subdomain = 'zzshadowbot'`):
every automatic close of a bot account since the sweep started is `ENGINE` (zero `WEB`), no `TRADE_PNL` twice, every `PostCloseEffect` `DONE`, the S3 margin-call notice present and the S5 coverage leg closed once, the S7 EUR account closed at the converted price, the S4 account not written off.
**FAIL** = anything else: set `zzshadowbot` back to WEB (8) and stop; the Futurix flip does not happen.
