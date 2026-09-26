# One-shot reset of the MT5 -> engine price feed on the VPS, with its own verification.
#
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\mt5-ea\deploy\feed-reset.ps1 -CheckOnly   # diagnose only
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\mt5-ea\deploy\feed-reset.ps1              # fix + verify
#
# Run it over RDP as the Windows user MT5 runs as. The engine expects DIRECT mode: the EA POSTs ticks to
# http://127.0.0.1:8081/internal/price-feed and history to /internal/history on the same box. In PROXY mode
# (UseDirectMode=false or DirectServerUrl empty) ticks go to Vercel's /api/internal/price-feed instead, which
# forwards them to its own TRADING_CORE_URL -- not this box's engine, whose port is not public -- so ticks_in
# here stays 0; and every history backfill returns without sending anything (history is direct-mode only).
#
# Steps (the fix run stops MT5 first and starts it again at the end):
#   1. engine: /health on 127.0.0.1:8081, which process owns the port, how old its build is
#   2. secrets: PRICE_FEED_SECRET / INTERNAL_SERVICE_SECRET from start-engine.cmd (never printed); the price-feed
#      secret is proven against the engine itself (an empty POST must answer 400 "no valid ticks", not 401)
#   3. secret file for EA v1.42+ (%APPDATA%\MetaQuotes\Terminal\Common\Files\vyx_secret.txt)
#   4. profile VyXFeed: exactly ONE chart keeps the EA; its inputs are set to UseDirectMode=true,
#      DirectServerUrl=http://127.0.0.1:8081, ApiSecret empty, backfill flags off (backup taken first)
#   5. MT5 allowed-URL list must contain http://127.0.0.1:8081 (checked; one UI step if missing)
#   6. start MT5 (the "VyX MT5 price feed" task, else the launcher), then for up to 2 minutes: ticks_in on the
#      engine must climb, and the EA log is scanned for the lines that explain any failure

param(
    [switch] $CheckOnly,
    [string] $Mt5Dir = "C:\MT5-Pepperstone",
    [string] $EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd",
    [string] $Profile = "VyXFeed",
    [string] $EngineUrl = "http://127.0.0.1:8081",
    [string] $TaskName = "VyX MT5 price feed"
)
$ErrorActionPreference = "Stop"
$fail = 0
function Ok($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Bad($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:fail++ }
function Note($m) { Write-Host "  ..   $m" -ForegroundColor Yellow }
function Step($m) { Write-Host "`n== $m" -ForegroundColor Cyan }

function Read-CmdVar([string] $name) {
    $m = Select-String -Path $EngineCmd -Pattern "^\s*set\s+`"?$name=([^`"\r\n]+)`"?\s*$" | Select-Object -First 1
    if (-not $m) { return $null }
    return $m.Matches[0].Groups[1].Value.Trim()
}

# ---------------------------------------------------------------- 1. engine
Step "1. engine on $EngineUrl"
try { $h = Invoke-WebRequest "$EngineUrl/health" -UseBasicParsing -TimeoutSec 5; if ($h.StatusCode -eq 200) { Ok "/health 200" } else { Bad "/health $($h.StatusCode)" } }
catch { Bad "/health unreachable: $($_.Exception.Message) -- start the engine service (C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe start vyxtrader-engine) and rerun"; exit 1 }
$port = $EngineUrl -replace '.*:(\d+).*', '$1'
$owners = @(Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue } | Sort-Object Id -Unique)
foreach ($p in $owners) { Note "port $port owned by $($p.ProcessName) pid $($p.Id) started $($p.StartTime) ($($p.Path))" }
$engines = @(Get-Process trading-core-server -ErrorAction SilentlyContinue)
if ($engines.Count -gt 1) { Bad "$($engines.Count) trading-core-server processes are running -- only the nssm service should be" } else { Ok "$($engines.Count) engine process" }
foreach ($p in $engines) {
    $built = (Get-Item $p.Path).LastWriteTime
    if ($built -lt [datetime]'2026-09-08') { Bad "engine build $built predates 2026-09-08: it does not store M15 history (answers 200 + upserted 0) -- deploy main (deep-backfill runbook section 2)" }
    else { Ok "engine build $built" }
}

# ---------------------------------------------------------------- 2. secrets, proven against the engine
Step "2. secrets from $EngineCmd"
$feedSecret = Read-CmdVar "PRICE_FEED_SECRET"
$internalSecret = Read-CmdVar "INTERNAL_SERVICE_SECRET"
if (-not $feedSecret) { Bad "PRICE_FEED_SECRET not found in $EngineCmd"; exit 1 }
if (-not $internalSecret) { Bad "INTERNAL_SERVICE_SECRET not found in $EngineCmd"; exit 1 }
Ok "PRICE_FEED_SECRET $($feedSecret.Length) chars, INTERNAL_SERVICE_SECRET $($internalSecret.Length) chars (values not shown)"
# an empty batch is refused AFTER the secret check: 400 = secret accepted, 401 = the running engine uses another one
try {
    Invoke-WebRequest "$EngineUrl/internal/price-feed" -Method Post -UseBasicParsing -TimeoutSec 5 -ContentType "application/json" -Body "[]" -Headers @{ "x-price-feed-secret" = $feedSecret } | Out-Null
    Note "empty price-feed POST was accepted (unexpected, harmless)"
} catch {
    $code = [int]$_.Exception.Response.StatusCode
    if ($code -eq 400) { Ok "the engine accepts this PRICE_FEED_SECRET (empty batch -> 400 no valid ticks)" }
    elseif ($code -eq 401) { Bad "the RUNNING engine rejects PRICE_FEED_SECRET from $EngineCmd (401): it was started with another value -- C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe restart vyxtrader-engine, then rerun"; exit 1 }
    else { Bad "price-feed probe answered $code" }
}
function Get-Stats { Invoke-RestMethod "$EngineUrl/internal/feed-stats" -Headers @{ "x-internal-secret" = $internalSecret } -TimeoutSec 5 }
try { $s0 = Get-Stats; Ok "feed-stats readable: ticks_in=$($s0.ticks_in) broker_bars_applied_total=$($s0.broker_bars_applied_total) symbols=$(@($s0.per_symbol).Count)" }
catch { Bad "feed-stats: $($_.Exception.Message)"; exit 1 }

# ---------------------------------------------------------------- 3. secret file
Step "3. secret file for the EA"
$secretFile = Join-Path $env:APPDATA "MetaQuotes\Terminal\Common\Files\vyx_secret.txt"
$current = if (Test-Path $secretFile) { [IO.File]::ReadAllText($secretFile).Trim() } else { "" }
if ($current -eq $feedSecret) { Ok "$secretFile matches the engine" }
elseif ($CheckOnly) { Bad "$secretFile missing or different from the engine's PRICE_FEED_SECRET" }
else {
    New-Item -ItemType Directory -Force (Split-Path $secretFile) | Out-Null
    [IO.File]::WriteAllText($secretFile, $feedSecret, [Text.Encoding]::ASCII)
    Ok "$secretFile written ($($feedSecret.Length) chars)"
}

# ---------------------------------------------------------------- 4. stop MT5, one chart, direct-mode inputs
Step "4. profile '$Profile'"
$terminal = Join-Path $Mt5Dir "terminal64.exe"
$profileDir = Join-Path $Mt5Dir "MQL5\Profiles\Charts\$Profile"
if (-not (Test-Path $profileDir)) { Bad "no profile $profileDir -- in MT5: keep one XAUUSD M1 chart with the EA, File > Profiles > Save As '$Profile', rerun"; exit 1 }
$running = @(Get-Process terminal64 -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $terminal })
if (-not $CheckOnly -and $running.Count -gt 0) {
    Note "closing MT5 so it saves nothing over the profile while it is edited"
    foreach ($p in $running) { [void]$p.CloseMainWindow() }
    $deadline = (Get-Date).AddSeconds(30)
    while ((Get-Process -Id ($running.Id) -ErrorAction SilentlyContinue) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
    Get-Process -Id ($running.Id) -ErrorAction SilentlyContinue | Stop-Process -Force
    Ok "MT5 stopped"
}
$chr = @(Get-ChildItem $profileDir -Filter *.chr | Where-Object { Select-String -Path $_.FullName -Pattern '^name=VyXTraderPriceFeed\s*$' -Quiet })
if ($chr.Count -eq 0) { Bad "no chart in '$Profile' carries VyXTraderPriceFeed -- attach it to the XAUUSD chart, save the profile, rerun"; exit 1 }
$keep = ($chr | Where-Object { Select-String -Path $_.FullName -Pattern '^symbol=XAUUSD\s*$' -Quiet } | Select-Object -First 1)
if (-not $keep) { $keep = $chr[0] }
$extra = @($chr | Where-Object { $_.FullName -ne $keep.FullName })
$want = [ordered]@{ UseDirectMode = "true"; DirectServerUrl = "$EngineUrl"; ApiSecret = ""; ForceDeepBackfill = "false"; DeepBackfillFullHistory = "false"; DeepBackfillSymbols = ""; DeepBackfillTimeframes = "" }
$text = [IO.File]::ReadAllText($keep.FullName)   # .chr files are UTF-16 with a BOM; ReadAllText detects it
$diffs = @()
foreach ($k in $want.Keys) {
    $m = [regex]::Match($text, "(?m)^$k=(.*?)\r?$")
    $have = if ($m.Success) { $m.Groups[1].Value } else { "<not saved>" }
    if ($have -ne $want[$k]) { $diffs += "$k is '$(if ($k -eq 'ApiSecret' -and $have -ne '<not saved>') { "<$($have.Length) chars>" } else { $have })', needs '$($want[$k])'" }
}
if ($extra.Count -gt 0) { $diffs += "$($extra.Count) more chart(s) carry the EA: $(($extra | ForEach-Object Name) -join ', ')" }
if ($diffs.Count -eq 0) { Ok "one EA chart ($($keep.Name)), direct mode to $EngineUrl, no saved secret, backfill flags off" }
elseif ($CheckOnly) { foreach ($d in $diffs) { Bad $d } }
else {
    $backup = Join-Path $Mt5Dir "config\profile-backup-$Profile-$(Get-Date -Format yyyyMMdd-HHmmss)"
    Copy-Item $profileDir $backup -Recurse
    Note "profile backed up to $backup"
    foreach ($d in $diffs) { Note "fixing: $d" }
    foreach ($k in $want.Keys) {
        $line = "$k=$($want[$k])"
        if ([regex]::IsMatch($text, "(?m)^$k=.*?\r?$")) { $text = [regex]::Replace($text, "(?m)^$k=.*?(\r?)$", { param($mm) $line + $mm.Groups[1].Value }) }
        else { $text = $text -replace '(?m)^</inputs>', "$line`r`n</inputs>" }
    }
    [IO.File]::WriteAllText($keep.FullName, $text, [Text.Encoding]::Unicode)
    foreach ($e in $extra) { Remove-Item $e.FullName -Force }
    Ok "profile fixed: one EA chart ($($keep.Name)) in direct mode"
}

# ---------------------------------------------------------------- 5. allowed WebRequest URL
Step "5. MT5 allowed WebRequest URLs"
$allowed = Get-ChildItem (Join-Path $Mt5Dir "config") -Filter *.ini -ErrorAction SilentlyContinue | Where-Object { Select-String -Path $_.FullName -Pattern ([regex]::Escape(($EngineUrl -replace '^https?://', ''))) -Quiet }
if ($allowed) { Ok "$EngineUrl found in $(($allowed | ForEach-Object Name) -join ', ')" }
else { Note "$EngineUrl not found in MT5's config -- if step 6 reports error 4060: Tools > Options > Expert Advisors > tick 'Allow WebRequest for listed URL' and add $EngineUrl" }

if ($CheckOnly) {
    Step "check only: $fail problem(s) found; run without -CheckOnly to fix them"
    exit $fail
}

# ---------------------------------------------------------------- 6. start MT5 and prove ticks arrive
Step "6. start MT5 and watch the engine"
$logFile = Join-Path $Mt5Dir "MQL5\Logs\$(Get-Date -Format yyyyMMdd).log"
$logStart = if (Test-Path $logFile) { (Get-Content $logFile).Count } else { 0 }
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) { Start-ScheduledTask -TaskName $TaskName; Note "started task '$TaskName'" }
else { Start-Process -FilePath $terminal -ArgumentList '/portable', "/profile:$Profile" -WorkingDirectory $Mt5Dir; Note "started MT5 directly (no task)" }
$before = (Get-Stats).ticks_in
$passed = $false
for ($i = 1; $i -le 12; $i++) {
    Start-Sleep 10
    $s = Get-Stats
    Write-Host ("  t+{0,3}s ticks_in={1} broker_bars_applied={2} symbols={3}" -f ($i * 10), $s.ticks_in, $s.broker_bars_applied_total, @($s.per_symbol).Count)
    if ($s.ticks_in -gt $before -and $i -ge 3) { $passed = $true; break }
}
$fresh = if (Test-Path $logFile) { Get-Content $logFile | Select-Object -Skip $logStart } else { @() }
$keyLines = $fresh | Select-String 'secret loaded|another instance|history backfill on init|\(direct\)|NOT connected|4060|ENGINE SKIPPED|no secret|server responded|WebRequest failed'
Write-Host "`n  EA log since start:"; $keyLines | Select-Object -Last 12 | ForEach-Object { Write-Host "    $($_.Line)" }
if ($passed) { Ok "ticks_in is climbing: the engine receives live ticks from the EA" }
else {
    Bad "ticks_in did not move in 2 minutes"
    if ($fresh | Select-String '4060') { Note "cause: $EngineUrl is not in MT5's allowed WebRequest URLs (Tools > Options > Expert Advisors)" }
    elseif ($fresh | Select-String '\(direct\): server responded 401') { Note "cause: the engine rejects the EA's secret -- vyx_secret.txt and the running engine disagree (rerun this script)" }
    elseif ($fresh | Select-String 'server responded|WebRequest failed') { Note "cause: pushes are failing -- see the EA lines above" }
    elseif ($fresh | Select-String 'NOT connected') { Note "cause: MT5 is not logged in to the broker (Journal: 'authorized on ...')" }
    elseif ($fresh | Select-String 'another instance') { Note "cause: a second EA instance still holds the feed -- close every chart but the one in '$Profile'" }
    elseif (-not ($fresh | Select-String 'secret loaded')) { Note "cause: the EA never initialised -- is it attached (smiley top-right of the chart) and is Algo Trading on?" }
}
Step "done: $fail problem(s)"
exit $fail
