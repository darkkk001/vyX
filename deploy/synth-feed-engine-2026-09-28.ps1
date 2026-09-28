# Synthetic symbols, STEP 1 of 4 (2026-09-28, owner go): the engine with /internal/synth-feed, the real-feed v* guard
# and the v* 24/7 candle rule, plus SYNTH_FEED_SECRET. Run on the VPS in an elevated PowerShell.
#
# What changes:
#   * engine built from commit 8d862d0 (branch synth/infra = main + the synthetic work; main moves to it in step 3);
#   * start-engine.cmd gains SYNTH_FEED_SECRET (48 hex, generated HERE, never printed; also written to
#     C:\vyxtrader\secrets\synth-feed-secret.txt for the bot machine). An existing value is kept (re-run safe).
# Unchanged: ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every other secret, VYX_SHADOW_PASS_SECS.
# Stops by itself (and puts the previous exe + start-engine.cmd back) if the build fails, the exe cannot be swapped,
# /health does not answer, or the startup log shows SHADOW REFUSED / no 'read-only role verified'.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Target = "8d862d042622a47198500b1f616b78d9d31a48c3"
$Repo   = "C:\vyxtrader\repo"
$Cmd    = "C:\vyxtrader\scripts\start-engine.cmd"
$SecretFile = "C:\vyxtrader\secrets\synth-feed-secret.txt"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\synth-feed-$Stamp"
New-Item -ItemType Directory -Force $Bk | Out-Null

function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
function Get-NssmValue([string]$Svc, [string]$Key) { ((& $Nssm get $Svc $Key) -join "" -replace "`0", "").Trim() }
function Get-CmdVar([string]$Name) {
  $line = Get-Content $Cmd | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Code([string]$Method, [string]$Url, [hashtable]$Headers, [string]$Body) {
  try {
    $p = @{ UseBasicParsing = $true; Uri = $Url; Method = $Method; Headers = $Headers; TimeoutSec = 8 }
    if ($Body) { $p.Body = $Body; $p.ContentType = "application/json" }
    (Invoke-WebRequest @p).StatusCode
  } catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}

# ---- STEP 1: code (detached at the exact commit) ----
Set-Location $Repo
$before = (Invoke-Native { git rev-parse HEAD }) -join ""
Invoke-Native { git fetch --all } | Out-Null
Invoke-Native { git cat-file -e "$Target^{commit}" } | Out-Null
if ($LASTEXITCODE -ne 0) { throw "commit $Target not found after fetch -- nothing touched" }
"engine changes going live ($($before.Substring(0,7)) -> $($Target.Substring(0,7)), engine\ only):"
Invoke-Native { git log --oneline "$before..$Target" -- engine } | ForEach-Object { "  $_" }
Invoke-Native { git checkout --detach $Target } | Select-Object -Last 1
if (((Invoke-Native { git rev-parse HEAD }) -join "") -ne $Target) { throw "checkout did not land on $Target -- nothing built" }
if (-not (Select-String -Path "$Repo\engine\market-data\src\synthetic.rs" -Pattern 'pub const SYNTH_PREFIX: &str = "v";' -Quiet)) { throw "synthetic.rs missing -- nothing built" }

# ---- STEP 2: build (the running exe keeps serving until the swap) ----
$LiveExe  = "$Repo\engine\target\release\trading-core-server.exe"
$BuildDir = "$Repo\engine\build-tmp"
$BuiltExe = "$BuildDir\release\trading-core-server.exe"
Copy-Item $LiveExe "$Bk\trading-core-server.pre.exe"
Copy-Item $Cmd "$Bk\start-engine.cmd.pre"
Set-Location "$Repo\engine"
$env:CARGO_TARGET_DIR = $BuildDir
Invoke-Native { cargo build --release -p server } -Tail 3
$buildExit = $LASTEXITCODE
Remove-Item Env:\CARGO_TARGET_DIR
if ($buildExit -ne 0) { throw "build failed (exit $buildExit) -- the old engine is still running, nothing restarted" }
$newHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
"built: sha256 $($newHash.Substring(0,16))"

# ---- STEP 3: SYNTH_FEED_SECRET (generated here, never printed) ----
$existing = Get-CmdVar "SYNTH_FEED_SECRET"
if ($existing) { "SYNTH_FEED_SECRET already set in start-engine.cmd (kept)"; $secret = $existing }
else {
  $bytes = New-Object byte[] 24; [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $secret = -join ($bytes | ForEach-Object { $_.ToString("x2") })
  if ($secret -eq (Get-CmdVar "PRICE_FEED_SECRET")) { throw "generated secret equals PRICE_FEED_SECRET (impossible) -- nothing touched" }
  $lines = [System.Collections.Generic.List[string]](Get-Content $Cmd)
  $launch = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '\.exe' -and $lines[$_] -notmatch '^\s*(rem|::|set\s)' })[0]
  if ($null -eq $launch) { throw "launch line not found in $Cmd -- nothing touched" }
  $lines.Insert($launch, 'set "SYNTH_FEED_SECRET=' + $secret + '"')
  Set-Content -Path $Cmd -Value $lines -Encoding ascii
  "SYNTH_FEED_SECRET added to start-engine.cmd (48 hex, not shown)"
}
New-Item -ItemType Directory -Force (Split-Path $SecretFile) | Out-Null
Set-Content -Path $SecretFile -Value $secret -NoNewline -Encoding ascii
"secret file: $SecretFile (copy it to the bot machine; never paste it anywhere public)"

# ---- STEP 4: swap + start ----
function Restore([string]$why) {
  Invoke-Native { & $Nssm stop vyxtrader-engine } | Out-Null
  Start-Sleep 2
  Copy-Item "$Bk\trading-core-server.pre.exe" $LiveExe -Force -ErrorAction SilentlyContinue
  Copy-Item "$Bk\start-engine.cmd.pre" $Cmd -Force
  Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
  throw "$why -- the previous exe and start-engine.cmd were put back and started. Backups: $Bk"
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
foreach ($i in 1..30) { if ((Get-Code GET "http://127.0.0.1:8081/health" @{} $null) -eq 200) { $healthy = $true; break }; Start-Sleep 1 }
if (-not $healthy) { Restore "the new engine did not answer /health within 30 s" }
"engine up: /health 200 (sha256 $($newHash.Substring(0,16)))"
Start-Sleep 15

# ---- STEP 5: shadow health from the startup log ----
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|SHADOW REFUSED|risk hook enabled|risk hook backstop|risk hook margin trigger|risk hook OFF|USING 60|idle gate'
$found = @()
foreach ($f in $logFiles) {
  # a rotated (shorter) file is read whole
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
$recent = $found
if ($recent -match 'SHADOW REFUSED') { Restore "SHADOW REFUSED in the startup log" }
if (-not ($recent -match 'read-only role verified')) { Restore "no 'read-only role verified' in the startup log" }
$pass = ($recent | Where-Object { $_ -match 'order management SHADOW' } | Select-Object -Last 1)
"shadow pass_secs: " + $(if ($pass -match 'pass_secs\D+(\d+)') { $Matches[1] } else { "(not found in the line above)" })

# ---- STEP 6: the new route answers, and refuses what it must (local; nothing is ingested) ----
$h = @{ "x-synth-feed-secret" = $secret }
$c1 = Get-Code POST "http://127.0.0.1:8081/internal/synth-feed" @{ "x-synth-feed-secret" = "wrong" } '{"symbol":"vGOLD","bid":1.0,"ask":1.0}'
$c2 = Get-Code POST "http://127.0.0.1:8081/internal/synth-feed" $h '{"symbol":"XAUUSD","bid":1.0,"ask":1.0}'
"synth-feed wrong secret -> $c1 (want 401); real symbol XAUUSD with the right secret -> $c2 (want 403)"
if ($c1 -ne 401 -or $c2 -ne 403) { Restore "the synth route did not refuse as designed" }
"STEP 1 OK. Backups: $Bk"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe and"
"$Bk\start-engine.cmd.pre over $Cmd; nssm start vyxtrader-engine; then git -C $Repo checkout main."
