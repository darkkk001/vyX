# Execution endpoint on the VPS (execution latency Phase 1)

**Why:** an order from Pakistan went phone -> Vercel edge (Mumbai) -> Vercel function (Frankfurt) -> Neon. About 234 ms
of a 347 ms order was outside the route (measured 2026-10-23, 20 demo orders). The VPS is in France (Contabo,
Lauterbourg, about 150 km from Frankfurt; not London as older docs say). A request straight to it costs one network
round trip from the client and nothing else. Neon and Redis are a few milliseconds away.

**What:** the SAME web build Vercel production runs, on the VPS as nssm service `vyx-exec` (localhost:3200, which is `[::1]` on Windows). Caddy
exposes only the order routes through it:

```
https://feed.<root>/exec/<broker host>/api/trade/orders                    POST (place), GET
https://feed.<root>/exec/<broker host>/api/trade/orders/<id>               PATCH (modify), DELETE (cancel)
https://feed.<root>/exec/<broker host>/api/trade/orders/<id>/requote-response
https://feed.<root>/exec/<broker host>/api/trade/positions/<id>            PATCH (SL / TP)
https://feed.<root>/exec/<broker host>/api/trade/positions/<id>/close      POST
https://feed.<root>/exec/<broker host>/api/trade/positions/close-bulk      POST
https://feed.<root>/exec/<broker host>/api/trade/positions/modify-bulk     POST
https://feed.<root>/exec/<broker host>/api/health                          GET (clients switch over only when 200)
```

Everything else (sign-in, quotes, history, the backoffice) stays on Vercel.

**Unchanged:** auth, risk and validation are the same code. The broker comes from `<broker host>`, which Caddy passes
as the Host header, so `middleware.ts` resolves it and `getAccountSession` refuses a session of another broker, exactly
as on Vercel. Custom-domain brokers use their subdomain host (`futurixglobal.vyxtrader.com`). The only code change for
the VPS is `MIDDLEWARE_INTERNAL_ORIGIN`: the middleware's own lookups go to the local process instead of out to Vercel.

**Clients:** each client asks `.../exec/<its host>/api/health` once and keeps the answer for a few minutes. It sends
orders there only after a 200, and falls back to the normal URL when the endpoint cannot be reached. A request that
was sent is never re-sent elsewhere. Until this runbook is done every client keeps using Vercel exactly as today.

## Rules

- Owner's go only, and only in a window agreed with the engine / gateway / feed sessions (no deploy during a
  volatile or high-impact market window without the owner).
- Elevated Windows PowerShell on the VPS. Nothing below prints a secret.
- Caddy: always `caddy validate`, then `caddy reload`. Never `nssm restart vyxtrader-caddy`.
- The VPS commit must be the one Vercel production runs (same code on both, or orders would follow two versions).

## 1. The environment file (once; update when Vercel's production env changes)

Create `C:\vyxtrader\exec\exec.env` with one `KEY=value` per line, from Vercel's production environment (the owner
copies it from the Vercel dashboard; the values are never pasted into chat). Required: `DATABASE_URL`, `DIRECT_URL`,
`REDIS_URL`, `INTERNAL_SERVICE_SECRET`, `ROOT_DOMAIN`, plus every other production key. Then override for the VPS:

```
GATEWAY_URL=http://127.0.0.1:<gateway port>
MARKET_DATA_URL=http://127.0.0.1:<market-data port>
MARKET_DATA_PRICES=vps
```

Use the local ports the feed site block in the Caddyfile actually proxies to (the gateway's `/internal/events` and the
market-data `/internal/prices` upstreams); if unsure, keep the public `https://feed.<root>` values from Vercel. Both
work, local only saves a TLS hop. (`MIDDLEWARE_INTERNAL_ORIGIN`, `NODE_ENV` and the port are set by the install
script.) Restrict the file to
Administrators: `icacls C:\vyxtrader\exec\exec.env /inheritance:r /grant:r Administrators:F`.

## 2. Build and start (the commit Vercel production runs)

```powershell
cd C:\vyxtrader\repo
git fetch origin
.\deploy\vps\exec\install-exec.ps1 -Sha <production sha>
```

Expected last lines: `OK: vyx-exec <sha> healthy on localhost:3200 (health 200; GET /api/trade/orders without a
session -> 401, expected 401)`. A failure stops before anything public changes (Caddy is untouched until step 3).

## 3. Caddy: expose the route

1. Add the content of `deploy/vps/exec/Caddyfile.exec` once, at the top level of the live Caddyfile (the path is
   `nssm get vyxtrader-caddy AppParameters`). Back the Caddyfile up first.
2. In each feed site block (`feed.vyxtrader.com`, and `feed.qoretrader.com` if it has its own block), add
   `import vyx_exec` as the FIRST line inside the block.
3. `caddy validate --config <Caddyfile>`, then `caddy reload --config <Caddyfile>`.
4. Check from outside (any machine):
   - `https://feed.vyxtrader.com/exec/futurixglobal.vyxtrader.com/api/health` -> 200 `{"status":"ok",...}`
   - `https://feed.vyxtrader.com/exec/futurixglobal.vyxtrader.com/api/trade/orders` without a session -> 401
   - `https://feed.vyxtrader.com/exec/futurixglobal.vyxtrader.com/api/trade/me` -> 404 (not exposed)
   - `https://feed.vyxtrader.com/exec/evil.example.com/api/health` -> 404 (only the two root domains pass)
   - the price stream and the gateway work as before (a terminal and the app still tick).

## 4. Measure (before / after)

From the phone (native app and web build): 20 market orders + closes on the demo account. The app's QT_PERF log and
the session scratchpad `probe.mjs` (PC) record send -> fill. Compare with the Phase 0 table.

## Rollback

- Fast (clients fall back by themselves within minutes): remove the `import vyx_exec` lines, `caddy validate`,
  `caddy reload`. `/exec/.../api/health` stops answering 200, and clients go back to Vercel.
- Service: `nssm stop vyx-exec`. Previous build: run `install-exec.ps1 -Sha <previous sha>` (its folder is kept).
- Logs: `C:\vyxtrader\logs\exec.out.log`, `exec.err.log`.
