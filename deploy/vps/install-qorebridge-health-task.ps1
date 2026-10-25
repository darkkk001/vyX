# Installs (or with -Uninstall removes) the scheduled task "VyX QoreBridge health": runs
# qorebridge-health-check.ps1 every 5 minutes as SYSTEM. Same shape as install-caddy-health-task.ps1.
# Idempotent: re-running replaces the task. Run in an elevated PowerShell on the VPS.
param([switch]$Uninstall)
$ErrorActionPreference = "Stop"
$TaskName = "VyX QoreBridge health"
$Target = "C:\vyxtrader\scripts\qorebridge-health-check.ps1"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "removed task '$TaskName'" }
  else { "task '$TaskName' was not installed" }
  return
}

if (-not (Test-Path -LiteralPath $Target)) { throw "check script not found: $Target" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Target`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName $TaskName
"installed task '$TaskName' ($($t.State)): every 5 minutes as SYSTEM, runs $Target"
