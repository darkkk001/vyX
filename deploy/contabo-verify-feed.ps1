<#
.SYNOPSIS
    Read-only verification of the tick pipeline after the EA re-attach on
    commit 65828a3 -- does NOT build, restart, or touch anything running.

.DESCRIPTION
    1. Polls /internal/feed-stats every -IntervalSec for -DurationSec,
       prints the table, and flags:
         - t0_invalid still climbing (should be flat -- the TimeGMT() fix)
         - ea_to_engine_ms_p50/p95 outside a plausible localhost range
         - per-symbol ticks_60s/last_tick_age_ms, with a specific
           before/after comparison hint for the "remove EA from Exness"
           step (shared-symbol counts should roughly halve).
    2. Tails the MT5 Experts log (portable-mode default path guessed as
       C:\MT5-Pepperstone\MQL5\Logs\<today>.log -- override with
       -EaLogPath if that's wrong) for the new EA version string and for
       "ApiSecret is empty" / "WebRequest failed" lines.
    3. Confirms the repo checkout backing the currently-running gateway is
       on -ExpectedCommit (checks git HEAD in -RepoDir -- this assumes
       gateway was rebuilt from that same checkout, it does not inspect
       the running process itself).
    4. Confirms DATABASE_URL is present (redacted) in start-gateway.cmd.
    5. If -GatewayLogPath is given, tails it for "getEnabledSymbols"-
       related error lines.

.PARAMETER Label
    A short tag printed at the top of the output and used nowhere else --
    pass e.g. -Label "before-exness-removal" / -Label "after-exness-removal"
    so pasted output is easy to tell apart when you run this twice.
#>

[CmdletBinding()]
param(
    [string]$Label            = "run",
    [string]$RepoDir          = "C:\vyxtrader\repo",
    [string]$ScriptsDir       = "C:\vyxtrader\scripts",
    [string]$ExpectedCommit   = "65828a3",
    [int]$DurationSec         = 60,
    [int]$IntervalSec         = 5,
    [string]$EaLogPath        = "C:\MT5-Pepperstone\MQL5\Logs\$(Get-Date -Format 'yyyyMMdd').log",
    [string]$GatewayLogPath   = ""
)

$ErrorActionPreference = "Stop"

function Write-StepHeader($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Write-Ok($msg)         { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)       { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)       { Write-Host "[FAIL] $msg" -ForegroundColor Red }

Write-Host "==================== VERIFY ($Label) $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====================" -ForegroundColor Magenta

$StartEngine  = Join-Path $ScriptsDir "start-engine.cmd"
$StartGateway = Join-Path $ScriptsDir "start-gateway.cmd"

# =============================================================================
# 1. Poll /internal/feed-stats
# =============================================================================
Write-StepHeader "1. Polling /internal/feed-stats for ${DurationSec}s"

if (-not (Test-Path $StartEngine)) {
    Write-Fail "$StartEngine not found -- cannot read INTERNAL_SERVICE_SECRET, skipping the poll entirely"
} else {
    $secretMatch = Get-Content $StartEngine | Select-String '^\s*set\s+INTERNAL_SERVICE_SECRET\s*=\s*(.+)$'
    if (-not $secretMatch) {
        Write-Fail "Could not find INTERNAL_SERVICE_SECRET in $StartEngine -- skipping the poll"
    } else {
        $internalSecret = $secretMatch.Matches[0].Groups[1].Value.Trim()
        $headers = @{ "x-internal-secret" = $internalSecret }
        $samples = New-Object System.Collections.Generic.List[object]
        $lastPerSymbol = $null

        $pollStart = Get-Date
        while (((Get-Date) - $pollStart).TotalSeconds -lt $DurationSec) {
            try {
                $stats = Invoke-RestMethod -Uri "http://127.0.0.1:8081/internal/feed-stats" -Headers $headers -TimeoutSec 5
                $samples.Add([PSCustomObject]@{
                    t                    = (Get-Date).ToString("HH:mm:ss")
                    ticks_in             = $stats.ticks_in
                    t0_invalid           = $stats.t0_invalid
                    nats_out             = $stats.nats_out
                    ea_to_engine_ms_last = $stats.ea_to_engine_ms_last
                    ea_to_engine_ms_p50  = $stats.ea_to_engine_ms_p50
                    ea_to_engine_ms_p95  = $stats.ea_to_engine_ms_p95
                })
                $lastPerSymbol = $stats.per_symbol
            } catch {
                $samples.Add([PSCustomObject]@{
                    t = (Get-Date).ToString("HH:mm:ss"); ticks_in = "ERROR"; t0_invalid = $_.Exception.Message
                    nats_out = $null; ea_to_engine_ms_last = $null; ea_to_engine_ms_p50 = $null; ea_to_engine_ms_p95 = $null
                })
            }
            $remaining = $DurationSec - ((Get-Date) - $pollStart).TotalSeconds
            if ($remaining -gt 0) { Start-Sleep -Seconds ([Math]::Min($IntervalSec, [Math]::Max(1, $remaining))) }
        }

        $samples | Format-Table -AutoSize | Out-String | Write-Host

        $good = $samples | Where-Object { $_.ticks_in -ne "ERROR" }
        if ($good.Count -ge 2) {
            $first = $good | Select-Object -First 1
            $last  = $good | Select-Object -Last 1

            if ($last.t0_invalid -gt $first.t0_invalid) {
                Write-Fail "t0_invalid grew during this window ($($first.t0_invalid) -> $($last.t0_invalid)) -- TimeGMT() fix may not be live. Check the Experts log below for which EA version actually loaded."
            } else {
                Write-Ok "t0_invalid flat ($($last.t0_invalid)) -- no bad timestamps"
            }

            $p50 = $last.ea_to_engine_ms_p50
            $p95 = $last.ea_to_engine_ms_p95
            if ($null -eq $p50) {
                Write-Warn "No ea_to_engine_ms_p50 sample yet (empty latency window) -- re-run once ticks have flowed a bit"
            } elseif ($p50 -lt 0 -or $p50 -gt 1000 -or ($null -ne $p95 -and ($p95 -lt 0 -or $p95 -gt 1000))) {
                Write-Fail "ea_to_engine_ms_p50/p95 ($p50 / $p95) is outside a plausible localhost range (expected single-digit to ~20ms) -- looks like a clock/timezone issue, not real latency"
            } else {
                Write-Ok "ea_to_engine_ms_p50/p95 ($p50 / $p95) looks like real localhost latency"
            }
        } else {
            Write-Fail "Fewer than 2 successful samples -- check the errors in the table above (engine down? wrong secret?)"
        }

        if ($lastPerSymbol -and $lastPerSymbol.Count -gt 0) {
            Write-Host "`n--- per_symbol (last sample) ---"
            $lastPerSymbol | Sort-Object symbol | Format-Table symbol, ticks_60s, last_tick_age_ms, bid, ask -AutoSize | Out-String | Write-Host
            Write-Warn "Compare ticks_60s across two runs of this script (-Label before-exness-removal / -Label after-exness-removal): a symbol fed by BOTH Exness and Pepperstone should show roughly double the ticks_60s before removal vs. after (e.g. ~120 -> ~60), since a single symbol getting pushed by two EA instances double-counts here."
        } else {
            Write-Warn "per_symbol empty or missing -- feed may not be flowing yet, or the engine build predates this field"
        }
    }
}

# =============================================================================
# 2. EA Experts log
# =============================================================================
Write-StepHeader "2. MT5 Experts log"
if (-not (Test-Path $EaLogPath)) {
    Write-Warn "No log found at $EaLogPath (guessed path for portable mode -- pass -EaLogPath if this terminal's data folder differs). Check the Experts tab in MetaEditor/the terminal directly instead."
} else {
    $tail = Get-Content $EaLogPath -Tail 200
    $badLines = $tail | Select-String "ApiSecret is empty|WebRequest failed"
    if ($badLines) {
        Write-Fail "Found error lines in the last 200 log lines:"
        $badLines | ForEach-Object { Write-Host $_ }
    } else {
        Write-Ok "No 'ApiSecret is empty' / 'WebRequest failed' in the last 200 log lines"
    }
    $versionLine = $tail | Select-String "VyXTraderPriceFeed" | Select-Object -Last 3
    if ($versionLine) {
        Write-Host "Last VyXTraderPriceFeed-related log lines:"
        $versionLine | ForEach-Object { Write-Host $_ }
    } else {
        Write-Warn "No VyXTraderPriceFeed-related lines found in the last 200 log lines -- check the log path/date"
    }
}

# =============================================================================
# 3. Gateway build / commit check
# =============================================================================
Write-StepHeader "3. Gateway build check"
if (-not (Test-Path $RepoDir)) {
    Write-Fail "$RepoDir not found -- cannot check the commit backing the gateway build"
} else {
    Push-Location $RepoDir
    $head = (git rev-parse --short HEAD).Trim()
    Pop-Location
    if ($head -eq $ExpectedCommit) {
        Write-Ok "Repo HEAD is $head, matches expected $ExpectedCommit"
    } else {
        Write-Warn "Repo HEAD is $head, expected $ExpectedCommit -- if the gateway was built from this checkout, it may be running an older or newer build than intended. This only checks the checkout, not the running process's actual loaded code."
    }
}

# =============================================================================
# 4. DATABASE_URL presence
# =============================================================================
Write-StepHeader "4. start-gateway.cmd DATABASE_URL"
if (-not (Test-Path $StartGateway)) {
    Write-Fail "$StartGateway not found"
} else {
    $dbUrlLine = Get-Content $StartGateway | Select-String '^\s*set\s+DATABASE_URL\s*='
    if ($dbUrlLine) {
        Write-Ok "DATABASE_URL is set in $StartGateway (value redacted): set DATABASE_URL=***REDACTED***"
    } else {
        Write-Fail "DATABASE_URL not found in $StartGateway -- getEnabledSymbolNames (the per-tenant symbol filter) will throw on every tick fan-out check until this is set and the gateway is restarted"
    }
}

# =============================================================================
# 5. Gateway log (optional)
# =============================================================================
Write-StepHeader "5. Gateway log (getEnabledSymbols errors)"
if (-not $GatewayLogPath) {
    Write-Warn "No -GatewayLogPath given -- skipping. Pass it to scan for errors from the new per-tenant filter."
} elseif (-not (Test-Path $GatewayLogPath)) {
    Write-Warn "No log found at $GatewayLogPath"
} else {
    $gwErrors = Get-Content $GatewayLogPath -Tail 200 | Select-String "getEnabledSymbols|price stream:"
    if ($gwErrors) {
        Write-Host "Matching lines from the last 200 lines of $GatewayLogPath :"
        $gwErrors | ForEach-Object { Write-Host $_ }
    } else {
        Write-Ok "No getEnabledSymbols/price-stream-related lines in the last 200 lines (no errors, or nothing logged either way)"
    }
}

Write-Host "`n==================== END VERIFY ($Label) ====================" -ForegroundColor Magenta
