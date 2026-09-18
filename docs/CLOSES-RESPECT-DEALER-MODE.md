# Closes respect DEALER mode — implementation plan

_Written 2026-09-16. Status: **BUILT 2026-09-18, held for release** — web commits 9317be1 (stages
1-3), 3cc56ae (4 / 7 / 8); platform repo f5c8a9a (terminal, stage 5), b3cd68c (backoffice, stage 6).
Code index: `lib/queued-close.ts` (queue / execute / cancel), migration
`20260918100000_queued_close_orders` (apply with `migrate deploy` BEFORE the web deploy), tests
`app/api/manage/dealing-queue/[id]/queued-close.test.ts`. SL / TP / stop-out run in
`lib/risk-monitor.ts` (the engine only hooks it), so "engine" in the plan meant that file._

## Problem

When DEALER mode is ON for a group, terminal **opens** correctly reach the dealer queue
(AWAITING DEALER), but **closes bypass the queue and auto-execute** — they never wait for the
dealer. The dealer-mode intercept exists only on the open path.

- **Open intercept:** `app/api/trade/orders/route.ts` — `resolveWantsDealingQueue({...})`
  (`:260`) → `if (type === "MARKET" && wantsQueue)` (`:269`) creates an `Order` with
  `status:"PENDING"` and **no Position** (`:284`). That PENDING Order *is* the queue entry;
  the dealer acts on it in `app/api/manage/dealing-queue/[id]/route.ts` (accept → creates a
  Position, `status:"FILLED"`).
- **Close path:** `app/api/trade/positions/[id]/close/route.ts` runs
  `prisma.$transaction(tx => closePositionInTx(tx, {...}))` (`:120`) **unconditionally** —
  no queue branch. `resolveWantsDealingQueue` (`lib/dealing-routing.ts:26`) is called on the
  open path, the resting-order fill path (`orders/[id]/fill/route.ts:132`) and the desk-toggle
  re-eval (`manage/dealing-desk-toggle/route.ts:127`) — **never on any close path.**

## Policy (decided)

- **MANUAL client-initiated close** (single, bulk, close-by) → **dealer queue** when dealer
  mode is ON, same gate as opens.
- **TP / SL / stop-out** (automatic, price/risk-triggered) → **execute immediately, BYPASS**
  the dealer. Never held.
- **Every close on a dealing-group account — including bypassed TP/SL/stop-out — must still
  appear in the dealer ACTIVITY LOG** (awareness). See the #5 correction below.
- **(a) close-by while dealer-managed → queue BOTH legs** (consistent with manual close).
- **(b) partial close through the queue → ALLOW** (`closeVolume`); do not force a full close.

---

## The #5 correction — bypassed closes are NOT in the dealer feed today

The earlier framing ("`recordDealerActivity` already tags closes, so it keeps working") was
**wrong**. Verified:

- `recordDealerActivity` (`lib/dealer-activity.ts:69`) writes **no AuditLog** — it only
  publishes a live `DealerActivity` NATS event + an optional bell notification.
- The dealer feed's **history** (`getDealerActivityFeedRows`, backing
  `GET /api/manage/dealing-desk`) reads `AuditLog` rows whose action is in `AUDIT_ACTION_MAP`
  (`lib/dealer-activity.ts:140`). The only close mapping is
  `MANUAL_POSITION_CLOSE → POSITION_CLOSED`, and that audit row is written **only by the admin
  close route** (`app/api/manage/positions/[id]/close/route.ts:158`).
- `closePositionInTx` (`lib/position-close.ts`) does **not** write a close audit row (only a
  `Transaction` row, and `NEGATIVE_BALANCE_PROTECTION_APPLIED` in one case).

Current dealer-feed coverage of closes on a dealing-group account:

| Close path | Live event (`recordDealerActivity`) | History (mapped `AuditLog`) |
|---|---|---|
| Single client close (`trade/positions/[id]/close`) | ✅ `:173` | ❌ (disclosed gap, `dealer-activity.ts:133-139`) |
| Client bulk (`trade/positions/close-bulk`) | ❌ | ❌ |
| Client close-by (`trade/positions/close-by`) | ❌ | ❌ |
| Admin close (`manage/positions/[id]/close`) | ✅ `:196` | ✅ `MANUAL_POSITION_CLOSE` `:158` |
| **Risk monitor SL/TP/stop-out** (`lib/risk-monitor.ts:130,191`) | ❌ | ❌ |
| Mirror close (`lib/mirror.ts:521`) | ❌ | ❌ |

⇒ **TP/SL/stop-out (and client bulk/close-by) closes appear in the dealer feed neither live
nor in history.** #5 requires new work.

### Central fix (satisfies #5 for every path at once)

Write the feed's audit row **inside `closePositionInTx`** so *all* close paths — client
single/bulk/close-by, admin, risk-monitor SL/TP/stop-out, mirror — produce a
`POSITION_CLOSED` history row uniformly and atomically with the close:

- Add params to `closePositionInTx`: `accountNumber`, `accountFullName`, `symbolName`,
  `closeReason` (`MANUAL | SL | TP | STOP_OUT | MIRROR | ADMIN`). Callers already have these
  (risk-monitor/mirror may need to `select` accountNumber/fullName).
- Add the `closeReason` → feed-action mapping to `AUDIT_ACTION_MAP` (`lib/dealer-activity.ts:140`);
  `getDealerActivityFeedRows` already computes `isDealingGroup` per row via the account join, so
  the row is correctly shown/filtered for the dealer.
- This **also closes the disclosed cold-load gap** (`dealer-activity.ts:133-139`).
- For **real-time** visibility on an open panel, add a `recordDealerActivity(...)` live event
  (with `isDealingGroup: isDealingManagedAccount({...})`, `skipNotification` as appropriate) on
  the risk-monitor close paths (`lib/risk-monitor.ts:130,191`) and the mirror
  (`lib/mirror.ts:521`) — mirroring `close/route.ts:173-183`.

Net: bypassed TP/SL/stop-out closes execute immediately **and** still land in the dealer
activity log (history always; live when the panel is open).

---

## 1. Schema — extend `Order` (recommended)

The dealer queue is `Order`-based (`dealing-queue/route.ts:32-41` lists `Order` where
`type:"MARKET"`, `status PENDING/REQUOTED`; accept/requote/reject in `dealing-queue/[id]/route.ts`
operate on `Order`). A queued close as an `Order` reuses the one queue + handlers + backoffice
screen + desk-toggle re-eval.

Rejected: `PositionActionRequest` (`schema:1756`) is admin maker-checker
(`requestedByAdminId`/`reviewedByAdminId`) — wrong actor and UI. A separate `PendingClose`
entity would need a parallel queue + handlers.

`prisma/schema.prisma`:
- `Order`: add `closesPositionId String?` + relation `closesPosition Position? @relation("OrderCloses")`;
  `closeVolume Decimal?` (partial closes — policy (b)). `closesPositionId != null` is the
  open-vs-close discriminator (keep `type:"MARKET"`, so the existing queue filter catches it;
  an explicit `OrderType.CLOSE` is the more-verbose alternative that touches every `OrderType`
  switch).
- `Position`: add `closePendingOrderId String?` (+ relation) — the lock (trader UI locks the
  row; a second close / `resolveWantsDealingQueue` call rejects "already pending").
- Reuse the `OrderStatus` lifecycle (PENDING → ACCEPTED/FILLED / REJECTED / REQUOTED).
- One migration via `migrate deploy` (never `migrate dev` on this DB — Rust engine tables
  trigger false drift/reset).

## 2. Manual vs automatic — it's the caller (no flag needed for gating)

`closePositionInTx` (`lib/position-close.ts`) callers:
- **Client (gate):** `trade/positions/[id]/close/route.ts:121`; `lib/bulk-close.ts:128`
  (via `trade/positions/close-bulk`); `lib/close-by.ts:99,106` (via `trade/positions/close-by`).
- **Automatic (leave untouched → bypass):** `lib/risk-monitor.ts:130` (SL/TP), `:191`
  (stop-out); `lib/mirror.ts:521`.

The risk monitor and mirror call `closePositionInTx` directly from their own modules and never
touch the client routes, so they're excluded for free. `lib/bulk-close.ts` is *also* used by the
**admin** `manage/positions/close-bulk/route.ts`, which must keep bypassing — so the gate goes in
the three `app/api/trade/positions/**` routes, **not** inside the shared `lib/bulk-close.ts` /
`lib/close-by.ts` helpers. (`closeReason` is still added to `closePositionInTx` for the #5 feed
row, but it is not what decides queue-vs-execute — the caller does.)

## 3. Gate the three client close routes

Compute `resolveWantsDealingQueue({ groupDealingMode, brokerDealingModeOn, groupForceDealingMode,
groupTypeIsDealing, dealingDeskAutoFillOn })` (`lib/dealing-routing.ts:26`) up front, mirroring
`orders/route.ts:260` (the single route already selects the group at `close/route.ts:44`; fetch
broker `dealingModeAt`/`dealingDeskAutoFillAt` before the close instead of after).

- **Single** (`trade/positions/[id]/close/route.ts`): if `wantsQueue`, create a close-intent
  `Order` (`status:"PENDING"`, `closesPositionId`, `closeVolume`), set
  `Position.closePendingOrderId`, audit `ORDER_PLACED`, return "awaiting dealer" — instead of the
  `prisma.$transaction(closePositionInTx)` at `:120`. Reject if `closePendingOrderId` already set
  (double-act guard, alongside the existing `outcome.closed===false → 409` at `:136`).
- **close-bulk** (`trade/positions/close-bulk/route.ts`): when dealer-managed, create **N**
  pending close Orders (one per in-scope open position) rather than calling `closeBulkForAccount`;
  `lib/bulk-close.ts`'s scope logic still selects *which* positions.
- **close-by** (`trade/positions/close-by/route.ts`): **queue both legs** (policy (a)) — two
  pending close Orders, each locking its position.

## 4. Accept / requote / reject → CLOSE at the dealer price

In `dealing-queue/[id]/route.ts` (today accept creates a Position + `FILLED` + returns
`positionId`, `:269,308-310`), branch on `order.closesPositionId != null`:
- **Accept** → `closePositionInTx(tx, { position, closePrice: dealerMarkedPrice, closeVolume:
  order.closeVolume, closeReason: "MANUAL", … })`; set Order `FILLED`; clear
  `Position.closePendingOrderId`; run the close route's post-commit block
  (`close/route.ts:164-183`: `mirror.onClose`, `publishTradingEvent("PositionClosed")`). No new
  Position.
- **Requote** → `REQUOTED` with the offered close price; the client responds via
  `orders/[id]/requote-response/route.ts` — needs the close branch too.
- **Reject** → `REJECTED`; clear the lock; position stays open.
- Queue list (`dealing-queue/route.ts`) + backoffice Dealing row: add a CLOSE-vs-OPEN indicator
  (show "CLOSE {vol}" + target ticket). The backoffice renders whatever the manage endpoint
  returns, so mostly a server-shape/label change.

## 5. Dealer activity log for every close

See **The #5 correction** above — the central `closePositionInTx` audit-row write (plus the
risk-monitor/mirror live events and the `AUDIT_ACTION_MAP` mapping) is what makes bypassed
TP/SL/stop-out/bulk/close-by closes appear in the dealer feed, both in history and (with the
added live events) in real time.

## 6. Desk toggles off → pending closes

Parallel the re-eval in `manage/dealing-desk-toggle/route.ts:102-160` (re-runs
`resolveWantsDealingQueue` per PENDING order on flip, auto-filling those that no longer want the
queue): extend it so PENDING **close** Orders auto-**execute the close** (`closePositionInTx`,
clear the lock) instead of auto-filling an open. Edge: if the **risk monitor** closes a position
that has a pending close (SL/TP/stop-out wins the race), cancel the orphaned close Order + clear
the lock — add to `lib/risk-monitor.ts` post-close, or rely on the accept-path guard (position
already closed → no-op).

## 7. Effort & versioning

**~4–6 focused days:** schema + migration ~0.5d; three route gates incl. bulk fan-out ~1d;
accept/requote/reject/requote-response close branches ~1.5d; `closePositionInTx` feed
unification + risk-monitor/mirror live events + `AUDIT_ACTION_MAP` ~1d; position lock +
trader-UI "close pending" + orphan-cancel race ~1d; tests ~0.5–1d. Mirror existing tests:
`app/api/manage/dealing-queue/[id]/route.test.ts`, `app/api/trade/positions/[id]/close/route.test.ts`,
`close-bulk.test.ts`, `close-by.test.ts`.

**Ships as its own version** — cross-cutting web/engine feature with a **DB migration**, plus
small trader-terminal (lock UI) and backoffice (CLOSE-row label) changes. Dedicated feature
branch → one coordinated deploy (migration first, then app); terminal/backoffice pick up their
small bits in their next builds. Do not bundle into an unrelated release.

## File/function index

- Gate: `resolveWantsDealingQueue` — `lib/dealing-routing.ts:26`
- Open intercept (model to mirror): `app/api/trade/orders/route.ts:260,269,284`
- Close execution: `closePositionInTx` — `lib/position-close.ts`
- Client close routes to gate: `app/api/trade/positions/[id]/close/route.ts:120`;
  `app/api/trade/positions/close-bulk/route.ts` → `lib/bulk-close.ts:128`;
  `app/api/trade/positions/close-by/route.ts` → `lib/close-by.ts:99,106`
- Bypass (untouched, + add feed events): `lib/risk-monitor.ts:130,191`; `lib/mirror.ts:521`;
  admin `app/api/manage/positions/close-bulk/route.ts` (keeps bypassing)
- Queue list: `app/api/manage/dealing-queue/route.ts:32-41`
- Accept/requote/reject: `app/api/manage/dealing-queue/[id]/route.ts:269,292,308-310`
- Client requote response: `app/api/trade/orders/[id]/requote-response/route.ts`
- Desk-toggle re-eval: `app/api/manage/dealing-desk-toggle/route.ts:102-160,127`
- Dealer feed: `lib/dealer-activity.ts` — `recordDealerActivity:69`, `getDealerActivityFeedRows`,
  `AUDIT_ACTION_MAP:140`, disclosed gap `:133-139`; admin close audit
  `app/api/manage/positions/[id]/close/route.ts:158`
- Schema: `prisma/schema.prisma` — `Order:1623`, `Position:1663`, `OrderType:165`,
  `OrderStatus:176`, `PositionActionRequest:1756` (why not reused)
