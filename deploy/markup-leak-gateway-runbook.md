# Markup-leak hotfix: VPS gateway runbook (rollout step 3)

Commits `0e95d8e` + the Neon-quiet follow-up (branch `markup-leak`; `main` must contain both). This page covers only the **api-gateway** on the VPS
(nssm service `vyxtrader-gateway`, `node dist\index.js` from `C:\vyxtrader\repo\services\api-gateway`, port 8080).
The engine is not rebuilt or restarted.

## Order of the whole rollout

1. Migration `20261005090000_broker_client_ask_server_side` applied on ep-morning-glade (the coordinator does this).
   Apply it before this gateway starts. If it is missing, the gateway logs
   `Broker.clientAskServerSideAt missing (migration not applied?), server-side asks stay off` and keeps every broker switched off (raw ticks,
   as today) rather than going dark.
2. Web deploy of `main` (the coordinator does this).
3. **This runbook**: gateway build and restart on the VPS.
4. Only after the owner confirms step 3 is healthy: `UPDATE "Broker" SET "clientAskServerSideAt" = now()` per broker
   (the coordinator does this), **immediately followed by the announce in section 8**.

**Until step 4, the new gateway behaves exactly like the old one, with zero extra database reads.** Every trader
socket gets the raw tick, the same bytes as today. The switch is read in the same per-broker query the stream already
runs for its enabled-symbol filter: at the broker's first socket, on a ConfigChanged, and every 10 minutes. While a
broker is switched off, no ask rule is ever read for its traders (gateway-stats `askRuleQueriesTotal` stays 0).

**After step 4, for a switched-on broker:**
- The rules are read once when a trader's socket opens.
- They are read once for all of that broker's connected traders on each ConfigChanged, and once for an account on
  its own AccountUpdated.
- A safety reload runs every 10 minutes.
- They are never read per tick.
- A trader whose rules are not loaded yet gets no ticks (held, never raw) until they are.

**The switch is per broker:** turning it on for one broker changes nothing for the others. Open sockets pick it up
on the next ConfigChanged for that broker, or at the 10-minute refresh at the latest. A reconnect is not needed.
Section 8's announce makes that happen within about a second.

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

Expected from `npm test`: `ℹ pass 14` (client-ask incl. the query-count tests, book-seq, internal-secret),
`ℹ fail 0`.

## 4. Pre-flight: the new queries work against the live DB (read-only, prints no value)

This runs the two queries the new gateway uses (`dist\db.js` `getBrokerStreamConfig` and `dist\client-ask.js`
`loadAskRules`) for the brokers of the 5 newest accounts, with the gateway's own `DATABASE_URL`. If this fails, **do
not restart**.

```powershell
$env:DATABASE_URL = Get-CmdVar $GwCmd "DATABASE_URL"
if (-not $env:DATABASE_URL) { throw "DATABASE_URL not found in start-gateway.cmd -- stop and report" }
"gateway DB host: $([regex]::Match($env:DATABASE_URL, 'ep-[a-z]+-[a-z]+').Value)  (must be ep-morning-glade)"
@'
import pg from "pg";
import { loadAskRules } from "./dist/client-ask.js";
import { getBrokerStreamConfig } from "./dist/db.js";
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
const q = (s, p) => pool.query(s, p);
try {
  const accts = (await q(`SELECT a.id, a."brokerId" FROM "Account" a ORDER BY a."createdAt" DESC LIMIT 5`, [])).rows;
  for (const brokerId of [...new Set(accts.map((a) => a.brokerId))]) {
    const cfg = await getBrokerStreamConfig(brokerId);
    const ids = accts.filter((a) => a.brokerId === brokerId).map((a) => a.id);
    const rules = await loadAskRules(q, ids, brokerId);
    console.log(`broker ...${String(brokerId).slice(-6)}: switch=${cfg.clientAskServerSide ? "ON" : "off"} symbols=${cfg.symbols.length} accounts=${rules.size} rules=${[...rules.values()].map((m) => m.size).join(",")}`);
  }
  console.log("PREFLIGHT OK");
} catch (e) {
  console.log("PREFLIGHT FAILED: " + (e && e.code ? e.code + " " : "") + String(e && e.message).replace(/postgres(ql)?:\/\/\S+/g, "<url>"));
} finally { await pool.end(); process.exit(0); }
'@ | Set-Content -Encoding utf8 "$Gw\.preflight-markup.mjs"
Set-Location $Gw
node .preflight-markup.mjs
Remove-Item "$Gw\.preflight-markup.mjs"
Remove-Item Env:\DATABASE_URL
```

Expected: `gateway DB host: ep-morning-glade`. Then one line per broker, `switch=off` everywhere before step 4, with
symbol and rule counts above 0. Then `PREFLIGHT OK`. The first query wakes Neon once, and nothing keeps it awake.
If the log shows `Broker.clientAskServerSideAt missing`, the migration (rollout step 1) is not applied yet.

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
"rule reads: $($b.askRuleQueriesTotal) total ; brokers switched on: $($b.askBrokersSwitchedOn) ; accounts with rules loaded: $($b.askAccountsLoaded)"
$H = $null
$log = Get-GwLog; "log file: $log"
Get-Content $log -Tail 80 | Select-String -Pattern "listening|ask rules load failed|ALERT|Error|error" | Select-Object -Last 15
```

Expected, with markets open and at least one terminal or WebTrader connected (check that one is connected; ticks
only go out to connected clients):
- `ticks forwarded in 15 s` well above 0, and `last tick forwarded` a few seconds ago.
- `rule reads: 0 total ; brokers switched on: 0 ; accounts with rules loaded: 0`. **This must stay 0 while every
  broker is switched off.** Re-run this block later (an hour into market hours) and the total must still be 0. Any
  other value before step 4 is a bug: report it.
- The log shows a fresh `api-gateway listening on 127.0.0.1:8080`, and **no** `price stream: ask rules load failed`
  and no `[ALERT] price stream`.

If `ask rules load failed` appears, or ticks forwarded stay at 0 while NATS messages rise and clients are connected,
go to ROLLBACK and report.

Then tell the coordinator: "gateway on markup-leak running, health 200, ticks flowing, rule reads 0, log clean".
Only then is step 4 (the per-broker switch) allowed.

## 8. Step 4 companion: announce the switch (run right after each broker's UPDATE, and after any switch-off)

The UPDATE is a plain SQL write, so nothing tells the gateway or the open terminals. This publishes one ConfigChanged
(scope `pricing`) for that broker through the gateway's own `/internal/events`, the same path the backoffice's
pricing saves use.
- **Gateway:** re-reads the switch and loads that broker's connected traders' rules (one read).
- **Terminals and WebTrader:** re-read `/api/trade/prices` (askMarkup `"0"`), at the same moment.

Without it, the gateway would flip at its next 10-minute refresh while a terminal still held the old askMarkup, and
it would add the markup twice until it refetched. A save of any pricing value in the backoffice for that broker does
the same thing.

```powershell
$BrokerId = "<the broker's id>"   # from the coordinator (Broker.id, not the subdomain)
$H = @{ "x-internal-secret" = (Get-CmdVar $GwCmd "INTERNAL_SERVICE_SECRET") }
$body = @{ subject = "config.changed"; payload = @{ type = "ConfigChanged"; broker_id = $BrokerId; scope = "pricing" } } | ConvertTo-Json -Compress
"publish: HTTP $((Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:8080/internal/events -Headers $H -ContentType 'application/json' -Body $body -TimeoutSec 5).StatusCode)"
Start-Sleep 3
$b = Invoke-RestMethod -Uri http://127.0.0.1:8080/internal/gateway-stats -Headers $H -TimeoutSec 5
"brokers switched on: $($b.askBrokersSwitchedOn) ; accounts with rules loaded: $($b.askAccountsLoaded) ; rule reads: $($b.askRuleQueriesTotal)"
$H = $null
```

Expected:
- `publish: HTTP 202`.
- `brokers switched on` goes up by one.
- If any of that broker's traders are connected, `accounts with rules loaded` is above 0 and `rule reads` goes up by one.
- After a switch-off (UPDATE to NULL, then this block), `brokers switched on` goes down again.

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
`UPDATE "Broker" SET "clientAskServerSideAt" = NULL WHERE subdomain = '<broker>'` (the coordinator does this), then
section 8's announce, so open terminals re-read the real askMarkup. Otherwise `/api/trade/prices` reports
`askMarkup "0"` while the old gateway streams raw asks, and those traders would see the raw ask as their price.

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
