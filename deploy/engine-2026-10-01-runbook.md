# Engine deploy 2026-10-01: margin-call flap + torn pinned read (VPS runbook)

**This supersedes `deploy/margin-call-flap-engine-runbook.md` and its script.** One engine build carries both shadow
fixes. The script is `deploy/engine-2026-10-01.ps1`.

**What ships:** commits `4e9bb50` + `ee3bb23` (margin-call flap) and `97b04af` (torn read), all in `main`. The script
requires HEAD's `engine\` to be byte-identical to `97b04af`'s. It changes the engine binary `trading-core-server.exe`
only. There is no schema change and no env change. These stay as they are:
- `start-engine.cmd`;
- `ENGINE_ORDER_MANAGEMENT`, which stays `shadow`;
- every DB URL and every secret;
- `VYX_SHADOW_PASS_SECS` and `VYX_RISK_TRIGGER_MS`.

The web is untouched.

1. **Margin-call flap** (owner's VPS query confirmed it):
   - **Reconciler:**
     - a web notice pairs with its nearest unused shadow edge only when it is also that edge's nearest notice, which
       ends the cascade;
     - the rest are explained by an overlapping shadow episode: any edge in the window, samples in a call or crossing
       the level, or the sample closest to the level (no longer the lowest sample);
     - a lone shadow edge is also explained by a web clear in the window.
   - **Trigger:** the 5 s damping defers a margin-call change instead of dropping it.
   - **The rule (owner):** "Margin-call notices: no real warning is lost; the account's final state is announced
     within 5 s; sub-5 s flickers are not repeated (for the 11-flap replay: 8 in/out pairs vs the web's 11, all 11 web
     notices explained, 0 WEB_ONLY)."
2. **Torn pinned read:** every read of an evaluation (funds, positions, sessions, fx quotes, the pinned ledger) runs in
   ONE `REPEATABLE READ, READ ONLY` transaction, so they all see the same commit. It works under the read-only shadow
   role.

**Before / after:**

| Case | Before (live shadow) | After (replay on the real schema) |
|---|---|---|
| 50005708, 2026-10-01 04:18–04:23 UTC, 11 margin-call flaps | 9 in / 9 out shadow edges; 1 WEB_ONLY (04:20:04.94) + 5 TIMING with skews −17 254, −11 065, −10 758, −6 573, −14 425 ms | 8 MATCH (within 3.2 s) + 3 SNAPSHOT, 0 WEB_ONLY (`tests/reconcile_flap_db.rs`) |
| 49990004 (S2 a4), stop-out at 07:00:10.871 UTC, the web's close between the shadow's reads | pinned balance 1643.765 → 127.67 % → no decision → WEB_ONLY | one snapshot → stop_out at 45.48 %, balance after 356.235 (`tests/torn_read_db.rs`) |

## Rules

- Run in an **elevated** Windows PowerShell on the VPS.
- Nothing below prints a secret: URLs are read into variables, and only lengths, host or database names and counts
  are shown. The `-U postgres` commands let psql ask for the password itself.
- `nssm` is not on the VPS PATH. Always use `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`.
- Note the deploy time (UTC) printed in step 2. Section 3 uses it.

## 0. Before the deploy: which row holds the soak clock (read-only)

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
 ORDER BY p.created_at DESC LIMIT 3;
SELECT id, class, kind, account_id, position_id, to_char(web_at,'YYYY-MM-DD HH24:MI:SS.MS') web_at FROM shadow_pair
 WHERE (account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in' AND class='WEB_ONLY' AND web_at BETWEEN '2026-10-01 04:20:04Z' AND '2026-10-01 04:20:06Z')
    OR (position_id='cmup6pjmo000ll004h45kcfob' AND kind='stop_out' AND class='WEB_ONLY');
'@
$sql | psql -X -q $u
```
Expected: the second query lists the two WEB_ONLY rows that section 4 excuses, one per row: (a) and (b).

## 1. Get the code (HEAD must carry all three commits)

```powershell
cd C:\vyxtrader\repo
if (git status --porcelain) { throw "working tree not clean: stop and report" }
git fetch --all
git checkout --detach origin/main          # use the remote name `git remote -v` shows for darkkk001/vyX
foreach ($c in "4e9bb50", "ee3bb23", "97b04af") { git merge-base --is-ancestor $c HEAD; if ($LASTEXITCODE -ne 0) { throw "main does not contain $c yet" } }
git log --oneline -5
```

## 2. Build, back up, swap, start, check (one script)

```powershell
"deploy started (UTC): $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-2026-10-01.ps1
```

The script:
1. Checks that HEAD carries `97b04af` with an identical `engine\`, and that all three changes are present
   (`fired_in_call`, `call_evidence_around`, `REPEATABLE READ, READ ONLY`).
2. Backs up the live exe to `C:\vyxtrader\backup\engine-2026-10-01-<stamp>\trading-core-server.pre.exe`.
3. Runs `cargo build --release -p server` into the separate target dir `engine\build-tmp`. The old engine keeps
   serving meanwhile.
4. Stops, swaps and starts `vyxtrader-engine` through `$Nssm`, and checks the exe hash after the swap.
5. Waits up to 30 s for `/health` on 127.0.0.1:8081 to return 200.
6. Scans the startup log, this start only. These lines must all be present, or the previous exe is put back:
   - shadow read-only role verified;
   - shadow reconciler running;
   - per-tick margin trigger enabled;
   - fires pinned;
   - risk trigger loop decoupled, every_ms=250.

   Any `SHADOW REFUSED` or `reconciler NOT running` also rolls back.
7. Confirms the new exe is the one running (process start time later than the exe's write time).

Expected last lines:
```
engine up: /health 200 (sha256 ...)
  OK  shadow read-only role verified
  OK  shadow reconciler running
  OK  per-tick margin trigger enabled
  OK  fires pinned to the snapshot
  OK  risk trigger loop decoupled
  OK  risk trigger every_ms=250
running pid ... started ...; exe written ...; new exe running: True
DEPLOY OK. Backup: C:\vyxtrader\backup\engine-2026-10-01-...
```

## 3. After the deploy: still recording, margin calls and stop-outs pair clean (read-only, counts only)

Run this 10 minutes after the start, while markets are open, and again the next day. Set `$Since` to the deploy time
from step 2. `$u` is from section 0; run that block's first four lines again in a new window.

```powershell
$Since = "2026-10-01 00:00:00"   # <- the deploy time (UTC) printed in step 2
$sql = @"
SET default_transaction_read_only = on;
SELECT 'decisions since deploy' AS what, count(*) FROM shadow_decision WHERE first_seen > '$Since'::timestamptz
UNION ALL SELECT 'pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz
UNION ALL SELECT 'unexplained pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz AND class IN ('VALUE','ENGINE_ONLY','WEB_ONLY')
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
- **margin_call_in:** MATCH and SNAPSHOT, with TIMING only for a genuinely late edge (never a 6–17 s cascade), and
  **no WEB_ONLY**.
- **stop_out:** MATCH (or TIMING / SNAPSHOT / PREEMPTED, which are explained), and **no WEB_ONLY**, including a
  stop-out the web closes while the shadow is mid-evaluation.
- `decisions` and `pairs` go up during market hours, and `seconds since the newest pair` stays in step with risk
  activity.
- Any unexplained row is a genuine difference, logged at ERROR with both sides.

Log scan (no secrets; matching lines only):
```powershell
$log = ((& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-engine AppStdout) -join "") -replace "`0",""
Get-Content $log -Tail 400 | Select-String -Pattern "ERROR|panicked|SHADOW REFUSED|reconciler|could not serialize" | Select-Object -Last 15 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)) }
```
Expected: no `panicked`, and no `ERROR` other than a genuinely unexplained pair. The snapshot transaction is read
only, so it cannot hit serialization failures.

## 4. The soak clock: excuse the two old WEB_ONLY rows (option A, owner only)

Neither old row is re-classified automatically:
- the reconciler's cursors have moved past them;
- `shadow_pair.web_ref` is unique, and inserts are `ON CONFLICT DO NOTHING`;
- a restart does not re-pair history.

The soak clock is derived: max(the soak start, the newest unexplained pair NOT excused). Until both rows are excused,
the newer one (b, 07:00:10 UTC) holds the clock. The fixes stop new resets, and excusing both rows gives back the time
before them.

`shadow_excuse` has the columns `pair_id` (the `shadow_pair.id`), `reason` (at least 10 characters), `excused_by`
(at least 2) and `excused_at` (default now). The engine role may only SELECT it (`deploy/shadow-store.sql`). So these
inserts run as **postgres**: on the store's own host and database, taken from the same URL without printing it.

```powershell
$m = [regex]::Match($u, '@([^:/?]+)(?::(\d+))?/([^?]+)')
$StoreHost = $m.Groups[1].Value; $StorePort = if ($m.Groups[2].Success) { $m.Groups[2].Value } else { "5432" }; $StoreDb = $m.Groups[3].Value
"store: host $StoreHost port $StorePort db $StoreDb"    # names only, no credentials
$sql = @'
\set ON_ERROR_STOP on
BEGIN;
-- (a) 50005708 margin_call_in 2026-10-01 04:20:04.94 UTC
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'margin-call flap 2026-10-01 04:20:04.94 UTC (account 50005708): 11 flaps across 100 %, explained by an overlapping shadow episode; matcher fixed in 4e9bb50 (deployed 2026-10-01)', 'owner'
  FROM shadow_pair WHERE account_id = 'cmuexlh9r0001jp04yrfxqq9f' AND kind = 'margin_call_in' AND class = 'WEB_ONLY'
   AND web_at BETWEEN '2026-10-01 04:20:04Z' AND '2026-10-01 04:20:06Z'
ON CONFLICT (pair_id) DO NOTHING;
-- (b) 49990004 stop_out 2026-10-01 07:00:10.871 / 10.883 UTC, position cmup6pjmo000ll004h45kcfob
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'torn pinned read 2026-10-01 07:00:10.871 UTC (49990004, position cmup6pjmo000ll004h45kcfob): shadow-only artifact, the web close landed between the shadow''s funds and ledger reads; the engine would have stopped it out; fixed in 97b04af (deployed 2026-10-01)', 'owner'
  FROM shadow_pair WHERE position_id = 'cmup6pjmo000ll004h45kcfob' AND kind = 'stop_out' AND class = 'WEB_ONLY'
ON CONFLICT (pair_id) DO NOTHING;
SELECT e.pair_id, p.class, p.kind, p.account_id, e.excused_by, e.excused_at FROM shadow_excuse e JOIN shadow_pair p ON p.id = e.pair_id
 WHERE p.account_id IN ('cmuexlh9r0001jp04yrfxqq9f') OR p.position_id = 'cmup6pjmo000ll004h45kcfob' ORDER BY e.pair_id;
COMMIT;
'@
$sql | psql -X -q -U postgres -h $StoreHost -p $StorePort -d $StoreDb
```
Expected: `INSERT 0 1` twice (or `INSERT 0 0` for a row already excused), then the two excuses listed.

Then re-run section 0. Expected: `holds_the_clock_since` now names an older unexplained row, or none, and the second
query still lists the two rows (now excused). An excuse is undone by deleting its `shadow_excuse` row, as postgres.

## Rollback

```powershell
$N = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$B = (Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "engine-2026-10-01-*" | Sort-Object Name | Select-Object -Last 1).FullName
"rolling back from $B"
& $N stop vyxtrader-engine; Start-Sleep 2
Copy-Item "$B\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
& $N start vyxtrader-engine
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health -TimeoutSec 3).StatusCode -eq 200) { "OK: previous engine back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

Pairs already written by the new reconciler stay as they are, and so do excuses. The old reconciler only reads new
rows, so nothing is re-classified.
