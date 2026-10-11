# Run ON THE VPS (elevated PowerShell). Read-only for everything that exists: it only reads service settings, config
# files and scheduled tasks, and writes one new folder + zip under C:\vyxtrader\backup. The output contains secrets
# (nssm environment, start scripts): copy the zip to C:\vyx-backup-inbox\ on the backup PC, where
# scripts/backup-platform.ps1 puts it inside the encrypted archive, then delete it from the VPS.

$ErrorActionPreference = "Continue"
$Nssm = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$stamp = Get-Date -Format "yyyy-MM-dd"
$out = "C:\vyxtrader\backup\vps-config-$stamp"
New-Item -ItemType Directory -Force $out | Out-Null

# 1. nssm services
$services = @(Get-Service -Name "vyxtrader-*" -ErrorAction SilentlyContinue | ForEach-Object Name)
$params = "Application", "AppDirectory", "AppParameters", "AppEnvironmentExtra", "AppStdout", "AppStderr", "AppRotateFiles",
    "AppExit", "AppRestartDelay", "AppStopMethodConsole", "Start", "ObjectName", "DependOnService", "DisplayName", "Description"
foreach ($s in $services) {
    $lines = foreach ($p in $params) { "$p = " + ((& $Nssm get $s $p 2>$null) -join " | ") }
    $lines += ""; $lines += (sc.exe qc $s); $lines += (sc.exe qfailure $s)
    $lines | Set-Content (Join-Path $out "nssm-$s.txt") -Encoding UTF8
}

# 2. Caddyfile (path taken from the caddy service's own --config argument, plus the usual places)
$caddyArgs = (& $Nssm get vyxtrader-caddy AppParameters 2>$null) -join " "
$cfg = @()
if ($caddyArgs -match '--config\s+"?([^"\s]+)') { $cfg += $Matches[1] }
$cfg += "C:\caddy\Caddyfile", "C:\vyxtrader\caddy\Caddyfile"
$appDir = (& $Nssm get vyxtrader-caddy AppDirectory 2>$null) -join ""
foreach ($c in ($cfg | Select-Object -Unique)) {
    $full = if ([IO.Path]::IsPathRooted($c)) { $c } elseif ($appDir) { Join-Path $appDir $c } else { $c }
    if (Test-Path -LiteralPath $full) { Copy-Item -LiteralPath $full (Join-Path $out ("Caddyfile-from-" + ($full -replace '[:\\]', '_'))) }
}

# 3. start scripts and health script
Get-ChildItem "C:\vyxtrader\scripts" -File -Include *.cmd, *.ps1, *.bat -Recurse -ErrorAction SilentlyContinue |
    ForEach-Object { New-Item -ItemType Directory -Force (Join-Path $out "scripts") | Out-Null; Copy-Item $_.FullName (Join-Path $out "scripts") }

# 4. scheduled tasks (caddy health, MT5 feed autostart, anything VyX)
New-Item -ItemType Directory -Force (Join-Path $out "tasks") | Out-Null
Get-ScheduledTask | Where-Object { $_.TaskName -match 'vyx|caddy|mt5|feed|backup' -or $_.TaskPath -match 'vyx' } | ForEach-Object {
    Export-ScheduledTask -TaskName $_.TaskName -TaskPath $_.TaskPath |
        Set-Content (Join-Path $out ("tasks\" + ($_.TaskName -replace '[^\w.-]', '_') + ".xml")) -Encoding Unicode
}

# 5. what is deployed
@(
    "repo HEAD: " + ((git -C C:\vyxtrader\repo log -1 --format="%H %cs %s" 2>$null) -join "")
    "repo status:"; (git -C C:\vyxtrader\repo status --short 2>$null)
    ""; "services:"; (Get-Service -Name "vyxtrader-*" | Format-Table Name, Status, StartType -AutoSize | Out-String)
    ""; "binaries:"; (Get-ChildItem C:\vyxtrader\repo\engine\target\release\*.exe -ErrorAction SilentlyContinue | ForEach-Object { "$($_.Name) $($_.LastWriteTime) $((Get-FileHash $_.FullName).Hash)" })
) | Set-Content (Join-Path $out "deployed.txt") -Encoding UTF8

Compress-Archive -Path "$out\*" -DestinationPath "$out.zip" -Force
Remove-Item -Recurse -Force $out
"wrote $out.zip ($([math]::Round((Get-Item "$out.zip").Length / 1KB)) KB): copy it to C:\vyx-backup-inbox\ on the backup PC, then delete it here"
