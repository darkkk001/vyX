# Order-path latency: account 50005708 (futurixglobal, Avalonia terminal)

Measured 2026-09-26. Read-only: nothing was traded, written to the live DB, deployed or committed.
**M** = measured (the source is named). **E** = estimated (the method is named).

## Region facts
- Vercel is `fra1` (vercel.json). Every request header seen was `X-Vercel-Id: bom1::fra1`. That means the terminal enters Vercel at the **Mumbai** edge and the function runs in Frankfurt. **M**
- Neon is `ep-morning-glade…c-6.eu-central-1` (Frankfurt), so it is in the same region as Vercel. The "Vercel region = Neon region" fix is **already in place**, so it would save **0 ms**.
- In production, each sequential Prisma statement costs **~6.5 ms**. **M**: these are gaps between Prisma-stamped timestamps inside the fill transaction, over 20 real fills. `Order.createdAt`→`Position.openedAt` had a median of 6.5 ms (range 5–17). `Order.createdAt`→`AuditLog` had a median of 13 ms over 2 statements.
- Measurements from this machine, which is the trader's own terminal:
  - Neon `SELECT 1`: 127 ms round trip. A new connection (TLS + SCRAM) takes 1,075 ms, about 8 round trips. From fra1 the same setup would be about 10–30 ms per pooled connection per new lambda instance. **E**
  - Neon compute never suspends, because the engine writes to it continuously, so there is no Neon cold start on this path.
  - Vercel: TCP to bom1 takes 60 ms. A minimal authenticated-path request (`/api/trade/me`, 401) takes **~215 ms** from request to first byte after TLS. **M**, 14 runs.
  - Redis session GET: about 8 ms per call. **M**, the with/without-cookie difference, which is noisy. That puts Redis near fra1.
  - Gateway VPS (London): TCP takes 140 ms. **M**
  - The fra1→London hop for the gateway POST and the VPS price GET: **E** ~15 ms round trip.

## Ordered DB queries per route
Source: the real handlers run against the local scratch Postgres with Prisma query events and an injected ~30 ms round trip, so each sequential wave shows up clearly. The config mirrors production: pricing engine on, B_BOOK/DEALING/AUTO group, a desk on auto-fill, 1 non-matching MirrorRule, and all risk limits null. W = sequential wave; items joined with `‖` run in parallel.

**Market BUY: 26 statements in 21 waves**
1. Order (idempotency)
2. BrokerSymbol
3. Symbol
4. TradingSession
5. Broker ‖ Account
6. Group
7. GroupSymbol
8. LivePrice (in production this is the VPS HTTP call)
9. pricing (4‖)
10. pricing (2‖)
11. margin Position
12. margin Account
13. BrokerSymbol hedged-margin
14. BEGIN
15. INSERT Order
16. INSERT Position
17. INSERT AuditLog
18. COMMIT
19. mirror Account
20. MirrorRule
21. coverage Broker

After the queries come 2 awaited gateway POSTs (`order.filled`, then `dealing.activity`). `POST()` then calls `getAccountSession()` a second time, which adds 2 Redis round trips before the response is sent.

**Close: 26 statements in 25 waves**
1. Position
2. Symbol
3. Account
4. Group
5. BrokerSymbol
6. TradingSession
7. LivePrice (VPS)
8. Broker (routing)
9. Broker (slippage)
10. BEGIN
11. Position
12. Symbol
13. Account
14. UPDATE Position
15. SELECT … FOR UPDATE
16. UPDATE Account
17. INSERT Transaction
18. Position
19. COMMIT
20. MirrorLink
21. Position
22. Symbol
23. Account
24. Group
25. Broker, then coverage Position

The transaction holds row locks for 10 round trips. `position.closed` is published only **after** the mirror and coverage steps.

**SL/TP modify: 9 statements in 7 waves**
1. Position
2. BrokerSymbol
3. Symbol
4. TradingSession
5. Account ‖ Broker
6. Group
7. LivePrice (VPS)
8. UPDATE Position

It then makes 2 awaited gateway POSTs.

Prisma `include` issues one extra sequential query per relation level, which accounts for about 40% of the waves.

## Timeline per action (ms)
### (a) Market BUY
| Stage | ms | Kind / source |
|---|---|---|
| Terminal → bom1 edge (one way) | ~30 | E: half of the 60 ms TCP round trip |
| bom1 middleware → `INSERT Order` | **320** median (230–739, n=9) | M: Vercel request log vs `Order.createdAt` |
| …of which DB waves 1–14 | ~85 | E: 13 × 6.5 |
| …of which Redis ×2, VPS price, bom1→fra1 hop | ~16 + ~15 + ~60 | E |
| …unattributed (cold instances, pool connects, resolve-broker every 30 s) | ~140 | residual |
| INSERT → COMMIT | ~20 | M: prod timestamps |
| Mirror + coverage + 2 publishes + second session check | ~75 | E: 3 × 6.5 + 2 × 15 + 16 |
| HTTP response reaches the terminal | INSERT + ~225 | M: the terminal's post-response `GET /positions` reaches Vercel at INSERT + 250–268 (n=5) |
| Event: publish → gateway → WebSocket → terminal | INSERT + ~110 | M: the event-driven 4-GET burst reaches Vercel at INSERT + 128–146 (n=8), minus about 30 |
| **Fill sound** (plays on the `OrderFilled` event, not on the HTTP response) | **click + ~460** | M+E |
| HTTP response at the terminal | click + ~575 | M+E |
| **Chart line** (drawn only after a `GET /positions` refetch; the response body is ignored) | **click + ~700–800** | E: event GET + one more round trip |

### (b) Close
| Stage | ms | Source |
|---|---|---|
| POST → `closedAt` | 273 (n=1) | M: log vs `Position.closedAt` |
| closedAt → event burst arrives | 177 (manual close); 153 (engine SL/TP close) | M |
| Sound | click + ~480 | M+E: plays on the `PositionClosed` event |
| Row removed | on the HTTP response (`DropClosedLocally`), ≈ click + ~560 | E |

### (c) SL/TP modify
There are no production timestamps: the route writes no audit row and `Position` has no `updatedAt`.

| Stage | ms | Source |
|---|---|---|
| Inside the route | ~110 (7 × 6.5 + VPS + Redis + 2 publishes) | E |
| HTTP response | ~330 | E: 215 + 110 |
| Line redrawn after the awaited `GET /positions` | ~600 | E |
| Sound | none (no modify sound exists) | code |

The gateway hop itself (NATS → `ws.ts` fan-out) is **E**: under 5 ms. The event legs are dominated by the London→terminal WebSocket (~70 ms one way).

## Top 3 causes and estimated savings
1. **The server does its work one step at a time.** There are 21 / 25 / 7 sequential DB waves, the publish waits on mirror and coverage, 2 gateway POSTs are awaited, and the session check runs twice. There is also about 140 ms of cold-instance and connection overhead.
   - Fix: batch the independent reads (`Promise.all` / `relationLoadStrategy: "join"` / a single CTE), publish right after COMMIT, and move the mirror step, dealer-activity and the latency record into `waitUntil`.
   - Saves about **100–130 ms** on the fill and response (open ~21→~6 waves) and **~45 ms** on the sound. It saves about 130 ms on close.
   - Fluid compute / keeping instances warm could remove part of the 140 ms residual. **E**
2. **The terminal waits for a refetch before drawing** and ignores the 201 body, which already contains the full order and position.
   - Fix: draw from the response or the event (optimistic UI), and play the sound on whichever arrives first, the 2xx or the event.
   - Saves **~250–300 ms** before the chart line appears on open and modify, and it removes the duplicate refetch rounds.
3. **Geography.** Every HTTP round trip goes terminal → bom1 → fra1 (~215 ms minimum), and events go London → terminal.
   - Fix: this can only be removed by the **Rust cutover**: orders over the existing gateway WebSocket to the London VPS, checked in memory, with the DB write off the critical path. The London VPS → Neon Frankfurt write is ~15 ms.
   - Expected click → acknowledgement ~150–200 ms, compared with ~575 now. That saves **~350–400 ms** but is the largest build.

**Vercel = Neon region**: already done, so it saves **0**.

The throwaway probe test was deleted. No repo files were changed apart from this doc.
