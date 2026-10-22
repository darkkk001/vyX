# QoreBridge M5: VPS gateway runbook

This page covers only the **api-gateway** on the VPS: nssm service `vyxtrader-gateway`, running `node dist\index.js` from
`C:\vyxtrader\repo\services\api-gateway` on port 8080. The engine is not rebuilt or restarted.

**What changes:** the backoffice (admin) event stream also subscribes `bridge.result.>`. QoreBridge publishes one
message there after each batch of hedge results it commits, and the backoffice Liquidity screen refreshes its hedges
and UNHEDGED EXPOSURE at once instead of on its next poll. That is the whole diff (`services/api-gateway/src/ws.ts`).
The trader stream never subscribes it, so no client ever sees a hedge.

**Safe before the bridge runs:** nothing publishes `bridge.result.*` until QoreBridge is installed
(`deploy/qorebridge-vps-runbook.md`), so until then the new gateway behaves exactly like the old one. Without this
gateway, hedging still works; the Liquidity screen just updates on its poll.

## Order of the whole rollout

1. The M5 migrations `20261021130000_hedge_intent_result` and `20261021140000_hedge_escalation_notify` are applied on
   ep-morning-glade. Done 2026-10-22 by the coordinator.
2. M5 merged to `main` and deployed on Vercel. The coordinator does this.
3. **This runbook**: gateway build and restart on the VPS (the owner runs it).
4. `deploy/qorebridge-vps-runbook.md`: install the bridge and the simulated LP on the VPS.

A restart drops every price-stream socket for a few seconds. Terminals, WebTrader and the backoffice reconnect on their
own.

## Rules

- Run in an **elevated** Windows PowerShell on the VPS. Paste one block at a time, and check its expected output before
  the next block.
- Nothing below prints a secret or an env value.
- `nssm` is not on the VPS PATH. Always use `$Nssm` (the full path).
- Any `throw` means stop: nothing after it ran. Report the line.

## 0. Setup (paste first; prints nothing secret)

```powershell
$ErrorActionPreference = "Stop"
$Nssm    = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Repo    = "C:\vyxtrader\repo"
$Gw      = "$Repo\services\api-gateway"
$GwCmd   = "C:\vyxtrader\scripts\start-gateway.cmd"
$Bk      = "C:\vyxtrader\backup\m5-gateway-" + (Get-Date -Format "yyyyMMdd-HHmmss")
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
function Get-GwLog { ((& $Nssm get vyxtrader-gateway AppStdout) -join "") -replace "`0", "" }   # a file path, not a secret
New-Item -ItemType Directory -Force $Bk | Out-Null
"backup dir: $Bk"
& $Nssm status vyxtrader-gateway
```

Expected: `SERVICE_RUNNING`.

## 1. Get the code (main, fast-forward only)

The coordinator gives you the merge commit (`<M5_MERGE>` below).

```powershell
$M5Merge = "<M5_MERGE>"
Set-Location $Repo
$PreHead = (git rev-parse HEAD).Trim(); "pre HEAD: $PreHead  branch: $((git rev-parse --abbrev-ref HEAD).Trim())"
$PreHead | Set-Content "$Bk\pre-head.txt"
if (git status --porcelain) { throw "working tree not clean -- stop and report, nothing touched" }
Invoke-Native { git fetch --all } -Tail 3
Invoke-Native { git checkout main } -Tail 2
Invoke-Native { git pull --ff-only } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed -- nothing touched" }
git log --oneline -3
Invoke-Native { git merge-base --is-ancestor $M5Merge HEAD }
if ($LASTEXITCODE -ne 0) { throw "main does not contain $M5Merge yet -- wait for the push, nothing touched" }
if (-not (Select-String -Path "$Gw\src\ws.ts" -Pattern 'bridge\.result\.>' -Quiet)) { throw "src\ws.ts has no bridge.result subscription -- nothing touched" }
"OK: main contains $M5Merge"
```

## 2. Back up the running build (for rollback)

```powershell
Copy-Item -Recurse -Force "$Gw\dist" "$Bk\gateway-dist"
Copy-Item -Force $GwCmd "$Bk\start-gateway.cmd"
"backed up dist ($((Get-ChildItem "$Bk\gateway-dist" -Recurse -File).Count) files) + start-gateway.cmd"
```

## 3. Build (the old gateway keeps serving meanwhile)

```powershell
Set-Location $Gw
Invoke-Native { npm ci } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "npm ci failed -- nothing restarted (old dist still in place)" }
Invoke-Native { npm test } -Tail 6
if ($LASTEXITCODE -ne 0) { throw "gateway tests failed -- nothing restarted" }
Invoke-Native { npm run build } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "build failed -- nothing restarted; restore dist from $Bk\gateway-dist if needed" }
if (-not (Select-String -Path "$Gw\dist\ws.js" -Pattern 'bridge\.result\.>' -Quiet)) { throw "dist\ws.js is not the new build -- nothing restarted" }
"OK: new gateway built ($((Get-Item "$Gw\dist\ws.js").LastWriteTime))"
```

Expected from `npm test`: `ℹ fail 0`.

## 4. Restart and check health

```powershell
Invoke-Native { & $Nssm restart vyxtrader-gateway }
$ok = $false; foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8080/health" @{}) -eq 200) { $ok = $true; break }; Start-Sleep 1 }
if (-not $ok) { "<<< gateway /health not 200 after 30 s -- go to ROLLBACK" } else { "OK: /health 200" }
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 5).Content
"public: HTTP $(Get-Code 'https://feed.vyxtrader.com/health' @{})"
```

Expected: `OK: /health 200`, then `{"ok":true}`, then `public: HTTP 200`.

## 5. Confirm the new build is the one running, still loopback-only

```powershell
$procId = (Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object -First 1).OwningProcess
$started = (Get-Process -Id $procId).StartTime
$built = (Get-Item "$Gw\dist\ws.js").LastWriteTime
"listener pid $procId started $started ; dist\ws.js built $built ; new build running: $($started -gt $built)"
Set-Location $Repo; "repo HEAD: $((git rev-parse --short HEAD).Trim())"
netstat -ano | Select-String ":8080\s" | Select-String "LISTENING"
```

Expected: `new build running: True`, and `127.0.0.1:8080 ... LISTENING` (never `0.0.0.0:8080`).

## 6. Ticks still flow, and the log is clean

```powershell
$H = @{ "x-internal-secret" = (Get-CmdVar $GwCmd "INTERNAL_SERVICE_SECRET") }
"internal secret length: $($H['x-internal-secret'].Length)"
$a = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
Start-Sleep 15
$b = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
"ticks forwarded in 15 s: $($b.ticksForwardedTotal - $a.ticksForwardedTotal) ; NATS msgs: $($b.natsMessagesReceivedTotal - $a.natsMessagesReceivedTotal) ; last tick forwarded $([int]((([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() - $b.lastTickForwardedAtMs)/1000)) s ago"
$H = $null
$log = Get-GwLog; "log file: $log"
Get-Content $log -Tail 80 | Select-String -Pattern "listening|ALERT|Error|error" | Select-Object -Last 15
```

Expected, with markets open and at least one terminal or WebTrader connected:
- `ticks forwarded in 15 s` well above 0, and `last tick forwarded` a few seconds ago;
- a fresh `api-gateway listening on 127.0.0.1:8080`, and no `[ALERT]` line.

If ticks stay at 0 while NATS messages rise and clients are connected, go to ROLLBACK and report.

Then tell the coordinator: "gateway on M5 running, health 200, ticks flowing, log clean".

## ROLLBACK (back to the previous gateway build)

```powershell
$Bk = (Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "m5-gateway-*" | Sort-Object Name | Select-Object -Last 1).FullName
"rolling back from $Bk"
& $Nssm stop vyxtrader-gateway
Remove-Item -Recurse -Force "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Recurse -Force "$Bk\gateway-dist" "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Force "$Bk\start-gateway.cmd" "C:\vyxtrader\scripts\start-gateway.cmd"
& $Nssm start vyxtrader-gateway
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 3).StatusCode -eq 200) { "OK: old gateway back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

The gateway's dependencies did not change, so the old `dist\` runs on the new `node_modules`. The repo stays on `main`,
and the next deploy simply rebuilds. Rolling the gateway back does not affect hedging: the backoffice falls back to its
poll.
