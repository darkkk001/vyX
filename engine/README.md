# engine — VyXTrader Rust Trading Core

Phase 1 workspace scaffold. See `../docs/architecture.md`,
`../docs/trading-engine.md`, `../docs/risk-engine.md`,
`../docs/execution.md`, and `../docs/market-data.md` for design context —
this README only orients the code layout.

## Status

Scaffold only. State-machine legality, the margin formula, margin-call/
stop-out evaluation, candle bucketing, and internal-strategy fill pricing
are implemented and unit-tested (pure functions, no I/O). Postgres/NATS
wiring, the actual OMS orchestration loop, and the ongoing margin-monitor
loop are Phase 2 work — not started, per the master spec's own phase
ordering.

The existing Next.js/Prisma trading path (`../app/api/trade/*`,
`../lib/trading.ts`) keeps running unmodified and is unaffected by
anything in this directory — see ADR-003 in `../docs/decisions.md`.

## Layout

| Crate | Role |
|---|---|
| `protocol` | Shared types/events crossing crate and NATS boundaries |
| `market-data` | Tick ingest, candle bucketing (ported from `lib/price-feed.ts`) |
| `order-management` | Order state machine, the sole writer of `orders` |
| `position` | Position state, applies fills |
| `risk` | Pre-trade margin/exposure checks |
| `margin` | Ongoing margin-call/stop-out monitor logic |
| `execution` | Fill pricing (internal/B-book strategy) |
| `ledger` | Balance-affecting entries (deposits, P&L, commission, swap) |

## Building

```
cd engine
cargo build
cargo test
```

Verified: `cargo build` and `cargo test` both pass clean (16 tests, 0
failures, 0 warnings) with Rust 1.97.1 + MSVC build tools on Windows.
