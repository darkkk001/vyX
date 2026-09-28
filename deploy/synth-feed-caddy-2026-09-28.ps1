# Synthetic symbols, STEP 2 of 4 (2026-09-28, owner go): the public route for the bot's synthetic ticks. Run on the VPS
# in an elevated PowerShell AFTER synth-feed-engine-2026-09-28.ps1 reported "STEP 1 OK".
#
# The production Caddyfile keeps every path inside ONE `route { }` in the feed.vyxtrader.com site block (so paths run
# in written order), ending with the catch-all `handle { reverse_proxy 127.0.0.1:8080 }` (the gateway). The synth route
# goes INSIDE that route block, directly BEFORE the catch-all -- after it, the catch-all would send synth ticks to the
# gateway:
#     @synthfeed {
#         path /internal/synth-feed
#         header X-Synth-Feed-Secret *
#     }
#     handle @synthfeed {
#         reverse_proxy 127.0.0.1:8081
#     }
# Nothing else in the file changes: feed-stats, alert-stats and @marketdata (the web's /internal/candles and
# /internal/prices reads) stay byte-for-byte as they are. The engine checks the secret itself (constant-time) and
# refuses any non-v* symbol.
#
#   (no switch)  prints the exact diff (where, and the inserted lines) and STOPS: nothing validated, nothing written.
#   -Apply       the same insertion, then `caddy validate` on a candidate file, then `caddy reload` (zero downtime;
#                NEVER `nssm restart vyxtrader-caddy`), then checks through https://feed.vyxtrader.com; any wrong check
#                puts the backup back and reloads by itself.
# Secrets are read from start-engine.cmd and never printed.
param([switch]$Apply)
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

# Brace depth of a Caddyfile line: quoted strings, comments and {placeholders} (no spaces inside) are not blocks.
function Get-BraceDelta([string]$line) {
  $s = $line -replace '"(?:[^"\\]|\\.)*"', '""' -replace '`[^`]*`', '' -replace '\s#.*$', '' -replace '^\s*#.*$', ''
  $s = $s -replace '\{[A-Za-z_][^{}\s]*\}', ''
  ([regex]::Matches($s, '\{')).Count - ([regex]::Matches($s, '\}')).Count
}

# Where the synth route goes: inside the feed.vyxtrader.com site block's route { }, directly before its catch-all
# `handle {` (a handle with NO matcher). Returns @{ Index = <line index to insert BEFORE>; Block = <lines> } or throws.
function Get-SynthInsertion([string[]]$lines) {
  $site = @(0..($lines.Count - 1) | Where-Object { $lines[$_] -match '^\s*[^#\s][^#]*feed\.vyxtrader\.com[^{#]*\{\s*$' })
  if ($site.Count -ne 1) { throw "expected exactly one 'feed.vyxtrader.com ... {' site line, found $($site.Count) -- nothing touched" }
  # the site block's extent
  $depth = 0; $siteEnd = -1
  for ($k = $site[0]; $k -lt $lines.Count; $k++) { $depth += Get-BraceDelta $lines[$k]; if ($depth -eq 0) { $siteEnd = $k; break } }
  if ($siteEnd -lt 0) { throw "the feed.vyxtrader.com block never closes (brace count) -- nothing touched" }
  # its route blocks, as direct children of the site block
  $routes = @(); $depth = 0
  for ($k = $site[0]; $k -le $siteEnd; $k++) {
    if ($depth -eq 1 -and $lines[$k] -match '^\s*route\s*\{\s*$') { $routes += $k }
    $depth += Get-BraceDelta $lines[$k]
  }
  if ($routes.Count -ne 1) { throw "expected exactly one 'route {' directly inside feed.vyxtrader.com, found $($routes.Count) -- nothing touched" }
  $r = $routes[0]
  # direct children of the route block; the catch-all is a handle WITHOUT a matcher
  $depth = 0; $catchAll = @(); $handles = @(); $routeEnd = -1
  for ($k = $r; $k -le $siteEnd; $k++) {
    if ($k -gt $r -and $depth -eq 1) {
      if ($lines[$k] -match '^\s*handle\s*\{') { $catchAll += $k }
      if ($lines[$k] -match '^\s*handle\b') { $handles += $k }
    }
    $depth += Get-BraceDelta $lines[$k]
    if ($k -gt $r -and $depth -eq 0) { $routeEnd = $k; break }
  }
  if ($routeEnd -lt 0) { throw "the route block never closes (brace count) -- nothing touched" }
  if ($catchAll.Count -ne 1) { throw "expected exactly one catch-all 'handle {' in the route block, found $($catchAll.Count) -- nothing touched" }
  if ($handles[-1] -ne $catchAll[0]) { throw "the catch-all 'handle {' is not the last handle in the route block -- nothing touched" }
  $at = $catchAll[0]
  $in = $lines[$at] -replace '^(\s*).*$', '$1'
  $step = if ($in -match "`t") { "`t" } else { "  " }
  $block = @(
    "$in# synthetic symbols (2026-09-28): the shadow bot's v* ticks to the engine; it checks the secret and the v prefix",
    "$in@synthfeed {",
    "$in${step}path /internal/synth-feed",
    "$in${step}header X-Synth-Feed-Secret *",
    "$in}",
    "${in}handle @synthfeed {",
    "$in${step}reverse_proxy 127.0.0.1:8081",
    "$in}"
  )
  return @{ Index = $at; Block = $block; Site = $site[0]; Route = $r; RouteEnd = $routeEnd }
}

# ---- where Caddy and its config are ----
$CE = NssmGet "Application"; $params = NssmGet "AppParameters"; $dir = NssmGet "AppDirectory"
if ($params -notmatch '(?:--config|-c)\s+(?:"([^"]+)"|(\S+))') { throw "no --config in the vyxtrader-caddy AppParameters -- nothing touched" }
$CF = if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
if (-not [IO.Path]::IsPathRooted($CF)) { $CF = Join-Path $dir $CF }
if ($CF -match '\.json$') { throw "$CF is JSON; this script edits a Caddyfile only -- nothing touched" }
"caddy: $CE"; "config: $CF"

$lines = @(Get-Content $CF)
$already = @($lines | Where-Object { $_ -match 'internal/synth-feed' }).Count -gt 0
if ($already) { "the synth-feed route is already in the Caddyfile -- no edit" }
else {
  $ins = Get-SynthInsertion $lines
  $out = New-Object System.Collections.Generic.List[string]
  for ($k = 0; $k -lt $lines.Count; $k++) { if ($k -eq $ins.Index) { foreach ($b in $ins.Block) { $out.Add($b) } }; $out.Add($lines[$k]) }
  # the diff: every existing line unchanged, only the block added (checked, not assumed)
  # remove exactly the inserted range again: what is left must be the original file, line for line
  $kept = @($out[0..($ins.Index - 1)]) + @($out[($ins.Index + $ins.Block.Count)..($out.Count - 1)])
  if (($kept -join "`n") -ne ($lines -join "`n")) { throw "internal check: the edit would change an existing line -- nothing touched" }
  ""
  "DIFF ($CF): $($ins.Block.Count) lines inserted, 0 changed, 0 removed."
  "Inserted inside 'route {' (line $($ins.Route + 1)), directly BEFORE the catch-all at line $($ins.Index + 1):"
  $from = [Math]::Max($ins.Route, $ins.Index - 4)
  for ($k = $from; $k -lt $ins.Index; $k++) { "  {0,4}   {1}" -f ($k + 1), $lines[$k] }
  foreach ($b in $ins.Block) { "  {0,4} + {1}" -f "", $b }
  for ($k = $ins.Index; $k -le [Math]::Min($ins.RouteEnd, $ins.Index + 2); $k++) { "  {0,4}   {1}" -f ($k + 1), $lines[$k] }
  ""
  if (-not $Apply) { "DRY RUN: nothing validated, nothing written. Rerun with -Apply to validate + reload + check."; return }

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
  Start-Sleep 2
}
if (-not $Apply) { "DRY RUN: nothing validated, nothing written."; return }

# ---- checks through the public name (nothing is ingested: every synth POST below is refused) ----
$synth = Get-CmdVar "SYNTH_FEED_SECRET"
$read  = Get-CmdVar "MARKET_DATA_READ_SECRET"
if (-not $synth -or -not $read) { throw "SYNTH_FEED_SECRET / MARKET_DATA_READ_SECRET missing in start-engine.cmd" }
$u = "$Feed/internal/synth-feed"
$refused = 400..499   # a request that must not reach the engine: Caddy / the gateway refuse it (4xx)
$checks = [ordered]@{
  "health"                                 = @((Get-Resp GET "$Feed/health" @{} $null), @(200), "")
  "existing price read (web's path)"       = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{ "X-Market-Data-Secret" = $read } $null), @(200), "")
  "existing price read, no secret"         = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{} $null), @(401), "")
  "price read with only the synth header"  = @((Get-Resp GET "$Feed/internal/prices/XAUUSD" @{ "X-Synth-Feed-Secret" = $synth } $null), @(401), "")
  "synth, wrong secret (engine's 401)"     = @((Get-Resp POST $u @{ "X-Synth-Feed-Secret" = "wrong" } '{"symbol":"vGOLD","bid":1.0,"ask":1.0}'), @(401), "unauthorized")
  "synth, real symbol XAUUSD (engine 403)" = @((Get-Resp POST $u @{ "X-Synth-Feed-Secret" = $synth } '{"symbol":"XAUUSD","bid":1.0,"ask":1.0}'), @(403), "only symbols starting with")
  "synth, no header (never the engine)"    = @((Get-Resp POST $u @{} '{"symbol":"vGOLD","bid":1.0,"ask":1.0}'), $refused, "")
}
$bad = 0
foreach ($k in $checks.Keys) {
  $r = $checks[$k][0]; $want = $checks[$k][1]; $needle = $checks[$k][2]
  $ok = (@($want) -contains $r.Code) -and (-not $needle -or $r.Body -match [regex]::Escape($needle))
  if (-not $ok) { $bad++ }
  $wantText = if (@($want).Count -gt 3) { "4xx" } else { @($want) -join " or " }
  "{0,-42} {1} (want {2}) {3}" -f $k, $r.Code, $wantText, $(if ($ok) { "OK" } else { "WRONG" })
}
if ($bad -gt 0) {
  if (-not $already) {
    Copy-Item $bk $CF -Force
    Invoke-Native { & $CE reload --config $CF --adapter caddyfile } | Select-Object -Last 1 | ForEach-Object { "  $_" }
    throw "$bad check(s) wrong -- the previous Caddyfile was put back and reloaded. Backup: $bk"
  }
  throw "$bad check(s) wrong (the route was already present; nothing changed)"
}
"STEP 2 OK" + $(if (-not $already) { ". Backup: $bk" } else { "" })
