# Installs the QoreBridgeFeed alert monitor (feed-alert-monitor.ps1) as the nssm service VyXFeedAlert (owner 2026-10-29).
# Copies the script to C:\vyxtrader\scripts, the config to C:\vyxtrader\config\feed-alert.json (only when it does not
# exist yet, so tuned thresholds survive a reinstall), sends one test push, then starts the service.
param(
  [string]$NssmPath = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe",
  [string]$ServiceName = "VyXFeedAlert",
  [switch]$Reinstall
)
$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = "C:\vyxtrader\scripts\feed-alert-monitor.ps1"
$config = "C:\vyxtrader\config\feed-alert.json"
New-Item -ItemType Directory -Force "C:\vyxtrader\scripts", "C:\vyxtrader\config", "C:\vyxtrader\status" | Out-Null
Copy-Item (Join-Path $here "feed-alert-monitor.ps1") $script -Force
if (-not (Test-Path $config)) { Copy-Item (Join-Path $here "feed-alert.config.json") $config }
$cfg = Get-Content $config -Raw | ConvertFrom-Json
if (-not (Test-Path $cfg.ntfy_topic_file)) { throw "ntfy topic file $($cfg.ntfy_topic_file) is missing" }

& powershell.exe -NoProfile -ExecutionPolicy Bypass -File $script -ConfigPath $config -TestPush
if ($LASTEXITCODE -ne 0) { throw "the test push failed; nothing installed" }

$existing = Get-Service -Name $ServiceName -ErrorAction SilentlyContinue
if ($existing) {
  if (-not $Reinstall) { throw "Service $ServiceName already exists. Use -Reinstall to replace it." }
  & $NssmPath stop $ServiceName | Out-Null
  & $NssmPath remove $ServiceName confirm | Out-Null
}
& $NssmPath install $ServiceName "C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe" | Out-Null
& $NssmPath set $ServiceName AppParameters "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$script`" -ConfigPath `"$config`"" | Out-Null
& $NssmPath set $ServiceName AppDirectory "C:\vyxtrader\scripts" | Out-Null
& $NssmPath set $ServiceName DisplayName "VyX Feed alert (QoreBridgeFeed)" | Out-Null
& $NssmPath set $ServiceName Description "Pushes CRITICAL/WARNING alerts for the QoreBridge FIX price feed (read-only monitor)" | Out-Null
& $NssmPath set $ServiceName Start SERVICE_AUTO_START | Out-Null
& $NssmPath set $ServiceName AppExit Default Restart | Out-Null
& $NssmPath set $ServiceName AppRestartDelay 5000 | Out-Null
& $NssmPath set $ServiceName AppStdout "C:\vyxtrader\status\feed-alert-service.log" | Out-Null
& $NssmPath set $ServiceName AppStderr "C:\vyxtrader\status\feed-alert-service.log" | Out-Null
& $NssmPath set $ServiceName AppRotateFiles 1 | Out-Null
& $NssmPath set $ServiceName AppRotateBytes 10485760 | Out-Null
Start-Service $ServiceName
"Installed $ServiceName ($((Get-Service $ServiceName).Status)). Status: C:\vyxtrader\status\feed-alert.json"
