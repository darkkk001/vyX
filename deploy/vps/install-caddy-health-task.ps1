# Installs (or with -Uninstall removes) the scheduled task "VyX Caddy health": runs caddy-health-check.ps1 every
# 5 minutes as SYSTEM (same account as the VyxMarketDataBackup task). Idempotent: re-running replaces the task and the
# script copy. The script is copied to C:\vyxtrader\scripts so the task never depends on which commit the repo
# checkout is on. Run in an elevated PowerShell on the VPS from the repo root.
param([switch]$Uninstall, [string]$Source = "$PSScriptRoot\caddy-health-check.ps1")
$ErrorActionPreference = "Stop"
$TaskName = "VyX Caddy health"
$Target = "C:\vyxtrader\scripts\caddy-health-check.ps1"

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "removed task '$TaskName'" }
  else { "task '$TaskName' was not installed" }
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force; "removed $Target" }
  return
}

if (-not (Test-Path -LiteralPath $Source)) { throw "source script not found: $Source" }
New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
Copy-Item -LiteralPath $Source -Destination $Target -Force
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Target`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName $TaskName
"installed task '$TaskName' ($($t.State)): every 5 minutes as SYSTEM, runs $Target"
