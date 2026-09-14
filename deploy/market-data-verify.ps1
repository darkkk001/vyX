<#
.SYNOPSIS
    S2 soak check for the Neon -> VPS market-data store: prints the engine's
    per-sink flush counters and a Neon-vs-local Candle count / newest-bucket
    table per timeframe. Read-only. Run on the Contabo box.
.EXAMPLE
    .\market-data-verify.ps1 -NeonUrl "postgresql://neondb_owner:...@ep-flat-boat-b1wjz20p.c-5.eu-central-1.aws.neon.tech/neondb?sslmode=require" -InternalSecret "<INTERNAL_SERVICE_SECRET>"
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]$NeonUrl,
    [Parameter(Mandatory)] [string]$InternalSecret,
    [string]$LocalUrl   = "postgresql://postgres@127.0.0.1:5432/market_data",   # PGPASSWORD in the env
    [string]$EngineUrl  = "http://127.0.0.1:8081",
    [string]$Psql       = "psql"
)
$ErrorActionPreference = "Stop"

Write-Host "== engine /internal/feed-stats" -ForegroundColor Cyan
$stats = Invoke-RestMethod "$EngineUrl/internal/feed-stats" -Headers @{ "x-internal-secret" = $InternalSecret }
$stats | Select-Object market_data_write, market_data_reader, ticks_in, queue_len, db_ok, db_fail, db_lag_ms, local_db_ok, local_db_fail, local_db_lag_ms | Format-List
if ($stats.local_db_fail -gt 0) { Write-Host "[WARN] local_db_fail = $($stats.local_db_fail) -- check the engine log for 'sink=local'" -ForegroundColor Yellow }

$q = 'SELECT timeframe::text AS tf, count(*) AS n, to_char(max("bucketStart") AT TIME ZONE ''UTC'', ''YYYY-MM-DD HH24:MI'') AS newest FROM "Candle" GROUP BY 1 ORDER BY 1;'
function Read-Table([string]$url) {
    $out = & $Psql $url -At -F '|' -c $q
    $h = @{}
    foreach ($line in $out) { if ($line) { $p = $line.Split('|'); $h[$p[0]] = @{ n = [int64]$p[1]; newest = $p[2] } } }
    return $h
}
Write-Host "== Candle per timeframe: neon vs local" -ForegroundColor Cyan
$neon  = Read-Table $NeonUrl
$local = Read-Table $LocalUrl
$rows = foreach ($tf in ($neon.Keys + $local.Keys | Sort-Object -Unique)) {
    $n = $neon[$tf]; $l = $local[$tf]
    [pscustomobject]@{
        tf          = $tf
        neon_n      = if ($n) { $n.n } else { 0 }
        local_n     = if ($l) { $l.n } else { 0 }
        diff        = (if ($l) { $l.n } else { 0 }) - (if ($n) { $n.n } else { 0 })
        neon_newest = if ($n) { $n.newest } else { "-" }
        local_newest= if ($l) { $l.newest } else { "-" }
        newest_ok   = if ($n -and $l) { $n.newest -eq $l.newest } else { $false }
    }
}
$rows | Format-Table -AutoSize
$lp = & $Psql $NeonUrl -At -c 'SELECT count(*) FROM "LivePrice";'
$ll = & $Psql $LocalUrl -At -c 'SELECT count(*) FROM "LivePrice";'
Write-Host "LivePrice rows: neon $lp / local $ll"
$size = & $Psql $LocalUrl -At -c "SELECT pg_size_pretty(pg_database_size('market_data'));"
Write-Host "local database size: $size"
if (($rows | Where-Object { -not $_.newest_ok }).Count -eq 0 -and $stats.local_db_fail -eq 0) {
    Write-Host "[OK] every timeframe's newest bucket matches and the local sink has no failures" -ForegroundColor Green
} else {
    Write-Host "[CHECK] see the table above -- a newest mismatch right after a restore is normal until the gap-fill catches up (minutes)" -ForegroundColor Yellow
}
