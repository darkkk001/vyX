# Testing

## 1. Today

No automated test suite exists in the current Next.js codebase — no unit
tests, no integration tests, no E2E tests. Verification during this
engagement has been manual (build locally, click through the WebTrader
UI, build/launch the Electron `.exe` locally). This is a real gap, stated
plainly rather than implied — it means the "never destroy existing
working functionality" rule (ADR-003) has so far been upheld by manual
QA, not a regression suite.

## 2. Target: Rust Trading Core test/benchmark gates (spec §21/§29)

The master spec's own "Definition of Done" ties directly into ADR-003's
cutover condition ("cut over broker-by-broker once the Rust core passes
its own test/benchmark gates"). This doc defines what those gates are so
that condition is checkable, not just aspirational:

| Layer | Requirement | Status (2026-08-17) |
|---|---|---|
| OMS state machine | Every legal transition in `trading-engine.md` §2.1 has a unit test; every illegal transition is asserted unreachable (ideally unreachable at the type level, tested regardless) | **Closed.** `every_documented_legal_transition_is_legal` asserts all 11 legal `(from, to)` pairs from `is_legal_transition`'s match arms individually, including the two `cancel_order` depends on (`Accepted→Cancelled`, `PartiallyFilled→Cancelled`); `terminal_states_have_no_outgoing_transitions` extended to also assert `Rejected`/`Expired` are illegal targets from every terminal state. |
| Risk/Margin | Unit tests for the margin formula, pre-trade checks (§2.1 in `risk-engine.md`), and the margin-call/stop-out monitor against a table of known-correct inputs/outputs | **Closed.** `risk` had 21 tests already (incl. `validate_sl_tp`). `margin` gained 4: the exact-boundary "`<` not `<=`" semantic at both the call and stop-out level, the flat-account (`used_margin == 0`) case, and a non-default `MarginThresholds` proving broker-specific config actually changes the outcome. |
| Execution | Fill-price correctness against a mocked Market Data Core feed; partial-fill and reject paths, not just the happy path | **Partially not applicable.** Fill-price happy-path is tested (`buy_fills_at_ask`/`sell_fills_at_bid`). The partial-fill half doesn't have a test gap so much as a *feature* gap: `execute_market_order` has exactly one `ExecutionStrategy::Internal` branch that always fills 100% of requested volume (`remaining_volume` hardcoded to `Decimal::ZERO`) — `execution.md` §2.1.2 explicitly documents "no partial fills or slippage model for Phase 2." This row can't be closed by writing more tests; it needs a partial-fill execution path to exist first, which is out of scope for Phase 2 by design. Revisit this row's wording once/if that changes. |
| Market Data Core | Candle-bucketing correctness ported test-for-test from whatever coverage `lib/price-feed.ts`'s bucketing math has today (currently none — so this is also new coverage, not just a port) | **Closed.** All 6 fixed-millisecond timeframes now individually tested (previously only `M1`); `candle_updates_for_tick` — the function every DB writer actually consumes per tick, previously untested — now has coverage confirming it returns one `CandleUpdate` per timeframe with the correct OHLC-from-bid values and bucket starts matching `bucket_start` called directly. |
| Concurrency/latency benchmark | Order placement to fill under concurrent load — a specific number isn't set here since no current baseline exists to compare against; the first Rust benchmark run becomes the baseline other changes are measured against | **Tooling closed, first baseline recorded — with an important caveat.** `engine/loadtest` (`cargo run -p loadtest --release`) hits the real `POST /v1/orders/market` under concurrent load (HTTP → OMS → Postgres → NATS, not an in-process micro-benchmark), self-seeds a live tick, self-cleans every row it creates. First real run, `LOADTEST_CONCURRENCY=8 LOADTEST_REQUESTS=80` against this sandbox's actual dev Postgres (`db.prisma.io`): **80/80 filled, 0 errors, p50=13915ms p95=18713ms p99=19284ms max=19610ms, 0.5 req/s.** An earlier attempt at concurrency 20 instead surfaced a *different*, also-real finding first: `engine/server`'s sqlx pool used the bare default (`PgPool::connect`, no `max_connections` set) and returned `PoolTimedOut` on 193 of 200 requests. The concurrency-8 numbers themselves are dominated by this specific sandbox's remote-DB round-trip latency (`sqlx::pool::acquire` logged 2–3s per acquire even with an idle pool, and `place_market_order` makes ~8–10 sequential round-trips per order) — **not representative of engine code performance**, and not comparable to a production deployment with a co-located, properly-pooled Postgres.

**Pool-sizing fix applied and verified (2026-08-17).** `db::connect_pool` now takes an explicit `max_connections` (via `PgPoolOptions`, not the bare `PgPool::connect` default of 10); `engine/server` reads it from a new `DATABASE_POOL_MAX_CONNECTIONS` env var, default 20. Re-ran the exact concurrency-20/200-request scenario that failed before: `PoolTimedOut` count dropped from 193/200 to 94/200 — a real, measured improvement, not a full fix. The remaining failures weren't a sizing bug anymore, they were this sandbox's DB latency itself: at concurrency 20, each in-flight request held a connection for 15–30+ seconds (round-trip latency × ~8-10 sequential queries), so even 20 pool slots saturated before earlier requests finished.

**Round-trip reduction applied and verified (2026-08-17), the second lever named above.** `place_market_order` did all its work inside one uncommitted transaction, including three `db::set_status` writes (`Validating`/`Accepted`/`Routing`) that nothing outside the transaction could ever observe before commit (Postgres's default READ COMMITTED isolation, confirmed no `SET TRANSACTION ISOLATION LEVEL` anywhere in the workspace) — provably redundant round trips, not a behavior change to remove. Removed all three (and the equivalent redundant `Validating` write in `place_pending_order`, whose `Accepted` write is the real terminal state there and stays). Also combined `get_symbol_exposure` + `get_broker_max_open_positions` (previously two independent round trips) into one query, `get_exposure_and_max_positions`. Net: `place_market_order` dropped from ~12-14 round trips to ~8-9. Live-verified the two DB rows this touches (a `FILLED` order's `filled_price`, a `REJECTED` order's `reject_reason`) are byte-for-byte identical to before. Re-ran the exact same `LOADTEST_CONCURRENCY=8 LOADTEST_REQUESTS=80` scenario for a direct before/after comparison:

| | Before | After |
|---|---|---|
| p50 | 13915ms | **3955ms** |
| p95 | 18713ms | **8083ms** |
| p99 | 19284ms | **8117ms** |
| max | 19610ms | **8141ms** |
| throughput | 0.5 req/s | **1.8 req/s** |
| errors | 0/80 | 0/80 |

**~3.5x lower p50 latency, ~3.6x higher throughput**, same 0-error correctness — a larger improvement than the raw round-trip-count reduction alone would suggest (~30-35% fewer round trips), consistent with each request also holding its pool connection for less wall-clock time, which compounds under concurrency (frees a slot for a waiting worker sooner). Numbers still reflect this specific sandbox's remote-DB latency profile (not a production, co-located-Postgres deployment) — the *relative* improvement is the durable finding, not the absolute milliseconds. The bigger, not-yet-attempted lever (deferring the order `INSERT` itself until the final outcome is known, collapsing INSERT+multiple-UPDATEs into one INSERT) remains a possible further optimization, flagged but not built in this pass. |

## 3. Integration testing across the Gateway boundary

Once the API Gateway is extracted (`api.md` §2), integration tests
exercise the real REST/WebSocket surface end-to-end (Gateway → Rust core
→ Postgres → response), not just each module in isolation — catches
serialization/contract mismatches a pure unit test can't.

## 4. Cutover test plan (broker-by-broker, per ADR-003)

Before any broker is switched from the Next.js trading path to the Rust
core:

1. Full order-lifecycle smoke test against that broker's demo accounts on
   the new path (place, fill, modify, close, for each order type).
2. Parallel-run comparison for a period: same order submitted to both
   paths in a staging environment, fills/margin/P&L compared for
   equivalence — not automated further here since it depends on
   infrastructure (staging environment mirroring both paths) that doesn't
   exist yet.
3. Rollback plan: since the old Next.js path stays live and unmodified
   throughout (ADR-003), rollback for a broker is "point them back," not
   a data migration in reverse — this is the main practical benefit of
   ADR-003's approach over a hard cutover.

## 5. Explicitly out of scope for Phase 0

Load testing at production scale, chaos/fault-injection testing, and a
CI pipeline's exact tool choice (GitHub Actions vs. something else) are
implementation/process decisions for Phase 1+, not architecture.
