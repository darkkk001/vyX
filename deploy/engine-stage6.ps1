# Engine deploy for Stage 6 (owner go needed, NOT run): ships the risk-authority code in SHADOW mode.
#   docs/STAGE6-RUNBOOK-FUTURIX-DEMO.md section 4. Runs AFTER the migration (section 2) and the web (section 3).
#   What this build adds to the engine: risk mode (ENGINE_ORDER_MANAGEMENT=risk), the per-broker authority, the engine-down watchdog
#   (heartbeat), the startup flip-marker WARNING. With ENGINE_ORDER_MANAGEMENT=shadow (what this script requires) NONE of it is active:
#   the shadow behaves exactly as in engine-2026-10-05.ps1. The flip (section 5) is a later, separate step.
# Run on the VPS in an elevated PowerShell, from the repo, AFTER checking out the code the owner approved:
#   cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <full sha>
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-stage6.ps1 -Branch engine/stage6 -Commit <full sha> -OwnerGo "engine/stage6@<full sha>"
#
# NO PIN IN THE FILE, NO DEFAULT THAT PASSES. The script takes the branch and the 40-character commit as parameters and refuses (one line,
# exit code 1, nothing touched, nothing built) unless ALL of these hold:
#   - -Branch, -Commit and -OwnerGo are all given;
#   - -OwnerGo is exactly "<Branch>@<Commit>" (case-sensitive): the owner's explicit go for that exact code;
#   - the checked-out HEAD equals -Commit;
#   - -Commit is on -Branch (an ancestor of the local branch or of any remote's branch of that name).
# -RepoPath (default C:\vyxtrader\repo) exists so the refusals can be tested against another checkout without deploying.
#
# What changes: the engine exe only. No env change: start-engine.cmd, ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every secret
# all untouched. The running engine keeps serving during the build (separate target dir); downtime = the stop / swap / start only.
# Stops by itself (and puts the previous exe back) if the build fails, the exe cannot be swapped, /health does not answer, or the startup
# log shows SHADOW REFUSED / reconciler NOT running / RISK MODE / the flip-marker WARNING / a missing required line.
param(
  [string]$Branch = "",
  [string]$Commit = "",
  [string]$OwnerGo = "",
  [string]$RepoPath = "C:\vyxtrader\repo"
)
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Fix    = $Commit
$Repo   = $RepoPath
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\engine-stage6-$Stamp"

# ---- GATE: the owner's explicit go for exactly this branch + commit; every refusal is one line, exit 1, nothing touched ----
function Refuse([string]$Reason) { Write-Host "REFUSED: $Reason. Nothing touched."; exit 1 }
if (-not $Branch -or -not $Commit -or -not $OwnerGo) { Refuse "-Branch, -Commit and -OwnerGo are all required (OwnerGo = '<Branch>@<full commit sha>')" }
if ($Commit -cnotmatch '^[0-9a-f]{40}$') { Refuse "-Commit must be the full 40-character lower-case sha" }
if ($OwnerGo -cne "$Branch@$Commit") { Refuse "-OwnerGo does not equal '<Branch>@<Commit>': the owner's go is missing or for other code" }
if (-not (Test-Path "$Repo\.git")) { Refuse "$Repo is not a git checkout" }
Set-Location $Repo
$headSha = (& git rev-parse HEAD 2>$null) -join ""
if ($headSha -cne $Commit) { Refuse "checked-out HEAD ($(if ($headSha) { $headSha.Substring(0, [Math]::Min(7, $headSha.Length)) } else { 'unknown' })) is not -Commit ($($Commit.Substring(0, 7)))" }
$onBranch = $false
foreach ($ref in @(& git for-each-ref --format="%(refname)" "refs/heads/$Branch" "refs/remotes/*/$Branch" 2>$null)) {
  & git merge-base --is-ancestor $Commit $ref 2>$null
  if ($LASTEXITCODE -eq 0) { $onBranch = $true; break }
}
if (-not $onBranch) { Refuse "commit $($Commit.Substring(0, 7)) is not on branch '$Branch' (git fetch --all first?)" }
"owner go accepted: $Branch@$($Commit.Substring(0, 7)), HEAD equals it"
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

# ---- STEP 0: the engine must still be in SHADOW (this deploy does not flip anything) ----
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
$modeLine = Get-Content $EngineCmd | Where-Object { $_ -match '^\s*set\s+"?ENGINE_ORDER_MANAGEMENT=' } | Select-Object -First 1
if (-not $modeLine -or ($modeLine -replace '^\s*set\s+"?ENGINE_ORDER_MANAGEMENT=', '' -replace '"\s*$', '').Trim() -ne 'shadow') { throw "start-engine.cmd does not say ENGINE_ORDER_MANAGEMENT=shadow ($modeLine): this deploy is shadow-only. Nothing touched" }
if (Get-Content $EngineCmd | Where-Object { $_ -match '^\s*set\s+"?VYX_RISK_FLIP_INTENT=' }) { throw "start-engine.cmd already carries VYX_RISK_FLIP_INTENT: the flip is section 5, not this step. Nothing touched" }
"start-engine.cmd: $($modeLine.Trim()) (shadow, as required)"

# ---- STEP 1: the checked-out code is the fix ----
Set-Location $Repo
$head = (Invoke-Native { git rev-parse HEAD }) -join ""
if ($head -cne $Fix) { throw "HEAD $($head.Substring(0,7)) is not the approved commit $($Fix.Substring(0,7)). Nothing touched" }
# the Stage 6 code is in (code lines, not doc comments), and the 2026-10-05 code it builds on is still in
$must = @(
  @("order-management\src\authority.rs", 'pub async fn lock_owner_in_tx', "in-transaction owner check"),
  @("order-management\src\authority.rs", 'ENGINE_ALIVE_SQL', "engine-down watchdog (liveness in the rule)"),
  @("order-management\src\authority.rs", 'pub async fn beat', "heartbeat writer"),
  @("order-management\src\authority.rs", 'pub fn flip_marker_warning', "startup flip-marker warning"),
  @("order-management\src\monitor.rs", 'pub fn spawn_live_trigger', "live fire worker"),
  @("market-data\src\risk_hook.rs", 'LiveFire', "fire channel"),
  @("order-management\src\margin_watch.rs", 'decide_engine_now', "fill-event evaluation"),
  @("order-management\src\book.rs", 'pub async fn load_pass_book', "one-snapshot pass book (10-05)"),
  @("order-management\src\calc.rs", 'REPEATABLE READ, READ ONLY', "torn-read snapshot (10-05)"),
  @("market-data\src\pricing.rs", 'pub struct PricingCache', "pricing cache (10-05)")
)
foreach ($m in $must) {
  if (-not (Select-String -Path "$Repo\engine\$($m[0])" -Pattern $m[1] -SimpleMatch -Quiet)) { throw "$($m[2]) missing ($($m[1]) in $($m[0])): nothing built" }
}
"HEAD $($head.Substring(0,7)) is the approved commit $($Fix.Substring(0,7)) on $Branch, Stage 6 code present"

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

# ---- STEP 4: the startup log (this start only): the shadow lines of 2026-10-05, and NOTHING of risk mode ----
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|SHADOW REFUSED|risk hook margin trigger|shadow trigger:|risk trigger loop|VYX_RISK_TRIGGER_MS=|risk hook OFF|idle gate|pricing cache|RISK MODE|risk heartbeat|WARNING: ENGINE_ORDER_MANAGEMENT|flip marker'
$found = @()
foreach ($f in $logFiles) {
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }   # a rotated (shorter) file is read whole
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line -replace "$([char]27)\[[0-9;]*m", '' }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
if ($found -match 'SHADOW REFUSED') { Restore "SHADOW REFUSED in the startup log" }
if ($found -match 'reconciler NOT running') { Restore "shadow reconciler NOT running" }
if ($found -match 'RISK MODE|risk heartbeat') { Restore "risk mode started although ENGINE_ORDER_MANAGEMENT=shadow: the wrong mode is running" }
if ($found -match 'WARNING: ENGINE_ORDER_MANAGEMENT|flip marker') { Restore "the flip-marker warning fired: a live mode is configured on this process" }
$checks = [ordered]@{
  "shadow read-only role verified"   = 'read-only role verified'
  "shadow reconciler running"        = 'shadow reconciler running'
  "per-tick margin trigger enabled"  = 'risk hook margin trigger enabled'
  "fires pinned to the snapshot"     = 'pinned to the fire'
  "risk trigger loop decoupled"      = 'risk trigger loop: decoupled from the LivePrice write'
  "pricing cache loaded"             = 'pricing cache loaded'
  "pricing cache reload on change"   = 'pricing cache: reload on change subscribed'
}
foreach ($k in $checks.Keys) {
  if ($found -match $checks[$k]) { "  OK  $k" } else { Restore "missing in the startup log: $k" }
}
# ---- STEP 5: the new exe is the one running ----
$proc = Get-Process -Name trading-core-server -ErrorAction SilentlyContinue | Select-Object -First 1
$exeTime = (Get-Item $LiveExe).LastWriteTime
if ($proc) { "running pid $($proc.Id) started $($proc.StartTime); exe written $exeTime; new exe running: $($proc.StartTime -gt $exeTime)" } else { "  WARN no trading-core-server process found by name: check nssm status" }
"DEPLOY OK (shadow mode, risk mode NOT active). Backup: $Bk"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe; nssm start vyxtrader-engine."
