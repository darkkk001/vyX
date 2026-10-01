# Margin-call flapping: VPS engine runbook (DRAFT)

**Status: draft.** Do not run it until the owner's read-only VPS query confirms the diagnosis: fewer than 11 shadow
`margin_call_in` edges for 50005708 between 04:19 and 04:22 UTC on 2026-10-01, with no edge around 04:20:00-04:20:06.

**What ships:** commit `4e9bb50` (branch `shadow/margin-call-flap`, merged to `main`). It changes the engine binary
`trading-core-server.exe` only.
- **Reconciler:** a web margin-call notice pairs with its nearest unused shadow edge only when it is also that edge's
  nearest notice. The rest are explained by an overlapping shadow episode:
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

**Effect on the trigger:** it now fires the margin-call state the account is in when each 5 s damping window ends.
- For the 11-flap sequence it sends 8 IN and 8 OUT, against the web's 11 and 11.
- The final state is always announced, at most 5 s late.
- Before this change, a flip inside the 5 s was dropped. The account could then be left announced "in" after it had
  left the call, which is where the WEB_ONLY came from.

## Rules

- Run in an **elevated** Windows PowerShell on the VPS.
- Nothing below prints a secret: URLs are read into variables, and only lengths and counts are shown.
- `nssm` is not on the VPS PATH. Always use `C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe`.

## 1. Get the code

```powershell
cd C:\vyxtrader\repo
if (git status --porcelain) { throw "working tree not clean: stop and report" }
git fetch --all
git checkout --detach origin/main          # use the remote name `git remote -v` shows for darkkk001/vyX
git merge-base --is-ancestor 4e9bb50 HEAD; if ($LASTEXITCODE -ne 0) { throw "main does not contain 4e9bb50 yet" }
git log --oneline -3
```

## 2. Build, back up, swap, start, check (one script)

```powershell
powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\margin-call-flap-engine-2026-10-01.ps1
```

The script follows the soak-gate / margin-edges deploy pattern:
1. It checks that HEAD carries `4e9bb50` with an identical `engine\`, and that the new code is present
   (`fired_in_call`, `call_evidence_around`).
2. It backs up the live exe to `C:\vyxtrader\backup\margin-call-flap-<stamp>\trading-core-server.pre.exe`.
3. It runs `cargo build --release -p server` into `engine\build-tmp`. The old engine keeps serving meanwhile.
4. It stops, swaps and starts `vyxtrader-engine` through nssm, and checks the exe hash after the swap.
5. It waits up to 30 s for `/health` on 127.0.0.1:8081 to return 200.
6. It scans the startup log, this start only. These lines must all be present:
   - shadow read-only role verified;
   - shadow reconciler running;
   - per-tick margin trigger enabled;
   - fires pinned;
   - risk trigger loop decoupled, every_ms=250.

   Any `SHADOW REFUSED` puts the previous exe back.
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

## 3. The shadow is still recording (read-only, counts only)

Run this 5 to 10 minutes after the start, while markets are open:

```powershell
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
function Get-CmdVar([string]$Path, [string]$Name) { $l = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1; if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() } }
$u = Get-CmdVar $EngineCmd "VYX_SHADOW_STORE_URL"; if (-not $u) { $u = Get-CmdVar $EngineCmd "MARKET_DATA_DATABASE_URL" }
"store url length: $($u.Length)"
$sql = @'
SET default_transaction_read_only = on;
SELECT 'decisions last 30 min' AS what, count(*) FROM shadow_decision WHERE first_seen > now() - interval '30 minutes'
UNION ALL SELECT 'margin-call edges last 30 min', count(*) FROM shadow_decision WHERE kind LIKE 'margin_call%' AND first_seen > now() - interval '30 minutes'
UNION ALL SELECT 'pairs last 30 min', count(*) FROM shadow_pair WHERE created_at > now() - interval '30 minutes'
UNION ALL SELECT 'unexplained pairs last 30 min', count(*) FROM shadow_pair WHERE created_at > now() - interval '30 minutes' AND class IN ('VALUE','ENGINE_ONLY','WEB_ONLY')
UNION ALL SELECT 'seconds since the newest pair', coalesce(extract(epoch FROM now() - max(created_at))::bigint, -1) FROM shadow_pair;
SELECT class, count(*) FROM shadow_pair WHERE created_at > now() - interval '30 minutes' GROUP BY class ORDER BY class;
'@
$sql | psql -X -q $u
$u = $null
```

Expected:
- `decisions last 30 min` goes up during market hours.
- `pairs last 30 min` goes up whenever there was risk activity, and `seconds since the newest pair` stays in step with
  it.
- `unexplained pairs` is 0 unless a genuine difference occurred. A flapping margin call now shows as MATCH or SNAPSHOT.

Log scan (no secrets; matching lines only):
```powershell
$log = ((& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-engine AppStdout) -join "") -replace "`0",""
Get-Content $log -Tail 400 | Select-String -Pattern "ERROR|panicked|SHADOW REFUSED|reconciler" | Select-Object -Last 15 | ForEach-Object { $_.Line.Substring(0, [Math]::Min(220, $_.Line.Length)) }
```
Expected: no `panicked`, and no `ERROR` other than a genuinely unexplained pair, which is logged with both sides.

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

## Appendix: the diagnosis query (run BEFORE deploying; read-only, prints no secret)

This is the same `$u` setup as in section 3:
```powershell
$sql = @'
SET default_transaction_read_only = on;
SELECT to_char(first_seen,'HH24:MI:SS.MS') t, kind, round(level,2) lvl FROM shadow_decision
 WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind LIKE 'margin_call%' AND first_seen BETWEEN '2026-10-01 04:18Z' AND '2026-10-01 04:23Z' ORDER BY first_seen;
SELECT to_char(web_at,'HH24:MI:SS.MS') web, to_char(shadow_at,'HH24:MI:SS.MS') shadow, class, skew_ms FROM shadow_pair
 WHERE account_id='cmuexlh9r0001jp04yrfxqq9f' AND kind='margin_call_in' AND coalesce(web_at,shadow_at) BETWEEN '2026-10-01 04:18Z' AND '2026-10-01 04:23Z' ORDER BY 1,2;
'@
$sql | psql -X -q $u
$u = $null
```
