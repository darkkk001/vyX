# Order rate limit, per account (design, 2026-10-23)

Status: **applied on this branch (owner go 2026-10-23), no bot exemption.** Web route only; the VPS gateway follows (phase 2).

## Why

`POST /api/trade/orders` has no rate limit (security re-audit 2026-10-23, `docs/PENTEST-2026-10-23.md`). One signed-in
client can send orders as fast as the network allows. Each one takes an account lock and a margin check. A refusal also
writes a trace row; that trace is now capped at 60 per minute. The cap below protects the platform and the other
accounts on the same broker. It must never stop a legitimate bot, including our own back-test bots.

## What real traffic looks like (live DB, last 30 days, read-only)

| per account, peak | orders |
|---|---|
| in 1 second | 25 |
| in 10 seconds | 67 |
| in 1 minute | 90 (p99 of busy minutes: 57) |
| in 1 hour | 181 |

The busiest accounts are Futurix desktop terminals (`DESKTOP_NATIVE`). Bot tenants (zzshadowbot, zzzqa) peak at 5 per second.

## Rule

A token bucket per account, held in Redis and updated atomically in one Lua call:

- **Burst** = bucket size: how many orders may arrive back to back. **Default 100.**
- **Sustained** = refill rate: how many orders per minute may keep coming forever. **Default 600 per minute (10 per second).**

Against the measured peaks, the burst allows 4x the busiest second and the sustained rate is 6.7x the busiest minute. A
back-test bot that sends one order every 100 ms never touches the cap.

What counts as one order request:
- Every `POST /api/trade/orders`, accepted or refused. A request that is turned away by the cap does not consume a token.
- A retry with an `idempotencyKey` already answered is free, so a client retrying after a timeout cannot lock itself out.
- Close-all, close-by and bulk modify count as one request each. They are separate routes and stay uncapped in this
  phase; the order route is the one an attacker can call in a loop to open positions.

## Configuration

Two new nullable columns on `Broker`: `orderBurst Int?` and `orderPerMinute Int?`.
- Null means the platform default (100 / 600).
- `0` on either column turns the cap off for that broker, for a broker whose bots need more.
- Set by Super Admin only, on the broker's settings page. Broker staff do not see infrastructure limits (standing rule).

Optional, if the owner wants it: a per-account override (`Account.orderRateExempt Boolean @default(false)`) for a named
bot account. Without it, the broker-level setting is the only knob.

The migration is additive (two nullable columns), so it goes first and causes no 503s, same as the last two windows.

## Refusal

- HTTP 429 with `Retry-After` set to the seconds until one token is back (at least 1).
- Body: `{ "error": "Too many orders in a short time. Wait a moment and try again.", "code": "ORDER_RATE_LIMITED", "retryAfterSeconds": n }`.
- The terminal, mobile app and WebTrader already show `error` where the trader clicked (no silent refusals).
- One RejectedOrder row per throttled episode, at the first refusal, not one per request, reason "rate limited". That way
  the dealer's FEED shows that an account hit the cap without being flooded by it.

## Failure behaviour

If Redis cannot be reached, the order is **allowed** and the failure is logged. Trading must not stop because the
limiter's store is down. The account lock and margin check still apply.

## Second entry point

The VPS gateway also takes trader orders (`services/api-gateway/src/routes/orders.ts`, `POST /v1/orders` and the pending
route). Phase 2 gives it the same bucket logic against the VPS Redis, with the same defaults and the same 429 body.
Both entry points would then be capped separately, so an account using both at once gets up to twice the allowance.
That is acceptable for a protection limit.

## Tests (written with the change)

- 100 back to back are accepted; the 101st gets 429 with `Retry-After`; after the refill time orders are accepted again.
- A steady 10 per second for 2 minutes is never refused.
- A retry with the same `idempotencyKey` is free.
- Broker setting 0 disables the cap; per-broker values override the defaults.
- Redis down: the order is accepted.
- One account at the cap does not affect another account on the same broker.
- No session: 401 before the limiter is touched.
