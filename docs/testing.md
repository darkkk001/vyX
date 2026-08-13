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

| Layer | Requirement |
|---|---|
| OMS state machine | Every legal transition in `trading-engine.md` §2.1 has a unit test; every illegal transition is asserted unreachable (ideally unreachable at the type level, tested regardless) |
| Risk/Margin | Unit tests for the margin formula, pre-trade checks (§2.1 in `risk-engine.md`), and the margin-call/stop-out monitor against a table of known-correct inputs/outputs |
| Execution | Fill-price correctness against a mocked Market Data Core feed; partial-fill and reject paths, not just the happy path |
| Market Data Core | Candle-bucketing correctness ported test-for-test from whatever coverage `lib/price-feed.ts`'s bucketing math has today (currently none — so this is also new coverage, not just a port) |
| Concurrency/latency benchmark | Order placement to fill under concurrent load — a specific number isn't set here since no current baseline exists to compare against; the first Rust benchmark run becomes the baseline other changes are measured against |

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
