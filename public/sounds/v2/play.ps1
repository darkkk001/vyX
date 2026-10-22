# Sounds v2 audition: plays every WAV in this folder in order, printing its name first.
#   .\play.ps1            play all
#   .\play.ps1 tp         play only files whose name contains "tp"
#   .\play.ps1 -Loop      repeat the whole list until Ctrl+C
param([string]$Filter = "", [switch]$Loop, [int]$PauseMs = 900)

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$labels = @{}
Import-Csv (Join-Path $dir "manifest.csv") | ForEach-Object { $labels[$_.file] = "$($_.event) ($($_.duration_ms) ms)" }
$files = Get-ChildItem $dir -Filter *.wav | Sort-Object Name | Where-Object { $_.Name -like "*$Filter*" }
if (-not $files) { Write-Host "No sound matches '$Filter'."; exit 1 }

do {
    foreach ($f in $files) {
        Write-Host ("{0,-22} {1}" -f $f.BaseName, $labels[$f.Name])
        $p = New-Object System.Media.SoundPlayer $f.FullName
        $p.PlaySync()
        $p.Dispose()
        Start-Sleep -Milliseconds $PauseMs
    }
} while ($Loop)
