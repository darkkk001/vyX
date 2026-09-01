# Reverse Mirror

Spec: `docs/briefs/VYX-MIRROR-V0-BRIEF.md`. v0, shipped on `feat/reverse-mirror-v0`.

## What it does

A `MirrorRule` says "trades from this group or account are mirrored onto
this target account." REVERSE (the default) flips BUY↔SELL; SAME copies
the side as-is. `multiplier` scales lot size; `symbolFilter` restricts
which symbols mirror; `maxOpenLots`/`maxDailyLoss` are per-rule kill-switch
caps on the target account.

## Where it hooks in (v0)

`lib/mirror.ts` exports `onFill(db, source)` (plus the `onFillPosition(db,
position, symbolName)` convenience wrapper most call sites use) and
`onClose(db, closeEvent)`. A first pass only wired two of these; a real
dealer-accept fill going unmirrored with zero trace (no `MirrorLink`, no
`MIRROR_FAILED`) showed that every place a Position is opened or closed on
the legacy Next.js path needs the hook, not just the two most obvious ones.
Current call sites, all after their own transaction commits, all
`.catch()`-wrapped:

**Fill (`onFill`/`onFillPosition`)**
- `app/api/trade/orders/route.ts` — the direct MARKET fill branch, *and*
  the separate Smart Dealer auto-accept branch (a different code path in
  the same file that returns before ever reaching the first one).
- `app/api/manage/dealing-queue/[id]/route.ts` — a human dealer's ACCEPT.
- `app/api/trade/orders/[id]/requote-response/route.ts` — a client
  accepting a dealer's requoted price.
- `app/api/trade/orders/[id]/fill/route.ts` — a resting LIMIT/STOP order's
  trigger firing.
- `app/api/manage/positions/route.ts` — a dealing desk's manual open
  ("execute for client").
- `app/api/manage/positions/[id]/reverse/route.ts` — the new leg an admin
  reverse opens.

**Close (`onClose`)**
- `app/api/trade/positions/[id]/close/route.ts` — the trader's own close
  (full or partial). "Close all" is client-side N calls to this same
  route, so it's covered for free.
- `lib/risk-monitor.ts` — both the SL/TP pass and the stop-out pass.
- `app/api/manage/positions/[id]/close/route.ts` — a dealer-initiated
  close.
- `app/api/manage/positions/[id]/reverse/route.ts` — the closed leg of an
  admin reverse (called before the new leg's `onFill`, matching real
  event order).
- `app/api/manage/positions/[id]/void/route.ts` — not in the original
  brief, but a real corollary: voiding a manually-opened position that had
  already been mirrored must close that mirror too, or it sits open
  forever against a source that no longer exists.

A mirror failure (margin, market closed, kill switch) can never roll back
or delay-block the client's own trade — the brief's own explicit
requirement. `onFill` is also `await`ed (not fire-and-forget) at every
site, so it does add bounded latency to the response (a handful of
Postgres round trips, no external calls) even though it can never fail the
trade itself.

If a matching rule exists but is currently disabled (manually, or by its
own kill switch), `onFill` logs a `MIRROR_SKIPPED_RULE_DISABLED` audit row
instead of doing nothing silently — "no `MirrorLink` and no `MIRROR_FAILED`
row" used to be ambiguous between "nothing matched" and "something matched
but didn't fire."

`lib/mirror.test.ts`'s "wiring audit" describe block statically greps every
file above for its expected hook call and fails if one goes missing — the
cheapest real regression guard against this exact class of bug recurring,
short of a full HTTP-level test harness (which this repo doesn't have for
any route today).

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

## Prerequisite: the source group must actually auto-fill

A mirror strategy depends on the source's own fill happening instantly --
if the source order sits in the manual dealing queue, nothing has been
mirrored yet by the time a dealer eventually accepts it. Three existing
settings can route a group's orders to the queue: `Broker.dealingModeAt`
(Manager → Risk → "Dealing mode"), `Group.forceDealingMode` (Manager →
Client Groups → "Dealing" checkbox), and `Group.groupType === "DEALING"`
(Manager → Client Groups → "Type" dropdown -- **DEALING is every new
group's default**, so a freshly-created source group is queued by default
unless this is addressed).

`Group.dealingMode` (`INHERIT` default / `AUTO` / `MANUAL`, Manager →
Client Groups → "Dealing override" column, see
`lib/dealing-routing.ts`'s `resolveWantsDealingQueue`) exists specifically
to break the coupling between "correctly classified as DEALING for book
accounting" and "requires manual review" -- set a mirror source group's
override to `AUTO` to guarantee instant fills regardless of the other
three settings, without having to misclassify its book type as `LP` just
to dodge the queue. AUTO still goes through the ordinary margin gate and
fills at the real server price -- it only skips the manual-review step.

## Known v0 limitations (by design, not oversight)

- LP destination, chained/follower copiers, per-trade SL/TP mirroring, and
  equity-proportional sizing are explicitly out of scope (brief's own list).
- The kill switch checks a fresh DB read before every fill/close rather
  than a cached rule (acceptable at v0's trade volume, per the brief).
- `sourceId` is a polymorphic string (`Group.id` or `Account.id` depending
  on `sourceType`), not a DB-level FK — same convention as this schema's
  existing `AuditLog.entityId`/`Notification.entityId`.
