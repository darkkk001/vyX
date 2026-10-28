# QoreBridge health check for the VPS (owner 2026-10-25). Mirrors caddy-health-check.ps1.
# Read-only on the box apart from its own status file: it NEVER restarts or touches a service.
# Runs every 5 minutes as the scheduled task "VyX QoreBridge health".
#
# Checks:
#   a) `nssm status QoreBridge` is SERVICE_RUNNING
#   b) http://127.0.0.1:8095/health answers 200 within 5 s
#   c) /health overall status is "ok" AND every component (intake, license, lp:*) is "ok"
#   d) qb_license_state is 1  (0 = holding / not yet confirmed, 2 = grace / platform unreachable, 3 = stopped)
#   e) qb_lp_sessions_ready is at least 1
#   f) the price feed, when its service is installed (owner 2026-10-28): `nssm status QoreBridgeFeed` is
#      SERVICE_RUNNING and its own qb_license_state on http://127.0.0.1:8096/metrics is 1. Not installed = skipped.
# Reports: POST to $WebUrl/api/internal/infra-health (x-internal-secret = INTERNAL_SERVICE_SECRET from
# start-gateway.cmd, never printed), writes C:\vyxtrader\status\qorebridge-health.json, prints one line.
# Exit 0 = all OK, 1 = something is wrong.
param(
  [string]$WebUrl = "https://www.vyxtrader.com",
  [string]$HealthUrl = "http://127.0.0.1:8095/health",
  [string]$MetricsUrl = "http://127.0.0.1:8095/metrics",
  [string]$FeedMetricsUrl = "http://127.0.0.1:8096/metrics",
  [string]$FeedService = "QoreBridgeFeed",
  [string]$GatewayCmd = "C:\vyxtrader\scripts\start-gateway.cmd",
  [string]$StatusDir = "C:\vyxtrader\status",
  [string]$NssmPath = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Nssm = $NssmPath
$HaveNssm = Test-Path -LiteralPath $Nssm
$Service = "QoreBridge"
$OutFile = Join-Path $StatusDir "qorebridge-health.json"
New-Item -ItemType Directory -Force $StatusDir | Out-Null

function Get-CmdVar([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $l = Get-Content -LiteralPath $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() }
}

$reasons = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}

# ---- a) service state
$status = if ($HaveNssm) { ((& $Nssm status $Service 2>$null) -join "" -replace "`0", "").Trim() } else { "" }
$checks.serviceStatus = $status
if ($status -ne "SERVICE_RUNNING") { $reasons.Add("nssm status $Service is '$(if ($status) { $status } else { 'unknown' })', not SERVICE_RUNNING") }

# ---- b + c) /health
$checks.healthStatus = $null
$checks.healthOk = $null
$checks.componentsBad = @()
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
  $checks.healthStatus = [int]$r.StatusCode
  $h = $r.Content | ConvertFrom-Json
  $checks.healthOk = ($h.status -eq "ok")
  if ($h.status -ne "ok") { $reasons.Add("/health overall status is '$($h.status)', not ok") }
  $bad = @()
  if ($h.components) {
    foreach ($p in $h.components.PSObject.Properties) {
      if ($p.Value.status -ne "ok") { $bad += "$($p.Name)=$($p.Value.status)" }
    }
  } else { $reasons.Add("/health returned no components block") }
  $checks.componentsBad = @($bad)
  if ($bad.Count -gt 0) { $reasons.Add("/health components not ok: $($bad -join ', ')") }
} catch {
  $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  $checks.healthStatus = $code
  $reasons.Add("$HealthUrl answered $(if ($code) { $code } else { 'nothing within 5 s' })")
}
if ($checks.healthStatus -ne $null -and $checks.healthStatus -ne 200) {
  if (-not ($reasons -match 'answered')) { $reasons.Add("$HealthUrl answered $($checks.healthStatus)") }
}

# ---- d + e) metrics
$checks.licenseState = $null
$checks.lpSessionsReady = $null
try {
  $m = (Invoke-WebRequest -UseBasicParsing -Uri $MetricsUrl -TimeoutSec 5).Content -split "`n"
  $ls = $m | Where-Object { $_ -match '^qb_license_state\s+(\d+)' } | Select-Object -First 1
  if ($ls -match '^qb_license_state\s+(\d+)') { $checks.licenseState = [int]$Matches[1] }
  $lp = $m | Where-Object { $_ -match '^qb_lp_sessions_ready\s+(\d+)' } | Select-Object -First 1
  if ($lp -match '^qb_lp_sessions_ready\s+(\d+)') { $checks.lpSessionsReady = [int]$Matches[1] }
} catch {
  $reasons.Add("$MetricsUrl unreachable: $($_.Exception.Message)")
}
$licMeaning = @{ 0 = "holding (not yet confirmed)"; 1 = "ok"; 2 = "grace (platform unreachable)"; 3 = "stopped" }
if ($checks.licenseState -eq $null) { $reasons.Add("qb_license_state not present in /metrics") }
elseif ($checks.licenseState -ne 1) { $reasons.Add("qb_license_state is $($checks.licenseState) -- $($licMeaning[[int]$checks.licenseState]) -- expected 1 (ok)") }
if ($checks.lpSessionsReady -eq $null) { $reasons.Add("qb_lp_sessions_ready not present in /metrics") }
elseif ($checks.lpSessionsReady -lt 1) { $reasons.Add("qb_lp_sessions_ready is 0 -- no LP FIX session is logged on") }

# ---- f) the price feed (its own process, its own license check)
$checks.feedServiceStatus = $null
$checks.feedLicenseState = $null
$feedStatus = if ($HaveNssm) { ((& $Nssm status $FeedService 2>$null) -join "" -replace "`0", "").Trim() } else { "" }
if ($feedStatus -match '^SERVICE_') {
  $checks.feedServiceStatus = $feedStatus
  if ($feedStatus -ne "SERVICE_RUNNING") { $reasons.Add("nssm status $FeedService is '$feedStatus', not SERVICE_RUNNING") }
  else {
    try {
      $fm = (Invoke-WebRequest -UseBasicParsing -Uri $FeedMetricsUrl -TimeoutSec 5).Content -split "`n"
      $fl = $fm | Where-Object { $_ -match '^qb_license_state\s+(\d+)' } | Select-Object -First 1
      if ($fl -match '^qb_license_state\s+(\d+)') { $checks.feedLicenseState = [int]$Matches[1] }
    } catch {
      $reasons.Add("$FeedMetricsUrl unreachable: $($_.Exception.Message)")
    }
    if ($checks.feedLicenseState -eq $null) { if (-not ($reasons -match [regex]::Escape($FeedMetricsUrl))) { $reasons.Add("feed qb_license_state not present in $FeedMetricsUrl") } }
    elseif ($checks.feedLicenseState -ne 1) { $reasons.Add("feed qb_license_state is $($checks.feedLicenseState) -- $($licMeaning[[int]$checks.feedLicenseState]) -- expected 1 (ok)") }
  }
} else {
  $checks.feedServiceStatus = "not installed"
}

$ok = ($reasons.Count -eq 0)
$result = [ordered]@{ component = "qorebridge"; ok = $ok; checks = $checks; reasons = @($reasons); checkedAt = (Get-Date).ToUniversalTime().ToString("o"); host = $env:COMPUTERNAME }
$json = $result | ConvertTo-Json -Depth 5 -Compress

# report to the web (secret never printed)
$delivered = "not sent"
$secret = Get-CmdVar $GatewayCmd "INTERNAL_SERVICE_SECRET"
if (-not $secret) { $delivered = "not sent: INTERNAL_SERVICE_SECRET not found in $GatewayCmd" }
else {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$WebUrl/api/internal/infra-health" -Headers @{ "x-internal-secret" = $secret } -ContentType "application/json" -Body $json -TimeoutSec 15
    $delivered = "delivered ($([int]$resp.StatusCode))"
  } catch {
    $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    $delivered = "NOT delivered ($(if ($code) { "HTTP $code" } else { $_.Exception.Message }))"
  }
}
$secret = $null
$result.report = $delivered
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding UTF8

"qorebridge health $(if ($ok) { 'OK' } else { 'FAIL' }): service $status, /health $($checks.healthStatus), license_state $($checks.licenseState), lp_sessions_ready $($checks.lpSessionsReady), feed $($checks.feedServiceStatus)$(if ($checks.feedServiceStatus -ne 'not installed') { ' license_state ' + $checks.feedLicenseState }); report $delivered$(if (-not $ok) { '; ' + ($reasons -join '; ') })"
if ($ok) { exit 0 } else { exit 1 }
