# term-ticket · Trader terminal · 3) OT ORDER TICKET (docked) + order flows

## A. Purpose + panels
Docked order ticket in the right column (top), follows the active chart symbol; places MARKET / LIMIT / STOP orders. Below a splitter: the docked Smart Trade Manager (covered in term-stm.md) and the SESSIONS rows.
Panels: title bar (`3)` `OT` `ORDER TICKET`, right = active chart symbol) · type tabs · field rows · SELL/BUY split buttons · hint / error / status boxes · RISK / REWARD / R:R strip · splitter · STM block · SESSIONS rows.
Evidence: E:\vyxtrader\src\Vyx.Trader.App\Views\OrderTicketPanel.axaml:73-77, 197-469; MainWindow.axaml:45-46 (RightCol row 0).

## B. Data
| Panel | Source | ApiClient | Route handler | Refresh | Notes |
|---|---|---|---|---|---|
| Symbol terms (digits, contractSize, stopLevel, minLot, maxLot, lotStep) | GET /api/trade/symbols | ApiClient.FetchAllSymbolsAsync ApiClient.cs:151 | app/api/trade/symbols/route.ts:14-45 (broker-enabled only, NOT filtered by group allowed symbols, no tradingMode) | on login (MarketDataService.cs:1043-1046) and on AccountUpdated event (MarketDataService.cs:564-579); pushed into the ticket only when the active symbol/digits change (MarketDataService.cs:1443-1451) | a changed stopLevel/lot terms for the SAME symbol does not reach the ticket until a symbol switch (MarketDataService.cs:1443) |
| Bid / ask | gateway WS ticks (PriceStreamClient) + REST snapshot GET /api/trade/prices | ApiClient.FetchPricesAsync ApiClient.cs:191 | app/api/trade/prices/route.ts | live tick (MarketDataService.cs:2200-2206); snapshot on login/AccountUpdated (1819-1837) | askMarkup added to BUY reference (OrderTicketViewModel.cs:64) |
| Balance / leverage / currency | GET /api/trade/me | ApiClient.FetchAccountAsync ApiClient.cs:140 | app/api/trade/me/route.ts | on login, every trading event, F7 (MarketDataService.cs:1579-1586, 281) | |
| Market closed flag | symbol sessions (MarketSchedule) else snapshot marketClosed | – | – | per tick (MarketDataService.cs:98-103, 2203) | |
| SESSIONS rows | local SessionClock | – | – | 1 s timer, rebuilt every 30 s (MarketDataService.cs:1237-1256) | header text is a hard-coded literal (OrderTicketPanel.axaml:451) |
Empty/loading: price faces show "—" until a price (OrderTicketViewModel.cs:122-123); readouts "—" (164-169). Error box = Ticket.Error (red), status box = Ticket.Status (green/red border) (OrderTicketPanel.axaml:327-332).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MARKET / LIMIT / STOP tabs | top row, OrderTicketPanel.axaml:202-215 | live | always | none (sets Ticket.OrderType, MainWindow.axaml.cs:66) | – | LIMIT/STOP seeds PRICE from bid once (OrderTicketViewModel.cs:75) | no | no | trader session | labels become SELL LIMIT / BUY STOP (68-69) | WORKS |
| SYMBOL ▾ flyout | row 1, :218-242 | live | always | Market.SelectChartAsync (MainWindow.axaml.cs:67) → GET /api/trade/candles (chart) | none | list = GridCandidates (watchlist + all broker-enabled, MarketDataService.cs:1100-1102); group-restricted symbols still listed | no | no | – | switches the ACTIVE CHART symbol, ticket follows; clears PRICE/SL/TP (OrderTicketViewModel.cs:79) | WORKS |
| PRICE | :244-249 | type ≠ MARKET | always | none | – | client ValidatePendingPrice (OrderValidation.cs:28-47) at send | – | – | – | – | WORKS |
| VOLUME LOTS | :250-255 | live | always | none | – | ValidateVolume (OrderValidation.cs:11-22); edits re-derive RISK % (OrderTicketViewModel.cs:80) | – | – | – | F4 focuses it (MainWindow.axaml.cs:307) | WORKS |
| STOP LOSS / TAKE PROFIT | :256-267 | live | always | none | – | live side hint LegHint (OrderTicketViewModel.cs:97-110); SlTpValidation at send (223) | – | – | – | – | WORKS |
| RISK % | :268-273 | live | always | none | – | ↔ volume via SizingMath (OrderTicketViewModel.cs:140-156) | – | – | – | – | PARTIAL (risk $ in quote currency, no FX conversion SizingMath.cs:54-66; lots floored at 0.01 not the symbol lot step SizingMath.cs:39-45) |
| LEVERAGE (read-only) | :274-279 | live | – | – | – | – | – | – | – | – | WORKS |
| EXPIRY (read-only "GTC") | :280-285 | live | – | never sent (PlacePendingOrderAsync has no expiry, ApiClient.cs:306-312) | – | – | – | – | – | – | UI-ONLY |
| MARGIN REQ readout | :286-294 | live | – | – | – | lots×contract×price/leverage (SizingMath.cs:64-65) | – | – | – | – | PARTIAL (no FX conversion, no hedged-margin netting; server uses both margin.ts:276-317) |
| PIP VALUE readout | :295-303 | live | – | – | – | lots×contract×TICK (OrderValidation.cs:79-80) | – | – | – | – | PARTIAL (value of one tick/point, labelled pip; pip elsewhere = 10 ticks SmartRules.cs:46, PositionMath.cs:38) |
| SELL / SELL LIMIT / SELL STOP | split left, :307-312 | live | always (no disabled state) | SubmitTicket → PrepareOrder → Confirm → PlaceTicketOrderAsync → ApiClient.PlaceMarketOrderAsync (ApiClient.cs:296) / PlacePendingOrderAsync (306) → POST /api/trade/orders | MARKET: Order(FILLED)+Position+commission Transaction+AuditLog ORDER_FILLED, mirror.onFillPosition, coverage.onFillAutoHedge, NATS OrderFilled, dealer activity (route.ts:594-676). Dealer mode: Order(PENDING)+AuditLog ORDER_PLACED+Notification DEALING_ORDER_PENDING+OrderAccepted/DealingQueued events (315-534). LIMIT/STOP: Order(PENDING)+AuditLog ORDER_PLACED+OrderAccepted (682-733) | see order-flow table below | yes if Settings.ConfirmTicketOrders (default true TerminalSettings.cs:18), MainWindow.axaml.cs:361-365; no "don't ask" key | no | trader session | status box + journal + positions/orders refresh (MarketDataService.cs:1741-1775) | WORKS |
| BUY / BUY LIMIT / BUY STOP | split right, :313-318 | live | always | same as SELL | same | same | same | no | – | same | WORKS |
| RISK / REWARD / R:R | :335-356 | live | – | – | – | SizingMath.Compute | – | – | – | – | WORKS |
| STM splitter | :360-361 | live | – | – | – | – | – | – | – | height persisted LayoutStmHeight (MainWindow.axaml.cs:674-676) | WORKS |
| STM block | :369-449 | live | – | see term-stm.md | | | | | | | DUPLICATE (listed in term-stm.md) |
| SESSIONS rows | :450-465 | always | – | – | – | – | – | – | – | – | PARTIAL (header literal "SESSIONS · 03:17 UTC" never updates, :451) |

## Order flows (dedicated section)

### Order types supported
- MARKET, LIMIT, STOP only (ticket tabs OrderTicketPanel.axaml:202-215; F9 NewOrderWindow.axaml:90-92; server accepts exactly these, route.ts:87). No STOP-LIMIT, no expiry (EXPIRY is display-only), no pending-order modify from the terminal (server PATCH /api/trade/orders/[id] exists, orders/[id]/route.ts:25; no ApiClient method calls it — only PATCH positions, ApiClient.cs:258).
- Entry paths into the same send path (MarketDataService.PlaceTicketOrderAsync :1645):
  - ticket SELL/BUY (MainWindow.axaml.cs:357-367) — confirm per ConfirmTicketOrders;
  - F9 dialog (NewOrderWindow.axaml.cs:60-81) — see term-neworder.md;
  - chart one-click (MainWindow.axaml.cs:339-347) — MARKET only, no SL/TP (OrderTicketViewModel.cs:194-205), confirm only when 1-Click is OFF;
  - STM hotkeys (MainWindow.axaml.cs:329-337) — MARKET only, SL/TP of the ticket NOT sent (uses PrepareOneClickOrder, MarketDataService.cs:1639), no confirm;
  - REV row action (MarketDataService.cs:2040-2058) — MARKET, no SL/TP.
  - Chart right-click pending order uses a different path, PlaceChartOrderAsync (MarketDataService.cs:1938-1944): no client volume / price-side validation, no idempotent retry (chart = other agent).
- Pending orders fill only when a connected client sees the trigger: CheckPendingTriggers on every tick (MarketDataService.cs:809-820) → POST /api/trade/orders/{id}/fill (ApiClient.cs:369-370; fill/route.ts:43). Server comment says the order "rests ... until the client's local price simulation reports the trigger price is hit" (route.ts:679-681). The Rust pending scanner reads table `orders` with status ACCEPTED (engine/order-management/src/db.rs:587-588) while this route writes Prisma model `Order` status PENDING (route.ts:682-696; schema model Order has no @@map). No other server-side trigger found in lib/ or app/api (grep). With every terminal/WebTrader closed a LIMIT/STOP never fills.
- On a failed fill the client removes the order from `_triggering` (MarketDataService.cs:827) so it is re-sent on the next tick of that symbol: a persistent rejection (margin, halt, 5-pip trigger slippage fill/route.ts:246-255) repeats a POST + two LOG lines per tick.

### Validation matrix (client C# vs server)
| Check | Client (C#) | Server |
|---|---|---|
| Volume min / max / step | OrderValidation.ValidateVolume (OrderValidation.cs:11-22) via PrepareOrder (OrderTicketViewModel.cs:209) | min/max route.ts:148-153; lot step risk.ts:98-105 via route.ts:189; group max lot route.ts:190 (group max not known client-side) |
| Market closed | Ticket.MarketClosed (OrderTicketViewModel.cs:206, set from MarketDataService.IsMarketClosed :98-103) and again at send (MarketDataService.cs:1654) | checkTradingSession risk.ts:201 via route.ts:188 → MARKET_CLOSED + nextOpenAt (208-211); open-by-schedule but not quoting → MARKET_CLOSED/NOT_QUOTING (260-262) |
| No live price / stale | HasPrice (OrderTicketViewModel.cs:207); current ≤ 0 (MarketDataService.cs:1659) | MARKET only: evaluateLiveMarketPrice (risk.ts:371-392, NO_LIVE_FEED + deviation vs mid) and checkPriceFreshness 3 s (risk.ts:428-433) at route.ts:253-264; client retries PRICE_STALE once after 800 ms (MarketDataService.cs:1687-1695) |
| Pending entry side (LIMIT below / STOP above) | ValidatePendingPrice (OrderValidation.cs:28-39) at OrderTicketViewModel.cs:217 | validatePendingOrderDirection (lib/trading.ts:77-95) at route.ts:273-280, skipped when no LivePrice row |
| Pending entry stop-level distance | ValidatePendingPrice stopLevel (OrderValidation.cs:40-45) | NOT checked at placement (validatePendingPriceDistance lib/trading.ts:50-63 is only called by PATCH orders/[id]/route.ts:104) |
| SL / TP side + stop level | SlTpValidation.Validate (Vyx.Shared/Trading/PriceRounding.cs:35-52) vs the live side price (MARKET) or entry price (pending), OrderTicketViewModel.cs:223 | validateSlTp (lib/trading.ts:16-40) at route.ts:227, reference = client-sent `price` |
| Slippage | Client withholds MARKET send if the side price moved > SLIPPAGE MAX since confirm (MarketDataService.cs:1660-1665; OrderValidation.cs:59-60). Default Settings.DefaultSlippagePts = 0 → "M" = unlimited (TerminalSettings.cs:36; OrderValidation.cs:68-76; MarketDataService.cs:1521-1526). Sends maxSlippagePips = pts/10 or the literal "unlimited" (MarketDataService.cs:1680). One automatic re-send on SLIPPAGE_EXCEEDED within the confirmed max (1700-1713) | checkSlippage (risk.ts:453-471) at route.ts:558-570; "unlimited" skips; nothing sent → broker defaultMaxSlippagePips else none. Pending trigger fill: fixed 5 pips (risk.ts PENDING_TRIGGER_MAX_SLIPPAGE_PIPS, fill/route.ts:246-255) |
| Margin / free margin < 0 | NONE. Ticket shows MARGIN REQ only (OrderTicketViewModel.cs:164); PrepareOrder has no margin/free-margin check (190-232) | checkAccountPreTradeMargin (lib/margin.ts:246-331) on MARKET fill (route.ts:579-592), smart-dealer auto-accept (391-402, falls through to the human queue), pending trigger fill (fill/route.ts:261-274). NOT on pending placement (route.ts:679-697) and NOT before queueing to the human dealer (483-534). Rejection body {error, required, available, balance} rendered by FriendlyFor (MarketDataService.cs:135-144). NO_CONVERSION_RATE has no mapping (shown as "no conversion rate", Friendly :906) |
| Symbol disabled | picker lists broker-enabled symbols only (symbols/route.ts:21) | brokerSymbol enabled lookup → "symbol not available for this broker" (route.ts:131-137). Client maps SYMBOL_DISABLED / SYMBOL_NOT_TRADABLE (MarketDataService.cs:900) — codes the route never sends |
| Group allowed symbols | none (symbols route not group-filtered) | checkGroupAllowedSymbol route.ts:194-200 |
| Close-only | none | broker checkCloseOnly route.ts:186 (risk.ts:24-25); group route.ts:193 |
| Halted | none | broker route.ts:185; group route.ts:192 |
| Buy-only / sell-only | none (tradingMode not sent by /symbols) | symbol route.ts:187; group restriction route.ts:191 |
| Max open positions / exposure / daily loss | none | route.ts:201-204 |
| Duplicate submit | new GUID idempotencyKey per send (MarketDataService.cs:1671); retries use a new key (1694, 1710) | idempotent replay route.ts:122-129 |
| Dealer mode | none (message after the fact: "submitted, awaiting dealer review" MarketDataService.cs:1768-1770; REJECTED body handled 1718-1724) | resolveWantsDealingQueue route.ts:291-297 |

### Account in margin call — can it still open?
- Server: checkPreTradeMargin refuses when the projected margin level after the order is ≤ Group.marginCallLevel (lib/margin.ts:202-217, `lte`). An account already in margin call (level ≤ call level) that adds used margin only lowers the level further, so every margin-increasing MARKET order / trigger fill is refused (INSUFFICIENT_MARGIN, or INSUFFICIENT_BALANCE when balance+credit < required, margin.ts:321-330). Exception: an order that does not increase used margin passes regardless of level (margin.ts:315-317) — only possible for an opposite-side order on the same symbol when BrokerSymbol.hedgedMarginPct < 200 (margin.ts:128-129, 140, 157-163; default 200 = plain sum).
- Not gated in margin call: placing a LIMIT/STOP (no margin check at placement, route.ts:679-697; checked only at fill), and MARKET orders routed to the human dealer queue (route.ts:483-534; whether the dealer accept route re-checks margin is outside this scope: UNVERIFIED).
- Client: no gate at all. The account panel shows the margin level and the call level (MarketDataService.cs:1616-1620) but PrepareOrder / PlaceTicketOrderAsync never read them (OrderTicketViewModel.cs:190-232; MarketDataService.cs:1645-1778). The trader learns from the server rejection text "not enough free margin — need X, have Y" (MarketDataService.cs:135-139) and the margin-reject sound (1748).

## D. Dialogs
Confirm overlay (shared ChartHost.Confirm, Vyx.Shared.Ui/Charting/ChartHost.cs:262-278): title `BUY XAUUSD AT MARKET` / `BUY LIMIT XAUUSD`, detail = PreparedOrder.Summary + "?" (OrderTicketViewModel.cs:226-230), button `PLACE ORDER`. No "don't ask again" (no sessionKey, MainWindow.axaml.cs:361).
Ticket fields → storage:
| Field | Type | Default | Stored in | Read by |
|---|---|---|---|---|
| type | tab | MARKET (OrderTicketViewModel.cs:33) | Order.type | route.ts:87; fill route |
| volume | text | "0.01" (34) | Order.volume, Position.volume | margin/exposure checks route.ts:148-204; P&L everywhere |
| price | text | "" (seeded from bid on LIMIT/STOP) | Order.requestedPrice | MARKET: slippage anchor only (route.ts:558-567); pending: trigger via client (MarketDataService.cs:814) |
| sl / tp | text | "" | Order.slPrice/tpPrice, Position.slPrice/tpPrice | lib/risk-monitor.ts:110-128; engine/market-data/src/risk_hook.rs |
| risk % | text | "" | nowhere (client only) | – |
| slippage max | not on the docked ticket | "M" (MarketDataService.cs:1455) | request body maxSlippagePips only | risk.ts:453-471 |
| expiry | read-only | "GTC" | nowhere | nowhere |

## E. Text
- "SESSIONS · 03:17 UTC" fixed literal on the live panel (OrderTicketPanel.axaml:451).
- "PIP VALUE" shows the value of one tick (OrderValidation.cs:77-80).
- Error "SL/TP on the wrong side for BUY and SELL" (OrderTicketViewModel.cs:108) vs send error "Stop Loss must be below the current price (…) for a BUY" (PriceRounding.cs:40) — two wordings for the same rule.
- Slippage withhold text uses ASCII "-": "price moved 16 pts since confirm (max 20) - not sent, re-quote" (MarketDataService.cs:1664).
- Code comment claims "Unlimited is the default" (MarketDataService.cs:1679) while OrderTicketViewModel doc says 20 is the default (OrderTicketViewModel.cs:40-44); effective value is "M" from settings.
- Friendly maps SYMBOL_DISABLED / INVALID_STOPS / INVALID_SL_TP (MarketDataService.cs:900-902): the order route never emits these codes (it sends sentences, route.ts:136, 229).

## F. UI structure map
Layout: right column top (BodyGrid col 4, 268-420 px, MainWindow.axaml:45-46; MainWindow.axaml.cs:654, 662). Header = PanelTitleBar Number `3)` Code `OT` Sub `ORDER TICKET`; header-right = active chart symbol text (OrderTicketPanel.axaml:73-77). No KPI strip.
Upper scroll area (live, :197-359), top to bottom:
1. Type tab row: `MARKET` | `LIMIT` | `STOP` (default MARKET; active = filled bg). Click = select.
2. Rows label | value: `SYMBOL` (`XAUUSD ▾`, click = flyout list of symbols, click item = switch chart) · `PRICE` (only LIMIT/STOP) · `VOLUME LOTS` · `STOP LOSS` (watermark SL) · `TAKE PROFIT` (watermark TP) · `RISK %` · `LEVERAGE` (1:N) · `EXPIRY` (GTC) · `MARGIN REQ` + currency · `PIP VALUE` + currency.
3. Split buttons: left caption `SELL` / `SELL LIMIT` / `SELL STOP` + bid (red); right `BUY` / `BUY LIMIT` / `BUY STOP` + ask+markup (green). No primary/orange button; no disabled state.
4. Hint box (only when SL/TP set): "SL/TP: BUY only" / "SL/TP: SELL only" (grey) or "SL/TP on the wrong side for BUY and SELL" (red border).
5. Error box (red), Status box (green/red border).
6. Strip `RISK` | `REWARD` | `R:R`.
Splitter (drag, persisted), then lower scroll area: Smart Trade Manager block (see term-stm.md) and `SESSIONS · 03:17 UTC` + one row per session (name | OPEN green / countdown dim).
Tables: none. Right-click: none anywhere on the panel (no ContextMenu in OrderTicketPanel.axaml / .cs). Keyboard: F4 focuses VOLUME LOTS (MainWindow.axaml.cs:307). Dropdowns: SYMBOL flyout = GridCandidates order (watchlist first).
Fixture (not live) variant: same frame with static rows, `SELL · C2` / `BUY · C1`, static RISK −13.83 / REWARD +26.35 / R:R 1:1.9 and a SMART EXECUTION list (OrderTicketPanel.axaml:80-192).

## Issues
[functional] term-ticket · STM hotkey orders are sent without the ticket's SL/TP even though the STM block shows SL/TP fields above the hotkeys (PrepareOneClickOrder = marketOnly) · MainWindow.axaml.cs:329-337; MarketDataService.cs:1639; OrderTicketViewModel.cs:194-205; OrderTicketPanel.axaml:364-368
[functional] term-ticket · web-placed LIMIT/STOP orders are triggered only by a connected client; no server-side trigger reads them (engine scanner reads `orders`/ACCEPTED) · route.ts:679-697; MarketDataService.cs:809-828; engine/order-management/src/db.rs:587-588
[functional] term-ticket · a rejected pending-trigger fill is re-armed and re-POSTed on every following tick (journal + request flood while the rejection persists) · MarketDataService.cs:813-827
[money] term-ticket · no margin check when placing a LIMIT/STOP or when queueing a MARKET order for the human dealer; an account in margin call can still place them · route.ts:483-534, 679-697
[functional] term-ticket · no client-side margin / margin-call / close-only / halted / buy-only gate; the trader only learns from the server rejection · OrderTicketViewModel.cs:190-232
[functional] term-ticket · server does not enforce stopLevel distance for a pending entry price at placement (only on PATCH) · route.ts:273-280; orders/[id]/route.ts:104
[functional] term-ticket · MARGIN REQ ignores FX conversion and hedged margin; non-USD-quoted symbols show a quote-currency figure labelled with the account currency · SizingMath.cs:64-65; OrderTicketPanel.axaml:288-293; margin.ts:276-317
[ux] term-ticket · PIP VALUE row shows the value of one tick, not one pip (pip = 10 ticks elsewhere) · OrderValidation.cs:79-80; SmartRules.cs:46
[ux] term-ticket · EXPIRY row always shows GTC and is never sent · OrderTicketPanel.axaml:280-285; ApiClient.cs:306-312
[text] term-ticket · live SESSIONS header is the literal "SESSIONS · 03:17 UTC" · OrderTicketPanel.axaml:451
[functional] term-ticket · symbol picker lists group-restricted symbols (symbols route not group-filtered); order then refused server-side · symbols/route.ts:20-22; route.ts:194-200
[functional] term-ticket · updated stopLevel / lot terms for the current symbol are not pushed to the ticket until the symbol changes · MarketDataService.cs:1443-1451
[text] term-ticket · Friendly() maps SYMBOL_DISABLED / INVALID_STOPS / INVALID_SL_TP codes the order route never returns; NO_CONVERSION_RATE is unmapped · MarketDataService.cs:889-907; margin.ts:279
[functional] term-ticket · hotkey orders do not send `source: "hotkey"`, so the server's STM_HOTKEY_ORDER audit row is never written for the native terminal · ApiClient.cs:296-303; route.ts:101, 653
[functional] term-ticket · RISK % → lots floors at 0.01 and ignores the symbol lot step, can produce a volume the ticket then refuses · SizingMath.cs:39-45; OrderTicketViewModel.cs:144-146

## Status counts
STATUS-COUNTS app=terminal screen=term-ticket WORKS=10 PARTIAL=4 UI-ONLY=1 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
