# term-account · Trader terminal · 6) ACC ACCOUNT panel + top-bar account cells

Path prefixes: `T\` = E:\vyxtrader\src\Vyx.Trader.App\ · `S\` = E:\vyxtrader\src\Vyx.Shared\ · `SU\` = E:\vyxtrader\src\Vyx.Shared.Ui\ · `W\` = D:\VyXTrader-Tauri\vyX\. Commits: E: 1c8b0d3, D: 74b3c02.

## A. Purpose + panels
Read-only account summary in the right column, bottom (T\MainWindow.axaml:48, below the order ticket). Seven value rows + a margin gauge. Values are computed client-side on every tick of a symbol with an open position, from /me balance + credit + live prices + closed history. Related read-only cells in the top bar: ACCOUNT, EQUITY USD, MARGIN LVL (T\Views\TopBar.axaml:77-98).
Panels: title bar `6)` `ACC` `ACCOUNT` (right text empty when live) · rows · gauge (T\Views\AccountPanel.axaml:11-44). Pre-live the design fixture rows/gauge are shown instead (:47-74).

## B. Data
| Panel | Source | ApiClient | Route handler | Refresh | Notes |
|---|---|---|---|---|---|
| balance, credit, leverage, currency, accountMode, fullName, marginCallLevel, groupName | GET /api/trade/me | `FetchAccountAsync` S\Api\ApiClient.cs:140-148 (credit parsed S\Api\Models.cs:103) | W\app\api\trade\me\route.ts:5-43 (returns `marginCallLevel` from group, fallback 100, :42; no stopOutLevel) | at sign-in (T\Services\MarketDataService.cs:1061), after EVERY trading event (:281), F7 (T\MainWindow.axaml.cs:310). Not polled. | while the trading-event stream is down, balance/credit stay stale (the 4 s poll refreshes positions/orders only, :1083-1085) |
| open positions (symbol, side, volume, openPrice, contractSize) | GET /api/trade/positions | `FetchPositionsAsync` ApiClient.cs:237 | W\app\api\trade\positions\route.ts:5 | 4 s poll + events (MarketDataService.cs:1083-1085, 275) | |
| live bid/ask | gateway price stream | PriceStreamClient | gateway | every tick of a symbol that has a dock position → `RecomputeAccountPanel` (MarketDataService.cs:2196-2198) | a position with no tick yet counts in neither equity nor margin (S\Trading\AccountMath.cs:71) |
| hedged margin % per symbol | GET /api/trade/symbols `hedgedMarginPct` | `FetchAllSymbolsAsync` ApiClient.cs:151; parsed Models.cs:28 (clamp 0–200, default 200) | W\app\api\trade\symbols\route.ts:55 | sign-in + AccountUpdated event (MarketDataService.cs:564-579) | |
| closed trades for DAY/WEEK P/L | GET /api/trade/history (all closed, no limit) | `FetchHistoryAsync` ApiClient.cs:329 | W\app\api\trade\history\route.ts:5-46 | sign-in, OrderFilled / PositionClosed events (MarketDataService.cs:277) | summed from the full set `_historyAll`, independent of the HISTORY tab filter (:1609-1613) |
Computation (T\Services\MarketDataService.cs:1592-1623; S\Trading\AccountMath.cs:64-104):
- equity = balance + credit + Σ floating; floating per position = (close price − open) × contractSize × volume, close price = bid for BUY / ask for SELL (AccountMath.cs:67-77). Same formula as server `computeAccountMarginSnapshots` (W\lib\margin.ts:84) EXCEPT the server multiplies floating and margin by a quote→account FX rate (W\lib\margin.ts:67-74); the terminal applies none.
- used margin = MT5 hedged margin (HedgedMargin.UsedMargin, AccountMath.cs:31-53) = server `hedgedUsedMargin` (W\lib\margin.ts:142), default 200 % (margin.ts:140). Margin per leg = volume × contractSize × close price / leverage (AccountMath.cs:78; server margin.ts:108-114, 182-191).
- free margin = equity − used; level = equity / used × 100 when used > 0 (AccountMath.cs:81-84).
- DAY P/L = realized+swap+commission of trades closed since 00:00 UTC today + the WHOLE current floating P/L; WEEK P/L = same since Monday 00:00 UTC + whole floating (MarketDataService.cs:1614-1615; AccountMath.cs:89-104).
- Pending orders reserve no margin (same as server).
Empty/loading/error: rows show "—" until the first /me (AccRowViewModel `_value = "—"`, T\ViewModels\AccountViewModel.cs:56); /me failure is silent (MarketDataService.cs:1582).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F7 ACCOUNT (key or status-bar cell) | T\MainWindow.axaml.cs:310 | live (cell) | always | GET /api/trade/me (ApiClient.cs:140) | none | – | no | no | none | panel + top bar recomputed; line "F7 · account refreshed" | WORKS |
The panel itself has no clickable control (AccountPanel.axaml has no handlers). Top-bar account cells are display-only.

## D. Dialogs
None. Row sources:
| Row (label) | Value | Colour rule | Evidence |
|---|---|---|---|
| BALANCE | balance, plus "  (+<credit> credit)" when credit ≠ 0 | red if balance < 0 | T\ViewModels\AccountViewModel.cs:32 |
| EQUITY | balance + credit + floating | green if equity ≥ balance, else red | :33 |
| OPEN P/L | floating | green ≥ 0 | :34 |
| MARGIN USED | hedged used margin | default | :35 |
| FREE MARGIN | equity − used | red if < 0 | :36 |
| DAY P/L | realized today (UTC) + whole floating | green ≥ 0 | :37 |
| WEEK P/L | realized since Monday UTC + whole floating | green ≥ 0 | :38 |
| gauge left "MARGIN n%" | used / equity clamped 0–100 % | red when level ≤ call level | :39-41, 45 |
| gauge right "LEVEL n% · CALL n%" | margin level; group marginCallLevel from /me | – | :42-44 |
Stop-out level is not shown (not in /me, W\app\api\trade\me\route.ts:33, 42). Currency / group / mode are deliberately hidden (HeaderRight = "", :31); `currency`, `accountMode`, `groupName` parameters are passed but unused except `Currency` (:30).
Top bar: ACCOUNT = "<accountNumber> <accountMode>"; EQUITY USD = LastSummary.Equity, green when ≥ 0; MARGIN LVL = level % or "—" (T\Services\MarketDataService.cs:1289-1300; TopBar.axaml:80-96).

## E. Text
- "EQUITY USD" is a hard-coded label (T\Views\TopBar.axaml:89) whatever the account currency.
- Pre-live fixture shows "MARGIN USED 38%" / "STOP-OUT 20%" literals (AccountPanel.axaml:65-66); the live gauge has no stop-out.
- Panel number `6)` (AccountPanel.axaml:11) vs the ViewModel doc "7) ACC panel" (AccountViewModel.cs:7).
- "DAY P/L" / "WEEK P/L" labels (AccountViewModel.cs:17) do not say they include the full current floating P/L and use UTC boundaries.
- Credit rendering "(+−50.00 credit)" when credit is negative (AccountViewModel.cs:32 prefixes "+" before Money(), which prints "−").

## F. UI structure map
- Location: right column, bottom row (below order ticket / STM), height from splitter (T\MainWindow.axaml:46-48; LayoutRightBottomHeight).
- Header: PanelTitleBar Number "6)", Code "ACC", Sub "ACCOUNT"; header-right text bound to HeaderRight (always "" when live) (AccountPanel.axaml:11-15).
- Body (live): 7 rows, label left (muted 11.5) / value right (semibold, up/down/default colour), 1 px separators, order: BALANCE, EQUITY, OPEN P/L, MARGIN USED, FREE MARGIN, DAY P/L, WEEK P/L (AccountViewModel.cs:15-18). Under them: gauge caption left "MARGIN n%" (red when warn, else dim), right "LEVEL n% · CALL n%"; 5 px bar, fill = used/equity, amber (red when warn) (AccountPanel.axaml:33-43; AccountPanel.axaml.cs:21-27).
- No table, no selection, no row click / double-click, right-click on panel: NO, no buttons, no dropdowns, no tabs.
- Top bar right cells (left→right): ACCOUNT, EQUITY USD, MARGIN LVL, THEME, USER ▾, caption buttons (TopBar.axaml:77-120).

## Issues
- [money] term-account · equity / open P/L / margin / free margin / level ignore the quote→account FX rate the server applies; wrong for any symbol not quoted in the account currency (e.g. USDJPY on a USD account), while DAY/WEEK realized parts come from the server already converted · S\Trading\AccountMath.cs:67-78 vs W\lib\margin.ts:67-74
- [money] term-account · stop-out level is not shown anywhere (me route returns only marginCallLevel); the gauge warns only at margin call · W\app\api\trade\me\route.ts:33,42; T\ViewModels\AccountViewModel.cs:42-45
- [ux] term-account · EQUITY shows green whenever equity ≥ balance, so with credit it is green while the account is losing up to the credit amount · T\ViewModels\AccountViewModel.cs:33
- [ux] term-account · DAY P/L and WEEK P/L each include the entire floating P/L of positions opened days earlier, and use UTC day/week boundaries · T\Services\MarketDataService.cs:1614-1615; S\Trading\AccountMath.cs:89-94
- [functional] term-account · balance/credit refresh only on trading events, sign-in and F7; with the event stream down a deposit/adjustment is not reflected (no /me poll) · T\Services\MarketDataService.cs:281, 1083-1085
- [functional] term-account · /api/trade/history returns every closed trade with no limit and is refetched on every fill/close event to compute DAY/WEEK · W\app\api\trade\history\route.ts:16-44; T\Services\MarketDataService.cs:277
- [text] term-account · "EQUITY USD" hard-coded regardless of account currency · T\Views\TopBar.axaml:89
- [text] term-account · negative credit renders "(+−x credit)" · T\ViewModels\AccountViewModel.cs:32

## Status counts
`STATUS-COUNTS app=terminal screen=ACC WORKS=1 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
