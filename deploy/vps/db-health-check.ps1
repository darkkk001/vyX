# Book database health check for the VPS (incident 2026-10-27 11:02-11:30 UTC: the neondb_owner password was reset, the
# database refused every NEW connection for ~28 minutes and every check stayed green). Read-only apart from its own
# status file. Runs every 2 minutes as the scheduled task "VyX DB health" (deploy/vps/install-db-health-task.ps1).
#
# Reads the book-database probe of the engine, the gateway and the web (engine/server/src/db_probe.rs,
# services/api-gateway/src/db-probe.ts, lib/db-probe.ts): each opens a NEW connection and reports it in /health
# (`x-vyx-db: ok | idle | starting | down reason=<auth|unreachable|timeout|error|probe-stale> ...`; down = HTTP 503).
# The web is asked only while the engine's probe runs (not idle), so Neon still suspends when quiet.
#   FAIL = any of them says "down".
#   An engine / gateway that does not answer at all is NOT this check's failure (the Caddy check's feed /health and the
#   deploy scripts cover a dead process); it is recorded in the checks only.
# The daily break (16:59-18:00 New York time = 20:59-22:00 UTC in summer, 21:59-23:00 UTC in winter; deploys and
# restarts happen there): nothing is reported, so a restart never alerts; a failure that is still there after the break
# alerts at the first check after it.
# Reports: POST to <WebUrl>/api/internal/infra-health as component "database" (x-internal-secret = INTERNAL_SERVICE_SECRET
# from start-gateway.cmd, never printed): one e-mail on OK -> FAIL, one on recovery (lib/infra-health.ts). That route
# needs Redis and e-mail only, no database, so it still alerts when the web's own database access is down.
# Exit 0 = OK (or in the break), 1 = down.
param(
  [string]$WebUrl = "https://www.vyxtrader.com",
  [string]$EngineHealth = "http://127.0.0.1:8081/health",
  [string]$GatewayHealth = "http://127.0.0.1:8080/health",
  [string]$GatewayCmd = "C:\vyxtrader\scripts\start-gateway.cmd",
  [string]$StatusDir = "C:\vyxtrader\status",
  [string]$Now = ""   # testing only: an ISO UTC time instead of the clock (the break rule)
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$OutFile = Join-Path $StatusDir "db-health.json"
New-Item -ItemType Directory -Force $StatusDir | Out-Null

function Get-CmdVar([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $l = Get-Content -LiteralPath $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() }
}
# The daily break in New York time (the session rolls at 17:00 ET; the platform's break is 16:59-18:00 ET).
function Test-InBreak([datetime]$utc) {
  $et = [TimeZoneInfo]::ConvertTimeFromUtc($utc, [TimeZoneInfo]::FindSystemTimeZoneById("Eastern Standard Time"))
  $m = $et.Hour * 60 + $et.Minute
  return ($m -ge (16 * 60 + 59)) -and ($m -lt (18 * 60))
}
# GET <url>: HTTP code (0 = no answer within 5 s) and the x-vyx-db header ("" when absent).
function Read-Health([string]$Url) {
  try {
    $r = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 5
    return @{ code = [int]$r.StatusCode; db = "$($r.Headers['x-vyx-db'])" }
  } catch {
    $resp = $_.Exception.Response
    if ($resp) { return @{ code = [int]$resp.StatusCode; db = "$($resp.Headers['x-vyx-db'])" } }
    return @{ code = 0; db = "" }
  }
}

$utcNow = if ($Now) { [datetime]::Parse($Now, $null, [Globalization.DateTimeStyles]::AdjustToUniversal -bor [Globalization.DateTimeStyles]::AssumeUniversal) } else { (Get-Date).ToUniversalTime() }
$checks = [ordered]@{}
$reasons = New-Object System.Collections.Generic.List[string]
# stable failure keys (checks.failing): the web alerts on each NEW key, not only on OK -> FAIL (lib/infra-health.ts)
$failing = New-Object System.Collections.Generic.List[string]
function Add-Failure([string]$Key, [string]$Text) { $reasons.Add($Text); if (-not $failing.Contains($Key)) { $failing.Add($Key) } }
foreach ($c in @(@{ name = "engine"; url = $EngineHealth }, @{ name = "gateway"; url = $GatewayHealth })) {
  $h = Read-Health $c.url
  $checks["$($c.name)Status"] = $h.code
  $checks["$($c.name)Db"] = if ($h.db) { $h.db } elseif ($h.code -eq 0) { "no answer" } else { "no probe (older build)" }
  if ($h.db -like "down*") { Add-Failure "$($c.name)_db" ("$($c.name): the book database refuses new connections ($($h.db)); /health $($h.code)") }
}
# The web (Vercel, its own DATABASE_URL: lib/db-probe.ts behind /api/health). Asked only while the engine's probe runs
# (x-vyx-db ok / down / starting, not idle): each ask opens a new connection, and Neon must still suspend when quiet.
if ($checks.engineDb -like "ok*" -or $checks.engineDb -like "down*" -or $checks.engineDb -like "starting*") {
  $h = Read-Health "$WebUrl/api/health"
  $checks.webStatus = $h.code
  $checks.webDb = if ($h.db) { $h.db } elseif ($h.code -eq 0) { "no answer" } else { "no probe (older build)" }
  if ($h.db -like "down*") { Add-Failure "web_db" ("web: the book database refuses new connections ($($h.db)); /api/health $($h.code)") }
} else {
  $checks.webStatus = $null
  $checks.webDb = "not asked (the engine is idle or has no probe)"
}

$inBreak = Test-InBreak $utcNow
$checks.failing = @($failing)
$ok = ($reasons.Count -eq 0)
$result = [ordered]@{ component = "database"; ok = $ok; checks = $checks; reasons = @($reasons); checkedAt = $utcNow.ToString("o"); host = $env:COMPUTERNAME }
$delivered = "not sent"
if ($inBreak) {
  $delivered = "not sent: daily break (deploys and restarts happen now)"
} else {
  $secret = Get-CmdVar $GatewayCmd "INTERNAL_SERVICE_SECRET"
  if (-not $secret) { $delivered = "not sent: INTERNAL_SERVICE_SECRET not found in $GatewayCmd" }
  else {
    try {
      $json = $result | ConvertTo-Json -Depth 5 -Compress
      $resp = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$WebUrl/api/internal/infra-health" -Headers @{ "x-internal-secret" = $secret } -ContentType "application/json" -Body $json -TimeoutSec 15
      $delivered = "delivered ($([int]$resp.StatusCode))"
    } catch {
      $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
      $delivered = "NOT delivered ($(if ($code) { "HTTP $code" } else { $_.Exception.Message }))"
    }
  }
  $secret = $null
}
$result.report = $delivered
$result.inBreak = $inBreak
$result | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $OutFile -Encoding UTF8

"db health $(if ($ok) { 'OK' } else { 'FAIL' }): engine $($checks.engineStatus) [$($checks.engineDb)], gateway $($checks.gatewayStatus) [$($checks.gatewayDb)], web $($checks.webStatus) [$($checks.webDb)]; report $delivered$(if (-not $ok) { '; ' + ($reasons -join '; ') })"
if ($ok -or $inBreak) { exit 0 } else { exit 1 }
