# Book database health: probe, alert, runbook

Incident 2026-10-27 11:02-11:30 UTC. The `neondb_owner` password was reset, and for ~28 minutes the database refused every
NEW connection. Every health check stayed green:

- the engine's and the gateway's `/health` never touched the database;
- the engine logged nothing, because the connections it already held kept working.

A restart in that window would not have come back.

## Design

### The probe

The engine (`engine/server/src/db_probe.rs`) and the gateway (`services/api-gateway/src/db-probe.ts`) run the same probe:

- **A NEW connection each time**, on `DATABASE_URL`, then `SELECT 1`, closed again.
  - This is what a restart or a pool refill does.
  - A pooled connection is never used: one would have answered fine all through the incident.
- **Timeout:** 2 s. A server that accepts and never answers is `timeout`.
- **Every 10 s**, in a background task (not per request), so the failure is logged even when nobody calls `/health`.
- **Not while idle**, so Neon can still suspend when quiet:
  - **engine:** only while its idle gate allows, i.e. a real symbol's quote moved within 60 s (`reload_due`, the same rule as the book reloads);
  - **gateway:** only while its Neon pool was used within 60 s;
  - **always:** while the last probe failed (so the recovery is seen), and once at start-up.
- **Classification:** `auth` (28P01 / 28000 / "password authentication failed"), `unreachable` (DNS / TCP / TLS), `timeout`, `error`.
  - Checked against live Neon: a wrong password reads `auth`, through the pooler too.

### `/health`

| probe | engine | gateway | `x-vyx-db` |
|---|---|---|---|
| ok | 200 `ok` (unchanged) | 200 `{ok:true, db:"ok"}` | `ok` |
| gate closed, last probe good | 200 `ok` | 200 `{ok:true, db:"idle"}` | `idle` |
| first probe not finished | 200 `ok` | 200 `{ok:true, db:"starting"}` | `starting` |
| down | **503** `{"status":"down","db":"down","reason":"auth","down_secs":N}` | **503** `{ok:false,status:"down",db:"down",reason,down_secs}` | `down reason=<r> secs=<n>` |
| no result for 30 s while it should run | **503**, reason `probe-stale` | **503**, reason `probe-stale` | `down reason=probe-stale` |

- **Readers:** every check that wants 200 now turns red on a database outage. That includes:
  - the deploy scripts' "engine / gateway /health 200 within 30 s". A deploy with a bad password now fails its own check, and rolls back where the script does.
  - the Caddy check's feed `/health`.
- **Start-up:** the engine only starts when its pool connects, and the first probe runs at once, so `starting` lasts a moment.

### Logging

- **ERROR** on the first failure: `DB PROBE: the book database refuses NEW connections (auth) ...`.
- **ERROR** again every 60 s while it lasts: `DB PROBE: still down (auth) for N s`.
- **WARN** once when it is back: `DB PROBE: ... accepts new connections again after N s`.
- The error text names the user and the host at most, never the password.

### The external alert

`deploy/vps/db-health-check.ps1`, scheduled task "VyX DB health", every 2 minutes:

- It reads `x-vyx-db` of the engine (`127.0.0.1:8081/health`) and the gateway (`127.0.0.1:8080/health`).
- **FAIL** = either says `down`.
- An engine or gateway that does not answer is not this check's failure: the Caddy check and the deploy scripts cover a dead process. It is recorded in the checks only.
- It reports to `/api/internal/infra-health` as component **`database`**: one e-mail to `OPS_ALERT_EMAIL` on OK -> FAIL, one on recovery.
  - That route needs Redis and e-mail only, no database, so it alerts even when the web's own database access is down.
- **The daily break** is 16:59-18:00 New York time: 20:59-22:00 UTC in summer, 21:59-23:00 UTC after the 11-01 DST change.
  - In the break nothing is reported, so a deploy or restart never alerts.
  - A failure still there after the break alerts at the first check after it.
- `caddy-health-check.ps1`: a feed `/health` 503 whose `x-vyx-db` says `down` is no longer a **Caddy** failure. That is the database alert, so one outage is not reported twice under the wrong name.

### Not covered (follow-ups)

- **The web's own database access** (the Vercel `DATABASE_URL`). If only that is wrong, the VPS probes stay green. The web's `/api/health` checks the schema state, which is cached.
  - Follow-up: give `/api/health` the same fresh-connection probe, or check a DB-backed public route from the VPS.
- **`MARKET_DATA_DATABASE_URL`**: the local VPS Postgres, a different role. Not probed here.
- **Pool errors in request handlers** are not logged separately: the probe sees the same failure within 10 s.

## Deploy (not before 10-29; engine + gateway restart = the break, or after a trader notice)

1. **Caddy gate, before the engine deploy.** The Caddyfile must not use an active health check on `/health` for the engine upstream. Otherwise a database outage would also stop the price reads (`/internal/prices`), which do not need Neon:
   ```powershell
   Select-String -Path <the Caddyfile from nssm AppParameters> -Pattern 'health_uri|health_path|health_interval' | ForEach-Object { "$($_.LineNumber): $($_.Line.Trim())" }
   ```
   - **Empty:** go.
   - **Any line:** stop and send it. Then give the engine upstream a separate always-200 path first.
2. **Deploy and restart.** Deploy the engine build and restart the gateway with the usual scripts. Then:
   ```powershell
   (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8081/health).Headers['x-vyx-db']   # ok (or idle when nothing ticks)
   (Invoke-WebRequest -UseBasicParsing http://127.0.0.1:8080/health).Headers['x-vyx-db']   # ok / idle / starting
   ```
3. **Install the check.** From the repo checkout:
   ```powershell
   git -C C:\vyxtrader\repo show <sha>:deploy/vps/db-health-check.ps1 | Set-Content C:\vyxtrader\scripts\db-health-check.ps1 -Encoding UTF8
   git -C C:\vyxtrader\repo show <sha>:deploy/vps/caddy-health-check.ps1 | Set-Content C:\vyxtrader\scripts\caddy-health-check.ps1 -Encoding UTF8
   powershell -ExecutionPolicy Bypass -File <repo>\deploy\vps\install-db-health-task.ps1 -Source C:\vyxtrader\scripts\db-health-check.ps1
   powershell -ExecutionPolicy Bypass -File C:\vyxtrader\scripts\db-health-check.ps1   # one line: db health OK ...; report delivered (200)
   ```
4. **The web part.** The `database` component in `lib/infra-health.ts` must be live before step 3's first report, or the route answers 400 "invalid report". It is in the same branch and ships with the web batch.

## When it alerts

1. Read the reason in the e-mail or in `C:\vyxtrader\status\db-health.json`:
   - **`auth`:** a password changed. Find every place that holds it (`C:\vyx\handoff\vps-neon-owner-password.ps1` lists them without printing a value), update them, then restart.
   - **`unreachable` / `timeout`:** Neon or the network. Check the Neon console (status, compute, quota).
2. **Do not restart the engine** to "fix" it while it says down. The open connections are what is still working; a restart would come back without a database.
3. **After the fix:** the probe recovers within 10 s, `/health` turns 200, and the check sends the recovery e-mail.
