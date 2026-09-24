# Rust cutover, Phase 3: stop-out / margin call / SL-TP moves from the web to the engine

_Written 2026-09-23. Status (2026-09-24): pre-stage web money fixes LIVE (b5dc33c, 55b86da, 8b5f60b).
**Stage 0 DONE** (0417ad0). **Stage 1 DONE** (d8732b1). **Stage 2 DONE** (c25e1f8 F4, a938732 F2, d0d4045 F3,
d843c6d F1, 58729f6 F5; terminal dfea309): gate green, 20/20 parity scenarios MATCH on the real monitor
against the real schema. Stages 3-6 not started. ENGINE_ORDER_MANAGEMENT stays OFF._

## Scope

Today production's risk path is the web: `lib/risk-monitor.ts` (SL/TP, stop-out, margin call) called by
`/api/internal/margin-monitor` (Vercel cron `*/5`, the engine's per-symbol SL/TP hook, and the engine's
60 s backstop). The Rust engine is feed-only plus that hook; its own order management
(`engine/order-management`, flag `ENGINE_ORDER_MANAGEMENT`, default off since eef0b35) reads empty
lowercase tables (`positions`, `orders`, `ledger_entries`) while the real book is Prisma's
`"Position"` / `"Order"` / `"Transaction"`.

Phase 3 moves **stop-out, margin call and SL/TP** to the engine. Order placement, manual close, dealer
queue, mirror and coverage stay on the web. Nothing in this plan touches LP routing.

## Decisions (user, 2026-09-23)

| Question | Decision |
|---|---|
| Credit in equity | **Model A (2026-09-24, final; replaces the 2026-09-23 "credit out")**: equity = balance + credit + floating. A loss beyond the balance is paid from credit, then negative-balance protection. BEHAVIOR CHANGE on the web (production credit is 0, so no live effect yet). |
| Quote-currency conversion | Fix it everywhere. Web done in 55b86da (`lib/fx.ts`); Rust must use the same rule (Stage 2). |
| Admin-close double credit | Fix before the cutover. Done in b5dc33c. |
| Stop-out / margin call | `<=` for both (MT5), 2026-09-24. BEHAVIOR CHANGE on the web at exactly the threshold. |
| Freshness | `tickAt` (UTC) + trading sessions; EA confirmed to send UTC, no EA change. |
| Plan doc | This file. |

## Reference behaviour (what Rust must reproduce)

The web path after b5dc33c + 55b86da + 8b5f60b is the spec. Each row is pinned by a parity scenario
(`engine/parity/scenarios`).

| Rule | Web (spec) | Rust today | Stage |
|---|---|---|---|
| Equity | balance + floating of priced positions, **no credit** | balance + ledger sum + credit + floating | 1 (balance model), 2 (credit) |
| Used margin price | live close-side (BUY bid, SELL ask) | open price | 2 |
| Position without a fresh price | out of equity AND margin | margin at open price | 2 |
| Freshness | `LivePrice.tickAt` within 15 s, closed trading session = no price | `updatedAt` within 15 s | 2 (**FAIL 12**) |
| Quote -> account currency | `conversionRate` (pair, inverse, USD cross; mid; stale OK; missing = unpriced, close refused) | none | 2 |
| Stop-out | level < stopOut; close the single worst (account-currency P&L), recompute, repeat | same shape | ok |
| Margin call | level **<=** marginCall, edge-triggered via `Account.marginCallNotifiedAt` | level < marginCall | 2 |
| Thresholds | Group, defaults 100 / 50 | Group, defaults; grouped-but-unloaded account skipped | 2 |
| Close write | `closePositionInTx`: guard (status + volume), NBP, `Account.balance`, TRADE_PNL (+ NEGATIVE_BALANCE_PROTECTION + AuditLog) | ledger row only, no NBP | 1 (**FAIL 10**) |
| SL/TP order in one pass | load order | reverse order (`monitor.rs:109`) | 2 |

## Stages

Every stage ends at a gate; the next does not start until the gate is green.

### Pre-stage: web money bugs. DONE (b5dc33c + 55b86da deployed 2026-09-23; 8b5f60b committed)

- 8b5f60b: every read-modify-write of `Account.balance` locks the row first (`lib/account-lock.ts`):
  10 concurrent closes on one account lost 6-7 of their P&Ls without it. Concurrency test + 624/624.

- b5dc33c: admin close, reverse close and void go through the guarded close / claim; `closePositionInTx`
  guards on status AND volume (stale partial / stale full close no longer pay twice). 7 new tests.
- 55b86da: quote-currency conversion in the close, the risk monitor, margin snapshots and the pre-trade
  check (`NO_CONVERSION_RATE`). 12 new tests.
- Gate met: money-path suites 20 files, 573/573 (twice), on scratch `vyx_test`.
- Open: the terminal / backoffice **live floating-P&L display** reprices client-side without conversion,
  so a non-USD-quoted symbol shows a wrong floating number until those clients convert too (display
  only; server money figures are right). Needs a terminal + backoffice release.

### Stage 0: harness. DONE (0417ad0)

`bash scripts/parity/run-all.sh` (scratch DB `vyx_rust_harness` on 127.0.0.1:5499 only). Result:
0 MATCH, 10 EXPECTED-DIVERGENCE, **2 FAIL**, both real engine gaps now owned by Stages 1 and 2.
Details and per-scenario meaning: `engine/parity/README.md`.

### Stage 1: engine DB layer on the real schema. DONE

Delivered: `engine/order-management/src/book.rs` (the risk path's reads and the close on `"Position"` /
`"Account"` / `"Transaction"`, a line-for-line port of `closePositionInTx`: status + volume guard,
`FOR UPDATE` on the account, negative-balance protection + AuditLog, TRADE_PNL with the raw balanceAfter),
`calc::load_book_state` (balance = `Account.balance`, no ledger sum), `monitor.rs` on book.rs with the
web's note texts and a public `evaluate_account` returning an `EvalReport` (optional NATS; Stage 5's
shadow mode needs the decision, not just the rows). Tests: `tests/book_db.rs`, 6 DB tests including 10
real concurrent closes (fails without the row lock). Gate: `bash scripts/parity/run-db.sh` = 11
EXPECTED-DIVERGENCE (all Stage 2 formula tags) + 1 FAIL (scenario 12, Stage 2's freshness rule);
scenario 10 (NBP) now matches on balances and Transaction rows.

Scope note: only the RISK path moved. The engine's order path (insert_order / insert_position, pending
orders, swap, its own manual close at lib.rs:648) still uses the lowercase tables; it is behind
ENGINE_ORDER_MANAGEMENT (off) and has no callers, and moves in the order-execution phase, not this one.
The gateway's `"Position"` read (d84d926) moves with the Stage 2 formulas it has to share.

Original plan text:

- Rewrite the 24 statements in `engine/order-management/src/db.rs` onto `"Position"` / `"Order"` /
  `"Transaction"` / `"Account"`: `accountId`, `symbolId` join, `openPrice`, `deletedAt IS NULL`, VOIDED
  excluded, Prisma enum names, Decimal scales.
- The close does exactly what `closePositionInTx` does, in one transaction, INCLUDING negative-balance
  protection (FAIL 10) and the status + volume guard. `ledger_entries` stops being read or written.
- Fix `db.rs:530` (volume sum without `status='OPEN'`).
- Gateway: read `"Position"` directly (supersedes d84d926's union) with the Stage 2 formulas.
- Parity harness grows a DB mode: the Rust side seeds and reads `vyx_rust_harness` like the TS side.
- **Gate:** scenario 10 MATCH on balances and Transaction rows to 4 dp; a double-close race test.

### Stage 2: formulas (1-2 days)

Everything in the table above marked 2: no credit, live close-side margin price, unpriced positions out,
`tickAt` freshness + trading sessions (FAIL 12), quote-currency conversion with the web's rule, `<=` for
margin call, default thresholds instead of skipping, SL/TP order.
- **Gate:** all 12 scenarios MATCH (the known-divergence tags are removed); plus new scenarios for
  JPY-quoted positions and a closed trading session.

### Stage 2 — Canonical formulas (APPROVED 2026-09-24 with credit Model A and stop-out `<=`; IMPLEMENTED, gate 20/20)

Both engines implement exactly this. Decimal only (Prisma.Decimal / rust_decimal) for every money figure,
level and threshold; a JS `number` or f64 only at a display boundary. Every row names where the code
changes; "BEHAVIOR CHANGE" = the web's live money path acts differently afterwards.

**Harness baseline before any change** (`bash scripts/parity/run-db.sh`, scratch DB, 2026-09-24):
0 MATCH, 11 EXPECTED-DIVERGENCE, 1 FAIL.

| # | scenario | web (TS) | engine (Rust, real monitor on the real schema) | why |
|---|---|---|---|---|
| 01 | healthy | level 547.26 | 550.00 | margin at open vs live price |
| 02 | stop-out, one close | 9.99 | 9.95 | same |
| 03 | stop-out, two closes | 4.97 | 4.95 | same (same closes, same balance) |
| 04 | SL hit | 426.29 | 424.17 | same |
| 05 | TP hit | 958.90 | 954.55 | same |
| 06 | credit decides | level 10.04, stops out p1, balance 200 | 60.00, margin call only, balance 1000 | credit in equity |
| 07 | open vs live crosses | 50.53, margin call, no close | 48.00, stops out p1 (-10,000) | margin at open vs live price |
| 08 | no fresh price | 500.00, nothing | 41.67, closes the only priced position | unpriced position still in Rust's margin |
| 09 | level == call | margin call | none | `<=` vs `<` |
| 10 | negative-balance protection | -25.13 | -25.00 | level only (Stage 1 made balances match) |
| 11 | custom group thresholds | 70.21 | 70.00 | level only |
| 12 | heartbeat on a stale tick | no price, nothing | 10.00, stops out p1 | freshness on updatedAt (**FAIL**) |

#### CONFLICTS with earlier decisions (RESOLVED 2026-09-24: credit Model A, stop-out `<=`)

1. **Credit.** The 2026-09-23 decision (table at the top of this file) was "web behaviour: credit NOT in
   equity". The 2026-09-24 brief says `Equity = Balance + Credit + FloatingPnL`. These are opposite.
   Choosing the new one is a **BEHAVIOR CHANGE** on the live web path: an account holding credit is
   stopped out later (scenario 06 flips from "stop out at 10.04%" to "margin call at 60%").
2. **Stop-out comparison.** Both engines today stop out on `level < stopOut` (web `risk-monitor.ts:209`
   exits on `>=`; engine `margin/src/lib.rs:90`). The brief says `<=` for stop-out too: a **BEHAVIOR
   CHANGE** at exactly the threshold (an account sitting on exactly 50.00% is stopped out). Margin call
   `<=` is already the web's rule (`risk-monitor.ts:277`).

The rows below are written for the 2026-09-24 brief (credit IN, `<=` for both) and mark what changes if you
keep the earlier choice instead.

#### F1. Equity and credit

- **Formula:** `Equity = Balance + Credit + Σ floating P&L` over positions that have a usable price
  (F4), each converted to the account currency (F2). Balance, credit and P&L in the account currency.
- **Credit is not withdrawable:** withdrawals and transfers check `balance`, never `balance + credit`
  (true today: `lib/funds-approval.ts:130` withdrawal check, `app/api/manage/transfers/route.ts:99`).
- **Credit and negative-balance protection (the consumption rule), proposed:** a close whose loss takes
  the BALANCE below zero first consumes CREDIT, up to the shortfall; only what credit cannot cover is
  written off by NBP (broker absorbs), or left negative when the broker has NBP off.
  Example: balance 50, credit 200, loss 500 -> raw balance -450 -> credit 200 absorbs 200 (credit 0,
  balance -250) -> NBP writes off 250 -> balance 0, credit 0. Rows: TRADE_PNL -500, CREDIT -200
  ("credit consumed by loss"), NEGATIVE_BALANCE_PROTECTION +250.
  *Why this and not "credit untouched":* with credit counted in equity, a client could trade a bonus,
  lose it, have the broker's NBP eat the loss and still keep the full bonus. Needs your OK: it is a
  product rule, and it changes what an NBP write-off costs the broker.
- If you keep **credit OUT** instead: equity = balance + floating, credit plays no part in stop-out and
  is never consumed; F1 then changes nothing on the web and only Rust drops credit.
- **Changes:**
  - TS equity: `lib/risk-monitor.ts:194` (stop-out pass) and `:267` (margin-call pass) add
    `account.credit`; `lib/margin.ts:50` (snapshot) and `:207` (pre-trade) add credit. **BEHAVIOR CHANGE.**
  - TS consumption: `lib/position-close.ts:119-170` (NBP block) consumes credit first, one CREDIT row.
    **BEHAVIOR CHANGE.**
  - Rust equity already adds credit (`order-management/src/calc.rs:57`): stays.
  - Rust consumption: `order-management/src/book.rs` NBP block (`close_position_in_tx`), same rule/rows.

#### F2. Margin: LIVE, converted at the current rate

- **Formula:** `UsedMargin = Σ volume × contractSize × livePrice / leverage × fxRate` over positions with a
  usable price. `livePrice` = the side that would close it now (BUY bid, SELL ask). `fxRate` = quote ->
  account currency from `lib/fx.ts` (pair, inverse, or a USD cross; mid of the latest quote; age not
  required; missing rate = the position is treated as unpriced). Leverage = the account's own.
- A position with no usable price is in NEITHER equity nor used margin (web today; F4 defines "usable").
- **Changes:**
  - TS: no change (`lib/risk-monitor.ts:203`, `:273`; `lib/margin.ts:113-123`). Pre-trade
    (`lib/margin.ts:219`) keeps its deliberate conservative fallback: an unpriced EXISTING position is
    counted at its open price when deciding whether a NEW order may open (stricter, never looser).
  - Rust: `order-management/src/calc.rs:40-45` `used_margin` -> live close-side price x fxRate, priced
    positions only; `calc.rs:48-57` floating x fxRate. New `order-management/src/fx.rs`, a port of
    `lib/fx.ts` with the same tests; `book.rs` query gains `Symbol.quoteCurrency`, `Account.currency`.
  - Rust close P&L converted and rounded to 4 dp exactly like `lib/position-close.ts:59-67`; a missing rate
    refuses the close.
  - TS display: `lib/margin.ts:28-77` sums money as JS numbers; switch to Decimal internally, `number`
    only in the returned snapshot (no behaviour change, removes f64 money math).

#### F3. Thresholds and the margin level

- **Level:** `MarginLevel = Equity / UsedMargin × 100`, a percent, Decimal, NOT rounded before comparing
  (thresholds are `Decimal(6,2)` percents on Group).
- **UsedMargin = 0 -> level is null (infinite)**, and null never triggers a margin call or a stop-out.
  Already true: web `risk-monitor.ts:207`, `:275`, `margin.ts:74`; engine `risk/src/lib.rs:82-85`,
  `margin/src/lib.rs:89`. Cleanup only: `monitor.rs:259`, `:269` print 0 for a null level in the event /
  note text; print "n/a".
- **Comparisons (brief):** margin call when `level <= marginCallLevel`; stop-out when `level <= stopOutLevel`,
  closing the single worst position (account-currency P&L) and re-evaluating, until `level > stopOut`, the
  level is null, or nothing priced is left.
- **Source:** the account's Group (`marginCallLevel`, `stopOutLevel`), read with the account in the same
  query, every evaluation. An account with no group: global defaults 100 / 50 (web `risk-monitor.ts:182`,
  `:263`). No cached map; the engine stops skipping accounts whose group was "not loaded".
- **Changes:**
  - TS stop-out `<=`: `lib/risk-monitor.ts:209` exits on `gt` instead of `gte`. **BEHAVIOR CHANGE**
    (only at exactly the threshold). Keep-`<` alternative: no change.
  - Rust: `margin/src/lib.rs:87-92` `evaluate` -> `<=` for both (and its two unit tests at `:164`,
    `:172` that pin `<`); `monitor.rs:234-235` + `db::load_group_thresholds` -> thresholds joined in
    `book.rs`/`calc::load_book_state` with the 100/50 defaults.

#### F4. Price freshness: `tickAt` (UTC), plus trading sessions

- **Usable price** = a LivePrice row whose `tickAt` is at most 15 s old AND whose symbol's trading session is
  open now. `updatedAt` is ignored: the EA's heartbeat re-sends an unchanged price every few seconds, which
  bumps `updatedAt` while `tickAt` stays at the real last tick.
- Session rule = web `lib/risk.ts:201-232` `checkTradingSession`: CRYPTO always open; no configured
  sessions -> default FX/metals weekend (Fri >= 21:00 UTC to Sun < 22:00 UTC) and the metals daily break
  (the NY-close hour, US-DST aware); otherwise the BrokerSymbol's configured sessions (UTC).
- **Changes:**
  - TS: no change (`lib/live-price.ts:127` tickAt cutoff; `lib/risk-monitor.ts:87` session gate).
  - Rust: `book.rs:52` join on `"tickAt"` instead of `"updatedAt"`; new `order-management/src/session.rs`,
    a port of `checkTradingSession` with the web's unit cases; `book.rs` loads `Symbol.category` and the
    BrokerSymbol sessions.

**EA tickAt finding (no EA change proposed):**
- The EA already sends UTC: `tick_ms = tick.time_msc - BrokerOffsetSec*1000`
  (`mt5-ea/VyXTraderPriceFeed.mq5:1388`), `BrokerOffsetSec = TimeTradeServer() - TimeGMT()` rounded to
  the minute (`:230-235`).
- The engine writes `LivePrice.tickAt` from that `tick_ms`, falling back to the arrival time only when
  `tick_ms` is missing or more than 100 ms in the future (`engine/market-data/src/ingest.rs:96-101`).
  So `tickAt` is UTC, not Pepperstone server time.
- **DST:** the offset is recomputed after every successful clock sync (`mq5:594`, every
  `ClockSyncIntervalSec` = 60 s, direct mode only). For at most ~60 s after the broker's DST switch the
  offset is an hour off:
  - spring (+2 -> +3): `tick_ms` is an hour in the future -> the engine uses the arrival time -> the price
    stays usable;
  - autumn (+3 -> +2): `tickAt` is an hour old -> both engines see no usable price for that minute -> no
    SL/TP/stop-out in that window. That is the safe direction (no action on a price that is not trusted).
  - Proxy mode never re-syncs, so the offset would stay wrong until a restart; direct mode is the
    configured mode (see `mt5-ea/deploy/feed-reset.ps1`).
- **Web finding (not changed here):** the default weekend window is fixed at 21:00 / 22:00 UTC while the
  metals daily break follows US DST; in winter the real Friday close is 22:00 UTC. Separate decision.

#### F5. SL/TP order within one pass (determinism)

- Positions are evaluated in `openedAt, id` order in both engines (matters when two closes in one pass
  interact through NBP or credit).
- **Changes:** TS `lib/risk-monitor.ts:60` `findMany` gains `orderBy: [{ openedAt: "asc" }, { id: "asc" }]`
  (**BEHAVIOR CHANGE**: only the order of closes within one pass, today unspecified). Rust
  `monitor.rs:113` iterates forward instead of `.rev()`.

#### Implementation order (one commit per divergence, TS + Rust + harness expectation together)

F4 freshness + sessions (turns FAIL 12 into MATCH) -> F2 live margin + fx -> F3 thresholds -> F1 credit
(+ consumption rule) -> F5 order. After each: `run-db.sh`, the TS money-path suites, the engine workspace.

#### Gate

12/12 MATCH (every knownDivergence tag removed) plus new scenarios, each run on both engines:
- `13-zero-used-margin`: positions but none priced -> level null -> nothing happens.
- `14-negative-equity-with-credit`: a loss bigger than balance + credit, NBP on -> the F1 consumption rows.
- `15-stale-tick-fresh-updatedAt-sl`: the SL is crossed on a price whose `tickAt` is 60 s old and
  `updatedAt` fresh -> no close.
- `16-dst-boundary-tickat`: `tickAt` exactly 3,600 s old (the autumn window), `updatedAt` fresh -> no
  usable price.
- `17-jpy-quoted-stop-out`: USDJPY on a USD account through F2's conversion.
- `18-metals-daily-break`: XAUUSD inside the NY-close hour -> no usable price.

### Stage 3: post-close side effects via an outbox — APPROVED + IMPLEMENTED 2026-09-24 (gate green, see 3.7)

The web runs these after every automatic close: `cancelPendingClose`, `mirror.onClose`,
`coverage.notifyStopOut` (stop-out only), `coverage.onClose`, `publishTradingEvent` and
`emitPositionClosedActivity`. They are TypeScript on Prisma, all `.catch`-swallowed, and Vercel cannot
subscribe to NATS. Negative-balance protection, credit consumption and TRADE_PNL are **not** on this list.
They already run inside the close transaction on both sides (`closePositionInTx` and
`book::close_position_in_tx`), so they stay there.

#### 3.1 Scope of each side effect (from the code, 2026-09-24)

| # | Effect | What it writes | Replay today | Needs |
|---|---|---|---|---|
| E1 | `cancelPendingClose(pos)` | Order→CANCELLED (guarded `status IN (PENDING,REQUOTED)`), clears `closePendingOrderId`, `DEALING_CLOSE_SUPERSEDED` audit, `OrderCancelled` event | **Safe.** On a second run `closePendingOrderId` is already null, so it returns early and writes nothing. A crash between the cancel and the audit loses that audit, which is acceptable. The dealer's accept on an already-closed position already returns 409 and cancels (dealing-queue route :252), so the window before the dispatcher runs is safe too. | nothing |
| E2 | `mirror.onClose` | target close via `closePositionInTx`, then target `cancelPendingClose`, `MIRROR_CLOSED` audit, publish, activity; `recordMirrorFailure` on error | **Full close: safe.** The target is no longer OPEN, so the call is a no-op. **Partial close: NOT safe.** The retry re-reads the target's (smaller) volume and closes the same proportion again. A crash after the target close skips the audit, publish and activity on retry. | step marker in the SAME tx as the target close |
| E3 | `coverage.notifyStopOut` | 1 `Notification` (STOP_OUT / COVERAGE_STOP_OUT) | **Not safe.** A plain `notification.create`, so every retry adds a duplicate alert. | dedupe |
| E4a | `coverage.onClose`, a coverage LEG closed | releases the client (guarded `updateMany`), `POSITION_COVERAGE_RELEASED` audit, `COVERAGE_RELEASED` / `COVERAGE_STOP_OUT` notification | **Release: safe.** Once the client is released `coveredClientPos` is empty, so a retry is a no-op. The flip side: a crash after the release but before the notification loses the notification for good. | release + audit + notification in ONE tx with the step marker |
| E4b | `coverage.onClose`, a CLIENT closed, auto-hedged leg | leg close via `closePositionInTx`, `POSITION_COVERAGE_AUTO_CLOSED` audit, publish, activity | Same shape as E2: a full close is safe and a partial close closes the leg twice. | step marker in the SAME tx as the leg close |
| E4c | `coverage.onClose`, a CLIENT closed, dealer-booked leg | `AWAITING_DEALER` audit + notification | **Not safe:** every retry writes both again. | dedupe |
| E4d | `coverage.onClose`, a CLIENT closed, no live price | `COVERAGE_CLOSE_FAILED` notification | **Not safe:** a duplicate on every retry. A retry after the price returns WOULD close the leg, which is the correct outcome, but the stale "NOT closed" alert is left behind. | dedupe, and retry this sub-case (see 3.4) |
| E5 | `publishTradingEvent("PositionClosed")` | NATS via the gateway relay, no DB write | At-least-once, harmless: clients refetch on this event. | nothing (last step) |
| E6 | `emitPositionClosedActivity` | `DealerActivity` event only. `POSITION_CLOSED` is not in `NOTIFY_ACTIONS`, so there is no DB row. | At-least-once, harmless (a feed line can repeat on a crash-retry). | nothing (last step) |
| E7 | margin call, pass 3 | `Account.marginCallNotifiedAt` edge + 2 `createNotification` (trader + staff) | Rust only publishes `MarginCall` today: **no edge column, no notification.** | same outbox, kind `MARGIN_CALL`, edge set in the Rust tx |

**Two findings from reading the code:**
- **(a) Partial-close double-close.** A partial source close retried inside E2 or E4b closes the target again. The Rust monitor only does full closes, so this can't hit Stage 3's own traffic. The fix is still in scope: the same route would be unsafe the day a partial close goes through it.
- **(b) The Rust margin call is a new gap, not only a missing side effect.** Without the `marginCallNotifiedAt` edge, the engine has nothing to edge-trigger from.

#### 3.2 Idempotency model: step markers, committed with the write

Dedupe columns on `Notification`/`AuditLog` would each fix only one table. Instead, the outbox row carries
`doneSteps text[]`. **Every step that writes to the DB commits its writes AND
`array_append(doneSteps, '<step>')` in one transaction**, and the step first checks that its name is not
already in `doneSteps`. Each DB write therefore happens exactly once, whatever happens to the process.
Only E5/E6 (external events) are at-least-once, and they run last.

How each step gets its marker:
- **E2 and E4b** need a small refactor (no behaviour change). `mirror.onClose` and `coverage.onClose`
  take an optional `markStep(tx)` callback, and the target/leg `closePositionInTx` plus its audit
  run inside it in ONE `$transaction`. This also fixes finding (a): once the close commits, the marker
  commits with it, so the retry skips it.
  - **BEHAVIOR CHANGE (small, TS paths too):** the `MIRROR_CLOSED` and `POSITION_COVERAGE_AUTO_CLOSED`
    audits move inside the close transaction. Today they sit after it and are lost on a crash.
- **E3, E4a, E4c, E4d:** notification + audit + marker in one tx.
- **E1:** already idempotent, so it only needs a marker for bookkeeping.

#### 3.3 Schema (one migration, `migrate deploy` only, scratch first)

```prisma
model PostCloseEffect {
  id            String    @id @default(cuid())
  kind          String    // "POSITION_CLOSED" | "MARGIN_CALL"
  dedupeKey     String    @unique  // "close:<positionId>:<closeTxnId>" | "mc:<accountId>:<edgeAt ms>"
  brokerId      String
  accountId     String
  positionId    String?
  reason        String?   // "sl" | "tp" | "stop_out"
  payload       Json      // closedLots, sourceVolumeBeforeClose, closePrice, realizedPnl, marginLevel, stopOutLevel (Decimal as string)
  status        String    @default("PENDING")   // PENDING | DONE | DEAD
  doneSteps     String[]  @default([])
  attempts      Int       @default(0)
  nextAttemptAt DateTime  @default(now()) @db.Timestamptz(3)
  leaseUntil    DateTime? @db.Timestamptz(3)
  lastError     String?
  createdAt     DateTime  @default(now()) @db.Timestamptz(3)
  doneAt        DateTime? @db.Timestamptz(3)
  @@index([status, nextAttemptAt])
}
```

- **Where rows are written.** The INSERT goes inside `book::close_position_in_tx`, and only when the
  close actually happened (the `Some(CloseOutcome)` branch). The `dedupeKey` uses the TRADE_PNL
  transaction id, so one close gives exactly one row, even if two monitor passes race.
- **Payload.** It captures the values before the close (`sourceVolumeBeforeClose`, `closedLots`),
  because the route can no longer read them from the position.
- **MARGIN_CALL rows.** Rust sets `Account.marginCallNotifiedAt` in the same tx as the MARGIN_CALL row,
  using the same edge rule as TS pass 3: set on entry, cleared on recovery.
- **The TS web path is unchanged.** It keeps running the effects inline, with no outbox. Only
  engine-originated closes use the outbox.

#### 3.4 Dispatcher

- **Runs in the engine** (VPS), and is woken three ways:
  - **Fast path:** a `tokio::Notify` fires right after the monitor's tx commits, so a normal close
    reaches the route in about 100 ms.
  - **Sweep:** every 15 s. `SELECT … WHERE status='PENDING' AND nextAttemptAt<=now() ORDER BY createdAt
    LIMIT 20 FOR UPDATE SKIP LOCKED`, then set `leaseUntil=now()+60s` before the HTTP call.
  - **Neon cost.** The engine already hits Neon every second (coalesced margin pass), so a 15 s
    indexed query adds no compute hours. See the Neon compute-leak memory.
- **HTTP.** `POST https://<web>/api/internal/post-close {id}` with `Authorization: Bearer
  $VYX_POST_CLOSE_SECRET`. A new secret, not CRON_SECRET. The route compares with
  `crypto.timingSafeEqual`. The existing margin-monitor `!==` is fixed in the same commit
  (BEHAVIOR CHANGE: none).
- **Backoff.** 2 s, 10 s, 30 s, 2 m, 10 m, then every 30 m. After 24 h or 50 attempts: `DEAD`, plus an
  `OUTBOX_DEAD` staff notification. A dead row is never silent.
- **The route claims the row itself:** `UPDATE … SET leaseUntil=now()+60s, attempts=attempts+1 WHERE
  id=$1 AND status='PENDING' AND (leaseUntil IS NULL OR leaseUntil<now() OR <caller holds it>)`. Two
  dispatchers, or a dispatcher plus the backstop, can then never run the same row at once.
- **Backstop.** If the engine is down, the Vercel margin-monitor cron also drains `PENDING` rows older
  than 2 min, calling the same `runPostClose(id)` in-process. The Vercel cron stays on until Stage 6
  anyway.
- **No-price sub-case (E4d).** The step does NOT mark done and does not send a notification on the first
  failure. It reschedules instead, and only after 3 tries (about 1 min) does it write
  `COVERAGE_CLOSE_FAILED` and mark done. This is a small improvement over today, which alerts
  instantly and never retries.

#### 3.5 Order inside the route (the same order as `lib/risk-monitor.ts` today)

`POSITION_CLOSED`, in this order:
1. E1 cancelPendingClose
2. E2 mirror.onClose
3. E3 notifyStopOut (stop_out only)
4. E4 coverage.onClose (reason `sl_tp` / `stop_out`, marginLevel)
5. E5 publish PositionClosed
6. E6 activity (`origin:"risk_monitor_engine"`, closeReason SL/TP/STOP_OUT)

`MARGIN_CALL`: 2 notifications, 1 step.

- **Failure handling.** A step that throws stops the run (later steps don't run), and the row goes back
  to PENDING with backoff. Earlier done steps are skipped next time.
  - **BEHAVIOR CHANGE vs the inline web path:** today a failing mirror is swallowed and coverage still
    runs. Here coverage waits for the mirror retry.
  - **Exception:** a mirror failure that `recordMirrorFailure` already recorded (rule disabled, no
    price) counts as done. It is a business outcome, not an error.
- **Rust events.** Rust keeps publishing `StopLossHit` / `TakeProfitHit` / `StopOut` immediately. E5
  adds the web-shaped `PositionClosed` that clients key on.

#### 3.6 Gate (scratch only, `vyx_rust_harness`)

1. **The core scenario.** A stop-out on an account whose position has a mirror target, an auto-hedged
   coverage leg and a queued close, with the Rust monitor closing it. It must end with the mirror
   target CLOSED, the leg CLOSED, the queue order CANCELLED, and exactly ONE of each notification and
   audit. That holds in each of these runs:
   - (i) clean;
   - (ii) the route returns 500 once at each step boundary (fault-injection env on scratch);
   - (iii) the process is killed between E2's tx and E3;
   - (iv) two dispatchers run concurrently.
2. **Partial-close replay.** A 0.5-of-1.0 source close, replayed 3 times, closes the target exactly once.
3. **Margin call.** Entry fires 2 notifications once, and the edge column is set. Recovery clears it.
   Re-entry fires again.
4. **Dead row.** The route returns 500 permanently: the row goes DEAD and exactly 1 `OUTBOX_DEAD` is sent.
5. **No regression.** Full TS suite + engine suite + parity 20/20 unchanged. The TS inline path uses the
   refactored `mirror`/`coverage` (markStep undefined) and gets identical results.

**Prod rollout:** the migration goes to ep-flat-boat and the route is deployed, both inert, because
ENGINE_ORDER_MANAGEMENT stays OFF, so no engine writes rows. It first carries traffic in Stage 5 shadow.

#### 3.7 Implementation (2026-09-24, all four behaviour changes approved)

| Piece | Where |
|---|---|
| Table + migration | `prisma/schema.prisma` PostCloseEffect, `prisma/migrations/20260924120000_post_close_outbox` (additive, empty) |
| Row written in the close tx | `book::enqueue_post_close` (called by `monitor.rs` SL/TP + stop-out inside the close's own tx), `book::apply_margin_call_edge` (MARGIN_CALL kind + the `marginCallNotifiedAt` edge = TS pass 3) |
| Dispatcher | `engine/order-management/src/outbox.rs`: `wake()` fast path + 15 s sweep, backoff 2/10/30/120/600 s then 30 min, DEAD at 50 attempts or 24 h with one OUTBOX_DEAD; spawned in `engine/server` only under ENGINE_ORDER_MANAGEMENT and only with `VYX_POST_CLOSE_URL` + `VYX_POST_CLOSE_SECRET` |
| Runner | `lib/post-close.ts` runPostClose (lease 60 s, steps `cancel_pending_close → mirror → notify_stop_out → coverage → activity`, then publish `pendingEvents`), recordPostCloseFailure (same backoff/DEAD rule as outbox.rs), drainPostCloseBackstop |
| Route | `app/api/internal/post-close` (bearer `POST_CLOSE_SECRET`, `lib/internal-auth.ts` constant-time); 200 done/gone/busy, 503 retry, 500 error |
| Backstop | `app/api/internal/margin-monitor` drains rows older than 2 min (one indexed query when empty); its CRON_SECRET check is now constant-time too |
| Event buffer | `lib/nats.ts` withTradingEventBuffer / deferTradingEvents: a step's events are stored with its writes and published after commit |

BEHAVIOR CHANGES shipped (approved): (1) MIRROR_CLOSED (+ the target's queued-close cancel) and
POSITION_COVERAGE_AUTO_CLOSED commit in the close's own transaction, on every path; (2) outbox only: mirror
`rethrow` makes an unexpected mirror error retry the step and the coverage step waits; (3) outbox only: no live
price for an auto-hedged leg retries 3 runs (~1 min) before COVERAGE_CLOSE_FAILED; (4) outbox only: step markers
make a partial replay close the target once. The web's own inline paths (lib/risk-monitor.ts etc.) are otherwise
unchanged.

**Found by the gate, fixed:** rust_decimal `format!("{:.2}")` TRUNCATES (90.909 → "90.90") where the web's
`toFixed(2)` rounds ("90.91"). It was also in the Stage 2 stop-out note ("margin level X%"), the credit / NBP notes
and their audit JSON: all now go through `book::fixed2` (half away from zero = decimal.js ROUND_HALF_UP). Parity
never compared note text, so it had not shown.

**Gate results (scratch only):**
- `lib/post-close.test.ts` on `vyx_rust_harness` with `POST_CLOSE_GATE=1`: **26/26**. The real engine monitor
  (`parity --evaluate-accounts`) stops out a client with a mirror target, an auto-hedged leg and a queued close,
  then: (i) clean; (ii) a 500 at each of the 11 step boundaries, then a retry; (iii) a crash after the mirror step
  (lease holds → busy → lapses → done); (iv) 2 dispatchers (one done, one turned away), plus 3 runners with the
  lease bypassed. Every write happened **exactly once**. Also covered:
  - partial 0.5/1.0 replayed through a crash, a 500 and 3 more runs: target at 0.5, one MIRROR_CLOSED;
  - margin call set / stay / clear / fire again: 2 rows, 4 notifications;
  - DEAD at attempt 50 and at 24 h, each with exactly one OUTBOX_DEAD;
  - the backoff table;
  - the no-price path (retry ×3, then one COVERAGE_CLOSE_FAILED; or the leg closes once the price is back);
  - the cron backstop;
  - the route (401/400/200 done/200 gone/503).
- Engine: `cargo test --workspace` **240 pass**, including:
  - `book_db` (+2: close and its outbox row commit or roll back together; margin-call edge once per episode);
  - `outbox_db` (a mock route: 200 settles; a 500 backs off and is not re-sent early; no answer is a failure;
    backoff table; DEAD once; `wake()` delivers within 3 s with the sweep an hour away);
  - `fixed2`.
- Parity `run-db.sh`: **20/20 MATCH**. `marginCallNotified` is now read from the engine's `marginCallNotifiedAt`
  edge itself, so pass 3 is under parity too.
- TS suite on `vyx_test`: 963 pass / 13 fail. The 13 are pre-existing and fail identically at HEAD with these
  changes stashed:
  - `lib/market-simulator.test.ts` (11);
  - `portal/me PATCH`, which has no handler: the `tsc` error of the same name;
  - the maker-checker pentest.

**Deploy (inert until Stage 5):**
1. Apply the migration to ep-flat-boat with `migrate deploy`.
2. Push the web. The route and backstop do nothing while the table is empty.
3. Set `POST_CLOSE_SECRET` on Vercel only when the engine side is switched on.
4. On the VPS engine: `VYX_POST_CLOSE_URL=https://<web>/api/internal/post-close` + `VYX_POST_CLOSE_SECRET`
   (same value). Only takes effect with ENGINE_ORDER_MANAGEMENT=1 (still OFF).

### Stage 4: synthetic load, scratch only — DONE 2026-09-24 (see 4.9 RED, 4.10 GREEN)

**Goal.** At 100 / 500 / 1000 accounts, one price shock through stop-out. We need proof of three things:
1. The engine (monitor + outbox + lib/post-close.ts) leaves EXACTLY the web's final state.
2. It does so under concurrency and injected faults, with zero double closes or duplicate follow-ups.
3. Its latency and DB transaction count, measured.

Production is never touched. Everything runs on `127.0.0.1:5499`, in two NEW throwaway databases (`vyx_load_web`,
`vyx_load_engine`). The orchestrator refuses any other host or database name.

#### 4.1 The synthetic book (deterministic: one integer seed → byte-identical seed in both databases)

`scripts/load/generate.ts --seed S --accounts N` writes one JSON world. Every id and ticket is derived from the
seed, so the two databases can be compared id by id.

| Dimension | Mix (of N accounts) |
|---|---|
| Groups | 4 groups: stop-out/margin-call 50/100, 30/80, 20/50, and one with no group (defaults) |
| Account currency | 85 % USD, 10 % EUR, 5 % JPY-quoted exposure (USDJPY, conversion via fx.ts both sides) |
| Credit | 20 % carry credit (Model A: in equity, consumed before NBP) |
| Brokers | 2 brokers, NBP on / off |
| Positions | 1 to 6 per account on XAUUSD / EURUSD / USDJPY / GBPUSD (+ a cross for EUR accounts), deliberate ties in floating P&L (tests the "worst first" tie-break), some SL/TP |
| Outcome after the shock | ~35 % stop-out (some multi-close, some down to zero with NBP), ~15 % margin call only, ~15 % SL/TP hits, ~5 % priced on a session-CLOSED symbol, ~5 % on a stale (no tick) symbol, rest untouched |
| Mirror | ~10 % of clients' positions mirrored to 2 master accounts (SOURCE_PRICE and MARKET) |
| Coverage | ~20 % of positions hedged on each broker's coverage account (auto-hedged and dealer-booked mix); the coverage account itself is sized to be stopped out in one variant |
| Queued closes | ~5 % of positions carry a pending queued close |

- **Sessions.** Seeded explicitly: 24/7 except one symbol hard-closed. The result never depends on the weekday
  or the hour the run happens (the weekend flakiness in memory).
- **Freshness clock.** The shock writes every LivePrice with `tickAt = now()`. A small re-stamper keeps the SAME
  prices fresh (every 2 s) in both databases for the whole run: a 1000-account pass can outlast the 15 s
  freshness window, and the stale symbol stays stale on purpose.

#### 4.2 The two runs

- **Web (reference).** `vyx_load_web` is seeded, shocked, then `evaluateAccountRisk` runs for every account once,
  sequentially. This is today's production path, with the side effects inline.
- **Engine.** `vyx_load_engine`, same seed, same shock. A new mode `parity --load` runs
  `monitor::evaluate_account` with **K concurrent evaluators over an overlapping account list** (every account is
  hit by at least 2 workers at once: the tick path + the timer in production). Meanwhile **M concurrent outbox
  runners** (lib/post-close.ts, in-process) drain the rows. Injected faults:
  - 5 % of step boundaries throw a 500;
  - 2 % of runs "crash" (the lease is held, then left to lapse).
- **Settle.** Both sides get repeated passes until one changes nothing (cap 3), plus a full drain. The number of
  passes needed is recorded.
- **Replay.** Then one extra engine pass + drain over the settled state. It must write NOTHING new.

#### 4.3 What is compared (the canonical snapshot, both databases)

- Per position: status, close price, realizedPnl, close reason (from the TRADE_PNL note, as in parity).
- Per account: balance, credit, marginCallNotified, and the TRADE_PNL / CREDIT / NBP rows (type + amount, in
  close order).
- Side effects, as counts per (type or action, entityId):
  - Notification: STOP_OUT, COVERAGE_STOP_OUT, COVERAGE_RELEASED, MARGIN_CALL, COVERAGE_CLOSE_FAILED,
    AWAITING_DEALER.
  - AuditLog: MIRROR_CLOSED, POSITION_COVERAGE_*, DEALING_CLOSE_SUPERSEDED, CREDIT_CONSUMED_BY_LOSS,
    NEGATIVE_BALANCE_PROTECTION_APPLIED.
  - The state of every mirror target, coverage leg and queued order.

Not compared, by design:
- event publishes (at-least-once);
- activity `origin` (`risk_monitor` vs `risk_monitor_engine`);
- timestamps / createdAt.

#### 4.4 Gate

1. **Identical snapshots** at N = 100, 500 and 1000, each for 3 seeds. Any difference is a FAIL, reported as
   scenario + account + field, and nothing is waved through without a written, approved classification.
2. **Exactly-once under load** (engine database):
   - at most one TRADE_PNL per closed position and no position closed twice;
   - every PostCloseEffect row DONE (none DEAD), each step listed once in its `doneSteps`;
   - notification / audit counts equal to the web's, whatever the faults.
3. **Replay writes nothing:** row counts of every table unchanged by the extra pass + drain.
4. **Latency and cost, recorded (not gated):**
   - evaluate_account p50/p95/p99;
   - full-pass wall time;
   - close-commit → row DONE p50/p95;
   - Postgres transactions per pass (`pg_stat_database.xact_commit` delta), the number that drives Neon compute
     (the compute-leak memory).
5. **No regression:** parity 20/20 + the Stage 3 gate still green.

#### 4.5 Risks this is designed to expose (not assumed away)

- **Ordering** (mirror / coverage follow-ups vs a later account's own evaluation): RESOLVED in Stage 4.5 below. The
  generator still seeds both orders (client first, master / coverage account first) at scale, and the snapshots
  must MATCH.
- **Concurrent stale state.** A worker whose account state predates another worker's close sees a rosier equity:
  it should UNDER-close, and the next pass completes the job. The load test measures whether that holds, and
  whether it ever over-closes (credit / NBP interplay).
- **Tie-break.** "Worst position first" on equal P&L: both sides must pick the first in (openedAt, id) order.
- **Freshness drift** on long passes: handled by the re-stamper, and asserted (no account unpriced by accident).

#### 4.6 Deliverables and effort (~2-3 days)

- `scripts/load/{generate.ts, seed.ts, shock.ts, run-web.ts, drain.ts, snapshot.ts, diff.mjs, run.sh}`, with a
  scratch guard in run.sh AND in every script.
- `parity --load` (engine concurrent evaluator + latency JSON).
- A results table in this doc per N / seed.
- **Optional HTTP smoke:** `next start` pointed at `vyx_load_engine` + the real engine dispatcher against it, for a
  few hundred rows. It runs the true route + bearer + backoff over HTTP.
  - The .env points at PROD. The run passes DATABASE_URL / DIRECT_URL explicitly and first proves via a probe row
    that it writes to scratch.
  - Recommended but separable.

#### 4.7 Addition (user, 2026-09-24): chained follow-ups / cascades and deferral starvation

**What is seeded.** In the generator, besides the 4.1 mix, per seed:

| Topology | Chain | Web (one pass, account order) |
|---|---|---|
| Mirror cascade (depth 2 and 3) | client stop-out → mirror closes t1 on master A → A's realized loss puts A in stop-out → A's own position a1 (mirrored by a second rule onto master B) closes → mirror closes b1 on B | order client, A, B: every close lands before the next account is evaluated |
| Coverage cascade | client X's close → its auto-hedged leg closes on the coverage account C → C's realized loss stops C out → C's other leg (hedging client Y) closes → Y is released | order X, C, Y |
| Fan-in | 50-200 clients mirrored onto ONE master / hedged on ONE coverage account, all stopped out by the same shock | master / C evaluated once, after all of them |
| Reverse orders | each of the above with the downstream account FIRST | the downstream account acts on its own first |

"Coverage-of-coverage" (a coverage leg hedged by another leg) cannot arise from the product (lib/coverage.ts never
auto-hedges a coverage leg; covered by lib/coverage.test.ts). It is seeded directly as a data-only case to prove
nothing loops. A mirror target is not re-mirrored either (onFill only runs for real fills), so mirror chains run
through the master's OWN positions, as seeded above.

**The prediction (to be proven by the harness, not assumed).** With the 4.5 rule, deferral looks only at rows that
ALREADY exist. In the depth-2 chain with order client, A, B:
1. The client closes in cycle 1; A is deferred.
2. B is evaluated in the same cycle, because nothing pending touches B yet (A's close has not happened).
3. B may then stop out b1 itself, where the web had it closed by the mirror, at another price.

The same shape applies to X / C / Y. **Expected result: FAIL on depth ≥ 2.**

**Fix options (for approval once the harness shows it; engine-only, BEHAVIOR CHANGE):**
- **(R) Resume point.** When an account is deferred, the pass stops there and resumes from that account once its
  follow-ups ran. This is exactly the web's sequential semantics. Accounts after it wait about one outbox round
  (~100 ms at the dispatcher's fast path); unrelated brokers are not held.
- **(T) Transitive deferral.** Defer every account reachable from a deferred one through mirror rules / coverage
  links. Less waiting, but it needs a graph walk each pass and is easier to get subtly wrong.
- My recommendation is **R**, simpler and exact.

**Starvation.** Today the 30 s safety release is per ROW: a steady stream of fresh rows touching the same master
(fan-in) could keep it deferred for longer than any single row's window. Proposed alongside R:
- an ACCOUNT-level cap, measured from the account's first continuous deferral (kept in the monitor's memory);
- the 30 s window stays only as the stuck-outbox safety net.

**Gate additions.**
- (a) Every cascade and fan-in topology gives an identical snapshot, in both orders, with K ≥ 2 concurrent evaluators
  and the dispatcher running CONCURRENTLY (production shape), not only drained between cycles.
- (b) **Zero safety releases.** The harness counts every evaluation of an account while a pending row older than the
  window still touches it (a harness-side query, no engine change). It must be 0 in every topology the web resolves in
  one pass.
- (c) Per account, recorded: number of passes deferred, and the time from first deferral to evaluation (max / p95).
  Bound: ≤ chain depth passes, and ≤ 2 s in the harness.

#### 4.8 Addition (user, 2026-09-24): cost of the deferral query

`book::pending_follow_up_owns` is 3 EXISTS subqueries on every evaluated account. They use existing indexes:
- PostCloseEffect `(status, nextAttemptAt)`;
- MirrorLink `sourcePositionId` @unique;
- Position `coveragePositionId` @unique, plus its pkey.

Measured on scratch:
1. `EXPLAIN (ANALYZE, BUFFERS)` of the query with PostCloseEffect at 0 / 1k / 100k DONE rows plus a few PENDING ones:
   plan, index use, shared-buffer hits, exec time.
2. At N = 100 / 500 / 1000 open accounts, one steady-state pass with no pending rows (the normal case) and one
   stop-out pass. Recorded:
   - extra queries per pass, and the added pass wall time;
   - `pg_stat_database.xact_commit` / `tup_fetched` deltas;
   - `pg_stat_statements` mean time, if the extension can be enabled on scratch (otherwise client-side timing).
3. Projection to Neon: today's coalesced cadence (1 pass/s, see the compute-leak memory) × accounts with open positions
   = extra queries per hour. Also, whether it keeps compute from auto-suspending (it does not add wake-ups: it rides
   the pass that already runs).

**Likely optimisation, measured in the same run.** One cheap query per PASS ("any PENDING POSITION_CLOSED row younger
than the window?", served by the status index). The per-account EXISTS runs only when that returns true: in steady
state that is 1 query per pass instead of N. It is engine-only, and results are unchanged by construction; the gate
re-runs to prove it.

**Deliverables added to 4.6.**
- A `topology` section in the generator.
- Starvation / safety-release counters in the engine run's report.
- `scripts/load/explain-deferral.ts`.
- A cost table in this doc.
- Estimated **+1-1.5 days** on top of 4.6. If R is approved after the harness shows the divergence, **+1 day** for
  it and a re-run.

#### 4.9 Harness built; RED before the fix (2026-09-24)

**What is built.**
- `scripts/load/{generate,seed,run-web,snapshot,env}.ts`, `diff.mjs` and `run.sh`.
- `parity --load-run <walkers>` (engine/parity/src/load_mode.rs).
- `monitor::run_pass`, which run_once now calls.
- Deterministic pass order: `accountId COLLATE "C"`.
- `book::pending_follow_up_state`, with DEFER_QUERIES / SAFETY_RELEASES counters.

The load databases are cloned from `vyx_rust_harness`. **A FRESH database cannot take `migrate deploy`:**
`20260921160000_stage3a_group_the_ungrouped` is a production data migration that aborts when its listed accounts are
missing. A self-hosted installer needs a baseline or a skip for it.

**RED, seed 1, 100 clients** (152 accounts, 549 positions, 46 mirror links, 9 topologies), engine = Stage 4.5 rule:

| Topology | K=1 | K=2 | What differs |
|---|---|---|---|
| bulk | MATCH | **FAIL (9)** | concurrency, not ordering: e.g. b-bulk-raw-a00066, the engine also stopped out p000290 (+819.28) that the web left open; balance web -671.71 / engine 147.57. A walker's in-memory state went stale when the other walker closed a PROFITABLE position of the same account; the web re-reads account + positions every stop-out iteration. Also 2 extra MARGIN_CALL notices on a00092 |
| mirror-d2 | **FAIL** | **FAIL** | B: web 0 / engine 2000 (web: b1 mirror-closed +2000 BEFORE B's stop-out of b2, NBP 900; engine: b2 first) |
| mirror-d3 | **FAIL** | **FAIL** | same on B |
| coverage-chain | **FAIL** | **FAIL** | ly: web closed by CV's stop-out, engine by coverage auto-close; POSITION_COVERAGE_RELEASED + COVERAGE_STOP_OUT on Y missing |
| coverage-chain-rev | **FAIL** | **FAIL** | the same shape on lx / X |
| mirror-d2-rev, mirror-d3-rev, fan-in, circular, coverage-of-coverage | MATCH | MATCH | depth 1 and reverse orders are already right |

Engine run K=2: 27 rounds, 146 closes, 5628 deferral queries, 0 safety releases. The worst account was deferred 50
passes / 7.2 s, because the dispatcher drains ~146 follow-ups one HTTP call at a time.

**Two engine fixes follow, in separate commits:** (1) re-read the account after every close (the web's semantics);
(2) the resume point (R) with its loop guard.

#### 4.10 After the fixes: GREEN (2026-09-24)

**Engine commits.**
1. `6962567`: re-read the account after every close; margin-call edge transitions decided on a fresh read.
2. `2d269ce`: resume point (R) + loop guard (`tests/pass_db.rs`).
3. The per-pass deferral precheck (this commit).

**Gate matrix**, with the precheck on (the default):

| Run | Engine wall | Closes (= web) | Deferral queries | Prechecks | Safety releases | Max passes deferred | Max wait | Diff |
|---|---|---|---|---|---|---|---|---|
| s1/s2/s3 × 100, K=2 | 4.8–6.6 s | 147 / 128 / 123 | ~285 | 32 | 0 | 1 | ≤1.6 s | 0 |
| s1/s2/s3 × 500, K=2 | 21–25 s | 739 / 767 / 715 | ~1240 | 32–34 | 0 | 1 | ≤6.9 s | 0 |
| s1/s2/s3 × 1000, K=2 | ~49 s | 1292 / 1307 / 1241 | ~2450 | 34 | 0 | 1 | ≤15.8 s | 0 |
| s4 × 500, K=4 | 27.8 s | 739 | 2497 | 68 | 0 | 1 | 8.2 s | 0 |

What the matrix covers:
- Every topology in every run: bulk, mirror-d2/d3 both orders, coverage-chain both orders, fan-in, circular,
  coverage-of-coverage.
- 2 or 4 concurrent walkers, with the dispatcher running.
- Every account deferred at most 1 pass, which is ≤ chain depth.
- 0 safety releases.

**Timing caveat.** The machine slowed between runs: the web's first pass at 1000 clients took 40 s in the earlier
matrix and 72 s later. An A/B on that same slow machine (s1 × 1000) gives:

| Precheck | Engine wall | Max wait |
|---|---|---|
| off | 49.2 s | 14.7 s |
| on | 50.5 s | 14.8 s |

So the slowdown is the machine, not the change. The max wait is the fan-in master (200 follow-ups ahead of it,
delivered one HTTP call at a time by the dispatcher). The same volume on the web runs inline inside a 40-72 s pass.

**Deferral query cost (§4.8, `scripts/load/explain-deferral.sh`, 632 accounts).**
- **Plan:** every PostCloseEffect access goes through the `status` index, unchanged from 893 to 101,893 DONE rows.
- **Per-account query:** ~1.0-1.15 ms including planning (plpgsql EXECUTE; the engine's prepared statements skip the
  planning).
- **Precheck:** ~0.044 ms.

**Precheck (engine, results-identical).** One `EXISTS` on PENDING POSITION_CLOSED rows per pass. The per-account
query only runs once one is pending, or once this process queued one during the pass (FOLLOW_UPS_QUEUED; only the
engine queues these rows, so concurrent walkers are covered).

| Situation | Deferral queries | Pass time | Results |
|---|---|---|---|
| Steady state, 433 open accounts, nothing pending | 433 → 0 (+1 precheck) | ~1.2 s → ~0.94 s | identical |
| Stop-out storm, s1 × 500 | 2160 → 1246 | similar | engine snapshot precheck on vs off: 0 differences; both 0 vs the web |
| Stop-out storm, s1 × 1000 | 4206 → 2450 | similar | identical |

Neon projection: at the coalesced 1 pass/s this saves one query per open account per second, i.e. ~433 queries/s at
this book size, whenever nothing is pending. `pg_stat_database` xact deltas proved too noisy (stats flush
asynchronously) to use as evidence.

**Regression:** parity 22/22, engine 242, Stage 3 gate 26/26.

### Stage 4.6: fan-in dispatcher latency — BUILT 2026-09-24 (results in 4.11.4; web part awaiting deploy approval)

**Problem.** In fan-in, 200 follow-ups are delivered one HTTP call at a time: ~75 ms per row on this machine, so the
master waits ~15 s.

**Constraint (from the code, not assumed).** All 200 fan-in rows touch the SAME master (M) and coverage account (CV).
The order in which M's targets close decides which position carries how much negative-balance write-off (NBP
attribution per Transaction row). For example, with balance 100: -500 then +300 ends at 300, while +300 then -500
ends at 0. The web closes them in client order. So rows touching a shared account must stay SERIAL, in source-close
order, or the result stops being web-identical. Exactly-once alone would survive parallelism, but the gate would not.

**Existing hole, fixed as part of this.** Today `drain_once` carries on after a failed row, so a LATER row touching
the same account can run before it. That is an ordering violation on failure.

#### 4.11.1 Design

1. **Conflict groups (engine dispatcher).**
   - One query fetches the due rows (up to 200) together with every account each row will touch: the source account,
     mirror target accounts, the coverage leg's account, and clients a closed leg releases.
   - Union-find turns shared accounts into groups. Within a group, order is (createdAt, id) = source-close order.
   - Up to P groups are in flight at once (`VYX_POST_CLOSE_PARALLEL`, default 8; 1 = today's serial behaviour).
   - Disjoint groups touch disjoint accounts, so running them in parallel cannot change any result.
2. **Stop at the first failure within a group.** A row that answers retry, error or busy stops its group. Rows after
   it are not attempted (no attempt counted, they stay due), and the group continues from that row once it is due
   again. This closes the hole above.
3. **Batch per group (web side: the OUTBOX RUNNER ONLY, not the inline web money path).**
   - `POST /api/internal/post-close` also accepts `{ids: [...]}` (max 50, in order), and `runPostCloseBatch` runs
     them in that order.
   - It stops at the first row that is not done and answers per id: `done`/`gone` (settled), `retry`/`error` (the row
     that stopped it), `not_attempted` (the rest).
   - The single-id form stays unchanged.
   - This saves one HTTP round trip per row. In production that is VPS → Vercel, plus the function's per-invocation
     overhead.
4. **Partial-batch safety.**
   - The per-row lease and `doneSteps` markers are unchanged: every row still claims its own 60 s lease inside
     runPostClose, and a second dispatcher or the web backstop just gets `busy`.
   - The dispatcher records a failure only for the row that stopped the group. Settled rows are finished;
     not_attempted rows are simply re-sent.
   - If the whole request gets no answer, the dispatcher re-reads the rows' status: DONE ones are skipped, the first
     still-PENDING one gets the attempt counted, and the rest are re-sent (idempotent anyway through the markers).
   - Result: half a batch done means only the other half is sent again, and a row can never go DEAD because a
     neighbour failed.
5. **Events published in parallel (runner).** A row's pendingEvents go out concurrently (`Promise.all`) instead of
   one after another: ~5 gateway round trips become ~1 in production. Delivery is still at-least-once, and DONE is
   still marked after the publish.

**BEHAVIOR CHANGE (engine dispatch semantics):**
- groups in parallel;
- stop-at-first-failure within a group;
- batch delivery.

**Web change (outbox runner / route only):** the batch form and the parallel publish. The inline risk path
(`lib/risk-monitor.ts`, `evaluateAccountRisk`) and everything the web does on its own closes are untouched.

#### 4.11.2 Step 1: measure before optimising

The per-row cost is split into: HTTP, the lease claim, each step's transaction (mirror and coverage each run
closePositionInTx with an account row lock), the pendingEvents read, the publish, and DONE. This uses a
harness-only timing hook in `post-close-server.ts`. The split decides how far batching gets.

**Honest risk.** Fan-in is ONE group of 200 rows by nature. Parallelism cannot help it; only a lower per-row cost can.
- If the floor without HTTP is still above ~10 ms per row on this machine, whose disk slowed ~1.8x mid-session, then
  <2 s for 200 rows is not reachable while staying web-identical.
- In that case I report the measured floor and stop for a decision. The next lever would be all of a row's steps in
  ONE transaction (fewer commits, same exactly-once, coarser failure granularity), which is itself a BEHAVIOR CHANGE
  of the runner.

#### 4.11.3 Gate

1. Fan-in max wait **< 2 s** at 1000 clients, measured with the same harness. If not reachable, the measured floor
   plus the decision above.
2. The full Stage 4 matrix: seeds 1-3 × 100 / 500 / 1000 × K=2, plus K=4. **0 differences**, closes equal to the
   web, 0 safety releases, ≤ 1 pass deferred.
3. **Exactly-once checker** (new, on the engine DB after every run):
   - every PostCloseEffect row is DONE, none DEAD;
   - no step twice in `doneSteps`;
   - at most one TRADE_PNL per position;
   - every Notification / AuditLog count equals the web's (already in the diff).
4. **Faults:**
   - The harness server fails the k-th row of a batch once (500), and drops one whole batch response.
   - Settled rows are not redone, the remainder is delivered once, nothing goes DEAD, and the result still MATCHes.
5. **Two dispatchers at once** on the same outbox: no double delivery (route `busy`), MATCH.
6. **Regression:** parity 22/22, Stage 3 gate 26/26, engine tests, plus new unit tests for grouping (union-find) and
   batch accounting against a mock route.

**Effort:** ~1.5-2 days. Add ~0.5 day if the single-transaction lever is needed and approved.

#### 4.11.4 Results (2026-09-24; approved clamps: additive route, measurement first, no single-transaction lever)

**Built.**
- Engine `outbox.rs`: `queued_rows` (every PENDING row with the accounts it touches), `conflict_groups` (union-find),
  `drain_once` (groups in parallel, `VYX_POST_CLOSE_PARALLEL`=8; strictly in order within a group; a group whose head
  is not due waits whole), `deliver_group` (stops at the first unfinished row; batch `{ids}`, `VYX_POST_CLOSE_BATCH`=50,
  0 = the old single form), and DELIVERIES / DELIVERY_MICROS metrics.
- Web runner (`lib/post-close.ts`): `runPostCloseBatch`, the parallel publish, and two harness-only hooks (timing,
  fault injection).
- Route: the additive `{ids}` form; `{id}` unchanged.

**Gate (all green).**
- **Matrix:** seeds 1-3 × 100 / 500 / 1000 × K=2, plus s4 × 500 × K=4. 0 differences, closes = the web, 0 safety
  releases, ≤ 1 pass deferred.
- **Exactly-once checker** (`scripts/load/exactly-once.ts`) OK in every run: all rows DONE, no step twice, one row per
  close, no double close, no duplicate follow-up notice / audit.
- **Faults** (every 7th row fails once, every 5th answer dropped after the work, 2 dispatchers at once): 118 rows retried,
  still 0 differences, exactly-once OK, nothing DEAD. Worst wait 27.5 s: the backoff (2 s, then 10 s) holding a group's
  head; still under the 30 s window, 0 safety releases.
- **Unit / DB tests:** grouping; batch done → error → not_attempted (only the failed row counts an attempt, the next is
  untouched); a group waits while its head backs off; an unanswered batch counts one attempt on the first still-PENDING
  row.
- **Route:** `{id}` single form unchanged (401 / 400 / primitive body 400 / 200 done / 200 gone); `{ids}` order, stop,
  not_attempted, 400s.
- **Suites:** Stage 3 gate 28/28, parity 22/22, engine 243 (3 clean runs). One run showed 1 engine failure that did
  not reproduce in 3 reruns and whose name was not captured: a possible flake, watch it. TS 965 pass, 13 pre-existing.

**Measured floor** (per row, the SHAPE; seed 1, 1000 clients, K=2):

| | fan-in wait (200-row group) | per row | steps (transactions) | HTTP | lease + read + DONE |
|---|---|---|---|---|---|
| before (serial, one global queue) | 8.8 s | 16.3 ms | ~83 % | ~4 % | ~12 % |
| groups + batch, MX500 (D:) | 5.0-5.6 s | ~24 ms (DB contention across parallel groups) | ~83 % | ~2-3 % | ~12 % |
| same on the NVMe (C:, data + WAL) | 5.6 s | 23 ms | same shape | | |
| same with `synchronous_commit=off` | 4.75 s | 24 ms | same shape | | |

**The disk is NOT the bottleneck.** NVMe equals MX500, and removing the commit flush altogether gains ~15 %. The floor
is the follow-up's own query round trips (Node / Prisma interactive transactions: five step transactions per row, two
of them full closes with an account row lock). 500 clients (a 100-row group): 2.5-2.7 s. The time grows linearly with
the rows in the group, ~24-28 ms each.

**Production will be SLOWER per row, not faster.** The route runs on Vercel against Neon over the network, so every
query adds ~1-2 ms of round trip. A better VPS disk does not bring it to 2-2.5 s. The single-transaction lever (fewer
round trips) is the only real one; it is deferred (user, 2026-09-24): an optional post-cutover optimisation, not a
blocker.

#### 4.11.5 KNOWN fan-in timing ceiling (for the Stage 5 shadow reconciler)

When one account (a mirror master, a coverage account) receives follow-ups from N source closes in one pass, the
engine finishes them N rows in a row, strictly in order, after the sources close. The web does them inline in the same
order. Same values, different timing.

The shadow reconciler classifies a difference on such an account as **TIMING (known)**, not VALUE / WEB_ONLY, while it
is within:

**ceiling = max(2 s, N × 30 ms)** (N = follow-up rows in that account's conflict group for the pass)

- Measured on the harness: N = 200 → 4.75-5.6 s (≤ 6 s); N = 100 → 2.5-2.7 s (≤ 3 s).
- The 30 ms per row is ~25 % above the measured ~24 ms.
- **Recalibrate in Stage 5** against Neon: the shadow records the real per-row time, and the constant becomes the
  measured p95 per row × 1.25.
- Past the ceiling, or with a differing VALUE, it is a real finding.

### Stage 4.5: mirror / coverage ordering aligned with the web — DONE 2026-09-24

**Decision (user, 2026-09-24).** The web is canonical and is not changed: it runs mirror / coverage right after
each close, inside its pass. The engine aligns on ORDERING, not timing: follow-ups are still enqueued in the close's
transaction and dispatched by the outbox (exactly-once), never inline or synchronous.

**Rule (engine BEHAVIOR CHANGE).** `monitor::evaluate_account` first asks `book::pending_follow_up_owns`. An account
waits for the next pass (`EvalReport.deferred`) while a PENDING POSITION_CLOSED row, queued under
FOLLOW_UP_DEFER_SECS (30 s) ago, is still going to touch one of its OPEN positions:
- close a mirror target (`mirror` step not done);
- close an auto-hedged coverage leg (`coverage` step not done; dealer-booked legs are left open on the web too);
- release a client position whose coverage leg was the one closed (`coverage` step not done).

The web did all of these before it reached that account; the engine now evaluates the account after them too.
Past 30 s the account is evaluated anyway, so a stuck outbox (dispatcher down) can never keep an account from
its own stop-out. Cost: one indexed EXISTS query per evaluated account.

**Harness.**
- `run-db.sh` now drains the engine's outbox after each cycle, through the real dispatcher (`outbox::drain_once`)
  into the real route (`scripts/parity/post-close-server.ts`, scratch DB only, stopped on exit). Every account is
  still evaluated exactly once, in scenario order, like the web's pass.
- DB-mode outputs now also carry `sideEffects` (every Notification / AuditLog count per type / action, entity and
  audience) and `positions` (every position's end state). `diff.mjs` compares both.
- New db-only scenarios:
  - `21-mirror-coverage-order-client-first`: the seeded divergence case;
  - `22-mirror-coverage-order-master-first`: the reverse order, which must not change.

**Evidence.**
- The deferral switched off for one run (not committed): 20 MATCH, 2 FAIL.
  - 21: master's t1 was stopped out at ask 1.10020 (-10020, NBP 5020) where the web mirror-closed it at the source
    price 1.1 (-10000, NBP 5000). This also left MIRROR_CLOSED / POSITION_COVERAGE_AUTO_CLOSED missing and STOP_OUT /
    COVERAGE_STOP_OUT extra.
  - 22: the release of the client position and its COVERAGE_STOP_OUT notice were missing.
- With it: **22/22 MATCH**, including the new side-effect and position comparison on all 20 earlier scenarios. Their
  STOP_OUT / MARGIN_CALL notices now come from the outbox and equal the web's inline ones.
- Engine `cargo test --workspace` **241 pass** (+1: defers only while the step is pending, never past 30 s, never
  for a dealer-booked leg).
- Stage 3 gate 26/26.
- TS 963 pass; the 13 pre-existing failures are unchanged.
- The pure-calc Stage 0 run skips the 2 db-only scenarios. Its 9 FAILs are identical at HEAD: the pure model
  predates Stage 2, and DB mode is the gate.

**Not yet built:** the Stage 4 load harness (4.1-4.6 above is still a plan awaiting approval). This ordering case
goes into its generator; at that scale it must MATCH as here.

### Stage 5: shadow (2-3 days build, 1-2 weeks soak)

The engine evaluates and decides but does not act; the web risk monitor logs its own decisions; both go
to a comparison store on the VPS Postgres (never Neon), each with the price snapshot it used. The book
is held in memory (NATS position events + a 5-10 s reconcile read) so Neon's compute does not climb back
(see the 2026-09-23 coalescing fix).
- **Gate:** every mismatch explained (timing / snapshot); an unexplained one resets the soak clock.

### Stage 6: cutover with a warm fallback (1-2 days + drill)

Per-broker `riskAuthority = WEB | SHADOW | RUST`, read by both sides so exactly one acts. Futurix demo
first; in RUST mode every web evaluator (cron, hook, backstop, price-feed) skips that broker. Drill:
flip back to WEB and watch the web take the next stop-out. The Vercel cron stays until then.

## Effort

Build ~3-4 weeks after the pre-stage, then 1-2 weeks of soak.

## Risks

- Balance model: the engine must adopt `Account.balance` + Transaction exactly; keeping
  "balance + ledger sum" while also writing the balance double-counts every close.
- Two writers on `"Position"` during and after the cutover (web manual closes, engine automatic closes):
  the status + volume guard on both sides is what keeps that safe.
- Neon compute if the engine polls the book instead of holding it in memory.
- A rate for every non-account-currency symbol must exist in LivePrice, or those positions are unpriced
  (not stopped out) and their closes are refused; the symbol setup should enforce it.
