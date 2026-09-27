# Neon load (2026-09-26): deploy the engine's idle gate and set the owner's timer values. Run on the VPS in an
# elevated PowerShell AFTER main carries the idle-gate commit (git log below must show it).
#
# What changes:
#   * engine build from main: the backstop, the shadow pass and the risk hook / margin trigger reloads skip while no
#     symbol has a fresh tick, the book is flat, or none of the book's symbols ticks (market_data::activity);
#   * start-engine.cmd: VYX_RISK_HOOK_BACKSTOP_SECS=5 (owner: stays 5) and VYX_SHADOW_PASS_SECS=10 (owner: 10).
# Unchanged: ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every secret. Rollback at the bottom.
$ErrorActionPreference = "Stop"
$Nssm = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH (2026-09-26): always the full path

# Windows PowerShell 5.1 turns a native program's stderr into error records when it is redirected (2>&1), and with
# $ErrorActionPreference = "Stop" the first one ends the script -- cargo writes its progress ("Compiling ...") to
# stderr, so a successful build stopped the deploy (owner, 2026-09-26). Every native call goes through Invoke-Native:
# the preference is relaxed for that call only, every line is shown as plain text, and success is judged by the exit
# code, which the caller checks.
function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = & $Command 2>&1 | ForEach-Object { "$_" }
    if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out }
  } finally {
    $ErrorActionPreference = $prev
  }
}
$Repo   = "C:\vyxtrader\repo"
$Cmd    = "C:\vyxtrader\scripts\start-engine.cmd"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\idle-gate-$Stamp"
$Want   = [ordered]@{ "VYX_RISK_HOOK_BACKSTOP_SECS" = "5"; "VYX_SHADOW_PASS_SECS" = "10" }
New-Item -ItemType Directory -Force $Bk | Out-Null

# ---- STEP 1: code ----
Set-Location $Repo
Invoke-Native { git fetch --all }
Invoke-Native { git checkout main }
Invoke-Native { git pull --ff-only }
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed -- nothing touched" }
Invoke-Native { git log --oneline -3 }
if (-not (Select-String -Path "$Repo\engine\market-data\src\activity.rs" -Pattern "pub fn book_gate" -Quiet)) { throw "main does not carry the idle gate yet (engine\market-data\src\activity.rs) -- nothing touched" }

# ---- STEP 2: build (the running exe keeps serving until the restart) ----
# The service runs engine\target\release\trading-core-server.exe and Windows locks a running exe, so cargo cannot
# overwrite it ("Access is denied", owner 2026-09-27). Build into engine\build-tmp instead (its own cargo target
# directory: the first build there is a full one, later ones are incremental); step 5 stops the service, copies the
# new exe into place, and starts it.
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
if (-not (Test-Path $BuiltExe)) { throw "build reported success but $BuiltExe is missing -- nothing restarted" }
$newHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
"built: $BuiltExe (sha256 $($newHash.Substring(0,16)))"

# ---- STEP 3: the two timer values (update in place, else insert above the launch line; no duplicates) ----
$lines = [System.Collections.Generic.List[string]](Get-Content $Cmd)
"BEFORE:"; $lines | Select-String -Pattern ($Want.Keys -join "|") | ForEach-Object { "  " + $_.Line }
foreach ($k in $Want.Keys) {
  $rx = '^\s*set\s+"?' + [regex]::Escape($k) + '='
  $idx = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $rx })
  $newLine = 'set "' + $k + '=' + $Want[$k] + '"'
  if ($idx.Count -gt 0) {
    $lines[$idx[0]] = $newLine
    foreach ($extra in ($idx | Select-Object -Skip 1 | Sort-Object -Descending)) { $lines.RemoveAt($extra) }
  } else {
    $launch = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '\.exe' -and $lines[$_] -notmatch '^\s*(rem|::|set\s)' })[0]
    if ($null -eq $launch) { throw "launch line not found in $Cmd -- restore $Bk\start-engine.cmd.pre if needed" }
    $lines.Insert($launch, $newLine)
  }
}
Set-Content -Path $Cmd -Value $lines -Encoding ascii
"AFTER:"; Get-Content $Cmd | Select-String -Pattern ($Want.Keys -join "|") | ForEach-Object { "  " + $_.Line }

# ---- STEP 4: shadow soak state before the restart (read-only, the engine's local store) ----
$envLines = Get-Content $Cmd
function Get-CmdVar($name) { ($envLines | Where-Object { $_ -match ('^\s*set\s+"?' + $name + '=') } | Select-Object -First 1) -replace ('^\s*set\s+"?' + $name + '='), '' -replace '"\s*$', '' }
$storeUrl = Get-CmdVar "VYX_SHADOW_STORE_URL"; if (-not $storeUrl) { $storeUrl = Get-CmdVar "MARKET_DATA_DATABASE_URL" }
Invoke-Native { psql "$storeUrl" -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT class, kind, count(*) FROM shadow_pair GROUP BY class, kind ORDER BY 1, 2; SELECT key, value FROM shadow_state ORDER BY key; COMMIT;" }

# ---- STEP 5: stop, put the new exe in place, start, read the startup lines ----
$log = (& $Nssm get vyxtrader-engine AppStdout).Trim(); $err = (& $Nssm get vyxtrader-engine AppStderr).Trim()
Invoke-Native { & $Nssm stop vyxtrader-engine }
# the process can take a moment to release the exe after the service reports stopped
$copied = $false
foreach ($try in 1..10) {
  try { Copy-Item $BuiltExe $LiveExe -Force -ErrorAction Stop; $copied = $true; break } catch { Start-Sleep 1 }
}
if (-not $copied -or (Get-FileHash $LiveExe -Algorithm SHA256).Hash -ne $newHash) {
  Copy-Item "$Bk\trading-core-server.pre.exe" $LiveExe -Force -ErrorAction SilentlyContinue
  Invoke-Native { & $Nssm start vyxtrader-engine }
  throw "could not put the new exe in place (still locked?) -- the previous exe was restored and started"
}
"new exe in place: $LiveExe (sha256 $($newHash.Substring(0,16)))"
Invoke-Native { & $Nssm start vyxtrader-engine }
Start-Sleep 20
& $Nssm status vyxtrader-engine
$pattern = 'read-only role verified|shadow reconciler|order management SHADOW|risk hook backstop|risk hook margin trigger|risk hook enabled|risk hook OFF|SHADOW REFUSED|USING 60|idle gate'
foreach ($f in @($log, $err) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -Unique) {
  "---- $f ----"
  Get-Content $f -Tail 400 | Select-String -Pattern $pattern | ForEach-Object { $_.Line }
}
"Expect: 'order management SHADOW' pass_secs=10, 'risk hook backstop enabled' every_secs=5, 'risk hook margin trigger enabled',"
"'shadow reconciler running', 'read-only role verified', and NO 'SHADOW REFUSED' / 'USING 60' / 'risk hook OFF'."
"With the market closed (weekend) also: 'idle gate: skipping until the book can move' for 'risk hook backstop' and 'shadow pass'"
"(once each, not repeating). They switch to 'idle gate: resumed' on the first fresh tick after the reopen."
"Backups: $Bk"

# ---- ROLLBACK (only if needed) ----
# & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" stop vyxtrader-engine
# Copy-Item "<backup dir>\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
# Copy-Item "<backup dir>\start-engine.cmd.pre" C:\vyxtrader\scripts\start-engine.cmd -Force
# & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" start vyxtrader-engine
