# D4 + slippage batch: live preview (read-only)

Run 2026-09-30 against **ep-morning-glade** with `SET default_transaction_read_only = on`, via psql (the URL was read
from `.env.live` and never printed). SQL: `deploy/d4-slippage-preview.sql` (sections below match its numbers).

## Summary

- **D4 changes no effective price, commission, swap rate or swap-free for any live account.**
  - I checked 368 (typed account × enabled symbol) pairs on 30 typed accounts: 0 spread, 0 commission, 0 swap-rate
    and 0 swap-free changes. 3 of those pairs hold open positions; their swap from tonight and the commission on
    their next fills are unchanged.
  - Why: no account type anywhere carries a spread, commission or swap value, and there are 0 per-symbol type rows.
    The only non-null type field is `swapFree = false` (acmefx, novamarkets, zzzqa types), and every account on those
    types has its own `swapFree = false`, so the type level never decided anything.
  - No account's client-facing pricing gets better or worse.
- **Slippage: 0 brokers store a cap** (`defaultMaxSlippagePips` is NULL for all 5). The data step writes 0 rows today.
  The conversion is exact for every live symbol: the smallest digits value in use is 1, so 1 pip = 10 points
  everywhere.
- **Applications:** 0 live-account applications carry a requested type.

## 1. Brokers and slippage caps

| Broker | Pricing engine | Cap (pips) | Cap (points) after |
|---|---|---|---|
| acmefx | on | none | none |
| futurixglobal | on | none | none |
| novamarkets | on | none | none |
| zzshadowbot | on | none | none |
| zzzqa | on | none | none |

## 2. Pip to point factor, per symbol class (live symbols)

| Class | Digits | Points per pip | Symbols |
|---|---|---|---|
| Commodities | 3 | 10 | SpotBrent, SpotCrude |
| Crypto | 1 | 10 | BTCUSD, vIDX |
| Crypto | 2 | 10 | ETHUSD, SOLUSD, vGOLD |
| Crypto | 3 | 10 | vJPY |
| Crypto | 4 | 10 | XRPUSD |
| Crypto | 5 | 10 | vEUR, vGBP |
| Forex | 3 | 10 | AUDJPY, CADJPY, CHFJPY, EURJPY, GBPJPY, USDJPY |
| Forex | 5 | 10 | AUDUSD, EURCHF, EURGBP, EURUSD, GBPUSD, NZDUSD, USDCAD, USDCHF |
| Indices | 1 | 10 | GER40, JPN225, NAS100, UK100, US30, US500 |
| Metals | 2 | 10 | XAUEUR, XAUUSD, XPTUSD |
| Metals | 3 | 10 | XAGUSD |

- Rule: the server's pip is 10^-(digits-1), floored at 1 for a 0-digit symbol (`lib/group-pricing.ts pipSize`). A
  point is 10^-digits.
- So one pip is 10 points for digits ≥ 1, and 1 point for digits = 0.
- No live symbol has 0 digits, so the broker-wide x10 is exact. The data step refuses to run if one ever appears.

## 3. Account types today

| Broker | Type | Enabled | Spread | Commission | Swap L | Swap S | Swap-free | Accounts | Per-symbol rows |
|---|---|---|---|---|---|---|---|---|---|
| acmefx | Pro / Standard / Zero | yes | – | – | – | – | false | 0 / 10 / 0 | 0 |
| futurixglobal | ECN / Pro / Standard / Zero | yes / no / yes / yes | – | – | – | – | – (inherit) | 0 / 0 / 16 / 0 | 0 |
| novamarkets | Pro / Standard / Zero | yes | – | – | – | – | false | 0 / 1 / 0 | 0 |
| zzzqa | Pro / Smoke Test / Standard / Zero | yes | – | – | – | – | false | 0 / 0 / 2 / 1 | 0 |

("–" = NULL, inherit.)

## 4. Effective values, before vs after, for every typed account and enabled symbol

| Pairs checked | Spread changes | Commission changes | Swap-rate changes | Swap-free changes | Pairs with open positions |
|---|---|---|---|---|---|
| 368 | 0 | 0 | 0 | 0 | 3 |

- 4b, the rows that differ: none.
- The 14 accounts on a type with `swapFree = false` all have `Account.swapFree = false` themselves, so they were and
  stay not swap-free:
  - acmefx: 10, of which 50005679 has 15 open positions;
  - novamarkets: 50005678;
  - zzzqa: 00090001, 00090002, 50005705.

## 5. Typed accounts per broker

| Broker | With a type | Accounts |
|---|---|---|
| acmefx | 10 | 10 |
| futurixglobal | 16 | 17 |
| novamarkets | 1 | 1 |
| zzshadowbot | 0 | 14 |
| zzzqa | 3 | 3 |

## 6. Live-account applications with a requested type

None, in any status.

## 7. Slippage data step

0 of 5 brokers have a cap, so the backfill converts 0 rows today (it still runs, with its guards, to prove it).
