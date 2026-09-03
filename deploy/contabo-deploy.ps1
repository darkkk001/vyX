<#
.SYNOPSIS
    Deploys fix/tick-path-hardening (commit 1c556fc) to the Contabo box
    running vyxtrader-engine / vyxtrader-gateway.

.DESCRIPTION
    Implements deploy-runbook steps 1 (backup), 2 (checkout), 3 (build
    engine), 4 (build gateway), 5 (env edits to start-*.cmd), 6 (restart
    + verify), and 8 (poll /internal/feed-stats and print a table).

    Step 7 (recompiling and re-attaching the MT5 EA in MetaEditor) has no
    CLI and is NOT automated here -- a checklist is printed at the end
    instead.

    Stops and rolls back automatically on any failure through step 6:
    before step 6 actually restarts a service, nothing running has been
    touched (a failed build/env-edit just leaves the old binaries in
    place and the old processes serving traffic), so "stop" alone is
    enough -- the repo checkout is reverted for hygiene but no service is
    touched. From step 6 onward, a failure triggers the full rollback
    (stop both, restore the backed-up exe + start-*.cmd, revert the repo,
    restart on the old build).

    Step 8 is observational only and does NOT roll back on its own --
    there's no single automatable "good"/"bad" threshold for feed health
    that's safe to act on unattended against a live trading price feed. A
    human reads the printed table and decides.

.NOTES
    Run elevated -- nssm start/stop/restart need it.
    Run from any directory; every path used is absolute.

.PARAMETER EngineLogPath
    Optional. This script doesn't know where NSSM is configured to write
    the engine's stdout/stderr on this box, so the "listening on
    127.0.0.1:8081" log-line check and the log-spam (lines/minute)
    comparison are both skipped unless this is supplied. The HTTP health
    check (Step 6) is the authoritative readiness gate either way and
    always runs regardless of this parameter.
#>

[CmdletBinding()]
param(
    [string]$RepoDir          = "C:\vyxtrader\repo",
    [string]$BackupDir        = "C:\vyxtrader\backup",
    [string]$ScriptsDir       = "C:\vyxtrader\scripts",
    [string]$EngineService    = "vyxtrader-engine",
    [string]$GatewayService   = "vyxtrader-gateway",
    [string]$TargetBranch     = "fix/tick-path-hardening",
    [string]$TargetCommit     = "1c556fc",
    [string]$RollbackRef      = "feat/vyxtrader-platform-setup",
    [string]$RollbackExeName  = "trading-core-server.7475312.exe",
    [string]$EngineLogPath    = "",
    [int]$PollIntervalSec     = 10,
    [int]$PollDurationSec     = 120
)

$ErrorActionPreference = "Stop"

# ---- admin check ----------------------------------------------------------
$currentPrincipal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $currentPrincipal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Write-Host "[FAIL] Run this script elevated (Administrator) -- nssm start/stop/restart require it." -ForegroundColor Red
    exit 1
}

# ---- derived paths ----------------------------------------------------------
$EngineExe          = Join-Path $RepoDir "engine\target\release\trading-core-server.exe"
$StartEngine        = Join-Path $ScriptsDir "start-engine.cmd"
$StartGateway       = Join-Path $ScriptsDir "start-gateway.cmd"
$BackupExe          = Join-Path $BackupDir $RollbackExeName
$BackupStartEngine  = Join-Path $BackupDir "start-engine.cmd"
$BackupStartGateway = Join-Path $BackupDir "start-gateway.cmd"

# ---- small helpers ----------------------------------------------------------
function Write-StepHeader($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Write-Ok($msg)         { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)       { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)       { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# Redacts the value half of any `set SOMETHING_SECRET=...` style line for
# display only -- the real file on disk keeps the real value, this is
# purely so this script's own console output (and anything piped from it
# into a log) doesn't leak secrets.
function Get-RedactedLines([string[]]$lines) {
    $lines | ForEach-Object {
        # Match on the VARIABLE NAME, not the value: anything whose name
        # carries SECRET / URL / KEY / TOKEN / PASSWORD. The old pattern
        # only caught *SECRET*, so DATABASE_URL and REDIS_URL -- which
        # carry credentials inline -- were printed in full under a header
        # that claimed "secrets redacted". Deliberately over-broad: it also
        # redacts harmless ones like NATS_URL/TRADING_CORE_URL, which is
        # the right trade when the output gets pasted into chats and logs.
        if ($_ -match '^(?<prefix>\s*set\s+[^=]*(SECRET|URL|KEY|TOKEN|PASSWORD)[^=]*=)(?<val>.+)$') {
            "$($Matches.prefix)***REDACTED***"
        } else {
            $_
        }
    }
}

function Get-LogLineCount([string]$path) {
    if ($path -and (Test-Path $path)) {
        return (Get-Content $path | Measure-Object -Line).Lines
    }
    return $null
}

# True only once Step 6 has actually stopped/restarted a service -- see
# the module doc comment above for why everything before that point can
# fail-and-stop without a service-level rollback.
$script:ServicesTouched = $false

function Invoke-FullRollback([string]$reason) {
    Write-Fail "ROLLING BACK: $reason"
    try {
        if ($script:ServicesTouched) {
            Write-Host "Stopping both services..."
            & nssm stop $GatewayService 2>&1 | Write-Host
            & nssm stop $EngineService 2>&1 | Write-Host

            if (Test-Path $BackupExe) {
                Copy-Item -Force $BackupExe $EngineExe
                Write-Ok "Restored engine exe from $BackupExe"
            } else {
                Write-Fail "Backup exe not found at $BackupExe -- engine exe NOT restored, manual intervention required"
            }
            if (Test-Path $BackupStartEngine)  { Copy-Item -Force $BackupStartEngine $StartEngine;  Write-Ok "Restored start-engine.cmd" }
            else { Write-Fail "Backup start-engine.cmd not found at $BackupStartEngine -- NOT restored" }
            if (Test-Path $BackupStartGateway) { Copy-Item -Force $BackupStartGateway $StartGateway; Write-Ok "Restored start-gateway.cmd" }
            else { Write-Fail "Backup start-gateway.cmd not found at $BackupStartGateway -- NOT restored" }
        }

        if (Test-Path $RepoDir) {
            Push-Location $RepoDir
            git checkout $RollbackRef 2>&1 | Write-Host
            Pop-Location
            Write-Ok "Repo reverted to $RollbackRef"
        }

        if ($script:ServicesTouched) {
            Write-Host "Restarting engine, then gateway, on the restored build..."
            & nssm start $EngineService 2>&1 | Write-Host
            Start-Sleep -Seconds 3
            & nssm start $GatewayService 2>&1 | Write-Host
            Write-Warn "Both services restarted on the pre-deploy build. This script does NOT re-verify health after a rollback restart -- check manually."
        }
    } catch {
        Write-Fail "Rollback itself failed: $($_.Exception.Message)"
        Write-Fail "MANUAL INTERVENTION REQUIRED. Backup exe: $BackupExe -- Backup cmds: $BackupDir -- Rollback git ref: $RollbackRef"
    }
    exit 1
}

function Stop-Deploy([string]$msg) {
    # Pre-Step-6 failure path: nothing running has been touched yet, so
    # only the repo checkout needs reverting (hygiene, not safety).
    Write-Fail $msg
    if ((Test-Path $RepoDir) -and $script:CheckedOutTargetBranch) {
        try {
            Push-Location $RepoDir
            git checkout $RollbackRef 2>&1 | Write-Host
            Pop-Location
        } catch { }
    }
    exit 1
}

$script:CheckedOutTargetBranch = $false
$deployStartedAt = Get-Date

# For the Step-8 log-spam comparison (optional, only if -EngineLogPath is
# given): sample the "before" rate over the short window between now and
# just before Step 6 stops/restarts anything.
$logCountAtStart = Get-LogLineCount $EngineLogPath
$logSampleAtStart = Get-Date

# =============================================================================
# Step 1: Backup
# =============================================================================
Write-StepHeader "Step 1: Backup"
if (-not (Test-Path $BackupDir)) {
    New-Item -ItemType Directory -Path $BackupDir | Out-Null
    Write-Ok "Created $BackupDir"
}
if (-not (Test-Path $EngineExe))    { Stop-Deploy "Engine exe not found at $EngineExe -- aborting before touching anything" }
if (-not (Test-Path $StartEngine))  { Stop-Deploy "start-engine.cmd not found at $StartEngine" }
if (-not (Test-Path $StartGateway)) { Stop-Deploy "start-gateway.cmd not found at $StartGateway" }

Copy-Item -Force $EngineExe $BackupExe
Copy-Item -Force $StartEngine $BackupStartEngine
Copy-Item -Force $StartGateway $BackupStartGateway
Write-Ok "Backed up engine exe -> $BackupExe"
Write-Ok "Backed up start-engine.cmd, start-gateway.cmd -> $BackupDir"

# =============================================================================
# Step 2: Checkout
# =============================================================================
Write-StepHeader "Step 2: Checkout $TargetBranch"
Push-Location $RepoDir

$status = git status --porcelain
if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Deploy "git status failed -- is $RepoDir a git repo?" }
if ($status) {
    Pop-Location
    Stop-Deploy "git status is not clean, refusing to touch a dirty working tree:`n$status"
}

git fetch --all
if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Deploy "git fetch --all failed" }

git checkout $TargetBranch
if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Deploy "git checkout $TargetBranch failed" }
$script:CheckedOutTargetBranch = $true

git pull
if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Deploy "git pull failed" }

$head = (git rev-parse --short HEAD).Trim()
Pop-Location

if ($head -ne $TargetCommit) {
    Stop-Deploy "HEAD is $head, expected $TargetCommit -- aborting"
}
Write-Ok "Repo is on $TargetBranch @ $head"

# =============================================================================
# Step 3: Build engine
# =============================================================================
Write-StepHeader "Step 3: Build engine"
$preBuildTime = (Get-Item $EngineExe).LastWriteTime

Push-Location (Join-Path $RepoDir "engine")
cargo build --release -p server
$buildExit = $LASTEXITCODE
Pop-Location

if ($buildExit -ne 0) { Stop-Deploy "cargo build --release -p server failed (exit $buildExit)" }
if (-not (Test-Path $EngineExe)) { Stop-Deploy "Build reported success but $EngineExe does not exist" }

$postBuildTime = (Get-Item $EngineExe).LastWriteTime
if ($postBuildTime -le $preBuildTime) {
    Stop-Deploy "Engine exe timestamp did not advance (was $preBuildTime, still $postBuildTime) -- build may not have actually run"
}
Write-Ok "Engine built: $EngineExe (was $preBuildTime, now $postBuildTime)"

# =============================================================================
# Step 4: Build gateway
# =============================================================================
Write-StepHeader "Step 4: Build gateway"
Push-Location (Join-Path $RepoDir "services\api-gateway")

npm ci
if ($LASTEXITCODE -ne 0) { Pop-Location; Stop-Deploy "npm ci failed in services/api-gateway" }

npm run build
$gwBuildExit = $LASTEXITCODE
Pop-Location

if ($gwBuildExit -ne 0) { Stop-Deploy "npm run build failed in services/api-gateway (exit $gwBuildExit)" }
Write-Ok "Gateway built (dist/ updated)"

# =============================================================================
# Step 5: Environment variables
# =============================================================================
Write-StepHeader "Step 5: Environment variables"

# Adds/updates $SetVars and strips $RemoveVarNames from a start-*.cmd,
# inserting the new lines right after the last existing `set` line (or
# after any leading @echo off/rem header block if there are no `set`
# lines to anchor on). Idempotent -- re-running this against a file this
# function already edited just replaces the same lines with themselves.
function Set-CmdEnvVars {
    param(
        [Parameter(Mandatory)] [string]$Path,
        [Parameter(Mandatory)] [hashtable]$SetVars,
        [string[]]$RemoveVarNames = @()
    )
    $lines = Get-Content -Path $Path
    $allNames = @($SetVars.Keys) + $RemoveVarNames | ForEach-Object { [regex]::Escape($_) }
    $removePattern = '^\s*set\s+(' + ($allNames -join '|') + ')\s*='
    $kept = @($lines | Where-Object { $_ -notmatch $removePattern })

    $newLines = @()
    foreach ($name in $SetVars.Keys) { $newLines += "set $name=$($SetVars[$name])" }

    $lastSetIdx = -1
    for ($i = 0; $i -lt $kept.Count; $i++) {
        if ($kept[$i] -match '^\s*set\s+') { $lastSetIdx = $i }
    }

    if ($lastSetIdx -ge 0) {
        $before = if ($lastSetIdx -ge 0) { $kept[0..$lastSetIdx] } else { @() }
        $after  = if ($lastSetIdx -lt $kept.Count - 1) { $kept[($lastSetIdx + 1)..($kept.Count - 1)] } else { @() }
        $result = $before + $newLines + $after
    } else {
        $headerEnd = -1
        for ($i = 0; $i -lt $kept.Count; $i++) {
            if ($kept[$i] -match '^\s*(@echo\s+off|rem\b|::)' -or $kept[$i].Trim() -eq '') { $headerEnd = $i } else { break }
        }
        if ($headerEnd -ge 0) {
            $before = $kept[0..$headerEnd]
            $after  = if ($headerEnd -lt $kept.Count - 1) { $kept[($headerEnd + 1)..($kept.Count - 1)] } else { @() }
            $result = $before + $newLines + $after
        } else {
            $result = $newLines + $kept
        }
    }
    Set-Content -Path $Path -Value $result
    return $result
}

$engineResult = Set-CmdEnvVars -Path $StartEngine `
    -SetVars @{ BIND_ADDR = "127.0.0.1"; LIVE_PRICE_FLUSH_INTERVAL_MS = "250"; CANDLE_FLUSH_INTERVAL_MS = "1000" } `
    -RemoveVarNames @("LIVE_PRICE_FLUSH_INTERVAL_SECS", "CANDLE_FLUSH_INTERVAL_SECS")
Write-Ok "Updated $StartEngine"
Write-Host "--- $StartEngine (secrets redacted) ---"
Get-RedactedLines $engineResult | ForEach-Object { Write-Host $_ }

$gatewayResult = Set-CmdEnvVars -Path $StartGateway -SetVars @{ BIND_ADDR = "127.0.0.1" }
Write-Ok "Updated $StartGateway"
Write-Host "--- $StartGateway (secrets redacted) ---"
Get-RedactedLines $gatewayResult | ForEach-Object { Write-Host $_ }

# =============================================================================
# Step 6: Restart services
# =============================================================================
Write-StepHeader "Step 6: Restart services"
$script:ServicesTouched = $true   # from here on, any failure triggers the full rollback

function Wait-ForHttp200 {
    param([string]$Url, [int]$TimeoutSec = 30)
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        try {
            $resp = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 3
            if ($resp.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 1
    }
    return $false
}

$logCountBeforeRestart = Get-LogLineCount $EngineLogPath
$logSampleBeforeRestart = Get-Date

Write-Host "Stopping $GatewayService..."
& nssm stop $GatewayService 2>&1 | Write-Host
Start-Sleep -Seconds 2

Write-Host "Restarting $EngineService..."
& nssm restart $EngineService 2>&1 | Write-Host
if (-not (Wait-ForHttp200 -Url "http://127.0.0.1:8081/health" -TimeoutSec 30)) {
    Invoke-FullRollback "engine did not respond 200 on http://127.0.0.1:8081/health within 30s"
}
Write-Ok "Engine is up (http://127.0.0.1:8081/health -> 200)"

if ($EngineLogPath -and (Test-Path $EngineLogPath)) {
    $listeningLine = Get-Content $EngineLogPath -Tail 50 | Select-String "listening on 127.0.0.1:8081"
    if ($listeningLine) { Write-Ok "Confirmed in log: $listeningLine" }
    else { Write-Warn "HTTP health check passed but 'listening on 127.0.0.1:8081' wasn't found in the last 50 lines of $EngineLogPath -- check manually" }
} else {
    Write-Warn "No -EngineLogPath given -- skipping the log-line check, relying on the HTTP health check above"
}

Write-Host "Starting $GatewayService..."
& nssm start $GatewayService 2>&1 | Write-Host
if (-not (Wait-ForHttp200 -Url "http://127.0.0.1:8080/health" -TimeoutSec 30)) {
    Invoke-FullRollback "gateway did not respond 200 on http://127.0.0.1:8080/health within 30s"
}
Write-Ok "Gateway is up (http://127.0.0.1:8080/health -> 200)"

# netstat -- both ports must be bound to 127.0.0.1 only, not 0.0.0.0
$netstatOutput = netstat -ano | Select-String ":(8080|8081)\s"
Write-Host "--- netstat (8080/8081) ---"
$netstatOutput | ForEach-Object { Write-Host $_ }
$badBindings = $netstatOutput | Where-Object { $_ -match "0\.0\.0\.0:(8080|8081)\s" -and $_ -match "LISTENING" }
if ($badBindings) {
    Invoke-FullRollback "port 8080 or 8081 is bound to 0.0.0.0, not 127.0.0.1 -- BIND_ADDR did not take effect:`n$badBindings"
}
Write-Ok "8080/8081 confirmed loopback-only"

# Public health check through Caddy
try {
    $feedHealth = Invoke-WebRequest -Uri "https://feed.vyxtrader.com/health" -UseBasicParsing -TimeoutSec 10
    if ($feedHealth.StatusCode -ne 200) {
        Invoke-FullRollback "https://feed.vyxtrader.com/health returned $($feedHealth.StatusCode), expected 200"
    }
    Write-Ok "https://feed.vyxtrader.com/health -> 200 (Caddy -> gateway path confirmed)"
} catch {
    Invoke-FullRollback "https://feed.vyxtrader.com/health request failed: $($_.Exception.Message)"
}

Write-Ok "Step 6 complete -- both services restarted and verified on $TargetCommit"

# =============================================================================
# Step 8: Poll /internal/feed-stats
# =============================================================================
Write-StepHeader "Step 8: Poll /internal/feed-stats for ${PollDurationSec}s"

$secretMatch = Get-Content $StartEngine | Select-String '^\s*set\s+INTERNAL_SERVICE_SECRET\s*=\s*(.+)$'
if (-not $secretMatch) {
    Write-Fail "Could not find INTERNAL_SERVICE_SECRET in $StartEngine -- skipping Step 8. The deploy itself is already verified (Step 6's health checks passed); this only affects the feed-health table below."
} else {
    $internalSecret = $secretMatch.Matches[0].Groups[1].Value.Trim()
    $headers = @{ "x-internal-secret" = $internalSecret }
    $samples = New-Object System.Collections.Generic.List[object]

    $logCountPollStart = Get-LogLineCount $EngineLogPath
    $logSamplePollStart = Get-Date

    $pollStart = Get-Date
    $lastPerSymbol = $null
    while (((Get-Date) - $pollStart).TotalSeconds -lt $PollDurationSec) {
        try {
            $stats = Invoke-RestMethod -Uri "http://127.0.0.1:8081/internal/feed-stats" -Headers $headers -TimeoutSec 5
            $samples.Add([PSCustomObject]@{
                t                  = (Get-Date).ToString("HH:mm:ss")
                ticks_in           = $stats.ticks_in
                t0_invalid         = $stats.t0_invalid
                nats_out           = $stats.nats_out
                queue_len          = $stats.queue_len
                db_ok              = $stats.db_ok
                db_fail            = $stats.db_fail
                db_lag_ms          = $stats.db_lag_ms
                ea_to_engine_ms_last = $stats.ea_to_engine_ms_last
                ea_to_engine_ms_p50  = $stats.ea_to_engine_ms_p50
                ea_to_engine_ms_p95  = $stats.ea_to_engine_ms_p95
                clock_offset_ms      = $stats.clock_offset_ms
                rtt_ms               = $stats.rtt_ms
            })
            $lastPerSymbol = $stats.per_symbol
        } catch {
            $samples.Add([PSCustomObject]@{
                t = (Get-Date).ToString("HH:mm:ss"); ticks_in = "ERROR"; t0_invalid = $_.Exception.Message
                nats_out = $null; queue_len = $null; db_ok = $null; db_fail = $null; db_lag_ms = $null
                ea_to_engine_ms_last = $null; ea_to_engine_ms_p50 = $null; ea_to_engine_ms_p95 = $null
                clock_offset_ms = $null; rtt_ms = $null
            })
        }
        $remaining = $PollDurationSec - ((Get-Date) - $pollStart).TotalSeconds
        if ($remaining -gt 0) { Start-Sleep -Seconds ([Math]::Min($PollIntervalSec, [Math]::Max(1, $remaining))) }
    }

    $logCountPollEnd = Get-LogLineCount $EngineLogPath
    $logSamplePollEnd = Get-Date

    Write-Host "`n--- /internal/feed-stats, every ${PollIntervalSec}s for ${PollDurationSec}s ---"
    $samples | Format-Table -AutoSize | Out-String | Write-Host

    $good = $samples | Where-Object { $_.ticks_in -ne "ERROR" }
    if ($good.Count -ge 2) {
        $first = $good | Select-Object -First 1
        $last  = $good | Select-Object -Last 1
        $ticksDelta = $last.ticks_in - $first.ticks_in
        $natsDelta  = $last.nats_out - $first.nats_out
        $dbOkDelta  = $last.db_ok - $first.db_ok

        Write-Host "`nticks_in: $($first.ticks_in) -> $($last.ticks_in)  (delta $ticksDelta)"
        Write-Host "nats_out: $($first.nats_out) -> $($last.nats_out)  (delta $natsDelta)"
        Write-Host "db_ok:    $($first.db_ok) -> $($last.db_ok)  (delta $dbOkDelta)"
        Write-Host "db_fail (cumulative): $($last.db_fail)"
        Write-Host "db_lag_ms (last sample): $($last.db_lag_ms)"
        Write-Host "t0_invalid (cumulative): $($last.t0_invalid)  -- non-zero and climbing means the EA's timestamp is still wrong (should be ~0 after the TimeGMT() fix)"
        Write-Host "ea_to_engine_ms last/p50/p95 (last sample): $($last.ea_to_engine_ms_last) / $($last.ea_to_engine_ms_p50) / $($last.ea_to_engine_ms_p95)  -- should be small positive numbers, not near +/-10,800,000"
        Write-Host "queue_len (last sample): $($last.queue_len)  -- compare by eye against how many symbols should be live"

        if ($ticksDelta -le 0) { Write-Warn "ticks_in did not climb over the poll window -- feed may not be flowing" }
        else { Write-Ok "ticks_in is climbing" }

        if ($ticksDelta -ne $natsDelta) { Write-Warn "nats_out delta ($natsDelta) != ticks_in delta ($ticksDelta) -- some ticks aren't reaching NATS" }
        else { Write-Ok "nats_out is tracking ticks_in exactly over this window" }

        if ($last.db_fail -gt $first.db_fail) { Write-Warn "db_fail increased during the poll window ($($first.db_fail) -> $($last.db_fail))" }

        if ($last.t0_invalid -gt $first.t0_invalid) { Write-Warn "t0_invalid increased during the poll window ($($first.t0_invalid) -> $($last.t0_invalid)) -- check the EA's TimeGMT() fix actually deployed" }
        if ($null -ne $last.ea_to_engine_ms_p50 -and [Math]::Abs($last.ea_to_engine_ms_p50) -gt 60000) { Write-Warn "ea_to_engine_ms_p50 ($($last.ea_to_engine_ms_p50)) looks like a timezone/clock bug, not real latency" }
    } else {
        Write-Fail "Fewer than 2 successful samples -- could not compute deltas. Check the errors printed in the table above."
    }

    if ($lastPerSymbol -and $lastPerSymbol.Count -gt 0) {
        Write-Host "`n--- per_symbol (from the last successful sample) ---"
        $lastPerSymbol | Sort-Object symbol | Format-Table symbol, ticks_60s, last_tick_age_ms, bid, ask -AutoSize | Out-String | Write-Host

        $stale = $lastPerSymbol | Where-Object { $_.last_tick_age_ms -gt 15000 }
        if ($stale) { Write-Warn "Symbols with last_tick_age_ms > 15000 (stale): $(($stale | ForEach-Object { $_.symbol }) -join ', ')" }
        else { Write-Ok "All reported symbols are fresh (last_tick_age_ms <= 15000)" }

        foreach ($weekendSymbol in @("BTCUSD", "ETHUSD")) {
            $row = $lastPerSymbol | Where-Object { $_.symbol -eq $weekendSymbol }
            if ($row) { Write-Ok "$weekendSymbol is live -- last_tick_age_ms=$($row.last_tick_age_ms), ticks_60s=$($row.ticks_60s)" }
            else { Write-Warn "$weekendSymbol not present in per_symbol -- not being pushed by the EA right now" }
        }
    } else {
        Write-Warn "per_symbol was empty or missing on the last successful sample -- check the engine build actually includes this follow-up's changes"
    }

    if ($EngineLogPath -and $logCountAtStart -ne $null -and $logCountBeforeRestart -ne $null -and $logCountPollStart -ne $null -and $logCountPollEnd -ne $null) {
        $beforeMinutes = ($logSampleBeforeRestart - $logSampleAtStart).TotalMinutes
        $afterMinutes  = ($logSamplePollEnd - $logSamplePollStart).TotalMinutes
        $beforeRate = if ($beforeMinutes -gt 0) { [Math]::Round(($logCountBeforeRestart - $logCountAtStart) / $beforeMinutes, 1) } else { $null }
        $afterRate  = if ($afterMinutes -gt 0)  { [Math]::Round(($logCountPollEnd - $logCountPollStart) / $afterMinutes, 1) } else { $null }
        Write-Host "`nengine.log lines/minute -- before deploy (old code, short pre-restart sample): $beforeRate    after deploy (new code, over the ${PollDurationSec}s poll window): $afterRate"
    } else {
        Write-Warn "No -EngineLogPath given -- skipping the log-spam (lines/minute) comparison"
    }
}

# =============================================================================
# Step 7 checklist (manual -- MetaEditor has no CLI)
# =============================================================================
Write-StepHeader "Step 7 (MANUAL -- do this yourself, this script does not touch MT5)"
Write-Host @"
  [ ] Copy the updated mt5-ea\VyXTraderPriceFeed.mq5 into MQL5\Experts on the
      Pepperstone terminal (C:\MT5-Pepperstone, portable mode).
  [ ] Open it in MetaEditor, compile (F7). Confirm zero errors in the compile
      log before proceeding.
  [ ] Tools > Options > Expert Advisors > Allow WebRequest for listed URL --
      confirm http://127.0.0.1:8081 is in the list (add it if UseDirectMode
      talks to the engine over plain HTTP on loopback).
  [ ] Re-attach to a XAUUSD chart (M1) with Inputs:
        UseDirectMode     = true
        DirectServerUrl   = <same URL the previous instance used>
        ApiSecret         = <value of PRICE_FEED_SECRET from start-engine.cmd>
        PushOnEveryTick   = true
        PushMinIntervalMs = 50
        BrokerNames[]     = mapped to this Pepperstone account's actual symbol
                            names (check Market Watch for exact spelling/suffix)
  [ ] Check the Experts log: no "ApiSecret is empty", no "WebRequest failed".
  [ ] Only once Step 8 above looked green AND this Pepperstone EA is
      confirmed live: remove the EA from the Exness chart. Never close the
      Exness terminal itself.
"@ -ForegroundColor Cyan

Write-Host "`n==== Deploy finished in $([Math]::Round(((Get-Date) - $deployStartedAt).TotalMinutes, 1)) minutes ====" -ForegroundColor Cyan
