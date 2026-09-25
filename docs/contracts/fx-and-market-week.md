# FX conversion + weekly close: one contract for server, web trader and terminal (2026-09-26)

Closes the 5 deferred FX money lines in docs/audit/2026-09-24/issues.md (term-account, chart, marketwatch,
term-positions, shell).

## 1. Quote → account conversion (the server's rule, lib/fx.ts)
Every money figure computed from a price comes out in the symbol's **quote currency**: P/L, margin, point value and
the margin a new order needs. Multiply it by `rate = conversionRate(quote, account)`, applied in this order:
1. quote = account currency: **1**, and no price is read;
2. the pair `QUOTE+ACCOUNT` (e.g. `GBPUSD` for GBP→USD): its **mid** = (bid + ask) / 2;
3. the inverse pair `ACCOUNT+QUOTE` (e.g. `USDJPY` for JPY→USD): **1 / mid**;
4. neither, and neither currency is USD: cross through USD, i.e. rate(QUOTE→USD) × rate(USD→ACCOUNT), each leg by
   steps 2–3;
5. still nothing: **no rate**. The position is *unpriced*: P/L, margin and point value show "–", and it is left out
   of equity and used margin (the server's risk path does the same).

A conversion quote whose tick is **72 h old or older** counts as no quote (`FX_RATE_MAX_AGE_MS`). That covers a
normal weekend and never uses a days-old rate.

Formulas, all × rate:
- P/L = (BUY: bid − open; SELL: open − ask) × contractSize × volume
- Margin (open position) = volume × contractSize × closing-side price / leverage
- Margin needed (ticket) = volume × contractSize × fill price (BUY ask, SELL bid) / leverage
- Point value = volume × contractSize × 10^−digits
- Account:
  - equity = balance + credit + Σ P/L;
  - used margin = the hedged sum (lib/margin.ts hedgedUsedMargin, per-symbol hedged %);
  - free margin = equity − used;
  - margin level = equity / used × 100 ("–" when used = 0).

## 2. Where the clients get the conversion quotes
The conversion pairs are often not symbols the broker offers, so they are not on the client's price stream. The
server sends them:
- `GET /api/trade/symbols`: each symbol gains `quoteCurrency` and `baseCurrency`.
- `GET /api/trade/me`: `currency` (already there) is the account currency.
- `GET /api/trade/prices` gains `fx`:
  ```json
  { "accountCurrency": "USD",
    "quotes": [ { "symbol": "USDJPY", "bid": "150.000", "ask": "150.020", "tickAt": "2026-09-26T..." } ],
    "rates": { "JPY": "0.00666622", "GBP": "1.3001", "USD": "1" } }
  ```
  - `quotes` holds every pair §1 may read for the quote currencies of the broker's enabled symbols, already filtered
    to the 72 h limit.
  - `rates` holds the server's own rate per quote currency at that moment, so a client can check itself. A currency
    with no rate is absent.
- The client recomputes the rate with §1 on every tick. It uses the live stream tick when the conversion pair is
  streamed; otherwise the `fx.quotes` row. That row is refreshed with the prices re-read (30 s) and on every
  ConfigChanged.

## 3. The shared test vectors
- `docs/contracts/fx-vectors.json` is generated from the server's own functions by
  `scripts/contracts/gen-fx-vectors.ts`. Never edit it by hand.
  - `cases`: one position's rate, P/L, margin, point value and new-order margin.
  - `accounts`: equity, used / free margin and margin level, including a hedged pair and an unpriced position.
- `docs/contracts/market-week-vectors.json`: UTC instants and whether the weekly close is in force.
- Pinned by:
  - web/server: `lib/fx-contract.test.ts` recomputes the file from the server functions, and the web trader's
    client math must reproduce it;
  - engine: gap_fill tests read the market-week file;
  - terminal: `tests/Vyx.Shared.Tests` FxContractTests + MarketWeekContractTests, on byte-identical copies of both
    files. A test compares them with the D: copies when that checkout is present.
- Tolerance: relative 1e-9; money 1e-6 absolute.

## 4. Weekly close / reopen: one rule
Markets that are not traded around the clock close **Friday 17:00 America/New_York** and reopen **Sunday 17:00
America/New_York**. That is 21:00 UTC under US daylight saving time (2nd Sunday of March 07:00 UTC → 1st Sunday of
November 06:00 UTC) and 22:00 UTC otherwise.
- Crypto is never closed by this rule.
- A broker's own TradingSession rows still win where they exist.
- The metals daily break (17:00 NY, Mon–Thu) is a separate rule on the same anchor.
- Implementations:
  - engine `gap_fill.rs market_closed` (already this rule);
  - web `lib/market-week.ts`, used by `lib/risk.ts` (default session) and `lib/market-simulator.ts` (candles);
  - terminal `MarketSchedule` / `CandleSeries.IsFxWeekend`.
