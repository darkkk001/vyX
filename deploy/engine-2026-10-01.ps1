# Engine deploy 2026-10-01 (owner go): BOTH shadow fixes in one build, supersedes margin-call-flap-engine-2026-10-01.ps1.
#   1. margin-call flapping (4e9bb50 + ee3bb23): overlapping-episode matcher, deferred margin-call edges (damping A, 5 s);
#   2. the torn pinned read (97b04af): every read of an evaluation in one REPEATABLE READ, READ ONLY snapshot.
# Runbook: deploy\engine-2026-10-01-runbook.md. Run on the VPS in an elevated PowerShell, from the repo, AFTER checking
# out the new main:
#   cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <remote>/main
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-2026-10-01.ps1
#
# What changes: the engine exe only (built from the checked-out HEAD, whose engine\ must be byte-identical to 97b04af's).
# No schema change, no env change: start-engine.cmd, ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every secret,
# VYX_SHADOW_PASS_SECS, VYX_RISK_TRIGGER_MS all untouched.
# The running engine keeps serving during the build (separate target dir); downtime = the stop / swap / start only.
# Stops by itself (and puts the previous exe back) if the build fails, the exe cannot be swapped, /health does not
# answer, or the startup log shows SHADOW REFUSED / reconciler NOT running / a missing required line.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Fix    = "97b04af84fbf1fa88137e8ca30f7d4ed037f8c5d"
$Repo   = "C:\vyxtrader\repo"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\engine-2026-10-01-$Stamp"
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
if (-not (Select-String -Path "$Repo\engine\market-data\src\ingest.rs" -Pattern 'pub fn risk_trigger_interval_from' -Quiet)) { throw "risk_trigger_interval_from missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\book.rs" -Pattern 'pub fn edges_recordable' -Quiet)) { throw "edges_recordable missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\reconcile.rs" -Pattern 'pub fn is_test_broker' -Quiet)) { throw "soak gate code missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\margin_watch.rs" -Pattern 'fired_in_call' -Quiet)) { throw "deferred margin-call edges missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\shadow.rs" -Pattern 'pub fn call_evidence_around' -Quiet)) { throw "overlapping-episode matcher missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\calc.rs" -Pattern 'REPEATABLE READ, READ ONLY' -Quiet)) { throw "torn-read snapshot missing: nothing built" }
$cmdLine = Get-Content "C:\vyxtrader\scripts\start-engine.cmd" | Where-Object { $_ -match '^\s*set\s+"?VYX_RISK_TRIGGER_MS=' } | Select-Object -First 1
if ($cmdLine) { "start-engine.cmd: $($cmdLine.Trim())" } else { "start-engine.cmd: no VYX_RISK_TRIGGER_MS line (the engine default 250 applies)" }
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
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|SHADOW REFUSED|risk hook margin trigger|shadow trigger:|risk trigger loop|VYX_RISK_TRIGGER_MS=|risk hook OFF|idle gate'
$found = @()
foreach ($f in $logFiles) {
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }   # a rotated (shorter) file is read whole
  # colour codes stripped, so `every_ms=250` matches whether or not the log is written with ANSI styling
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line -replace "$([char]27)\[[0-9;]*m", '' }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
if ($found -match 'SHADOW REFUSED') { Restore "SHADOW REFUSED in the startup log" }
if ($found -match 'reconciler NOT running') { Restore "shadow reconciler NOT running (did deploy\shadow-store.sql run as postgres first?)" }
$checks = [ordered]@{
  "shadow read-only role verified"   = 'read-only role verified'
  "shadow reconciler running"        = 'shadow reconciler running'
  "per-tick margin trigger enabled"  = 'risk hook margin trigger enabled'
  "fires pinned to the snapshot"     = 'pinned to the fire'
  "risk trigger loop decoupled"      = 'risk trigger loop: decoupled from the LivePrice write'
  "risk trigger every_ms=250"        = 'risk trigger loop: decoupled.*every_ms=250\b'
}
if ($found -match 'VYX_RISK_TRIGGER_MS=.*USING') { "  WARN VYX_RISK_TRIGGER_MS in start-engine.cmd is not a plain number: the engine uses the default 250 (fix the set line)" }
foreach ($k in $checks.Keys) {
  if ($found -match $checks[$k]) { "  OK  $k" } else { Restore "missing in the startup log: $k" }
}
$pass = ($found | Where-Object { $_ -match 'order management SHADOW' } | Select-Object -Last 1)
$ps = if ($pass -match 'pass_secs\D+(\d+)') { $Matches[1] } else { "?" }
if ($ps -eq "4") { "  OK  shadow pass_secs=4" } else { "  WARN shadow pass_secs=$ps (want 4; this deploy does not change it: check start-engine.cmd)" }
# ---- STEP 5: the new exe is the one running ----
$proc = Get-Process -Name trading-core-server -ErrorAction SilentlyContinue | Select-Object -First 1
$exeTime = (Get-Item $LiveExe).LastWriteTime
if ($proc) { "running pid $($proc.Id) started $($proc.StartTime); exe written $exeTime; new exe running: $($proc.StartTime -gt $exeTime)" } else { "  WARN no trading-core-server process found by name: check nssm status" }
"DEPLOY OK. Backup: $Bk"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe; nssm start vyxtrader-engine."
