# term-hotkeys-sounds · Trader terminal · hotkeys (F-keys, order hotkeys, chart keys), sounds, notifications/toasts, journal (LOG tab)

Path prefixes: `T\` = E:\vyxtrader\src\Vyx.Trader.App\ · `S\` = E:\vyxtrader\src\Vyx.Shared\ · `SU\` = E:\vyxtrader\src\Vyx.Shared.Ui\ · `W\` = D:\VyXTrader-Tauri\vyX\. Commits: E: 1c8b0d3, D: 74b3c02.

## A. Purpose + panels
- F-key router: keyboard F1–F12 on the main window and the clickable F-key strip on the status bar share one router `RouteFKey` (T\MainWindow.axaml.cs:256-258, 299-318; T\Views\StatusBar.axaml.cs:15-18).
- Order hotkeys: BUY HOTKEY / SELL HOTKEY fields in the Smart Trade Manager block of the order ticket; active only while the STM is ENABLED (per session) (T\MainWindow.axaml.cs:90-121, 260-266, 329-337).
- Chart keys: Esc (drop tool/selection), Delete (remove selected drawing) (SU\Charting\ChartHost.cs:169-175).
- Sounds: synthesized winmm tones, `SoundService` (S\Audio\SoundService.cs:22-150). No UI control.
- Notifications: no toast system. Feedback surfaces = chart action line (3 s, SU\Charting\ChartHost.cs:73-80; SU\Charting\ChartPanel.axaml:240-242), per-row notices in the positions table (T\ViewModels\DockViewModels.cs:160), the LOG tab (journal).
- Journal: LOG tab of the bottom dock (T\Views\PositionsPanel.axaml:433-459), in-memory, local entries merged with the server audit feed.

## B. Data
| Panel | Source | ApiClient | Route handler | Refresh | Notes |
|---|---|---|---|---|---|
| LOG tab, server rows | GET /api/trade/audit | `FetchAuditAsync` S\Api\ApiClient.cs:354-365 | W\app\api\trade\audit\route.ts:16-48 (AuditLog rows whose old/new value accountNumber = this account, take 100, `time` = HH:MM:SS only, :36, :43) | once, at sign-in only (T\Services\MarketDataService.cs:1075; only caller of RefreshAuditAsync :320) | server time has no date; client stamps it today, or yesterday if ahead of now (T\ViewModels\DockViewModels.cs:310-317) → rows older than 24 h show a wrong date |
| LOG tab, local rows | `Journal()` T\Services\MarketDataService.cs:312-318 | – | – | live, on each event: own actions, stream state (:233, :256), trading events (:272), sign in/out (:1082, :1019), REJECTED lines (T\MainWindow.axaml.cs:58) | capped 200 rows in view (:316); backing `_journal` list is never trimmed (:181, :314); nothing persisted to disk |
| Trading events → journal/sound | gateway trading event stream `TradingEventStreamClient` (S\Api\TradingEventStreamClient.cs) | – | gateway (not in app/api) | push | label map T\Services\MarketDataService.cs:285-308 |
| Action line | `Vm.ActionResult` | – | – | set per action, cleared after 3 s (SU\Charting\ChartHost.cs:74-80) | failures also vanish after 3 s |
Empty/loading/error: LOG tab has no empty text; audit fetch failure is silent (MarketDataService.cs:324).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F1 HELP | key / status cell (T\ViewModels\MainViewModel.cs:47) | status cell: live only (StatusBar.axaml:28) | always | none | none | – | no | no | none | action line: "F1 HELP · F2 watch search · F3 chart single · F4 ticket · F5 positions · F6 log · F7 account refresh · F11 layout single/grid" (MainWindow.axaml.cs:304) | WORKS |
| F2 WATCH | same | same | always | none | none | – | no | no | none | focuses Market Watch search (:305) | WORKS |
| F3 CHART | same | same | always | none | none | – | no | no | none | single-chart mode + focus (:306) | WORKS |
| F4 TICKET | same | same | always | none | none | – | no | no | none | focuses ticket VolumeBox (:307) | WORKS |
| F5 POSITIONS | same | same | always | none | none | – | no | no | none | dock tab POS (:308) | WORKS |
| F6 NEWS | same | same | always | GET /api/trade/news (`FetchCalendarAsync` ApiClient.cs:167) | none | – | no | no | none | refreshes the always-visible 5) ECO panel; line "F6 · calendar refreshed" (:309) | WORKS |
| F7 ACCOUNT | same | same | always | GET /api/trade/me (`FetchAccountAsync` ApiClient.cs:140; W\app\api\trade\me\route.ts:5) | none | – | no | no | none | account panel recomputed (MarketDataService.cs:1579-1586) | WORKS |
| F8 ALERTS | same | same | live (else "FAILED · sign in first") | opens AlertsWindow (MainWindow.axaml.cs:436-441) | – | – | – | – | none | modal | WORKS |
| F9 NEW ORDER | same | same | live | opens NewOrderWindow (:385-392) | – | – | – | – | none | modal | WORKS |
| F10 REPORTS | same | same | always | none | none | – | – | – | – | "F10 · reports (coming soon)" (:313) | PLACEHOLDER |
| F11 LAYOUT | same | same | always | none | none | – | no | no | none | toggles single / grid 2×2 (:314) | WORKS |
| F12 SETTINGS | same | same | always | opens SettingsWindow (:315, 428-434) | – | – | – | – | none | modal (term-settings.md) | WORKS |
| BUY HOTKEY field | T\Views\OrderTicketPanel.axaml:402-407 | live (STM block :369) | STM ENABLED (hit-test off otherwise, :378) | none | none | client: parsed gesture; bare F1–F12, Esc, Enter, Tab, Delete, Space, Backspace and the other hotkey refused (MainWindow.axaml.cs:102-111); captured by key press (OrderTicketPanel.axaml.cs:37-51) | no | no | none | settings.json `BuyHotkey`, action line "hotkeys: buy …, sell …" (MainWindow.axaml.cs:116-119) | WORKS |
| SELL HOTKEY field | OrderTicketPanel.axaml:408-413 | same | same | none | none | same | no | no | none | settings.json `SellHotkey` | WORKS |
| Pressing the buy/sell hotkey | anywhere in the main window except a TextBox | – | live AND STM ENABLED (MainWindow.axaml.cs:262) | `PlaceTicketOrderAsync` → POST /api/trade/orders (ApiClient.cs:296-303; W\app\api\trade\orders\route.ts:66) MARKET, ticket lots/SL/TP | order + position (see term-ticket.md) | client: ticket PrepareOrder (lots, tick rounding, SL/TP side); server: order route | NO (never, regardless of ConfirmTicketOrders, :326-336) | no | none | journal "Hotkey BUY · …"; origin "Ctrl+2 hotkey"-style tooltip (:333-335); numpad digit also fires a digit hotkey (:572-578) | WORKS |
| STM ENABLED / DISABLED chip | OrderTicketPanel.axaml:373-375 | live | always | none | none | – | no | no | none | action line "Smart Trade Manager ON · hotkeys live" / "… OFF"; not persisted, OFF each launch (MainWindow.axaml.cs:90, 97) | WORKS |
| Esc | chart | – | not in TextBox, no confirm open | none | none | – | no | – | – | drops drawing tool / selection (ChartHost.cs:171-172) | WORKS |
| Delete | chart | – | a drawing selected | none | none (local drawings file) | – | no | – | – | "<Kind> removed" (ChartHost.cs:173) | WORKS |
| LOG tab | dock tab strip (T\ViewModels\DockViewModels.cs:18) | always | always | none (see B) | none | – | – | – | – | shows journal | WORKS |
| LOG header right-click column picker | PositionsPanel.axaml:435 → PositionsPanel.axaml.cs:208-214, 221-230 | LOG tab | right button | none | none | – | – | – | – | TIME / SRC / MESSAGE show/hide, persisted TableColumns["log"] | WORKS |

Sounds (no controls; what plays, all S\Audio\SoundService.cs tones):
| Trigger | Sound | Evidence |
|---|---|---|
| price feed established (min gap between chimes) | Connected (C-E-G) | T\Services\MarketDataService.cs:238-246 |
| trading event OrderFilled | TradeOpened | :273 |
| PositionClosed / PositionsClosed (incl. SL/TP/stop-out) | TradeClosed (same tone for all reasons) | :274 |
| order POST failed INSUFFICIENT_MARGIN / INSUFFICIENT_BALANCE | MarginReject | :1748 |
| order POST failed INVALID_VOLUME | InvalidVolume | :1749 |
| any other order failure / rejected reason in 2xx | OrderRejected | :1750, :1755 |
| AlertTriggered, OrderRequoted, DealingQueued, OrderCancelled, stop-out warning | NONE | :272-282 (no Play) |
Mute: `SoundService.Enabled` default true (SoundService.cs:26), never set by the terminal; server `soundsEnabled` modelled but unread (S\Charting\ChartVisualSettings.cs:27).

## D. Dialogs
No dialog. Stored fields: `BuyHotkey`, `SellHotkey` (settings.json, default "", T\Services\TerminalSettings.cs:55-56) READ BY T\MainWindow.axaml.cs:94-96, 121, 264-265. Hotkeys saved by the 1.0.7 parser are wiped to "" on launch when they parse to Cancel/Back/None (:93-95).

## E. Text
- F1 help "… F6 log …" (T\MainWindow.axaml.cs:304): F6 refreshes the calendar, status cell says "NEWS" (MainViewModel.cs:48); there is no log hotkey. F1 help omits F8, F9, F10, F12.
- Hotkey hint "set hotkey: 1, b, F9, Ctrl+Shift+B…" (T\ViewModels\MainViewModel.cs:67): F9 is refused ("F9 already opens a panel", MainWindow.axaml.cs:107).
- Design-fixture F-key strip shows "F9 BOTS" (MainViewModel.cs:132) vs live "F9 NEW ORDER" (:48).
- "F10 · reports (coming soon)" (MainWindow.axaml.cs:313).
- Code comment "default Ctrl+1 = BUY / Ctrl+2 = SELL … the same validated + confirmed path as the ticket buttons" (MainWindow.axaml.cs:260-261): default is unset (TerminalSettings.cs:55-56) and hotkeys never confirm (:326-328).
- Journal SRC column mixes "local", "order", "event", "server" (MarketDataService.cs:312, 272; MainWindow.axaml.cs:58).
- Journal event labels: "Dealer requoted (XAUUSD): offered 4456.10 — accept or reject in PENDING" (MarketDataService.cs:295), "Account settings updated by the broker" (:305); unknown event types print the raw type name (:306).

## F. UI structure map
- Status bar (bottom, 26 px): left→right: connection dot + text (StatusBar.axaml:9-14); UTC clock (live); sessions text + update pill (live) (:16-27); spacer; F-key strip right-aligned: F1 HELP · F2 WATCH · F3 CHART · F4 TICKET · F5 POSITIONS · F6 NEWS · F7 ACCOUNT · F8 ALERTS · F9 NEW ORDER · F10 REPORTS · F11 LAYOUT · F12 SETTINGS (key amber bold + label muted; MainViewModel.cs:45-50). Live strip cells are clickable (hand cursor); pre-live fixture strip is not (StatusBar.axaml:45-62). Right-click on status bar: NO.
- STM hotkey rows (order ticket, right column, below SL/TP rows): "BUY HOTKEY" [84 px box, watermark "set hotkey", tooltip "Press a key"], "SELL HOTKEY" [same], hint line (9 pt dim) (OrderTicketPanel.axaml:402-416). Greyed and not clickable while STM DISABLED (:378).
- LOG tab (bottom dock, 6th tab after POS, PENDING, ORDERS, HISTORY, BALANCE): table columns in order TIME (120) · SRC (60) · MESSAGE (600) (T\ViewModels\TableLayout.cs:170-171). Not sortable; order = newest first. Selection: none. Row click / double-click / Enter: nothing. Per-row buttons: none. Right-click on row: NO. Right-click on column header: YES → menu "COLUMNS" (disabled header), separator, checkable items TIME, SRC, MESSAGE (stay open on click) (PositionsPanel.axaml.cs:221-230). Column widths drag-resizable (grip, PositionsPanel.axaml:443). Empty text: none. TIME shows HH:mm:ss today, "dd MMM HH:mm:ss" otherwise (DockViewModels.cs:305-306).
- Action line: bottom-left over the chart, bordered green (ok) / red (fail), auto-clears after 3 s (ChartPanel.axaml:240-242; ChartHost.cs:74-80).
- No toast / popup / OS notification anywhere in the terminal (no WindowNotificationManager or tray code in T\ or SU\).

## Issues
- [functional] term-hotkeys · price alert triggered = only a LOG line (no sound, no popup, no action line); a trader not on the LOG tab misses it · T\Services\MarketDataService.cs:272-278, 303
- [functional] term-sounds · sounds cannot be muted; server soundsEnabled / per-event sound flags (set from WebTrader) are ignored · S\Audio\SoundService.cs:26; S\Charting\ChartVisualSettings.cs:27
- [ux] term-sounds · requote, dealer queue, order cancelled, SL vs TP vs stop-out have no distinct or no sound (all closes = TradeClosed) · T\Services\MarketDataService.cs:273-274
- [functional] term-journal · server audit rows fetched only once at sign-in; never refreshed during the session · T\Services\MarketDataService.cs:1075, 320
- [functional] term-journal · server audit rows carry time without date; rows older than 24 h are shown with today's/yesterday's date and mis-sorted · W\app\api\trade\audit\route.ts:43; T\ViewModels\DockViewModels.cs:310-317
- [ux] term-journal · journal is memory-only (lost on exit/sign-out); backing list never trimmed · T\Services\MarketDataService.cs:181, 314
- [ux] term-hotkeys · order hotkeys send MARKET orders with no confirmation even when "Confirm ticket" is on · T\MainWindow.axaml.cs:326-336
- [ux] term-notifications · failure messages on the action line disappear after 3 s; no persistent error surface besides LOG · SU\Charting\ChartHost.cs:74-80
- [text] term-hotkeys · F1 help says "F6 log" (F6 = news/calendar) and omits F8/F9/F10/F12 · T\MainWindow.axaml.cs:304
- [text] term-hotkeys · hint suggests F9 as a hotkey, which the validator refuses · T\ViewModels\MainViewModel.cs:67; T\MainWindow.axaml.cs:107
- [text] term-hotkeys · F10 REPORTS shown in the live F-key strip but is "coming soon" · T\ViewModels\MainViewModel.cs:49; T\MainWindow.axaml.cs:313

## Status counts
`STATUS-COUNTS app=terminal screen=HOTKEYS-SOUNDS WORKS=19 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=0`
