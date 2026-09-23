# Rust cutover, Phase 3: stop-out / margin call / SL-TP moves from the web to the engine

_Written 2026-09-23. Status: pre-stage web money fixes **LIVE** (b5dc33c, 55b86da, deployed 2026-09-23) plus
the balance row lock (8b5f60b). **Stage 0 DONE** (0417ad0). **Stage 1 DONE** (book.rs, gate green: the
engine's real monitor on the real schema matches the web's balances and Transaction rows on every
scenario; the only FAIL left is Stage 2's freshness rule). Stages 2-6 not started._

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
| Credit in equity | **Web behaviour**: equity = balance + floating P&L of priced positions, credit NOT counted. Rust changes (Stage 2), the web does not. |
| Quote-currency conversion | Fix it everywhere. Web done in 55b86da (`lib/fx.ts`); Rust must use the same rule (Stage 2). |
| Admin-close double credit | Fix before the cutover. Done in b5dc33c. |
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

### Stage 2 — Canonical formulas (DRAFT 2026-09-24, awaiting approval; nothing implemented)

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

#### CONFLICTS with earlier decisions (need your call before implementing)

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

### Stage 3: post-close side effects via an outbox (3-5 days)

The web runs, after every automatic close: `cancelPendingClose`, `mirror.onClose`,
`coverage.notifyStopOut` (stop-out), `coverage.onClose`, `publishTradingEvent`,
`emitPositionClosedActivity`. They are TypeScript on Prisma and Vercel cannot subscribe to NATS.
- The engine's close writes a `PostCloseEffect` row (positionId, reason, dedupe key) in the SAME
  transaction; a dispatcher calls `POST /api/internal/post-close` (bearer secret), which runs that
  sequence and marks the row done; failures retry with backoff.
- Mirror / coverage closes are already retry-safe (guarded close); notifications and activity need the
  dedupe key.
- **Gate:** on scratch, a stop-out that has a mirror target, an auto-hedged leg and a queued close ends
  with the mirror closed, the leg closed, the queue entry cancelled and exactly one notification, also
  when the route returns 500 once.

### Stage 4: synthetic load, scratch only (2-3 days)

100 / 500 / 1000 accounts across symbols (including JPY-quoted and credit accounts), mirror rules and
hedges, one price shock through stop-out. Web and engine run the same seed separately.
- **Gate:** identical closed sets, balances, Transactions and side-effect counts; zero double closes in
  a concurrent run; latency recorded.

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
