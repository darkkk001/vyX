# Testing

## 1. Today

No automated test suite exists in the current Next.js codebase — no unit
tests, no integration tests, no E2E tests. Verification during this
engagement has been manual (build locally, click through the WebTrader
UI, build/launch the Tauri desktop app locally). This is a real gap, stated
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

**~3.5x lower p50 latency, ~3.6x higher throughput**, same 0-error correctness — a larger improvement than the raw round-trip-count reduction alone would suggest (~30-35% fewer round trips), consistent with each request also holding its pool connection for less wall-clock time, which compounds under concurrency (frees a slot for a waiting worker sooner). Numbers still reflect this specific sandbox's remote-DB latency profile (not a production, co-located-Postgres deployment) — the *relative* improvement is the durable finding, not the absolute milliseconds. The bigger, not-yet-attempted lever (deferring the order `INSERT` itself until the final outcome is known, collapsing INSERT+multiple-UPDATEs into one INSERT) remains a possible further optimization, flagged but not built in this pass.

**In-memory tick cache applied and verified (2026-08-18), a third lever — removing the price-lookup round trip entirely rather than reducing it.** `place_market_order`/`place_pending_order` each called `market_data::db::get_live_price` (a Postgres SELECT) on every order just to read the current price, even though the same tick already flows through the process in memory via NATS ingest. New `market_data::cache::TickCache`, populated at ingest time, read first by both order-placement functions with the original Postgres read kept only as a cold-start fallback — see `architecture.md` item 24 for the full design writeup. `engine/loadtest` itself had to be fixed first: it seeded `"LivePrice"` via raw SQL, bypassing the real ingest path and leaving the new cache permanently cold — switched to `POST /internal/price-feed`, the real ingest route. Re-ran the identical `LOADTEST_CONCURRENCY=8 LOADTEST_REQUESTS=80` scenario against this same sandbox's dev Postgres, directly against the table above's "After" column:

| | Before (round-trip reduction) | After (+ tick cache) |
|---|---|---|
| p50 | 3955ms | **3093ms** |
| p95 | 8083ms | 8165ms |
| p99 | 8117ms | 8167ms |
| max | 8141ms | 8169ms |
| throughput | 1.8 req/s | **2.0 req/s** |
| errors | 0/80 | 0/80 |

**~22% lower p50, consistent with removing 1 of the remaining ~8-9 round trips** — p95/p99/max are within this sandbox's normal run-to-run noise (its remote Postgres round-trip time isn't perfectly stable), not a regression. Both paths live-verified, not just the happy path: a normal order fills at the cached price with zero DB read in the common case; a `trading-core-server` restart (empty cache) immediately followed by an order placement still fills correctly via the Postgres fallback, confirming a cold start can't strand order placement. Scoped to the Rust engine only — no broker has cut over yet, so this doesn't change today's live latency (see `decisions.md` ADR-003).

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

   **Tooling now exists, reframed (2026-08-17) — this item's own premise
   didn't hold once investigated.** `engine/parallel-run` (`cargo run -p
   parallel-run`) submits the same nominal order to both paths and
   reports what each side does — it does **not** assert equivalence,
   because "equivalent" isn't actually the right goal between these two
   systems today. Confirmed, not assumed: zero margin/exposure/max-
   position code exists anywhere in the Next.js path (`app/`, `lib/`) —
   it fills whatever the client asks, at whatever price the client
   supplies (its own route comment calls this "a deliberate, temporary
   simplification... replaces this wholesale in Phase 5"); Rust always
   fetches its own price and fully gates on margin/exposure/max-
   positions. Live-verified both concrete divergences this implies: (1)
   given the *same* seeded reference price, Rust's fill price differs
   from Legacy's by exactly the broker's configured `spreadMarkup` —
   Legacy applies no server-side markup at all; (2) a 100-lot order with
   insufficient margin fills unconditionally on Legacy and is correctly
   `REJECTED` on Rust with a specific reason. Neither is a bug to
   reconcile — Legacy is a documented Phase 2 stopgap, and Rust doing
   the *correct* thing is the point of Phase 5, not a divergence to
   suppress. "Equivalence" as literally written above isn't achievable
   until Legacy either backports these checks or a broker is fully
   retired from that path — this tool exists to make that fact
   concrete and re-checkable, not to paper over it.

   **Sustained-monitoring mode — done for local use (2026-08-18).**
   `engine/parallel-run` no longer has to be one-shot: set
   `PARALLEL_RUN_LOOP_SECS` to run both scenarios repeatedly on that
   interval (seeding fixtures once, cleaning up once at the end, whether
   that's a normal stop, `PARALLEL_RUN_MAX_ITERATIONS` being reached, or
   Ctrl+C) instead of exiting after one pass. Each iteration appends one
   structured JSON line to `PARALLEL_RUN_LOG`
   (default `parallel-run.jsonl`) — a reviewable history over "a
   period," not just a point-in-time snapshot, alongside the existing
   human-readable narration. New `engine/scripts/staging-up.sh` /
   `staging-down.sh` bring up the local pieces this needs (`nats-server`
   + `engine/server`, both as background processes with PID/log files
   under `engine/scripts/.staging/`) and start the loop-mode monitor
   automatically — plain bash around the same native binaries every
   Rust-engine verification this whole engagement has already used
   (no Docker anywhere in this sandbox or this repo; the scripts carry
   over to a real Linux host unchanged). They deliberately don't manage
   the Next.js dev server's lifecycle — only check it's reachable and
   say so plainly if not.

   Live-verified for real, not just described: built the release
   binaries, brought the whole local stack up via `staging-up.sh`, let
   it run 3 real loop iterations, confirmed both scenarios' expected
   divergences (spread-markup delta, margin-check rejection) landed
   correctly in `parallel-run.jsonl` every time, confirmed the process
   exited and cleaned up its own fixtures on hitting the iteration cap,
   independently verified zero leftover rows via a direct DB query (not
   just trusting the tool's own "cleaned up" message), then confirmed
   `staging-down.sh` stopped every remaining process — checked
   independently via the OS process list, not just the script's own
   exit code.

   **Still missing, and explicitly not attempted here**: this proves the
   mechanism works on a local machine. Actually running it *sustained*
   (hours/days, unattended) on real hosted infrastructure is the user's
   own next step — they have a VPS already and plan to deploy the whole
   `vyX` folder there once everything's proven locally, which is exactly
   what this pass was for. No hosting was provisioned and no VPS access
   exists from this sandbox; that step needs the user's own
   credentials/action, not more engineering here.
3. Rollback plan: since the old Next.js path stays live and unmodified
   throughout (ADR-003), rollback for a broker is "point them back," not
   a data migration in reverse — this is the main practical benefit of
   ADR-003's approach over a hard cutover.

## 5. Explicitly out of scope for Phase 0

Load testing at production scale and chaos/fault-injection testing are
implementation/process decisions for Phase 1+, not architecture.

**CI pipeline — decided and built (2026-08-18).** GitHub Actions,
`.github/workflows/engine-ci.yml`, scoped to `engine/` only (the Rust
Trading Core workspace — not the Next.js web app, which has no
automated test suite yet per §1 above, and not `desktop-tauri/`'s own
separate Cargo project). Runs on push to `main` and
`claude/vyxtrader-platform-setup-0odm99` and on PRs targeting `main`,
path-filtered to `engine/**` so unrelated commits don't trigger it.
`cargo build --workspace --all-targets` and `cargo test --workspace`
are hard gates; `cargo clippy`/`cargo fmt --check` run but don't fail
the job (the workspace has pre-existing warnings/formatting diffs
neither of those introduced — see below — so making them hard gates now
would fail CI on day one for code this task wasn't asked to touch;
cleaning that up is a separate follow-up, not bundled in here).

**No Postgres/NATS service container in CI, deliberately.** Confirmed
before relying on it, not assumed: `order-management/src/db.rs` and
`market-data/src/db.rs` already document (and were grepped to confirm,
zero real hits) that this workspace uses runtime-checked
`sqlx::query`/`query_as` everywhere, never the compile-time
`sqlx::query!`/`query_as!` macros — so building/testing the whole
workspace needs no live database anywhere, unlike `loadtest`/
`parallel-run` (deliberately excluded from CI for exactly that reason —
they need a real running Postgres+NATS+server, which belongs with the
still-missing parallel-run staging environment, §4's own open item, not
this build/test gate).

**Known pre-existing gaps this CI surfaces but doesn't fix**: the
workspace isn't `cargo fmt`-clean (real diffs in `execution`,
`loadtest`) and `cargo clippy` currently reports 3 warnings (two
inconsistent-digit-grouping, one `await_holding_lock` in `loadtest`) —
none introduced by adding CI, all pre-existing, none fixed here since
that wasn't in scope for "add a CI pipeline."
