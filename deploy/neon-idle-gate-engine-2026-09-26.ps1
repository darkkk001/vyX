# Neon load (2026-09-26): deploy the engine's idle gate and set the owner's timer values. Run on the VPS in an
# elevated PowerShell AFTER main carries the idle-gate commit (git log below must show it).
#
# What changes:
#   * engine build from main: the backstop, the shadow pass and the risk hook / margin trigger reloads skip while no
#     symbol has a fresh tick, the book is flat, or none of the book's symbols ticks (market_data::activity);
#   * start-engine.cmd: VYX_RISK_HOOK_BACKSTOP_SECS=5 (owner: stays 5) and VYX_SHADOW_PASS_SECS=10 (owner: 10).
# Unchanged: ENGINE_ORDER_MANAGEMENT (stays shadow), every DB URL, every secret. Rollback at the bottom.
$ErrorActionPreference = "Stop"
$Repo   = "C:\vyxtrader\repo"
$Cmd    = "C:\vyxtrader\scripts\start-engine.cmd"
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\idle-gate-$Stamp"
$Want   = [ordered]@{ "VYX_RISK_HOOK_BACKSTOP_SECS" = "5"; "VYX_SHADOW_PASS_SECS" = "10" }
New-Item -ItemType Directory -Force $Bk | Out-Null

# ---- STEP 1: code ----
Set-Location $Repo
git fetch --all
git checkout main
git pull --ff-only
git log --oneline -3
if (-not (Select-String -Path "$Repo\engine\market-data\src\activity.rs" -Pattern "pub fn book_gate" -Quiet)) { throw "main does not carry the idle gate yet (engine\market-data\src\activity.rs) -- nothing touched" }

# ---- STEP 2: build (the running exe keeps serving until the restart) ----
Copy-Item "$Repo\engine\target\release\trading-core-server.exe" "$Bk\trading-core-server.pre.exe"
Copy-Item $Cmd "$Bk\start-engine.cmd.pre"
Set-Location "$Repo\engine"
cargo build --release -p server 2>&1 | Select-Object -Last 2
if ($LASTEXITCODE -ne 0) { throw "build failed -- the old engine is still running, nothing restarted" }

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
psql "$storeUrl" -v ON_ERROR_STOP=1 -c "BEGIN READ ONLY; SELECT class, kind, count(*) FROM shadow_pair GROUP BY class, kind ORDER BY 1, 2; SELECT key, value FROM shadow_state ORDER BY key; COMMIT;"

# ---- STEP 5: restart and read the startup lines ----
$log = (nssm get vyxtrader-engine AppStdout).Trim(); $err = (nssm get vyxtrader-engine AppStderr).Trim()
nssm restart vyxtrader-engine
Start-Sleep 20
nssm status vyxtrader-engine
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
# nssm stop vyxtrader-engine
# Copy-Item "<backup dir>\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
# Copy-Item "<backup dir>\start-engine.cmd.pre" C:\vyxtrader\scripts\start-engine.cmd -Force
# nssm start vyxtrader-engine
