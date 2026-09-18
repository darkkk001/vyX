# Wrong-field / copy-paste / mapping-mismatch audit — 2026-09-18

Trigger: `db::upsert_candles_batch` bound `u.open` as open, high, low AND close
(fixed in this pass, see §0). One proactive sweep of the whole
candle → price → order → money path for the same class of bug — code that
compiles and runs but binds/copies the wrong field, side, sign, pool or unit —
so they get fixed together instead of one at a time.

Scope read in full: `engine/market-data`, `engine/server`, `engine/protocol`,
`engine/order-management`, `engine/{execution,position,ledger,margin,risk}`,
`services/api-gateway/src/db.ts`, web `lib/*` money+price modules, every
`app/api/trade/{orders,positions,prices,candles}` route, the dealing-queue /
requote routes, mirror, swap, commission; Avalonia client `Vyx.Shared`
(Api/Models/Charting/Trading), terminal view-models, backoffice DealingChart /
LiveService. Every finding cites file:line and was verified by reading the
surrounding code; items marked PLAUSIBLE could not be executed to prove.

Verdict legend: **CONFIRMED** read and traced end-to-end · **PLAUSIBLE** the
mechanism is certain but the live outcome wasn't reproduced · **DESIGN?**
consistent code that may or may not be the intended business rule.

## 0. Fixed in this pass (engine market-data + EA)

| # | Where | Bug | Status |
|---|-------|-----|--------|
| 0.1 | `engine/market-data/src/db.rs` `upsert_candles_batch` | Bound `u.open` for open/high/low/close → the accumulated intra-window high/low and latest-tick close never reached the row; every flush stored the window's OPEN as H, L and C. Stored bar = ~1 Hz point sample of window opens. | **FIXED** — four arrays, each column from its own field. DB-backed test `upsert_candles_batch_stores_each_ohlc_field_and_widens_across_flushes` (was `high=101` for a `110` spike before). |
| 0.2 | `engine/market-data/src/cache.rs` + `ingest.rs` | Whole flush window bucketed by its LAST tick's time: a spike at 12:00:59.8 flushed at 12:01:00.2 landed in 12:01 and 12:00 never got its final ticks; 12:01's insert-only `open` was a 12:00 price. Every minute boundary, every symbol. | **FIXED** — cache closes a segment on each UTC-minute rollover; `CandleSample.at` carries the ingest-resolved time and the flush buckets by it. End-to-end test `a_flush_window_straddling_a_minute_writes_each_minutes_true_ohlc_to_its_own_row` (stored `2400/2400/2400/2400` before; `2400/2410/2395/2395` + `2402/2403/2402/2403` after). |
| 0.3 | `mt5-ea/VyXTraderPriceFeed.mq5` `RefreshBrokerOffset` + `engine/server/src/main.rs` `ingest_history` | `BrokerOffsetSec = TimeTradeServer() - TimeGMT()`: two second-resolution reads; a straddled second gives 10799/10801 and every backfilled bar lands at `hh:mm:01` as a phantom row beside the real one — the authoritative overwrite never touches the real bucket, silently. Engine accepted any timestamp. | **FIXED** — EA (v1.39) rounds the offset to the minute; engine rejects off-grid bars via `market_data::bucket_is_aligned` and warns once per request with the first offender. |

## 1. CRITICAL — money-affecting

| # | Where | Bug | Verdict |
|---|-------|-----|---------|
| 1.1 | `app/api/trade/positions/[id]/close/route.ts:32,84,191` | Client close fills at the **client-supplied** `closePrice` (only gated by `checkLiveMarketPrice`'s ±2 % band, side ignored) and that value goes straight into `closePositionInTx` → realized P&L and balance. BUY 1 lot XAUUSD mid 2600, POST `closePrice: 2650` → ~$5,000/lot minted, repeatable. Open path was made server-priced; close was not. Fix: `closePrice = closePriceFor(side, live.bid, live.ask)` after `checkPriceFreshness`, client value only as the `checkSlippage` anchor (exactly what `lib/bulk-close.ts:102` and `lib/risk-monitor.ts:96` do). | CONFIRMED |
| 1.2 | `engine/order-management/src/db.rs:894` (+ `pending_orders.rs:91`, `lib.rs:174/383`) | Margin monitor / SL-TP / pending trigger / placement fallback read `LivePrice` from the **Neon trade pool** (`server/src/main.rs:1270-1276` pass `pool`) with `"updatedAt" > now()-15s`. Since S5 (`MARKET_DATA_WRITE=local`, 2026-09-15) LivePrice is written only to the VPS store → bid/ask NULL for every position → SL/TP never fire, stop-out finds no position, equity ignores floating loss, pending trigger's margin check over-permits. Two wrong fields in one line: wrong pool (must be `market_pools.reader()`, as the gateway does via `marketDataPool`) and wrong column (`tickAt`, not the heartbeat-bumped `updatedAt`). Applies to whatever runs through the engine path today (memory: demo-only), but it is dead code the moment real money does. | CONFIRMED |

## 2. HIGH

| # | Where | Bug | Verdict |
|---|-------|-----|---------|
| 2.1 | `lib/group-pricing.ts:100-126 chargeCommission` | Debits balance + writes a COMMISSION Transaction but **never writes `Position.commission`**. Readers: `lib/commission.ts:24,36` (IB PERCENTAGE payout = rate × SUM(commission) → always 0), `app/api/manage/reports/summary/route.ts:35,52`, `reports/trading`, `manage/positions:137`, deals screens, WebTrader (shows 0.00 while the balance was debited). Engine side is correct (`order-management/db.rs:334`). Fix: `tx.position.update({ data: { commission: { increment } } })`. | CONFIRMED |
| 2.2 | `app/api/trade/orders/[id]/fill/route.ts:45,182-192` | Pending-order trigger is **never verified server-side** (only `WebTrader.tsx:2337` on the raw ask, while the fill uses the marked-up ask) and slippage is anchored on the client body's `requestedFillPrice`, not `order.requestedPrice`. Any client can POST `/fill` at any time → resting LIMIT becomes a market order; BUY LIMIT 1.0800 fills 1.0802. Fix: enforce LIMIT/STOP condition on the marked-up fill price; anchor on `order.requestedPrice`. | CONFIRMED |
| 2.3 | `app/api/manage/dealing-queue/[id]/route.ts:254-269`, `app/api/trade/orders/[id]/requote-response/route.ts:175-186`, `app/api/trade/orders/route.ts:254-262` | No `checkAccountPreTradeMargin` before `openPositionFromOrder` on dealer accept or client requote-accept; the smart-dealer branch falls through to the manual queue on `marginError`, so the dealer can accept exactly the order the margin gate refused. | CONFIRMED |
| 2.4 | `engine/order-management/src/db.rs:530` | Symbol-exposure subquery `SUM(volume) FILTER (WHERE symbol=$3) FROM positions WHERE account_id=$2` has no `AND status='OPEN'` (the COUNT on the next line and the `get_symbol_exposure` it replaced both have it). Closed history counts against `maxExposure` → spurious "exposure limit exceeded". | CONFIRMED |
| 2.5 | `engine/order-management/src/db.rs:760`, `swap.rs:243` | Swap: `last_swap_at IS NULL` charges a just-opened position on the next 300 s poll (a 2-minute scalp pays a full day), and weekends are not skipped while Wednesday is already ×3 → 9 charges/week vs 7. Fix: seed `last_swap_at` at insert; skip ISO weekday 6/7. | CONFIRMED |
| 2.6 | `E:\vyxtrader\src\Vyx.Shared\Charting\Timeframe.cs:35-39` → `CandleSeries.cs:246-272 ApplyTick`; `Vyx.Shared.Ui\Charting\ChartDrawOperation.cs:701` | Client buckets H4/D1/W1 on the **epoch** grid (D1 00:00 UTC, H4 00/04/08…, W1 Thursday) while the server buckets on the **broker day** (Pepperstone UTC+3 → D1 21:00 UTC, H4 01/05/…/21). Ticks compute a bucket `<` the last server row → `Ignored`: the live H4 candle is frozen 3 of every 4 hours, D1 21:00–00:00, W1 Sun–Thu; then a phantom candle opens on the epoch grid that the server never has. Countdown `MsToClose` wrong by the same offset. M1..H1 unaffected. Fix: phase-relative bucketing off the loaded rows (`last + floor((t-last)/span)*span`), or expose `brokerOffsetSec` and port `bucket_start()` 1:1. | CONFIRMED (display only) |
| 2.7 | `E:\vyxtrader\src\Vyx.Trader.App\ViewModels\MarketWatchViewModels.cs:29-32` (from `MainViewModel.cs:138-146`, unconditional) | `double.Parse("4456.17")` etc. on fixture prices **without `InvariantCulture`**, `InvariantGlobalization=false`. On fr-FR/ru-RU/pl-PL this throws `FormatException` in a field initializer → the terminal cannot open its main window. Live-path parsing is all invariant (clean). Fix: `CultureInfo.InvariantCulture` (or set `DefaultThreadCurrentCulture` at startup). | PLAUSIBLE (semantics certain, not launched under a foreign culture) |

## 3. MEDIUM

| # | Where | Bug | Verdict |
|---|-------|-----|---------|
| 3.1 | `lib/commission.ts:24,29` with `lib/position-close.ts:40-61` | IB PER_LOT commission sums `Position.volume` of CLOSED rows, but a partial close shrinks `volume` in place → 1.0 lot closed 0.9 + 0.1 pays IB on 0.1. `Position.realizedPnl` likewise holds only the last slice (`reports/trading/route.ts:34` exports it as "Realized P&L"). Fix: sum close Transactions or add `closedVolume` / cumulative `realizedPnl`. | CONFIRMED |
| 3.2 | `app/api/manage/dealing-queue/[id]/route.ts:320`, `requote-response/route.ts:198` | REQUESTED-mode dealer ACCEPT applies `applySpreadMarkup` to the client's own limit price → BUY LIMIT 2000.00 fills at 2000.00 + markup, worse than the limit. MARKET mode (0fdedaa) is side-correct. | DESIGN? (MT convention is limit-or-better) |
| 3.3 | `lib/mirror.ts:80-90` | Proportional close volume not rounded to the target `lotStep` (e.g. 0.333333…); P&L computed on it, but `Position.volume` is Decimal(10,2) so the remainder is silently rounded → lots double-counted. Fix: reuse `roundMirrorVolume`. | CONFIRMED |
| 3.4 | `lib/mirror.ts:273,386` | MARKET-mode mirror fills/closes use `getLivePriceRow` with no `tickAt` freshness gate — every other fill path uses `getFreshPrice`/`checkPriceFreshness`. A heartbeat-frozen tick fills the target at a dead price. | CONFIRMED |
| 3.5 | `engine/market-data/src/gap_fill.rs:282,395` | `market_open` evaluated at the bucket START; for metals a UTC+3/+2 broker's D1 (and one H4) bucket starts exactly at the daily-break hour → judged closed, never gap-filled, and `plan_sweep` advances past it. Outage-recovery only (real ticks / EA backfill still create the bar). Fix: for spans ≥ 4 h test `cursor + 1h` (or "any instant in the bucket is open"). | CONFIRMED |
| 3.6 | `E:\vyxtrader\src\Vyx.Shared\Trading\OrderValidation.cs:79-80` | "PIP VALUE" readout (`OrderTicketPanel.axaml:297`, `NewOrderWindow.axaml:107`) is `lots × contractSize × TickSize(digits)` = a **point** value; everything else (`PositionMath.PnlPips`, `SmartRules.PipSize`, server `pipSize()`) defines pip = 10 points → readout 10× low. Fix: ×10 or relabel POINT VALUE. | CONFIRMED |
| 3.7 | `engine/order-management/src/pricing.rs:126`, `lib/group-pricing.ts:45`, closes via raw `closePriceFor` | Spread markup is ask-only: a SELL round trip pays no markup (opens raw bid, closes raw ask), a BUY closes at raw bid; the trader sees the marked-up ask but a SELL is bought back below it. Consistent in both engines. | DESIGN? |

## 4. LOW

| # | Where | Bug |
|---|-------|-----|
| 4.1 | `lib/queued-close.ts:275 cancelPendingClose` | Zero callers (header comment claims risk-monitor/admin close use it) → after SL/TP/stop-out closes a locked position the queued close Order stays PENDING and `closePendingOrderId` is set on a CLOSED row until a dealer clicks it. No money impact. |
| 4.2 | `lib/position-actions.ts:89,98` | Reverse-in-place audit values a BUY at ask and a SELL at bid (opposite of `closePriceFor`). Only written to `AuditLog.oldValue/newValue.floatingPnl`. |
| 4.3 | `app/api/trade/positions/[id]/route.ts:56-58`, `app/api/trade/orders/route.ts:165` | SL/TP validated against the **client's** reference price, not the server fill/live price. Not exploitable for money (SL/TP fire at market) but a BUY SL "above" a fake reference is accepted and closes immediately. |
| 4.4 | `engine/server/src/main.rs:995-1012 price_row`; `feed_stats:879-890` | `/internal/prices.updatedAt` and `ageMs` are the tick time (`entry.at` = `resolve_tick_time`), not receipt time as the comment/JSON contract states. No money reader (`lib/risk.ts` uses `tickAt`). Fix: a second `received_at` in `TickEntry`. |
| 4.5 | `engine/market-data/src/gap_fill.rs:279-292` | D1/H4 gap cursor steps a fixed `fixed_ms` from the previous start; across a broker DST shift the first fill lands on the old grid (stray row beside the real bar, twice a year). Fix: derive via `bucket_start(tf, cursor+step, offset)`. |
| 4.6 | `engine/order-management/src/lib.rs:205`, `pending_orders.rs:90` | Admission margin uses raw `tick.bid` for both sides while `calc::used_margin` uses `open_price` (marked-up ask for BUY) → small under-reservation and admission/monitor inconsistency. |
| 4.7 | engine order-management (all writes) | No rounding: fill price, P&L, margin stored unrounded and truncated by column scale; price not snapped to `Symbol.digits`. Cosmetic until markup is fractional pips. |
| 4.8 | `E:\vyxtrader\...\MarketDataService.cs:1161-1165` | Tape day-change uses the raw last D1 row, not the `WithoutDeadCandles` "today" that `ApplyDayLevels:1229-1247` uses → ≈0.00 % over the weekend while header/Market Watch show change vs Friday. |
| 4.9 | `E:\vyxtrader\src\Vyx.Shared\Api\Models.cs:283-287` | `CandleRow.FromJson` throws on a row without `bucketStart` (parse is outside `GetJsonAsync`'s try) → escapes into fire-and-forget `SelectSlotAsync`. Robustness only. |
| 4.10 | `E:\vyxtrader\src\Vyx.Shared\Charting\CandleSeries.cs:128-143,230-240` | FX weekend fixed at 22:00 UTC vs the server's DST-aware 21:00/22:00 → in summer keeps the dead Fri 21:00 bar and drops the live Sun 21:00 one. Cosmetic. |

Known / guarded, not new: quote-currency conversion is absent everywhere
(P&L and margin in quote units); `app/api/manage/symbols/route.ts:175-191`
blocks enabling non-USD-quoted symbols, so this cannot bite until that gate
is lifted.

## Checked and found clean (so the coverage is known)

- **engine/market-data**: `upsert_live_prices_batch` (4/4 binds, bid→bid, ask→ask, tickAt), `upsert_candles_authoritative_batch` (7/7, replaces all four), `fetch_candles` / `fetch_last_buckets` tuple order, `load_active_price_alerts`, `mark_price_alert_triggered`, `get_live_price`, `retention` binds + per-TF days, `risk_hook` (buy closes at bid / sell at ask, SL/TP inequalities), `alerts` (ABOVE/BELOW/CROSSES), `bucket_start` (offset sign, Monday weeks, month/year), `merge_dedup`, `resolve_tick_time` ms math, `flush_live_prices` lockstep arrays, `gap_fill` flat = prev close, `stats` counters, `sink` targets/reader, `server` HistoryBar→CandleUpdate and StoredCandle→CandleRow field-for-field, order bodies 1:1, NATS payloads.
- **engine order-management**: all 68 `.bind` calls ($N count/order/semantics), every `query_as` tuple↔struct, enum strings, fill sides BUY@ask/SELL@bid and closes inverted, `is_triggered` / `validate_pending_price_side`, `floating_pnl` sign, partial-close proportionality, close-by mid-price netting, margin `lots×cs×price/lev`, level = equity/margin×100 vs percent thresholds, worst-first stop-out, commission once per fill, swap sign by side, `pip_size` == web `pipSize`.
- **web**: `lib/market-data-client.ts` engine→Prisma Candle (each of O/H/L/C from its own field), `toLivePriceRow`, `WebTrader` consumer shape, `risk-monitor` SL/TP/stop-out/margin-call units, `lib/margin.ts`, `bulk-close.ts`, `close-by.ts`, dealer `liveRefAtClick` side logic, `swap-rollover.ts` (side, ISODOW 3 ×3, sign), every `position.create` (`openPrice: fillPrice`, SL/TP unswapped, ids from the order), Transaction `balanceBefore/After`, negative-balance write-off sign, `pipSize` vs `validateSlTp` points.
- **client**: every `Models.cs` / `ApiClient.ManageG1.cs` JSON property vs its route, ISO parse `AssumeUniversal|AdjustToUniversal`, `ApplyTick` H=max/L=min/C=tick, bid used consistently, `PriceStreamClient`, order ticket faces/references/slippage/retries, pending side/type, trigger detection, SL/TP sides, type strings, `AccountMath` line-for-line with `lib/margin.ts`, position row / footer / modify / backoffice overlay fields and signs, indicators, invariant culture on the whole live path.
