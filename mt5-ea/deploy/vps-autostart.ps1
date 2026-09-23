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
#   3. registers the scheduled task "VyX MT5 price feed": AT LOG ON of this user (+30 s for the network), in
#      that user's own interactive session, so MT5 is on the desktop you see over RDP and its inputs can be
#      changed there. A reboot comes back unattended because Windows auto-logon (Sysinternals Autologon)
#      signs this user in; the script checks that auto-logon is on for this user and says so if not.
#      The task runs <MT5>\config\vyx-launch.ps1, which starts terminal64.exe /portable /config:<ini> ONLY if
#      that exact terminal64.exe is not already running: an RDP connection that opens a new session is also a
#      "log on" and must not start a second MT5 on the same portable folder.
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

# 3) auto-logon check: "at log on" only brings MT5 back after a reboot if Windows signs this user in by itself
$winlogon = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon"
$autoOn = "$($winlogon.AutoAdminLogon)" -eq "1"
$autoUser = "$($winlogon.DefaultUserName)"
if (-not $autoOn) {
    Write-Warning "Windows auto-logon is OFF: after a reboot MT5 starts only when someone logs in. Run Sysinternals Autologon (autologon64.exe) for $env:USERNAME, then re-run this script."
} elseif ($autoUser -ne $env:USERNAME) {
    Write-Warning "Windows auto-logon signs in '$autoUser', not '$env:USERNAME': this task (and the secret file) belong to $env:USERNAME. Point Autologon at $env:USERNAME, or run this script as $autoUser."
} else {
    Write-Output "3) auto-logon: ON for $autoUser"
}

# 4) launcher: start this MT5 only if that exact terminal64.exe is not running already (an RDP login that opens
#    a new session is also a "log on"; two MT5s on one portable folder fight over its files)
$launcher = Join-Path $Mt5Dir "config\vyx-launch.ps1"
@"
`$exe = '$terminal'
`$running = Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { `$_.Path -eq `$exe }
if (`$running) { exit 0 }
Start-Process -FilePath `$exe -ArgumentList '/portable','/config:"$ini"' -WorkingDirectory '$Mt5Dir'
"@ | Set-Content -Path $launcher -Encoding ASCII
Write-Output "4) launcher: $launcher"

# 5) scheduled task: at THIS user's log on, in their interactive session (visible over RDP), no stored password
$me = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$launcher`"" -WorkingDirectory $Mt5Dir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $me
$trigger.Delay = "PT30S"
$principal = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null
Write-Output "5) scheduled task '$TaskName': at log on of $me (+30s) -> $launcher"
Write-Output "Done. Test it: close MT5, then  Start-ScheduledTask -TaskName '$TaskName'  -- MT5 opens on this desktop, and feed-stats ticks_in climbs."
