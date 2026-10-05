# Installs (or with -Uninstall removes) the scheduled task "VyX Caddy health": runs caddy-health-check.ps1 every
# 5 minutes as SYSTEM (same account as the VyxMarketDataBackup task). Idempotent: re-running replaces the task and the
# script copy. The script is copied to C:\vyxtrader\scripts so the task never depends on which commit the repo
# checkout is on. Run in an elevated PowerShell on the VPS.
# The check script is taken from -Source if given, else from next to this installer, else the copy already in
# C:\vyxtrader\scripts is used as is (the runbook's block puts it there with `git show`; fixed 2026-10-05: the first
# version only looked next to itself and failed when the installer was run from %TEMP%).
param([switch]$Uninstall, [string]$Source = "")
$ErrorActionPreference = "Stop"
$TaskName = "VyX Caddy health"
$Target = "C:\vyxtrader\scripts\caddy-health-check.ps1"
if (-not $Source) {
  $beside = if ($PSScriptRoot) { Join-Path $PSScriptRoot "caddy-health-check.ps1" } else { "" }
  $Source = if ($beside -and (Test-Path -LiteralPath $beside)) { $beside } else { $Target }
}

if ($Uninstall) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false; "removed task '$TaskName'" }
  else { "task '$TaskName' was not installed" }
  if (Test-Path -LiteralPath $Target) { Remove-Item -LiteralPath $Target -Force; "removed $Target" }
  return
}

if (-not (Test-Path -LiteralPath $Source)) { throw "check script not found: $Source (put caddy-health-check.ps1 in C:\vyxtrader\scripts or pass -Source)" }
New-Item -ItemType Directory -Force (Split-Path $Target) | Out-Null
if ((Resolve-Path -LiteralPath $Source).Path -ne [IO.Path]::GetFullPath($Target)) { Copy-Item -LiteralPath $Source -Destination $Target -Force; "copied $Source -> $Target" }
else { "using $Target as is" }
$action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$Target`""
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -StartWhenAvailable
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
$t = Get-ScheduledTask -TaskName $TaskName
"installed task '$TaskName' ($($t.State)): every 5 minutes as SYSTEM, runs $Target"
