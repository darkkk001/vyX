# WebTrader + Smart Trade Manager — Architecture Review

**Status: fully implemented (2026-08-22).** Every item in §3 and the §6 sequencing plan has shipped, including the three §4.6 audit actions (`WEBTRADER_SSO_LOGIN`, `STM_HOTKEY_ORDER`, `STM_BULK_CLOSE`) that initially went in without their audit-log writes, and watchlist/panel-layout persistence (item 10) alongside the STM-config/theme persistence that shipped with items 1 and 9. This document is kept as-is below for the original proposal/rationale — read it as history, not a live TODO list.

---

## 1. How to read this document

Two specs came in: a full WebTrader upgrade spec (43 sections) and a Smart Trade Manager spec (25 parts). They overlap heavily — STM's bulk position actions are a subset of WebTrader's Position Management section. This review treats them as one backlog, organized by what's really new versus what's UI wiring on top of things that already exist.

**The headline finding**: almost every *trading primitive* STM and WebTrader ask for — partial close, SL/TP modify, single-position close — already exists in the backend, already goes through the Trading Core → Risk Engine path, and already has idempotency where it matters (order placement). The real gap is almost entirely in the **client**: no hotkey system, no bulk-action orchestration, no multi-account UI, no SSO entry point. This is good news for risk: most of this work touches `components/webtrader/WebTrader.tsx` and a handful of new thin API routes, not the Rust engine.

---

## 2. Current architecture (inspection findings)

### 2.1 Client Terminal / WebTrader — one codebase, three shells

`components/webtrader/WebTrader.tsx` (2,471 lines) is the entire trading UI. Three different "products" all load the exact same page:

| Shell | How it loads WebTrader |
|---|---|
| Browser (WebTrader, public) | Direct navigation to `acmefx.vyxtrader.com/trade` |
| Client Terminal (`desktop-tauri`) | Tauri webview pointed at `acmefx.vyxtrader.com/trade` (`broker.config.json`) |
| — | (Backoffice/Super Admin are the same pattern via `manager-tauri`/`admin-tauri`, out of scope here) |

There is **no separate backend** for the desktop app versus the browser — same routes, same session model, same everything. This matters for the SSO and hotkey work below: whatever we build has to work through this one shared surface.

### 2.2 Order/Position/Pending model

- `Order` (Prisma) — a trade *request*: `MARKET`, `LIMIT`, `STOP` types, status (`PENDING`, `FILLED`, `REJECTED`, `CANCELLED`, `REQUOTED`, etc.), carries `idempotencyKey` (unique per `accountId`).
- `Position` (Prisma) — actual open exposure: `side`, `volume`, `openPrice`, `slPrice`/`tpPrice`, `status` (`OPEN`/`CLOSED`).
- The "Orders" bottom tab in WebTrader today shows **only pending orders** (`pendingOrders.length` drives its badge count) — it's already functionally a Pending Orders tab, just labeled "Orders." There's no separate view of order *lifecycle* (rejected/cancelled/expired history distinct from closed-position history).
- "Net positions" tab already exists and computes real aggregated exposure per symbol (not faked client-side) — this already satisfies STM/WebTrader's Net Positions requirement almost as-is.
- A `Position` row IS the netting unit today — there's no evidence of a "hedging vs netting" account-mode toggle in the schema; every account behaves like a hedging account (multiple simultaneous positions per symbol, each with its own ID). This is worth confirming explicitly with you before Part 11/13 (Partial Close, Netting mode) is built, since "netting mode" isn't a concept that exists anywhere in the schema today.

### 2.3 Trading primitives that already exist (reusable as-is)

| Capability | Route | Notes |
|---|---|---|
| Place market/pending order | `POST /api/trade/orders` | Idempotency key required, full risk chain (`lib/risk.ts`), dealing-queue/requote flow |
| Cancel pending order | `DELETE /api/trade/orders/[id]` (assumed from route list) | |
| Modify SL/TP | `PATCH /api/trade/positions/[id]` | Validates side-aware via `lib/trading.ts`'s `validateSlTp` against a client-reported current price — **this is exactly what Break-Even needs**: compute `newSl = openPrice ± offset`, call this route |
| Close position, full or partial | `POST /api/trade/positions/[id]/close` | Already branches on `isPartial = closeVolume.lt(position.volume)` — **this is exactly what Partial Close and Close-All/Profitable/Losing need**: no new backend logic, just call this once per matching position with the right volume |
| Reverse / void (manager-side) | `app/api/manage/positions/[id]/reverse` | Backoffice only, not relevant to STM |
| Close profitable / losing / all, close-all-by-symbol | `WebTrader.tsx`'s `closeManyBy`/`closeManyBySymbol` (client orchestration over the close endpoint above) | **Correction to an earlier pass of this review**: these already exist in the UI today (Actions menu + bottom-panel bulk buttons + per-symbol "close all") — an earlier grep for the literal strings "Close All"/"closeAll" missed them since the real functions are named `closeManyBy`/`closeManyBySymbol`. Custom-lot partial close (`openPartialClose`, prompt-based) also already exists. |

**Revised conclusion: STM Parts 13–15 (Close Profitable/Losing/All) are already built, not a gap.** What's still genuinely missing from Parts 11–12: **percentage-based** partial close (25/50/75% buttons — today it's custom-lot-only via a prompt), **Break-Even** (not built at all), and scoping bulk actions by **BUY/SELL direction** or a **selected-positions** checkbox set (today's bulk actions are "all positions" or "one symbol" only — no direction filter, no multi-select). None of this needs new Trading Core/Risk Engine work either — same reuse of the existing close/modify-SL endpoints, just richer client-side filtering.

### 2.4 Real-time infrastructure

- Market data: Rust `engine/market-data` → NATS (`price.tick.{symbol}`) → `services/api-gateway`'s `/v1/prices/stream` WebSocket → `WebTrader.tsx` already subscribes to this (`NEXT_PUBLIC_GATEWAY_WS_URL`).
- A 2-second REST poll (`tradeApi.prices()`) runs alongside the WebSocket as: (a) a fallback when the socket can't connect, (b) the piggyback carrier for `refreshOrders()`/`refreshPositions()` (dealer requotes, externally-created positions — added this session), and (c) the connection-status signal.
- **This already satisfies section 7's "no 2-second polling for prices" requirement** — prices come from the WebSocket; the poll is a secondary fallback/carrier, not the primary price path. Worth being precise about this distinction if it's re-audited later.
- Order/position/account updates are **not yet pushed over the WebSocket** — they're picked up by the same 2s poll. Section 11 wants fills/balance/equity/margin pushed via WebSocket rather than polled. This is a real gap (see §4.3).

### 2.5 Hotkeys

None exist. The only `onKeyDown` handlers in `WebTrader.tsx` are Enter/Escape on two inline-edit inputs and a generic modal's input field. STM's entire Part 8/9 (hotkey manager, modifier keys, conflict detection) is new.

### 2.6 Client-side settings persistence

Only `localStorage["vyx-theme"]` exists today. No workspace/watchlist/STM-config persistence layer. New, but small — same pattern, new keys.

### 2.7 Multi-account

`Account.email` is **not** `@unique` in the schema — multiple accounts (e.g., a LIVE and a DEMO account) can already share one email under one broker. Each `Account` has its own independent `passwordHash`, and login (`POST /api/trade/login`) is by `accountNumber`. There is no session concept of "one identity, N accounts" and no account-switcher UI. Per your decision, this stays lightweight: switching = pick a linked account from a dropdown, re-enter that account's password.

### 2.8 Authentication

- Trader sessions: Redis-backed opaque token (`vyx_trade_session` cookie), 7-day TTL, `lib/account-auth.ts`.
- No 2FA, no device/session list anywhere in the codebase.
- No SSO/token-handoff route exists yet — this is entirely new (see §4.1).

---

## 3. What's genuinely new (not just reuse)

1. **SSO entry point** (broker's own portal → WebTrader, no manual login) — new auth surface.
2. **Account Selector** (lightweight, linked-by-email accounts) — new UI + one new API route.
3. **Hotkey Manager + Smart Trade Manager panel** — new client module.
4. **Bulk position-action orchestration** (partial close %, break-even, close profitable/losing/all, with scopes) — new client-side loop over existing endpoints + a small aggregation response shape.
5. **Live SL/TP validity indicator** tied to the STM config (not just the order ticket) — new, reuses `validateSlTp`'s logic client-side for instant feedback, server stays authoritative.
6. **Order/position/account updates over WebSocket** instead of the 2s poll — extends `services/api-gateway` and the Rust order-management side to publish these events, not just ticks.
7. **Pending Orders tab renamed/clarified**, separated conceptually from Orders-as-lifecycle — small, mostly a labeling and grouping fix given §2.2's finding.
8. **2FA, device/session management** — new, not started.
9. **Mobile responsive layout** — new, WebTrader is currently fixed-pixel desktop-only.
10. **Client settings/workspace persistence** (STM config, watchlists, layout) — new, small, follows the existing theme-localStorage pattern.

Explicitly **not** proposed yet (deferred, low priority, or needs your input first): Market Depth (spec marks it optional/feed-dependent), Internal Transfer between accounts (depends on §2.7 multi-account existing first), Quick Trade panel (thin wrapper over the existing order ticket, cheap to add once STM's panel exists), hedging-vs-netting account mode (schema doesn't have this concept today — flagged in §2.2, needs a decision before Partial Close's "respect hedging/netting mode" line means anything concrete).

---

## 4. Proposed architecture

### 4.1 SSO entry point

```
Broker's own backend (external, not ours)
  │  authenticates trader in THEIR system
  ▼
POST https://acmefx.vyxtrader.com/api/trade/sso/token
  Headers: X-Broker-Secret: <per-broker secret, issued by us>
  Body: { accountNumber }
  ▼
Returns: { ssoToken }  (short-lived, single-use, ~30s expiry)
  │
  ▼
Broker's frontend redirects trader's browser to:
  https://acmefx.vyxtrader.com/trade/sso?token=<ssoToken>
  │
  ▼
GET /trade/sso — validates token (one-time use, checks broker match),
  creates a real trader session exactly like /api/trade/login does,
  sets the same vyx_trade_session cookie, redirects into /trade
```

- New `Broker.ssoSecret` column (generated, shown once in Super Admin, rotatable).
- New table or Redis key for single-use SSO tokens (Redis fits better — same TTL/consume pattern as `lib/rate-limit.ts` already uses).
- Reuses `createAccountSession` from `lib/account-auth.ts` unchanged — the SSO route's only job is *proving* the broker already authenticated this trader, then handing off to the exact same session mechanism as normal login.
- Never accepts a trader-supplied broker ID or account ID without checking `X-Broker-Secret` server-side first (matches the existing rule in `lib/permissions.ts`'s style: never trust a client-asserted identity).

### 4.2 Account Selector (lightweight)

- New `GET /api/trade/linked-accounts` — `prisma.account.findMany({ where: { email: session.email, brokerId: session.brokerId, id: { not: session.accountId } } })`, returns `accountNumber`, `accountType`, `currency`, masked balance.
- New UI: dropdown in the top bar next to the existing account info, listing linked accounts. Selecting one opens a small password-confirm modal, then calls the existing `/api/trade/login` for that `accountNumber` — this **replaces** the session (matches MT4/5 behavior: switching accounts is a real re-login, just conveniently pre-filled).
- No schema change.

### 4.3 WebSocket-pushed order/position/account events

- `services/api-gateway` already subscribes to NATS for ticks; extend it to also subscribe to a new subject family (e.g. `account.{accountId}.event`) and forward matching events to the right WebSocket client.
- On the Rust side, `order-management`'s fill/close/modify paths (and the Next.js API routes for order placement/close/modify, until a broker cuts over to the Rust engine per ADR-003) publish a small event to NATS after a successful mutation — same "fire and forget, never block the response on it" pattern already used for ticks.
- Client: `WebTrader.tsx`'s existing WebSocket effect gets a second message-type branch (ticks already use an implicit shape; add a `type` discriminator) that calls `refreshPositions()`/`refreshOrders()`/`refreshAccount()` immediately on receipt, instead of waiting up to 2s for the poll.
- The 2s poll **stays** as the fallback/reconciliation path (§31 of the spec explicitly wants a full reconciliation on reconnect, not just trusting cached state) — this isn't replaced, just no longer the primary latency source for these updates.

### 4.4 Smart Trade Manager module

New client-only module, no new Trading Core work:

- `lib/hotkeys.ts` — a small hotkey manager: registers key+modifier combinations, ignores events when focus is inside an input/textarea (spec's "respect focused input fields"), detects conflicts at assignment time.
- `components/webtrader/SmartTradeManager.tsx` — the config panel (symbol, order type, lot, SL, TP, hotkeys, Smart Execution toggle with the required confirmation modal).
- Config persisted to `localStorage` under a new key (`vyx-stm-config`), same pattern as `vyx-theme`. Nothing sensitive in it (lot size/SL/TP/hotkeys aren't credentials).
- Buy/Sell hotkey press → builds an order request with a **freshly generated `idempotencyKey` per press** (so key-repeat/double-fire produces at most one order, but two genuine separate presses correctly produce two orders — matches the spec's "every press is an independent order request" while still protecting against accidental duplicates) → calls the existing `POST /api/trade/orders`, unchanged.
- Bulk actions (break-even/partial-close/close-profitable/losing/all) → client-side filter of `positions` state by scope, then `Promise.allSettled` over the existing close/modify endpoints per position, aggregated into `{ requested, successful, failed, results: [...] }` for the UI.
- Live SL/TP validity indicator: reuses `validateSlTp`'s exact comparison logic client-side (already duplicated once for the order ticket's own UX validation — same reasoning applies here), recomputed on every tick from the live price already flowing through `WebTrader.tsx`'s state. Server-side `validateSlTp` remains the authority at execution time regardless of what the indicator showed.

### 4.5 Pending Orders / Orders clarity

- Rename the existing "Orders" tab to "Pending Orders" (it already only shows pending orders — this is a label fix, not new data plumbing).
- Add a genuinely new "Orders" tab if you want full order-lifecycle visibility (including rejected/cancelled/expired, not just what's currently pending or in closed-position history) — this needs a new read endpoint (`GET /api/trade/orders?status=all`) since today's `tradeApi.orders()` likely only returns pending ones. Flagging this as optional/lower-priority since it's the one item in this section that isn't purely cosmetic.

### 4.6 Security model (applies across all of the above)

- Every new route re-validates `getAccountSession()` and re-derives `brokerId`/`accountId` server-side — never trusts a client-supplied ID, consistent with everything already in this codebase.
- SSO tokens: single-use (deleted from Redis on consumption), short TTL, bound to one `accountId`, transmitted only over HTTPS, never logged.
- Bulk actions and hotkey-triggered orders go through the exact same `lib/risk.ts` chain as manual order placement — no new bypass path is introduced anywhere in this plan.
- Audit logging: extend `lib/audit-labels.ts` with the new action types the specs ask for (`WEBTRADER_SSO_LOGIN`, `WEBTRADER_ACCOUNT_SWITCH`, `STM_HOTKEY_ORDER`, `STM_BULK_CLOSE`, etc.), written the same way every other mutation in this app already writes to `AuditLog`.

---

## 5. Files touched (estimate)

**New:**
- `app/api/trade/sso/token/route.ts`, `app/trade/sso/route.ts` (or a route handler under `/trade`)
- `app/api/trade/linked-accounts/route.ts`
- `lib/hotkeys.ts`
- `components/webtrader/SmartTradeManager.tsx`
- `components/webtrader/AccountSelector.tsx`
- One Prisma migration: `Broker.ssoSecret` column + `AuditLog` label additions (no new tables strictly required — SSO tokens live in Redis, not Postgres)

**Modified:**
- `components/webtrader/WebTrader.tsx` — mount points for the two new panels, WebSocket message-type branch, bulk-action handlers
- `services/api-gateway/src/*` — new NATS subject subscription + forwarding for account/order/position events
- Rust `order-management` (and/or the Next.js order routes, pre-cutover) — publish events on fill/close/modify
- `lib/audit-labels.ts` — new action labels

**Not touched:** Trading Core, Risk Engine, Execution Engine logic itself; the `Order`/`Position` schema; anything under `engine/risk`, `engine/execution`.

---

## 6. Sequencing recommendation

Given dependencies (Account Selector's UI slot is more useful once SSO exists; STM's bulk actions don't depend on anything else):

1. **Smart Trade Manager** (hotkeys + bulk actions + live validation) — fully self-contained, reuses existing endpoints, no new backend surface beyond orchestration. Lowest risk, immediately useful.
2. **SSO entry point** — new auth surface, needs careful review before shipping (per your earlier caution about the backoffice/superadmin exposure — same category of decision).
3. **Account Selector** — small, benefits from SSO existing first (SSO handoff already knows which account; the in-app selector becomes the "if you got here without SSO" path).
4. **WebSocket-pushed order/position/account events** — real latency win, moderate Rust+Gateway work.
5. **2FA / device management, mobile responsive, Pending/Orders split** — lower urgency, no hard dependencies, can happen in any order once 1-4 are stable.

---

## 7. Testing plan

Following both specs' §42/§24 lists directly — grouped by what actually needs a test versus what's covered by existing coverage:

- **New, needs tests**: SSO token issuance/consumption/expiry/single-use, account-switch flow, every hotkey action (including repeat-press → single order, two genuine presses → two orders), every bulk-action scope combination (symbol × side × selection), live SL/TP validity flipping as price moves, WebSocket event-driven refresh vs poll fallback on disconnect.
- **Already covered by existing order/risk tests** (per `lib/risk.ts`/`lib/trading.ts` having their own test coverage already, per this session's earlier work): margin, lot validation, symbol/session rules — these don't need re-testing, STM just calls the same validated paths.

---

**Waiting for your go-ahead before writing any code**, per both specs' explicit instruction. Sequencing in §6 is a recommendation, not a decision — happy to reorder based on what you actually want first.
