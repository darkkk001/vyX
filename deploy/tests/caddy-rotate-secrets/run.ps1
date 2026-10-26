# Test of deploy/caddy-rotate-secrets-2026-09-28.ps1 on any Windows PC, no VPS: stub nssm (a .cmd), stub caddy (caddy.py),
# a stand-in feed + admin endpoint (server.py, which answers in Caddy's own key order), the registry under HKCU, a fake
# start-engine.cmd. Dummy values only. Exit 0 = every case as expected.
#   powershell -NoProfile -ExecutionPolicy Bypass -File deploy\tests\caddy-rotate-secrets\run.ps1
$ErrorActionPreference = "Stop"
$T = $PSScriptRoot
$W = Join-Path $T "work"
$src = Join-Path $T "..\..\caddy-rotate-secrets-2026-09-28.ps1"
$reg = "HKCU:\Software\VyxCaddyRotationTest\Parameters"
$port = 18099
$values = "aaaa1111", "bbbb2222", "cccc3333", "dddd4444"
if (Test-Path $W) { Remove-Item -Recurse -Force $W }
New-Item -ItemType Directory -Force $W | Out-Null
New-Item -Force $reg | Out-Null

Set-Content "$W\caddy.cmd" "@python `"$T\caddy.py`" %*" -Encoding ascii
Set-Content "$W\Caddyfile" @'
feed.example {
	@noread not header X-Market-Data-Secret {$MARKET_DATA_READ_SECRET} {$MARKET_DATA_READ_SECRET_PREVIOUS}
	reverse_proxy 127.0.0.1:8081 {
		header_up x-internal-secret {$INTERNAL_SERVICE_SECRET}
	}
}
'@ -Encoding ascii
Set-Content "$W\nssm.cmd" @"
@echo off
if "%3"=="Application" echo $W\caddy.cmd
if "%3"=="AppParameters" echo run --config $W\Caddyfile --adapter caddyfile
if "%3"=="AppDirectory" echo $W
"@ -Encoding ascii

# the script under test, pointed at the stubs (only these six constants change)
$s = Get-Content $src -Raw
foreach ($p in @(
  @('"C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"', "`"$W\nssm.cmd`""),
  @('"C:\vyxtrader\scripts\start-engine.cmd"', "`"$W\start-engine.cmd`""),
  @('"https://feed.vyxtrader.com"', "`"http://127.0.0.1:$port`""),
  @('"HKLM:\SYSTEM\CurrentControlSet\Services\$Service\Parameters"', "`"$reg`""),
  @('"http://127.0.0.1:2019/config/"', "`"http://127.0.0.1:$port/config/`""),
  @('"C:\vyxtrader\backup"', "`"$W\backup`""))) {
  if (-not $s.Contains($p[0])) { throw "the script no longer has $($p[0]); update this test" }
  $s = $s.Replace($p[0], $p[1])
}
Set-Content "$W\under-test.ps1" $s -Encoding utf8

function Engine($newI, $newR, $oldI, $oldR) {
  $l = @("@echo off", "set INTERNAL_SERVICE_SECRET=$newI", "set MARKET_DATA_READ_SECRET=$newR")
  if ($oldI) { $l += "set INTERNAL_SERVICE_SECRET_PREVIOUS=$oldI"; $l += "set MARKET_DATA_READ_SECRET_PREVIOUS=$oldR" }
  Set-Content "$W\start-engine.cmd" $l -Encoding ascii
}
function StoredEnv { ((Get-ItemProperty $reg).AppEnvironmentExtra) -join " | " }
$script:failed = 0
function Case([string]$name, [string]$phase, [int]$wantCode, [string]$wantEnv) {
  $ErrorActionPreference = "Continue"
  $out = & powershell -NoProfile -ExecutionPolicy Bypass -File "$W\under-test.ps1" -Phase $phase 2>&1 | ForEach-Object { "$_" }
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  $why = @()
  if ($code -ne $wantCode) { $why += "exit $code, want $wantCode" }
  if ($wantEnv -and (StoredEnv) -ne $wantEnv) { $why += "AppEnvironmentExtra is '$(StoredEnv)', want '$wantEnv'" }
  foreach ($v in $values) { if (($out -join "`n").Contains($v)) { $why += "a value was printed" } }
  if ($why) {
    $script:failed++
    Write-Host "FAIL  $name : $($why -join '; ')"
    $out | ForEach-Object { Write-Host "      $_" }
  } else { Write-Host "ok    $name" }
}

$srv = Start-Process python -ArgumentList "`"$T\server.py`" $port" -PassThru -WindowStyle Hidden
Start-Sleep 1
try {
  $old = "INTERNAL_SERVICE_SECRET=aaaa1111 | MARKET_DATA_READ_SECRET=bbbb2222 | MARKET_DATA_READ_SECRET_PREVIOUS=bbbb2222 | OTHER=keep"
  $overlap = "INTERNAL_SERVICE_SECRET=cccc3333 | MARKET_DATA_READ_SECRET=dddd4444 | MARKET_DATA_READ_SECRET_PREVIOUS=bbbb2222 | OTHER=keep"
  $finish = "INTERNAL_SERVICE_SECRET=cccc3333 | MARKET_DATA_READ_SECRET=dddd4444 | MARKET_DATA_READ_SECRET_PREVIOUS=dddd4444 | OTHER=keep"
  # today on the VPS: Caddy runs the OLD values from AppEnvironmentExtra; running = stored
  Set-ItemProperty $reg AppEnvironmentExtra -Type MultiString -Value ($old -split " \| ")
  Engine "aaaa1111" "bbbb2222" $null $null
  $env:MARKET_DATA_READ_SECRET = "bbbb2222"; $env:MARKET_DATA_READ_SECRET_PREVIOUS = "bbbb2222"; $env:INTERNAL_SERVICE_SECRET = "aaaa1111"
  & python "$T\caddy.py" reload --config "$W\Caddyfile" | Out-Null
  Remove-Item Env:MARKET_DATA_READ_SECRET, Env:MARKET_DATA_READ_SECRET_PREVIOUS, Env:INTERNAL_SERVICE_SECRET

  Case "verify: only the key order differs (Caddy's admin order) -> parity OK" "Verify" 0 $old
  New-Item "$W\swap-array.flag" | Out-Null
  Case "verify: the routes array order differs -> parity DIFFERENT" "Verify" 1 $old
  Remove-Item "$W\swap-array.flag"

  Engine "cccc3333" "dddd4444" "aaaa1111" "bbbb2222"   # the engine script's Overlap ran: NEW current, OLD as *_PREVIOUS
  $env:FAIL_RELOAD = "1"; Case "overlap: reload fails -> environment put back" "Overlap" 1 $old; Remove-Item Env:FAIL_RELOAD
  $env:IGNORE_PREV = "1"; Case "overlap: OLD read refused after reload -> rolled back" "Overlap" 1 $old; Remove-Item Env:IGNORE_PREV
  Case "overlap" "Overlap" 0 $overlap
  Case "finish" "Finish" 0 $finish
  Engine "cccc3333" "dddd4444" $null $null
  Case "verify after the rotation" "Verify" 0 $finish
  $drift = "INTERNAL_SERVICE_SECRET=cccc3333 | MARKET_DATA_READ_SECRET=bbbb2222 | MARKET_DATA_READ_SECRET_PREVIOUS=bbbb2222 | OTHER=keep"
  Set-ItemProperty $reg AppEnvironmentExtra -Type MultiString -Value ($drift -split " \| ")
  Case "verify: stored environment drifted from the running one -> DIFFERENT" "Verify" 1 $drift

  $markers = @(Get-ChildItem "$W\backup" -Filter *.done -ErrorAction SilentlyContinue).Count
  if ($markers -ne 2) { $script:failed++; Write-Host "FAIL  markers: $markers, want 2 (Overlap + Finish)" } else { Write-Host "ok    markers: Overlap + Finish" }
  $left = @("INTERNAL_SERVICE_SECRET", "MARKET_DATA_READ_SECRET", "MARKET_DATA_READ_SECRET_PREVIOUS" | Where-Object { Test-Path "Env:$_" })
  if ($left) { $script:failed++; Write-Host "FAIL  values left in this shell: $($left -join ', ')" }
} finally {
  Stop-Process -Id $srv.Id -Force -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force "HKCU:\Software\VyxCaddyRotationTest" -ErrorAction SilentlyContinue
}
if ($script:failed) { Write-Host "$($script:failed) FAILED"; exit 1 }
Write-Host "ALL OK"
exit 0
