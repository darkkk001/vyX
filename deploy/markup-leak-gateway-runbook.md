# Markup-leak hotfix: VPS gateway runbook (rollout step 3)

Commit `0e95d8e` (branch `markup-leak`, merged to `main`). This page covers only the **api-gateway** on the VPS
(nssm service `vyxtrader-gateway`, `node dist\index.js` from `C:\vyxtrader\repo\services\api-gateway`, port 8080).
The engine is not rebuilt or restarted.

## Order of the whole rollout

1. Migration `20261005090000_broker_client_ask_server_side` applied on ep-morning-glade (the coordinator does this).
   **It must be applied before this gateway starts.** The new gateway's ask-rule query reads
   `Broker."clientAskServerSideAt"`. Without the column, the query fails, and a trader socket whose rules never load
   gets **no ticks**.
2. Web deploy of `main` (the coordinator does this).
3. **This runbook**: gateway build and restart on the VPS.
4. Only after the owner confirms step 3 is healthy: `UPDATE "Broker" SET "clientAskServerSideAt" = now()` per broker
   (the coordinator does this).

**Until step 4, the new gateway behaves exactly like the old one.** Every trader socket gets the raw tick, the same
bytes as today. The only difference is that the gateway reads each trader account's ask rules from the main database
when the socket connects, and again at most every 15 s while ticks flow. Step 4 flips the stream for that broker, and
`/api/trade/prices` follows within 15 s.

A restart drops every price-stream socket for a few seconds. Terminals and WebTrader reconnect on their own.

## Rules

- Run in an **elevated** Windows PowerShell on the VPS. Paste one block at a time.
- Nothing below prints a secret or an env value. Values are read into variables, and only a length, a host id
  (`ep-...`) or a yes/no is shown. Do not add `Get-Content start-gateway.cmd`, `nssm get ... AppEnvironmentExtra` or
  `$env:...` echoes.
- `nssm` is not on the VPS PATH. Always use `$Nssm` (the full path).

## 0. Setup (paste first; prints nothing secret)

```powershell
$ErrorActionPreference = "Stop"
$Nssm    = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$Repo    = "C:\vyxtrader\repo"
$Gw      = "$Repo\services\api-gateway"
$GwCmd   = "C:\vyxtrader\scripts\start-gateway.cmd"
$Bk      = "C:\vyxtrader\backup\markup-leak-" + (Get-Date -Format "yyyyMMdd-HHmmss")
function Invoke-Native([scriptblock]$Command, [int]$Tail = 0) {
  $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
  try { $out = & $Command 2>&1 | ForEach-Object { "$_" }; if ($Tail -gt 0) { $out | Select-Object -Last $Tail } else { $out } }
  finally { $ErrorActionPreference = $prev }
}
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
function Get-Code([string]$Url, [hashtable]$Headers) {
  try { (Invoke-WebRequest -UseBasicParsing -Uri $Url -Headers $Headers -TimeoutSec 5).StatusCode }
  catch { if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 } }
}
function Get-GwLog { ((& $Nssm get vyxtrader-gateway AppStdout) -join "") -replace "`0", "" }   # a file path, not a secret
New-Item -ItemType Directory -Force $Bk | Out-Null
"backup dir: $Bk"
& $Nssm status vyxtrader-gateway
```

Expected: `SERVICE_RUNNING`.

## 1. Get the code (main, fast-forward only)

```powershell
Set-Location $Repo
$PreHead = (git rev-parse HEAD).Trim(); "pre HEAD: $PreHead  branch: $((git rev-parse --abbrev-ref HEAD).Trim())"
$PreHead | Set-Content "$Bk\pre-head.txt"
if (git status --porcelain) { throw "working tree not clean -- stop and report, nothing touched" }
Invoke-Native { git fetch --all } -Tail 3
Invoke-Native { git checkout main } -Tail 2
Invoke-Native { git pull --ff-only } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "git pull --ff-only failed -- nothing touched" }
git log --oneline -3
Invoke-Native { git merge-base --is-ancestor 0e95d8e HEAD }
if ($LASTEXITCODE -ne 0) { throw "main does not contain 0e95d8e yet -- wait for the push, nothing touched" }
if (-not (Test-Path "$Gw\src\client-ask.ts")) { throw "src\client-ask.ts missing -- nothing touched" }
"OK: main contains 0e95d8e"
```

## 2. Back up the running build (for rollback)

```powershell
Copy-Item -Recurse -Force "$Gw\dist" "$Bk\gateway-dist"
Copy-Item -Force $GwCmd "$Bk\start-gateway.cmd"
"backed up dist ($((Get-ChildItem "$Bk\gateway-dist" -Recurse -File).Count) files) + start-gateway.cmd"
```

## 3. Build (the old gateway keeps serving meanwhile)

```powershell
Set-Location $Gw
Invoke-Native { npm ci } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "npm ci failed -- nothing restarted (old dist still in place)" }
Invoke-Native { npm test } -Tail 6
if ($LASTEXITCODE -ne 0) { throw "gateway tests failed -- nothing restarted" }
Invoke-Native { npm run build } -Tail 3
if ($LASTEXITCODE -ne 0) { throw "build failed -- nothing restarted; restore dist from $Bk\gateway-dist if needed" }
if (-not (Test-Path "$Gw\dist\client-ask.js")) { throw "dist\client-ask.js missing -- nothing restarted" }
if (-not (Select-String -Path "$Gw\dist\ws.js" -Pattern "accountBySocket" -Quiet)) { throw "dist\ws.js is not the new build -- nothing restarted" }
"OK: new gateway built ($((Get-Item "$Gw\dist\ws.js").LastWriteTime))"
```

Expected from `npm test`: `# pass 9`-style lines for client-ask, plus the existing book-seq and internal-secret tests,
`# fail 0`.

## 4. Pre-flight: the new ask-rule query works against the live DB (read-only, prints no value)

This runs the exact query the new gateway uses (`dist\client-ask.js` `loadAccountAskState`) for up to 5 trader
accounts, with the gateway's own `DATABASE_URL`. If this fails, **do not restart**: the new gateway would hold back
ticks from those sockets.

```powershell
$env:DATABASE_URL = Get-CmdVar $GwCmd "DATABASE_URL"
if (-not $env:DATABASE_URL) { throw "DATABASE_URL not found in start-gateway.cmd -- stop and report" }
"gateway DB host: $([regex]::Match($env:DATABASE_URL, 'ep-[a-z]+-[a-z]+').Value)  (must be ep-morning-glade)"
@'
import pg from "pg";
import { loadAccountAskState } from "./dist/client-ask.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const q = (s, p) => pool.query(s, p);
try {
  const accts = await q(`SELECT a.id, a."brokerId" FROM "Account" a JOIN "Broker" b ON b.id = a."brokerId" ORDER BY a."createdAt" DESC LIMIT 5`, []);
  for (const a of accts.rows) {
    const st = await loadAccountAskState(q, a.id, a.brokerId);
    console.log(`account ...${String(a.id).slice(-6)}: loaded=${st !== null} serverSide=${st?.serverSide} symbols=${st?.rules.size ?? 0}`);
  }
  console.log("PREFLIGHT OK");
} catch (e) {
  console.log("PREFLIGHT FAILED: " + (e && e.code ? e.code + " " : "") + String(e && e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
} finally { await pool.end(); }
'@ | Set-Content -Encoding utf8 "$Gw\.preflight-markup.mjs"
Set-Location $Gw
node .preflight-markup.mjs
Remove-Item "$Gw\.preflight-markup.mjs"
Remove-Item Env:\DATABASE_URL
```

Expected: `gateway DB host: ep-morning-glade`. Then up to 5 lines `loaded=true serverSide=false symbols=<n>`
(`serverSide=false` everywhere before step 4), then `PREFLIGHT OK`.

## 5. Restart and check health

```powershell
Invoke-Native { & $Nssm restart vyxtrader-gateway }
$ok = $false; foreach ($i in 1..30) { if ((Get-Code "http://127.0.0.1:8080/health" @{}) -eq 200) { $ok = $true; break }; Start-Sleep 1 }
if (-not $ok) { "<<< gateway /health not 200 after 30 s -- go to ROLLBACK" } else { "OK: /health 200" }
(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 5).Content
"public: HTTP $(Get-Code 'https://feed.vyxtrader.com/health' @{})"
```

Expected: `OK: /health 200`, then `{"ok":true}`, then `public: HTTP 200`.

## 6. Confirm the new build is the one running

`/health` carries no version, so compare the process start time with the build time.

```powershell
$procId = (Get-NetTCPConnection -LocalPort 8080 -State Listen | Select-Object -First 1).OwningProcess
$started = (Get-Process -Id $procId).StartTime
$built = (Get-Item "$Gw\dist\ws.js").LastWriteTime
"listener pid $procId started $started ; dist\ws.js built $built ; new build running: $($started -gt $built)"
Set-Location $Repo; "repo HEAD: $((git rev-parse --short HEAD).Trim())"
```

Expected: `new build running: True`. Also check that 8080 is still loopback-only:

```powershell
netstat -ano | Select-String ":8080\s" | Select-String "LISTENING"
```

Expected: `127.0.0.1:8080 ... LISTENING` (never `0.0.0.0:8080`).

## 7. Ticks still flow, and the log is clean

```powershell
$H = @{ "x-internal-secret" = (Get-CmdVar $GwCmd "INTERNAL_SERVICE_SECRET") }
"internal secret length: $($H['x-internal-secret'].Length)"
$a = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
Start-Sleep 15
$b = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
"ticks forwarded in 15 s: $($b.ticksForwardedTotal - $a.ticksForwardedTotal) ; NATS msgs: $($b.natsMessagesReceivedTotal - $a.natsMessagesReceivedTotal) ; last tick forwarded $([int]((([DateTimeOffset]::UtcNow).ToUnixTimeMilliseconds() - $b.lastTickForwardedAtMs)/1000)) s ago ; ws connections total $($b.wsConnectionsTotal)"
$H = $null
$log = Get-GwLog; "log file: $log"
Get-Content $log -Tail 80 | Select-String -Pattern "listening|ask rules load failed|ALERT|Error|error" | Select-Object -Last 15
```

Expected, with markets open and at least one terminal or WebTrader connected (check that one is connected; ticks
only go out to connected clients):
- `ticks forwarded in 15 s` well above 0, and `last tick forwarded` a few seconds ago.
- The log shows a fresh `api-gateway listening on 127.0.0.1:8080`, and **no** `price stream: ask rules load failed`
  and no `[ALERT] price stream`.

If `ask rules load failed` appears, or ticks forwarded stay at 0 while NATS messages rise and clients are connected,
go to ROLLBACK and report.

Then tell the coordinator: "gateway on 0e95d8e running, health 200, ticks flowing, log clean". Only then is step 4
(the per-broker switch) allowed.

## ROLLBACK (back to the previous gateway build)

```powershell
$Bk = (Get-ChildItem "C:\vyxtrader\backup" -Directory -Filter "markup-leak-*" | Sort-Object Name | Select-Object -Last 1).FullName
"rolling back from $Bk"
& $Nssm stop vyxtrader-gateway
Remove-Item -Recurse -Force "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Recurse -Force "$Bk\gateway-dist" "C:\vyxtrader\repo\services\api-gateway\dist"
Copy-Item -Force "$Bk\start-gateway.cmd" "C:\vyxtrader\scripts\start-gateway.cmd"
& $Nssm start vyxtrader-gateway
foreach ($i in 1..30) { try { if ((Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health -TimeoutSec 3).StatusCode -eq 200) { "OK: old gateway back, /health 200"; break } } catch {}; Start-Sleep 1 }
```

The dependencies did not change in this commit (`decimal.js` and `pg` were already there), so the old `dist\` runs
on the new `node_modules`. The repo stays on `main`, and the next deploy simply rebuilds. To also move the checkout
back, run `git checkout (Get-Content "$Bk\pre-head.txt")`. That gives a detached HEAD, so go back to `main` before
any later deploy.

**If step 4 has already been applied for a broker**, roll the switch back first, then the gateway:
`UPDATE "Broker" SET "clientAskServerSideAt" = NULL WHERE subdomain = '<broker>'` (the coordinator does this).
Otherwise `/api/trade/prices` reports `askMarkup "0"` while the old gateway streams raw asks, and those traders would
see the raw ask as their price.

---

## Appendix: US30 / XAUUSD candle check, 30 Sep (read-only, prints no secret)

This reads the engine's own read secret from `start-engine.cmd` into a variable. If that secret is not set, it uses
the internal secret, which the engine also accepts on `/internal/candles`. Then it asks the local engine for M1 bars
and prints, per window and symbol, only: the first and last bar, the count, the flat bars (high = low), and every gap
longer than 2 minutes, including at the window's edges. A gap line `21:00 -> 00:00 (180 min missing)` means no bar
from 21:00 up to the 00:00 bar. This was tested against a stand-in engine that returns a 3-hour hole.

```powershell
$EngineCmd = "C:\vyxtrader\scripts\start-engine.cmd"
function Get-CmdVar([string]$Path, [string]$Name) {
  $line = Get-Content $Path | Where-Object { $_ -match ('^\s*set\s+"?' + [regex]::Escape($Name) + '=') } | Select-Object -First 1
  if (-not $line) { return $null }
  return ($line -replace ('^\s*set\s+"?' + [regex]::Escape($Name) + '='), '' -replace '"\s*$', '').Trim()
}
if (-not (Test-Path $EngineCmd)) { throw "start-engine.cmd not found at $EngineCmd" }
$s = Get-CmdVar $EngineCmd "MARKET_DATA_READ_SECRET"
if ($s) { $H = @{ "x-market-data-secret" = $s } } else { $H = @{ "x-internal-secret" = (Get-CmdVar $EngineCmd "INTERNAL_SERVICE_SECRET") } }
if (-not @($H.Values)[0]) { throw "no read or internal secret in start-engine.cmd -- stop and report" }
"auth: $(@($H.Keys)[0]) (length $(@($H.Values)[0].Length))"; $s = $null
$IC = [Globalization.CultureInfo]::InvariantCulture
function To-Utc($v) {
  if ($v -is [datetime]) { return [DateTimeOffset]$v.ToUniversalTime() }
  return [DateTimeOffset]::Parse("$v", $IC, [Globalization.DateTimeStyles]::AssumeUniversal)
}
function Check-Window([string]$Sym, [string]$FromIso, [string]$ToIso) {
  $from = To-Utc $FromIso; $to = To-Utc $ToIso
  $url = "http://127.0.0.1:8081/internal/candles?symbol=$Sym&tf=M1&limit=1000&before=$($to.ToUnixTimeMilliseconds())"
  try { $rows = Invoke-RestMethod -Uri $url -Headers $H -TimeoutSec 20 }
  catch { "$Sym ${FromIso}..${ToIso}: request failed, HTTP $(if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 'n/a' })"; return }
  $bars = @(); foreach ($r in $rows) { $t = To-Utc $r.bucketStart; if ($t -ge $from -and $t -lt $to) { $bars += [pscustomobject]@{ T = $t; Flat = ("$($r.high)" -eq "$($r.low)") } } }
  $bars = @($bars | Sort-Object T)
  if ($bars.Count -eq 0) { "$Sym ${FromIso}..${ToIso}: 0 bars (the whole window is empty)"; return }
  $flat = @($bars | Where-Object Flat).Count
  "$Sym ${FromIso}..${ToIso}: $($bars.Count) bars, first $($bars[0].T.ToString('MM-dd HH:mm')), last $($bars[-1].T.ToString('MM-dd HH:mm')), flat $flat"
  $prev = $from.AddMinutes(-1)
  foreach ($b in $bars + @([pscustomobject]@{ T = $to; Flat = $false })) {
    $gap = ($b.T - $prev).TotalMinutes - 1
    if ($gap -gt 2) { "    gap: $($prev.AddMinutes(1).ToString('MM-dd HH:mm')) -> $($b.T.ToString('MM-dd HH:mm'))  ($gap min missing)" }
    $prev = $b.T
  }
}
foreach ($sym in "US30", "XAUUSD") {
  Check-Window $sym "2026-09-30T20:30:00Z" "2026-10-01T00:30:00Z"
  Check-Window $sym "2026-09-29T21:00:00Z" "2026-09-29T22:00:00Z"
}
$H = $null
```

How to read it:
- **US30 on 29 Sep, 21:00-22:00:** this is the normal daily index break (in summer US30 trades 22:00 to 21:00 UTC). Expect either 0 bars or 60 flat bars. That is the baseline.
- **30 Sep window:**
  - If US30 is missing well beyond 21:00-22:00 while XAUUSD has bars (apart from its own 21:00-22:00 metals
    break), the US30 quotes stopped at the source (MT5 / EA symbol).
  - If both symbols are missing over the same span, the whole feed (EA, VPS or engine) was down.
  - If both have bars there but the chart showed a gap, the gap is on the chart side.
