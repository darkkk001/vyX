# Execution

## 1. Today

`app/api/trade/orders/route.ts` fills MARKET orders immediately, at
whatever price the client sent in the request body (`filledPrice: price`,
`status: "FILLED"`, in the same request that created the order). There is
no server-side price check against `LivePrice`, no slippage, no requote,
no partial fill, no dealing-desk step of any kind — this is a documented
MVP simplification, not a hidden bug. It works because there is currently
no real liquidity to route to; a broker demo account trading against a
simulated/EA-fed price is its own counterparty in every sense today.

## 2. Target: the Rust Execution module

Sits at OMS's `ROUTING` state (see `trading-engine.md` §2). Its job:
given an accepted order, produce a fill price and quantity (possibly
partial), using the current best bid/ask from the Market Data Core —
never the client-supplied price.

### 2.1 Execution model (Phase 2 default: internalized/B-book)

Matches the current business reality — broker is the counterparty, no
external LP connectivity exists yet:

1. Read current bid/ask for the order's symbol from Market Data Core
   (in-process call or NATS request, not a Postgres read — market data is
   the Market Data Core's domain, per `market-data.md`).
2. MARKET BUY fills at ask, MARKET SELL fills at bid, at the size
   requested, in one fill — no partial fills, no slippage model — for
   Phase 2. Full-fill and partial-fill *support* in the module's data
   model regardless, so LIMIT/STOP-triggered fills and any future
   external-LP routing don't need a schema change later.
3. LIMIT/STOP orders sit in `ACCEPTED` until the Market Data Core's
   tick stream crosses the trigger price, at which point Execution treats
   it exactly like a newly-routed MARKET order at that moment's price.

### 2.2 External LP routing (explicitly out of scope for Phase 2)

The institutional multi-venue LP/FIX routing prompt the user separately
flagged (paused, not part of this engagement per the user's own "wait,
VyXTrader ka bhejta hu") would live here as a second execution strategy
behind the same module interface — `ExecutionStrategy::Internal` vs
`ExecutionStrategy::Aggregated(venues)`. Not designed further in this
doc; noted only so the module boundary doesn't have to be redrawn if that
work starts later.

### 2.3 Module API

- `Execute(order) -> Fill { price, volume, remaining_volume }` — called
  once by OMS per routing attempt; OMS handles the partial-fill/re-route
  loop, Execution just executes what it's given.
- No independent state of its own beyond in-flight order tracking for
  timeout/retry — Execution does not own a Postgres table; every result
  it produces is written by OMS to `orders`/`positions` in the same
  transaction as the state transition.

## 3. Ownership boundary

Execution is stateless from Postgres's point of view (per ADR-002 — OMS
is the sole `orders`/`positions` writer). It only reads live prices from
the Market Data Core.

## 4. Open questions for Phase 2

- Slippage/requote modeling for MARKET orders during fast price moves —
  the current system has zero precedent for this (it doesn't check the
  price at all today), so this is new design, not a migration.
- Commission/swap application point — currently computed client-side at
  order time in the existing UI math (`lib/trading.ts` `computeRealizedPnl`);
  needs to move server-side into Execution or OMS as part of Phase 2, not
  assumed to already be correct.

## 5. Implementation status

**§2.1 step 1 (read current bid/ask from Market Data Core, not a
caller-supplied price) — done.** `place_market_order`
(`engine/order-management/src/lib.rs`) fetches the tick itself via
`market_data::db::get_live_price(pool, &req.symbol)` — a direct Postgres
read against `"LivePrice"` (same table Market Data Core writes, per
`market-data.md` §3; reading another module's table read-only isn't an
ADR-002 boundary violation, only writing it would be, same reasoning
already established for reading `Account`). `PlaceMarketOrderRequest` no
longer has a `current_tick` field at all — it was removed, not just
ignored, so the "don't trust a caller-supplied price" rule can't
regress by someone re-populating it. `services/api-gateway/src/routes/
orders.ts` correspondingly stopped fetching and forwarding a `LivePrice`
row for this purpose (`getLivePrice` was dead-code'd out of
`services/api-gateway/src/db.ts` too, since that was its only caller);
the Gateway previously already read the real Postgres value rather than
trusting the browser, so this wasn't a live exploit — the point of the
change is one fewer hop between "the price OMS fills at" and what Market
Data Core actually has, closing a staleness window, and matching this
doc's own target architecture instead of half-implementing it.

No live price for the order's symbol is now a first-class rejection
("no live price for {symbol}"), going through the exact same
insert-order-then-reject path as a risk rejection — not a 500, not a
silent fallback.

Verified live end to end (seeded broker/account/symbol/price against a
real Postgres): a BUY filled at exactly the seeded ask with no price in
the request payload at all; a known symbol with no `LivePrice` row
rejected cleanly with the reason above; the pre-existing free-margin
rejection still fires correctly now that it runs after the price fetch
instead of before.

Still open: slippage/requote modeling, commission/swap moving
server-side, and LIMIT/STOP trigger logic (§2.1 step 3) — none of these
are touched by the above, all still exactly as described in §4.
