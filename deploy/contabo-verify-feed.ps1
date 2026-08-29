<#
.SYNOPSIS
    Read-only verification of the tick pipeline after an EA re-attach --
    does NOT build, restart, or touch anything running.

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
       the running process itself). Defaults to whatever -RepoDir is
       currently on, so this check is a no-op unless you pin a specific
       commit you expect to be deployed.
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
    # Empty by default -- resolved below to "whatever RepoDir is currently
    # on" if not given, which makes this check a no-op unless you actually
    # pin a specific commit you expect to be deployed.
    [string]$ExpectedCommit   = "",
    # 70 by default -- the first 10s are excluded from the t0_invalid
    # gate (re-attach settle-in noise), leaving a true 60s of evaluated
    # window to match "flat over the last 60s."
    [int]$DurationSec         = 70,
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

if (-not $ExpectedCommit -and (Test-Path $RepoDir)) {
    Push-Location $RepoDir
    $ExpectedCommit = (git rev-parse --short HEAD).Trim()
    Pop-Location
}

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
            $elapsedSec = [Math]::Round(((Get-Date) - $pollStart).TotalSeconds, 1)
            try {
                $stats = Invoke-RestMethod -Uri "http://127.0.0.1:8081/internal/feed-stats" -Headers $headers -TimeoutSec 5
                $samples.Add([PSCustomObject]@{
                    t                       = (Get-Date).ToString("HH:mm:ss")
                    elapsed_sec             = $elapsedSec
                    ticks_in                = $stats.ticks_in
                    t0_invalid              = $stats.t0_invalid
                    nats_out                = $stats.nats_out
                    ea_to_engine_ms_last    = $stats.ea_to_engine_ms_last
                    ea_to_engine_ms_p50     = $stats.ea_to_engine_ms_p50
                    ea_to_engine_ms_p95     = $stats.ea_to_engine_ms_p95
                    mono_to_utc_offset_ms   = $stats.mono_to_utc_offset_ms
                    rtt_ms                  = $stats.rtt_ms
                })
                $lastPerSymbol = $stats.per_symbol
            } catch {
                $samples.Add([PSCustomObject]@{
                    t = (Get-Date).ToString("HH:mm:ss"); elapsed_sec = $elapsedSec; ticks_in = "ERROR"; t0_invalid = $_.Exception.Message
                    nats_out = $null; ea_to_engine_ms_last = $null; ea_to_engine_ms_p50 = $null; ea_to_engine_ms_p95 = $null
                    mono_to_utc_offset_ms = $null; rtt_ms = $null
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

            # t0_invalid gate: flat over the tail of the window, ignoring
            # the first 10s -- a re-attach can leave a handful of
            # in-flight/stale ticks from before the new EA build settled,
            # which would otherwise read as a false failure even though
            # the real, steady-state behavior is fine.
            $settled = $good | Where-Object { $_.elapsed_sec -ge 10 }
            if ($settled.Count -ge 2) {
                $settledFirst = $settled | Select-Object -First 1
                $settledLast  = $settled | Select-Object -Last 1
                if ($settledLast.t0_invalid -gt $settledFirst.t0_invalid) {
                    Write-Fail "t0_invalid grew from $($settledFirst.t0_invalid) to $($settledLast.t0_invalid) after the first 10s -- the clock-sync handshake isn't holding steady, or UseDirectMode/DirectServerUrl got reset on re-attach. Check the Experts log below for which EA version actually loaded."
                } else {
                    Write-Ok "t0_invalid flat over the settled portion of the window (from elapsed_sec=10 to $($settledLast.elapsed_sec)s: $($settledLast.t0_invalid)) -- no bad timestamps once settled"
                }
            } else {
                Write-Warn "Window too short to apply the 10s settle-in exclusion (-DurationSec $DurationSec) -- re-run with a longer -DurationSec for a real t0_invalid verdict"
            }

            $p50 = $last.ea_to_engine_ms_p50
            $p95 = $last.ea_to_engine_ms_p95
            if ($null -eq $p50) {
                Write-Warn "No ea_to_engine_ms_p50 sample yet (empty latency window) -- re-run once ticks have flowed a bit"
            } elseif ($p50 -gt 100) {
                Write-Fail "ea_to_engine_ms_p50 ($p50 ms) is above the 100ms threshold for a Contabo-local handshake -- p95 is $p95 ms"
            } else {
                Write-Ok "ea_to_engine_ms_p50/p95 ($p50 / $p95 ms) OK (<=100ms)"
            }

            if ($null -eq $last.mono_to_utc_offset_ms) {
                Write-Warn "mono_to_utc_offset_ms/rtt_ms not reported yet -- either the EA hasn't completed its first /internal/time handshake, UseDirectMode is off, or this is running against an older engine build"
            } else {
                Write-Ok "clock handshake reporting: offset=$($last.mono_to_utc_offset_ms)ms, rtt=$($last.rtt_ms)ms"
                # This is not clock skew -- as the name now says, it is the
                # constant that converts the EA's monotonic clock
                # (GetMicrosecondCount(), counting from when the EA started)
                # into UTC epoch ms. It is therefore ALWAYS a number near the
                # current epoch, and comparing its magnitude to a few-second
                # skew threshold fired on every healthy run. What should
                # actually hold is: now - offset == the EA's runtime.
                $nowMs = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
                $impliedRuntimeMs = $nowMs - [int64]$last.mono_to_utc_offset_ms
                $maxRuntimeMs = 90L * 24 * 3600 * 1000
                if ($impliedRuntimeMs -lt 0 -or $impliedRuntimeMs -gt $maxRuntimeMs) {
                    Write-Warn "mono_to_utc_offset_ms implies an EA runtime of $([math]::Round($impliedRuntimeMs / 3600000.0, 1))h, which is impossible -- suspect a real clock problem on the terminal's host, or an EA/engine mismatch in how this field is computed"
                } else {
                    Write-Ok "mono_to_utc_offset_ms is consistent with an EA runtime of $([math]::Round($impliedRuntimeMs / 3600000.0, 1))h (monotonic-to-UTC constant, not clock skew -- near the current epoch is correct)"
                }

                # rtt_ms is the real health signal for the handshake.
                if ($null -ne $last.rtt_ms -and $last.rtt_ms -gt 100) {
                    Write-Warn "rtt_ms ($($last.rtt_ms)) is high for a loopback handshake -- expect single-digit ms; a slow /internal/time round-trip widens the offset error"
                }
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
