# Engine deploy 2026-10-05: idle gate + pricing cache + D8 (+ the held 10-01 fixes) (VPS runbook)

**This supersedes `deploy/engine-2026-10-01-runbook.md` and its script, which were never run.** Everything the 10-01
deploy carried is in this build. The script is `deploy/engine-2026-10-05.ps1`.

**What ships** (branch `engine/pricing-cache` on darkkk001/vyX, merged into `main` as `44f7a51` on 2026-10-05):

| # | Change | Commits |
|---|---|---|
| 1 | Margin-call flap: overlapping-episode matcher, 5 s damping defers instead of dropping (the 10-01 deploy) | `4e9bb50` + `ee3bb23` |
| 2 | Torn pinned read: every read of an evaluation in one `REPEATABLE READ, READ ONLY` snapshot (the 10-01 deploy) | `51de153` |
| 3 | Idle gate: a symbol counts as fresh only when its quote MOVED; a heartbeat resend of a frozen quote never opens a gate, v\* ticks never do; a frozen quote is not re-evaluated on every heartbeat | `86a4adc` |
| 4 | Pricing cache: ask-rule configuration in memory, reloaded on `config.changed` / `account.updated` (debounced), on a lost event or reconnect, and every 10 min only while something real moves. No book query joins a pricing table or LivePrice. The shadow pass reads its whole book in one snapshot | `d4743a4` + `65d1908` + `08ce631` |
| 5 | D8: account types take no part in the engine's ask rule (web D4 parity); the vectors test pins the web's 12 cases | `76fe899` (= `3338c72`, merged `d554292`) |
| 6 | Broker counter (**droppable**): the reconciler fills in the broker of pairs stored without one since the soak start; grant file carries `Broker.subdomain` | `b5c1a2a` |

**The pin.** Re-pinned on 2026-10-05 to **`44f7a51`**, the merge of `engine/pricing-cache` into `main` (the owner
chose "merge to main first"; `b5c1a2a` kept). Its `engine\` is byte-identical to `b5c1a2a`'s, the reviewed and tested
code (`git diff --quiet b5c1a2a 44f7a51 -- engine` is empty). The script requires HEAD to contain `44f7a51` and HEAD's
`engine\` to equal its. Any later engine change on `main` means re-pinning `$Fix` and section 1 first. A pin that
doesn't match makes the script stop with "Nothing touched".

It changes the engine binary `trading-core-server.exe` only. There is no schema change and no env change. These stay
as they are: `start-engine.cmd`; `ENGINE_ORDER_MANAGEMENT` (stays `shadow`); every DB URL and every secret;
`VYX_SHADOW_PASS_SECS` and `VYX_RISK_TRIGGER_MS`. The only database step is the optional one-line grant of section 5.

**The web.** Not touched by this deploy. #123's root cause, the web sending MARGIN_CALL twice, is fixed on the web
side by `ce25b5d`, live in production since 2026-10-05 04:49 UTC (main `c691bf1`).

**Before / after:**

| Case | Before (live, 2026-10-03..05) | After (this build, scratch DB, measured) |
|---|---|---|
| Shadow pass, statements per pass (`tests/pricing_cache_db.rs`, sqlx's own per-statement events) | 1 + 7 per account (29 at 4 accounts, 141 at 20); live: the book query ~1/s, TradingSession ~1/s over 45 h | **4, whatever the book size** (SET, positions, sessions, ROLLBACK); the pass book decides on exactly `load_book_state`'s numbers |
| Weekend, gold-only book, Friday's quote resent every 5 s (no tick_ms / future tick_ms / offset re-sync / two feeds) | gate open all weekend: backstop every 5 s, margin-monitor 30.7k calls in 45 h | gate closed at every probe, 0 backstop web calls (`activity.rs`, `risk_hook.rs` weekend tests) |
| Pricing configuration reads | joined into every book row (~2.3 M pricing reads in 45 h) | one cached snapshot; 0 reloads while nothing moves; an announced change is picked up at once |
| 50005708 margin-call flaps (10-01) | 1 WEB_ONLY + 5 TIMING | 8 MATCH + 3 SNAPSHOT, 0 WEB_ONLY (`tests/reconcile_flap_db.rs`) |
| 49990004 a4 stop-out, torn read (10-01) | no decision, WEB_ONLY | stop_out at 45.48 % (`tests/torn_read_db.rs`) |

**Verification on scratch** (2026-10-05, at `b5c1a2a`): engine workspace 360 passed / 0 failed / 1 ignored; parity
`run-db.sh` 27/27 MATCH; Stage 5 shadow gate (`scripts/load/shadow-gate.sh --seed 1 --accounts 100`, the production
grant file including the new subdomain line, the shadow as the read-only role) GREEN: 38 passes, 221 decisions, 147
web risk closes, MATCH 133 / PREEMPTED 45 / TIMING 43, 0 unexplained.

## Rules

- Run in an **elevated** Windows PowerShell on the VPS, except section 5 and the pg_stat_statements check in section
  3, which run on the owner's PC against live Neon.
- Nothing below prints a secret: URLs are read into variables, and only lengths, host or database names and counts
  are shown. The `-U postgres` commands let psql ask for the password itself.
- `nssm` is not on the VPS PATH. Always use `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`.
- Note the deploy time (UTC) printed in step 2. Section 3 uses it.
- Section 5 (the grant) can run **before** the deploy. The running engine's reconciler then starts attributing new
  pairs straight away, and the new build backfills the old ones.

## 0. Before the deploy: which row holds the soak clock, and the four rows to excuse (read-only)

Read-only, with the engine's own store URL from `start-engine.cmd`:
```powershell
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
function Get-CmdVar([string]$Path, [string]$Name) { $l = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1; if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() } }
$u = Get-CmdVar $EngineCmd "VYX_SHADOW_STORE_URL"; if (-not $u) { $u = Get-CmdVar $EngineCmd "MARKET_DATA_DATABASE_URL" }
"store url length: $($u.Length)"
$sql = @'
SET default_transaction_read_only = on;
SELECT p.id, p.class, p.kind, p.account_id, p.created_at AS holds_the_clock_since FROM shadow_pair p
 WHERE p.class IN ('VALUE','ENGINE_ONLY','WEB_ONLY') AND NOT EXISTS (SELECT 1 FROM shadow_excuse e WHERE e.pair_id = p.id)
 ORDER BY p.created_at DESC LIMIT 5;
SELECT id, class, kind, account_id, position_id, to_char(web_at,'YYYY-MM-DD HH24:MI:SS.MS') web_at,
       EXISTS (SELECT 1 FROM shadow_excuse e WHERE e.pair_id = shadow_pair.id) AS excused
  FROM shadow_pair WHERE id IN (98, 109, 118, 123) ORDER BY id;
'@
$sql | psql -X -q $u
```
Expected, second query: exactly these four rows, none excused yet:

| id | class | kind | account / position | web_at (UTC) |
|---|---|---|---|---|
| 98 | WEB_ONLY | margin_call_in | `cmuexlh9r0001jp04yrfxqq9f` (50005708) | 2026-10-01 04:20:04.9xx |
| 109 | WEB_ONLY | stop_out | position `cmup6pjmo000ll004h45kcfob` (49990004, a4) | 2026-10-01 07:00:10.8xx |
| 118 | WEB_ONLY | stop_out | 49990002 (`cmuhzby3i0026vczwnye5eswv` or `cmuhzbyan002avczwra22jvxg`) | 2026-10-02 12:10:04.626 |
| 123 | WEB_ONLY | margin_call_in | 49990003 (the other of those two) | 2026-10-02 12:20:45.221 |

If any row differs (other class, kind, account or time), stop: section 4's inserts check all of these and would insert
nothing for it, and that row needs a decision first.

## 1. Get the code (HEAD must carry every change)

```powershell
cd C:\vyxtrader\repo
if (git status --porcelain) { throw "working tree not clean: stop and report" }
git fetch --all
git checkout --detach newrepo/main   # use the remote name `git remote -v` shows for darkkk001/vyX
foreach ($c in "4e9bb50", "ee3bb23", "51de153", "86a4adc", "65d1908", "3338c72", "b5c1a2a", "44f7a51") { git merge-base --is-ancestor $c HEAD; if ($LASTEXITCODE -ne 0) { throw "HEAD does not contain $c" } }
git log --oneline -8
```
(The owner kept `b5c1a2a` on 2026-10-05, so it stays in the list.)

## 2. Build, back up, swap, start, check (one script)

```powershell
"deploy started (UTC): $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-2026-10-05.ps1
```

The script:
1. Checks that HEAD's `engine\` is identical to the pin `44f7a51` (= `b5c1a2a`'s engine code), and that every change is present:
   - the flap and torn-read code (as 10-01);
   - `any_moved_at` (gate);
   - `PricingCache` and `load_pass_book`;
   - no `LEVELS_JOINS` and no account-type join (pricing cache, D8).

   It also prints whether the broker backfill is in the build.
2. Backs up the live exe to `C:\vyxtrader\backup\engine-2026-10-05-<stamp>\trading-core-server.pre.exe`.
3. Runs `cargo build --release -p server` into the separate target dir `engine\build-tmp`. The old engine keeps
   serving meanwhile.
4. Stops, swaps and starts `vyxtrader-engine` through `$Nssm`, and checks the exe hash after the swap.
5. Waits up to 30 s for `/health` on 127.0.0.1:8081 to return 200.
6. Scans the startup log, this start only. These lines must all be present, or the previous exe is put back:
   - shadow read-only role verified;
   - shadow reconciler running;
   - per-tick margin trigger enabled;
   - fires pinned;
   - risk trigger loop decoupled, every_ms=250;
   - **pricing cache loaded**;
   - **pricing cache: reload on change subscribed**.

   Any `SHADOW REFUSED` or `reconciler NOT running` also rolls back. A `pricing cache: reload failed` at start is
   only a WARN (it retries every second).
7. Prints `pass_secs`, unchanged by this deploy. If it was raised to 60 for relief, it can go back to 4 once section 3
   shows the shadow's cost: a pass is 4 statements now.
8. Confirms the new exe is the one running (process start time later than the exe's write time).

Expected last lines:
```
engine up: /health 200 (sha256 ...)
  OK  shadow read-only role verified
  OK  shadow reconciler running
  OK  per-tick margin trigger enabled
  OK  fires pinned to the snapshot
  OK  risk trigger loop decoupled
  OK  risk trigger every_ms=250
  OK  pricing cache loaded
  OK  pricing cache reload on change
  INFO shadow pass_secs=...
running pid ... started ...; exe written ...; new exe running: True
DEPLOY OK. Backup: C:\vyxtrader\backup\engine-2026-10-05-...
```

## 3. After the deploy

### 3a. Still recording, margin calls and stop-outs pair clean (VPS, read-only, counts only)

Run this 10 minutes after the start, while markets are open, and again the next day. Set `$Since` to the deploy time
from step 2. `$u` is from section 0; run that block's first four lines again in a new window.

```powershell
$Since = "2026-10-05 00:00:00"   # <- the deploy time (UTC) printed in step 2
$sql = @"
SET default_transaction_read_only = on;
SELECT 'decisions since deploy' AS what, count(*) FROM shadow_decision WHERE first_seen > '$Since'::timestamptz
UNION ALL SELECT 'pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz
UNION ALL SELECT 'unexplained pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz AND class IN ('VALUE','ENGINE_ONLY','WEB_ONLY')
UNION ALL SELECT 'pairs since deploy with no broker', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz AND broker IS NULL
UNION ALL SELECT 'seconds since the newest pair', coalesce(extract(epoch FROM now() - max(created_at))::bigint, -1) FROM shadow_pair;
SELECT 'margin_call_in' AS kind, class, count(*), max(abs(skew_ms)) AS max_skew_ms FROM shadow_pair
 WHERE created_at > '$Since'::timestamptz AND kind = 'margin_call_in' GROUP BY class
UNION ALL
SELECT 'stop_out', class, count(*), max(abs(skew_ms)) FROM shadow_pair
 WHERE created_at > '$Since'::timestamptz AND kind = 'stop_out' GROUP BY class ORDER BY 1, 2;
"@
$sql | psql -X -q $u
```

Expected:
- **margin_call_in:** MATCH and SNAPSHOT, with TIMING only for a genuinely late edge, and **no WEB_ONLY**. Before the
  web deploy, a duplicate web notice can still show up as WEB_ONLY: that is #123's web bug, not the engine.
- **stop_out:** MATCH (or TIMING / SNAPSHOT / PREEMPTED, which are explained), and **no WEB_ONLY**.
- **pairs with no broker:** 0 once section 5's grant is in.
- `decisions` and `pairs` go up during market hours.

Log scan (no secrets; matching lines only):
```powershell
$log = ((& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-engine AppStdout) -join "") -replace "`0",""
Get-Content $log -Tail 600 | Select-String -Pattern "ERROR|panicked|SHADOW REFUSED|reconciler NOT|pricing cache|idle gate:|broker filled|broker backfill" | Select-Object -Last 20 | ForEach-Object { ($_.Line -replace "$([char]27)\[[0-9;]*m", '').Substring(0, [Math]::Min(220, $_.Line.Length)) }
```

Expected:
- No `panicked`, and no `ERROR` other than a genuinely unexplained pair.
- `idle gate: resumed` while markets move. After the Friday close: `idle gate: skipping until the book can move`
  for `shadow pass`, `risk hook backstop` and `reconciler`, and **no `resumed` again until Sunday's reopen**. That is
  the weekend fix.
- A `pricing cache: reload failed` line repeating means the role can't read a pricing table (stop and report).

### 3b. Neon by role (owner's PC, live Neon, read-only, two reads 10 minutes apart)

This shows what each client costs now, against the 45-hour baseline: shadow book query ~1/s, TradingSession ~1/s,
web margin-monitor 0.19/s. It keeps the compute awake for 10 minutes, so run it while markets are open. It loads both
URLs from `.env.live` without printing them:
```powershell
$EnvFile = "D:\VyXTrader-Tauri\vyX\.env.live"
foreach ($n in "DATABASE_URL", "DIRECT_URL") {
  $l = Get-Content $EnvFile | Where-Object { $_ -match "^\s*$n\s*=" } | Select-Object -First 1
  if (-not $l) { throw "$n missing in $EnvFile" }
  Set-Item "env:$n" (($l -replace "^\s*$n\s*=\s*", "").Trim().Trim('"').Trim("'"))
}
$Psql = "D:\pg-scratch\pgsql\bin\psql.exe"
$q = "SET default_transaction_read_only = on; SELECT userid::regrole::text, queryid, calls, left(regexp_replace(query,'\s+',' ','g'),110) FROM pg_stat_statements;"
function Read-Stats { $h = @{}; foreach ($r in (& $Psql $env:DIRECT_URL -X -A -t -F "|" -c $q | Where-Object { $_ -match '\|' })) { $f = $r -split '\|', 4; $h["$($f[0])|$($f[1])"] = @{ role = $f[0]; calls = [long]$f[2]; q = $f[3] } }; $h }
$a = Read-Stats; "first read: $($a.Count) statements; waiting 600 s"; Start-Sleep 600; $b = Read-Stats
$d = foreach ($k in $b.Keys) { $was = if ($a.ContainsKey($k)) { $a[$k].calls } else { 0 }; [pscustomobject]@{ role = $b[$k].role; calls = $b[$k].calls - $was; q = $b[$k].q } }
"--- calls per minute by role (10 min)"; $d | Group-Object role | ForEach-Object { "{0,-16} {1,8:N1}/min" -f $_.Name, (($_.Group | Measure-Object calls -Sum).Sum / 10) } 
"--- top 12 statements by calls (10 min)"; $d | Where-Object { $_.calls -gt 0 } | Sort-Object calls -Descending | Select-Object -First 12 | ForEach-Object { "{0,-16} {1,7}  {2}" -f $_.role, $_.calls, $_.q }
Remove-Item env:DATABASE_URL, env:DIRECT_URL
```

Expected for `vyx_shadow_ro`:
- about `(60 / pass_secs) x 4` statements a minute for the pass while the gate is open, plus the fires and the
  reconciler; **0 while the book is closed** (weekend);
- no statement joining `Position` with `GroupSymbolConfig` / `AccountSymbolConfig` / `LivePrice`;
- the pricing tables read in five small statements per reload, not per pass.

Before this deploy the shadow's book query ran ~60 a minute (one per account per pass).

## 4. The soak clock: excuse the four WEB_ONLY rows (owner only)

All four are explained by the owner's evidence (VPS block, section 4, 2026-10-05):

| Pair | What happened | Fixed by |
|---|---|---|
| #98 | 50005708, 2026-10-01 04:20:04.94 UTC: margin-call flap, 11 flaps across 100 %, explained by an overlapping shadow episode | `4e9bb50` + `ee3bb23` (this deploy) |
| #109 | 49990004 (a4), stop-out 2026-10-01 07:00:10.871 UTC: torn read, the web's close landed between the shadow's funds and ledger reads | `51de153` (this deploy) |
| #118 | 49990002, stop-out 2026-10-02 12:10:04.626 UTC at 19680, web 27.20 %: torn read. The shadow saw 355.96 % (equity 2000 = balance 2000 + the 1847.185 loss counted twice − 1847.185 floating; used margin 561.9) and decided nothing | `51de153` (this deploy) |
| #123 | 49990003, margin call 2026-10-02: the web sent MARGIN_CALL twice (12:20:45.139 and .221). The shadow matched .139 with decision #168 (plus stop_out #169, margin_call_out #170); the duplicate .221 was left WEB_ONLY | web `ce25b5d` (the web deploy) |

Neither row is re-classified automatically (the reconciler's cursors have moved past them, `web_ref` is unique and
inserts are `ON CONFLICT DO NOTHING`). The soak clock is derived: max(the soak start, the newest unexplained pair NOT
excused). Until all four are excused, #123 (2 Oct) holds the clock.

`shadow_excuse` (`pair_id`, `reason` >= 10 chars, `excused_by` >= 2 chars, `excused_at`) is SELECT-only for the engine
role (`deploy/shadow-store.sql`). So this runs as **postgres**, on the store's own host and database, from the same
URL without printing it. **Each insert is keyed by the pair id AND re-checks its class, kind, account or position and
time,** so a wrong id inserts nothing. The transaction refuses to commit unless all four rows end up excused.

```powershell
$m = [regex]::Match($u, '@([^:/?]+)(?::(\d+))?/([^?]+)')
$StoreHost = $m.Groups[1].Value; $StorePort = if ($m.Groups[2].Success) { $m.Groups[2].Value } else { "5432" }; $StoreDb = $m.Groups[3].Value
"store: host $StoreHost port $StorePort db $StoreDb"    # names only, no credentials
$sql = @'
\set ON_ERROR_STOP on
BEGIN;
-- #98: 50005708 margin_call_in 2026-10-01 04:20:04.94 UTC
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'margin-call flap 2026-10-01 04:20:04.94 UTC (50005708): 11 flaps across 100 %, explained by an overlapping shadow episode; matcher fixed in 4e9bb50 + ee3bb23 (engine deploy 2026-10-05)', 'owner'
  FROM shadow_pair WHERE id = 98 AND class = 'WEB_ONLY' AND kind = 'margin_call_in' AND account_id = 'cmuexlh9r0001jp04yrfxqq9f'
   AND web_at BETWEEN '2026-10-01 04:20:04Z' AND '2026-10-01 04:20:06Z'
ON CONFLICT (pair_id) DO NOTHING;
-- #109: 49990004 stop_out 2026-10-01 07:00:10.871 UTC, position cmup6pjmo000ll004h45kcfob
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'torn pinned read 2026-10-01 07:00:10.871 UTC (49990004 a4, position cmup6pjmo000ll004h45kcfob): the web close landed between the shadow''s funds and ledger reads; fixed in 51de153 (engine deploy 2026-10-05)', 'owner'
  FROM shadow_pair WHERE id = 109 AND class = 'WEB_ONLY' AND kind = 'stop_out' AND position_id = 'cmup6pjmo000ll004h45kcfob'
ON CONFLICT (pair_id) DO NOTHING;
-- #118: 49990002 stop_out 2026-10-02 12:10:04.626 UTC
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'torn read 2026-10-02 12:10:04.626 UTC (49990002 stop-out at 19680, web 27.20 %): shadow saw 355.96 % = equity 2000 (balance 2000 + 1847.185 loss double-counted - 1847.185 floating) / used margin 561.9, no decision; fixed in 51de153 (engine deploy 2026-10-05)', 'owner'
  FROM shadow_pair WHERE id = 118 AND class = 'WEB_ONLY' AND kind = 'stop_out'
   AND account_id IN ('cmuhzby3i0026vczwnye5eswv', 'cmuhzbyan002avczwra22jvxg')
   AND web_at BETWEEN '2026-10-02 12:10:03Z' AND '2026-10-02 12:10:06Z'
ON CONFLICT (pair_id) DO NOTHING;
-- #123: 49990003 margin_call_in, the web's duplicate notice at 2026-10-02 12:20:45.221 UTC
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'web double MARGIN_CALL notice 2026-10-02 12:20:45.139 / .221 UTC (49990003): the shadow matched .139 with decision #168, the duplicate .221 was left WEB_ONLY; web bug fixed in ce25b5d (web deploy)', 'owner'
  FROM shadow_pair WHERE id = 123 AND class = 'WEB_ONLY' AND kind = 'margin_call_in'
   AND account_id IN ('cmuhzby3i0026vczwnye5eswv', 'cmuhzbyan002avczwra22jvxg')
   AND web_at BETWEEN '2026-10-02 12:20:45Z' AND '2026-10-02 12:20:46Z'
ON CONFLICT (pair_id) DO NOTHING;
-- all four or nothing: a row whose checks did not match aborts the whole transaction
DO $$ BEGIN
  IF (SELECT count(*) FROM shadow_excuse WHERE pair_id IN (98, 109, 118, 123)) <> 4 THEN
    RAISE EXCEPTION 'not all four rows matched their checks: nothing excused (run section 0 again and report)';
  END IF;
END $$;
SELECT e.pair_id, p.class, p.kind, p.account_id, e.excused_by, e.excused_at FROM shadow_excuse e JOIN shadow_pair p ON p.id = e.pair_id
 WHERE e.pair_id IN (98, 109, 118, 123) ORDER BY e.pair_id;
COMMIT;
'@
$sql | psql -X -q -U postgres -h $StoreHost -p $StorePort -d $StoreDb
```
Expected: `INSERT 0 1` four times, then the four excuses listed. An exception means a row didn't match: nothing was
written, so run section 0 again and report.

Then re-run section 0. Expected: `holds_the_clock_since` names an older unexplained row, or none. With nothing new,
the clock goes back to the soak start, 2026-09-29 10:56 UTC. The second query shows all four `excused = t`. An excuse
is undone by deleting its `shadow_excuse` row, as postgres.

## 5. The broker counter: one grant on live Neon (owner, `neondb_owner`)

All 39 pairs since the soak start have `broker` NULL, because the read-only role can't read `Broker.subdomain`. So
the soak exit's "30 real paired" counts nothing as real. One column grant fixes the lookups. It is not personal data,
and the engine's start-up check (no write rights, no `passwordHash`) still passes. The same line is now in
`deploy/neon-shadow-readonly.sql`, so a re-run keeps it.

On the owner's PC (loads `DIRECT_URL` from `.env.live` without printing it):
```powershell
$EnvFile = "D:\VyXTrader-Tauri\vyX\.env.live"
$l = Get-Content $EnvFile | Where-Object { $_ -match "^\s*DIRECT_URL\s*=" } | Select-Object -First 1
if (-not $l) { throw "DIRECT_URL missing in $EnvFile" }
$env:DIRECT_URL = ($l -replace "^\s*DIRECT_URL\s*=\s*", "").Trim().Trim('"').Trim("'")
@'
\set ON_ERROR_STOP on
GRANT SELECT (subdomain) ON "Broker" TO vyx_shadow_ro;
SELECT has_column_privilege('vyx_shadow_ro', '"Broker"', 'subdomain', 'SELECT') AS subdomain_readable,
       has_column_privilege('vyx_shadow_ro', '"Account"', 'passwordHash', 'SELECT') AS password_hash_readable;
'@ | & "D:\pg-scratch\pgsql\bin\psql.exe" $env:DIRECT_URL -X -q
Remove-Item env:DIRECT_URL
```
Expected: `GRANT`, then `subdomain_readable = t`, `password_hash_readable = f`.

What follows by itself, no restart:
- New pairs carry their broker at once (the running engine, old or new).
- With this build (`b5c1a2a`), the reconciler fills in every pair since the soak start that has no broker, within 10
  minutes. The log line is `shadow reconcile: broker filled in on the pairs stored without it` with `filled=` the
  count. Only `broker` is set: no pair is re-classified, no excuse touched, nothing edited by hand.
- The day's `shadow_daily` summary recomputes `paired_real` / `paired_bot` / `paired_unknown` from the pairs since the
  clock started, at its next write.

Check (VPS, read-only, `$u` from section 0):
```powershell
$sql = @'
SET default_transaction_read_only = on;
SELECT coalesce(broker, '<NULL>') AS broker, class, count(*) FROM shadow_pair WHERE created_at >= '2026-09-29 10:56Z' GROUP BY 1, 2 ORDER BY 1, 2;
SELECT day, paired_real, paired_bot, paired_unknown FROM shadow_daily WHERE day >= '2026-09-29' ORDER BY day;
'@
$sql | psql -X -q $u
```
Expected: no `<NULL>` rows (other than an account deleted since). The bot's pairs show `zzshadowbot` and count as
bot; real brokers count toward the 30.

If the owner drops `b5c1a2a`, run only the grant. New pairs then carry their broker, but the 39 old ones stay NULL,
so the 30-real count starts from the grant.

## Rollback

```powershell
$N = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$B = (Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "engine-2026-10-05-*" | Sort-Object Name | Select-Object -Last 1).FullName
"rolling back from $B"
& $N stop vyxtrader-engine; Start-Sleep 2
Copy-Item "$B\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
& $N start vyxtrader-engine
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health -TimeoutSec 3).StatusCode -eq 200) { "OK: previous engine back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

After a rollback:
- **Pairs, excuses and backfilled brokers:** they stay. The old reconciler only reads new rows, and a filled-in broker
  is only more information.
- **The section 5 grant:** it can stay. The previous engine runs with or without it.
- **Grants the previous exe still needs:** the grant file keeps `LivePrice`, `AccountType` and
  `AccountTypeSymbolConfig` for it. Don't revoke them until this build has run clean for a while.
