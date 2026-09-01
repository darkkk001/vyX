# Reverse Mirror

Spec: `docs/briefs/VYX-MIRROR-V0-BRIEF.md`. v0, shipped on `feat/reverse-mirror-v0`.

## What it does

A `MirrorRule` says "trades from this group or account are mirrored onto
this target account." REVERSE (the default) flips BUY↔SELL; SAME copies
the side as-is. `multiplier` scales lot size; `symbolFilter` restricts
which symbols mirror; `maxOpenLots`/`maxDailyLoss` are per-rule kill-switch
caps on the target account.

## Where it hooks in (v0)

`lib/mirror.ts` exports `onFill(db, source)` and `onClose(db, closeEvent)`.
Both are called from the two places a trade currently changes state on the
legacy Next.js order path:

- `app/api/trade/orders/route.ts` — after a MARKET order's own fill
  transaction commits, `onFill` runs against the position just opened.
- `app/api/trade/positions/[id]/close/route.ts` — after a close (full or
  partial) commits, `onClose` runs against the volume just closed.

Both calls happen **after** the client's own transaction has committed, in
their own separate transaction, wrapped in `.catch()` at the call site. A
mirror failure (margin, market closed, kill switch) can never roll back or
delay the client's own trade — the brief's own explicit requirement.

Matching, rounding, caps, and the DB writes themselves reuse the same
primitives every other fill/close path in this app uses —
`openPositionFromOrder` (`lib/dealing.ts`) and `closePositionInTx`
(`lib/position-close.ts`) — so a mirrored position is indistinguishable
from a manually-opened one everywhere else in the schema (margin, P/L,
ledger, audit).

## Phase 3

The schema (`MirrorRule`, `MirrorLink`), the backoffice UI, the audit
trail, and the risk/kill-switch logic are all meant to survive unchanged
once execution moves to the Rust engine. The only throwaway part is the
hook *call site* — `onFill`/`onClose`'s two callers above get replaced by
subscribers on the engine's own fill/close events (NATS), calling the
exact same `onFill`/`onClose` functions with the same `MirrorSourcePosition`/
`MirrorSourceClose` shapes. Nothing inside `lib/mirror.ts` needs to change
for that cutover.

## Known v0 limitations (by design, not oversight)

- LP destination, chained/follower copiers, per-trade SL/TP mirroring, and
  equity-proportional sizing are explicitly out of scope (brief's own list).
- The kill switch checks a fresh DB read before every fill/close rather
  than a cached rule (acceptable at v0's trade volume, per the brief).
- `sourceId` is a polymorphic string (`Group.id` or `Account.id` depending
  on `sourceType`), not a DB-level FK — same convention as this schema's
  existing `AuditLog.entityId`/`Notification.entityId`.
