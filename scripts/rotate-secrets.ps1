<#
.SYNOPSIS
    Rotates PRICE_FEED_SECRET and INTERNAL_SERVICE_SECRET: generates two
    new random secrets, updates start-engine.cmd/start-gateway.cmd, and
    (if found) updates the MT5 EA's saved .set preset's ApiSecret so the
    next re-attach picks up the new PRICE_FEED_SECRET automatically.

.DESCRIPTION
    NEVER PRINTS A GENERATED SECRET'S VALUE. Every confirmation below
    reports only that a value changed, never what it changed to -- if you
    need to see a rotated value, open the .cmd/.set file directly
    yourself, on the box, outside any tool that might log or transcript
    it (see CLAUDE.md's "never print secret values" note, added
    alongside this script for exactly that reason).

    Neither secret is read anywhere in the Next.js app (grepped: both are
    Contabo-only -- PRICE_FEED_SECRET gates engine/server's MT5 ingest
    route, INTERNAL_SERVICE_SECRET gates the order/feed-stats routes
    between engine and gateway) -- so there is normally no Vercel step.
    This script still prints the Vercel commands as a checklist in case
    that assumption is ever wrong for your deployment; if neither secret
    is actually set in Vercel today, that checklist is a no-op to skip.

    Does NOT restart engine or gateway -- both processes read these env
    vars once at startup, so a rotation only takes effect on their next
    restart. Restart order matches deploy/contabo-deploy.ps1's own
    (engine, then gateway) since the gateway sends INTERNAL_SERVICE_SECRET
    to the engine on every order/stats call and both must agree.

.PARAMETER ScriptsDir
    Where start-engine.cmd/start-gateway.cmd live.
.PARAMETER SetFilePath
    The MT5 EA's saved input preset (.set file), if one exists. Guessed
    default for the Pepperstone portable install; pass -SetFilePath ""
    to skip this step entirely (e.g. no preset has been saved yet and
    ApiSecret is set by hand in the Inputs tab each time).
.PARAMETER WhatIf
    Generates the new secrets and reports which files WOULD change,
    without writing to any of them.
#>

[CmdletBinding()]
param(
    [string]$ScriptsDir   = "C:\vyxtrader\scripts",
    [string]$SetFilePath  = "C:\MT5-Pepperstone\MQL5\Presets\VyXTraderPriceFeed.set",
    [switch]$WhatIf
)

$ErrorActionPreference = "Stop"

function Write-StepHeader($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Write-Ok($msg)         { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)       { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)       { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# 24 random bytes -> 48 hex chars, matching the existing secrets' own
# length/shape (the old hardcoded mt5-ea ApiSecret default, before it was
# removed for shipping a real value in a committed file, was exactly this
# shape) -- not a format the two secrets need to match each other, just a
# convention worth keeping consistent with what's already deployed.
function New-RandomHexSecret {
    $bytes = New-Object byte[] 24
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
    return -join ($bytes | ForEach-Object { $_.ToString("x2") })
}

# Replaces an existing `set NAME=...` line in a start-*.cmd, or appends it
# right after the last existing `set` line (matching
# deploy/contabo-deploy.ps1's Set-CmdEnvVars insertion point) if the
# variable isn't set there yet. Returns $true if the file was changed.
function Set-CmdSecret {
    param([string]$Path, [string]$VarName, [string]$NewValue, [switch]$WhatIfOnly)

    if (-not (Test-Path $Path)) {
        Write-Fail "$Path not found -- $VarName not updated there"
        return $false
    }

    $lines = Get-Content -Path $Path
    $pattern = "^\s*set\s+$([regex]::Escape($VarName))\s*="
    $existingIdx = -1
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match $pattern) { $existingIdx = $i; break }
    }

    $newLine = "set $VarName=$NewValue"
    if ($existingIdx -ge 0) {
        if ($WhatIfOnly) {
            Write-Host "[WHATIF] $Path : would replace line $($existingIdx + 1) (set $VarName=...)"
            return $true
        }
        $lines[$existingIdx] = $newLine
    } else {
        if ($WhatIfOnly) {
            Write-Host "[WHATIF] $Path : would append a new 'set $VarName=...' line (none exists today)"
            return $true
        }
        $lastSetIdx = -1
        for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match '^\s*set\s+') { $lastSetIdx = $i } }
        if ($lastSetIdx -ge 0) {
            $before = $lines[0..$lastSetIdx]
            $after  = if ($lastSetIdx -lt $lines.Count - 1) { $lines[($lastSetIdx + 1)..($lines.Count - 1)] } else { @() }
            $lines = $before + @($newLine) + $after
        } else {
            $lines = @($newLine) + $lines
        }
    }

    if (-not $WhatIfOnly) {
        Set-Content -Path $Path -Value $lines
        Write-Ok "$Path : $VarName updated"
    }
    return $true
}

Write-StepHeader "Generating new secrets"
$newPriceFeedSecret = New-RandomHexSecret
$newInternalServiceSecret = New-RandomHexSecret
Write-Ok "Generated two new 48-hex-char secrets (values not shown -- see this script's own doc comment on why)"

$StartEngine  = Join-Path $ScriptsDir "start-engine.cmd"
$StartGateway = Join-Path $ScriptsDir "start-gateway.cmd"

Write-StepHeader "Updating start-engine.cmd"
Set-CmdSecret -Path $StartEngine -VarName "PRICE_FEED_SECRET" -NewValue $newPriceFeedSecret -WhatIfOnly:$WhatIf | Out-Null
Set-CmdSecret -Path $StartEngine -VarName "INTERNAL_SERVICE_SECRET" -NewValue $newInternalServiceSecret -WhatIfOnly:$WhatIf | Out-Null

Write-StepHeader "Updating start-gateway.cmd"
# Only INTERNAL_SERVICE_SECRET -- PRICE_FEED_SECRET is never read by
# services/api-gateway (grepped: only engine/server's MT5 ingest route
# checks it), so it has no reason to live in this file.
Set-CmdSecret -Path $StartGateway -VarName "INTERNAL_SERVICE_SECRET" -NewValue $newInternalServiceSecret -WhatIfOnly:$WhatIf | Out-Null

Write-StepHeader "Updating the MT5 .set preset"
if (-not $SetFilePath) {
    Write-Warn "No -SetFilePath given (empty) -- skipping. Update ApiSecret by hand in the EA's Inputs tab and re-save a preset if you use one."
} elseif (-not (Test-Path $SetFilePath)) {
    Write-Warn "$SetFilePath not found -- skipping. If this terminal doesn't use a saved preset, update ApiSecret by hand in the Inputs tab on next re-attach instead."
} else {
    $setLines = Get-Content -Path $SetFilePath
    $apiSecretIdx = -1
    for ($i = 0; $i -lt $setLines.Count; $i++) { if ($setLines[$i] -match '^\s*ApiSecret\s*=') { $apiSecretIdx = $i; break } }

    if ($apiSecretIdx -lt 0) {
        Write-Warn "$SetFilePath doesn't contain an ApiSecret= line -- not touched. Check this is really the right preset file."
    } elseif ($WhatIf) {
        Write-Host "[WHATIF] $SetFilePath : would replace line $($apiSecretIdx + 1) (ApiSecret=...)"
    } else {
        $setLines[$apiSecretIdx] = "ApiSecret=$newPriceFeedSecret"
        Set-Content -Path $SetFilePath -Value $setLines
        Write-Ok "$SetFilePath : ApiSecret updated. Re-attach the EA (or reload this preset) to pick it up -- a running EA instance does not hot-reload a .set file."
    }
}

Write-StepHeader "Vercel (checklist only -- run these yourself if either secret actually is set there)"
Write-Host @"
  npx vercel env rm PRICE_FEED_SECRET production
  npx vercel env add PRICE_FEED_SECRET production
  npx vercel env rm INTERNAL_SERVICE_SECRET production
  npx vercel env add INTERNAL_SERVICE_SECRET production
"@ -ForegroundColor Cyan
Write-Warn "Confirmed via grep this turn: neither secret is read anywhere in the Next.js app today (both are Contabo-only, engine+gateway). Skip the above unless that's changed since."

if ($WhatIf) {
    Write-Host "`n-WhatIf: nothing was written. Re-run without -WhatIf to apply." -ForegroundColor Yellow
} else {
    Write-Host "`nDone. Restart order: nssm restart vyxtrader-engine, then nssm restart vyxtrader-gateway (gateway sends INTERNAL_SERVICE_SECRET to the engine on every call -- both must be on the new value before either is trusted)." -ForegroundColor Cyan
}
