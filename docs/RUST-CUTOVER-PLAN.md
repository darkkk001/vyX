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
