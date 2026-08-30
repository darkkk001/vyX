# VyXTrader — 12-Week Roadmap (v1, 2026-08-30)

Based on `docs/PRODUCT-INVENTORY.md` + `docs/STATE-OF-PROJECT.md` (commit `293c62d`).
Rule: one phase in flight at a time; each phase ends with a Contabo/Vercel deploy and a
written acceptance check. Claude Code briefs are cut per phase, not per feature.

## Standing decisions (locked now, stop re-deciding)

1. **Rust engine is the future execution path.** The legacy Next.js order path gets
   safety-patched (P0) and then frozen — no new features on it, ever. Cutover happens
   per-broker via the existing `Broker.executionEngine` toggle, which becomes REAL.
2. **Fill price is always server-side.** The client never supplies an executable price;
   it supplies only a max-slippage tolerance.
3. **Tauri stays. klinecharts stays. NATS stays. Decimal handling stays.** Native
   desktop is a Phase-6+ product on a frozen protocol, not now.
4. **GTM order: Futurix (own B-book brokerage) monetizes first** → PSP + email before
   LP bridge. Bridge starts the moment Futurix deposits work.

---

## Phase 0 — P0 money-risk patch (this week, 2–4 days)

Legacy path stays live during cutover, so it must stop being exploitable first.

- Server-side fill price on `app/api/trade/orders`: fill at `LivePrice` (staleness ≤ 3 s,
  else reject `MARKET_CLOSED/STALE`), client price becomes `maxSlippage` only.
- Pre-trade margin gate: compute projected margin level post-order (math exists in
  `lib/margin.ts`); reject below margin-call level. Same check on the Rust path is
  already done — assert parity in a test.
- Fix the Feed Health field-rename regression (`FeedHealthManager.tsx` + route).
- Order-ack latency instrumentation on BOTH paths (submit→response ms, p50/p95 to
  feed-stats + a new `/manage/feed-health` row). We will never again ship an order path
  we can't measure.
- Accept: exploit test (stale/better client price) rejected; margin-breach order
  rejected with reason; ack p95 visible.

## Phase 1 — Trust pack (weeks 1–2)

Everything a security-literate broker asks in the first demo.

- Admin 2FA (TOTP) for MANAGER/BROKER_ADMIN/SUPPORT — port the trader pattern.
- Admin session → Redis-backed opaque token (port `lib/account-auth.ts` pattern);
  revoke-on-disable, session list in `/manage/team`.
- Price alerts made REAL: `Alert` model (symbol, condition, price, expiry), engine
  evaluates on tick (it already sees every tick), fires NATS `alert.triggered` →
  in-app notification + (Phase 2) email. Delete the mock state.
- First TS tests (Vitest): orders route (fill price, margin gate, slippage), funds
  approval maker-checker, balance adjustment, KYC decision, position close. ~25 tests.
  CI: `cargo test` + `vitest` + `tsc` on every push.
- Quick honesty fixes: hide `executionEngine` toggle behind a "beta" label until Phase 3
  makes it real; enable or remove TopbarSearch; M15 timeframe added everywhere (it's
  a config array); multi-chart grid gets the missing W1/MN1/Y1.

## Phase 2 — Futurix goes commercial (weeks 3–5)

The platform can take real clients' money without manual ops.

- **PSP v1:** one crypto processor (USDT TRC20 — NOWPayments/CoinsPaid-class) wired to
  funds-requests: deposit auto-credit on confirmation webhook (idempotent), withdrawal
  payout initiation after maker-checker. PSP config per-broker in backoffice.
- **Email:** Resend (or SES) — transactional set: welcome, deposit confirmed,
  withdrawal states, password reset (kill the "Notification-only" forgot-password),
  margin call, alert triggered. Template table per-broker (branding).
- **KYC provider v1:** Sumsub or Veriff sandbox behind the existing manual flow —
  auto-check score lands on the KYC review page; manual approve stays the decision.
- Billing v1 (Super Admin): Stripe subscription per tenant (plan from `lib/billing.ts`),
  invoice list, past-due flag. Enough to charge broker #2; not a billing suite.
- Backoffice dashboard: add 14-day deposit/withdrawal/net + active-traders trend
  charts (data exists in `Transaction`).

## Phase 3 — Rust cutover (weeks 5–8)

- Close the gateway gaps: `/v1/positions/:id/close`, order history read path, and
  whatever `parallel-run` divergence list says (margin gate now exists on both).
- Make `Broker.executionEngine` real: `app/api/trade/orders` (+ positions modify/close)
  forwards to the gateway when RUST; legacy code path runs only when LEGACY.
- Shadow mode first: RUST for demo accounts of Futurix for 1 week (real users, fake
  money), compare fills/ledger nightly (`parallel-run` repurposed as reconciler).
- Then Futurix LIVE cutover with a written rollback (toggle back + reconcile script).
- Engine hardening that cutover forces: startup state recovery test (kill -9 mid-flow),
  ledger crate tests, swap rollover on the Rust path verified over a weekend.
- Retire: delete legacy order/dealing code once Futurix runs 2 clean weeks on RUST.
- Accept: order ack p95 < 60 ms browser-side EU; ledger sum == balance nightly; zero
  manual reconciliation diffs for 14 days.

## Phase 4 — Bridge v1 / A-book (weeks 8–12)

- FIX 4.4 initiator crate (`engine/bridge`): logon, MD subscribe, NOS, ER handling,
  sequence store, reconnect. Test against cTrader FIX (free) first, then chosen LP.
- Second price source: bridge feed becomes primary, MT5 EA demoted to fallback
  (auto-failover on 3 s staleness — kills the single-terminal SPOF).
- A-book execution: `LpRoutingRule` becomes real for RUST brokers — route by
  group/size/symbol; hedge order lifecycle in the dealing desk; fill-quality
  (slippage) tracking per LP.
- Auto-hedge on B-book net exposure thresholds (the backoffice panel exists; wire it).
- Accept: demo A-book order round-trips through FIX sandbox < 150 ms; EA unplug →
  feed fails over < 3 s; slippage report per LP in backoffice.

## Phase 5 — Terminal & backoffice modernization (parallel filler, weeks 2–12)

Small, independent items to slot into spare capacity — never displacing a phase:

Terminal: indicator pack (RSI, MACD, Bollinger, ATR, VWAP, Stoch — klinecharts has
most built-in, expose them), chart-trading (drag SL/TP lines on chart), position lines
on chart, depth-of-market panel (engine has the data model post-bridge), order
templates, trade-from-chart context menu, sound alerts, session high/low lines,
account equity sparkline, i18n scaffold (en + ur first).

Backoffice: margin page push-driven (it's the only fetch-once left), exposure heatmap,
client equity-curve on CLI page (design exists from the mockups), dealing queue SLA
timer, IB commission accrual job (computed-on-read → accrued ledger rows), report
scheduler (email the CSVs), audit log diff viewer.

Design language: apply the institutional theme (command bar, panel codes, density)
from the mockup files as the Pro skin; current UI becomes Basic. Do this AFTER Phase 3
so we're not restyling a path scheduled for deletion.

---

## What we are explicitly NOT doing before week 12

Native desktop rewrite; PAMM/copy (Phase 6 with Bullion Club); mobile apps; second
region/HA engine (revisit at first non-Futurix tenant); marketing site rebuild.
