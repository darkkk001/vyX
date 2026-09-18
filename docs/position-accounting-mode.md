# Position Accounting Mode: Netting vs Hedging

Status: **design only, nothing built**. Staged rollout with shadow
verification before any real fill logic branches, same discipline the
pricing engine used (`lib/pricing-engine.ts`, `lib/pricing-shadow-compare.ts`,
`Broker.pricingEngineEnabled`).

## 0. Current state (baseline, verified in-repo)

Every account, in every group, is unconditionally **hedging** today —
there is no netting code path anywhere. Every one of the 6 real
fill sites (`lib/dealing.ts` `openPositionFromOrder`, and its 5 real
callers: `app/api/trade/orders/route.ts`, `app/api/trade/orders/[id]/fill/route.ts`,
`app/api/manage/positions/route.ts`, `app/api/manage/dealing-queue/[id]/route.ts`,
`app/api/trade/orders/[id]/requote-response/route.ts`, plus `lib/mirror.ts`
for mirror-destination accounts and `app/api/manage/dealing-desk-toggle/route.ts`
for queue-drain fills) unconditionally does `tx.position.create(...)` — none
of them ever looks up an existing open position on the same symbol first.
`lib/dealing.ts`'s own header comment claiming "3 callers" is stale; there
are 7 real call sites, all in scope for this change.

`Position.originOrderId String @unique` + `Order.position Position?`
(singular) currently enforce a strict **1:1 Order→Position** relationship.
This is the central constraint netting has to work around: a netting fill
that merges into, reduces, or flips an *existing* position cannot simply
reuse the "always insert a new Position row" primitive.

No net-per-symbol margin exists anywhere either — `computeAccountMarginSnapshots`
(`lib/margin.ts:27-72`) sums margin/exposure per open Position **row**,
so today a 1-lot BUY + 1-lot SELL on the same symbol already consumes 2×
the margin a netted 0-lot exposure would. §4 explains why this needs no
new margin-calculation code at all once the write-time design below is in
place.

## 1. Schema

```prisma
enum PositionMode {
  NETTING
  HEDGING
}

model Group {
  // ...existing fields...
  // Default accounting mode for every account in this group that hasn't
  // set its own override (Account.positionMode). Non-null with a default
  // so this always resolves to something -- same "config now, zero
  // behavior change until explicitly touched" shape as GroupDealingMode.
  // HEDGING preserves exactly what every account already does today.
  positionMode PositionMode @default(HEDGING)
}

model Account {
  // ...existing fields...
  // Per-account OVERRIDE of Group.positionMode. Nullable tri-state, same
  // "null = not set, fall through to the parent" convention as
  // Account.swapFree/AccountType.swapFree/Group.swapFree (see those
  // fields' own comments) -- just a 2-level version of it, since
  // Group.positionMode is itself already non-null with a real default
  // (no further AccountType/broker-wide fallback needed). Resolution:
  // account override > group default > HEDGING (the HEDGING literal is
  // only ever reached for an account with no group at all).
  positionMode PositionMode?
}

model Order {
  // ...existing fields...
  // Set ONLY when this order's fill was merged into, reduced, or closed
  // an EXISTING position rather than creating its own (NETTING mode's
  // same-side-add / opposite-side-smaller / opposite-side-flip branches
  // -- see §3). An order that opens its own new position (HEDGING mode
  // always; NETTING mode's first fill on a flat symbol; the "open"
  // half of a flip) is still found the existing way, via
  // Position.originOrderId / Order.position. Deliberately NOT unique --
  // many orders over a netting position's life each point back to the
  // same position. Nullable FK, ON DELETE SET NULL (an order's own
  // history row must never disappear because the position it affected
  // was later hard-deleted by a backoffice PositionActionRequest).
  nettedPositionId String?
  nettedPosition   Position? @relation("OrderNettedPosition", fields: [nettedPositionId], references: [id])
}

model Position {
  // ...existing fields, unchanged...
  nettedByOrders Order[] @relation("OrderNettedPosition")

  // NEW -- the netting fill-site hot path needs "does this account
  // already have an OPEN position in this symbol" to be a cheap lookup,
  // not a scan. Nothing indexes (accountId, symbolId, status) today.
  @@index([accountId, symbolId, status])
}
```

Nothing about `Position.originOrderId`'s own uniqueness changes. A
netting position's *originating* order (the fill that first opened it,
or that opened the remainder after a flip) is still exactly one order,
still enforced at the DB level. Every *subsequent* order that only
merges into / reduces / flips that same position is linked via the new
`nettedPositionId` instead — full fill-by-fill audit trail (for
statements, backoffice review, and dispute investigation) without
touching the existing 1:1 constraint anyone else's code already relies
on.

### 1a. Migration SQL (additive only)

```sql
-- CreateEnum
CREATE TYPE "PositionMode" AS ENUM ('NETTING', 'HEDGING');

-- AlterTable: Group gets a real, non-null default -- every existing
-- group becomes HEDGING explicitly, identical to its current de-facto
-- behavior.
ALTER TABLE "Group" ADD COLUMN "positionMode" "PositionMode" NOT NULL DEFAULT 'HEDGING';

-- AlterTable: Account gets a nullable override, no default -- every
-- existing account becomes NULL (inherit from group), zero change.
ALTER TABLE "Account" ADD COLUMN "positionMode" "PositionMode";

-- AlterTable: Order's new audit pointer, nullable, no default -- every
-- existing order becomes NULL (never netted, correct for 100% of
-- existing rows, since netting has never existed).
ALTER TABLE "Order" ADD COLUMN "nettedPositionId" TEXT;
ALTER TABLE "Order" ADD CONSTRAINT "Order_nettedPositionId_fkey"
  FOREIGN KEY ("nettedPositionId") REFERENCES "Position"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Order_nettedPositionId_idx" ON "Order"("nettedPositionId");

-- Hot-path index for the netting fill lookup (and a reasonable general
-- speedup for any other accountId+symbolId+status query).
CREATE INDEX "Position_accountId_symbolId_status_idx"
  ON "Position"("accountId", "symbolId", "status");
```

This migration alone is **fully safe to ship standalone**, ahead of any
fill-site code changes: it only adds nullable/defaulted columns, a new
FK, and an index. No existing query, resolver, or fill path reads any of
these new columns yet, so `prisma migrate deploy` for this file changes
zero live behavior for any broker — same "Stage 1: additive migration,
defaults preserve old behavior" step the pricing engine used
(`Broker.pricingEngineEnabled`'s own schema comment).

Not in scope: `engine/migrations/*.sql` (the Rust engine's own
snake_case `positions`/`orders` tables). Confirmed via
`docs/STATE-OF-PROJECT.md` (2026-08-30) and ADR-003
(`docs/decisions.md`): the Next.js/Prisma path is the live, money-moving
system for every onboarded broker today; the Rust path "has never taken
a real order." This feature belongs on the Prisma models only until a
real engine cutover happens, at which point it would need its own
parallel design.

## 2. Resolution

```ts
// lib/position-accounting.ts (new)
export function resolvePositionMode(account: {
  positionMode: PositionMode | null;
  group: { positionMode: PositionMode } | null;
}): PositionMode {
  return account.positionMode ?? account.group?.positionMode ?? "HEDGING";
}
```

Trivial, pure, unit-testable in isolation — same shape as
`lib/pricing-engine.ts`'s own `firstNonNull(...) ?? finalDefault`
resolvers. Every fill site already loads `account` (with `group`
included, since margin/leverage/pricing resolution already needs it) —
this adds no new query, only a new field read off data already in hand.

## 3. Fill-time behavior

New shared primitive, `lib/position-accounting.ts`:

```ts
export async function fillOrderWithPositionMode(
  tx: Tx,
  order: { id, brokerId, accountId, symbolId, side, volume, slPrice, tpPrice },
  fillPrice: Prisma.Decimal,
  bookType: BookType,
  positionMode: PositionMode,
  contractSize: Prisma.Decimal,
  commissionPerLot: Prisma.Decimal = new Prisma.Decimal(0)
): Promise<FillOutcome>
```

This becomes the one function every one of the 7 call sites invokes
instead of calling `openPositionFromOrder` directly (`openPositionFromOrder`
itself stays exactly as-is and becomes this function's `HEDGING` branch —
zero change to its own body, zero risk to existing hedging behavior).

### 3a. HEDGING branch

Unchanged. Calls the existing `openPositionFromOrder(tx, order, fillPrice,
bookType, commissionPerLot)` verbatim. A buy and a sell on the same
symbol stay two independent rows, exactly like today.

### 3b. NETTING branch

First, **lock the account's existing open position on this symbol**,
inside the same transaction, before deciding anything:

```ts
const [existing] = await tx.$queryRaw<Position[]>`
  SELECT * FROM "Position"
  WHERE "accountId" = ${order.accountId}
    AND "symbolId" = ${order.symbolId}
    AND "status" = 'OPEN'
  FOR UPDATE
`;
```

The `FOR UPDATE` row lock is load-bearing, not decorative: two orders on
the same account+symbol filling concurrently (a common real scenario —
a resting LIMIT triggering at the same instant a new MARKET order is
placed) must not both read "no existing position" and both try to
create one, which would silently produce two open positions on a
netting account and violate the "at most one net position per symbol"
invariant this whole design depends on. Locking the existing row (or
locking against its *absence* — see below) serializes the decision.
When `existing` is null (flat), a `SELECT ... FOR UPDATE` finds no row
to lock, so the same race is still possible on the very first fill for
a symbol; the practical mitigation is the existing per-order
`idempotencyKey` uniqueness (`@@unique([accountId, idempotencyKey])`)
plus, if this proves insufficient under real concurrent load in Stage 2
testing, a Postgres advisory lock keyed on `hashtext(accountId ||
symbolId)` taken at the top of the netting branch specifically for the
flat-to-first-fill case. Flagged here as a concrete Stage 2 test case
(concurrent first-fill race), not solved definitively in this doc —
same "measure, then decide" posture `docs/testing.md` already expects
for money-path code.

**Case 1 — flat (no existing position):**
Identical to the hedging branch — `openPositionFromOrder`. First fill on
a flat symbol looks the same in both modes; netting only diverges once
a second fill arrives while something is already open.

**Case 2 — same side as `existing`:**
No position is closed; the existing row is **merged into**, not
replaced. Volume-weighted average price, in real `Prisma.Decimal`
arithmetic (never floating point, matching every other price
computation in this codebase):

```ts
const newVolume = existing.volume.add(order.volume);
const newOpenPrice = existing.openPrice
  .mul(existing.volume)
  .add(fillPrice.mul(order.volume))
  .div(newVolume)
  .toDecimalPlaces(5); // matches Position.openPrice's own @db.Decimal(18,5)

await tx.position.updateMany({
  where: { id: existing.id, status: "OPEN" }, // same race guard shape as closePositionInTx
  data: {
    volume: newVolume,
    openPrice: newOpenPrice,
    // A newly-submitted SL/TP replaces the position's own -- matches
    // real netting-broker UX (your latest trade's stop/target becomes
    // the position's stop/target); an order submitted with no SL/TP
    // (null) leaves the existing value untouched. Explicit design
    // choice, not a default fallen into -- flag for review.
    ...(order.slPrice !== null ? { slPrice: order.slPrice } : {}),
    ...(order.tpPrice !== null ? { tpPrice: order.tpPrice } : {}),
  },
});
await tx.order.update({ where: { id: order.id }, data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date(), nettedPositionId: existing.id } });
await chargeCommission(tx, { brokerId, accountId, positionId: existing.id, commissionPerLot, volume: order.volume }); // charged on the ORDER's own volume, same convention as every existing fill site
```

No PnL is realized (nothing closed). `bookType`/`brokerId` are not
re-stamped on the existing row — a position's book routing is decided
once, at its own creation, same as today.

**Case 3 — opposite side, `order.volume < existing.volume` (partial offset):**
This is economically a partial close, triggered by an incoming order
instead of an explicit close click — so it reuses `closePositionInTx`
**verbatim**, the exact same primitive `close-by.ts` already composes
for its own "smaller leg" case:

```ts
const outcome = await closePositionInTx(tx, {
  position: { id: existing.id, side: existing.side, openPrice: existing.openPrice, volume: existing.volume, symbol: { contractSize } },
  closePrice: fillPrice,
  closeVolume: order.volume,
  note: `Netting offset from order ${order.id}`,
});
```

Unlike `close-by` (which synthesizes a shared midpoint price because
it's pairing two *already-open* positions with no real triggering
trade), there is only one real fill happening here — the incoming
order's own `fillPrice` (already resolved through the caller's normal
`closePriceFor`/group-pricing path, same as any other fill) is the
correct, and only, price to use. `closePositionInTx`'s own `isPartial`
branch does everything else for free: reduces `existing.volume`,
leaves `status`/`closePrice` untouched, computes and credits the real
`realizedPnl` on the closed portion, writes the `TRADE_PNL` Transaction
row. Then:

```ts
await tx.order.update({ where: { id: order.id }, data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date(), nettedPositionId: existing.id } });
await chargeCommission(tx, { ..., positionId: existing.id, volume: order.volume });
```

**Case 4 — opposite side, `order.volume === existing.volume` (full offset):**
Same `closePositionInTx` call as Case 3, with `closeVolume =
existing.volume` — its own `isPartial = closeVolume.lt(position.volume)`
naturally evaluates false, so it takes the full-close branch (`status →
CLOSED`, `closePrice`/`realizedPnl`/`closedAt` stamped) with no separate
code path needed. Net position for that symbol is now flat.

**Case 5 — opposite side, `order.volume > existing.volume` (flip):**
Two steps, both inside the same transaction. First, close `existing` in
full (same call as Case 4, `closeVolume = existing.volume`). Second,
open a new position for the remainder:

```ts
const remainder = order.volume.sub(existing.volume);
const newPosition = await tx.position.create({
  data: {
    brokerId: order.brokerId, accountId: order.accountId, symbolId: order.symbolId,
    originOrderId: order.id, // this order is now the TRUE origin of a new position
    side: order.side, volume: remainder, openPrice: fillPrice,
    slPrice: order.slPrice, tpPrice: order.tpPrice, bookType,
  },
});
await tx.order.update({ where: { id: order.id }, data: { status: "FILLED", filledPrice: fillPrice, filledAt: new Date(), nettedPositionId: existing.id } });
```

One order ends up with **both** `originOrderId` pointing a brand-new
`Position` at it (satisfying the untouched `@unique` constraint — this
order is that position's one true origin) **and** its own
`nettedPositionId` pointing at the position it just closed. Both fields
coexist on one `Order` row without conflict; this is the intended
shape, not an edge case to special-case away. Commission is charged
once, on the order's **full** volume (`remainder` + the offset portion
together) — commission is a per-lot-traded fee regardless of whether
that volume closed an old position or opened a new one, matching how
every existing fill site already charges it.

Realized PnL for a flip is entirely the Case-4 full-close amount (the
`remainder`'s opening carries no PnL of its own — it's a fresh
position). The combined economics match what an equivalent close-by +
separate-open would produce, using the single real fill price instead
of a synthesized one, since there's only one real trade here.

## 4. Margin/PnL treatment — no new formula needed

This is the payoff of doing the merge/offset **at write time** instead
of computing a net view at read time (the way `netBySymbol` in
`WebTrader.tsx` already does, read-only, for hedging accounts): once
the invariant "a netting account has at most one OPEN position per
symbol" is enforced by construction (§3's branching guarantees it —
every case either merges into, reduces, or fully replaces the single
existing row, never adds a second one), `computeAccountMarginSnapshots`
(`lib/margin.ts:27-72`) and `computePositionPnl`/`positionPnl` need
**zero code changes**. They already iterate positions per-row and sum;
for a netting account there is simply only ever one row per symbol to
sum. Same for `checkAccountPreTradeMargin`, the Terminal dock's
position tables, and every existing report. This is a deliberate design
property, not an oversight — it's why §3's branching logic is worth
getting exactly right, and why no parallel "net-margin" code path needs
to be written, tested, or kept in sync with the real one.

## 5. Mode-switch guard

Both the group-level default and an account-level override are blocked
from changing while open positions exist, avoiding ever needing to
reconcile existing hedged tickets into a net position or split a net
position back into legs:

- **Account-level override change** (`PATCH` on the account, new
  `positionMode` field): reject with a clear error
  (`"cannot change position accounting mode while N position(s) are
  open"`) if `Position.count({ accountId, status: "OPEN" }) > 0`.
- **Group-level default change**: reject if *any* account in the group
  has an open position — `SELECT 1 FROM "Position" WHERE status='OPEN'
  AND "accountId" IN (SELECT id FROM "Account" WHERE "groupId" = $1)
  LIMIT 1`, an existence check, not a full scan or count, so this stays
  cheap even for a large group.

Both checks run inside the same transaction as the update, so a fill
landing in the same instant as an admin's mode-change request can never
race past this guard (the existence check and the write are
atomic together).

## 6. Backoffice UI

- **Group create/edit form**: a "Position Accounting" selector
  (Netting / Hedging), default Hedging, disabled with an inline
  "N accounts have open positions" note when the guard in §5 would
  reject the change (checked live as the admin opens the field, not
  only on submit).
- **Account detail page**: a new "Position Accounting" row showing the
  **resolved** mode plainly (e.g. "Hedging (inherited from group
  Standard)" or "Netting (account override)"), with a control to set an
  explicit override or return to "Inherit from group" — same
  inherit-vs-override UX pattern the pricing engine's own
  `AccountSymbolConfig` editor already uses for per-symbol pricing
  overrides. Same open-position guard as §5, surfaced as a disabled
  control with an explanatory tooltip rather than a silent no-op.
- **Accounts list**: an optional "Mode" column/badge showing the
  resolved value per row — nice-to-have, not required for correctness,
  worth doing in the same pass since the resolver is already a one-line
  call.

Not in scope for this stage: any change to the WebTrader/native-terminal
order ticket UI itself. The server enforces real behavior regardless of
what a client expects or previews; a "this order will reduce/flip/
increase your net FOO position" preview on the ticket is a genuine
future UX improvement but not required for correctness, and is
deliberately deferred out of this design.

## 7. Staged rollout (same discipline as the pricing engine)

1. **Migration only** (§1a). Ships alone, first, with zero behavior
   change for any broker — verified by the migration itself only adding
   nullable/defaulted columns nothing reads yet.
2. **`lib/position-accounting.ts` built and merged inert.** The
   resolver and `fillOrderWithPositionMode` exist, are exhaustively
   unit-tested (every branch in §3, plus explicit property-style
   invariant tests mirroring `close-by.test.ts`'s own "combined PnL is
   price-independent" pattern — e.g. "a netting account never ends up
   with more than one OPEN position per symbol, for any order of same/
   opposite-side fills," "realized PnL summed across a sequence of
   partial offsets equals `computeRealizedPnl` applied to the net
   change directly," decimal-precision edge cases on the weighted-
   average formula) — but **nothing calls it from the 7 real fill
   sites yet**. Same "new function living alongside the old one, no
   caller wired up" shape as `lib/pricing-engine.ts`'s own Stage 2.
3. **Shadow verification — necessarily different from the pricing
   engine's, and worth calling out explicitly.** Pricing's shadow
   compare (`lib/pricing-shadow-compare.ts`) works because pricing is
   *stateless per fill* — old vs. new can be diffed fill-by-fill with a
   pure function. Netting is **path-dependent**: what today's net
   position looks like depends on the account's entire fill history,
   not just the latest fill, so there is no equivalent "diff every
   account once" tool to build. Verification here is instead:
   - The exhaustive unit/integration test suite from Stage 2 (the real
     safety net for the *logic*).
   - A manual dry run on real demo accounts on the QA broker
     (`zzzqa.vyxtrader.com`) once the fill sites are actually wired in
     behind a group set to `NETTING` on that broker only — trade every
     branch in §3 by hand (same-side add, all three opposite-side
     cases, a flip, a race by firing two orders back-to-back) and
     verify the resulting position/order/ledger rows against the
     expected math from this doc, the same way the STM/chart/settings
     batches in this session were each live-verified against the real
     QA account before being called done.
   - Only after that: wire the 7 fill sites to call
     `fillOrderWithPositionMode` instead of `openPositionFromOrder`
     directly. Because `positionMode` resolves to `HEDGING` for every
     group/account that hasn't been explicitly switched (§1a), this
     wiring is itself safe to deploy broker-wide immediately —
     no broker is affected until an admin deliberately sets a group or
     account to `NETTING` through the new UI in §6, which won't exist
     for anyone to use until this stage ships anyway.
4. **Enablement is inherently per-group/per-account already** — unlike
   the pricing engine, this feature needs no separate
   `Broker.positionAccountingEnabled`-style flag layered on top. The
   `positionMode` field *is* the flag: every broker's every group
   defaults to `HEDGING` (§1a), so adoption is naturally gradual and
   opt-in, group by group or account by account, the moment the
   backoffice UI in §6 ships.

## 8. Open questions for review (not resolved by this doc)

- Same-side merge's SL/TP-replacement rule (§3, Case 2) is a real UX
  choice with no existing precedent in this codebase to defer to —
  confirm "latest order's SL/TP wins, null leaves it alone" is the
  intended behavior before Stage 2 implementation.
- The flat-symbol first-fill race (§3, under Case 1) is flagged but not
  definitively solved — needs a concrete concurrent-fill test in Stage
  2 to decide whether the existing `idempotencyKey` uniqueness is
  sufficient or an advisory lock is actually required.
- Whether `Position.bookType`/LP-hedge accounting for a netting
  account's merged/flipped position needs any special handling beyond
  "resolved once, at creation, same as today" — not researched in this
  pass; worth a dedicated look before Stage 2 if any broker on this
  platform runs real A-book/LP hedging (today's LP flow is
  record-keeping only per `Position.bookType`'s own schema comment, so
  likely no-op, but should be confirmed rather than assumed).
