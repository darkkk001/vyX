# VPS: make the Pepperstone MT5 price feed come back on its own after a reboot (EA v1.42+).
#
# Run ONCE on the Contabo box, in an elevated PowerShell, AS THE WINDOWS USER MT5 SHOULD RUN AS (the secret
# file lives in that user's %APPDATA%; a task running as another user would not find it):
#
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\mt5-ea\deploy\vps-autostart.ps1
#
# What it does (each step is idempotent; re-running just rewrites the same files / task):
#   1. writes the price-feed secret to %APPDATA%\MetaQuotes\Terminal\Common\Files\vyx_secret.txt, read from
#      the engine's own start-engine.cmd (PRICE_FEED_SECRET), so the EA and the engine can never disagree.
#      The value is never printed; only its length.
#   2. writes <MT5>\config\vyx-startup.ini: MT5's own startup config, which opens an XAUUSD M1 chart and
#      attaches VyXTraderPriceFeed with the preset MQL5\Presets\VyXTraderPriceFeed.set on every launch.
#   3. registers the scheduled task "VyX MT5 price feed": at system startup (+60 s for the network),
#      terminal64.exe /portable /config:<ini>, run whether the user is logged on or not, restart on failure.
#
# Before running it: in MT5, EA Properties > Inputs, clear ApiSecret (v1.42 then reads the file), make sure
# ForceDeepBackfill / DeepBackfillFullHistory are false, and Save the inputs as
# MQL5\Presets\VyXTraderPriceFeed.set (the button on the Inputs tab). The preset must NOT hold the secret.

param(
    [string] $Mt5Dir = "C:\MT5-Pepperstone",
    [string] $EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd",
    [string] $ChartSymbol = "XAUUSD",
    [string] $TaskName = "VyX MT5 price feed"
)
$ErrorActionPreference = "Stop"

# 1) secret file
$line = Select-String -Path $EngineCmd -Pattern '^\s*set\s+"?PRICE_FEED_SECRET=([^"\r\n]+)"?\s*$' | Select-Object -First 1
if (-not $line) { throw "PRICE_FEED_SECRET not found in $EngineCmd" }
$secret = $line.Matches[0].Groups[1].Value.Trim()
if ($secret.Length -lt 8) { throw "PRICE_FEED_SECRET in $EngineCmd looks wrong (length $($secret.Length))" }
$commonFiles = Join-Path $env:APPDATA "MetaQuotes\Terminal\Common\Files"
New-Item -ItemType Directory -Force $commonFiles | Out-Null
$secretFile = Join-Path $commonFiles "vyx_secret.txt"
# plain ASCII, no BOM, no newline: the EA reads it with FILE_ANSI (PowerShell 5's default encodings would not do)
[System.IO.File]::WriteAllText($secretFile, $secret, [System.Text.Encoding]::ASCII)
# only this user (and SYSTEM / Administrators) may read it
icacls $secretFile /inheritance:r /grant:r "$($env:USERNAME):(R,W)" "SYSTEM:(F)" "Administrators:(F)" | Out-Null
Write-Output "1) secret file: $secretFile ($($secret.Length) chars, ACL restricted)"

# 2) MT5 startup config
$terminal = Join-Path $Mt5Dir "terminal64.exe"
if (-not (Test-Path $terminal)) { throw "no terminal64.exe in $Mt5Dir" }
$preset = Join-Path $Mt5Dir "MQL5\Presets\VyXTraderPriceFeed.set"
if (-not (Test-Path $preset)) { throw "missing $preset -- save the EA's Inputs (ApiSecret EMPTY) as that preset first" }
if (Select-String -Path $preset -Pattern '^ApiSecret=.+' -Quiet) { throw "$preset carries an ApiSecret value -- clear it in the Inputs tab and save the preset again" }
if (Select-String -Path $preset -Pattern '^(ForceDeepBackfill|DeepBackfillFullHistory)=(true|1)' -Quiet) { throw "$preset has a deep-backfill flag ON -- every reboot would re-run the pass; set both false and save again" }
New-Item -ItemType Directory -Force (Join-Path $Mt5Dir "config") | Out-Null
$ini = Join-Path $Mt5Dir "config\vyx-startup.ini"
@"
[StartUp]
Expert=VyXTraderPriceFeed
ExpertParameters=VyXTraderPriceFeed.set
Symbol=$ChartSymbol
Period=M1
"@ | Set-Content -Path $ini -Encoding ASCII
Write-Output "2) startup config: $ini"

# 3) scheduled task
$cred = Get-Credential -UserName "$env:USERDOMAIN\$env:USERNAME" -Message "Windows password for $env:USERNAME (the task runs as this user, logged on or not)"
$action = New-ScheduledTaskAction -Execute $terminal -Argument "/portable /config:`"$ini`"" -WorkingDirectory $Mt5Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = "PT60S"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -RestartCount 5 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -User $cred.UserName -Password $cred.GetNetworkCredential().Password -RunLevel Highest -Force | Out-Null
Write-Output "3) scheduled task '$TaskName': at startup +60s -> $terminal /portable /config:$ini"
Write-Output "Done. Test it: close MT5, then  Start-ScheduledTask -TaskName '$TaskName'  and watch feed-stats ticks_in climb."
