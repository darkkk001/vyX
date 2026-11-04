# Gateway deploy, window 2026-11-05 22:00-23:00 UTC (for the VPS session, or the owner)

Each step still needs the owner's go on the day. Gateway ONLY: service `vyxtrader-gateway`. Do NOT rebuild or restart the engine, do NOT touch the
candle-store, do NOT touch the EA. This commit contains engine code that needs a candle-store column first (tick
volume, not tonight), so the engine must stay on its current build.

Target commit: `e2f62b4d7c46f58ed668ab521ff46831f038bf6a`, branch `gateway/crm-on-vps` on darkkk001/vyX. Its gateway code is exactly `db2fbdf`: `264cc59` (the running gateway, with Bearer sessions and the open-route slippage cap) plus only the Trader's Room, forced password change and config coalescing changes in `services/api-gateway`. The target commit adds the `close_idempotency` migration and schema field, so the VPS repo matches the live database. It does NOT contain the web release.

The VPS repo must be at `264cc59ff8692d3be0e825ab8dc6f46950ade668` (detached, clean). It fast-forwards from there, so nothing is rolled back. Block 1 stops on any other HEAD. The commit after the target on the branch only adds this file.

The `264cc59` deploy (22:21 UTC 2026-11-04, scoped to demo 50005725) passed gates 1 and 2; gates 3 and 4 never finished. Treat Bearer and the slippage cap as live but not fully verified. Block 6 adds a no-order auth check only.

Timing: blocks 0 to 3 may run any time (the old gateway keeps serving). Blocks 4 to 6 restart it: ONLY inside
22:00-23:00 UTC (New York 17:00 close, winter time since 1 Nov). A restart drops price-stream sockets for a few seconds;
apps reconnect on their own.

Run in elevated Windows PowerShell, one block at a time. Any `throw` means stop and report. Nothing here prints a secret.

## 0. Setup

```powershell
$ErrorActionPreference = "Stop"
$Target  = "e2f62b4d7c46f58ed668ab521ff46831f038bf6a"
$Live    = "264cc59ff8692d3be0e825ab8dc6f46950ade668"
$Nssm    = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Repo    = "C:\vyxtrader\repo"
$Gw      = "$Repo\services\api-gateway"
$GwCmd   = "C:\vyxtrader\scripts\start-gateway.cmd"
$Bk      = "C:\vyxtrader\backup\crm-gateway-" + (Get-Date -Format "yyyyMMdd-HHmmss")
function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Code([string]$Url, [hashtable]$Headers) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}
function Get-GwLog { ((& $Nssm get vyxtrader-gateway AppStdout) -join "") -replace "`0", "" }
New-Item -ItemType Directory -Force $Bk | Out-Null
"backup dir: $Bk"
& $Nssm get vyxtrader-gateway AppDirectory
& $Nssm status vyxtrader-gateway
```

Expected: AppDirectory is `C:\vyxtrader\repo\services\api-gateway`, then `SERVICE_RUNNING`. Anything else: stop and report.

## 1. Get the code

The pull is fast-forward only. If the VPS repo holds anything that is not in the target commit, this stops with nothing changed.

```powershell
Set-Location $Repo
$PreHead = (git rev-parse HEAD).Trim(); "pre HEAD: $PreHead  branch: $((git rev-parse --abbrev-ref HEAD).Trim())"
$PreHead | Set-Content "$Bk\pre-head.txt"
if ($PreHead -ne $Live) { throw "VPS HEAD is not 264cc59 -- stop and report, nothing touched" }
if (git status --porcelain --untracked-files=no) { throw "tracked files changed -- stop and report, nothing touched" }
Invoke-Native { git fetch --all } -Tail 3
Invoke-Native { git cat-file -e "$Target^{commit}" }
if ($LASTEXITCODE -ne 0) { throw "target commit not fetched -- check the remote, nothing touched" }
Invoke-Native { git merge-base --is-ancestor HEAD $Target }
if ($LASTEXITCODE -ne 0) { throw "VPS HEAD is not an ancestor of the target -- stop and report, nothing touched" }
Invoke-Native { git merge --ff-only $Target } -Tail 2
if ($LASTEXITCODE -ne 0) { throw "fast-forward failed -- stop and report" }
if (-not (Select-String -Path "$Gw\src\ws.ts" -Pattern 'nc\.subscribe\("order\.>"\)' -Quiet)) { throw "src\ws.ts unexpected -- stop" }
if (-not (Select-String -Path "$Gw\src\ws.ts" -Pattern 'room\.>' -Quiet)) { throw "src\ws.ts has no room stream -- stop" }
"OK: repo at $((git rev-parse --short HEAD).Trim())"
```

## 2. Back up the running build

```powershell
Copy-Item -Recurse -Force "$Gw\dist" "$Bk\gateway-dist"
Copy-Item -Force $GwCmd "$Bk\start-gateway.cmd"
if (-not (Select-String -Path "$Bk\gateway-dist\auth.js" -Pattern 'bearerToken' -Quiet)) { throw "backup has no Bearer sessions -- this is not the 264cc59 build, stop" }
if (-not (Select-String -Path "$Bk\gateway-dist\routes\orders.js" -Pattern 'slippage' -Quiet)) { throw "backup has no slippage cap -- this is not the 264cc59 build, stop" }
"backed up dist ($((Get-ChildItem "$Bk\gateway-dist" -Recurse -File).Count) files) + start-gateway.cmd"
```

## 3. Build (the old gateway keeps serving)

```powershell
Set-Location $Gw
Invoke-Native { npm ci } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "npm ci failed -- nothing restarted" }
Invoke-Native { npm test } -Tail 6
if ($LASTEXITCODE -ne 0) { throw "gateway tests failed -- nothing restarted" }
Invoke-Native { npm run build } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "build failed -- nothing restarted; restore dist from $Bk\gateway-dist" }
if (-not (Select-String -Path "$Gw\dist\ws.js" -Pattern 'observer' -Quiet)) { throw "dist\ws.js is not the new build -- nothing restarted" }
if (-not (Select-String -Path "$Gw\dist\auth.js" -Pattern 'bearerToken' -Quiet)) { throw "new build lost Bearer sessions -- nothing restarted" }
if (-not (Select-String -Path "$Gw\dist\routes\orders.js" -Pattern 'slippage' -Quiet)) { throw "new build lost the slippage cap -- nothing restarted" }
"OK: new gateway built ($((Get-Item "$Gw\dist\ws.js").LastWriteTime))"
```

Expected from `npm test`: `pass 39`, `fail 0`. STOP here until 22:00 UTC.

## 4. Restart and check health (inside the window only)

```powershell
$now = (Get-Date).ToUniversalTime(); if ($now.TimeOfDay -lt [TimeSpan]"22:00:00" -or $now.TimeOfDay -gt [TimeSpan]"23:00:00") { throw "outside the break window ($now UTC)" }
Invoke-Native { & $Nssm restart vyxtrader-gateway }
$ok = $false; foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8080/health" @{}) -eq 200) { $ok = $true; break }; Start-Sleep 1 }
if (-not $ok) { "<<< gateway /health not 200 after 30 s -- go to ROLLBACK" } else { "OK: /health 200" }
"public: HTTP $(Get-Code 'https://feed.vyxtrader.com/health' @{})"
```

Expected: `OK: /health 200`, `public: HTTP 200`.

## 5. New build running, still loopback-only

```powershell
$procId = (Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object -First 1).OwningProcess
$started = (Get-Process -Id $procId).StartTime
$built = (Get-Item "$Gw\dist\ws.js").LastWriteTime
"listener pid $procId started $started ; dist\ws.js built $built ; new build running: $($started -gt $built)"
netstat -ano | Select-String ":8080\s" | Select-String "LISTENING"
```

Expected: `new build running: True`, and `127.0.0.1:8080 ... LISTENING` (never `0.0.0.0:8080`).

## 6. Ticks flow, log clean

Markets are closed in the break, so ticks may be 0 here. Re-run after 23:00 UTC to see them rise.

```powershell
$H = @{ "x-internal-secret" = (Get-CmdVar $GwCmd "INTERNAL_SERVICE_SECRET") }
$a = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
Start-Sleep 15
$b = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
"ticks forwarded in 15 s: $($b.ticksForwardedTotal - $a.ticksForwardedTotal) ; NATS msgs: $($b.natsMessagesReceivedTotal - $a.natsMessagesReceivedTotal)"
$H = $null
# no credentials, so no order can be placed: must answer 401
$c = try { (Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8080/v1/orders/market -TimeoutSec 5).StatusCode } catch { [int]$_.Exception.Response.StatusCode }
"unauthenticated order: HTTP $c"
$log = Get-GwLog
Get-Content $log -Tail 80 | Select-String -Pattern "listening|ALERT|Error|error" | Select-Object -Last 15
```

Expected: `unauthenticated order: HTTP 401`, a fresh `api-gateway listening on 127.0.0.1:8080`, no `[ALERT]` line.

Then report: "gateway on e2f62b4 running, health 200, log clean". The web deploy waits for this report.

## ROLLBACK

Returns to the `264cc59` build, the one running before this deploy, with Bearer sessions and the slippage cap. It uses the newest backup that holds that build, and stops if there is none. An empty backup folder from a re-run of block 0 is skipped. Never restore the 21:27 build.

```powershell
$Bk = Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "crm-gateway-*" | Sort-Object Name -Descending |
  Where-Object { (Test-Path "$($_.FullName)\gateway-dist\auth.js") -and (Test-Path "$($_.FullName)\gateway-dist\routes\orders.js") -and
    (Select-String -Path "$($_.FullName)\gateway-dist\auth.js" -Pattern 'bearerToken' -Quiet) -and
    (Select-String -Path "$($_.FullName)\gateway-dist\routes\orders.js" -Pattern 'slippage' -Quiet) } |
  Select-Object -First 1 -ExpandProperty FullName
if (-not $Bk) { throw "no backup holds the 264cc59 build -- do not stop the gateway, report" }
"rolling back from $Bk"
& $Nssm stop vyxtrader-gateway
Remove-Item -Recurse -Force "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Recurse -Force "$Bk\gateway-dist" "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Force "$Bk\start-gateway.cmd" "C:\vyxtrader\scripts\start-gateway.cmd"
& $Nssm start vyxtrader-gateway
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 3).StatusCode -eq 200) { "OK: old gateway back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

Report any rollback at once: the web deploy must not go ahead.
