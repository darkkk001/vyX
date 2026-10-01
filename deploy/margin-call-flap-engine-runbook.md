# Margin-call flapping: VPS engine runbook

**Status: final.** The owner's read-only VPS query confirmed the diagnosis on 2026-10-01. Damping option A is
confirmed, with EDGE_EVERY kept at 5 s.

**What ships:** commits `4e9bb50` (code) and `ee3bb23` (the damping rule text), on branch `shadow/margin-call-flap`,
merged to `main`. They change the engine binary `trading-core-server.exe` only.
- **Reconciler:** a web margin-call notice pairs with its nearest unused shadow edge only when it is also that edge's
  nearest notice. That ends the cascade where each notice took the next episode's edge. The rest are explained by an
  overlapping shadow episode:
  - any shadow edge in the window;
  - samples in a call or crossing the call level;
  - the sample closest to the level, no longer the lowest sample.

  A lone shadow edge is also explained when the web cleared a margin call within the window. Stop-out, SL and TP
  pairing is unchanged.
- **Margin trigger:** the 5 s margin-call damping defers a change instead of dropping it, by comparing against the last
  FIRED state.

**What does not change:** no schema change, no env change. These stay as they are:
- `start-engine.cmd`;
- `ENGINE_ORDER_MANAGEMENT`, which stays `shadow`;
- every DB URL and every secret;
- `VYX_SHADOW_PASS_SECS` and `VYX_RISK_TRIGGER_MS`.

The web is untouched.

**The rule (owner 2026-10-01):** "Margin-call notices: no real warning is lost; the account's final state is announced
within 5 s; sub-5 s flickers are not repeated (for the 11-flap replay: 8 in/out pairs vs the web's 11, all 11 web
notices explained, 0 WEB_ONLY)."

**Before / after, account 50005708, 2026-10-01 04:18–04:23 UTC:**

| | Before (live shadow, owner's VPS query) | After (replay of the same 11 flaps, `tests/reconcile_flap_db.rs`) |
|---|---|---|
| Shadow edges | 9 in / 9 out, flapping across 100 % (98.56 → 111.28 → 99.65 → 106.60 …) | the trigger fires 8 in / 8 out, deferred |
| Web notices | 11 MARGIN_CALL + 11 cleared | same |
| Classes | 1 WEB_ONLY (04:20:04.94), 5 TIMING with skews −17 254, −11 065, −10 758, −6 573, −14 425 ms, the rest MATCH | 8 MATCH (all within 3.2 s) + 3 SNAPSHOT (overlapping episode), 0 TIMING, 0 WEB_ONLY, 0 ENGINE_ONLY |
| Soak clock | reset by the WEB_ONLY | not reset |

## Rules

- Run in an **elevated** Windows PowerShell on the VPS.
- Nothing below prints a secret: URLs are read into variables, and only lengths and counts are shown. The `-U postgres`
  commands let psql ask for the password itself.
- `nssm` is not on the VPS PATH. Always use `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`.
- Note the deploy time (UTC) printed in step 2. Section 3 uses it.

## 1. Get the code (HEAD must carry both commits)

```powershell
cd C:\vyxtrader\repo
if (git status --porcelain) { throw "working tree not clean: stop and report" }
git fetch --all
git checkout --detach origin/main          # use the remote name `git remote -v` shows for darkkk001/vyX
foreach ($c in "4e9bb50", "ee3bb23") { git merge-base --is-ancestor $c HEAD; if ($LASTEXITCODE -ne 0) { throw "main does not contain $c yet" } }
git log --oneline -4
```

## 2. Build, back up, swap, start, check (one script)

```powershell
"deploy started (UTC): $((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd HH:mm:ss'))"
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\margin-call-flap-engine-2026-10-01.ps1
```

The script follows the soak-gate / margin-edges deploy pattern:
1. It checks that HEAD carries `ee3bb23` (the last engine commit of the branch) with an identical `engine\`, and that the new code is present
   (`fired_in_call`, `call_evidence_around`).
2. It backs up the live exe to `C:\vyxtrader\backup\margin-call-flap-<stamp>\trading-core-server.pre.exe`.
3. It runs `cargo build --release -p server` into the separate target dir `engine\build-tmp`. The old engine keeps
   serving meanwhile.
4. It stops, swaps and starts `vyxtrader-engine` through `$Nssm`, and checks the exe hash after the swap.
5. It waits up to 30 s for `/health` on 127.0.0.1:8081 to return 200.
6. It scans the startup log, this start only. These lines must all be present, or the previous exe is put back:
   - shadow read-only role verified;
   - shadow reconciler running;
   - per-tick margin trigger enabled;
   - fires pinned;
   - risk trigger loop decoupled, every_ms=250.

   Any `SHADOW REFUSED` or `reconciler NOT running` also rolls back.
7. It confirms the new exe is the one running (process start time later than the exe's write time).

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
DEPLOY OK. Backup: C:\vyxtrader\backup\margin-call-flap-...
```

## 3. The shadow is still recording, and margin calls pair clean (read-only, counts only)

Run this 10 minutes after the start, while markets are open, and again the next day. Set `$Since` to the deploy time
from step 2.

```powershell
$Since = "2026-10-01 00:00:00"   # <- the deploy time (UTC) printed in step 2
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
function Get-CmdVar([string]$Path, [string]$Name) { $l = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1; if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() } }
$u = Get-CmdVar $EngineCmd "VYX_SHADOW_STORE_URL"; if (-not $u) { $u = Get-CmdVar $EngineCmd "MARKET_DATA_DATABASE_URL" }
"store url length: $($u.Length)"
$sql = @"
SET default_transaction_read_only = on;
SELECT 'decisions since deploy' AS what, count(*) FROM shadow_decision WHERE first_seen > '$Since'::timestamptz
UNION ALL SELECT 'margin-call edges since deploy', count(*) FROM shadow_decision WHERE kind LIKE 'margin_call%' AND first_seen > '$Since'::timestamptz
UNION ALL SELECT 'pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz
UNION ALL SELECT 'unexplained pairs since deploy', count(*) FROM shadow_pair WHERE created_at > '$Since'::timestamptz AND class IN ('VALUE','ENGINE_ONLY','WEB_ONLY')
UNION ALL SELECT 'seconds since the newest pair', coalesce(extract(epoch FROM now() - max(created_at))::bigint, -1) FROM shadow_pair;
SELECT kind, class, count(*), max(abs(skew_ms)) AS max_skew_ms FROM shadow_pair WHERE created_at > '$Since'::timestamptz GROUP BY kind, class ORDER BY kind, class;
"@
$sql | psql -X -q $u
$u = $null
```

Expected:
- `decisions since deploy` goes up during market hours.
- `pairs since deploy` goes up whenever there was risk activity, and `seconds since the newest pair` stays in step
  with it.
- `margin_call_in` rows are MATCH or SNAPSHOT, with TIMING only for a genuinely late edge, never a 6–17 s cascade.
- **No WEB_ONLY or ENGINE_ONLY from a flapping account.** Any unexplained row is a genuine difference: it is logged at
  ERROR with both sides.

Log scan (no secrets; matching lines only):
```powershell
$log = ((& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-engine AppStdout) -join "") -replace "`0",""
Get-Content $log -Tail 400 | Select-String -Pattern "ERROR|panicked|SHADOW REFUSED|reconciler" | Select-Object -Last 15 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)) }
```
Expected: no `panicked`, and no `ERROR` other than a genuinely unexplained pair.

## 4. The old 04:20:04.94 WEB_ONLY row and the soak clock

**It is NOT re-classified automatically.**
- The reconciler reads web notices on a cursor that has already moved past it.
- `shadow_pair.web_ref` is unique, and inserts are `ON CONFLICT DO NOTHING`.
- A restart does not re-pair history.

The new matcher only classifies notices that arrive after the deploy.

**The soak clock** is derived, never stored: max(the soak start, the newest unexplained pair that is NOT excused).
- The old WEB_ONLY row (created about 04:21 UTC on 2026-10-01) holds the clock at that moment, unless a later
  unexplained row exists.
- The fix needs no action for the clock to run clean from then on. Future flaps no longer reset it, and the clock is
  already counting from about 04:21, earlier than the deploy.
- To give back the time before 04:21, the old row must be excused (option A) or re-classified (option B). That is the
  owner's choice, and both are writes to the shadow store, as postgres.

Read-only look at the window and at what holds the clock:
```powershell
$sql = @'
SET default_transaction_read_only = on;
SELECT id, class, to_char(web_at,'HH24:MI:SS.MS') web, to_char(shadow_at,'HH24:MI:SS.MS') shadow, skew_ms
  FROM shadow_pair WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in'
   AND coalesce(web_at,shadow_at) BETWEEN '2026-10-01 04:18Z' AND '2026-10-01 04:23Z' ORDER BY coalesce(web_at,shadow_at);
SELECT p.id, p.class, p.kind, p.created_at AS holds_the_clock_since FROM shadow_pair p
 WHERE p.class IN ('VALUE','ENGINE_ONLY','WEB_ONLY') AND NOT EXISTS (SELECT 1 FROM shadow_excuse e WHERE e.pair_id = p.id)
 ORDER BY p.created_at DESC LIMIT 1;
'@
$sql | psql -X -q -U postgres -h 127.0.0.1 -d market_data
```

**Option A, excuse the row** (owner only; the designed path, auditable, reversible by deleting the excuse):
```powershell
$sql = @'
INSERT INTO shadow_excuse (pair_id, reason, excused_by)
SELECT id, 'margin-call flap 2026-10-01 04:20:04.94 UTC: overlapping shadow episode, matcher fixed in 4e9bb50', 'owner'
  FROM shadow_pair WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in' AND class='WEB_ONLY'
   AND web_at BETWEEN '2026-10-01 04:20:04Z' AND '2026-10-01 04:20:06Z';
'@
$sql | psql -X -q -v ON_ERROR_STOP=1 -U postgres -h 127.0.0.1 -d market_data
```
Expected: `INSERT 0 1`. Then the read-only query above shows a different `holds_the_clock_since`.

**Option B, re-classify the window with the new matcher** (owner only; only AFTER the new engine runs). This deletes
the window's margin-call pairs for this one account and rewinds the web margin-call cursor to 04:18. The next
reconciler run, within a minute, re-pairs them:
- notices that still have a row are skipped (`ON CONFLICT DO NOTHING`, no log line);
- only this account's deleted rows are re-classified;
- the shadow's own edges for the window stay in `shadow_decision` and are used again.

The expected result, as in the replay, is MATCH and SNAPSHOT only, with 0 WEB_ONLY.
```powershell
$sql = @'
BEGIN;
DELETE FROM shadow_excuse WHERE pair_id IN (SELECT id FROM shadow_pair WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in'
   AND coalesce(web_at,shadow_at) BETWEEN '2026-10-01 04:18Z' AND '2026-10-01 04:23Z');
DELETE FROM shadow_pair WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in'
   AND coalesce(web_at,shadow_at) BETWEEN '2026-10-01 04:18Z' AND '2026-10-01 04:23Z';
UPDATE shadow_state SET value = '2026-10-01T04:18:00+00:00' WHERE key = 'web_mc_cursor_at';
UPDATE shadow_state SET value = '' WHERE key = 'web_mc_cursor_id';
COMMIT;
'@
$sql | psql -X -q -v ON_ERROR_STOP=1 -U postgres -h 127.0.0.1 -d market_data
```
Wait 2 minutes, then re-run the read-only window query above. Expected: one row per web notice plus any lone shadow
edges, all MATCH, TIMING or SNAPSHOT, with 0 WEB_ONLY. The rewound cursor reads every margin-call notice since 04:18
again. Notices of other accounts already have their rows, so it adds nothing for them.

## Rollback

```powershell
$N = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$B = (Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "margin-call-flap-*" | Sort-Object Name | Select-Object -Last 1).FullName
"rolling back from $B"
& $N stop vyxtrader-engine; Start-Sleep 2
Copy-Item "$B\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
& $N start vyxtrader-engine
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health -TimeoutSec 3).StatusCode -eq 200) { "OK: previous engine back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

Pairs already written by the new reconciler stay as they are. The old reconciler only reads new rows, so nothing is
re-classified.
