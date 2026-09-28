# Shadow margin-trigger fan-in fix (2026-09-29, owner go): the per-tick margin trigger hands the shadow the fire's
# pinned snapshot (27bf7a9) instead of just the account id. Run on the VPS in an elevated PowerShell, from the repo,
# AFTER checking out the new main (see the commands in the deploy note):
#   cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <remote>/main
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\shadow-margin-fire-pin-engine-2026-09-29.ps1
#
# What changes: the engine exe only (built from the checked-out HEAD, which must carry 27bf7a9's engine\ exactly).
# Unchanged: start-engine.cmd, ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every secret, VYX_SHADOW_PASS_SECS.
# The running engine keeps serving during the build (separate target dir); downtime = the stop / swap / start only.
# Stops by itself (and puts the previous exe back) if the build fails, the exe cannot be swapped, /health does not
# answer, or the startup log shows SHADOW REFUSED / reconciler NOT running / a missing required line.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Fix    = "27bf7a9aebe797209ea1028dc14641d2a41e17a5"
$Repo   = "C:\vyxtrader\repo"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\margin-fire-pin-$Stamp"
New-Item -ItemType Directory -Force $Bk | Out-Null

function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
function Get-NssmValue([string]$Svc, [string]$Key) { ((& $Nssm get $Svc $Key) -join "" -replace "`0", "").Trim() }
function Get-Code([string]$Url) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}

# ---- STEP 1: the checked-out code is the fix ----
Set-Location $Repo
$head = (Invoke-Native { git rev-parse HEAD }) -join ""
Invoke-Native { git cat-file -e "$Fix^{commit}" } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "commit $Fix not found: run git fetch --all first. Nothing touched" }
Invoke-Native { git merge-base --is-ancestor $Fix HEAD } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "HEAD $($head.Substring(0,7)) does not contain $($Fix.Substring(0,7)): check out the new main first. Nothing touched" }
Invoke-Native { git diff --quiet $Fix HEAD -- engine } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "HEAD's engine\ differs from $($Fix.Substring(0,7)): not the reviewed code. Nothing touched" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\margin_watch.rs" -Pattern 'pub struct MarginFire' -Quiet)) { throw "MarginFire missing: nothing built" }
"HEAD $($head.Substring(0,7)) carries the fix $($Fix.Substring(0,7)) (engine\ identical)"

# ---- STEP 2: build (the running exe keeps serving until the swap) ----
$LiveExe  = "$Repo\engine\target\release\trading-core-server.exe"
$BuildDir = "$Repo\engine\build-tmp"
$BuiltExe = "$BuildDir\release\trading-core-server.exe"
Copy-Item $LiveExe "$Bk\trading-core-server.pre.exe"
Set-Location "$Repo\engine"
$env:CARGO_TARGET_DIR = $BuildDir
Invoke-Native { cargo build --release -p server } -Tail 3
$buildExit = $LASTEXITCODE
Remove-Item Env:\CARGO_TARGET_DIR
if ($buildExit -ne 0) { throw "build failed (exit $buildExit): the old engine is still running, nothing restarted" }
$newHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
"built: sha256 $($newHash.Substring(0,16))"

# ---- STEP 3: swap + start ----
function Restore([string]$why) {
  Invoke-Native { & $Nssm stop vyxtrader-engine } | Out-Null
  Start-Sleep 2
  Copy-Item "$Bk\trading-core-server.pre.exe" $LiveExe -Force -ErrorAction SilentlyContinue
  Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
  throw "${why}: the previous exe was put back and started. Backup: $Bk"
}
$log = Get-NssmValue vyxtrader-engine AppStdout; $err = Get-NssmValue vyxtrader-engine AppStderr
# only the lines written after this restart count (the logs are appended to; an old OK line must not mask a failure)
$logFiles = @($log, $err) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) } | Select-Object -Unique
$startAt = @{}; foreach ($f in $logFiles) { $startAt[$f] = @(Get-Content $f).Count }
Invoke-Native { & $Nssm stop vyxtrader-engine } | Out-Null
$copied = $false
foreach ($try in 1..10) { try { Copy-Item $BuiltExe $LiveExe -Force -ErrorAction Stop; $copied = $true; break } catch { Start-Sleep 1 } }
if (-not $copied -or (Get-FileHash $LiveExe -Algorithm SHA256).Hash -ne $newHash) { Restore "could not put the new exe in place" }
Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
$healthy = $false
foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8081/health") -eq 200) { $healthy = $true; break }; Start-Sleep 1 }
if (-not $healthy) { Restore "the new engine did not answer /health within 30 s" }
"engine up: /health 200 (sha256 $($newHash.Substring(0,16)))"
Start-Sleep 15

# ---- STEP 4: the startup log (this start only) ----
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|SHADOW REFUSED|risk hook margin trigger|shadow trigger:|risk hook OFF|idle gate'
$found = @()
foreach ($f in $logFiles) {
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }   # a rotated (shorter) file is read whole
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
if ($found -match 'SHADOW REFUSED') { Restore "SHADOW REFUSED in the startup log" }
if ($found -match 'reconciler NOT running') { Restore "shadow reconciler NOT running" }
$checks = [ordered]@{
  "shadow read-only role verified"   = 'read-only role verified'
  "shadow reconciler running"        = 'shadow reconciler running'
  "per-tick margin trigger enabled"  = 'risk hook margin trigger enabled'
  "fires pinned to the snapshot"     = 'pinned to the fire'
}
foreach ($k in $checks.Keys) {
  if ($found -match $checks[$k]) { "  OK  $k" } else { Restore "missing in the startup log: $k" }
}
$pass = ($found | Where-Object { $_ -match 'order management SHADOW' } | Select-Object -Last 1)
$ps = if ($pass -match 'pass_secs\D+(\d+)') { $Matches[1] } else { "?" }
if ($ps -eq "4") { "  OK  shadow pass_secs=4" } else { "  WARN shadow pass_secs=$ps (want 4; this deploy does not change it: check start-engine.cmd)" }
"DEPLOY OK. Backup: $Bk"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe; nssm start vyxtrader-engine."
