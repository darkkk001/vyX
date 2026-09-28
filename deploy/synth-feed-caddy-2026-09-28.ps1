# Synthetic symbols, STEP 2 of 4 (2026-09-28, owner go): the public route for the bot's synthetic ticks. Run on the VPS
# in an elevated PowerShell AFTER synth-feed-engine-2026-09-28.ps1 reported "STEP 1 OK".
#
# Adds, as the FIRST lines of the feed.vyxtrader.com site block:
#     @synthfeed {
#         path /internal/synth-feed
#         header X-Synth-Feed-Secret *
#     }
#     handle @synthfeed {
#         reverse_proxy 127.0.0.1:8081
#     }
# Only POSTs to that one path carrying the header reach the engine, which checks the secret itself (constant-time) and
# refuses any non-v* symbol. Nothing else in the Caddyfile changes; the existing /internal/* 401 keeps applying to
# every other path (a `handle` block runs before `respond`/`abort` in Caddy's directive order).
# Always `caddy validate` then `caddy reload` (zero downtime; NEVER `nssm restart vyxtrader-caddy`). After the reload it
# checks through https://feed.vyxtrader.com and, if any check is wrong, puts the backup back and reloads by itself.
# Secrets are read from start-engine.cmd and never printed.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Engine = "C:\vyxtrader\scripts\start-engine.cmd"
$Feed   = "https://feed.vyxtrader.com"

function Invoke-Native([scriptblock]$Command) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { & $Command 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
}
function Get-CmdVar([string]$Name) {
  $line = Get-Content $Engine | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Resp([string]$Method, [string]$Url, [hashtable]$Headers, [string]$Body) {
  try {
    $p = @{ UseBasicParsing = $true; Uri = $Url; Method = $Method; Headers = $Headers; TimeoutSec = 8 }
    if ($Body) { $p.Body = $Body; $p.ContentType = "application/json" }
    $r = Invoke-WebRequest @p; return @{ Code = [int]$r.StatusCode; Body = "$($r.Content)" }
  } catch {
    if ($_.Exception.Response) {
      $b = ""; try { $b = (New-Object IO.StreamReader($_.Exception.Response.GetResponseStream())).ReadToEnd() } catch {}
      return @{ Code = [int]$_.Exception.Response.StatusCode; Body = $b }
    }
    return @{ Code = 0; Body = "$($_.Exception.Message)" }
  }
}
function NssmGet([string]$Key) { ((& $Nssm get vyxtrader-caddy $Key) -join "" -replace "`0", "").Trim() }

$synth = Get-CmdVar "SYNTH_FEED_SECRET"
$read  = Get-CmdVar "MARKET_DATA_READ_SECRET"
if (-not $synth) { throw "SYNTH_FEED_SECRET is not in start-engine.cmd -- run step 1 first; nothing touched" }
if (-not $read)  { throw "MARKET_DATA_READ_SECRET is not in start-engine.cmd -- cannot check the existing price path; nothing touched" }

# ---- where Caddy and its config are ----
$CE = NssmGet "Application"; $params = NssmGet "AppParameters"; $dir = NssmGet "AppDirectory"
if ($params -notmatch '(?:--config|-c)\s+(?:"([^"]+)"|(\S+))') { throw "no --config in the vyxtrader-caddy AppParameters -- nothing touched" }
$CF = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
if (-not [IO.Path]::IsPathRooted($CF)) { $CF = Join-Path $dir $CF }
if ($CF -match '\.json$') { throw "$CF is JSON; this script edits a Caddyfile only -- nothing touched" }
"caddy: $CE"; "config: $CF"

$lines = @(Get-Content $CF)
if ($lines -match 'internal/synth-feed') { "the synth-feed route is already in the Caddyfile -- no edit; running the checks only"; $edited = $false }
else {
  $site = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '^\s*[^#\s][^#]*feed\.vyxtrader\.com[^{#]*\{\s*$' })
  if ($site.Count -ne 1) { throw "expected exactly one 'feed.vyxtrader.com ... {' site line, found $($site.Count) -- nothing touched" }
  $i = $site[0]
  $indent = ($lines[$i] -replace '^(\s*).*$', '$1') + "`t"
  $block = @(
    "$indent# synthetic symbols (2026-09-28): the shadow bot's v* ticks; the engine checks the secret and the v prefix",
    "$indent@synthfeed {",
    "$indent`tpath /internal/synth-feed",
    "$indent`theader X-Synth-Feed-Secret *",
    "$indent}",
    "$indent" + "handle @synthfeed {",
    "$indent`treverse_proxy 127.0.0.1:8081",
    "$indent}"
  )
  $out = New-Object System.Collections.Generic.List[string]
  for ($k = 0; $k -lt $lines.Count; $k++) { $out.Add($lines[$k]); if ($k -eq $i) { foreach ($b in $block) { $out.Add($b) } } }
  "site block opens at line $($i + 1): $($lines[$i].Trim())"
  "inserted right after it:"; $block | ForEach-Object { "  $_" }

  $cand = "$CF.synth"
  Set-Content -Path $cand -Value $out -Encoding ascii
  $v = Invoke-Native { & $CE validate --config $cand --adapter caddyfile }
  $ok = $LASTEXITCODE -eq 0
  $v | Where-Object { $_ -match 'Valid configuration|Error|error' } | Select-Object -Last 3 | ForEach-Object { "  $_" }
  if (-not $ok) { Remove-Item $cand -Force; throw "caddy validate refused the edited config -- live Caddyfile untouched, nothing reloaded" }
  $bk = "C:\vyxtrader\backup\Caddyfile.pre-synth-feed-$(Get-Date -Format yyyyMMdd-HHmmss)"
  New-Item -ItemType Directory -Force C:\vyxtrader\backup | Out-Null
  Copy-Item $CF $bk
  Move-Item $cand $CF -Force
  Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 2 | ForEach-Object { "  $_" }
  if ($LASTEXITCODE -ne 0) { Copy-Item $bk $CF -Force; throw "caddy reload failed -- backup put back (the running Caddy never took the new config). Backup: $bk" }
  $edited = $true
  Start-Sleep 2
}

# ---- checks through the public name (nothing is ingested: every synth POST below is refused) ----
$u = "$Feed/internal/synth-feed"
$checks = [ordered]@{
  "health"                                 = @((Get-Resp GET "$Feed/health" @{} $null), 200, "")
  "existing price read (web's path)"       = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{ "X-Market-Data-Secret" = $read } $null), 200, "")
  "existing price read, no secret"         = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{} $null), 401, "")
  "synth, no header (Caddy refuses)"       = @((Get-Resp POST $u @{} '{"symbol":"vGOLD","bid":1.0,"ask":1.0}'), @(401, 404), "")
  "synth, wrong secret (engine's 401)"     = @((Get-Resp POST $u @{ "X-Synth-Feed-Secret" = "wrong" } '{"symbol":"vGOLD","bid":1.0,"ask":1.0}'), 401, "unauthorized")
  "synth, real symbol XAUUSD (engine 403)" = @((Get-Resp POST $u @{ "X-Synth-Feed-Secret" = $synth } '{"symbol":"XAUUSD","bid":1.0,"ask":1.0}'), 403, "only symbols starting with")
  "other /internal path, synth header"     = @((Get-Resp POST "$Feed/internal/price-feed" @{ "X-Synth-Feed-Secret" = $synth } '{"symbol":"XAUUSD","bid":1.0,"ask":1.0}'), @(401, 404), "")
  "price read with only the synth header"  = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{ "X-Synth-Feed-Secret" = $synth } $null), 401, "")
}
$bad = 0
foreach ($k in $checks.Keys) {
  $r = $checks[$k][0]; $want = $checks[$k][1]; $needle = $checks[$k][2]
  # $want is one code or a list of acceptable codes (Caddy's own refusal is 401 or its catch-all 404, both refuse)
  $ok = (@($want) -contains $r.Code) -and (-not $needle -or $r.Body -match [regex]::Escape($needle))
  if (-not $ok) { $bad++ }
  "{0,-42} {1} (want {2}) {3}" -f $k, $r.Code, (@($want) -join " or "), $(if ($ok) { "OK" } else { "WRONG" })
}
if ($bad -gt 0) {
  if ($edited) {
    Copy-Item $bk $CF -Force
    Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 1 | ForEach-Object { "  $_" }
    throw "$bad check(s) wrong -- the previous Caddyfile was put back and reloaded. Backup: $bk"
  }
  throw "$bad check(s) wrong (the route was already present; nothing changed)"
}
"STEP 2 OK" + $(if ($edited) { ". Backup: $bk" } else { "" })
