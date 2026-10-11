# Batch 5 real-time contract (web / gateway ↔ native apps)

Rule: any backoffice change reaches every open client within ~1 s, no restart, no re-login. The quote a trader sees equals the fill price.

## Events (NATS → gateway → WebSocket)
| Event (JSON `type`) | NATS subject | Payload | Trader stream | Admin stream |
|---|---|---|---|---|
| `ConfigChanged` (new) | `config.changed` | `{ type, broker_id, scope, symbol?, group_id? }` -- NO account_id: broker-wide | forwarded to EVERY trader socket of `broker_id` | forwarded to the broker's backoffice sockets |
| `MarginCall` (new) | `margin.call` | `{ type, account_id, broker_id, level, state: "margin_call" \| "stop_out" \| "cleared" }` | that account | the broker |
| `AccountUpdated` (existing) | `account.updated` | `{ type, account_id, broker_id, reason? }` | that account | the broker |
| `BalanceChanged` (existing) | `account.balance` | `{ type, account_id, broker_id, transaction_id }` | that account | the broker |
| `PositionModified` (existing, now also on admin SL/TP edits) | `position.modified` | `{ type, position_id, account_id, broker_id }` | that account | the broker |

`scope` values of ConfigChanged: `symbols` (enable/disable, lots, trading mode, stop level, hedged margin %, max exposure), `pricing` (markup / target spread / commission / swap at any level), `sessions` (trading hours), `risk` (broker trading halt / close-only / limits / max slippage), `groups` (group halt / close-only / leverage / settings), `dealing` (desk mode / auto-hedge), `mirror`, `payments`, `permissions`, `settings`, `kyc`.

## What each app does
**Terminal** (trading stream):
- `ConfigChanged` with scope in {symbols, pricing, sessions, risk, groups, settings}: re-fetch `/api/trade/symbols` (incl. trading sessions), `/api/trade/prices` (the spread rule, below) and `/api/trade/me` (trading state), re-apply to the ticket, Market Watch, chart and account panel. Debounce ~250 ms (a bulk edit can send several).
- `MarginCall`: refresh the account panel now and show the state.
- Safety net: re-read `/api/trade/prices` every 30 s even without events.
**Backoffice** (admin stream, `Vyx.Shared/Api/AdminEventStreamClient.cs` family mapping):
- `BalanceChanged` → family `account` (was `balancechanged`, matched no screen).
- `ConfigChanged` → family `config`; screens GRP, SYM, ATY, EMG, PSP, MIR, USR, CFG, RISK, DEAL, EXP, DASH add `config` to `LiveTopics`.
- `MarginCall` → family `margin` (RISK, MRG, DASH, EXP already list it).

## Quote = fill (`GET /api/trade/prices`, per symbol row)
- existing: `bid`, `ask` (raw), `askMarkup` (price units, the markup in force now), `marketClosed`
- new: `spreadRule`: `"markup"` | `"target"`; `targetSpread` (price units, string; only when `spreadRule = "target"`)
- displayed / traded BUY price: `markup` → `ask + askMarkup`; `target` → `max(ask, bid + targetSpread)` (= the fill: markup = max(0, target − live raw spread), lib/pricing-engine.ts resolveEffectiveSpreadMarkup). SELL = raw `bid` (no markup on the sell side). Applied on every tick.
- shared test vectors (web vitest and C# must agree):
  - markup: bid 4456.35, ask 4456.53, askMarkup 0.20 → buy 4456.73, spread 38 points (2 digits)
  - target, raw spread below target: bid 4456.35, ask 4456.53, target 0.30 → buy 4456.65, spread 30 points
  - target, raw spread above target: bid 4456.35, ask 4456.80, target 0.30 → buy 4456.80, spread 45 points

## `GET /api/trade/me` additions
- `tradingState`: `"open"` | `"close_only"` | `"halted"` (broker or the account's group; halted wins).
