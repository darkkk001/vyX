# QoreBridgeFeed (FIX price feed) alert monitor for the VPS (owner 2026-10-29). Runs as the nssm service
# "VyXFeedAlert" (install-feed-alert-service.ps1). Read-only on the box apart from its own status and log files: it
# NEVER restarts or touches the feed.
#
# Every poll_secs it reads the feed's own API (127.0.0.1:8096 /metrics and /health) and its events CSV:
#   CRITICAL  stall          no market data message on ANY symbol for more than stall_secs (qb_feed_quotes stops)
#   CRITICAL  session        /health feed:session not ok, or a new LP disconnect (qb_feed_disconnects) or logon reject
#   CRITICAL  mapping        a symbol held by the mapping guard (qb_feed_symbols_held) or a "mismatch" event
#   CRITICAL  feed_down      the feed API did not answer for feed_unreachable_polls polls in a row
#   WARNING   stale          stale_warn_ratio or more of the symbols stale for stale_warn_polls polls in a row
#   WARNING   drops          drop_warn_count or more dropped quotes / log lines / post errors within drop_window_secs
#   WARNING   engine         /health feed:engine not ok for more than engine_warn_secs
#   WARNING   restart        the feed process restarted (its counters went back)
# Alerts: an ntfy push at once (CRITICAL = urgent, WARNING = high, then one RESOLVED push), a CRITICAL reminder every
# remind_minutes while it lasts, and a report to $web_url/api/internal/infra-health (component qorebridge-feed, with the
# worst severity) on every change and every heartbeat_minutes; the platform e-mails OPS_ALERT_EMAIL on a change.
# quiet_windows (New York time, so they follow DST) suppress the conditions they list: the 17:00 NY rollover has
# minute-long gaps on every symbol (120 s seen on 2026-10-28), and the weekend closes everything but crypto.
# Thresholds live in the JSON config, reloaded when the file changes. -TestPush sends one test push and exits.
param(
  [string]$ConfigPath = "C:\vyxtrader\config\feed-alert.json",
  [switch]$TestPush,
  [switch]$Once
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:cfg = $null; $script:cfgStamp = $null
function Load-Config {
  $stamp = (Get-Item -LiteralPath $ConfigPath).LastWriteTimeUtc
  if ($script:cfgStamp -eq $stamp) { return }
  try {
    $c = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
    $script:cfg = $c; $script:cfgStamp = $stamp
    Write-Log "config loaded: stall $($c.stall_secs) s, stale >= $($c.stale_warn_ratio * 100)% x $($c.stale_warn_polls), drops >= $($c.drop_warn_count) / $($c.drop_window_secs) s, poll $($c.poll_secs) s"
  } catch {
    if (-not $script:cfg) { throw "config $ConfigPath unreadable: $_" }
    Write-Log "config change ignored, unreadable: $_ (keeping the previous one)"
  }
}

function Write-Log([string]$Line) {
  $dir = if ($script:cfg) { $script:cfg.status_dir } else { "C:\vyxtrader\status" }
  New-Item -ItemType Directory -Force $dir | Out-Null
  $l = "$((Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')) $Line"
  Add-Content -LiteralPath (Join-Path $dir "feed-alert-$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')).log") -Value $l
  Write-Host $l   # not Write-Output: the functions that log also return a value
}

function When([datetime]$Utc) {
  $pkt = [TimeZoneInfo]::ConvertTimeFromUtc($Utc, [TimeZoneInfo]::FindSystemTimeZoneById("Pakistan Standard Time"))
  "$($Utc.ToString('yyyy-MM-dd HH:mm:ss')) UTC ($($pkt.ToString('HH:mm:ss')) PKT)"
}

function Get-CmdVar([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $l = Get-Content -LiteralPath $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() }
}

# ---- ntfy push (the topic is the secret; it is read from its file and never logged)
function Send-Push([string]$Severity, [string]$Title, [string]$Body) {
  $topic = (Get-Content -LiteralPath $script:cfg.ntfy_topic_file -Raw).Trim()
  $prio = switch ($Severity) { "CRITICAL" { "5" } "WARNING" { "4" } default { "3" } }
  $tags = switch ($Severity) { "CRITICAL" { "rotating_light" } "WARNING" { "warning" } "RESOLVED" { "white_check_mark" } default { "information_source" } }
  try {
    Invoke-RestMethod -Method Post -Uri "$($script:cfg.ntfy_server.TrimEnd('/'))/$topic" -TimeoutSec 10 `
      -Headers @{ Title = $Title; Priority = $prio; Tags = $tags } -Body ([Text.Encoding]::UTF8.GetBytes($Body)) | Out-Null
    Write-Log "push sent [$Severity] $Title"
    return $true
  } catch {
    Write-Log "push FAILED [$Severity] $Title : $($_.Exception.Message)"
    return $false
  }
}

# ---- platform report (e-mail to OPS_ALERT_EMAIL on a change happens on the platform side)
function Send-Report([bool]$Ok, [string]$Severity, [string[]]$Reasons, $Checks) {
  $secret = Get-CmdVar $script:cfg.gateway_cmd "INTERNAL_SERVICE_SECRET"
  if (-not $secret) { Write-Log "report skipped: INTERNAL_SERVICE_SECRET not found in $($script:cfg.gateway_cmd)"; return $false }
  $c = [ordered]@{}; foreach ($k in $Checks.Keys) { $c[$k] = $Checks[$k] }
  if (-not $Ok) { $c.severity = $Severity }
  $body = [ordered]@{ component = "qorebridge-feed"; ok = $Ok; checks = $c; reasons = @($Reasons | Select-Object -First 20 | ForEach-Object { if ($_.Length -gt 300) { $_.Substring(0, 300) } else { $_ } })
    checkedAt = (Get-Date).ToUniversalTime().ToString("o"); host = $env:COMPUTERNAME } | ConvertTo-Json -Depth 5 -Compress
  try {
    $r = Invoke-RestMethod -Method Post -Uri "$($script:cfg.web_url.TrimEnd('/'))/api/internal/infra-health" -Headers @{ "x-internal-secret" = $secret } `
      -ContentType "application/json" -Body $body -TimeoutSec 15
    if ($r.alerted) { Write-Log "platform report: state $($r.state), e-mail $($r.alerted) (emailed $($r.emailed))" }
    return $true
  } catch {
    Write-Log "platform report FAILED: $($_.Exception.Message)"
    return $false
  }
}

function In-Quiet([string]$Condition, [datetime]$Utc) {
  $tz = [TimeZoneInfo]::FindSystemTimeZoneById($script:cfg.quiet_timezone)
  $local = [TimeZoneInfo]::ConvertTimeFromUtc($Utc, $tz)
  $day = $local.DayOfWeek.ToString().Substring(0, 3); $hm = $local.ToString("HH:mm")
  foreach ($w in $script:cfg.quiet_windows) {
    if (($w.days -split ',') -notcontains $day) { continue }
    if (@($w.suppress) -notcontains $Condition) { continue }
    if ($hm -ge $w.from -and $hm -lt $w.to) { return $w.name }
  }
  return $null
}

function Read-Feed {
  $base = $script:cfg.feed_url.TrimEnd('/')
  $m = @{}
  foreach ($l in ((Invoke-WebRequest -UseBasicParsing -Uri "$base/metrics" -TimeoutSec 3).Content -split "`n")) {
    if ($l -match '^(qb_[a-z0-9_]+)\s+(-?[0-9.eE+]+)\s*$') { $m[$Matches[1]] = [double]$Matches[2] }
  }
  $h = (Invoke-WebRequest -UseBasicParsing -Uri "$base/health" -TimeoutSec 3).Content | ConvertFrom-Json
  return @{ m = $m; h = $h }
}

# new "mismatch" events in today's events CSV (file per UTC day)
$script:evFile = $null; $script:evLines = 0
function New-Mismatches {
  $f = Join-Path $script:cfg.events_dir "events-$((Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')).csv"
  if (-not (Test-Path -LiteralPath $f)) { return @() }
  $lines = @(Get-Content -LiteralPath $f)
  if ($script:evFile -ne $f) { $first = ($script:evFile -eq $null); $script:evFile = $f; if ($first) { $script:evLines = $lines.Count; return @() }; $script:evLines = 1 }
  $new = @(); if ($lines.Count -gt $script:evLines) { $new = $lines[$script:evLines..($lines.Count - 1)] }
  $script:evLines = $lines.Count
  return @($new | Where-Object { ($_ -split ',', 3)[1] -eq 'mismatch' } | ForEach-Object { ($_ -split ',', 3)[2] })
}

# ---- condition state
$active = @{}   # id -> @{ sev; reason; since; lastPush; until }
function Raise-Alert([string]$Id, [string]$Sev, [string]$Reason, [datetime]$Now, [int]$HoldSecs = 0) {
  if ($active.ContainsKey($Id)) {
    $a = $active[$Id]; $a.reason = $Reason
    if ($HoldSecs -gt 0) { $a.until = $Now.AddSeconds($HoldSecs) }
    if ($a.sev -eq "CRITICAL" -and ($Now - $a.lastPush).TotalMinutes -ge $script:cfg.remind_minutes) {
      $mins = [int]($Now - $a.since).TotalMinutes
      Send-Push "CRITICAL" "STILL CRITICAL: feed $Id ($mins min)" "What: $Reason`nSince: $(When $a.since)`nNow: $(When $Now)" | Out-Null
      $a.lastPush = $Now
    }
    return
  }
  $active[$Id] = @{ sev = $Sev; reason = $Reason; since = $Now; lastPush = $Now; until = $(if ($HoldSecs -gt 0) { $Now.AddSeconds($HoldSecs) } else { $null }) }
  Write-Log "RAISE [$Sev] $Id : $Reason"
  Send-Push $Sev "$Sev`: QoreBridge FIX feed $Id" "What: $Reason`nWhen: $(When $Now)`nHost: $env:COMPUTERNAME" | Out-Null
  $script:changed = $true
}
function Resolve-Alert([string]$Id, [datetime]$Now) {
  if (-not $active.ContainsKey($Id)) { return }
  $a = $active[$Id]
  if ($a.until -and $Now -lt $a.until) { return }   # one-shot events stay up for their hold time
  $active.Remove($Id)
  $dur = [int]($Now - $a.since).TotalSeconds
  Write-Log "CLEAR $Id after $dur s"
  Send-Push "RESOLVED" "RESOLVED: QoreBridge FIX feed $Id" "Was: [$($a.sev)] $($a.reason)`nFrom: $(When $a.since)`nTo: $(When $Now) ($dur s)" | Out-Null
  $script:changed = $true
}

# ---- main loop
Load-Config
if ($TestPush) {
  $ok = Send-Push "INFO" "Test: VyX feed alerts are connected" "This is a test push from the QoreBridge FIX feed monitor on $env:COMPUTERNAME.`nSent: $(When (Get-Date).ToUniversalTime())"
  if ($ok) { exit 0 } else { exit 1 }
}
Write-Log "feed alert monitor started (pid $PID)"
$prev = $null; $lastMove = (Get-Date).ToUniversalTime(); $unreach = 0; $stalePolls = 0; $engineBadSince = $null
$drops = New-Object System.Collections.Generic.List[object]
$lastReport = [datetime]::MinValue; $lastReportTry = [datetime]::MinValue; $lastSig = $null
while ($true) {
  $t0 = Get-Date
  Load-Config
  $now = (Get-Date).ToUniversalTime(); $script:changed = $false
  $snap = [ordered]@{}
  $f = $null
  try { $f = Read-Feed; $unreach = 0; Resolve-Alert "feed_down" $now } catch {
    $unreach++
    if ($unreach -eq 1 -or $unreach % 12 -eq 0) { Write-Log "feed read failed ($unreach in a row): $($_.Exception.Message)" }
    if ($unreach -ge $script:cfg.feed_unreachable_polls) {
      $svc = (Get-Service -Name $script:cfg.feed_service -ErrorAction SilentlyContinue).Status
      Raise-Alert "feed_down" "CRITICAL" "feed API $($script:cfg.feed_url) not answering for $unreach polls (service $($script:cfg.feed_service): $(if ($svc) { $svc } else { 'not found' })): $($_.Exception.Message)" $now
    }
  }
  if ($f) {
    $m = $f.m; $comp = $f.h.components
    $snap.quotes = $m['qb_feed_quotes']; $snap.symbols_ok = $m['qb_feed_symbols_ok']; $snap.symbols_stale = $m['qb_feed_symbols_stale']
    $snap.symbols_held = $m['qb_feed_symbols_held']; $snap.disconnects = $m['qb_feed_disconnects']; $snap.uptime_s = $m['qb_uptime_seconds']

    # restart: counters went back -> new baselines
    if ($prev -and ($m['qb_uptime_seconds'] -lt $prev['qb_uptime_seconds'] -or $m['qb_feed_quotes'] -lt $prev['qb_feed_quotes'])) {
      Raise-Alert "restart" "WARNING" "the feed process restarted (uptime $([int]$m['qb_uptime_seconds']) s); counters start again" $now 60
      $prev = $null; $lastMove = $now
    }

    # 1) stall: no market data message on any symbol
    if (-not $prev -or $m['qb_feed_quotes'] -ne $prev['qb_feed_quotes']) { $lastMove = $now }
    $stall = [int]($now - $lastMove).TotalSeconds; $snap.no_quote_secs = $stall
    $q = In-Quiet "stall" $now
    if ($stall -gt $script:cfg.stall_secs -and -not $q) {
      Raise-Alert "stall" "CRITICAL" "feed stall: no quote on ANY symbol for $stall s (threshold $($script:cfg.stall_secs) s); last quote $(When $lastMove)" $now
    } else { Resolve-Alert "stall" $now }

    # 2) session
    $sess = $comp.'feed:session'
    if ($sess -and $sess.status -ne "ok") {
      Raise-Alert "session" "CRITICAL" "FIX session not ok: $($sess.status)$(if ($sess.detail) { " ($($sess.detail))" })" $now
    } elseif ($prev -and $m['qb_feed_disconnects'] -gt $prev['qb_feed_disconnects']) {
      Raise-Alert "session" "CRITICAL" "FIX session disconnected/logged out $([int]($m['qb_feed_disconnects'] - $prev['qb_feed_disconnects'])) time(s); total $([int]$m['qb_feed_disconnects']); last reconnect took $([int]$m['qb_feed_reconnect_ms_last']) ms" $now $script:cfg.session_event_hold_secs
    } else { Resolve-Alert "session" $now }
    if ($prev -and $m['qb_feed_logon_rejects'] -gt $prev['qb_feed_logon_rejects']) {
      Raise-Alert "logon_reject" "CRITICAL" "FIX logon REJECTED by the LP ($([int]$m['qb_feed_logon_rejects']) total). Check the password before any retry: repeated failures can lock the account." $now $script:cfg.session_event_hold_secs
    } else { Resolve-Alert "logon_reject" $now }

    # mapping guard
    $mm = @(New-Mismatches)
    if ($m['qb_feed_symbols_held'] -gt 0 -or $mm.Count -gt 0) {
      $held = @($comp.PSObject.Properties | Where-Object { $_.Name -like 'feed:*' -and $_.Value.status -eq 'held' } | ForEach-Object { $_.Name.Substring(5) })
      $why = @(); if ($m['qb_feed_symbols_held'] -gt 0) { $why += "$([int]$m['qb_feed_symbols_held']) symbol(s) held by the mapping guard$(if ($held.Count) { ': ' + ($held -join ', ') })" }
      if ($mm.Count -gt 0) { $why += "mapping mismatch: " + ($mm -join '; ') }
      Raise-Alert "mapping" "CRITICAL" (($why -join '. ') + ". A held symbol stops feeding.") $now $(if ($mm.Count -gt 0) { $script:cfg.session_event_hold_secs } else { 0 })
    } else { Resolve-Alert "mapping" $now }

    # 3) widespread staleness
    $syms = @($comp.PSObject.Properties | Where-Object { $_.Name -like 'feed:*' -and $_.Name -notin @('feed:session', 'feed:engine') -and @($script:cfg.stale_exclude) -notcontains $_.Name.Substring(5) })
    $stale = @($syms | Where-Object { $_.Value.status -ne 'ok' } | ForEach-Object { $_.Name.Substring(5) })
    $ratio = if ($syms.Count) { $stale.Count / $syms.Count } else { 0 }
    $snap.stale_ratio = [math]::Round($ratio, 3)
    if ($ratio -ge $script:cfg.stale_warn_ratio) { $stalePolls++ } else { $stalePolls = 0 }
    if ($stalePolls -ge $script:cfg.stale_warn_polls -and -not (In-Quiet "stale" $now)) {
      Raise-Alert "stale" "WARNING" "$($stale.Count) of $($syms.Count) symbols stale ($([int]($ratio * 100))%, threshold $([int]($script:cfg.stale_warn_ratio * 100))%): $(($stale | Select-Object -First 15) -join ', ')$(if ($stale.Count -gt 15) { ', ...' })" $now
    } elseif ($stalePolls -eq 0 -or (In-Quiet "stale" $now)) { Resolve-Alert "stale" $now }

    # 4) drops / rejects spike
    if ($prev) {
      $d = ($m['qb_feed_dropped'] - $prev['qb_feed_dropped']) + ($m['qb_feed_log_dropped'] - $prev['qb_feed_log_dropped']) + ($m['qb_feed_post_errors'] - $prev['qb_feed_post_errors'])
      if ($d -gt 0) { $drops.Add(@($now, $d)) }
    }
    $cut = $now.AddSeconds(-$script:cfg.drop_window_secs)
    while ($drops.Count -gt 0 -and $drops[0][0] -lt $cut) { $drops.RemoveAt(0) }
    $dsum = 0; foreach ($x in $drops) { $dsum += $x[1] }
    $snap.drops_window = $dsum
    if ($dsum -ge $script:cfg.drop_warn_count) {
      Raise-Alert "drops" "WARNING" "$([int]$dsum) quotes/log lines/posts dropped or refused in the last $($script:cfg.drop_window_secs) s (threshold $($script:cfg.drop_warn_count)); totals: dropped $([int]$m['qb_feed_dropped']), log_dropped $([int]$m['qb_feed_log_dropped']), post_errors $([int]$m['qb_feed_post_errors'])" $now
    } else { Resolve-Alert "drops" $now }

    # engine readability (fires on every engine restart, hence the delay)
    $eng = $comp.'feed:engine'
    if ($eng -and $eng.status -ne 'ok') { if (-not $engineBadSince) { $engineBadSince = $now } } else { $engineBadSince = $null }
    if ($engineBadSince -and ($now - $engineBadSince).TotalSeconds -gt $script:cfg.engine_warn_secs) {
      Raise-Alert "engine" "WARNING" "the feed cannot read the engine for $([int]($now - $engineBadSince).TotalSeconds) s: $($eng.status)$(if ($eng.detail) { " ($($eng.detail))" })" $now
    } else { Resolve-Alert "engine" $now }

    $prev = $m
  }
  foreach ($id in @($active.Keys)) { if ($active[$id].until) { Resolve-Alert $id $now } }   # expire one-shot events

  # platform report: on a change, and every heartbeat_minutes
  $worst = if (@($active.Values | Where-Object { $_.sev -eq 'CRITICAL' }).Count) { "CRITICAL" } elseif ($active.Count) { "WARNING" } else { $null }
  $reasons = @($active.Keys | Sort-Object | ForEach-Object { "[$($active[$_].sev)] $_ since $($active[$_].since.ToString('HH:mm:ss'))Z: $($active[$_].reason)" })
  $sig = "$worst|$(@($active.Keys | Sort-Object) -join ',')"
  # a failed report is retried at most every 30 s, not on every poll
  if (($sig -ne $lastSig -or ($now - $lastReport).TotalMinutes -ge $script:cfg.heartbeat_minutes) -and ($now - $lastReportTry).TotalSeconds -ge 30) {
    $lastReportTry = $now
    if (Send-Report (-not $worst) $worst $reasons $snap) { $lastReport = $now; $lastSig = $sig; $lastReportTry = [datetime]::MinValue }
  }
  $status = [ordered]@{ checkedAt = $now.ToString("o"); worst = $worst; active = $reasons; snapshot = $snap }
  $status | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $script:cfg.status_dir "feed-alert.json") -Encoding utf8

  if ($Once) { break }
  $sleep = [math]::Max(0.2, $script:cfg.poll_secs - ((Get-Date) - $t0).TotalSeconds)
  Start-Sleep -Milliseconds ([int]($sleep * 1000))
}
