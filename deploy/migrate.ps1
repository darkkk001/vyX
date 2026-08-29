<#
.SYNOPSIS
    Dump -> restore -> row-count verify for the Prisma Postgres -> Neon
    migration. See docs/db-migration.md for the full runbook this
    automates (steps 1, 2, and 5) and for everything it deliberately does
    NOT do.

.DESCRIPTION
    Needs SOURCE_DATABASE_URL (the current DIRECT Prisma connection
    string, NOT the prisma+postgres:// Accelerate URL) and
    TARGET_DATABASE_URL (Neon's direct connection string). Neither is
    ever a script parameter -- that would land them in shell history or a
    transcript via a command-line argument. Instead, in priority order:
      1. Already-set $env:SOURCE_DATABASE_URL / $env:TARGET_DATABASE_URL
         in the calling shell, if present -- wins over -EnvFile so a
         one-off override doesn't require editing the file.
      2. Otherwise, read from -EnvFile (default: .env at the repo root,
         i.e. next to this script's own deploy/ folder) -- add
         SOURCE_DATABASE_URL=... and TARGET_DATABASE_URL=... lines there.
         .env is already gitignored (.gitignore's .env* pattern, confirmed
         via `git check-ignore`) and already untracked, so this is a safe
         place for both -- never commit them anywhere else.

    Does NOT touch DATABASE_URL anywhere (Vercel, Contabo start-*.cmd) --
    that's docs/db-migration.md §6, a separate, deliberate action after
    this script's verification passes.

.PARAMETER EnvFile
    Path to a .env-style file to read SOURCE_DATABASE_URL/
    TARGET_DATABASE_URL from when they aren't already set as environment
    variables. Defaults to the repo's own .env (one level up from this
    script's deploy/ folder).

.PARAMETER DryRun
    Performs no writes to TARGET at all. Instead: dumps SOURCE's schema
    only (no data) to a throwaway temp file and lists its contents (first
    40 objects) as a connectivity/sanity check, and confirms TARGET is
    reachable with a bare SELECT 1. Use this first.

.PARAMETER SkipVerify
    Skips step 3 (row-count verification) after a real restore. Not
    recommended -- only for re-running the restore step alone when you've
    already verified a previous run and just need to redo the restore
    (e.g. after fixing a pg_restore error) without re-running dump.
#>

[CmdletBinding()]
param(
    [string]$BackupFile = "vyxtrader.backup",
    [string]$EnvFile = (Join-Path $PSScriptRoot "..\.env"),
    [switch]$DryRun,
    [switch]$SkipVerify
)

$ErrorActionPreference = "Stop"

function Write-StepHeader($msg) { Write-Host "`n==== $msg ====" -ForegroundColor Cyan }
function Write-Ok($msg)         { Write-Host "[OK] $msg" -ForegroundColor Green }
function Write-Warn($msg)       { Write-Host "[WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg)       { Write-Host "[FAIL] $msg" -ForegroundColor Red }

# Reads one KEY=value line out of a .env-style file -- never logs the
# value itself. Strips a surrounding "..."/'...' pair if present (dotenv
# files commonly quote values containing special characters).
function Get-DotEnvValue {
    param([string]$Path, [string]$Key)
    if (-not (Test-Path $Path)) { return $null }
    $pattern = "^\s*$([regex]::Escape($Key))\s*="
    $line = Get-Content -Path $Path | Where-Object { $_ -match $pattern } | Select-Object -First 1
    if (-not $line) { return $null }
    $value = ($line -replace $pattern, "").Trim()
    if ($value.Length -ge 2 -and (($value[0] -eq '"' -and $value[-1] -eq '"') -or ($value[0] -eq "'" -and $value[-1] -eq "'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }
    return $value
}

if (-not $env:SOURCE_DATABASE_URL) {
    $fromFile = Get-DotEnvValue -Path $EnvFile -Key "SOURCE_DATABASE_URL"
    if ($fromFile) { $env:SOURCE_DATABASE_URL = $fromFile; Write-Ok "Loaded SOURCE_DATABASE_URL from $EnvFile" }
}
if (-not $env:TARGET_DATABASE_URL) {
    $fromFile = Get-DotEnvValue -Path $EnvFile -Key "TARGET_DATABASE_URL"
    if ($fromFile) { $env:TARGET_DATABASE_URL = $fromFile; Write-Ok "Loaded TARGET_DATABASE_URL from $EnvFile" }
}

if (-not $env:SOURCE_DATABASE_URL) { Write-Fail "SOURCE_DATABASE_URL not found -- set `$env:SOURCE_DATABASE_URL or add it to $EnvFile (see docs/db-migration.md section 0)"; exit 1 }
if (-not $env:TARGET_DATABASE_URL) { Write-Fail "TARGET_DATABASE_URL not found -- set `$env:TARGET_DATABASE_URL or add it to $EnvFile (see docs/db-migration.md section 0)"; exit 1 }

# Never echoes either URL in full -- only scheme+host, for a "did I set
# the right one" sanity check without printing credentials.
function Get-RedactedUrl([string]$url) {
    if ($url -match '^(?<scheme>[a-z+]+://)[^/]*@?(?<hostpart>[^/?]+)') {
        return "$($Matches.scheme)<redacted>@$($Matches.hostpart)"
    }
    return "<redacted -- unrecognized URL shape, double-check it's a real postgres:// URL>"
}
Write-Host "SOURCE: $(Get-RedactedUrl $env:SOURCE_DATABASE_URL)"
Write-Host "TARGET: $(Get-RedactedUrl $env:TARGET_DATABASE_URL)"

if ($DryRun) {
    Write-StepHeader "DRY RUN -- no data will be written to TARGET"

    $tmpFile = Join-Path $env:TEMP "vyxtrader-dryrun-schema.backup"
    Write-Host "Checking pg_dump can reach SOURCE (schema-only, no data)..."
    & pg_dump "$env:SOURCE_DATABASE_URL" --schema-only --no-owner --format=custom --file="$tmpFile"
    if ($LASTEXITCODE -ne 0) { Write-Fail "pg_dump against SOURCE failed (exit $LASTEXITCODE)"; exit 1 }
    Write-Ok "SOURCE reachable -- schema dumped to a temp file"

    Write-Host "`nFirst 40 objects pg_restore would create:"
    & pg_restore --list "$tmpFile" | Select-Object -First 40 | ForEach-Object { Write-Host $_ }
    Remove-Item $tmpFile -ErrorAction SilentlyContinue

    Write-Host "`nChecking TARGET is reachable..."
    & psql "$env:TARGET_DATABASE_URL" -c "SELECT 1;" | Out-Null
    if ($LASTEXITCODE -ne 0) { Write-Fail "Could not connect to TARGET"; exit 1 }
    Write-Ok "TARGET reachable"

    Write-Host "`nDry run complete -- nothing was written to TARGET. Re-run without -DryRun for the real dump/restore."
    exit 0
}

Write-StepHeader "1. Dump SOURCE -> $BackupFile"
if (Test-Path $BackupFile) {
    Write-Fail "$BackupFile already exists -- remove or rename it first (refusing to silently overwrite a previous dump)"
    exit 1
}
& pg_dump "$env:SOURCE_DATABASE_URL" --no-owner --format=custom --file="$BackupFile"
if ($LASTEXITCODE -ne 0) { Write-Fail "pg_dump failed (exit $LASTEXITCODE)"; exit 1 }
Write-Ok "Dumped to $BackupFile ($((Get-Item $BackupFile).Length) bytes)"

Write-StepHeader "2. Restore into TARGET"
& pg_restore --no-owner --dbname="$env:TARGET_DATABASE_URL" "$BackupFile"
if ($LASTEXITCODE -ne 0) {
    Write-Fail "pg_restore reported errors (exit $LASTEXITCODE) -- review the output above before trusting TARGET. $BackupFile is untouched and SOURCE was never written to either way; re-run once the target's issue (existing conflicting objects, permissions) is fixed."
    exit 1
}
Write-Ok "Restore completed"

if ($SkipVerify) {
    Write-Warn "Skipping row-count verification (-SkipVerify) -- run step 3 manually before touching DATABASE_URL anywhere (docs/db-migration.md section 6)"
    exit 0
}

Write-StepHeader "3. Row-count verification per table"
$tableListQuery = "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename;"
$sourceTables = (& psql "$env:SOURCE_DATABASE_URL" -t -A -c $tableListQuery) | Where-Object { $_.Trim() -ne "" }

if (-not $sourceTables -or $sourceTables.Count -eq 0) {
    Write-Fail "Could not list tables from SOURCE -- check psql connectivity"
    exit 1
}

$mismatches = @()
foreach ($table in $sourceTables) {
    $table = $table.Trim()
    $countQuery = "SELECT COUNT(*) FROM `"$table`";"
    $sourceCount = (& psql "$env:SOURCE_DATABASE_URL" -t -A -c $countQuery).Trim()
    $targetCount = (& psql "$env:TARGET_DATABASE_URL" -t -A -c $countQuery).Trim()

    if ($sourceCount -eq $targetCount) {
        $status = "OK"
    } else {
        $status = "MISMATCH"
        $mismatches += $table
    }
    Write-Host ("{0,-30} source={1,-10} target={2,-10} {3}" -f $table, $sourceCount, $targetCount, $status)
}

if ($mismatches.Count -gt 0) {
    Write-Fail "Row-count mismatch on: $($mismatches -join ', ') -- DO NOT proceed to the DATABASE_URL swap (docs/db-migration.md section 6) until this is resolved"
    exit 1
}
Write-Ok "All $($sourceTables.Count) tables match row-for-row between SOURCE and TARGET"

Write-StepHeader "4. prisma migrate status against TARGET"
$env:DATABASE_URL = $env:TARGET_DATABASE_URL
npx prisma migrate status
Write-Warn "Confirm the line above reads 'Database schema is up to date' before doing the DATABASE_URL swap (docs/db-migration.md section 6) -- this script does not perform that swap."
