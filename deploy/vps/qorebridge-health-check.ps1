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
# Reports: POST to $WebUrl/api/internal/infra-health (x-internal-secret = INTERNAL_SERVICE_SECRET from
# start-gateway.cmd, never printed), writes C:\vyxtrader\status\qorebridge-health.json, prints one line.
# Exit 0 = all OK, 1 = something is wrong.
param(
  [string]$WebUrl = "https://www.vyxtrader.com",
  [string]$HealthUrl = "http://127.0.0.1:8095/health",
  [string]$MetricsUrl = "http://127.0.0.1:8095/metrics",
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
# stable failure keys (checks.failing): the web alerts on each NEW key, not only on OK -> FAIL (lib/infra-health.ts)
$failing = New-Object System.Collections.Generic.List[string]
function Add-Failure([string]$Key, [string]$Text) { $reasons.Add($Text); if (-not $failing.Contains($Key)) { $failing.Add($Key) } }

# ---- a) service state
$status = if ($HaveNssm) { ((& $Nssm status $Service 2>$null) -join "" -replace "`0", "").Trim() } else { "" }
$checks.serviceStatus = $status
if ($status -ne "SERVICE_RUNNING") { Add-Failure "service" ("nssm status $Service is '$(if ($status) { $status } else { 'unknown' })', not SERVICE_RUNNING") }

# ---- b + c) /health
$checks.healthStatus = $null
$checks.healthOk = $null
$checks.componentsBad = @()
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
  $checks.healthStatus = [int]$r.StatusCode
  $h = $r.Content | ConvertFrom-Json
  $checks.healthOk = ($h.status -eq "ok")
  if ($h.status -ne "ok") { Add-Failure "health_status" ("/health overall status is '$($h.status)', not ok") }
  $bad = @()
  if ($h.components) {
    foreach ($p in $h.components.PSObject.Properties) {
      if ($p.Value.status -ne "ok") { $bad += "$($p.Name)=$($p.Value.status)" }
    }
  } else { Add-Failure "health_components" ("/health returned no components block") }
  $checks.componentsBad = @($bad)
  if ($bad.Count -gt 0) { Add-Failure "health_components" ("/health components not ok: $($bad -join ', ')") }
} catch {
  $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  $checks.healthStatus = $code
  Add-Failure "health_down" ("$HealthUrl answered $(if ($code) { $code } else { 'nothing within 5 s' })")
}
if ($checks.healthStatus -ne $null -and $checks.healthStatus -ne 200) {
  if (-not ($reasons -match 'answered')) { Add-Failure "health_down" ("$HealthUrl answered $($checks.healthStatus)") }
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
  Add-Failure "metrics" ("$MetricsUrl unreachable: $($_.Exception.Message)")
}
$licMeaning = @{ 0 = "holding (not yet confirmed)"; 1 = "ok"; 2 = "grace (platform unreachable)"; 3 = "stopped" }
if ($checks.licenseState -eq $null) { Add-Failure "license_state" ("qb_license_state not present in /metrics") }
elseif ($checks.licenseState -ne 1) { Add-Failure "license_state" ("qb_license_state is $($checks.licenseState) -- $($licMeaning[[int]$checks.licenseState]) -- expected 1 (ok)") }
if ($checks.lpSessionsReady -eq $null) { Add-Failure "lp_sessions" ("qb_lp_sessions_ready not present in /metrics") }
elseif ($checks.lpSessionsReady -lt 1) { Add-Failure "lp_sessions" ("qb_lp_sessions_ready is 0 -- no LP FIX session is logged on") }

$checks.failing = @($failing)
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

"qorebridge health $(if ($ok) { 'OK' } else { 'FAIL' }): service $status, /health $($checks.healthStatus), license_state $($checks.licenseState), lp_sessions_ready $($checks.lpSessionsReady); report $delivered$(if (-not $ok) { '; ' + ($reasons -join '; ') })"
if ($ok) { exit 0 } else { exit 1 }
