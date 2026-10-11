# term-marketwatch — 1) MW Market Watch + Symbol Specification

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Live view = shared control Vyx.Shared.Ui/MarketWatch/MarketWatchView (also hosted by the backoffice Dealing screen). Code-only audit.

## A. Purpose + panels
The account's watchlist grouped by symbol category, one live row per symbol (bid / ask / spread / day high / low / change), with search, "+ ADD" flyout, row click → chart, double-click → New Order, right-click menu, and a read-only Symbol Specification dialog.
Panels: title bar `1) MW MARKET WATCH` + UTC clock (MarketWatchPanel.axaml:13-21); column header row; search + `+ ADD` row; grouped rows; status text (MarketWatchView.axaml:22-111). Fixture rows (design gate) show only before sign-in (MarketWatchPanel.axaml:40-88).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Rows (which symbols, order) | GET /api/trade/watchlist | FetchWatchlistAsync ApiClient.cs:162-163 | watchlist/route.ts:6-16 → lib/watchlist.ts:59-80 (lazy seeds 10 defaults when the account has 0 rows, :66-67) | sign-in (MarketDataService.cs:1060), after add/remove (1406, 1416), AccountUpdated when the symbol set changed (574) |
| Symbol universe / category / digits | GET /api/trade/symbols | FetchAllSymbolsAsync ApiClient.cs:151 | symbols/route.ts:20-56 (broker-enabled BrokerSymbol rows) | sign-in, AccountUpdated |
| Bid / Ask / Spread | WS ticks (PriceStreamClient) seeded by GET /api/trade/prices | FetchPricesAsync ApiClient.cs:191 | prices/route.ts | live per tick (MarketDataService.cs:2191); snapshot only at sign-in and AccountUpdated (1059, 576) |
| Day High / Low / CHG% | last D1 candle (open/high/low) then extended by live bid | FetchCandlesAsync(sym,"D1") ApiClient.cs:197 | candles/route.ts:22-27 | loaded per GridCandidate sequentially after each watchlist load (MarketDataService.cs:1327-1341), cached 5 min (1389); hourly day-roll re-read for chart slots only (1371-1384) |

Rules: a watchlist symbol not in `/symbols` is dropped client-side (MarketDataService.cs:1098). Groups = category upper-cased, first-seen order; blank category → `OTHER` (1312). Selection highlight = active chart symbol (1318, 1426). Spread = raw ask − bid in points (MarketWatchViewModel.cs:88; AccountMath.cs:129-133) — the BUY markup (`askMarkup`, prices/route.ts:165,171) is NOT added, while the ticket / one-click BUY price is ask + markup (OrderTicketViewModel.cs:64, 123). High/low follow bid only (MarketWatchViewModel.cs:83-84). CHG% = (bid − D1 open)/D1 open (MarketWatchViewModel.cs:89-95); `—` when no D1 row.
Sort/filter: no sorting; search filters rows by symbol substring only (MarketWatchViewModel.cs:44); group headers stay visible when all their rows are filtered out (group header has no visibility binding, MarketWatchView.axaml:74-76).
Pagination: none. Server fields `collapsedCategories` (watchlist/route.ts:15) and the web's reorder route (app/api/trade/watchlist/reorder) are not used by the terminal.
Empty/loading/error: `NO FEED` per row until a price exists (MarketWatchView.axaml:98). Status line bound to `Watch.Status` (MarketWatchView.axaml:111) is never set by the terminal (no writer in MarketDataService.cs) — a failed watchlist GET shows an empty panel with no text. ADD flyout empty text `all enabled symbols are on the watchlist` / `no match` (MarketWatchView.axaml.cs:76).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search box `search symbols…` | row 2 left (MarketWatchView.axaml:39) | IsLive | always | none (Filter → ApplyFilter, MarketWatchViewModel.cs:28,30,44) | none | – | No | No | trader session | rows hidden | PARTIAL (symbol-only match; empty category headers remain) |
| `+ ADD` | row 2 right (MarketWatchView.axaml:40-67) | IsLive | always | toggles flyout (MarketWatchView.axaml.cs:81-85) | none | – | No | No | – | ADD SYMBOL flyout | WORKS |
| ADD flyout `search…` | flyout (MarketWatchView.axaml:47) | flyout open | always | none (symbol OR description match, MarketWatchView.axaml.cs:69-77) | none | – | No | No | – | list filtered | WORKS |
| ADD flyout item | flyout list (MarketWatchView.axaml:52) | flyout open | always | AddToWatchlistAsync → POST /api/trade/watchlist {symbolId} (ApiClient.cs:181-182) | watchlist/route.ts:21-51: WatchlistItem upsert at max position+1; no AuditLog / notification | client: symbol must be in /symbols (MarketDataService.cs:1404); server: BrokerSymbol enabled (route :32-37) else 404 | No | No | – | watchlist re-GET, grid defaults reconciled, LOG `Added X to watchlist`, action line `OK · X added` (MarketDataService.cs:1402-1410) | WORKS |
| Row click (left) | row (MarketWatchView.axaml:81; .cs:33-61) | IsLive | always | SelectChartAsync → GET /api/trade/candles (ApiClient.cs:197) | read only | – | No | No | – | active chart (single or focused cell) switches | WORKS |
| Row double-click | row (MarketWatchView.axaml.cs:28-32) | IsLive | signed in | opens NewOrderWindow(symbol) (MainWindow.axaml.cs:231, 385-392) | – (order dialog audited separately) | – | – | – | – | modal New Order | WORKS |
| Menu: Open chart, SYM | row right-click | IsLive | always | same as row click | read only | – | No | No | – | chart switches | WORKS |
| Menu: New order, SYM | row right-click | IsLive | signed in | same as double-click | – | – | – | – | – | modal New Order | WORKS |
| Menu: Specification, SYM… | row right-click | IsLive | always | opens SymbolSpecWindow (MainWindow.axaml.cs:129, 422-426); no request, reads cached /symbols + last tick | none | – | No | No | – | modal dialog | PARTIAL (pip-value label/unit mismatch, margin ignores FX / hedged %, no trading hours although /symbols sends tradingSessions) |
| Menu: Add symbol… | row right-click | IsLive | always | opens the ADD flyout (MarketWatchView.axaml.cs:44) | none | – | No | No | – | flyout | WORKS |
| Menu: Remove SYM from watchlist | row right-click | IsLive | always | RemoveFromWatchlistAsync → DELETE /api/trade/watchlist/{symbolId} (ApiClient.cs:185-186) | watchlist/[symbolId]/route.ts:72-79: WatchlistItem deleteMany; no audit. Removing the last row → next GET re-seeds up to 10 default symbols (lib/watchlist.ts:66-67) | client: symbol in /symbols | Yes, always: `REMOVE FROM WATCHLIST` / `Remove {sym} from this account's watchlist.` / `REMOVE` (MainWindow.axaml.cs:230) | No | – | re-GET, LOG `Removed X from watchlist` | PARTIAL (removing the last symbol brings back the default set) |
| Menu: Columns ▸ Change % | row right-click submenu | IsLive | always | none (ShowChange toggle) | none | – | No | No | – | column hidden/shown; NOT persisted (MainWindow.axaml.cs:223, 226 read/write only MwShowSpread / MwShowHighLow; TerminalSettings.MwShowChange exists at TerminalSettings.cs:50 but is unused) | PARTIAL (resets to on at every launch) |
| Menu: Columns ▸ Spread | same | IsLive | always | none | local settings.json MwShowSpread | – | No | No | – | persisted | WORKS |
| Menu: Columns ▸ Daily High / Low | same | IsLive | always | none | local settings.json MwShowHighLow | – | No | No | – | persisted; left column widened to 440 px when on (MainWindow.axaml.cs:228) | WORKS |
| Spec dialog CLOSE | SymbolSpecWindow (SymbolSpecWindow.axaml:11-13) | dialog open | always | none | none | – | No | No | – | closes | WORKS |

## D. Dialogs
**ADD SYMBOL flyout**: `search…` text (not stored); list = every `/symbols` symbol not on the watchlist, API (name-asc) order, symbol + description (MarketDataService.cs:58-59; symbols/route.ts:30).

**Symbol Specification** (SymbolSpecWindow.axaml.cs:22-49), 380×470, read-only, snapshot at open (no live update). Title `{SYMBOL}  ·  {CATEGORY}`. Rows:
| Row | Value source | Stored in | Read by |
|---|---|---|---|
| Symbol id | SymbolInfo.Id | Symbol.id | internal id (display only) |
| Digits | SymbolInfo.Digits | Symbol.digits | price rounding everywhere |
| Tick size | 10^-digits (PriceRounding.TickSize) | derived | – |
| Contract size | SymbolInfo.ContractSize | Symbol.contractSize | P&L / margin (server lib/margin.ts; client AccountMath) |
| Pip value / 1 lot | lots×contract×tick (OrderValidation.cs:79-80), suffix `{ccy} per tick` | derived | – (label says pip, value is per tick, currency is the account's but value is quote-currency) |
| Stop level | `{n} ticks ({price distance})` or `none` | BrokerSymbol.stopLevel (points; schema.prisma:1715-1723) | server validateSlTp (positions/[id]/route.ts:66-73), client SlTpValidation |
| Min lot / Max lot / Lot step | SymbolInfo | BrokerSymbol.minLot/maxLot/lotStep | server checkLotStep (symbols/route.ts:46-52 comment), ticket validation |
| Bid / Ask | last tick | – | – |
| Spread | raw ask − bid in points `{n} pts` | – | – (excludes BUY markup) |
| BUY ask markup | askMarkup from /prices | derived from group/broker markup pips (prices/route.ts:165) | server BUY fill price |
| Market | `CLOSED` / `OPEN (live quote)` / `unknown` via MarketSchedule on tradingSessions (MarketDataService.cs:98-103) | TradingSession rows | server checkTradingSession |
| Margin / 1 lot @ 1:{lev} | contract × ask / leverage + account currency (SymbolSpecWindow.axaml.cs:47) | derived | – (no FX conversion, no hedged %, differs from server lib/margin.ts:69-73) |
Note line: `Swaps, commissions and trading hours: per account group (broker)` (SymbolSpecWindow.axaml.cs:48). Trading hours are not shown although tradingSessions are loaded.

## E. Text
- Spec: `Pip value / 1 lot` with value suffix `… per tick` (SymbolSpecWindow.axaml.cs:38).
- Spec: `Symbol id` exposes the internal cuid (SymbolSpecWindow.axaml.cs:34).
- Spec class doc: `the API carries no session schedule` (SymbolSpecWindow.axaml.cs:17) — /symbols sends tradingSessions (symbols/route.ts:24-27, 37).
- MarketWatchViewModel doc: `"<active> · CORRELATION 20D" section computed from real D1 closes` (MarketWatchViewModel.cs:8-10) — the section was removed (MarketDataService.cs:1398-1400).
- MarketWatchPanel.axaml.cs:34 comment `ticket focus for this symbol` — the event opens the New Order dialog.
- `FeedState` (`FEED LIVE` / `FEED RECONNECTING` …) is computed (MarketDataService.cs:228-229) but only the fixture shows a `FEED LIVE` literal (MarketWatchPanel.axaml:16); nothing live displays it.

## F. UI structure map
**Header**: `1)` `MW` `MARKET WATCH` (live) / `MARKET MONITOR` (fixture) (MainViewModel.cs:81). Header-right: live `HH:mm:ss UTC`; fixture `FEED LIVE` + `03:17:42 UTC`.
**Column header row** (not clickable, not sortable): `SYMBOL` · `BID` · `ASK` · `SPRD` (if Spread on) · `HIGH` · `LOW` (if High/Low on) · `CHG%` (if Change on) · (8 px up/down square, no header).
**Search row**: `search symbols…` box, `+ ADD` button (amber text).
**Table (grouped rows)**: group header bar = category name (e.g. `METALS`, `FOREX`, `OTHER`). Row columns in order: SYMBOL, BID, ASK, SPRD, HIGH, LOW, CHG% (green/red), square (green/red). NO FEED row: dim symbol + `NO FEED` in the CHG% slot. Not sortable; default order = watchlist position within first-seen category groups. Selection: single highlight = active chart symbol (not multi, no checkbox column).
Row click = open chart; double-click = New Order dialog; Enter: none.
**Right-click on row: YES** (MarketWatchView.axaml.cs:36-57), no header line:
```
Open chart, {SYM}
New order, {SYM}
Specification, {SYM}…
────────────
Add symbol…
Remove {SYM} from watchlist
────────────
Columns ▸
    [✓] Change %
    [✓] Spread
    [ ] Daily High / Low
```
All items always visible and enabled; no shortcuts. Right-click on multi-selection: N/A (no multi-select). Right-click on empty area / group header / column header: NO (handler only on the row Border).
**ADD SYMBOL flyout**: title `ADD SYMBOL`, `search…` box, scroll list (max 320 px) of `SYMBOL  description`, empty text `all enabled symbols are on the watchlist` / `no match`.
**Symbol Specification dialog**: title row, key/value list (order as in D), note line, `CLOSE` button bottom-right. No other buttons.

## Issues
[money] marketwatch · ASK and SPRD show the raw ask; the price a BUY pays (ticket / one-click) is ask + askMarkup, so on marked-up groups the watchlist spread is tighter than the traded spread · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:86-88; ViewModels/OrderTicketViewModel.cs:64,123; app/api/trade/prices/route.ts:165,171
[functional] marketwatch · removing the last watchlist symbol makes the next GET re-seed up to 10 default symbols · app/api/trade/watchlist/[symbolId]/route.ts:78; lib/watchlist.ts:66-67
[functional] marketwatch · Columns ▸ Change % is not persisted (MwShowChange exists but is never read or written by the terminal) · MainWindow.axaml.cs:223,226; Services/TerminalSettings.cs:50
[ux] marketwatch · a failed watchlist GET leaves an empty panel with no message (Watch.Status is never set) · Vyx.Shared.Ui/MarketWatch/MarketWatchView.axaml:111; Services/MarketDataService.cs:1092-1099
[ux] marketwatch · search matches symbol only and leaves empty category headers visible · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:44; MarketWatchView.axaml:74-76
[money] marketwatch · Specification "Margin / 1 lot" = contract × ask / leverage labelled in account currency: no FX conversion, no hedged %, not the server formula · Views/SymbolSpecWindow.axaml.cs:47; lib/margin.ts:69-73
[text] marketwatch · Specification `Pip value / 1 lot` shows a per-tick value (`… per tick`) · Views/SymbolSpecWindow.axaml.cs:38
[functional] marketwatch · Specification shows no trading hours although /symbols returns tradingSessions (note says "per account group") · Views/SymbolSpecWindow.axaml.cs:48; app/api/trade/symbols/route.ts:24-27,37
[text] marketwatch · Specification shows the internal `Symbol id` · Views/SymbolSpecWindow.axaml.cs:34
[text] marketwatch · stale doc comments: correlation section (removed) and "API carries no session schedule" · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:8-10; Views/SymbolSpecWindow.axaml.cs:17
[ux] marketwatch · the terminal ignores the server's collapsedCategories and has no reorder, both of which the web watchlist has · app/api/trade/watchlist/route.ts:15; Services/MarketDataService.cs:1092-1113

## Status counts
`STATUS-COUNTS app=terminal screen=marketwatch WORKS=11 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
