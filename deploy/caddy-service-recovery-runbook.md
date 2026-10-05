# Caddy service: rules, recovery and the periodic check (runbook started 2026-09-26)

## Incident 2026-10-05: nssm restart loop with an orphan Caddy
What the owner found on the VPS:
- `nssm status vyxtrader-caddy` said **SERVICE_PAUSED**.
- An **orphan caddy.exe, pid 4820, started 23 Sep**, was still serving the feed. It was not a child of nssm, so the
  service did not manage it.
- `caddy-err.log` held **4,024 `127.0.0.1:2019 bind` errors**. Port 2019 is Caddy's admin endpoint. The orphan held
  it, so every Caddy that nssm started died at once on the bind, nssm restarted it again and again, and finally
  throttled the service into Paused. The feed stayed up only because the orphan kept serving the old process's
  config; if it had died (or the VPS rebooted), `feed.vyxtrader.com` would have gone down with nothing to replace it.
- Nobody was alerted. That is why the periodic check below exists.

The fix the owner ran (about 5 s of feed downtime; clients reconnect on their own):
```powershell
$N  = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$CE = ((& $N get vyxtrader-caddy Application) -join "" -replace "`0", "").Trim()   # nssm prints UTF-16: strip NULs
$CF = "<the Caddyfile path from: & $N get vyxtrader-caddy AppParameters>"
& $CE validate --config $CF                                    # "Valid configuration"
& $N stop vyxtrader-caddy
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force   # ALL caddy.exe, the orphan included
& $N start vyxtrader-caddy
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" | Select-Object ProcessId, ParentProcessId, CreationDate
#   -> exactly one (new pid 52020), its ParentProcessId = the service's nssm pid:
(Get-CimInstance Win32_Service -Filter "Name='vyxtrader-caddy'").ProcessId
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
& $N continue vyxtrader-caddy                                  # clears the Paused state
& $N status vyxtrader-caddy                                    # SERVICE_RUNNING
```

## Incident 2026-10-05, second finding: Caddy under an ORPHAN nssm
After the fix above, the service still was not really managing Caddy. What the owner found:
- The running caddy.exe was the child of an **old, orphan nssm.exe (pid 2984)**, while the service
  `vyxtrader-caddy` pointed at a different nssm (pid 48180), which sat **Paused** with no Caddy of its own.
- So "exactly one caddy.exe" was true, but its parent was not the service's nssm. Stopping or restarting the service
  could not reach that Caddy; only killing its orphan nssm parent could.
- The periodic check catches this case: its parent check compares caddy.exe's parent with the service's own process id
  (`Win32_Service.ProcessId`) and fails on any other nssm.

The fix the owner ran (never touch the engine's or the gateway's nssm: each service has its own nssm process):
```powershell
$N   = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$svc = (Get-CimInstance Win32_Service -Filter "Name='vyxtrader-caddy'").ProcessId           # the service's nssm pid
$caddy = Get-CimInstance Win32_Process -Filter "Name='caddy.exe'"
$caddy | Select-Object ProcessId, ParentProcessId, CreationDate                              # parent <> $svc = orphan
# the nssm processes that are a caddy.exe parent but NOT the service's own nssm (safe to kill; engine/gateway nssm are
# never a caddy parent):
$orphanNssm = $caddy.ParentProcessId | Where-Object { $_ -ne $svc } | ForEach-Object {
  Get-CimInstance Win32_Process -Filter "ProcessId=$_" } | Where-Object Name -eq 'nssm.exe'
$orphanNssm | Select-Object ProcessId, CommandLine, CreationDate                             # check before killing
& $N stop vyxtrader-caddy
$orphanNssm | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-Process caddy -ErrorAction SilentlyContinue | Stop-Process -Force
& $N start vyxtrader-caddy
& $N continue vyxtrader-caddy
& $N status vyxtrader-caddy                                                                  # SERVICE_RUNNING
$svc = (Get-CimInstance Win32_Service -Filter "Name='vyxtrader-caddy'").ProcessId
Get-CimInstance Win32_Process -Filter "Name='caddy.exe'" | Select-Object ProcessId, ParentProcessId   # one; parent = $svc
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health                    # 200
powershell -NoProfile -ExecutionPolicy Bypass -File C:\vyxtrader\scripts\caddy-health-check.ps1   # "caddy health OK"
```

## RULES (owner, 2026-09-28 and 2026-10-05)
1. **Config changes only via `caddy validate` + `caddy reload`.** Zero downtime; the running, service-managed Caddy
   swaps to the new config. Procedure in the next section.
2. **Never `nssm restart vyxtrader-caddy`.** It does not replace a running Caddy (the old process keeps serving the
   old config and holds the ports), so a change silently never takes effect.
3. **Never start Caddy by hand:** no `caddy run`, no `caddy start`, no double-click, no scheduled task that launches
   caddy.exe. A Caddy outside the service holds ports 80/443/2019 and turns the service into a restart loop (the
   2026-10-05 incident).
4. **A recovery that really needs a fresh process** = stop the service, kill EVERY caddy.exe AND any orphan nssm.exe
   that is a caddy parent but not the service's own nssm (never the engine's or gateway's nssm), start the service,
   then verify a single caddy.exe whose parent is the service's nssm process, `/health` 200, `nssm continue` if it
   shows Paused, and the health check says OK. The two blocks above.
5. The periodic check (below) must stay installed; it is what tells us next time.

## Periodic check: "VyX Caddy health" (every 5 minutes)
- **What runs:** the scheduled task `VyX Caddy health`, as SYSTEM, every 5 minutes, running
  `C:\vyxtrader\scripts\caddy-health-check.ps1` (a copy of `deploy/vps/caddy-health-check.ps1`, installed by
  `deploy/vps/install-caddy-health-task.ps1`; `-Uninstall` removes it).
- **What it checks:** exactly one caddy.exe; its parent is the `vyxtrader-caddy` nssm process (no orphan); service
  SERVICE_RUNNING; no NEW `bind` / `address already in use` lines in Caddy's stderr log since the last run (the first
  run only records where the log ends, so old errors never alert; log rotation is handled); `/health` 200 within 5 s.
- **Where it reports:**
  - `C:\vyxtrader\status\caddy-health.json`: the last result (checks, reasons, whether the report reached the web).
  - POST `https://www.vyxtrader.com/api/internal/infra-health` with `x-internal-secret` (INTERNAL_SERVICE_SECRET from
    `start-gateway.cmd`, never printed). The web stores it, sends ONE alert e-mail when the state goes OK -> FAIL and
    ONE when it recovers (never repeated while unchanged), to the addresses in Vercel env `OPS_ALERT_EMAIL`.
  - Backoffice Feed health data (`GET /api/manage/feed-health` -> `infra.caddy`): OK / FAIL with the reasons, or
    NO_REPORT when no report arrived for 15 minutes (the check itself stopped).
- **How to read it on the VPS:**
  ```powershell
  Get-Content C:\vyxtrader\status\caddy-health.json                      # last result
  Get-ScheduledTaskInfo -TaskName "VyX Caddy health" | Select-Object LastRunTime, LastTaskResult, NextRunTime   # 0 = OK, 1 = FAIL
  powershell -NoProfile -ExecutionPolicy Bypass -File C:\vyxtrader\scripts\caddy-health-check.ps1   # run once by hand
  ```
  A report `NOT delivered (HTTP 401)` means the VPS's INTERNAL_SERVICE_SECRET and Vercel's differ.

## Config change procedure: ALWAYS `caddy reload` (owner, 2026-09-28)
`nssm restart vyxtrader-caddy` does NOT stop the running Caddy process: the old one keeps serving the OLD config (and
holds ports 80/443), so a Caddyfile change silently never takes effect. Every Caddyfile change goes:
```powershell
$N  = "C:\vyxtrader\nssm\nssm-2.24\win64\nssm.exe"
$CE = ((& $N get vyxtrader-caddy Application) -join "" -replace "`0", "").Trim()   # caddy.exe (nssm prints UTF-16: strip NULs)
$CF = "<the Caddyfile path from: & $N get vyxtrader-caddy AppParameters>"
Copy-Item $CF "C:\vyxtrader\backup\Caddyfile.pre-<change>-$(Get-Date -Format yyyyMMdd-HHmmss)"
# edit $CF, then:
& $CE validate --config $CF        # must say "Valid configuration"
& $CE reload   --config $CF        # zero downtime: the running Caddy swaps to the new config
curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
```
Rollback = copy the backup back over `$CF` and `caddy reload` again. Secret changes in the Caddyfile go through
`deploy/caddy-rotate-secrets-2026-09-28.ps1` (edits by value, never prints one; market-data-vps-runbook.md). (Used for the /internal/alert-stats route on
2026-09-28: live with no downtime.)

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
  # these nssm settings apply to the NEXT process nssm starts; a plain `nssm restart vyxtrader-caddy` does not
  # replace the running Caddy (see the rule at the top), so apply them at the next planned stop/start of the service
  curl.exe -s -o NUL -w "%{http_code}`n" https://feed.vyxtrader.com/health   # 200
  Get-Content C:\vyxtrader\logs\caddy.err.log -Tail 20                      # Caddy writes its log to stderr
  ```
  Rollback: `nssm reset vyxtrader-caddy AppStdout; nssm reset vyxtrader-caddy AppStderr` (effective at the next start).
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
When the program nssm starts exits right away, nssm throttles the restart, and Windows shows the service as
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
