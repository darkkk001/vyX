# Negative-balance protection on the last close + margin-call hysteresis

Owner request 2026-10-23, after account 50005696 (Futurix) on 2026-10-22: 14 NEGATIVE_BALANCE_PROTECTION write-offs
($530.71) between 19:00:39 and 20:21:42, each on one losing close, while 18 other positions stayed open (they still
are). No production data changes: the 50005696 write-offs stay as they are.

## 1. NBP runs once, when the account has no open position left

### Rule

A close books its realized P&L as today (credit Model A unchanged: a loss beyond the balance is paid from credit
first). Then:

- positions still OPEN on the account after this close -> the balance may stay **negative**. No write-off.
- this close leaves **zero** OPEN positions and the balance (after credit) is < 0 and `Broker.negativeBalanceProtection`
  -> ONE write-off of `-balance`, balance = 0. Same NEGATIVE_BALANCE_PROTECTION Transaction + AuditLog row shapes as
  today, `referenceId` = the position whose close emptied the account; the note and `writeOffAmount` now cover the
  whole accumulated deficit, not one close's loss.

Equity (balance + credit + floating) is what stop-out acts on, so a negative balance with positions open is just the
MT5 state "equity still decides". The stop-out loop keeps closing while the level is at or below the stop-out level;
when it closes the last position, that close is the one that writes off.

### Where (one place per implementation, so every path follows)

Every close in the system goes through one of three functions; the rule lives there, nowhere else:

| implementation | function | callers covered |
|---|---|---|
| engine (live) | `book.rs` `close_position_full` (via `close_money`) | stop-out loop, SL/TP, every engine close |
| web | `lib/position-close.ts` `closePositionInTx` | client close, bulk close, close-by (both legs), queued close, dealer/admin close, reverse, mirror, coverage, demo sweep, web risk monitor |
| engine shadow | `monitor.rs` shadow branch (via `close_money`) | Stage 5 shadow simulation |

`close_money` gains one input, `open_after: usize` (positions still open on the account after this close). NBP applies
only when `open_after == 0`. The live paths count `status = 'OPEN'` positions of the account in the same transaction,
AFTER the closing UPDATE and AFTER the account row is locked `FOR UPDATE`. Two concurrent closes of an account's last
two positions serialize on that lock: the first sees the other still open (no write-off), the second sees zero
(write-off). The shadow counts its in-memory `state.positions` minus the one it closes.

### Edge cases (decided, listed so they are visible)

- **Partial close**: the position stays OPEN -> no write-off.
- **Close-by**: two closes in one transaction; the second leg sees the first closed -> one write-off at most.
- **A new position opens while the last one closes**: the open does not take the account lock before the close counts,
  so the close may write off with a brand-new position open. The same can happen today; MT5 behaves alike. Not changed.
- **Accounts that end with zero positions and a negative balance without a close** (a VOID/DELETE of an open position,
  an admin debit): not reached by this rule; nothing writes off today either. Out of scope, listed for the owner.
- **Pre-trade margin gate** (`lib/margin.ts`) already uses balance + credit + floating, so a negative balance with
  positions open is refused new orders exactly when free margin is not positive.
- **Withdrawals / transfers out** are already refused below a zero balance.

### Shared fixture: the 50005696 sequence

`tests/fixtures/nbp-50005696-2026-10-22.json`: the real ledger sequence from 19:00:33 to 20:21:42 (15 stop-outs, 7
commissions, 7 bulk closes, balance 487.35 at the start, credit 0, NBP on), with the 18 positions that stayed open, plus
ONE final synthetic step that closes those 18 (that is the only way the sequence can end with no position open).
Consumed by:

- `engine/order-management/src/book.rs` unit test (pure `close_money` replay),
- `engine/order-management/tests/nbp_replay_db.rs` (real `close_position_full` against the scratch DB),
- `lib/nbp-replay.test.ts` (real `closePositionInTx` against the scratch DB).

Each asserts: zero NBP rows before the last close, the balance below zero in between, **exactly one** NBP row at the
end, for the full deficit, balance 0 after it. The parity scenarios that encode the old per-close floor (10, 20) get
their expected outputs updated and a new scenario covers "loss with others still open".

## 2. Orders on a zero balance (investigated, no change)

The 20:17-20:18 orders (7 XAUUSD BUYs, source MOBILE, web route `app/api/trade/orders`) passed the web pre-trade gate
`lib/margin.ts` `evaluatePreTradeMargin` / `checkPreTradeMargin`: equity = balance + credit + floating P&L of every open
position at live prices, projected level = equity / (used margin + this order's margin) must stay above the group's
margin-call level (100%). The 18 small positions carried floating profit: the margin-call-over notification at 19:36:58
recorded a **147.22%** level at balance 0, no margin call was raised again until 20:17:16 (95.70%, after six of the
fills), so each fill was checked against genuinely positive free margin. Left as is, per the owner's rule.

## 3. Margin-call hysteresis

Today an episode ends the moment the level is back above the call level: 34 MARGIN_CALL / MARGIN_CALL_CLEARED rows in
85 minutes on 50005696, some 3 s apart. New rule for ending an episode (`Out` edge):

- level >= call level + 10 points, AND
- at least 60 s since the episode started (`Account.marginCallNotifiedAt`).

Otherwise the flag stays set: no CLEARED row, and no new MARGIN_CALL either (the episode is still open). One
notification per episode. An account with **no open position left** still ends its episode at once: there is no level to
wait for and the next position starts a fresh episode.

Engine: `monitor.rs` `margin_call_edge` takes the episode start; `book::margin_call_notified` returns the timestamp
instead of a bool; the shadow keeps its own edge with the same rule. Web: `lib/risk-monitor.ts` pass 3 gets the same
two conditions, so WEB-owned accounts and the Stage 5 reconciler (which pairs web and engine margin-call rows) agree.
Constants: `MARGIN_CALL_CLEAR_MARGIN_POINTS = 10`, `MARGIN_CALL_MIN_EPISODE_SECS = 60`, one definition per language.

## 4. Commission 0.00 on the 18 positions (investigated, no change)

Futurix `BrokerSymbol.commissionPerLot` is 0.00 for all 13 symbols; group Standard has a commission only for XAUUSD
(7.00/lot); no account override. The 18 positions (AUDUSD, BTCUSD, ETHUSD, EURUSD, GBPUSD, NAS100, NZDUSD, SOLUSD,
US30, USDX, XAGUSD, XRPUSD) therefore cost 0, and a zero commission writes no ledger row by design. Configuration, not a
bug. If the broker wants commission on those symbols, set it per symbol or on the group.
