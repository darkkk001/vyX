# Engine deploy 2026-10-05 (owner go needed): SUPERSEDES engine-2026-10-01.ps1 (never run) and carries everything it did.
#   1. margin-call flapping (4e9bb50 + ee3bb23) and the torn pinned read (51de153): the held 10-01 deploy, unchanged;
#   2. the idle gate (86a4adc): a frozen quote's heartbeat no longer opens it, v* ticks never do (the weekend the gate
#      stayed open and kept Neon awake);
#   3. the pricing cache + one-snapshot shadow pass (d4743a4 + 65d1908): ask rules from memory (reloaded on
#      config.changed / account.updated), no pricing-table or LivePrice joins, 4 statements per shadow pass;
#   4. D8 (76fe899 = 3338c72, merged d554292): account types take no part in the engine's ask rule (web D4 parity);
#   5. the broker counter (b5c1a2a, DROPPABLE): the reconciler backfills the broker of pairs since the soak start.
# Runbook: deploy\engine-2026-10-05-runbook.md. Run on the VPS in an elevated PowerShell, from the repo, AFTER checking
# out the pinned code:
#   cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <remote>/main
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-2026-10-05.ps1
#
# PIN (re-pinned 2026-10-05 after the owner's "merge to main first"): $Fix is 44f7a51, the merge of
# engine/pricing-cache into main. Its engine\ is byte-identical to b5c1a2a's (the reviewed and tested code). HEAD must
# contain 44f7a51 and its engine\ must equal 44f7a51's; any later engine change on main means re-pinning first.
#
# What changes: the engine exe only. No schema change, no env change: start-engine.cmd, ENGINE_ORDER_MANAGEMENT
# (stays shadow), every DB URL, every secret, VYX_SHADOW_PASS_SECS, VYX_RISK_TRIGGER_MS all untouched.
# The running engine keeps serving during the build (separate target dir); downtime = the stop / swap / start only.
# Stops by itself (and puts the previous exe back) if the build fails, the exe cannot be swapped, /health does not
# answer, or the startup log shows SHADOW REFUSED / reconciler NOT running / a missing required line.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Fix    = "44f7a51071d1bcc24ac291a52964957c455b4e5c"   # 44f7a51: engine/pricing-cache merged into main (engine\ = b5c1a2a's)
$Repo   = "C:\vyxtrader\repo"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\engine-2026-10-05-$Stamp"
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
if ($LASTEXITCODE -ne 0) { throw "HEAD $($head.Substring(0,7)) does not contain $($Fix.Substring(0,7)): check out the pinned code first. Nothing touched" }
Invoke-Native { git diff --quiet $Fix HEAD -- engine } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "HEAD's engine\ differs from $($Fix.Substring(0,7)): not the reviewed code. Nothing touched" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\margin_watch.rs" -Pattern 'pub struct MarginFire' -Quiet)) { throw "MarginFire missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\market-data\src\ingest.rs" -Pattern 'pub fn risk_trigger_interval_from' -Quiet)) { throw "risk_trigger_interval_from missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\book.rs" -Pattern 'pub fn edges_recordable' -Quiet)) { throw "edges_recordable missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\reconcile.rs" -Pattern 'pub fn is_test_broker' -Quiet)) { throw "soak gate code missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\margin_watch.rs" -Pattern 'fired_in_call' -Quiet)) { throw "deferred margin-call edges missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\shadow.rs" -Pattern 'pub fn call_evidence_around' -Quiet)) { throw "overlapping-episode matcher missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\calc.rs" -Pattern 'REPEATABLE READ, READ ONLY' -Quiet)) { throw "torn-read snapshot missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\market-data\src\cache.rs" -Pattern 'pub fn any_moved_at' -Quiet)) { throw "idle-gate moved-at rule missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\market-data\src\pricing.rs" -Pattern 'pub struct PricingCache' -Quiet)) { throw "pricing cache missing: nothing built" }
if (-not (Select-String -Path "$Repo\engine\order-management\src\book.rs" -Pattern 'pub async fn load_pass_book' -Quiet)) { throw "one-snapshot pass book missing: nothing built" }
# code lines only: the file's doc comments name the removed LEVELS_JOINS on purpose (fixed 2026-10-05: the first run
# stopped here on those comments)
$joins = Select-String -Path "$Repo\engine\market-data\src\ask_markup.rs" -Pattern 'LEVELS_JOINS|am_at\b|AccountTypeSymbolConfig am_' | Where-Object { $_.Line -notmatch '^\s*//' }
if ($joins) { throw "pricing joins / account-type levels still present (pricing cache or D8 not in), line(s) $(($joins | ForEach-Object { $_.LineNumber }) -join ', '): nothing built" }
$broker = Select-String -Path "$Repo\engine\order-management\src\reconcile.rs" -Pattern 'pub async fn backfill_brokers' -Quiet
"broker backfill (b5c1a2a, droppable): $(if ($broker) { 'in this build' } else { 'NOT in this build (dropped): skip runbook section 5' })"
$cmdLine = Get-Content "C:\vyxtrader\scripts\start-engine.cmd" | Where-Object { $_ -match '^\s*set\s+"?VYX_RISK_TRIGGER_MS=' } | Select-Object -First 1
if ($cmdLine) { "start-engine.cmd: $($cmdLine.Trim())" } else { "start-engine.cmd: no VYX_RISK_TRIGGER_MS line (the engine default 250 applies)" }
"HEAD $($head.Substring(0,7)) carries the pin $($Fix.Substring(0,7)) (engine\ identical)"

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
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|SHADOW REFUSED|risk hook margin trigger|shadow trigger:|risk trigger loop|VYX_RISK_TRIGGER_MS=|risk hook OFF|idle gate|pricing cache'
$found = @()
foreach ($f in $logFiles) {
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }   # a rotated (shorter) file is read whole
  # colour codes stripped, so `every_ms=250` matches whether or not the log is written with ANSI styling
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line -replace "$([char]27)\[[0-9;]*m", '' }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
if ($found -match 'SHADOW REFUSED') { Restore "SHADOW REFUSED in the startup log" }
if ($found -match 'reconciler NOT running') { Restore "shadow reconciler NOT running (did deploy\shadow-store.sql run as postgres first?)" }
if ($found -match 'pricing cache: reload failed') { "  WARN pricing cache: a reload failed at start (it retries every second; check the role can read the pricing tables)" }
$checks = [ordered]@{
  "shadow read-only role verified"   = 'read-only role verified'
  "shadow reconciler running"        = 'shadow reconciler running'
  "per-tick margin trigger enabled"  = 'risk hook margin trigger enabled'
  "fires pinned to the snapshot"     = 'pinned to the fire'
  "risk trigger loop decoupled"      = 'risk trigger loop: decoupled from the LivePrice write'
  "risk trigger every_ms=250"        = 'risk trigger loop: decoupled.*every_ms=250\b'
  "pricing cache loaded"             = 'pricing cache loaded'
  "pricing cache reload on change"   = 'pricing cache: reload on change subscribed'
}
if ($found -match 'VYX_RISK_TRIGGER_MS=.*USING') { "  WARN VYX_RISK_TRIGGER_MS in start-engine.cmd is not a plain number: the engine uses the default 250 (fix the set line)" }
foreach ($k in $checks.Keys) {
  if ($found -match $checks[$k]) { "  OK  $k" } else { Restore "missing in the startup log: $k" }
}
$pass = ($found | Where-Object { $_ -match 'order management SHADOW' } | Select-Object -Last 1)
$ps = if ($pass -match 'pass_secs\D+(\d+)') { $Matches[1] } else { "?" }
"  INFO shadow pass_secs=$ps (unchanged by this deploy; with the one-snapshot pass a 4 s pass costs 4 statements, so a relief value of 60 can go back to 4 after section 3)"
# ---- STEP 5: the new exe is the one running ----
$proc = Get-Process -Name trading-core-server -ErrorAction SilentlyContinue | Select-Object -First 1
$exeTime = (Get-Item $LiveExe).LastWriteTime
if ($proc) { "running pid $($proc.Id) started $($proc.StartTime); exe written $exeTime; new exe running: $($proc.StartTime -gt $exeTime)" } else { "  WARN no trading-core-server process found by name: check nssm status" }
"DEPLOY OK. Backup: $Bk"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe; nssm start vyxtrader-engine."
