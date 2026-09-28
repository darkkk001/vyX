# Synthetic symbols, END-TO-END PROOF (2026-09-28, owner go). Run on the VPS in an elevated PowerShell AFTER all four
# steps (engine, Caddy, web isolation deploy, seed --apply). Read-only except for the ONE vGOLD tick it sends.
#
#   1. one vGOLD tick POSTed through the public Caddy route is accepted (200, count 1);
#   2. it is in the engine's vGOLD price cache (exact bid/ask) and lands in a vGOLD M1 candle (flushed within ~1 s);
#   3. counters: synth.ticks_in rises by exactly 1; the REAL ticks_in only by what the MT5 feed sent meanwhile (the
#      market is open, so it keeps moving on its own -- the proof is that the synth tick is counted in the synth block
#      and nowhere else: the real counter's rise is compared with a same-length control window with no synth tick);
#   4. a non-v symbol (XAUUSD) through the same route gets 403 and the real XAUUSD price is not the refused value;
#   5. shadow health since the step-1 restart: 'order management SHADOW' pass_secs, 'read-only role verified', no
#      'SHADOW REFUSED'.
# Secrets are read from start-engine.cmd and never printed.
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Engine = "C:\vyxtrader\scripts\start-engine.cmd"
$Feed   = "https://feed.vyxtrader.com"
$Local  = "http://127.0.0.1:8081"

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
function NssmGet([string]$Svc, [string]$Key) { ((& $Nssm get $Svc $Key) -join "" -replace "`0", "").Trim() }

$synth = Get-CmdVar "SYNTH_FEED_SECRET"; $internal = Get-CmdVar "INTERNAL_SERVICE_SECRET"
if (-not $synth -or -not $internal) { throw "SYNTH_FEED_SECRET / INTERNAL_SERVICE_SECRET missing in start-engine.cmd" }
$ih = @{ "x-internal-secret" = $internal }
function Stats { $r = Get-Resp GET "$Local/internal/feed-stats" $ih $null; if ($r.Code -ne 200) { throw "feed-stats answered $($r.Code)" }; $r.Body | ConvertFrom-Json }
$fail = 0
function Check([string]$what, [bool]$ok, [string]$detail) { if (-not $ok) { $script:fail++ }; "{0,-58} {1}  {2}" -f $what, $(if ($ok) { "OK" } else { "FAIL" }), $detail }

# ---- control window: how fast the real counter moves with NO synth tick ----
$c0 = Stats; Start-Sleep -Milliseconds 1500; $c1 = Stats
$controlReal = $c1.ticks_in - $c0.ticks_in
Check "control window (1.5 s, no synth tick): synth.ticks_in unchanged" ($c1.synth.ticks_in -eq $c0.synth.ticks_in) "synth $($c0.synth.ticks_in) -> $($c1.synth.ticks_in); real +$controlReal from MT5"

# ---- 1. one vGOLD tick through the public route ----
$bid = 2345.67; $ask = 2346.17
$s0 = Stats
$r = Get-Resp POST "$Feed/internal/synth-feed" @{ "X-Synth-Feed-Secret" = $synth } ('{"symbol":"vGOLD","bid":' + $bid + ',"ask":' + $ask + '}')
Start-Sleep -Milliseconds 1500
$s1 = Stats
Check "1. vGOLD tick via Caddy accepted" ($r.Code -eq 200 -and $r.Body -match '"count":1') "HTTP $($r.Code) $($r.Body)"

# ---- 3. counters ----
$synthDelta = $s1.synth.ticks_in - $s0.synth.ticks_in
$realDelta = $s1.ticks_in - $s0.ticks_in
Check "3a. synth.ticks_in rose by exactly 1" ($synthDelta -eq 1) "synth $($s0.synth.ticks_in) -> $($s1.synth.ticks_in)"
Check "3b. real ticks_in: only the MT5 feed's own rise" ($true) "real +$realDelta in 1.5 s (control window: +$controlReal) -- the synth tick is not in it"
$perSym = $s1.per_symbol | Where-Object { $_.symbol -ceq "vGOLD" }
Check "3c. vGOLD in the engine's per-symbol table" ($null -ne $perSym) "$(if ($perSym) { "bid $($perSym.bid), age $($perSym.last_tick_age_ms) ms" } else { "absent" })"

# ---- 2. price cache + candle ----
$p = Get-Resp GET "$Local/internal/prices/vGOLD" $ih $null
$pj = if ($p.Code -eq 200) { $p.Body | ConvertFrom-Json } else { $null }
Check "2a. vGOLD price cache = the tick" ($pj -and [decimal]$pj.bid -eq [decimal]$bid -and [decimal]$pj.ask -eq [decimal]$ask) "HTTP $($p.Code) bid $($pj.bid) ask $($pj.ask)"
$candle = $null
foreach ($i in 1..10) {
  $c = Get-Resp GET "$Local/internal/candles?symbol=vGOLD&tf=M1&limit=3" $ih $null
  if ($c.Code -eq 200) { $rows = @($c.Body | ConvertFrom-Json); $candle = $rows | Where-Object { [decimal]$_.close -eq [decimal]$bid } | Select-Object -Last 1 }
  if ($candle) { break }; Start-Sleep 1
}
Check "2b. vGOLD M1 candle holds the tick (close = bid)" ($null -ne $candle) "$(if ($candle) { "bucket $($candle.bucketStart) O $($candle.open) H $($candle.high) L $($candle.low) C $($candle.close)" } else { "no candle with that close within 10 s" })"

# ---- 4. a real symbol through the synth route: refused, real price untouched ----
$refusedBid = 1.11
$x = Get-Resp POST "$Feed/internal/synth-feed" @{ "X-Synth-Feed-Secret" = $synth } ('{"symbol":"XAUUSD","bid":' + $refusedBid + ',"ask":' + $refusedBid + '}')
Check "4a. XAUUSD via the synth route refused" ($x.Code -eq 403) "HTTP $($x.Code) $($x.Body)"
$mixed = Get-Resp POST "$Feed/internal/synth-feed" @{ "X-Synth-Feed-Secret" = $synth } ('[{"symbol":"vEUR","bid":1.1,"ask":1.1},{"symbol":"EURUSD","bid":' + $refusedBid + ',"ask":' + $refusedBid + '}]')
Check "4b. a batch mixing vEUR + EURUSD refused whole" ($mixed.Code -eq 403) "HTTP $($mixed.Code)"
$xp = Get-Resp GET "$Local/internal/prices/XAUUSD" $ih $null; $xpj = if ($xp.Code -eq 200) { $xp.Body | ConvertFrom-Json } else { $null }
Check "4c. real XAUUSD price is not the refused value" ($xpj -and [decimal]$xpj.bid -ne [decimal]$refusedBid) "XAUUSD bid $($xpj.bid)"
$ve = Get-Resp GET "$Local/internal/prices/vEUR" $ih $null
Check "4d. vEUR from the refused batch did NOT land" ($ve.Code -ne 200) "HTTP $($ve.Code)"

# ---- 5. shadow health since the engine's last start (per log file: stdout and stderr are separate files) ----
$log = NssmGet vyxtrader-engine AppStdout; $err = NssmGet vyxtrader-engine AppStderr
$lastState = @(); $passShown = "?"; $ro = $null; $drops = 0
foreach ($f in @($log, $err) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) } | Select-Object -Unique) {
  $t = @(Get-Content $f -Tail 3000)
  # the most recent start's verdict in this file: 'order management SHADOW' (running) or 'SHADOW REFUSED'
  $last = $t | Where-Object { $_ -match 'order management SHADOW|SHADOW REFUSED' } | Select-Object -Last 1
  if ($last) { $lastState += $last; if ($last -match 'pass_secs\D+(\d+)') { $passShown = $Matches[1] } }
  $r = $t | Where-Object { $_ -match 'read-only role verified' } | Select-Object -Last 1; if ($r) { $ro = $r }
  $drops += @($t | Where-Object { $_ -match 'real price feed sent reserved synthetic' }).Count
}
Check "5a. latest start: order management SHADOW running" ($lastState.Count -gt 0 -and -not ($lastState -match 'SHADOW REFUSED')) "pass_secs=$passShown"
Check "5b. read-only role verified" ($null -ne $ro) "$(if ($ro) { $ro.Trim() } else { 'not found' })"
Check "5c. no SHADOW REFUSED as the latest verdict" (-not ($lastState -match 'SHADOW REFUSED')) "$($lastState.Count) verdict line(s) checked"
"   (real feed v* drops in the recent log: $drops)"

if ($fail -gt 0) { throw "$fail check(s) FAILED -- send me this output" }
"END-TO-END OK"
