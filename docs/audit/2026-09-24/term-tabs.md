# term-tabs · Trader terminal · dock tabs PENDING / ORDERS / HISTORY / BALANCE / LOG (+ statement export)

## A. Purpose + panels
The five non-TRADE tabs of the 4) dock (TRADE is in term-positions.md):
PENDING = resting LIMIT/STOP orders, dealer-queued market orders, queued closes and requotes (cancel / accept / reject); ORDERS = order log (all statuses, read-only); HISTORY = closed trades with range / symbol filters, mini statement and statement export; BALANCE = deposits / withdrawals / credits / adjustments; LOG = local journal merged with the server audit.
Evidence: E:\vyxtrader\src\Vyx.Trader.App\Views\PositionsPanel.axaml:264-502; PositionsPanel.axaml.cs; ViewModels\DockViewModels.cs; ViewModels\TableLayout.cs:144-173; Services\MarketDataService.cs:312-460; Services\StatementExport.cs; MainWindow.axaml.cs:140-141, 182-209.

## B. Data
| Tab | Endpoint | ApiClient | Route handler | Refresh | Filter / sort / limit | Empty / error |
|---|---|---|---|---|---|---|
| PENDING | GET /api/trade/orders | FetchOrdersAsync(false) ApiClient.cs:316-326 | app/api/trade/orders/route.ts:753-777 (status PENDING or REQUOTED, createdAt desc, unbounded) | 4 s poll (MarketDataService.cs:1084), every trading event (276), after actions | none client-side | "No pending orders" (PositionsPanel.axaml:316); errors silently ignored (MarketDataService.cs:1630) |
| ORDERS | GET /api/trade/orders?status=all | FetchOrdersAsync(true) | same route, take 500 (route.ts:746, 767-775) | ONLY at sign-in (MarketDataService.cs:1073) and after a ticket order (1774); not on events, closes, cancels or the poll | client sort createdAt desc (456); "N orders total" counts the ≤500 loaded | no empty text; errors ignored (454) |
| HISTORY | GET /api/trade/history | FetchHistoryAsync ApiClient.cs:329-339 | app/api/trade/history/route.ts:5-37 (all CLOSED positions of the account, unbounded; from/to/symbol params exist but the terminal sends none) | sign-in (1074), events PositionClosed/PositionsClosed/OrderFilled (277), after every close | client range 1D/1W/1M/3M/6M/ALL/CUSTOM (default 1M, DockViewModels.cs:75) + symbol; sort closedAt desc (MarketDataService.cs:352, 360-397) | summary "no closed trades in this range" (396); rows area has no empty text |
| BALANCE | GET /api/trade/transactions | FetchTransactionsAsync ApiClient.cs:343-351 | app/api/trade/transactions/route.ts:20-43 (DEPOSIT/WITHDRAWAL/CREDIT/… types, createdAt desc, take 200) | ONLY on BalanceChanged/BalanceAdjusted events (279) and after closes (534, 557, 701, 748); NOT at sign-in (GoLiveAsync 1041-1087 never calls it) | none | no empty text |
| LOG | local journal + GET /api/trade/audit | FetchAuditAsync ApiClient.cs:354-364 | app/api/trade/audit/route.ts:16-48 (AuditLog rows whose old/new value accountNumber matches, take 100, time "HH:mm:ss") | local: live; server rows ONLY at sign-in (MarketDataService.cs:1075) | merged, newest first, capped 200 (320-335) | no empty text |

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tab buttons PENDING / ORDERS / HISTORY / BALANCE / LOG | dock tab row, PositionsPanel.axaml:166-180 | live | always | TabRequested → Dock.ActiveTab (MainWindow.axaml.cs:85) | – | – | – | – | – | tab content switches | PARTIAL (returning to TRADE highlights no tab: DockViewModels.cs:29 compares Label with the key "POS") |
| PENDING · ✕ (cancel) | ACTIONS cell, :306-308 | row not REQUOTED | always | CancelOrderRequested → Market.CancelOrderAsync (MarketDataService.cs:1791-1796) → DELETE /api/trade/orders/{id} (ApiClient.cs:373-374) | Order CANCELLED; queued close releases the position lock; AuditLog TRADER_CANCELLED_PENDING_ORDER / TRADER_CANCELLED_DEALING_ORDER; NATS OrderCancelled; dealer activity ORDER_CANCELLED (orders/[id]/route.ts:206-283) | server: order exists / cancellable status (224-227) | ConfirmTicketOrders "CANCEL ORDER" (MainWindow.axaml.cs:206) | no | trader session | pending list refresh; no LOG line written (MarketDataService.cs:1791-1796) | WORKS |
| PENDING · ✓ <offered price> (accept requote) | :303 | Status REQUOTED | always | AcceptRequoteAsync (MarketDataService.cs:1799-1805) → POST /api/trade/orders/{id}/requote-response {accept:true} (ApiClient.cs:378-379) | open: Position + commission + AuditLog DEALING_ORDER_REQUOTE_ACCEPTED + mirror.onFillPosition + coverage.onFillAutoHedge + OrderFilled (requote-response/route.ts:155-240); close requote: executeQueuedCloseInTx + DEALING_CLOSE_REQUOTE_ACCEPTED (113-152) | server risk battery (155-178); NO pre-trade margin check on this fill path (no checkAccountPreTradeMargin in the file) | none (by design, MainWindow.axaml.cs:207-208) | no | – | journal "Requote accepted — filled at the dealer's price" | WORKS |
| PENDING · ✕ REJECT | :304 | Status REQUOTED | always | RejectRequoteAsync (1808-1814) → same route {accept:false} | Order CANCELLED + AuditLog DEALING_ORDER_REQUOTE_REJECTED + OrderCancelled (requote-response/route.ts:60-90) | – | none | no | – | journal | WORKS |
| ORDERS rows | :337-357 | – | – | none | – | – | – | – | – | – | PARTIAL (stale: not refreshed on events / poll, MarketDataService.cs:1073, 1774) |
| HISTORY range chips 1D 1W 1M 3M 6M ALL CUSTOM | :366-372 | HISTORY | always | ApplyHistoryRange (MarketDataService.cs:360-397), no request | – | – | – | – | – | chip filled; summary line recomputed | WORKS |
| HISTORY FROM / TO date pickers | :373-378 | range = CUSTOM | always | Dock.HistoryFrom/To → ApplyHistoryRange("CUSTOM") (PositionsPanel.axaml.cs:143-150) | – | future dates blocked (172); TO inclusive (MarketDataService.cs:374) | – | – | – | – | WORKS |
| HISTORY SYMBOL combo | :380-383 | HISTORY | always | re-applies range (MainWindow.axaml.cs:141) | – | – | – | – | – | – | WORKS |
| STATEMENT ⤓ | :385 (amber) | HISTORY | always | save picker (HTML default / Excel / CSV) → StatementExport.ToHtml / ToXlsx (StatementExport.cs:31, 66) or HistoryCsv (MarketDataService.cs:433-448) (MainWindow.axaml.cs:182-205) | none (local file) | – | no | – | – | "statement saved · <file>" | WORKS |
| HISTORY row right-click › Share … | row, PositionsPanel.axaml.cs:57-63 | – | always | Share Trade window from the history row (MainWindow.axaml.cs:128, 453-456) | none | – | – | – | – | – | WORKS |
| HISTORY empty-area right-click › period items | list area, PositionsPanel.axaml.cs:117-138 | – | always | HistoryRangeRequested | – | – | – | – | – | – | DUPLICATE (range chips) |
| HISTORY empty-area right-click › Columns… | same menu | – | always | ShowColumnPicker | settings.json | – | – | – | – | – | DUPLICATE (header right-click) |
| Column picker (header right-click) on PENDING / ORDERS / HISTORY / BALANCE / LOG | header rows :267, 321, 388, 435, 469 | – | always | ShowColumnPicker (PositionsPanel.axaml.cs:208-241) | settings.json TableColumns (MarketDataService.cs:2003-2011) | – | – | – | – | persisted | WORKS |
| Column grip resize (all five tables) | header cell edges | – | – | OnGrip* (PositionsPanel.axaml.cs:245-264) | settings.json | 28-600 px | – | – | – | manual widths | WORKS |
| BALANCE rows | :485-501 | – | – | none | – | – | – | – | – | – | PARTIAL (empty after sign-in until a balance event or a close, MarketDataService.cs:1041-1087 vs 399-412) |
| LOG rows | :451-465 | – | – | none | – | – | – | – | – | – | PARTIAL (server audit rows merged only at sign-in, MarketDataService.cs:1075) |

## D. Dialogs
- Confirm `CANCEL ORDER` "Cancel XAUUSD BUY LIMIT 0.10?" [CANCEL ORDER] (MarketDataService.cs:945-950; MainWindow.axaml.cs:206).
- Save dialog "Export statement", suggested `statement-<account>-<range>-yyyyMMdd.html`, types "HTML statement (print / share)" (*.html), "Excel workbook" (*.xlsx), "CSV" (*.csv) (MainWindow.axaml.cs:185-194). Statement header = broker, account, name, currency, leverage, period (+ symbol), CURRENT balance, generated UTC (MarketDataService.cs:420-431); rows = the HISTORY tab's filtered rows; totals trades / profitable / commission / swap / profit (StatementExport.cs:23-25, 55, 81). CSV columns `ticket,symbol,side,lots,open,close,swap,commission,pnl,closed_utc,reason` (MarketDataService.cs:438).
- Share Trade window from history: P/L = realizedPnl + swap + commission (ShareCard.cs:25-27); see term-positions.md.
No input fields stored server-side on these tabs.

## E. Text
- Tab label "TRADE" but internal key/code "POS" and F5 note "F5 · positions" (DockViewModels.cs:90; MainWindow.axaml.cs:308).
- Summary "N trades · net X · comm Y · swap Z": "net" is the sum of realizedPnl only (MarketDataService.cs:391-396); whether realizedPnl already includes commission/swap: UNVERIFIED (not traced into position-close.ts).
- BALANCE DATE is rendered in LOCAL time (DockViewModels.cs:260) while every other dock time is UTC (DockViewModels.cs:214-218).
- Statement "Balance" is the balance now, not at period end (MarketDataService.cs:429).
- ORDERS total "N orders total" counts at most the 500 newest (route.ts:746; DockViewModels.cs:65).
- Requote tooltip "Dealer offered X — you requested Y. Accept or reject." (DockViewModels.cs:230).
- HISTORY right-click header item "STATEMENT PERIOD" with tick-marked "✓  Last month" etc. (PositionsPanel.axaml.cs:124-131).

## F. UI structure map
Shared frame: dock tab row `4) TRADE` · `PENDING` · `ORDERS` · `HISTORY` · `BALANCE` · `LOG` (active = P2 bg + "4) " prefix); bulk close buttons only on TRADE; footer (positions totals) visible on every tab (PositionsPanel.axaml:506-514). No selection, no checkbox column, no sorting, no row click / double-click / Enter handlers on any of these five tables.
PENDING: right-aligned total "N pending orders" · columns `TICKET` · `CREATED` · `SYMBOL` · `TYPE` (LIMIT / STOP / MARKET / "CLOSE #T") · `SIDE` · `LOTS` · `PRICE` · `S/L` · `T/P` · fixed `ACTIONS` (176 px). Per row: `✕` (red) or, on a REQUOTED row, `✓ <offered>` (green) + `✕ REJECT` (red). Tooltip: requote text or origin. RIGHT-CLICK ON ROW: NO. Empty area: NO. Header: YES → column picker (COLUMNS / checkbox per column / Fit columns to width / Reset columns).
ORDERS: right-aligned "N orders total" · `TICKET` · `CREATED` · `SYMBOL` · `TYPE` · `SIDE` · `LOTS` · `PRICE` · `FILLED` · `STATUS`. No per-row buttons. RIGHT-CLICK ON ROW: NO. Header: YES (picker).
HISTORY: toolbar `RANGE` chips `1D` `1W` `1M` (default) `3M` `6M` `ALL` `CUSTOM` (+ `FROM` / `TO` calendar pickers when CUSTOM) · `SYMBOL` combo (`ALL` + symbols seen) · summary text · `STATEMENT ⤓` (amber, primary). Columns `TICKET` · `OPENED` · `SYMBOL` · `SIDE` · `LOTS` · `OPEN PRICE` · `CLOSE PRICE` (coloured by reason) · `S/L` (red when SL/stop-out hit) · `T/P` (green when TP hit) · `SWAP` · `COMM` · `CLOSED` · `REASON` (hidden by default) · `DURATION` · `PROFIT / LOSS`. Default sort closed time desc.
 RIGHT-CLICK ON ROW: YES → single item `Share #TICKET SYMBOL…` (no header, no separator).
 RIGHT-CLICK ON EMPTY LIST AREA: YES → `STATEMENT PERIOD` (disabled header) · `✓  Last day` / `Last week` / `Last month` / `Last 3 months` / `Last 6 months` / `All time` / `Custom range…` (tick on the active one) · separator · `Columns…`. (The row handler marks the event handled, so this menu does not open from a row.)
 Header: YES (picker).
BALANCE: `DATE` · `TYPE` (coloured by sign) · `AMOUNT` (signed) · `REASON` · `STATUS`. RIGHT-CLICK ON ROW: NO. Header: YES (picker).
LOG: `TIME` (HH:mm:ss today, "dd MMM HH:mm:ss" older) · `SRC` (local / event / order / server / rule / rule!) · `MESSAGE` (ellipsis). RIGHT-CLICK ON ROW: NO. Header: YES (picker).

## Issues
[money] term-tabs · accepting a dealer requote opens the position without any pre-trade margin check · requote-response/route.ts:155-212 (no checkAccountPreTradeMargin); MarketDataService.cs:1799-1805
[functional] term-tabs · BALANCE tab is never loaded at sign-in; stays empty until a balance event or a close · MarketDataService.cs:399-412, 1041-1087
[functional] term-tabs · ORDERS tab refreshes only at sign-in and after a ticket order; fills, closes, cancels, dealer actions leave it stale · MarketDataService.cs:1073, 1774, 263-283
[functional] term-tabs · LOG merges server audit rows only once at sign-in · MarketDataService.cs:1075, 320-335
[ux] term-tabs · returning to TRADE leaves no tab highlighted (Label "TRADE" vs key "POS") · DockViewModels.cs:27-29, 90
[functional] term-tabs · HISTORY fetches the account's entire closed history (no from/to/limit) on every close event, then filters client-side · history/route.ts:16-37; ApiClient.cs:331; MarketDataService.cs:277, 346
[ux] term-tabs · cancelling a pending order writes no LOG line (other actions do) · MarketDataService.cs:1791-1796
[text] term-tabs · BALANCE dates are local time, all other dock times UTC · DockViewModels.cs:214-218, 260
[text] term-tabs · statement header balance is the current balance, not the period-end balance · MarketDataService.cs:429
[ux] term-tabs · ORDERS, HISTORY rows area, BALANCE and LOG have no empty-state text · PositionsPanel.axaml:319-502

## Status counts
STATUS-COUNTS app=terminal screen=term-tabs WORKS=10 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2
