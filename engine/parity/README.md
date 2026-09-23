# Stop-out / margin-call / SL-TP parity harness (Stage 0)

Runs the same scenarios through both implementations and diffs the outcome:

- **web (TS)**: what production runs today, `lib/risk-monitor.ts` `evaluateAccountRisk`, against a real
  Postgres (`scripts/parity/run-ts.ts`).
- **engine (Rust)**: this crate. It calls the engine's own `order_management::calc`, `risk` and `margin`
  functions with **no database**. Stage 1 adds the DB layer.

Stage 0 only makes the differences visible. It does not fix either path.

## Run it end to end

This needs the scratch Postgres at `D:\pg-scratch` running on `127.0.0.1:5499`. **Never** point this at the repo's
`.env` URL, because that is production.

```bash
# one-time: create + migrate the harness DB (migrate deploy only)
URL=postgresql://postgres@127.0.0.1:5499/vyx_rust_harness
/d/pg-scratch/pgsql/bin/createdb.exe -h 127.0.0.1 -p 5499 -U postgres vyx_rust_harness
DATABASE_URL=$URL DIRECT_URL=$URL npx prisma migrate deploy
#   20260921160000_stage3a_group_the_ungrouped is a production-data migration: it aborts on an
#   empty DB. Mark it applied (same as vyx_test) and re-run deploy:
#   npx prisma migrate resolve --rolled-back 20260921160000_stage3a_group_the_ungrouped
#   npx prisma migrate resolve --applied     20260921160000_stage3a_group_the_ungrouped

# every run (from the repo root):
bash scripts/parity/run-all.sh            # plain table; add --markdown for the table below
```

`run-all.sh` runs three steps:

1. `DATABASE_URL=$URL DIRECT_URL=$URL npx tsx --conditions=react-server scripts/parity/run-ts.ts`
   writes `out/ts/*.json`.
2. `cd engine && cargo run -p parity` writes `out/rust/*.json`.
3. `node scripts/parity/diff.mjs` prints the table. It exits 1 if any scenario FAILs.

`cargo test -p parity` covers the scenario loader: every checked-in scenario loads and validates, dangling
references are rejected, the freshness rule works, and one minimal stop-out is evaluated.

### How the TS runner stays local

- It refuses to start unless `DATABASE_URL` and `DIRECT_URL` both equal the harness URL. Before its first write it
  also checks `current_database()` and `inet_server_port()`.
- Each scenario TRUNCATEs every table in `vyx_rust_harness`, then seeds that scenario's data.
- `MARKET_DATA_PRICES=""`, so `lib/live-price.ts` reads `LivePrice` from this DB and never calls the VPS.
- `globalThis.fetch` is stubbed. Gateway event publishes get a local 204. Any other outbound fetch throws.
- `--conditions=react-server` resolves `server-only` to its no-op entry, so the libs run unmodified.
- Symbols are seeded as `CRYPTO`, which is continuously traded. The trading-session gate in `checkTradingSession`
  therefore never hides a price, and results don't depend on the weekday.
- `marginLevelBefore` (TS) is the web level before any close. `evaluateAccountRisk` doesn't return it, so the runner
  builds it from the same exported helpers that pass 2 uses (`getFreshPrices`, `closePriceFor`,
  `computeRealizedPnl`, `liveUsedMarginFor`).

### What the Rust side mirrors, and why

- These functions are private and `async` over a `PgPool`, so their selection logic is copied into `src/lib.rs`:
  - `monitor.rs` `sl_tp_trigger` (line 53)
  - `force_close_worst` (line 152: min P&L among priced positions)
  - `evaluate_account` (line 186: SL/TP in reverse index order, then a bounded `margin::evaluate` loop)
- The engine checks price freshness in SQL (`db.rs:894`, keyed on `LivePrice."updatedAt"`). `fresh_for_engine`
  applies the same rule to `updatedAgeSeconds`, falling back to `ageSeconds`.
- `finalBalance` is the starting balance plus the realized P&L of the closes the engine decided on. The engine
  books those as `ledger_entries`.
- `transactions` lists the TRADE_PNL amounts the engine would book.

## Scenario format (`scenarios/*.json`)

| field | contents |
|---|---|
| `name` | Must equal the file name. |
| `why` | One-line purpose of the scenario. |
| `knownDivergence` | `[{id, fields[], note}]`. A difference in a listed field is reported as EXPECTED-DIVERGENCE. |
| `broker` | `{negativeBalanceProtection}` |
| `groups` | `[{key, marginCallLevel, stopOutLevel}]`. The first group is the default. |
| `accounts` | `[{key, group, balance, credit, leverage}]` |
| `symbols` | `[{name, contractSize, digits, quoteCurrency}]` |
| `positions` | `[{key, account, symbol, side, volume, openPrice, slPrice?, tpPrice?}]`. Position ids in both outputs are these keys. |
| `prices` | `[{symbol, bid, ask, ageSeconds, updatedAgeSeconds?}]`. `ageSeconds` sets the `tickAt` age, which the web path gates on. `updatedAgeSeconds` sets the `updatedAt` age, which the engine gates on. It defaults to `ageSeconds`. A symbol with no entry has no `LivePrice` row. |

Decimals are strings.

Each output file has one entry per account: `{marginLevelBefore, closedPositionIds (in order), closeReasons,
finalBalance, transactions [{type, amount}], marginCallNotified}`.

## What each scenario proves

| scenario | proves |
|---|---|
| 01-healthy-no-action | A healthy account (level ~550%) triggers no action on either path. |
| 02-stop-out-one-close | The single worst position is force-closed. The survivor is then above 50%, so the loop stops after one close. |
| 03-stop-out-two-sequential-closes | Closes go worst-first and the level is recomputed after each one. It takes two closes to recover. |
| 04-sl-hit | A BUY's SL is hit at the bid and closes regardless of margin. |
| 05-tp-hit | A SELL's TP is hit exactly at the ask (`<=` boundary). |
| 06-credit-decides-stop-out | **Known divergence**: the engine counts credit in equity and the web does not. The web stops out; Rust only raises a margin call. |
| 07-margin-open-vs-live-crosses-threshold | **Known divergence**: used margin at open price (Rust) vs live price (web) puts the two levels on opposite sides of 50%. |
| 08-no-fresh-price | **Known divergence**: Rust still counts an unpriced position's margin (at open price) and stops out. The web excludes it and does nothing. |
| 09-level-exactly-margin-call | **Known divergence**: at a level of exactly 100.00, the web raises a margin call (`<=`) and Rust does not (`<`). |
| 10-negative-balance-protection | A deep stop-out on a broker with NBP on. The web floors the balance at 0 and books a +500 write-off. |
| 11-custom-group-thresholds | Per-group levels are read. A 150/80 group stops out at 70%; the default 100/50 group only raises a margin call. |
| 12-heartbeat-stale-tick | The last real tick is 60 s old but the row was re-written 1 s ago (EA heartbeat). The web treats the price as stale; Rust treats it as fresh. |

## Current results (2026-09-23)

| scenario | result | what differs |
|---|---|---|
| 01-healthy-no-action | EXPECTED-DIVERGENCE | level ts=547.26 rust=550.00 [used-margin-open-vs-live] |
| 02-stop-out-one-close | EXPECTED-DIVERGENCE | level ts=9.99 rust=9.95 [used-margin-open-vs-live] |
| 03-stop-out-two-sequential-closes | EXPECTED-DIVERGENCE | level ts=4.97 rust=4.95 [used-margin-open-vs-live] |
| 04-sl-hit | EXPECTED-DIVERGENCE | level ts=426.29 rust=424.17 [used-margin-open-vs-live] |
| 05-tp-hit | EXPECTED-DIVERGENCE | level ts=958.90 rust=954.55 [used-margin-open-vs-live] |
| 06-credit-decides-stop-out | EXPECTED-DIVERGENCE | level ts=10.04 rust=60.00; closed ts=[p1] rust=[]; balance ts=200 rust=1000; txns ts=[PNL:-800] rust=[-]; marginCall ts=false rust=true [credit-in-equity] |
| 07-margin-open-vs-live-crosses-threshold | EXPECTED-DIVERGENCE | level ts=50.53 rust=48.00; closed ts=[] rust=[p1]; balance ts=10960 rust=960; marginCall ts=true rust=false [used-margin-open-vs-live] |
| 08-no-fresh-price | EXPECTED-DIVERGENCE | level ts=500.00 rust=41.67; closed ts=[] rust=[p1]; txns ts=[-] rust=[PNL:0] [unpriced-position-margin] |
| 09-level-exactly-margin-call | EXPECTED-DIVERGENCE | marginCall ts=true rust=false [margin-call-lte-vs-lt] |
| 10-negative-balance-protection | **FAIL** | balance ts=0 rust=-500; txns ts=[PNL:-1000, NEGATIVE_BALANCE_PROTECTION:+500] rust=[PNL:-1000] |
| 11-custom-group-thresholds | EXPECTED-DIVERGENCE | a1/a2 level ts=70.21 rust=70.00 [used-margin-open-vs-live] (decisions match) |
| 12-heartbeat-stale-tick | **FAIL** | level ts=null rust=10.00; closed ts=[] rust=[p1]; balance ts=1000 rust=200 |

The SL/TP and stop-out *decisions* agree everywhere except the four known divergences and the two FAILs. The
FAILs are real engine gaps that are not on the known list:

- **10: no negative-balance protection in the engine.** `order-management/src/db.rs:934`
  (`close_position_with_ledger_entry`) writes the raw P&L to `ledger_entries`. The engine has no NBP floor and no
  write-off entry anywhere (`grep -ri negative_balance engine/` finds nothing). The web path does both
  (`lib/position-close.ts:~100-150`).
- **12: the engine gates freshness on `updatedAt`, not `tickAt`.** `order-management/src/db.rs:894` uses
  `lp."updatedAt" > now() - interval '15 seconds'`. `lib/live-price.ts:137` deliberately switched to `"tickAt"`,
  because the EA heartbeat bumps `updatedAt` while the price is frozen. The engine would stop out, or hit SL/TP,
  off a dead feed.

Also not covered here: if several positions hit SL/TP in the same pass, Rust closes them in reverse load order
(`monitor.rs:109`) and the web closes them in load order. Under negative-balance protection that order can change
the final balance. Every scenario here has at most one SL/TP hit.
