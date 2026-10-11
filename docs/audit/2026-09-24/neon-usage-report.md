# Neon quota exhaustion on ep-morning-glade: what consumed it (read-only, 2026-09-26)

Scope: Vercel production logs (measured), web/engine/gateway/native client code (D: main `b9a495b`, E: `940e28a`),
repo docs and commit messages. No DB access was possible: the live project refuses every connection. Nothing was
edited, deployed or written to any DB. SQL for when access returns: `neon-usage-queries.sql` (same folder).

Labels: **M** = measured in Vercel logs, **E** = estimated from code, **D** = taken from docs / commit messages.

## 0. When it stopped (M)

- Last successful DB call: `GET /api/internal/margin-monitor` 200 at **2026-09-26 03:58:28 UTC**.
- First failure: 03:58:33 UTC, `prisma.$queryRaw()` "Server has closed the connection" (the compute was cut
  mid-connection). From 03:58:38 on, every route returns "Can't reach database server at
  ep-morning-glade-b23tui1g-pooler...", including `resolve-broker` (every host then shows "No broker found").
- Not deploy-related: the same routes returned 200 five seconds earlier on the same deployment.

## 1. Vercel side, measured

### How it was sampled

- `npx vercel logs --environment production --json --since/--until`, 27 windows of 40 s each, one every 2 h from
  2026-09-24 00:07 to 2026-09-26 04:07 UTC. There were also two dense windows around the cut-off (03:58-04:00 in
  15 s slices) and one 3-minute window during the outage (04:41).
- **CLI quirk:** the CLI returns the same page over and over. A call with `--limit 1000` gave 1000-2150 raw lines
  but only about 50 distinct `id`s. Every count below is deduplicated by `id`.
- Windows were kept short so that a normal window holds fewer than 50 rows. 25 of the 27 windows are complete: fewer
  than 50 unique rows spanning the full ~36 s. Two (24T02:07, 25T20:07) hit the cap, so they are lower bounds.
- `requestPath` carries no query string, so `margin-monitor` backstop and `?symbols=` calls can't be told apart.
  The rate matches the backstop alone.

### Requests per route, steady state before the outage

| Route | Measured rate | Present in | Requests/day | DB queries per request (code, Prisma 6, no relationJoins: each include = +1 query) | Queries/day |
|---|---|---|---|---|---|
| `GET /api/internal/margin-monitor` | **8 per 35 s = 13.7/min, every 5 s, 24/7** (from 24T06:07 on, incl. Saturday 26T00:07). Before that ~1/36 s (60 s backstop) | 25/25 samples | **~17,300-19,700** | full pass: postclose 1 + pending orders 1-2 + count 1 + distinct 1 = **~5**, + **~22 per account with an open position** (`evaluateAccountRisk` loads the positions 3× at 6 queries each, plus the account ×3 and the group) | A=0: ~90k; **A=3: ~1.3M**; A=10: ~4M |
| `GET /api/trade/positions` + `GET /api/trade/orders` | **10 + 10 per 36 s = 15 + 15/min** (exactly one terminal on a 4 s timer) | 17/27 samples | 43,200 while signed in (≈27k averaged) | positions 4 (position + symbol + originOrder + closePendingOrder); orders 3 (order + symbol + closesPosition). Session is Redis, 0 DB | **~151k/day per signed-in terminal** (~95k measured average) |
| `GET /api/internal/resolve-broker` (middleware) | 2-9 per 36 s ≈ 3-15/min; **one lookup per parallel API request** (03:58:08: 9 manage calls → 9 lookups within 25 ms, so the per-isolate 30 s cache misses) | 19/27 | ~5k-20k | 1 | ~5k-20k |
| Backoffice badge timer (8 × `/api/manage/*`) | 8 per 60 s, whatever screen is open | 7/27 | 11.5k while signed in | 1 (`adminUser.findUnique` per request) + 1-3 each ≈ 20/wave | ~29k while open |
| Backoffice DASH (9 routes) / DEAL (12 routes) | DASH 9 per 30 s; DEAL 12 per 10 s (only while that screen is active) | DASH 2/27, DEAL 1/27 | DASH 26k, DEAL 104k if left open all day | DASH ~40/wave; DEAL ~50/wave | DASH ~115k/day, DEAL ~430k/day if left open |
| `/native-*-updates/*/RELEASES` | every ~10.5 s | recent | ~8k | 0 (static) | 0 |
| Vercel crons: margin-monitor `*/5`, swap-rollover daily | 0.2/min | - | 288 | as above | negligible |
| WebTrader (browser) | not seen in samples | 0/27 | - | prices + orders + positions every 30 s | - |

**During the outage (04:41 UTC, M):** 870/min requests (resolve-broker 480/min, each backoffice route ~45/min, 500s/0s).
Backoffice clients hammer the site while the DB is down. This did not cause the quota (it came after it), but it is
wasted Vercel invocations and a retry storm to fix.

## 2. Engine and gateway (E, from code; deployment state from memory/docs **D**)

- **2560176 (coalescing to 1 per second)** is on main and inside the VPS build `74b3c02`. It is **moot**:
  - eef0b35 (52 min later, also in 74b3c02) made `ENGINE_ORDER_MANAGEMENT` default OFF.
  - The coalescer only runs in ON mode.
  - The ~2000 txn/min (D: 2560176 message, measured on ep-flat-boat) was ON mode. It is not what burned ep-morning-glade.
- **Always on, whatever the mode, with no short-circuit and no weekend gate:**
  - `RiskHook::reload` runs 2 SELECTs (Position⋈Symbol, Order⋈Symbol) every 5 s (`engine/market-data/src/risk_hook.rs:298`).
  - `MarginWatch::reload` runs 1 SELECT every 5 s (`engine/order-management/src/margin_watch.rs:202`).
  - Together that is 36/min, about **52k/day**.
  - The backstop is the same process calling Vercel margin-monitor every 5 s (`VYX_RISK_HOOK_BACKSTOP_SECS=5`, D + M above).
- **Shadow (live on the VPS since 2026-09-25, D):**
  - `VYX_SHADOW_PASS_SECS=1`, as the `vyx_shadow_ro` role over the pooler.
  - Each pass is 1 account-list query + ~5 per open account, i.e. **60 × (1 + 5A)/min**. That is A=0: 86k/day; **A=3: 1.38M/day**.
  - The reconciler adds ~3/min (cursor-based, bounded by `LIMIT 500`).
  - There is no skip when the book is flat.
- **Ticks:**
  - The price-feed ingest path writes nothing to Neon.
  - LivePrice and Candle go to the VPS-local DB. Neon `LivePrice` is frozen at 2026-09-14 (confirmed read-only in
    `flat-candles-investigation.md`), so `MARKET_DATA_WRITE=local` is in effect.
  - Identical heartbeat prices are not deduplicated: `cache.rs:133` always marks the price dirty and `ingest.rs:141`
    publishes every tick to NATS. They cost **no Neon queries** in OFF/shadow mode, though. The risk-hook
    `after_flush` check is in memory, and frozen weekend `tick_ms` values fail the 15 s freshness test, so nothing fires.
  - Only price alerts (rare) write to Neon.
- **Gateway:**
  - `pg` Pool, max 10, 10 s idle.
  - 1 symbol-filter query per new WebSocket connection, and a 10-minute TTL refresh per broker.
  - `adminMayStream` runs once per cookie connection.
  - 0 queries per tick or per message, and no DB `setInterval`.
  - Negligible (<1/min).

## 3. Neon cost model

- **Egress: unlikely.**
  - The largest recurring payloads are one terminal's positions/orders (a few KB × 30/min ≈ 0.2-0.5 GB/day at most)
    and the backoffice lists.
  - Candles and ticks no longer leave Neon.
  - Only a DEAL screen left open for days (12 lists every 10 s) could reach the GB range. It appears in 1 of 27 samples.
- **Storage: no.** Trading tables only; Candle/LivePrice are frozen since 09-14.
- **Compute (CU-hours): yes. This is the driver.**
  - Neon bills awake-time × CU. Autosuspend (5 min default) needs 5 minutes with **no** query.
  - Since 2026-09-24 ~06:00 UTC Neon has been queried at least every 5 s, 24/7: the Vercel backstop (M: every
    single sample, including Saturday 00:07 UTC with markets closed), plus the engine reloads every 5 s (E), plus
    shadow every 1 s from 09-25 (D/E).
  - So the compute was **awake 100% of the time**, and usage = hours × average CU.
- **Arithmetic** (project life T to 2026-09-26 03:58 UTC):

  | Average CU | 50 h (from 09-24 ~02:00) | 76 h (from 09-23 00:05) |
  |---|---|---|
  | 0.25 | 12.5 CU-h | 19 CU-h |
  | 0.5 | 25 | 38 |
  | 1 | 50 | 76 |
  | 2 | **100** | 152 |

  - The same workload on the previous prod project measured **1049 CU-h in 528 h = 1.99 CU average** (D: the
    neon-compute-leak note, from the Neon console).
  - At ~2 CU, **100 CU-h** is used up in **~50 h**. That matches "about 2 days" and a 100 CU-h per-project allowance
    (the Free plan's monthly compute, or a per-project compute limit if one is set).
  - **Verify in the console:**
    - the plan and quota line;
    - the Monitoring → compute size graph;
    - the autoscaling min/max. A min CU of 1-2 while never suspending explains the whole bill even at a light ~33 queries/s.
- **Total query load at A=3, weekday** (E; consistent with the D note "~20 transactions/s"): ≈ 2,000 queries/min ≈ 2.9M/day.
  - Low CPU for Postgres. What costs money is **never suspending**, times the CU floor.

## 4. Top 5 consumers

A = accounts holding an open position. It is unknown; the SQL script's `pg_stat_statements` gives it. A=3 is illustrative.

| # | Consumer (service) | Rate | Queries/day (A=3) | Label | Fix | Expected saving |
|---|---|---|---|---|---|---|
| 1 | **Engine backstop → Vercel `/api/internal/margin-monitor` full pass every 5 s, 24/7** (VPS `VYX_RISK_HOOK_BACKSTOP_SECS=5`) | 13.7 req/min | ~1.3M (A=0 ~90k) | rate M, queries E | (a) backstop back to 60 s; the per-tick `?symbols=` trigger already covers speed. (b) Route: load positions once per account, not 3× (22 → ~9 queries/account). (c) Bail early when every symbol's session is closed (weekends) | (a) −92% (1.3M → ~110k); (b) a further −60%; (c) weekends ~0 |
| 2 | **Engine shadow pass every 1 s** (`ENGINE_ORDER_MANAGEMENT=shadow`, `vyx_shadow_ro`) | 60 passes/min | ~1.38M (A=0 86k) | E (+D for deploy) | `VYX_SHADOW_PASS_SECS=5` (or 10); skip when the account list is empty; pause outside market sessions except the weekend-reopen window the soak needs | −80% (−90% at 10 s); ~0 when the book is flat |
| 3 | **Native terminal positions + orders every 4 s** (`MarketDataService.cs` `_positionsTimer`) | 30 req/min per terminal | ~151k per terminal (95k averaged) | M | 30 s safety-net poll (trading-event WS already pushes changes); stop when minimized or the market is closed | −87% (151k → 20k per terminal) |
| 4 | **Engine `RiskHook::reload` + `MarginWatch::reload` every 5 s**, unconditional | 36/min | ~52k | E | Reload on a NATS "book changed" subject (the web already publishes trading events); 60 s safety reload; skip on weekends | −90%+ |
| 5 | **Backoffice polling** (60 s badge timer always; DASH 30 s / DEAL 10 s / FEED 5 s while active; keeps polling when minimized) | 8-72 req/min | 29k-460k while open | M (presence) + E | Pause when minimized; DEAL 10 → 30 s (events already refetch); make `resolve-broker` cheap (see below) | −65% of DEAL; ~100% when minimized |

**Keep-awake, the real bill** (cross-cutting): #1 + #2 + #4 each alone query Neon at least every 5 s, so the
compute never suspends: **24 CU-h/day per 1 CU**. The fixes above cut queries, but suspension only happens if
**all three** go quiet for more than 5 minutes when nobody is trading (nights and weekends). Needed together:
- a backstop ≥ 5 min, or skipped when the book is flat / sessions are closed;
- shadow gated off outside sessions;
- the reloads made event-driven.

Until then the lever is the **autoscaling floor**: min 0.25 CU, max 0.5-1.
- Always-awake at 0.25 CU = **6 CU-h/day**, vs **~48 CU-h/day at 2 CU**: −87%.
- A 100 CU-h allowance lasts ~16 days instead of 2.

**Also found:**
- **`resolve-broker` on every API request.** The middleware's per-isolate 30 s cache misses on parallel requests
  (M: 9 lookups per backoffice wave).
  - Fix: a longer TTL plus a shared cache (Vercel Edge Config, or Redis, already used for sessions), or put
    broker metadata into the signed session.
  - Saves 5-20k queries/day and one round trip per request.
- **Owner candidates that would save ~0 Neon today:**
  - "Engine margin pass once per second": already in the build, but that code path is off (eef0b35).
  - "Ignore repeated heartbeat prices": ticks don't reach Neon. It is still worth doing for NATS, terminal candles
    and flat bars (see `flat-candles-investigation.md`).
- **Outage retry storm:** after the cut, backoffice clients drove ~45 req/min per route and 480 resolve-broker/min
  (M). Add a backoff on 5xx.
- **Pooled vs direct:**
  - Vercel and shadow use the `-pooler` host (correct for serverless).
  - The engine is meant to use the direct URL with a sqlx pool of 20. That is fine for load, but does not change
    compute-hours.
