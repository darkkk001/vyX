# term-neworder · Trader terminal · F9 New Order dialog

## A. Purpose + panels
Modal "New Order" window (420×720, not resizable) with its OWN OrderTicketViewModel: same validation / send path as the docked ticket (PrepareOrder → PlaceTicketOrderAsync), plus a SLIPPAGE MAX field and an in-dialog confirm strip.
Opened by F9 (MainWindow.axaml.cs:312) and Market Watch "New order" (MainWindow.axaml.cs:231); refused with "FAILED · sign in first" when not live (MainWindow.axaml.cs:387).
Panels: caption `NEW ORDER · F9` · field grid · readouts · hint line · bottom stack (confirm strip, error box, result box, SELL/BUY buttons, CLOSE).
Evidence: E:\vyxtrader\src\Vyx.Trader.App\Views\NewOrderWindow.axaml:1-118; NewOrderWindow.axaml.cs:23-81; ViewModels\NewOrderViewModel.cs:10-21.

## B. Data
| Panel | Source | Refresh | Notes |
|---|---|---|---|
| Symbol list | Market.GridCandidates copied once at open (NewOrderWindow.axaml.cs:29) | on open only | watchlist first, then all broker-enabled (MarketDataService.cs:1100-1102) |
| Symbol terms, balance, leverage, currency, bid/ask | MarketDataService.BindTicket (MarketDataService.cs:1562-1574) from /api/trade/symbols (ApiClient.cs:151, symbols/route.ts:14-45) and /api/trade/me (ApiClient.cs:140) | on open and on symbol pick; ticks via _boundTickets (MarketDataService.cs:2194) | the tick path passes marketClosed=false (MarketDataService.cs:2194), so the dialog's closed flag is reset by any tick; the send path re-checks the schedule (MarketDataService.cs:1654) |
| Volume | copied from the docked ticket at open (NewOrderWindow.axaml.cs:30) | once | |
| Slippage max | copied from the docked ticket at open (NewOrderWindow.axaml.cs:31) | once | not recomputed when the dialog's symbol differs from the chart symbol (BindTicket does not touch SlippageMax, MarketDataService.cs:1562-1574) |
Error box = Ticket.Error; result box "sending…" → "OK · …" / "FAILED · …" (NewOrderWindow.axaml.cs:77-80). No loading state.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SYMBOL ▾ flyout | NewOrderWindow.axaml:63-85 | always | always | BindTicket (NewOrderWindow.axaml.cs:50) — no request | – | clears PRICE/SL/TP (OrderTicketViewModel.cs:79) | no | no | trader session | chart NOT switched (unlike the docked ticket) | WORKS |
| TYPE MARKET / LIMIT / STOP | :87-94 | always | always | none | – | LIMIT/STOP seeds PRICE from bid (OrderTicketViewModel.cs:75) | no | no | – | SELL/BUY captions change | WORKS |
| PRICE | :95-98 | type ≠ MARKET | always | none | – | ValidatePendingPrice (OrderValidation.cs:28-47) / server direction route.ts:273-280 | – | – | – | – | WORKS |
| VOLUME LOTS | :99 | always | always | none | – | ValidateVolume (OrderValidation.cs:11-22) / route.ts:148-153, 189-190 | – | – | – | – | WORKS |
| STOP LOSS / TAKE PROFIT | :100-101 | always | always | none | – | SlTpValidation (PriceRounding.cs:35-52) / validateSlTp route.ts:227 | – | – | – | – | WORKS |
| RISK % | :102 | always | always | none | – | SizingMath (OrderTicketViewModel.cs:140-156) | – | – | – | – | PARTIAL (no FX conversion; lots floored at 0.01, not lot step, SizingMath.cs:39-45) |
| SLIPPAGE MAX (watermark "M = unlimited") | :103 | always | always | sent as maxSlippagePips = pts/10 or "unlimited" (MarketDataService.cs:1680) | risk.ts:453-471 | client withhold (MarketDataService.cs:1660-1665) | – | – | – | – | PARTIAL (value inherited from the chart symbol's ticket, not recomputed for the dialog symbol, NewOrderWindow.axaml.cs:31) |
| EXPIRY (read-only GTC) | :104 | always | – | never sent (ApiClient.cs:306-312) | – | – | – | – | – | – | UI-ONLY |
| LEVERAGE / MARGIN REQ / PIP VALUE / RISK·REWARD·R:R readouts | :106-114 | always | – | – | – | – | – | – | – | – | PARTIAL (MARGIN REQ no FX / hedged margin SizingMath.cs:64-65; PIP VALUE = tick value OrderValidation.cs:79-80) |
| Hint line (MarketHint) | :115 | always | – | – | – | – | – | – | – | always "" (NewOrderWindow.axaml.cs:36; nothing else writes it) | DEAD |
| SELL (caption SELL / SELL LIMIT / SELL STOP + bid) | :41-47 | always | always | Submit("SELL") → Ticket.PrepareOrder → AcceptAsync → Market.PlaceTicketOrderAsync (MarketDataService.cs:1645) → ApiClient.PlaceMarketOrderAsync (ApiClient.cs:296) / PlacePendingOrderAsync (306) → POST /api/trade/orders | as term-ticket.md (route.ts:594-676 fill; 315-534 dealer queue; 682-733 pending) | full matrix in term-ticket.md | in-dialog strip if ConfirmTicketOrders (NewOrderWindow.axaml.cs:66-69) | no | trader session | result line; dialog stays open; docked ticket Status also set (MarketDataService.cs:1771, 1777) | WORKS |
| BUY (caption BUY / BUY LIMIT / BUY STOP + ask+markup) | :48-53 | always | always | same | same | same | same | no | – | same | WORKS |
| Confirm strip CANCEL | :29 | ConfirmVisible | – | none | – | – | – | – | – | pending order dropped | WORKS |
| Confirm strip PLACE ORDER | :30 | ConfirmVisible | – | AcceptAsync (NewOrderWindow.axaml.cs:73-81) | as SELL/BUY | – | – | – | – | – | WORKS |
| CLOSE | :55-57 | always | always | Close() | – | – | no | – | – | ticket unbound (NewOrderWindow.axaml.cs:37) | WORKS |
| Prefill side / type / price (OpenNewOrderAsync args) | MainWindow.axaml.cs:385-392 | – | – | no caller passes side/type/price (only symbol: MainWindow.axaml.cs:231, 312); `_prefillSide` stored, never read (NewOrderWindow.axaml.cs:35, 40-41) | – | – | – | – | – | – | DEAD |

## D. Dialogs
Fields (all on NewOrderViewModel.Ticket, an OrderTicketViewModel):
| Field | Type | Default | Stored in | Read by | Conditional |
|---|---|---|---|---|---|
| Symbol | flyout | argument or active chart symbol (NewOrderWindow.axaml.cs:32) | Order.symbolId | route.ts:131-137 | – |
| Type | tabs | MARKET | Order.type | route.ts:87 | – |
| Price | text | "" (bid when switched to LIMIT/STOP) | Order.requestedPrice | slippage anchor (MARKET) / client trigger (pending) | hidden for MARKET |
| Volume | text | docked ticket volume | Order.volume, Position.volume | route.ts:148-204 | – |
| SL / TP | text | "" | Order.slPrice/tpPrice → Position | lib/risk-monitor.ts:110-128 | – |
| Risk % | text | "" | nowhere | – | – |
| Slippage max | text | docked ticket value ("M" by default, MarketDataService.cs:1455) | request body only | risk.ts:453-471 | – |
| Expiry | read-only | GTC | nowhere | nowhere | – |
Confirm strip: title `SELL XAUUSD AT MARKET` / `BUY LIMIT XAUUSD`, detail = summary + ".", buttons `CANCEL` · `PLACE ORDER` (NewOrderWindow.axaml:24-33; .cs:67-69).

## E. Text
- Caption "NEW ORDER · F9" also shown when opened from Market Watch (NewOrderWindow.axaml:61).
- Confirm detail ends with "." (NewOrderWindow.axaml.cs:68) while the docked ticket's ends with "?" (MainWindow.axaml.cs:363).
- Label row "RISK / REWARD / R:R" with three unlabeled values (NewOrderWindow.axaml:109-114).
- Window close button is "CLOSE" while Modify / Smart-rules windows use "CLOSE WINDOW" (ModifyPositionWindow.axaml:42; SmartRulesWindow.axaml:41).

## F. UI structure map
Modal window, title `New Order`, 420×720 fixed, centred on owner (NewOrderWindow.axaml:7-8). No KPI strip.
Top-down: caption `NEW ORDER · F9` → rows (label col 120 px | editor): `SYMBOL` (`XAUUSD ▾` flyout, list of symbols) · `TYPE` (`MARKET` | `LIMIT` | `STOP`, default MARKET or the passed type) · `PRICE` (LIMIT/STOP only) · `VOLUME LOTS` · `STOP LOSS` (wm SL) · `TAKE PROFIT` (wm TP) · `RISK %` · `SLIPPAGE MAX` (wm `M = unlimited`) · `EXPIRY` (GTC) · rule · `LEVERAGE` · `MARGIN REQ` · `PIP VALUE` · `RISK / REWARD / R:R` (three values) · hint line (always empty).
Bottom stack: confirm strip (amber title, detail, `CANCEL` | `PLACE ORDER` = accent-filled primary) → red error box → result box → two buttons side by side: SELL (red border) | BUY (green border) → `CLOSE` right-aligned.
Tables: none. Right-click: none. Keyboard: no Enter/Esc bindings in the window (NewOrderWindow.axaml.cs has no KeyDown handler).

## Issues
[functional] term-neworder · SLIPPAGE MAX is copied from the chart symbol's ticket and not recomputed for the dialog's own symbol · NewOrderWindow.axaml.cs:31; MarketDataService.cs:1562-1574
[functional] term-neworder · every tick passes marketClosed=false to the dialog ticket, so its local closed-market refusal is lost after the first tick (send path still re-checks) · MarketDataService.cs:2194; OrderTicketViewModel.cs:120, 206
[functional] term-neworder · side / type / price prefill parameters are never supplied by any caller; the stored side is never read · MainWindow.axaml.cs:231, 312, 385-392; NewOrderWindow.axaml.cs:35, 40-41
[ux] term-neworder · hint line bound to MarketHint that is always empty · NewOrderWindow.axaml:115; NewOrderWindow.axaml.cs:36
[ux] term-neworder · EXPIRY shows GTC and is never sent · NewOrderWindow.axaml:104; ApiClient.cs:306-312
[ux] term-neworder · MARGIN REQ / PIP VALUE share the ticket's inaccuracies (no FX, pip = tick) · SizingMath.cs:64-65; OrderValidation.cs:79-80
[text] term-neworder · confirm detail ends with "." here and "?" on the docked ticket; close button "CLOSE" vs "CLOSE WINDOW" in sibling dialogs · NewOrderWindow.axaml.cs:68; MainWindow.axaml.cs:363; ModifyPositionWindow.axaml:42

## Status counts
STATUS-COUNTS app=terminal screen=term-neworder WORKS=10 PARTIAL=3 UI-ONLY=1 PLACEHOLDER=0 DEAD=2 DUPLICATE=0
