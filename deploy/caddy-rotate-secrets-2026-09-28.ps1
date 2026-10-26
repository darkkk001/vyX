# Caddy half of the INTERNAL_SERVICE_SECRET / MARKET_DATA_READ_SECRET rotation, for the {$VAR} Caddyfile (rewritten
# 2026-10-27: the VPS Caddyfile holds no secret any more, only {$NAME} placeholders; the values live in the
# vyxtrader-caddy service's AppEnvironmentExtra). Takes the values from start-engine.cmd (current = NEW, *_PREVIOUS =
# OLD), as before, and never prints one (key names only; any Caddy output is masked).
#
#   -Phase Overlap : AppEnvironmentExtra  INTERNAL = NEW, READ = NEW, READ_PREVIOUS = OLD
#                    (the web's current OLD read secret and its next NEW one both pass; header_up sends NEW internal)
#   -Phase Finish  : (after Vercel is on NEW)  READ_PREVIOUS = NEW too: OLD is refused everywhere
#   -Phase Reload  : any other Caddyfile change: validate + reload with the service's OWN environment, then the checks
#   -Phase Verify  : read-only: the checks and the restart parity (run at once after any Caddy restart or VPS reboot)
#
# Why the environment matters: {$NAME} is replaced when the Caddyfile is ADAPTED. A running service adapted it with its
# AppEnvironmentExtra when it started; `caddy validate` / `caddy reload` adapt it again IN THE SHELL THAT RUNS THEM. So
# every validate / reload here runs with exactly the service's environment set in this process, and a plain
# `caddy reload` from a shell without it would load EMPTY placeholders. The restart-parity check proves a restart or a
# reboot would load the same config as the one running now.
#
# Order per phase: write AppEnvironmentExtra -> validate -> reload (never `nssm restart vyxtrader-caddy`) -> checks through
# https://feed.vyxtrader.com -> parity. A failed validate or reload, or any wrong check, puts the previous
# AppEnvironmentExtra back and reloads it by itself.
param(
  [Parameter(Mandatory)][ValidateSet("Overlap", "Finish", "Reload", "Verify")][string]$Phase,
  # the placeholder names the Caddyfile uses (the VPS applied the engine's own names)
  [string]$InternalVar = "INTERNAL_SERVICE_SECRET",
  [string]$ReadVar = "MARKET_DATA_READ_SECRET",
  [string]$ReadPreviousVar = "MARKET_DATA_READ_SECRET_PREVIOUS"
)
$ErrorActionPreference = "Stop"
$Nssm    = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Engine  = "C:\vyxtrader\scripts\start-engine.cmd"
$Feed    = "https://feed.vyxtrader.com"
$Service = "vyxtrader-caddy"
$RegKey  = "HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"   # where nssm keeps AppEnvironmentExtra
$Admin   = "http://127.0.0.1:2019/config/"
$Marker  = "C:\vyxtrader\backup"

function Invoke-Native([scriptblock]$Command) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
}
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Code([string]$Url, [hashtable]$Headers) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 8).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}
function NssmGet([string]$Key) { ((& $Nssm get $Service $Key) -join "" -replace "`0", "").Trim() }

# ---- AppEnvironmentExtra: an ordered NAME -> value map, read and written through the registry (no value on a command line)
function Get-ServiceEnv {
  $raw = (Get-ItemProperty -Path $RegKey -Name AppEnvironmentExtra -ErrorAction SilentlyContinue).AppEnvironmentExtra
  $m = [ordered]@{}
  foreach ($l in @($raw)) {
    if (-not $l) { continue }
    $i = $l.IndexOf("=")
    if ($i -lt 1) { throw "AppEnvironmentExtra has a line without NAME= -- nothing touched" }
    $m[$l.Substring(0, $i)] = $l.Substring($i + 1)
  }
  return $m
}
function Set-ServiceEnv($m) {
  $lines = [string[]]@($m.Keys | ForEach-Object { "$_=$($m[$_])" })
  Set-ItemProperty -Path $RegKey -Name AppEnvironmentExtra -Value $lines -Type MultiString
}
# this process's environment = exactly $m for the names in $m and in $clear (so a reload adapts what the service would)
$script:touched = New-Object System.Collections.Generic.HashSet[string]
function Use-Env($m, [string[]]$clear) {
  foreach ($n in $clear) { if ($n) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue } }
  foreach ($n in $m.Keys) { Set-Item "Env:$n" $m[$n]; [void]$script:touched.Add($n) }
}
function Clear-Env { foreach ($n in $script:touched) { Remove-Item "Env:$n" -ErrorAction SilentlyContinue } }

# ---- the values (start-engine.cmd) and the mask
$newInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET"
$newRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET"
$oldInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET_PREVIOUS"
$oldRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET_PREVIOUS"
if (-not ($newInternal -and $newRead)) { throw "start-engine.cmd has no INTERNAL_SERVICE_SECRET / MARKET_DATA_READ_SECRET -- nothing touched" }
if (($Phase -eq "Overlap" -or $Phase -eq "Finish") -and -not ($oldInternal -and $oldRead)) {
  throw "start-engine.cmd must hold both *_PREVIOUS lines (run rotate-internal-read-secrets -Phase Overlap first; for Finish run THIS script before the engine's Finish) -- nothing touched"
}
function Mask([string]$s) {
  foreach ($p in @(@($oldInternal, "<OLD-INTERNAL>"), @($newInternal, "<NEW-INTERNAL>"), @($oldRead, "<OLD-READ>"), @($newRead, "<NEW-READ>"))) { if ($p[0]) { $s = $s.Replace($p[0], $p[1]) } }
  return $s
}

# ---- where Caddy and its config are; which placeholders the Caddyfile uses
$CE = NssmGet "Application"
$params = NssmGet "AppParameters"
$dir = NssmGet "AppDirectory"
if ($params -notmatch '(?:--config|-c)\s+(?:"([^"]+)"|(\S+))') { throw "no --config in the $Service AppParameters -- nothing touched" }
$CF = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
if (-not [IO.Path]::IsPathRooted($CF)) { $CF = Join-Path $dir $CF }
if ($CF -match '\.json$') { throw "$CF is JSON; this script handles a Caddyfile only -- nothing touched" }
"caddy: $CE"; "config: $CF"
$text = Get-Content $CF -Raw
foreach ($v in $oldInternal, $newInternal, $oldRead, $newRead) {
  if ($v -and $text.Contains($v)) { throw "the Caddyfile still holds a secret BY VALUE; this script is for the {`$VAR} Caddyfile -- nothing touched" }
}
if ($text -match '(?m)^\s*import\s') { "  note: the Caddyfile imports other files; only its own placeholders are listed below" }
$used = @([regex]::Matches($text, '\{\$([A-Za-z_][A-Za-z0-9_]*)(?::[^}]*)?\}') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique)
"placeholders in the Caddyfile: $($used -join ', ')"
$ours = @($InternalVar, $ReadVar, $ReadPreviousVar)
foreach ($n in $InternalVar, $ReadVar) { if ($used -notcontains $n) { throw "the Caddyfile has no {`$$n} (pass -InternalVar / -ReadVar with the names it uses) -- nothing touched" } }
if ($Phase -eq "Overlap" -and $used -notcontains $ReadPreviousVar) {
  throw "the Caddyfile has no {`$$ReadPreviousVar}: during the overlap the web's current (OLD) read secret would be refused. Add a second X-Market-Data-Secret value {`$$ReadPreviousVar} to the matcher (Reload phase) first -- nothing touched"
}

$before = Get-ServiceEnv
"AppEnvironmentExtra names now: $(@($before.Keys) -join ', ')"
foreach ($n in $used) { if (-not $before.Contains($n)) { "  <<< {`$$n} is used by the Caddyfile but not set in AppEnvironmentExtra: a restart would load it EMPTY" } }

# ---- the target environment
$after = [ordered]@{}; foreach ($k in $before.Keys) { $after[$k] = $before[$k] }
switch ($Phase) {
  "Overlap" { $after[$InternalVar] = $newInternal; $after[$ReadVar] = $newRead; $after[$ReadPreviousVar] = $oldRead }
  "Finish"  { $after[$InternalVar] = $newInternal; $after[$ReadVar] = $newRead; if ($used -contains $ReadPreviousVar -or $after.Contains($ReadPreviousVar)) { $after[$ReadPreviousVar] = $newRead } }
  default   { }
}
if ($Phase -eq "Finish") {
  foreach ($k in $after.Keys) { if ($after[$k] -eq $oldInternal -or $after[$k] -eq $oldRead) { throw "an OLD value would remain in AppEnvironmentExtra ($k) -- nothing touched" } }
}

function Invoke-Checks([string]$phase) {
  $want = [ordered]@{ "health" = @("/health", "", "", 200); "price  NEW read" = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $newRead, 200) }
  if ($phase -eq "Overlap") { $want["price  OLD read (web today)"] = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $oldRead, 200) }
  if ($phase -eq "Finish")  { $want["price  OLD read (retired)"]   = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $oldRead, 401) }
  $want["price  wrong read"] = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", "not-the-secret", 401)
  $want["price  no read header"] = @("/internal/prices/XAUUSD", "", "", 401)
  $bad = 0
  foreach ($k in $want.Keys) {
    $p = $want[$k]; $h = @{}; if ($p[1]) { $h[$p[1]] = $p[2] }
    $got = Get-Code ($Feed + $p[0]) $h
    if ($got -ne $p[3]) { $bad++ }
    Write-Host ("  {0,-30} HTTP {1,3}  want {2}  {3}" -f $k, $got, $p[3], $(if ($got -eq $p[3]) { "OK" } else { "<<< WRONG" }))
  }
  return $bad
}

# A parsed JSON value with the keys of every object in ordinal order, recursively; arrays keep their order (in a Caddy
# config the order of routes and handlers means something). Returned unrolled-safe (`,` keeps an array an array).
function ConvertTo-SortedJson($o) {
  if ($null -eq $o) { return $null }
  if ($o -is [System.Management.Automation.PSCustomObject]) {
    $names = [string[]]@($o.PSObject.Properties | ForEach-Object { $_.Name })
    [Array]::Sort($names, [StringComparer]::Ordinal)
    $m = [ordered]@{}
    foreach ($n in $names) { $m[$n] = ConvertTo-SortedJson $o.$n }
    return $m
  }
  if ($o -is [System.Collections.IList]) {
    $a = New-Object System.Collections.ArrayList
    foreach ($x in $o) { [void]$a.Add((ConvertTo-SortedJson $x)) }
    return , $a.ToArray()
  }
  return $o
}

# A restart or a reboot adapts the Caddyfile with AppEnvironmentExtra as stored: adapt it that way here and compare with
# the config the running Caddy holds (admin endpoint, localhost). Hashes only.
function Test-RestartParity {
  $stored = Get-ServiceEnv
  Use-Env $stored ($used + $ours)
  $adapted = Invoke-Native { & $CE adapt --config $CF --adapter caddyfile }
  $rc = $LASTEXITCODE
  if ($rc -ne 0) { Write-Host "  restart parity: adapt failed: $(Mask (($adapted | Select-Object -Last 2) -join ' '))"; return $false }
  $json = ($adapted | Where-Object { $_.TrimStart().StartsWith("{") }) -join ""
  try { $running = Invoke-RestMethod -Uri $Admin -TimeoutSec 5 } catch { Write-Host "  restart parity: admin endpoint unreachable"; return $false }
  # both sides as objects with every object's keys sorted (ordinal, at every depth; array order kept), serialized the
  # same way: the running config comes back from the admin endpoint in Caddy's own key order, which differs from the
  # adapter's (2026-10-27, VPS: a false "DIFFERENT" until the keys were sorted)
  $norm = { param($o) ConvertTo-Json -InputObject (ConvertTo-SortedJson $o) -Depth 100 -Compress }
  $sha = { param($s) [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($s))).Replace("-", "").Substring(0, 12) }
  $a = & $sha (& $norm ($json | ConvertFrom-Json)); $r = & $sha (& $norm $running)
  Write-Host "  restart parity: stored environment -> $a, running Caddy -> $r  $(if ($a -eq $r) { 'OK (a restart / reboot loads the same config)' } else { '<<< DIFFERENT: a restart or reboot would load another config' })"
  return ($a -eq $r)
}

# the actions run in a block: a failure sets the exit code and returns, and the finally below always clears this
# process's copies of the values
$script:code = 0
try { & {
  if ($Phase -eq "Verify") {
    "Verify (read-only):"
    $bad = Invoke-Checks "Verify"
    $parity = Test-RestartParity
    if ($bad -gt 0 -or -not $parity) { "VERIFY FAILED: $bad wrong check(s)$(if (-not $parity) { ', restart parity differs' }). Do not leave it like this: see caddy-service-recovery-runbook.md"; $script:code = 1; return }
    "VERIFY OK"; return
  }

  $changed = @($ours | Where-Object { $after.Contains($_) -and (-not $before.Contains($_) -or $before[$_] -ne $after[$_]) })
  "AppEnvironmentExtra names this phase sets: $(if ($changed) { $changed -join ', ' } else { '(none: values already in place)' })"
  if ($changed) { Set-ServiceEnv $after }

  Use-Env $after ($used + $ours)
  $v = Invoke-Native { & $CE validate --config $CF --adapter caddyfile }
  $ok = $LASTEXITCODE -eq 0
  $v | Where-Object { $_ -match 'Valid configuration|Error|error' } | Select-Object -Last 3 | ForEach-Object { "  " + (Mask $_) }
  if (-not $ok) { if ($changed) { Set-ServiceEnv $before }; throw "caddy validate refused the config with the new environment -- AppEnvironmentExtra put back, nothing reloaded" }

  Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 2 | ForEach-Object { "  " + (Mask $_) }
  if ($LASTEXITCODE -ne 0) { if ($changed) { Set-ServiceEnv $before }; throw "caddy reload failed -- AppEnvironmentExtra put back (the running Caddy never took the new config)" }
  Start-Sleep 2

  "checks through $Feed :"
  $bad = Invoke-Checks $Phase
  if ($bad -gt 0) {
    if ($changed) { Set-ServiceEnv $before }
    Use-Env $before ($used + $ours)
    Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 1 | ForEach-Object { "  " + (Mask $_) }
    "ROLLED BACK: $bad check(s) wrong; the previous AppEnvironmentExtra is stored and running again. Send me the lines above (codes only)."
    $script:code = 1; return
  }
  $parity = Test-RestartParity
  if (-not $parity) { "<<< the running config and the stored environment differ: run -Phase Verify, then the recovery runbook. Do not restart Caddy until this is OK."; $script:code = 1; return }
  if ($Phase -in "Overlap", "Finish") {
    # the engine script's Finish checks that the Caddy Finish ran AFTER this rotation's Overlap (no value inside)
    New-Item -ItemType Directory -Force $Marker | Out-Null
    Set-Content -Path (Join-Path $Marker "caddy-env-rotation-$Phase-$(Get-Date -Format yyyyMMdd-HHmmss).done") -Value "caddy $Phase done $(Get-Date -Format o)" -Encoding ascii
  }
  "ALL CHECKS OK."
  switch ($Phase) {
    "Overlap" { "Next: Vercel (MARKET_DATA_READ_SECRET + INTERNAL_SERVICE_SECRET = NEW, redeploy production)." }
    "Finish"  { "Next: rotate-internal-read-secrets-2026-09-28.ps1 -Phase Finish." }
    default   { }
  }
} } finally {
  Clear-Env
  Remove-Variable newInternal, newRead, oldInternal, oldRead, before, after -ErrorAction SilentlyContinue
}
exit $script:code
