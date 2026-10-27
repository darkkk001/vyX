# S8 after-runs (Part A, owner 2026-10-27): N x (tenant reset -> S8 run -> settle -> capture the run's stop-out episodes),
# then p50 / p95 / max(delay_ms) and count(delay_ms > 1000) over every row of the accumulating TSV.
# The capture runs BEFORE the next reset, because --reset-trading deletes the tenant's PostCloseEffect rows. Nothing in the
# TSV is ever rewritten: each run appends its rows. The scenario itself (s8-stopout-contention.json) is not touched.
# Each row keeps the phase split too: created_at (database now() = the close transaction's start) and close_written_at
# (database clock after the close's own writes). tick -> tx start = the engine's detect + lane queue (engine and database
# clocks, apart by close_written_at - close_engine_at), tx start -> write = the database work.
#
#   powershell -ExecutionPolicy Bypass -File tools\shadow-bot\s8-after-loop.ps1                 # 4 runs, then the summary
#   powershell -ExecutionPolicy Bypass -File tools\shadow-bot\s8-after-loop.ps1 -SummaryOnly    # the summary of the TSV only
#
# Reads DATABASE_URL / DIRECT_URL from -EnvFile into this process only; never prints a URL or a password (the host only).
param(
  [int]$Runs = 4,
  [string]$OutDir = 'C:\vyx\handoff\s8-after',
  [string]$EnvFile = 'C:\vyx-secrets\env\D-vyX\.env.live',
  [string]$PasswordFile = 'C:\vyx-secrets\shadowbot-password.txt',
  [string]$SynthSecretFile = 'C:\shadow-bot-secrets\synth-feed-secret.txt',
  [string]$WebRepo = 'C:\vyx\web',
  [string]$Psql = 'C:\pg-scratch\pgsql\bin\psql.exe',
  [int]$SettleSecs = 30,
  [switch]$SummaryOnly
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$tsv = Join-Path $OutDir 's8-after-episodes.tsv'
$columns = 'run', 'login', 'account_id', 'tick_engine_at', 'close_engine_at', 'created_at', 'close_written_at', 'delay_ms', 'sl_tp_ahead', 'run_from', 'run_to'
New-Item -ItemType Directory -Force $OutDir | Out-Null

function Stamp { [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }
function Say([string]$text) { $line = "$(Stamp) $text"; Write-Host $line; Add-Content -Path (Join-Path $OutDir 'loop.log') -Value $line }

function Read-EnvValue([string]$name) {
  foreach ($line in Get-Content $EnvFile) {
    if ($line -match "^\s*$name\s*=\s*(.*)$") { return $Matches[1].Trim().Trim('"').Trim("'") }
  }
  throw "$name is not in the env file"
}

# DIRECT_URL for psql: the pooler URL carries Prisma-only parameters (pgbouncer, connection_limit) that psql refuses.
function Set-PgEnv([string]$url) {
  $u = [uri]$url
  $userInfo = $u.UserInfo.Split(':', 2)
  $env:PGHOST = $u.Host
  $env:PGPORT = if ($u.Port -gt 0) { "$($u.Port)" } else { '5432' }
  $env:PGDATABASE = $u.AbsolutePath.TrimStart('/')
  $env:PGUSER = [uri]::UnescapeDataString($userInfo[0])
  $env:PGPASSWORD = [uri]::UnescapeDataString($userInfo[1])
  $env:PGSSLMODE = 'require'
  $env:PGCHANNELBINDING = 'require'
  $env:PGTZ = 'UTC'
}

# The run's stop-out episodes: the FIRST stop-out close of each account per episode (a new episode = more than 60 s after
# its previous stop-out close), the same rule as sql/stopout-contention-capture.sql, limited to the scenario's accounts.
$captureSql = @'
SET TIME ZONE 'UTC';
WITH c AS (
  SELECT a."accountNumber" AS login, e."accountId" AS account_id, e.reason,
         (e.payload->>'engineDelayMs')::numeric AS delay_ms,
         (e.payload->>'triggerTickEngineAt')::timestamptz AS tick_engine_at,
         (e.payload->>'closeEngineAt')::timestamptz AS close_engine_at,
         e."createdAt" AS created_at,
         (e.payload->>'closeWrittenAt')::timestamptz AS close_written_at
  FROM "PostCloseEffect" e JOIN "Account" a ON a.id = e."accountId"
  WHERE e.kind = 'POSITION_CLOSED' AND e.payload ? 'triggerSource'
    AND e."createdAt" BETWEEN :'t_from'::timestamptz AND :'t_to'::timestamptz
    AND a."accountNumber" IN ('49990001', '49990002', '49990003', '49990004')
), s AS (
  SELECT * FROM (
    SELECT c.*, lag(close_engine_at) OVER (PARTITION BY account_id ORDER BY close_engine_at) AS prev_close
    FROM c WHERE reason = 'stop_out'
  ) x WHERE prev_close IS NULL OR close_engine_at - prev_close > interval '60 seconds'
)
SELECT s.login, s.account_id,
       to_char(s.tick_engine_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(s.close_engine_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(s.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       to_char(s.close_written_at, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
       s.delay_ms,
       (SELECT count(*) FROM c o WHERE o.account_id <> s.account_id AND o.reason IN ('stop_loss', 'take_profit')
          AND o.close_engine_at > s.tick_engine_at AND o.close_engine_at < s.close_engine_at)
FROM s ORDER BY s.tick_engine_at;
'@
$captureFile = Join-Path $OutDir 'capture-episodes.sql'
[IO.File]::WriteAllText($captureFile, $captureSql)

function Get-Episodes([string]$from, [string]$to) {
  $out = & $Psql -X -q -A -t -F "`t" -v ON_ERROR_STOP=1 -v "t_from=$from" -v "t_to=$to" -f $captureFile
  if ($LASTEXITCODE -ne 0) { throw "capture failed (psql exit $LASTEXITCODE)" }
  @($out | Where-Object { $_ -and $_.Trim() })
}

# percentile_cont: linear interpolation between the closest ranks, as Postgres does
function Get-Percentile([double[]]$sorted, [double]$p) {
  if ($sorted.Count -eq 0) { return $null }
  $rank = $p * ($sorted.Count - 1)
  $lo = [Math]::Floor($rank); $hi = [Math]::Ceiling($rank)
  $sorted[$lo] + ($sorted[$hi] - $sorted[$lo]) * ($rank - $lo)
}

function Write-Summary {
  if (-not (Test-Path $tsv)) { throw "no TSV yet: $tsv" }
  $rows = @(Import-Csv -Path $tsv -Delimiter "`t")
  $d = [double[]]@($rows | ForEach-Object { [double]$_.delay_ms } | Sort-Object)
  $ahead = @($rows | ForEach-Object { [double]$_.sl_tp_ahead })
  $n = $d.Count
  $p50 = [Math]::Round((Get-Percentile $d 0.5)); $p95 = [Math]::Round((Get-Percentile $d 0.95)); $max = $d[-1]
  $aheadAvg = [Math]::Round(($ahead | Measure-Object -Average).Average, 1)
  $over = @($d | Where-Object { $_ -gt 1000 }).Count
  $runsSeen = @($rows | ForEach-Object { $_.run } | Sort-Object -Unique).Count
  $gate = if ($n -gt 0 -and $p95 -lt 500 -and $over -eq 0) { 'PASS' } else { 'FAIL' }
  $md = @"
# S8 stop-out delay: before / after

| row | engine | episodes | p50 ms | p95 ms | max ms | SL/TP closes ahead (avg) | over 1 s |
|---|---|---|---|---|---|---|---|
| before (documented, s8-stopout-contention-results.md) | 0d6760e8 | 3 | 8615 | 11041 | 11310 | 112.7 | 3/3 |
| after ($runsSeen runs, $tsv) | new (Part A) | $n | $p50 | $p95 | $max | $aheadAvg | $over/$n |

Section 9 gate (after p95 < 500 ms and over 1 s = 0/$n): **$gate**

Generated $(Stamp) by tools/shadow-bot/s8-after-loop.ps1 from every row of the TSV.
"@
  $summaryFile = Join-Path $OutDir 's8-after-summary.md'
  [IO.File]::WriteAllText($summaryFile, $md)
  Write-Host $md
}

if ($SummaryOnly) { Write-Summary; return }

$dbUrl = Read-EnvValue 'DATABASE_URL'
$env:DATABASE_URL = $dbUrl
$env:DIRECT_URL = Read-EnvValue 'DIRECT_URL'
Set-PgEnv $env:DIRECT_URL
$dbHost = ([uri]$dbUrl).Host
if (-not $env:SYNTH_FEED_SECRET_FILE) { $env:SYNTH_FEED_SECRET_FILE = $SynthSecretFile }
if (-not (Test-Path $env:SYNTH_FEED_SECRET_FILE)) { throw 'the synth-feed secret file is missing: set SYNTH_FEED_SECRET_FILE or -SynthSecretFile' }
if (Test-Path $PasswordFile) { $env:SHADOWBOT_PASSWORD = (Get-Content $PasswordFile -Raw).Trim() }
Say "database: $dbHost; scenario commit $(git -C $repo rev-parse --short HEAD); TSV $tsv"

if (-not (Test-Path $tsv)) { [IO.File]::WriteAllText($tsv, ($columns -join "`t") + "`n") }
# a TSV from before the phase columns is left as it is: its rows would not line up with the new ones
if ((Get-Content $tsv -TotalCount 1) -ne ($columns -join "`t")) { throw "$tsv has other columns (an older loop's file); keep it and pass a new -OutDir" }
$lastRun = @(Import-Csv -Path $tsv -Delimiter "`t" | ForEach-Object { [int]$_.run } | Sort-Object)
$firstRun = if ($lastRun.Count) { $lastRun[-1] + 1 } else { 1 }
# whatever the tenant still holds from earlier runs (the last 24 h) is kept in a file of its own before the first reset
$prior = Get-Episodes ([DateTime]::UtcNow.AddHours(-24).ToString('o')) (Stamp)
if ($prior.Count) {
  $priorFile = Join-Path $OutDir ("pre-reset-{0}.tsv" -f [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ'))
  [IO.File]::WriteAllText($priorFile, (@($columns[1..($columns.Count - 3)] -join "`t") + $prior) -join "`n")
  Say "kept $($prior.Count) earlier episode(s) in $priorFile (not part of the TSV)"
}

for ($run = $firstRun; $run -lt $firstRun + $Runs; $run++) {
  $log = Join-Path $OutDir ("run-{0:D2}" -f $run)

  Say "run ${run}: tenant reset"
  Push-Location $WebRepo
  try { cmd /c "npx tsx scripts/seed-zzshadowbot.ts --reset-trading --apply --confirm-host=$dbHost > `"$log-reset.log`" 2>&1" }
  finally { Pop-Location }
  if ($LASTEXITCODE -ne 0) { Say "run ${run}: reset FAILED (exit $LASTEXITCODE), see $log-reset.log; stopping"; exit 1 }

  $from = Stamp
  Say "run ${run}: S8 start"
  Push-Location $repo
  try { cmd /c "npx tsx tools/shadow-bot/bot.ts run s8-stopout-contention --flatten-first > `"$log-bot.log`" 2>&1" }
  finally { Pop-Location }
  $botExit = $LASTEXITCODE
  Say "run ${run}: S8 end (exit $botExit); settling $SettleSecs s"
  Start-Sleep -Seconds $SettleSecs
  $to = Stamp

  # capture before the next reset deletes the rows; read once more if the engine's last rows are still on their way
  $episodes = Get-Episodes $from $to
  if ($episodes.Count -lt 3) { Start-Sleep -Seconds $SettleSecs; $to = Stamp; $episodes = Get-Episodes $from $to }
  foreach ($e in $episodes) { Add-Content -Path $tsv -Value ("$run`t$e`t$from`t$to") }
  Say "run ${run}: $($episodes.Count) episode(s) appended"

  if ($botExit -ne 0 -or $episodes.Count -ne 3) {
    Say "run ${run}: scenario exit $botExit, $($episodes.Count) episode(s) instead of 3; stopping (see $log-bot.log)"
    Write-Summary
    exit 1
  }
}
Write-Summary
