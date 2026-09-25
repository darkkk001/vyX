# Hedged margin (MT5 style): broker guide

Backoffice → **Symbols** → column **HEDGED MARGIN %**, set per symbol.

When a client holds a BUY and a SELL on the same symbol, the offsetting volume is "hedged": its risk largely cancels.
The setting says how much margin a fully hedged lot **pair** (1 BUY + 1 SELL) uses, as a % of **one** lot's full margin.
Only the hedged volume is reduced; any extra volume on one side always pays full margin.

| Setting | A hedged 1+1 lot pair uses | Notes |
|---|---|---|
| **200** (default) | both legs in full (2 lots of margin) | The behavior before hedged margin existed. Nothing changes until you set it. |
| **100** | one lot (only the larger side) | Common for metals / CFDs ("larger leg"). |
| **50** | half a lot | The usual MT5 setting for FX. |
| **0 to 49** | less than half a lot, down to nothing | Needs an explicit confirmation. See the risks below. |

**What the setting changes:** margin, free margin and margin level, the same way everywhere. That covers the web risk
monitor (margin call / stop-out), the pre-trade check, the Rust engine, WebTrader, the trader terminal and the
backoffice Margin / Risk screens.

**Opening a hedge:** an order that does not increase the used margin (it hedges an open position at a setting below
200) is always allowed, even when the account is already at a low level.

## Below 50 %: two risks you must accept explicitly

The backoffice refuses a value below 50 until you confirm it in a warning dialog. The API refuses it too, unless the
request carries `confirmBelowFloor: true`. The confirmation is recorded in the audit log.

1. **At 0 %, a fully hedged account is never stopped out.** Its used margin is 0, so it has no margin level, and a
   stop-out needs one. Its equity can drift negative (the spread, swaps, commission) and nothing closes it. It cannot
   open new trades, and negative-balance protection applies when it is closed. MT5 behaves the same way. The broker
   carries the loss risk.
2. **A stop-out can cascade.** The stop-out closes the **largest loss** first (the MT5 rule). If that position is one
   leg of a hedge, closing it **unhedges** the book, the used margin jumps, and further positions can be stopped out
   one after another. Example (0 %): BUY 1 + SELL 1 + BUY 1 with the SELL as the largest loss. Closing the SELL
   unhedges the two BUYs and both follow. Both the web and the engine are tested to behave identically here (parity
   scenario 26).

If you are unsure, stay at **50 % or above**.
