# Caddy half of the INTERNAL_SERVICE_SECRET / MARKET_DATA_READ_SECRET rotation (2026-09-28). Runs AFTER
# rotate-internal-read-secrets-2026-09-28.ps1 of the same phase; takes the values from start-engine.cmd (current = NEW,
# *_PREVIOUS = OLD), edits the Caddyfile BY VALUE, and never prints one (lines are shown with the values masked).
#
#   -Phase Overlap : `header_up ... <OLD internal>` -> NEW internal (the engine already accepts both).
#                    Every other line holding an OLD value (the X-Market-Data-Secret matcher) keeps OLD and gains a
#                    copy with NEW, so the web's current (OLD) and next (NEW) read secret both pass. A
#                    `@name not header X-Market-Data-Secret "OLD"` refusal matcher becomes `@name { not { header ... "OLD"
#                    / header ... "NEW" } }`: refused only when the header is neither value.
#   -Phase Finish  : (after Vercel is on NEW) the lines holding OLD values are removed; NEW stays.
# Always `caddy validate` then `caddy reload` (zero downtime; NEVER `nssm restart vyxtrader-caddy`: it does not stop the
# running Caddy). After the reload it checks through https://feed.vyxtrader.com and, if any check is wrong, puts the
# backup back and reloads again by itself.
param([Parameter(Mandatory)][ValidateSet("Overlap", "Finish")][string]$Phase)
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Engine = "C:\vyxtrader\scripts\start-engine.cmd"
$Feed   = "https://feed.vyxtrader.com"

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
function NssmGet([string]$Key) { ((& $Nssm get vyxtrader-caddy $Key) -join "" -replace "`0", "").Trim() }

$newInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET"
$newRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET"
$oldInternal = Get-CmdVar $Engine "INTERNAL_SERVICE_SECRET_PREVIOUS"
$oldRead     = Get-CmdVar $Engine "MARKET_DATA_READ_SECRET_PREVIOUS"
if (-not ($newInternal -and $newRead -and $oldInternal -and $oldRead)) {
  throw "start-engine.cmd must hold both secrets AND both *_PREVIOUS lines (run rotate-internal-read-secrets -Phase Overlap first; for Finish run THIS script before the engine's Finish) -- nothing touched"
}
function Mask([string]$s) { $s.Replace($oldInternal, "<OLD-INTERNAL>").Replace($newInternal, "<NEW-INTERNAL>").Replace($oldRead, "<OLD-READ>").Replace($newRead, "<NEW-READ>") }

# ---- where Caddy and its config are ----
$CE = NssmGet "Application"
$params = NssmGet "AppParameters"
$dir = NssmGet "AppDirectory"
if ($params -notmatch '(?:--config|-c)\s+(?:"([^"]+)"|(\S+))') { throw "no --config in the vyxtrader-caddy AppParameters -- nothing touched" }
$CF = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
if (-not [IO.Path]::IsPathRooted($CF)) { $CF = Join-Path $dir $CF }
if ($CF -match '\.json$') { throw "$CF is JSON; this script edits a Caddyfile only -- nothing touched" }
"caddy: $CE"; "config: $CF"

$lines = @(Get-Content $CF)
$holds = { param($l) $l.Contains($oldInternal) -or $l.Contains($oldRead) }
"lines holding a secret (masked), before:"
$lines | Where-Object { $_.Contains($oldInternal) -or $_.Contains($oldRead) -or $_.Contains($newInternal) -or $_.Contains($newRead) } | ForEach-Object { "  " + (Mask $_) }

$out = New-Object System.Collections.Generic.List[string]
foreach ($l in $lines) {
  $t = $l.Trim()
  if (-not (& $holds $l)) { $out.Add($l); continue }
  if ($t -match '^header_up\s') {
    # outbound header towards the engine: only the internal secret can sit here
    if ($l.Contains($oldRead)) { throw "a header_up line holds the READ secret -- unexpected; nothing touched. Send me the masked lines above." }
    if ($Phase -eq "Overlap") { $out.Add($l.Replace($oldInternal, $newInternal)) } else { throw "a header_up line still holds the OLD internal secret -- run -Phase Overlap first; nothing touched" }
    continue
  }
  $indent = $l.Substring(0, $l.Length - $l.TrimStart().Length)
  if ($Phase -eq "Finish") {
    # only the plain `header <field> <OLD>` lines Overlap left next to their NEW twin may go; anything else means
    # Overlap never ran on this file
    if ($t -notmatch '^header\s') { throw "an OLD value is still in a matcher Overlap did not rewrite -- run -Phase Overlap first; nothing touched" }
    continue
  }
  $swap = { param($s) $s.Replace($oldInternal, $newInternal).Replace($oldRead, $newRead) }
  if ($t -match '^(@\S+)\s+not\s+(header\s+.+)$' -or $t -match '^()not\s+(header\s+.+)$') {
    # `@name not header F "OLD"` (single line) or `not header F "OLD"` (inside a matcher block): one `not { }` holding
    # both values, i.e. NOT (F is OLD or F is NEW): same field in one matcher set = either value (tested, Caddy 2.10.2).
    # Two separate `not header` lines would instead refuse a request carrying either value.
    $name = $Matches[1]; $body = $Matches[2]; $in = $indent
    if ($name) { $out.Add("$indent$name {"); $in = "$indent`t" }
    $out.Add("${in}not {")
    $out.Add("$in`t$body")
    $out.Add("$in`t" + (& $swap $body))
    $out.Add("$in}")
    if ($name) { $out.Add("$indent}") }
    continue
  }
  if ($t -match '^not\b' -or $t -match '\bnot\b') { throw "an OLD value sits in a 'not' form this script does not rewrite (only 'not header'); nothing touched. Send me the masked lines above." }
  $newLine = & $swap $l
  if ($t -match '^(@\S+)\s+(.+)$') {
    # single-line named matcher: turn it into a block so both values live in ONE matcher set (same field = either value)
    $name = $Matches[1]; $body = $Matches[2]
    $out.Add("$indent$name {")
    $out.Add("$indent`t$body")
    $out.Add("$indent`t" + $body.Replace($oldInternal, $newInternal).Replace($oldRead, $newRead))
    $out.Add("$indent}")
  } else {
    $out.Add($l); $out.Add($newLine)
  }
}
if ((($out | Where-Object { $_.Contains($newRead) }).Count -eq 0)) { throw "no line checks the NEW read secret -- nothing touched. Send me the masked lines above." }
if ((($out | Where-Object { $_.Contains($oldInternal) -or ($Phase -eq "Finish" -and $_.Contains($oldRead)) }).Count -gt 0)) { throw "an OLD value would remain -- nothing touched. Send me the masked lines above." }
"lines holding a secret (masked), after:"
$out | Where-Object { $_.Contains($oldInternal) -or $_.Contains($oldRead) -or $_.Contains($newInternal) -or $_.Contains($newRead) } | ForEach-Object { "  " + (Mask $_) }

# ---- validate a candidate next to the live file (same directory, so imports resolve the same) ----
$cand = "$CF.rotating"
Set-Content -Path $cand -Value $out -Encoding ascii
$v = Invoke-Native { & $CE validate --config $cand --adapter caddyfile }
$ok = $LASTEXITCODE -eq 0
$v | Where-Object { $_ -match 'Valid configuration|Error|error' } | Select-Object -Last 3 | ForEach-Object { "  " + (Mask $_) }
if (-not $ok) { Remove-Item $cand -Force; throw "caddy validate refused the edited config -- live Caddyfile untouched, nothing reloaded" }

$bk = "C:\vyxtrader\backup\Caddyfile.pre-rotation-$Phase-$(Get-Date -Format yyyyMMdd-HHmmss)"
New-Item -ItemType Directory -Force C:\vyxtrader\backup | Out-Null
Copy-Item $CF $bk
Move-Item $cand $CF -Force
Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 2 | ForEach-Object { "  " + (Mask $_) }
if ($LASTEXITCODE -ne 0) {
  Copy-Item $bk $CF -Force
  throw "caddy reload failed -- backup put back (the running Caddy never took the new config). Backup: $bk"
}
Start-Sleep 2

# ---- checks through the public name (the web's own path) ----
$want = if ($Phase -eq "Overlap") {
  [ordered]@{ "health" = @("/health", "", "", 200)
    "price  OLD read (web today)" = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $oldRead, 200)
    "price  NEW read"             = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $newRead, 200)
    "price  wrong read"           = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", "not-the-secret", 401) }
} else {
  [ordered]@{ "health" = @("/health", "", "", 200)
    "price  NEW read"             = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $newRead, 200)
    "price  OLD read (retired)"   = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", $oldRead, 401)
    "price  wrong read"           = @("/internal/prices/XAUUSD", "X-Market-Data-Secret", "not-the-secret", 401) }
}
$bad = 0
foreach ($k in $want.Keys) {
  $p = $want[$k]; $h = @{}; if ($p[1]) { $h[$p[1]] = $p[2] }
  $got = Get-Code ($Feed + $p[0]) $h
  if ($got -ne $p[3]) { $bad++ }
  "  {0,-30} HTTP {1,3}  want {2}  {3}" -f $k, $got, $p[3], $(if ($got -eq $p[3]) { "OK" } else { "<<< WRONG" })
}
if ($bad -gt 0) {
  # a price read that used to pass may now fail (or a retired value still pass): go back at once
  Copy-Item $bk $CF -Force
  Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 1
  "ROLLED BACK: $bad check(s) wrong, the previous Caddyfile is live again. Send me the lines above (masked, codes only)."
} else {
  "ALL CHECKS OK. Backup: $bk"
  if ($Phase -eq "Overlap") { "Next: Vercel (MARKET_DATA_READ_SECRET + INTERNAL_SERVICE_SECRET = NEW, redeploy production)." }
  else { "Next: rotate-internal-read-secrets-2026-09-28.ps1 -Phase Finish." }
}
Remove-Variable newInternal, newRead, oldInternal, oldRead -ErrorAction SilentlyContinue
