# Weekend flat XAUUSD candles + static SESSIONS clock (read-only investigation, 2026-09-26)

Line numbers are E: `HEAD` = 4dad6aa. MarketDataService.cs has uncommitted edits from another agent, so its working-tree line numbers are shifted by about 220.

## Terminal root cause (this makes the reported flat candles)
1. **The EA sends a heartbeat every 5 s, and the terminal treats it as a real tick.** `mt5-ea/VyXTraderPriceFeed.mq5:194,1353` resends each symbol's unchanged price every 5 s, even on weekends. It keeps the frozen `tick_ms` (l.1375-1386). On the engine side, `engine/market-data/src/ingest.rs:141` (`publish_tick`, l.600) publishes every tick to NATS with no session gate. `services/api-gateway/src/ws.ts:298-311` passes each one on as-is.
2. **The terminal ignores the tick's own time and stamps it with the local clock.** `src/Vyx.Shared/Api/PriceStreamClient.cs:231`: `new PriceTickEvent(symbol, bid, ask, DateTimeOffset.UtcNow...)`. The message's `tick_ms` field is dropped.
3. `MarketDataService.cs:2389` (`OnTick` -> `slot.Chart.ApplyTick(t.Bid, t.ReceivedAtMs)`) calls `CandleSeries.cs:183-209`. When the bucket is new, it adds `new Candle(bid,bid,bid,bid)`. There is no market-closed check and no check for a repeated price. **Result: the first heartbeat in each new minute adds one zero-range bar at Friday's last bid.**
4. Minor: `MarketDataService.cs:2353` adds the latest tick at `UtcNow` after every chart (re)load, so each load while closed adds one flat bar at "now". The backoffice has the same two paths: `DealingChart.cs:373` and `:453`.

Checked and not a cause:
- No C# gap-fill exists. `ApplyTick` rolls exactly one bar (see the doc comment at `CandleSeries.cs:179-182`). The web simulator's flat-fill was never ported.
- The 30 s `/prices` re-read (`MarketDataService.cs:1980-1985` -> `RefreshPricesSnapshotAsync` l.1859) only updates `_ticks`, the watch list and the ticket. It never touches a chart series.

## Countdown and SESSIONS clock
- **Countdown:** `ChartDrawOperation.cs:696-707` computes `Timeframe.MsToClose(UtcNow, tf)` from the wall clock only, and never checks whether the market is closed. It is repainted every second by `TickClock` (`MarketDataService.cs:1281`, `MarkTickOnly`).
- **SESSIONS clock:** it is a hard-coded design-fixture string, `Text="SESSIONS · 03:17 UTC"`, at `src/Vyx.Trader.App/Views/OrderTicketPanel.axaml:176` and `:455`. It is not bound to anything. The rows below it (`SessionRows`) do refresh.

## Server stores
- **Neon (ep-morning-glade, `.env.live`)**, queried read-only: **0** XAUUSD candles of any kind since 2026-09-25 20:00 UTC. Neon Candle/LivePrice stopped receiving writes at the S5 cut-over.
  - Latest rows: M1 max 2026-09-14 21:21. The last real M1 bar is 2026-09-14 20:58, O/H/L/C 4298.44/4298.96/4297.72/4298.96. It is followed by flat 4298.96 rows from 21:17 to 21:21 (old, pre-gate).
  - LivePrice XAUUSD: bid 4298.96, tickAt 2026-09-14T20:58:59Z (frozen).
  - No TradingSession rows exist for XAUUSD (category METALS). The close is therefore the default: Fri 21:00 UTC (EDT).
- **VPS engine store:** not reachable from here. `feed.vyxtrader.com/internal/candles` returns 401, and `MARKET_DATA_READ_SECRET` is redacted in `.env.old` and missing from `.env.live`. Read-only check for the owner to run on the VPS:
  `$H=@{'x-market-data-secret'=$env:MARKET_DATA_READ_SECRET}; Invoke-RestMethod "http://127.0.0.1:8081/internal/candles?symbol=XAUUSD&tf=M1&limit=900" -Headers $H | ? { $_.bucketStart -ge '2026-09-25T20:40' } | ft bucketStart,open,high,low,close,updatedAt`
  plus `Invoke-RestMethod http://127.0.0.1:8081/internal/prices/XAUUSD -Headers $H` (for `tickAt` / `ageMs`).
- **Engine code:** candle writes are gated. `ingest.rs:455` checks `market_open(symbol, tick's own tick_ms time)`, and the gap-fill checks the same thing (`gap_fill.rs:264,353`; the Fri close is 21:00 UTC in EDT). A heartbeat carries a frozen `tick_ms`, so the engine should **not** write weekend flats and `tickAt` should not advance. This needs confirming with the VPS query above. Only the NATS publish (and the in-memory LivePrice/tick cache) is ungated.

## Is 4284.99 the last real price?
Not verifiable from here: Neon is frozen at 09-14 (4298.96) and the VPS store is unreachable. By design the heartbeat resends the EA's last real bid, so 4284.99 should be Friday's last real bid. The VPS `prices/XAUUSD` `tickAt` or the last non-flat M1 bar would confirm it.

## Recommended fixes (none applied)
- **Terminal:**
  - Parse `tick_ms` in `PriceStreamClient.HandleMessage` and bucket on it instead of `UtcNow`.
  - In `OnTick`/`ApplyTick`, do not roll a new bar when `IsMarketClosed(symbol)`, or when the price and `tick_ms` are unchanged. Still update the watch list and ticket.
  - Skip the `:2353` fold-in when the market is closed.
  - Hide or freeze the countdown when the market is closed.
  - Bind the SESSIONS header to `UtcClock`.
  - Align `CandleSeries.IsFxWeekend` (Fri 22:00) with `MarketSchedule` (Fri 21:00).
  - Apply the same fixes to the backoffice `DealingChart`.
- **Server:** optionally stop publishing heartbeat resends to NATS while `market_open` is false, or mark them (`heartbeat:true`). Run the VPS query to confirm there are no stored flats.
