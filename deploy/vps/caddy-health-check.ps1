# Caddy health check for the VPS (owner 2026-10-05, after the nssm restart loop with an orphan Caddy:
# deploy/caddy-service-recovery-runbook.md). Read-only on the box apart from its own two status files.
# Runs every 5 minutes as the scheduled task "VyX Caddy health" (deploy/vps/install-caddy-health-task.ps1).
#
# Checks:
#   a) exactly one caddy.exe is running
#   b) that caddy.exe is a child of the nssm process of service vyxtrader-caddy (not an orphan / hand-started)
#   c) `nssm status vyxtrader-caddy` is SERVICE_RUNNING (not PAUSED / STOPPED)
#   d) no NEW "bind" / "address already in use" lines in Caddy's stderr log since the last run
#      (the first run only records where the log ends, so old errors never alert)
#   e) https://feed.vyxtrader.com/health answers 200 within 5 s
# Reports: POST to <WebUrl>/api/internal/infra-health (x-internal-secret = INTERNAL_SERVICE_SECRET from
# start-gateway.cmd, never printed), writes C:\vyxtrader\status\caddy-health.json, prints one line.
# Exit 0 = all OK, 1 = something is wrong.
param(
  [string]$WebUrl = "https://www.vyxtrader.com",
  [string]$HealthUrl = "https://feed.vyxtrader.com/health",
  [string]$GatewayCmd = "C:\vyxtrader\scripts\start-gateway.cmd",
  [string]$StatusDir = "C:\vyxtrader\status",
  [string]$NssmPath = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe",
  [string]$StderrLog = ""   # testing only: overrides the log path nssm reports
)
$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Nssm = $NssmPath
$HaveNssm = Test-Path -LiteralPath $Nssm
$Service = "vyxtrader-caddy"
$StateFile = Join-Path $StatusDir "caddy-health.state.json"
$OutFile = Join-Path $StatusDir "caddy-health.json"
New-Item -ItemType Directory -Force $StatusDir | Out-Null

function Get-NssmValue([string]$Key) { if (-not $HaveNssm) { return "" }; ((& $Nssm get $Service $Key 2>$null) -join "" -replace "`0", "").Trim() }
function Get-CmdVar([string]$Path, [string]$Name) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  $l = Get-Content -LiteralPath $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if ($l) { ($l -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim() }
}

$reasons = New-Object System.Collections.Generic.List[string]
$checks = [ordered]@{}

# a) + b) processes
$svc = Get-CimInstance Win32_Service -Filter "Name='$Service'" -ErrorAction SilentlyContinue
$nssmPid = if ($svc) { [int]$svc.ProcessId } else { 0 }
$caddies = @(Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" -ErrorAction SilentlyContinue)
$checks.processCount = $caddies.Count
$checks.servicePid = $nssmPid
$checks.caddyPids = @($caddies | ForEach-Object { [int]$_.ProcessId })
if ($caddies.Count -eq 0) { $reasons.Add("no caddy.exe is running") }
elseif ($caddies.Count -gt 1) {
  $desc = ($caddies | ForEach-Object { "pid $($_.ProcessId) parent $($_.ParentProcessId) started $($_.CreationDate.ToUniversalTime().ToString('yyyy-MM-dd HH:mm'))Z" }) -join "; "
  $reasons.Add("$($caddies.Count) caddy.exe processes ($desc); expected 1")
}
$orphans = @($caddies | Where-Object { $nssmPid -eq 0 -or [int]$_.ParentProcessId -ne $nssmPid })
$checks.orphanPids = @($orphans | ForEach-Object { [int]$_.ProcessId })
foreach ($o in $orphans) { $reasons.Add("caddy.exe pid $($o.ProcessId) is not a child of the $Service service (parent $($o.ParentProcessId), service pid $nssmPid)") }

# c) service state
$status = if ($HaveNssm) { ((& $Nssm status $Service 2>$null) -join "" -replace "`0", "").Trim() } else { "nssm not found at $Nssm" }
$checks.serviceStatus = $status
if ($status -ne "SERVICE_RUNNING") { $reasons.Add("service $Service is '$status', expected SERVICE_RUNNING") }

# d) new bind errors in the stderr log
$log = if ($StderrLog) { $StderrLog } else { Get-NssmValue "AppStderr" }
$checks.stderrLog = $log
$state = $null
if (Test-Path -LiteralPath $StateFile) { try { $state = Get-Content -LiteralPath $StateFile -Raw | ConvertFrom-Json } catch { $state = $null } }
$newBind = 0
if ($log -and (Test-Path -LiteralPath $log)) {
  $len = (Get-Item -LiteralPath $log).Length
  $from = 0L
  $baseline = $false
  if ($null -eq $state -or $state.log -ne $log) { $from = $len; $baseline = $true }        # first run: start at the end
  elseif ([long]$state.length -le $len) { $from = [long]$state.length }                   # normal: only the new part
  else { $from = 0L }                                                                     # rotated / truncated: whole new file
  if ($len -gt $from) {
    $fs = [System.IO.File]::Open($log, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
    try {
      [void]$fs.Seek($from, [System.IO.SeekOrigin]::Begin)
      $sr = New-Object System.IO.StreamReader($fs, [System.Text.Encoding]::UTF8)
      while ($null -ne ($line = $sr.ReadLine())) { if ($line -match 'bind|address already in use') { $newBind++ } }
    } finally { $fs.Dispose() }
  }
  $checks.stderrBaseline = $baseline
  @{ log = $log; length = $len; checkedAt = (Get-Date).ToUniversalTime().ToString("o") } | ConvertTo-Json | Set-Content -LiteralPath $StateFile -Encoding UTF8
} else {
  $checks.stderrBaseline = $false
}
$checks.newBindErrors = $newBind
if ($newBind -gt 0) { $reasons.Add("$newBind new 'bind' / 'address already in use' line(s) in $log since the last check") }

# e) the public health endpoint
try {
  $r = Invoke-WebRequest -UseBasicParsing -Uri $HealthUrl -TimeoutSec 5
  $checks.healthStatus = [int]$r.StatusCode
} catch {
  $code = $null; if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
  $checks.healthStatus = $code
}
if ($checks.healthStatus -ne 200) { $reasons.Add("$HealthUrl answered $(if ($checks.healthStatus) { $checks.healthStatus } else { 'nothing within 5 s' })") }

$ok = ($reasons.Count -eq 0)
$result = [ordered]@{ component = "caddy"; ok = $ok; checks = $checks; reasons = @($reasons); checkedAt = (Get-Date).ToUniversalTime().ToString("o"); host = $env:COMPUTERNAME }
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

"caddy health $(if ($ok) { 'OK' } else { 'FAIL' }): processes $($checks.processCount), service $status, new bind errors $newBind, /health $($checks.healthStatus); report $delivered$(if (-not $ok) { '; ' + ($reasons -join '; ') })"
if ($ok) { exit 0 } else { exit 1 }
