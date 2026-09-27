# Rotate INTERNAL_SERVICE_SECRET and MARKET_DATA_READ_SECRET without a refused call (owner, 2026-09-28: both exposed).
# Runbook: deploy/market-data-vps-runbook.md "Rotating INTERNAL_SERVICE_SECRET and MARKET_DATA_READ_SECRET (2026-09-28)".
# Run on the VPS in an elevated PowerShell. NEVER PRINTS A SECRET: the new values are pasted at hidden prompts, the old
# ones are read from the .cmd files, and the checks print HTTP codes only.
#
#   -Phase Overlap : pulls main, builds the engine (engine\build-tmp) and the gateway that accept *_PREVIOUS, then in
#                    ONE restart of each: new values current, old values kept as *_PREVIOUS. Checks OLD and NEW are
#                    both accepted. Next: Caddy (read matcher OLD or NEW, header_up NEW; caddy reload), then Vercel.
#   -Phase Finish  : once Vercel runs on the new values AND caddy-rotate-secrets-2026-09-28.ps1 -Phase Finish has run
#                    (it reads the OLD values from the *_PREVIOUS lines this phase removes): *_PREVIOUS removed, engine
#                    + gateway restarted. Checks OLD is refused and NEW accepted.
# Each engine restart is ~10-20 s with no price reads (no Neon fallback any more): run both phases in the daily break.
param([Parameter(Mandatory)][ValidateSet("Overlap", "Finish")][string]$Phase)
$ErrorActionPreference = "Stop"
$Nssm = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path

# Windows PowerShell 5.1 turns a redirected native program's stderr into error records, which "Stop" makes fatal
# (cargo and npm write progress to stderr). Relax it per call; the caller checks $LASTEXITCODE.
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
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
# replace in place (dropping duplicates), else insert above the launch line
function Set-CmdVar([string]$Path, [string]$Name, [string]$Value) {
  $lines = [System.Collections.Generic.List[string]](Get-Content $Path)
  $rx = '^\s*set\s+"?' + [regex]::Escape($Name) + '='
  $idx = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match $rx })
  $newLine = 'set "' + $Name + '=' + $Value + '"'
  if ($idx.Count -gt 0) {
    $lines[$idx[0]] = $newLine
    foreach ($extra in ($idx | Select-Object -Skip 1 | Sort-Object -Descending)) { $lines.RemoveAt($extra) }
  } else {
    $launch = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '\.(exe|js)\b|^\s*(node|npm)\s' -and $lines[$_] -notmatch '^\s*(rem|::|set\s)' })[0]
    if ($null -eq $launch) {
      $lastSet = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '^\s*set\s' })[-1]
      if ($null -eq $lastSet) { throw "neither a launch line nor a set line in $Path -- restore both .cmd files from the backup directory" }
      $launch = $lastSet + 1
    }
    $lines.Insert($launch, $newLine)
  }
  Set-Content -Path $Path -Value $lines -Encoding ascii
}
function Remove-CmdVar([string]$Path, [string]$Name) {
  $rx = '^\s*set\s+"?' + [regex]::Escape($Name) + '='
  $kept = @(Get-Content $Path | Where-Object { $_ -notmatch $rx })
  Set-Content -Path $Path -Value $kept -Encoding ascii
}
function Read-Secret([string]$Prompt) {
  $s = Read-Host -Prompt $Prompt -AsSecureString
  $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s)
  try { ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)).Trim() } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
}
function Get-Code([string]$Url, [hashtable]$Headers) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}
$script:Bad = 0
function Check([string]$Label, [string]$Url, [string]$Header, [string]$Value, [int]$Want) {
  $got = Get-Code $Url @{ $Header = $Value }
  if ($got -ne $Want) { $script:Bad++ }
  "  {0,-52} HTTP {1,3}  want {2}  {3}" -f $Label, $got, $Want, $(if ($got -eq $Want) { "OK" } else { "<<< WRONG" })
}
function Wait-Health([string]$Url) {
  foreach ($i in 1..30) { if ((Get-Code $Url @{}) -eq 200) { return $true }; Start-Sleep 1 }
  return $false
}

$Repo     = "C:\vyxtrader\repo"
$Engine   = "C:\vyxtrader\scripts\start-engine.cmd"
$Gateway  = "C:\vyxtrader\scripts\start-gateway.cmd"
$LiveExe  = "$Repo\engine\target\release\trading-core-server.exe"
$BuildDir = "$Repo\engine\build-tmp"
$BuiltExe = "$BuildDir\release\trading-core-server.exe"
$Bk       = "C:\vyxtrader\backup\rotate-internal-read-$Phase-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force $Bk | Out-Null
Copy-Item $Engine  "$Bk\start-engine.cmd.pre"
Copy-Item $Gateway "$Bk\start-gateway.cmd.pre"

if ($Phase -eq "Overlap") {
  # ---- read the current values and the new ones (before any build, so a wrong paste costs nothing) ----
  $oldInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET"
  $oldRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET"
  if (-not $oldInternal) { throw "INTERNAL_SERVICE_SECRET not in $Engine -- nothing touched" }
  if ((Get-CmdVar $Gateway "INTERNAL_SERVICE_SECRET") -ne $oldInternal) { throw "engine and gateway INTERNAL_SERVICE_SECRET differ today -- nothing touched" }
  if (Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET_PREVIOUS") { throw "a *_PREVIOUS line is already in $Engine (an earlier Overlap?) -- run -Phase Finish first; nothing touched" }
  $newInternal = Read-Secret "New INTERNAL_SERVICE_SECRET (paste, hidden)"
  $newRead     = Read-Secret "New MARKET_DATA_READ_SECRET (paste, hidden)"
  foreach ($v in $newInternal, $newRead) { if ($v -notmatch '^[0-9a-f]{48}$') { throw "each new value must be the 48 hex characters generated for this rotation -- nothing touched" } }
  if ($newInternal -eq $newRead) { throw "the two new values are the same -- nothing touched" }
  if ($newInternal -eq $oldInternal -or $newRead -eq $oldRead) { throw "a new value equals the old one -- nothing touched" }

  # ---- code: main must carry the *_PREVIOUS support in both services ----
  Set-Location $Repo
  Invoke-Native { git fetch --all }
  Invoke-Native { git checkout main }
  Invoke-Native { git pull --ff-only }
  if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed -- nothing touched" }
  Invoke-Native { git log --oneline -3 }
  if (-not (Select-String -Path "$Repo\engine\server\src\main.rs" -Pattern "INTERNAL_SERVICE_SECRET_PREVIOUS" -Quiet)) { throw "main's engine has no *_PREVIOUS support yet -- nothing touched" }
  if (-not (Test-Path "$Repo\services\api-gateway\src\internal-secret.ts")) { throw "main's gateway has no internal-secret.ts yet -- nothing touched" }

  # ---- build both while the old ones keep serving ----
  Copy-Item $LiveExe "$Bk\trading-core-server.pre.exe"
  Set-Location "$Repo\engine"
  $env:CARGO_TARGET_DIR = $BuildDir
  Invoke-Native { cargo build --release -p server } -Tail 3
  $buildExit = $LASTEXITCODE
  Remove-Item Env:\CARGO_TARGET_DIR
  if ($buildExit -ne 0 -or -not (Test-Path $BuiltExe)) { throw "engine build failed (exit $buildExit) -- nothing restarted, nothing changed" }
  $newHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
  "engine built (sha256 $($newHash.Substring(0,16)))"
  Set-Location "$Repo\services\api-gateway"
  Invoke-Native { npm ci } -Tail 2
  if ($LASTEXITCODE -ne 0) { throw "gateway npm ci failed -- nothing restarted, nothing changed" }
  Invoke-Native { npm run build } -Tail 3
  if ($LASTEXITCODE -ne 0) { throw "gateway build failed -- nothing restarted (dist\ may be partly rebuilt: fix, or git checkout the previous commit and rebuild)" }
  if (-not (Select-String -Path "$Repo\services\api-gateway\dist\internal-secret.js" -Pattern "INTERNAL_SERVICE_SECRET_PREVIOUS" -Quiet)) { throw "gateway dist\ lacks internal-secret.js -- nothing restarted" }
  "gateway built"

  # ---- secrets: new current, old kept as *_PREVIOUS ----
  Set-CmdVar $Engine  "INTERNAL_SERVICE_SECRET" $newInternal
  Set-CmdVar $Engine  "INTERNAL_SERVICE_SECRET_PREVIOUS" $oldInternal
  Set-CmdVar $Engine  "MARKET_DATA_READ_SECRET" $newRead
  if ($oldRead) { Set-CmdVar $Engine "MARKET_DATA_READ_SECRET_PREVIOUS" $oldRead }
  Set-CmdVar $Gateway "INTERNAL_SERVICE_SECRET" $newInternal
  Set-CmdVar $Gateway "INTERNAL_SERVICE_SECRET_PREVIOUS" $oldInternal
  "start-engine.cmd + start-gateway.cmd updated (backups in $Bk)"

  # ---- engine: stop, new exe in place, start ----
  Invoke-Native { & $Nssm stop vyxtrader-engine }
  $copied = $false
  foreach ($try in 1..10) { try { Copy-Item $BuiltExe $LiveExe -Force -ErrorAction Stop; $copied = $true; break } catch { Start-Sleep 1 } }
  if (-not $copied -or (Get-FileHash $LiveExe -Algorithm SHA256).Hash -ne $newHash) {
    Copy-Item "$Bk\trading-core-server.pre.exe" $LiveExe -Force -ErrorAction SilentlyContinue
    Copy-Item "$Bk\start-engine.cmd.pre" $Engine -Force; Copy-Item "$Bk\start-gateway.cmd.pre" $Gateway -Force
    Invoke-Native { & $Nssm start vyxtrader-engine }
    throw "could not put the new exe in place -- previous exe + both .cmd files restored, engine started on them; gateway untouched"
  }
  Invoke-Native { & $Nssm start vyxtrader-engine }
  if (-not (Wait-Health "http://127.0.0.1:8081/health")) { "  <<< engine /health not 200 after 30 s -- see ROLLBACK at the bottom of this script" }
  Invoke-Native { & $Nssm restart vyxtrader-gateway }
  if (-not (Wait-Health "http://127.0.0.1:8080/health")) { "  <<< gateway /health not 200 after 30 s -- see ROLLBACK" }

  "Overlap checks (both values must be accepted):"
  Check "engine feed-stats  NEW internal" "http://127.0.0.1:8081/internal/feed-stats" "x-internal-secret" $newInternal 200
  Check "engine feed-stats  OLD internal" "http://127.0.0.1:8081/internal/feed-stats" "x-internal-secret" $oldInternal 200
  Check "engine price       NEW read" "http://127.0.0.1:8081/internal/prices/XAUUSD" "x-market-data-secret" $newRead 200
  if ($oldRead) { Check "engine price       OLD read" "http://127.0.0.1:8081/internal/prices/XAUUSD" "x-market-data-secret" $oldRead 200 }
  Check "gateway stats      NEW internal" "http://127.0.0.1:8080/internal/gateway-stats" "x-internal-secret" $newInternal 200
  Check "gateway stats      OLD internal" "http://127.0.0.1:8080/internal/gateway-stats" "x-internal-secret" $oldInternal 200
  Check "engine price       a wrong value" "http://127.0.0.1:8081/internal/prices/XAUUSD" "x-market-data-secret" "not-the-secret" 401
  $next = "Next: caddy-rotate-secrets-2026-09-28.ps1 -Phase Overlap, then Vercel."
} else {
  $newInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET"
  $oldInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET_PREVIOUS"
  $newRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET"
  $oldRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET_PREVIOUS"
  if (-not $oldInternal) { throw "no INTERNAL_SERVICE_SECRET_PREVIOUS in $Engine (was -Phase Overlap run?) -- nothing touched" }
  $CaddyBk = @(Get-ChildItem "C:\vyxtrader\backup\Caddyfile.pre-rotation-Finish-*" -ErrorAction SilentlyContinue)
  if ($CaddyBk.Count -eq 0) { throw "run caddy-rotate-secrets-2026-09-28.ps1 -Phase Finish first (it needs the *_PREVIOUS lines) -- nothing touched" }
  foreach ($f in $Engine, $Gateway) { Remove-CmdVar $f "INTERNAL_SERVICE_SECRET_PREVIOUS" }
  Remove-CmdVar $Engine "MARKET_DATA_READ_SECRET_PREVIOUS"
  "*_PREVIOUS removed from start-engine.cmd + start-gateway.cmd (backups in $Bk)"
  Invoke-Native { & $Nssm restart vyxtrader-engine }
  if (-not (Wait-Health "http://127.0.0.1:8081/health")) { "  <<< engine /health not 200 after 30 s" }
  Invoke-Native { & $Nssm restart vyxtrader-gateway }
  if (-not (Wait-Health "http://127.0.0.1:8080/health")) { "  <<< gateway /health not 200 after 30 s" }

  "Finish checks (NEW accepted, OLD refused):"
  Check "engine feed-stats  NEW internal" "http://127.0.0.1:8081/internal/feed-stats" "x-internal-secret" $newInternal 200
  Check "engine feed-stats  OLD internal" "http://127.0.0.1:8081/internal/feed-stats" "x-internal-secret" $oldInternal 401
  Check "engine price       NEW read" "http://127.0.0.1:8081/internal/prices/XAUUSD" "x-market-data-secret" $newRead 200
  if ($oldRead) { Check "engine price       OLD read" "http://127.0.0.1:8081/internal/prices/XAUUSD" "x-market-data-secret" $oldRead 401 }
  Check "gateway stats      NEW internal" "http://127.0.0.1:8080/internal/gateway-stats" "x-internal-secret" $newInternal 200
  Check "gateway stats      OLD internal" "http://127.0.0.1:8080/internal/gateway-stats" "x-internal-secret" $oldInternal 401
  $next = "Rotation done. Delete the generated secrets file on the admin PC."
}
Remove-Variable newInternal, newRead, oldInternal, oldRead -ErrorAction SilentlyContinue
& $Nssm status vyxtrader-engine; & $Nssm status vyxtrader-gateway
# nssm prints UTF-16: in PowerShell its output carries NUL characters (and can be several lines), which made
# Test-Path / Get-Content fail with "Illegal characters in path" (owner, 2026-09-28). Join, strip NULs, trim.
function Get-NssmValue([string]$Svc, [string]$Key) { ((& $Nssm get $Svc $Key) -join "" -replace "`0", "").Trim() }
$log = Get-NssmValue vyxtrader-engine AppStdout; $err = Get-NssmValue vyxtrader-engine AppStderr
foreach ($f in @($log, $err) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) } | Select-Object -Unique) {
  Get-Content $f -Tail 300 | Select-String -Pattern 'secret rotation|risk hook enabled|shadow reconciler running|SHADOW REFUSED|book events' | Select-Object -Last 8 | ForEach-Object { "  " + $_.Line }
}
if ($Phase -eq "Overlap") { "Engine log: expect 'secret rotation in progress' (WARN)." } else { "Engine log: the newest start has NO 'secret rotation in progress'." }
if ($script:Bad -gt 0) { "$($script:Bad) CHECK(S) WRONG -- stop here and send me the lines above (codes only, never values)." } else { "ALL CHECKS OK. $next" }
"Backups: $Bk"

# ---- ROLLBACK (Overlap only, if the engine or gateway will not come up) ----
# $N = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"; $B = "<Backups dir printed above>"
# & $N stop vyxtrader-engine
# Copy-Item "$B\trading-core-server.pre.exe" C:\vyxtrader\repo\engine\target\release\trading-core-server.exe -Force
# Copy-Item "$B\start-engine.cmd.pre" C:\vyxtrader\scripts\start-engine.cmd -Force
# Copy-Item "$B\start-gateway.cmd.pre" C:\vyxtrader\scripts\start-gateway.cmd -Force
# & $N start vyxtrader-engine; & $N restart vyxtrader-gateway
# (the old gateway dist\ is gone after the build; the old .cmd files work with the new gateway code unchanged)
