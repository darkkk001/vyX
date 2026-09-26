# Caddy service "Paused" + missing MARKET_DATA_READ_SECRET: recovery runbook (2026-09-26)

## Outcome (2026-09-26, run by the owner on the VPS)
- **Cause: the `vyxtrader-caddy` service was simply paused.** Step 1 found a single caddy.exe, a child of nssm, and
  no stray instance. The "second Caddy / nssm throttling" hypothesis below was wrong. Pausing an nssm service does
  not stop its child, so Caddy kept serving the whole time.
- **Fix: `& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" continue vyxtrader-caddy`.** Service RUNNING, `/health` 200, no downtime. Step 2's stop / kill / start
  was not needed.
- **Step 3 done:** `set MARKET_DATA_READ_SECRET=...` added to `C:\vyxtrader\scripts\start-engine.cmd` (backup kept),
  engine restarted.
- **Caddy has no log file.** `& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppStderr` / `AppStdout` are empty, so Caddy's own output
  (certificate renewals, upstream errors, config errors at start) goes nowhere. The next incident will have no
  Caddy log to read. Optional fix, safe at any time (it takes effect on the next service restart, which is ~2 s of
  feed downtime):
  ```powershell
  New-Item -ItemType Directory -Force C:\vyxtrader\logs | Out-Null
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" set vyxtrader-caddy AppStdout C:\vyxtrader\logs\caddy.out.log
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" set vyxtrader-caddy AppStderr C:\vyxtrader\logs\caddy.err.log
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" set vyxtrader-caddy AppRotateFiles 1
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" set vyxtrader-caddy AppRotateOnline 1
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" set vyxtrader-caddy AppRotateBytes 10485760      # rotate at 10 MB
  & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" restart vyxtrader-caddy                           # do it while markets are closed
  curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
  Get-Content C:\vyxtrader\logs\caddy.err.log -Tail 20                      # Caddy writes its log to stderr
  ```
  Rollback: `nssm reset vyxtrader-caddy AppStdout; nssm reset vyxtrader-caddy AppStderr; & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" restart vyxtrader-caddy`.
- **If it shows Paused again:** `& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" status vyxtrader-caddy`. If PAUSED, run `& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" continue vyxtrader-caddy` (no
  downtime) and check who paused it: `Get-WinEvent -FilterHashtable @{LogName='System'; Id=7036} -MaxEvents 50 |
  ? Message -match 'caddy'` shows the service state changes with their times.

The rest of this file is the original diagnosis and procedure, kept for reference.

## What is known (checked from outside, read-only)
- `feed.vyxtrader.com` resolves to 161.97.138.160 (the VPS; a plain A record, no tunnel). It is served by Caddy
  **right now**: `/health` answers 200 with `Server: Caddy` and `Via: 1.1 Caddy`, and `/internal/*` without a secret
  gets Caddy's own 401 (empty body; the engine's own 401 says "unauthorized").
- Vercel production holds `MARKET_DATA_URL`, `MARKET_DATA_READ_SECRET`, `MARKET_DATA_PRICES`, `MARKET_DATA_VPS_SYMBOLS`,
  `TRADING_CORE_URL`, `GATEWAY_URL` and `INTERNAL_SERVICE_SECRET`. All are marked Sensitive, so their values can't be
  read back.
- Vercel logs, last 48 h:
  - The web's engine reads (`lib/market-data-client.ts`) failed only in short bursts: 09-24 04:11-04:35,
    09-25 03:29, 09-25 20:47 (UTC). That is 151 failed price reads, all `HTTP 502`, plus 2 timeouts.
  - Nothing failed outside those windows, and no Vercel route answered 5xx.
  - A 502 is a proxy's answer when its upstream is down. So `MARKET_DATA_URL` goes through Caddy, and the bursts are
    engine restarts (e.g. the 09-24 risk-hook deploy).
- The engine has no `MARKET_DATA_READ_SECRET` (start-engine.cmd), so it accepts only `x-internal-secret` on
  `/internal/prices` and `/internal/candles`. The web sends only `X-Market-Data-Secret`. Those reads still succeed,
  so Caddy must check `X-Market-Data-Secret` itself and add `x-internal-secret` towards the engine. **Caddy is
  therefore on the web's price path.**
- `feed-health` / `alert-stats` (`TRADING_CORE_URL` + `x-internal-secret`) fail silently (they show blank in
  Feed health, with no log line), so the logs can't tell. Open the backoffice Feed health screen: numbers = OK.

## Why the service shows "Paused" (original hypothesis: turned out WRONG, see Outcome)
When the program & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" starts exits right away, nssm throttles the restart, and Windows shows the service as
**Paused** meanwhile. Caddy is still serving, so the most likely cause: a second Caddy, started outside the service
(a console, `caddy start`, or a scheduled task), holds ports 80/443. The service's own Caddy then dies at once with
"address already in use", over and over.

## What breaks while it stays like this
Nothing right now: the stray Caddy is serving. But it is unmanaged. If it dies, or the VPS reboots and only the
service tries to start, `feed.vyxtrader.com` goes down:
- Every terminal and backoffice loses its live streams (`wss://feed.vyxtrader.com`: prices, trading events,
  admin events). Price/stream reconnects fail.
- The web's engine reads fail. Prices fall back to Neon's LivePrice, frozen since 2026-09-14, so market orders
  are refused `PRICE_STALE` and the margin monitor has no fresh prices for stop-outs. Charts fall back to old Neon
  candles.
- Feed health goes blank.

## Step 1: diagnose (read-only)
```powershell
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" status vyxtrader-caddy
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy Application; & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppParameters; & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppDirectory
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppStdout; & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppStderr      # then read the tail of that file:
Get-Content (& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy AppStderr) -Tail 40
# who holds 80/443, and how it was started
Get-NetTCPConnection -LocalPort 80,443 -State Listen | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$($_.OwningProcess)" | Select-Object ProcessId, Name, CommandLine, CreationDate }
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine, CreationDate
Get-WinEvent -FilterHashtable @{ LogName='Application'; ProviderName='nssm' } -MaxEvents 20 | Format-List TimeCreated, Message
Get-ScheduledTask | Where-Object { $_.Actions.Execute -match 'caddy' } | Select-Object TaskName, State
# the secret Caddy checks (do not paste it anywhere public)
$CF = "<the Caddyfile path from AppParameters, e.g. C:\caddy\Caddyfile>"
Select-String -Path $CF -Pattern 'market-data-secret|internal-secret|header_up' -Context 0,1
```
Expected: the stderr tail says `address already in use` (80/443), and a caddy.exe that is NOT a child of nssm owns
the ports. Save its full `CommandLine`; it is the rollback.

If stderr shows a Caddyfile error instead: run `caddy validate --config $CF` (same Application path) and send me the
output before continuing.

## Step 2: put Caddy back under the service (≈5 s of feed downtime; clients reconnect on their own)
Do it now, while markets are closed.
```powershell
$CF = "<Caddyfile path>"
& (& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" get vyxtrader-caddy Application) validate --config $CF      # must say "Valid configuration"
Copy-Item $CF "$CF.bak-2026-09-26"
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" stop vyxtrader-caddy
Stop-Process -Id <stray caddy ProcessId from step 1> -Force
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" start vyxtrader-caddy
Start-Sleep 5
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" status vyxtrader-caddy                                        # SERVICE_RUNNING
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine
```
The last line must show one caddy.exe whose parent is nssm. If a scheduled task started the stray one, disable it:
`Disable-ScheduledTask -TaskName <name>`.

**Rollback:** if the service won't stay RUNNING (stderr says why), bring the old way back so the feed is up, then
send me the stderr tail:
```powershell
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" stop vyxtrader-caddy
Start-Process -FilePath "<caddy.exe path>" -ArgumentList "<the rest of the saved CommandLine>" -WindowStyle Hidden
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
```

## Step 3: the engine's own copy of the read secret (defense in depth, runbook §5)
The value must equal Vercel's `MARKET_DATA_READ_SECRET`. It can't be read back from Vercel, but Caddy checks the
same value (step 1's Select-String shows it on the `X-Market-Data-Secret` matcher).
```powershell
Copy-Item C:\vyxtrader\scripts\start-engine.cmd C:\vyxtrader\backup\start-engine.cmd.pre-readsecret
notepad C:\vyxtrader\scripts\start-engine.cmd
#   add, next to the other set lines:   set MARKET_DATA_READ_SECRET=<the value from the Caddyfile matcher>
& "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" restart vyxtrader-engine
Start-Sleep 5
$R = @{ "x-market-data-secret" = "<same value>" }
Invoke-RestMethod http://127.0.0.1:8081/internal/prices/XAUUSD -Headers $R        # a price, not 401
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health         # 200
```
The engine restart is the ~10 s 502 window the web saw on 09-24/25. Web reads fall back to Neon meanwhile, so do it
while markets are closed.

**Rollback:** `Copy-Item C:\vyxtrader\backup\start-engine.cmd.pre-readsecret C:\vyxtrader\scripts\start-engine.cmd -Force; & "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe" restart vyxtrader-engine`.

## Step 4: the candle check that was skipped
Run the read-only check in market-data-vps-runbook.md ("Where the engine reads its secrets"). After step 3 the read
secret works too.
