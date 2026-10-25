# Engine deploy for the trigger-tick capture (owner go needed, NOT run): ships the 6.1 gate input "measured touch-to-write delay and
# slippage" (docs/RUST-CUTOVER-PLAN.md 6.1, docs/BACKEND-NEEDED.md) to the engine that is LIVE IN RISK MODE. Market-closed window.
#   What this build adds: every engine close (SL / TP / stop-out) writes the tick it was priced at into its POSITION_CLOSED follow-up
#   payload: triggerBid / triggerAsk / triggerTickAt (feed clock) / triggerPriceSource / triggerSource, triggerTickEngineAt + closeEngineAt
#   (the engine's own clock) and engineDelayMs between them (THE delay: one clock, no feed / database skew), closeWrittenAt (database clock,
#   reference). No schema change, no web change (the web reads the payload by a plain cast). Nothing else changes: risk mode, the per-broker
#   authority, the heartbeat, the deal write, NBP-on-last-close and every env var stay exactly as they are.
#   The payload INSERT now ends in `$7::jsonb || jsonb_build_object('closeWrittenAt', to_char(clock_timestamp() ...))`: a failure there
#   would fail EVERY engine close, so this script proves that insert (rolled back, as the engine's own role) BEFORE it stops the old engine
#   and again after the new one is up.
# Run on the VPS in an elevated PowerShell, from the repo, AFTER checking out the code the owner approved (the merge commit on main):
#   cd C:\vyxtrader\repo; git fetch --all; git checkout --detach <full sha>
#   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\repo\deploy\engine-trigger-tick.ps1 -Branch main -Commit <full sha> -OwnerGo "main@<full sha>"
#
# NO PIN IN THE FILE, NO DEFAULT THAT PASSES. The script takes the branch and the 40-character commit as parameters and refuses (one line,
# exit code 1, nothing touched, nothing built) unless ALL of these hold:
#   - -Branch, -Commit and -OwnerGo are all given;
#   - -OwnerGo is exactly "<Branch>@<Commit>" (case-sensitive): the owner's explicit go for that exact code;
#   - the checked-out HEAD equals -Commit;
#   - -Commit is on -Branch (an ancestor of the local branch or of any remote's branch of that name).
# -RepoPath (default C:\vyxtrader\repo) exists so the refusals can be tested against another checkout without deploying.
#
# Downtime: the stop / swap / start only (the build runs in a separate target dir while the old engine serves). The engine is the risk
# authority of every RUST broker: while it is down its heartbeat goes stale after staleAfterSecs (30 s) and the web takes those accounts
# over (engine-down watchdog), so a short gap is covered. Market-closed window (owner).
# Stops by itself (and puts the previous exe back) if the build fails, the exe cannot be swapped, /health does not answer, the heartbeat is
# not fresh within 30 s, the startup log shows RISK MODE REFUSED / a shadow or legacy mode / the flip-marker WARNING / a missing required
# line, or a post-start smoke check (payload write, deal write) fails.
# The smoke checks: BEGIN; INSERT (the engine's own statement shape) for the newest position, RETURNING; ROLLBACK. Nothing stays, except that
# a sequence is not transactional: each deal smoke check uses up one deal ticket (two per deploy; tickets may have gaps).
param(
  [string]$Branch = "",
  [string]$Commit = "",
  [string]$OwnerGo = "",
  [string]$RepoPath = "C:\vyxtrader\repo",
  [string]$Psql = "psql"
)
$ErrorActionPreference = "Stop"
$Nssm   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"   # nssm is not on the VPS PATH: always the full path
$Fix    = $Commit
$Repo   = $RepoPath
$Stamp  = Get-Date -Format yyyyMMdd-HHmmss
$Bk     = "C:\vyxtrader\backup\engine-trigger-tick-$Stamp"

# ---- GATE: the owner's explicit go for exactly this branch + commit; every refusal is one line, exit 1, nothing touched ----
function Refuse([string]$Reason) { Write-Host "REFUSED: $Reason. Nothing touched."; exit 1 }
if (-not $Branch -or -not $Commit -or -not $OwnerGo) { Refuse "-Branch, -Commit and -OwnerGo are all required (OwnerGo = '<Branch>@<full commit sha>')" }
if ($Commit -cnotmatch '^[0-9a-f]{40}$') { Refuse "-Commit must be the full 40-character lower-case sha" }
if ($OwnerGo -cne "$Branch@$Commit") { Refuse "-OwnerGo does not equal '<Branch>@<Commit>': the owner's go is missing or for other code" }
if (-not (Test-Path "$Repo\.git")) { Refuse "$Repo is not a git checkout" }
Set-Location $Repo
$headSha = (& git rev-parse HEAD 2>$null) -join ""
if ($headSha -cne $Commit) { Refuse "checked-out HEAD ($(if ($headSha) { $headSha.Substring(0, [Math]::Min(7, $headSha.Length)) } else { 'unknown' })) is not -Commit ($($Commit.Substring(0, 7)))" }
$onBranch = $false
foreach ($ref in @(& git for-each-ref --format="%(refname)" "refs/heads/$Branch" "refs/remotes/*/$Branch" 2>$null)) {
  & git merge-base --is-ancestor $Commit $ref 2>$null
  if ($LASTEXITCODE -eq 0) { $onBranch = $true; break }
}
if (-not $onBranch) { Refuse "commit $($Commit.Substring(0, 7)) is not on branch '$Branch' (git fetch --all first?)" }
"owner go accepted: $Branch@$($Commit.Substring(0, 7)), HEAD equals it"

function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
function Get-NssmValue([string]$Svc, [string]$Key) { ((& $Nssm get $Svc $Key) -join "" -replace "`0", "").Trim() }
function Get-Code([string]$Url) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec 8).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}

# ---- STEP 0: the engine is in RISK mode with its flip marker, and the database takes the new payload write (nothing touched yet) ----
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
if (-not (Test-Path $EngineCmd)) { Refuse "$EngineCmd not found" }
$cmdLines = Get-Content $EngineCmd
function Get-CmdValue([string]$Name) {
  $line = $cmdLines | Where-Object { $_ -match "^\s*set\s+`"?$Name=" } | Select-Object -Last 1
  if (-not $line) { return $null }
  ($line -replace "^\s*set\s+`"?$Name=", '' -replace '"\s*$', '').Trim()
}
$mode = Get-CmdValue 'ENGINE_ORDER_MANAGEMENT'
if ($mode -ne 'risk') { Refuse "start-engine.cmd says ENGINE_ORDER_MANAGEMENT=$mode, not risk: this deploy is for the engine in risk mode" }
$intent = Get-CmdValue 'VYX_RISK_FLIP_INTENT'
if (-not $intent -or $intent -cnotmatch '^[a-z0-9-]+:\d{4}-\d{2}-\d{2}$') { Refuse "start-engine.cmd has no valid VYX_RISK_FLIP_INTENT (<broker subdomain>:<YYYY-MM-DD>); the new engine would print the flip-marker WARNING" }
"start-engine.cmd: ENGINE_ORDER_MANAGEMENT=risk, VYX_RISK_FLIP_INTENT=$intent"
# the engine's own database URL (never printed): start-engine.cmd, else the service's environment
$DbUrl = Get-CmdValue 'DATABASE_URL'
if (-not $DbUrl) {
  $envExtra = (& $Nssm get vyxtrader-engine AppEnvironmentExtra) -join "`n" -replace "`0", ""
  $m = [regex]::Match($envExtra, '(?m)^DATABASE_URL=(.+)$'); if ($m.Success) { $DbUrl = $m.Groups[1].Value.Trim() }
}
if (-not $DbUrl) { Refuse "the engine's DATABASE_URL is neither in start-engine.cmd nor in the service environment" }
$dbHost = ([uri]($DbUrl -replace '^postgres(ql)?://', 'http://')).Host
"engine database host: $dbHost"
if (-not (Get-Command $Psql -ErrorAction SilentlyContinue)) { Refuse "psql not found ('$Psql'); pass -Psql <full path to psql.exe>" }

function Invoke-Sql([string]$Sql) {
  $f = Join-Path $env:TEMP "engine-trigger-tick-$Stamp-$([guid]::NewGuid().ToString('N')).sql"
  Set-Content -Path $f -Value $Sql -Encoding ascii
  try { Invoke-Native { & $Psql -X -q -At -v ON_ERROR_STOP=1 -f $f -d $DbUrl } } finally { Remove-Item $f -ErrorAction SilentlyContinue }
}
# the engine's POSITION_CLOSED insert (engine/order-management/src/book.rs enqueue_post_close: the same columns and the same payload
# expression, closeWrittenAt appended by the database), on the newest position, rolled back
$PayloadSmokeSql = @'
BEGIN;
INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
SELECT 'deploy-smoke-' || md5(random()::text), 'POSITION_CLOSED', 'deploy-smoke:' || md5(random()::text), p."brokerId", p."accountId", p.id, 'stop_loss',
       '{"triggerSource":"pass","closeEngineAt":"2026-01-01T00:00:00.000Z","engineDelayMs":0}'::jsonb
         || jsonb_build_object('closeWrittenAt', to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
  FROM "Position" p ORDER BY p."openedAt" DESC LIMIT 1
RETURNING 'payload-smoke closeWrittenAt ' || (payload->>'closeWrittenAt');
ROLLBACK;
'@
function Test-PayloadWrite {
  $out = Invoke-Sql $PayloadSmokeSql
  $hit = $out | Where-Object { $_ -match '^payload-smoke closeWrittenAt \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' } | Select-Object -First 1
  if ($hit) { return "$hit (rolled back)" }
  return $null
}
# the engine's deal insert (unchanged by this build, still required by every close), on the newest position, rolled back
$DealSmokeSql = @'
BEGIN;
INSERT INTO "Deal" (id, "brokerId", "accountId", "positionId", "symbolId", side, entry, reason, volume, price, profit, swap, "byPositionId", "transactionId", "executedAt")
SELECT 'deploy-smoke-' || md5(random()::text), p."brokerId", p."accountId", p.id, p."symbolId", p.side, 'OUT'::"DealEntry", 'SL'::"DealReason", 0, p."openPrice", 0, 0, NULL, NULL, now()
  FROM "Position" p ORDER BY p."openedAt" DESC LIMIT 1
RETURNING 'deal-smoke ticket ' || ticket;
ROLLBACK;
'@
function Test-DealWrite {
  $out = Invoke-Sql $DealSmokeSql
  $hit = $out | Where-Object { $_ -match '^deal-smoke ticket \d+$' } | Select-Object -First 1
  if ($hit) { return "$hit (rolled back)" }
  return $null
}
$pre = Test-PayloadWrite
if (-not $pre) { Refuse "the POSITION_CLOSED payload smoke check failed on the engine's database (as the engine's role): $((Invoke-Sql $PayloadSmokeSql) -join ' / ')" }
"pre-flight: payload write OK as the engine's role: $pre"
$preDeal = Test-DealWrite
if (-not $preDeal) { Refuse "the deal-write smoke check failed on the engine's database: $((Invoke-Sql $DealSmokeSql) -join ' / ')" }
"pre-flight: deal write OK as the engine's role: $preDeal"
$owners = Invoke-Sql @'
SELECT string_agg(subdomain || '=' || "riskAuthority"::text || CASE WHEN "riskAuthorityDemoOnly" THEN ' (demo only)' ELSE '' END, ', ' ORDER BY subdomain) FROM "Broker" WHERE "riskAuthority"::text = 'RUST';
'@
"engine-owned brokers now: $(if ($owners -and ($owners -join '').Trim()) { $owners -join '' } else { 'none (every broker WEB)' })"
New-Item -ItemType Directory -Force $Bk | Out-Null

# ---- STEP 1: the checked-out code is the approved commit: the trigger-tick capture, and everything live today it builds on ----
Set-Location $Repo
$head = (Invoke-Native { git rev-parse HEAD }) -join ""
if ($head -cne $Fix) { throw "HEAD $($head.Substring(0,7)) is not the approved commit $($Fix.Substring(0,7)). Nothing touched" }
$must = @(
  # this build: the trigger tick (2026-10-23)
  @("order-management\src\book.rs", 'pub struct TriggerTick', "trigger tick of a close (trigger-tick capture)"),
  @("order-management\src\book.rs", '"triggerTickEngineAt"', "engine-clock receive time in the payload (trigger-tick capture)"),
  @("order-management\src\book.rs", '"engineDelayMs"', "engine-clock delay in the payload (trigger-tick capture)"),
  @("order-management\src\book.rs", "jsonb_build_object('closeWrittenAt'", "database-clock write time in the payload (trigger-tick capture)"),
  @("order-management\src\db.rs", 'pub struct QuoteStamp', "price source and tick time per position (trigger-tick capture)"),
  @("order-management\src\monitor.rs", 'received: fire.received', "a live fire hands its receive times to the evaluation (trigger-tick capture)"),
  @("market-data\src\risk_hook.rs", 'pub received: HashMap', "a live fire carries the engine's receive time (trigger-tick capture)"),
  @("server\src\main.rs", 'engine build: commit', "the engine logs and serves its build commit (owner 2026-10-26)"),
  @("market-data\src\cache.rs", 'pub fn latest_received', "the tick cache keeps the engine's own receive time, not the feed's (trigger-tick receive-time fix)"),
  # live today, must not be lost: NBP on the last close + margin-call hysteresis (2026-10-22), deal model, Stage 6, 10-05
  @("order-management\src\book.rs", 'protect_nbp: bool, last_position: bool', "NBP only on the last close (2026-10-22)"),
  @("order-management\src\monitor.rs", 'fn margin_call_edge_at', "margin-call hysteresis (2026-10-22)"),
  @("order-management\src\book.rs", 'INSERT INTO "Deal"', "the close writes its deal (deal model)"),
  @("order-management\src\reconcile.rs", 'fn kind_from_deal_reason', "reconcile from Deal.reason (deal model)"),
  @("order-management\src\authority.rs", 'pub async fn lock_owner_in_tx', "in-transaction owner check (Stage 6)"),
  @("order-management\src\authority.rs", 'pub async fn verify_risk_pool', "risk-mode pool check (Stage 6)"),
  @("order-management\src\authority.rs", 'pub async fn beat', "heartbeat writer (Stage 6)"),
  @("order-management\src\authority.rs", 'pub fn flip_marker_warning', "startup flip-marker warning (Stage 6)"),
  @("order-management\src\monitor.rs", 'pub fn spawn_live_trigger', "live fire worker (Stage 6)"),
  @("order-management\src\monitor.rs", 'pub fn spawn_risk_passes', "risk passes (Stage 6)"),
  @("order-management\src\calc.rs", 'REPEATABLE READ, READ ONLY', "torn-read snapshot (10-05)"),
  @("market-data\src\pricing.rs", 'pub struct PricingCache', "pricing cache (10-05)")
)
foreach ($m in $must) {
  if (-not (Select-String -Path "$Repo\engine\$($m[0])" -Pattern $m[1] -SimpleMatch -Quiet)) { throw "$($m[2]) missing ($($m[1]) in $($m[0])): nothing built" }
}
"HEAD $($head.Substring(0,7)) is the approved commit $($Fix.Substring(0,7)) on ${Branch}: trigger-tick capture, NBP / hysteresis, deal write and Stage 6 code present"

# ---- STEP 2: build (the running exe keeps serving until the swap) ----
$LiveExe  = "$Repo\engine\target\release\trading-core-server.exe"
$BuildDir = "$Repo\engine\build-tmp"
$BuiltExe = "$BuildDir\release\trading-core-server.exe"
Copy-Item $LiveExe "$Bk\trading-core-server.pre.exe"
Copy-Item $EngineCmd "$Bk\start-engine.cmd.pre"   # for the record only: this script never edits it
Set-Location "$Repo\engine"
$env:CARGO_TARGET_DIR = $BuildDir
Invoke-Native { cargo build --release -p server } -Tail 3
$buildExit = $LASTEXITCODE
Remove-Item Env:\CARGO_TARGET_DIR
if ($buildExit -ne 0) { throw "build failed (exit $buildExit): the old engine is still running, nothing restarted" }
$newHash = (Get-FileHash $BuiltExe -Algorithm SHA256).Hash
"built: sha256 $($newHash.Substring(0,16))"

# ---- STEP 3: swap + start ----
function Restore([string]$why) {
  Invoke-Native { & $Nssm stop vyxtrader-engine } | Out-Null
  Start-Sleep 2
  Copy-Item "$Bk\trading-core-server.pre.exe" $LiveExe -Force -ErrorAction SilentlyContinue
  Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
  throw "${why}: the previous exe was put back and started. Backup: $Bk"
}
$log = Get-NssmValue vyxtrader-engine AppStdout; $err = Get-NssmValue vyxtrader-engine AppStderr
# only the lines written after this restart count (the logs are appended to; an old OK line must not mask a failure)
$logFiles = @($log, $err) | Where-Object { $_ -and (Test-Path -LiteralPath $_ -ErrorAction SilentlyContinue) } | Select-Object -Unique
$startAt = @{}; foreach ($f in $logFiles) { $startAt[$f] = @(Get-Content $f).Count }
Invoke-Native { & $Nssm stop vyxtrader-engine } | Out-Null
# the restart time on the DATABASE clock, taken once the old engine is stopped (no clock skew with the VPS; a beat after it is the new engine's)
$restartAt = ((Invoke-Sql "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US');") -join "").Trim()
if ($restartAt -notmatch '^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$') {
  Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
  throw "could not read the database clock after stopping the engine ($restartAt): the OLD exe was started again, nothing swapped. Backup: $Bk"
}
$restartTs = "('$restartAt'::timestamp AT TIME ZONE 'UTC')"
$copied = $false
foreach ($try in 1..10) { try { Copy-Item $BuiltExe $LiveExe -Force -ErrorAction Stop; $copied = $true; break } catch { Start-Sleep 1 } }
if (-not $copied -or (Get-FileHash $LiveExe -Algorithm SHA256).Hash -ne $newHash) { Restore "could not put the new exe in place" }
Invoke-Native { & $Nssm start vyxtrader-engine } | Out-Null
$healthy = $false
foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8081/health") -eq 200) { $healthy = $true; break }; Start-Sleep 1 }
if (-not $healthy) { Restore "the new engine did not answer /health within 30 s" }
# the running engine says which commit it was built from (x-vyx-engine-commit): it must be exactly the approved one
$served = ""
try { $served = (Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:8081/health" -TimeoutSec 8).Headers["x-vyx-engine-commit"] } catch { }
if ("$served" -cne $Fix) { Restore "the running engine reports commit '$served', not the approved $Fix" }
"  OK  /health x-vyx-engine-commit = $($Fix.Substring(0,7)) (the approved commit)"
"engine up: /health 200 (sha256 $($newHash.Substring(0,16)))"

# ---- STEP 4: the heartbeat is fresh again (the web hands the RUST accounts back to the engine) ----
$fresh = $false
foreach ($i in 1..30) {
  $age = (Invoke-Sql "SELECT floor(extract(epoch FROM now() - ""beatAt""))::int || '|' || ""staleAfterSecs"" FROM ""RiskEngineHeartbeat"" WHERE name = 'risk' AND ""beatAt"" >= $restartTs;") -join ""
  if ($age -match '^(\d+)\|(\d+)$' -and [int]$Matches[1] -lt [int]$Matches[2]) { $fresh = $true; "heartbeat: beat $($Matches[1]) s ago, after the restart (stale after $($Matches[2]) s)"; break }
  Start-Sleep 1
}
if (-not $fresh) { Restore "no fresh risk heartbeat from the new engine within 30 s" }
Start-Sleep 10

# ---- STEP 5: the startup log (this start only): RISK MODE ACTIVE and its lines, nothing of shadow / legacy / refusal ----
$pattern = 'engine build: commit|risk mode:|RISK MODE|risk heartbeat|post-close outbox dispatcher|post-close dispatcher|order management|SHADOW REFUSED|shadow reconciler|risk hook|risk trigger loop|pricing cache|WARNING: ENGINE_ORDER_MANAGEMENT|flip marker|idle gate'
$found = @()
foreach ($f in $logFiles) {
  $all = @(Get-Content $f); $from = if ($all.Count -ge $startAt[$f]) { $startAt[$f] } else { 0 }   # a rotated (shorter) file is read whole
  $found += $all | Select-Object -Skip $from | Select-String -Pattern $pattern | ForEach-Object { $_.Line -replace "$([char]27)\[[0-9;]*m", '' }
}
"startup lines (this start only):"; $found | ForEach-Object { "  $_" }
$bad = [ordered]@{
  'RISK MODE REFUSED'                                   = "RISK MODE REFUSED in the startup log"
  'risk mode: the post-close dispatcher could not be'   = "the post-close dispatcher could not be configured"
  'risk heartbeat: the first beat failed'               = "the first heartbeat failed"
  'risk heartbeat PAUSED'                               = "the heartbeat drill file is present (the web would own every RUST account)"
  'WARNING: ENGINE_ORDER_MANAGEMENT'                    = "the flip-marker warning fired"
  'order management SHADOW|SHADOW REFUSED'              = "shadow mode started: the wrong mode is running"
  'order management ENABLED|order management OFF'       = "legacy or no order management started: the wrong mode is running"
  'risk hook OFF|risk hook margin trigger OFF'          = "the risk hook or its margin trigger is off"
}
foreach ($k in $bad.Keys) { if ($found -match $k) { Restore $bad[$k] } }
$checks = [ordered]@{
  "risk mode: pool writable"              = 'risk mode: the pool is writable'
  "risk heartbeat written"                = 'risk heartbeat: written|risk heartbeat: staleAfterSecs'
  "post-close outbox dispatcher running"  = 'post-close outbox dispatcher running'
  "RISK MODE ACTIVE"                      = 'RISK MODE ACTIVE'
  "engine-owned margin fires live"        = 'risk mode: margin fires of engine-owned accounts'
  "per-tick margin trigger enabled"       = 'risk hook margin trigger enabled'
  "risk trigger loop decoupled"           = 'risk trigger loop: decoupled from the LivePrice write'
  "pricing cache loaded"                  = 'pricing cache loaded'
  "pricing cache reload on change"        = 'pricing cache: reload on change subscribed'
  "build commit = the approved commit"    = "engine build: commit $Fix"
}
foreach ($k in $checks.Keys) {
  if ($found -match $checks[$k]) { "  OK  $k" } else { Restore "missing in the startup log: $k" }
}

# ---- STEP 6: smoke checks against the running database; engine closes since the restart carry the trigger tick ----
$post = Test-PayloadWrite
if (-not $post) { Restore "the POSITION_CLOSED payload smoke check failed after the restart" }
"  OK  payload write: $post"
$postDeal = Test-DealWrite
if (-not $postDeal) { Restore "the deal-write smoke check failed after the restart" }
"  OK  deal write: $postDeal"
# an engine close queues a POSITION_CLOSED row in its own transaction; since the restart every one must carry the new keys. Market closed:
# usually 0 rows here, so the first real close is checked by hand (the verification query printed below), not by this script.
$tt = (Invoke-Sql "SELECT count(*) || '|' || count(*) FILTER (WHERE payload ? 'engineDelayMs' AND payload ? 'triggerTickAt' AND payload ? 'closeWrittenAt') FROM ""PostCloseEffect"" WHERE kind = 'POSITION_CLOSED' AND ""createdAt"" >= $restartTs;") -join ""
if ($tt -match '^(\d+)\|(\d+)$') {
  if ([int]$Matches[1] -gt [int]$Matches[2]) { Restore "$([int]$Matches[1] - [int]$Matches[2]) of $($Matches[1]) engine close(s) since the restart have no trigger tick: the new code is not the one closing" }
  "  OK  engine closes since the restart with the trigger tick: $($Matches[2]) of $($Matches[1])"
} else { "  WARN could not count the engine closes since the restart ($tt): check by hand" }

# ---- STEP 7: the new exe is the one running ----
$proc = Get-Process -Name trading-core-server -ErrorAction SilentlyContinue | Select-Object -First 1
$exeTime = (Get-Item $LiveExe).LastWriteTime
if ($proc) { "running pid $($proc.Id) started $($proc.StartTime); exe written $exeTime; new exe running: $($proc.StartTime -gt $exeTime)" } else { "  WARN no trading-core-server process found by name: check nssm status" }
"DEPLOY OK (risk mode ACTIVE, engine closes record their trigger tick). Backup: $Bk"
"First real engine close (an SL on a demo account of a RUST broker), check by hand, every column filled and engine_delay_ms small:"
"  SELECT ""createdAt"", reason, payload->>'triggerSource' AS src, payload->>'triggerPriceSource' AS price_src, payload->>'triggerTickAt' AS tick_feed,"
"         payload->>'triggerTickEngineAt' AS tick_engine, payload->>'closeEngineAt' AS close_engine, (payload->>'engineDelayMs')::int AS engine_delay_ms,"
"         payload->>'closeWrittenAt' AS close_db, payload->>'closePrice' AS fill"
"    FROM ""PostCloseEffect"" WHERE kind = 'POSITION_CLOSED' AND ""createdAt"" >= $restartTs ORDER BY ""createdAt"";"
"Rollback (only if needed): nssm stop vyxtrader-engine; copy $Bk\trading-core-server.pre.exe over $LiveExe; nssm start vyxtrader-engine. The old engine writes no trigger tick: its closes are simply not measured."
