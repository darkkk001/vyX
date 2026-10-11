# VYX-AUDIT-ALL part 5/9


<!-- ===== term-settings.md ===== -->

# term-settings · Trader terminal · Settings window (F12) + every TerminalSettings field

Path prefixes (all files): `T\` = E:\vyxtrader\src\Vyx.Trader.App\ · `S\` = E:\vyxtrader\src\Vyx.Shared\ · `SU\` = E:\vyxtrader\src\Vyx.Shared.Ui\ · `W\` = D:\VyXTrader-Tauri\vyX\. Commits: E: 1c8b0d3, D: 74b3c02.

## A. Purpose + panels
Modal "Settings" window (520x580, not resizable) for the trader's preferences. Four sections: CONFIRMATIONS, ACCOUNT, CHART, WORKSPACE, then a status line and CANCEL / SAVE.
Two storage places:
- local `%APPDATA%\VyxTrader\settings.json` (class `TerminalSettings`, T\Services\TerminalSettings.cs:12-97; path :74-79; Load :81-90; Save :92-96). One file per Windows user, NOT per account and NOT per install.
- server `Account.chartSettings` JSON (GET/PUT `/api/trade/chart-settings`, W\app\api\trade\chart-settings\route.ts:6-38), class `ChartVisualSettings` S\Charting\ChartVisualSettings.cs:10-30. Only `oneClickDefault` is edited from this window; the CHART APPEARANCE… button opens the separate chart appearance dialog that edits the rest of that document.
Opened only by F12 (keyboard) or the `F12 SETTINGS` status-bar cell (T\MainWindow.axaml.cs:315, 428-434). No menu entry.

## B. Data
| Panel | Source | ApiClient | Route handler | Refresh | Notes |
|---|---|---|---|---|---|
| Local flags (confirms, slippage, crosshair) | settings.json via `MarketDataService.Settings` (T\Services\MarketDataService.cs:203, loaded once per process) | – | – | on open (T\Views\SettingsWindow.axaml.cs:26-35) | corrupt file = every field silently back to defaults (TerminalSettings.cs:86-89); write is non-atomic `File.WriteAllText`, errors swallowed (:94-95) |
| 1-click default | `MarketDataService.Visual.OneClickDefault` = last GET /api/trade/chart-settings | `FetchChartSettingsAsync` S\Api\ApiClient.cs:402-409; save via `SaveChartSettingsAsync` ApiClient.cs:411-412 (PUT whole document) | GET route.ts:6-16, PUT route.ts:22-38 (whole-object replace merged over defaults, no field validation) | fetched once at sign-in (MarketDataService.cs:1053-1055) | if that GET failed, `Visual` is a default object with no `Extra`, so any later PUT (1-click, sessions, appearance) overwrites the server document with defaults (MarketDataService.cs:1054-1055, 1982-1983; ChartVisualSettings.cs:28-30) |
| Status line | local | – | – | on open: "Not signed in — server settings unavailable." when not live (SettingsWindow.axaml.cs:35) | |
Empty/loading/error: no loading state; save errors in the status line (SettingsWindow.axaml.cs:57, 60, 69-70).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| "Confirm ticket / New Order / dock closes before sending" checkbox | SettingsWindow.axaml:29 | always | always | none (settings.json on SAVE) | none | – | no | no | none | read by MainWindow.axaml.cs:130 (close), 161 (partial), 206 (cancel order), 361 (ticket), 611 (STM partial), 639-641 (STM close profit/loss/all); NewOrderWindow.axaml.cs:66 | WORKS |
| "Confirm chart right-click orders" | SettingsWindow.axaml:30 | always | always | none | none | – | no | no | none | read by MainWindow.axaml.cs:276-281 (chart order at price) | WORKS |
| "Confirm SL/TP drags and inline edits" | SettingsWindow.axaml:31 | always | always | none | none | – | no | no | none | read by MainWindow.axaml.cs:476 (drag / table edit), 158 + 627 (break-even), ModifyPositionWindow.axaml.cs:69, SmartRulesWindow.axaml.cs:133 | WORKS |
| "Confirm price alerts" | SettingsWindow.axaml:32 | always | always | none | none | – | no | no | none | read by MainWindow.axaml.cs:282-287 (chart alert), AlertsWindow.axaml.cs:78 (add), :85 (cancel) | WORKS |
| "Slippage max (points · M = unlimited)" text box (watermark "M") | SettingsWindow.axaml:33-36 | always | always | none | none | client: blank/"M"/"MAX" = 0 = unlimited; else number ≥ 0 (SettingsWindow.axaml.cs:52-57). Server: order route reads `maxSlippagePips` (W\app\api\trade\orders\route.ts:94) | no | no | none | settings.json `DefaultSlippagePts`; SaveSettings re-applies to ticket (MarketDataService.cs:1513-1518, 1521-1526) | PARTIAL (the number is a floor, not the max: effective = max(setting, 2 basis points of price) S\Trading\OrderValidation.cs:68-75, e.g. XAUUSD ~4456 → ≥ 89 points whatever is typed) |
| "I understand — apply this slippage limit" checkbox + amber warning | SettingsWindow.axaml:37-40 | field holds a number > 0 (SettingsWindow.axaml.cs:96-97) | always | none | none | SAVE refused without it when limit > 0 (SettingsWindow.axaml.cs:59-60) | – | no | none | not stored (derived: pre-ticked when a limit exists, :32) | WORKS |
| "1-click trading ON by default (skips only the human confirm)" | SettingsWindow.axaml:42 (section ACCOUNT) | always | always | on SAVE, only if live and changed: `SetOneClickAsync` MarketDataService.cs:1980-1988 → PUT /api/trade/chart-settings (ApiClient.cs:411) | writes `Account.chartSettings` (route.ts:33-36); no audit | none / none | no | no | none | read by MainWindow.axaml.cs:344 (`Confirm(!Vm.OneClick, …)` one-click widget), web W\components\webtrader\WebTrader.tsx:832 | DUPLICATE (chart one-click widget toggle `OcToggle` SU\Charting\ChartPanel.axaml:200 → MainWindow.axaml.cs:81, 349-353, same PUT) |
| "Crosshair sync across the 2×2 grid" | SettingsWindow.axaml:44 | always | always | none | none | – | no | no | none | settings.json `CrosshairSync`; read by SU\Charting\ChartHost.cs:107 via Vm (MarketDataService.cs:218-222, 1516) | DUPLICATE (chart layout flyout checkbox "Crosshair sync (grid)" SU\Charting\ChartPanel.axaml:36-38, saved immediately MarketDataService.cs:221) |
| CHART APPEARANCE… button (amber text) | SettingsWindow.axaml:45-47 | always | always | opens ChartSettingsWindow (MainWindow.axaml.cs:431, 463; SU\Charting\ChartHost.cs:243-251); its SAVE = PUT /api/trade/chart-settings (MainWindow.axaml.cs:59) | `Account.chartSettings` | none / none | no | no | none | second modal on top of Settings; applies via ApplyVisual (MarketDataService.cs:2063-2069) | WORKS |
| RESET GRID SYMBOLS button | SettingsWindow.axaml:49-51 | always | always | none | none | – | no | no | none | clears `GridSymbols[]`, saves settings.json immediately (SettingsWindow.axaml.cs:41-46) even if CANCEL follows | PARTIAL (no visible effect: GridDefaults.Reconcile keeps every cell's current offered symbol (S\Charting\GridDefaults.cs:38) and the next reconcile/cell change writes the current cells back into GridSymbols (MarketDataService.cs:1135-1145); status text "cells re-default on the next reconcile" is therefore false) |
| SAVE (orange/primary) | SettingsWindow.axaml:24 | always | always | settings.json + optional PUT chart-settings | see rows above | see rows | no | no | none | closes on success; stays open with "server FAILED: …" on PUT error (SettingsWindow.axaml.cs:66-73) | WORKS |
| CANCEL | SettingsWindow.axaml:23 | always | always | none | none | – | no | no | none | closes, discards unsaved (except RESET GRID) | WORKS |
| "Sounds and keyboard remapping: coming soon." | SettingsWindow.axaml:52 | always | – | none | none | – | – | – | – | – | PLACEHOLDER |

## D. Dialog fields (Settings window + every other TerminalSettings field)
Settings window fields:
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| ConfirmTicketOrders | bool | true (TerminalSettings.cs:18) | settings.json | MainWindow.axaml.cs:130,161,206,361,611,639-641; NewOrderWindow.axaml.cs:66 | – |
| ConfirmChartOrders | bool | true (:15) | settings.json | MainWindow.axaml.cs:277 | – |
| ConfirmSlTpDrag | bool | true (:14) | settings.json | MainWindow.axaml.cs:158,476,627; ModifyPositionWindow.axaml.cs:69; SmartRulesWindow.axaml.cs:133 | – |
| ConfirmAlerts | bool | true (:16) | settings.json | MainWindow.axaml.cs:283; AlertsWindow.axaml.cs:78,85 | – |
| DefaultSlippagePts | double, 0 = unlimited | 0 → shown "M" (:36; SettingsWindow.axaml.cs:31) | settings.json | MarketDataService.cs:1454, 1524, 2054 via OrderValidation.DefaultSlippagePoints | ack checkbox visible when > 0 |
| OneClickDefault | bool | false (ChartVisualSettings.cs:26; W\lib\chart-settings.ts:129) | Account.chartSettings.oneClickDefault | MainWindow.axaml.cs:344 (native); WebTrader.tsx:832 (web) | saved only when signed in |
| CrosshairSync | bool | true (:38) | settings.json | ChartHost.cs:107 | – |

Other settings.json fields (no Settings-window control):
| Field | Default | Written by | READ BY |
|---|---|---|---|
| GridSymbols[4] / GridTimeframes[4] | null / "H1" (:22-23) | MarketDataService.cs:1138-1145 | MarketDataService.cs:838, 1121 |
| LastHost / LastAccount / LastAccountMode / RecentHosts / RememberMe | "" / "" / "" / [] / false (:25-31) | LoginWindow.axaml.cs:172-175; MainWindow.axaml.cs:691 | LoginWindow.axaml.cs:45-59, 71, 84-85; MainWindow.axaml.cs:689 (see term-session.md) |
| LayoutLeftWidth / RightWidth / BottomHeight / LeftBottomHeight / RightBottomHeight / StmHeight | 0 = design default (:41-43, 67-70) | splitter drags MainWindow.axaml.cs:665-681 | MainWindow.axaml.cs:653-657, 675 (ignored when env VYX_LAYOUT_DEFAULTS=1, :650) |
| ShowEma | false (:45) | chart EMA chip MainWindow.axaml.cs:55 | MainWindow.axaml.cs:41 |
| ShowOneClickPanel | true (:47) | MainWindow.axaml.cs:56 | MainWindow.axaml.cs:40 |
| MwShowSpread / MwShowHighLow | true / false (:48-49) | MainWindow.axaml.cs:226 | MainWindow.axaml.cs:223 |
| MwShowChange | true (:50) | nowhere | nowhere (dead field) |
| StmEnabled | false (:53) | nowhere | nowhere; STM forced OFF each launch (MainWindow.axaml.cs:90) |
| BuyHotkey / SellHotkey | "" (:55-56) | MainWindow.axaml.cs:117-118 | MainWindow.axaml.cs:94-96, 121 (see term-hotkeys-sounds.md) |
| TradeComments | {} (:58) | MarketDataService.cs:2032 | MarketDataService.cs:2027 (local only, never sent to server) |
| PositionColumns | {} (:60) | nowhere | nowhere (dead field, superseded by TableColumns) |
| TableColumns | {} (:62) | MainWindow.axaml.cs:145; MarketDataService.cs:2009 | MarketDataService.cs:2007 |
| TradeOrigins | {} (:65) | MarketDataService.cs:2018 | MarketDataService.cs:472 (grows forever, no pruning) |
| Theme | "light" (:72) | ThemeService.cs:28 (TopBar THEME cell, login ☾/☀) | App.axaml.cs:20 (web's `theme` in chart-settings is not read) |

Server chart-settings fields the terminal models but never reads: `soundsEnabled` (ChartVisualSettings.cs:27; no reader in E:\vyxtrader\src). Fields it does not model (`theme`, `soundOrderFilled` … `soundError`, `timezone`) ride in `Extra` and are written back unchanged (ChartVisualSettings.cs:28-30).

## E. Text
- "Confirm ticket / New Order / dock closes before sending" (SettingsWindow.axaml:29): also governs cancel order, partial close and STM bulk closes; it does NOT govern close-by, dock close-filter, reverse, withdraw-close, which always confirm (MainWindow.axaml.cs:136, 138, 168, 176).
- "Confirm SL/TP drags and inline edits" (:31): also governs break-even (MainWindow.axaml.cs:158, 627; SmartRulesWindow.axaml.cs:133).
- Section "ACCOUNT" (:41) holds only the 1-click checkbox, a trading preference.
- "Slippage max (points · M = unlimited)" (:34): the value is a minimum floor (OrderValidation.cs:74).
- "Sounds and keyboard remapping: coming soon." (:52): order hotkeys are already configurable in the STM block (OrderTicketPanel.axaml:402-412) and sounds already play (term-hotkeys-sounds.md).
- "Remembered grid symbols cleared (cells re-default on the next reconcile)." (SettingsWindow.axaml.cs:45): false, see RESET GRID row.
- Class doc "for now the two flags that gate real server actions" (TerminalSettings.cs:7-8) is stale (30 fields).

## F. UI structure map
- Window: title "Settings", 520x580, CanResize=False, centred on owner, modal (SettingsWindow.axaml:7-8; MainWindow.axaml.cs:433). No header code, no KPI strip.
- Layout top→bottom, left-aligned, 16 px margin:
  1. "CONFIRMATIONS" (section label) → 4 checkboxes in order: "Confirm ticket / New Order / dock closes before sending", "Confirm chart right-click orders", "Confirm SL/TP drags and inline edits", "Confirm price alerts"; row "Slippage max (points · M = unlimited)" + right-aligned 90 px box (watermark "M"); when a number > 0: amber "⚠ With market volatility or price movement, your entries/orders may be rejected." + checkbox "I understand — apply this slippage limit".
  2. "ACCOUNT" → checkbox "1-click trading ON by default (skips only the human confirm)".
  3. "CHART" → checkbox "Crosshair sync across the 2×2 grid"; bordered button "CHART APPEARANCE…" (amber text).
  4. "WORKSPACE" → bordered button "RESET GRID SYMBOLS" (muted text).
  5. dim note "Sounds and keyboard remapping: coming soon."
  6. bottom dock: status text (wrap); right-aligned buttons in order CANCEL (outlined), SAVE (orange fill = primary).
- Tables: none. Right-click anywhere: NO context menu. Dropdowns / chips / tabs: none.
- Keyboard: no Enter/Esc bindings on the window (buttons are Borders with PointerPressed, SettingsWindow.axaml:23-24).
- Chart appearance dialog (opened from here): sections CANDLES (6 colours: Up body, Down body, Up border, Down border, Up wick, Down wick), DISPLAY (Grid lines, Last-price line, Previous day high/low (PDH/PDL), Session map (Asia/London/NY), OHLC info bar), Timezone "UTC" (fixed), CANCEL / SAVE (SU\Charting\ChartSettingsViewModel.cs:38-48; ChartSettingsWindow.axaml:13-51).

## Issues
- [functional] term-settings · RESET GRID SYMBOLS has no effect: Reconcile keeps current cells and rewrites GridSymbols from them; also persists even on CANCEL · T\Views\SettingsWindow.axaml.cs:41-46; S\Charting\GridDefaults.cs:38; T\Services\MarketDataService.cs:1135-1145
- [functional] term-settings · "Slippage max" is a floor: effective limit = max(typed points, 2 bp of price), typed small limits are ignored · S\Trading\OrderValidation.cs:68-75
- [functional] term-settings · when GET chart-settings fails at sign-in, any later PUT (1-click toggle, sessions chip, appearance SAVE) replaces the account's server document with defaults, wiping web theme/sound prefs · T\Services\MarketDataService.cs:1053-1055, 1982-1983; W\app\api\trade\chart-settings\route.ts:32-36
- [functional] term-settings · server `soundsEnabled` (and per-event sound flags) are ignored by the terminal; sounds cannot be muted · S\Charting\ChartVisualSettings.cs:27; S\Audio\SoundService.cs:26 (Enabled never set)
- [ux] term-settings · settings.json is per Windows user, not per account: confirms/slippage/hotkeys/comments/origins carry across accounts and brokers on the same PC · T\Services\TerminalSettings.cs:74-79
- [ux] term-settings · corrupt settings.json silently resets every preference (and remember-me) to defaults; save is non-atomic with swallowed errors · T\Services\TerminalSettings.cs:86-95
- [ux] term-settings · 1-click default and crosshair sync each have two controls (Settings + chart) · T\Views\SettingsWindow.axaml:42,44; SU\Charting\ChartPanel.axaml:36,200
- [ux] term-settings · Settings reachable only via F12 / status-bar cell, no menu entry · T\MainWindow.axaml.cs:315
- [functional] term-settings · PUT /api/trade/chart-settings accepts any object with no field validation (whole-object replace) · W\app\api\trade\chart-settings\route.ts:27-36
- [text] term-settings · "Sounds and keyboard remapping: coming soon." while hotkeys and sounds exist · T\Views\SettingsWindow.axaml:52
- [text] term-settings · confirm labels do not match what they gate (ticket flag covers cancel/partial/STM; SL/TP flag covers break-even; close-by/reverse always confirm) · T\Views\SettingsWindow.axaml:29,31; T\MainWindow.axaml.cs:136,138,158,176
- [text] term-settings · dead settings fields MwShowChange, PositionColumns, StmEnabled kept in file · T\Services\TerminalSettings.cs:50,53,60
- [ux] term-settings · TradeOrigins / TradeComments grow without pruning of closed positions · T\Services\MarketDataService.cs:2018,2032

## Status counts
`STATUS-COUNTS app=terminal screen=SETTINGS WORKS=8 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=2`


<!-- ===== term-hotkeys-sounds.md ===== -->

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


<!-- ===== term-session.md ===== -->

# term-session · Trader terminal · launch gate, single instance, sign-in window, remember-me, sign-out / switch account, auto-update

Path prefixes: `T\` = E:\vyxtrader\src\Vyx.Trader.App\ · `S\` = E:\vyxtrader\src\Vyx.Shared\ · `SU\` = E:\vyxtrader\src\Vyx.Shared.Ui\ · `W\` = D:\VyXTrader-Tauri\vyX\. Commits: E: 1c8b0d3, D: 74b3c02.

## A. Purpose + panels
Launch order (normal build): `Program.Main` → Velopack hooks (T\Program.cs:34) → single-instance lock (T\Program.cs:177) → Avalonia → `App.OnFrameworkInitializationCompleted`: theme from settings.json (T\App.axaml.cs:20) → single-instance activation listener (:32-39) → StartupGate (:43) → refusal window (:44-50) or MainWindow created hidden + LoginWindow shown (:51, 64-75) → on SignedIn the terminal window is shown and the login closed (:70-75).
Panels: StartupGate refusal window; Sign-in window (backdrop terminal + centred card: sign-in form or forgot-password form, update banner, version); in the terminal: USER ▾ menu (switch / sign out / sign out and forget), THEME cell, status-bar update pill.

### Why do sign-out and switch-account close the whole app? (answer)
1. Both menu items run the same method `SignOutAsync(forget)`: Switch account… → `SignOutAsync(false)` (T\MainWindow.axaml.cs:238); Sign out → `SignOutAsync(false)`, Sign out and forget → `SignOutAsync(true)` (:243-244).
2. `SignOutAsync` does not return to the login page in-process. By design it relaunches the exe and shuts this process down: `Process.Start(exe)` (T\MainWindow.axaml.cs:692-693) then `IClassicDesktopStyleApplicationLifetime.Shutdown()` (:694). The doc comment says "relaunch into the sign-in page (a fresh process is the clean way …)" (:684-686). Server session is revoked first (:690 → T\Services\MarketDataService.cs:1011-1019 → S\Api\ApiClient.cs:130-133 → W\app\api\trade\logout\route.ts:11-13).
3. The relaunched child hits the single-instance guard in `Main`: `if (!devFixtureWindow && !SingleInstance.TryAcquire("VyxTrader")) return;` (T\Program.cs:177). The parent still owns the named mutex `Local\Vyx.SI.<hash(appId|installDir)>` — it is created owned in TryAcquire and held (never released) for the whole process lifetime (SU\SingleInstance.cs:17, 30-33). `Process.Start` runs BEFORE `Shutdown()`, and `Shutdown()` does not end the process synchronously, so the child finds `createdNew == false`, signals the parent's activation event (SU\SingleInstance.cs:34) and returns false → the child exits without a window (T\Program.cs:177).
4. The parent then finishes its shutdown (T\MainWindow.axaml.cs:694; window Closed → `Market.Dispose()` :288). Net effect: no process is left; the user sees the whole app close.
5. Regression source (git): relaunch-on-sign-out came with commit dc6c798 (2026-09-11, "Login: real sign-in page … sign out"); the single-instance guard came later with d523a4c (2026-09-17, "single-instance: second launch surfaces the running window and exits"). The two were never reconciled.
6. Runtime: UNVERIFIED by launch (brief forbids launching). The code path is deterministic unless the parent process fully exits before the child reaches T\Program.cs:177 (only then would the child win the mutex).
7. Secondary effect even if the relaunch succeeded: "Sign out" and "Switch account…" keep the stored remember-me session cookie (only "forget" deletes it, :691) but the server session behind it was just revoked (W\app\api\trade\logout\route.ts:11-13; W\lib\account-auth.ts:155-157, :139 reads Redis), so the next launch's auto-resume fails with "Session expired — sign in again." (T\Views\LoginWindow.axaml.cs:85-88, 202-203). The confirm texts "Saved credential kept." (MainWindow.axaml.cs:238, 243) are therefore inaccurate.

## B. Data
| Panel | Source | ApiClient | Route handler | Refresh | Notes |
|---|---|---|---|---|---|
| StartupGate (broker builds only) | GET https://<DefaultHost>/api/client/manifest?slug&app=terminal&buildId (ECDSA-signed) | `ClientManifestVerifier.FetchAsync` S\Client\ClientManifest.cs:31-45 (12 s timeout :35) | W\app\api\client\manifest\route.ts:11-35 (status from ClientBuild row; UNKNOWN for unknown builds; exp = now + 24 h :30) | once per launch (SU\StartupGate.cs:20-33) | fail-closed: network error / 429 / 503 → refusal "This installation could not be verified with your broker (…)" (:27); REVOKED / not ACTIVE → refusal (:29-30); OK → `ApiClient.LockedHost = manifest.apiHost` (:31). Dev builds pass (:23) |
| Sign-in prefill | settings.json LastHost / LastAccount / LastAccountMode / RecentHosts / RememberMe | – | – | on window open (LoginWindow.axaml.cs:44-71) | broker build: host forced to LockedHost, box disabled, recent hosts hidden (:77-82) |
| Remember-me resume | Windows Credential Manager target "…session:<host>" (T\Services\CredentialStore.cs:20-49, CRED_PERSIST_LOCAL_MACHINE :18,33) → GET /api/trade/me with the saved cookie | `FetchAccountInfoAsync` ApiClient.cs:136 | W\app\api\trade\me\route.ts:5 | on open when RememberMe && account matches (LoginWindow.axaml.cs:85-89; MarketDataService.cs:982-989) | legacy stored PASSWORD entry is deleted on every open (LoginWindow.axaml.cs:84) |
| Sign in | POST /api/trade/login {accountNumber, password, remember:true, accountMode?} | `LoginAsync` ApiClient.cs:101-113 (called with remember = true always, MarketDataService.cs:963) | W\app\api\trade\login\route.ts:17-107 (build check 426 :42-43; 5/min rate limit :44; 401 / 403 / mode-mismatch 400 :61-80; 2FA pending :88-91; session cookie :98-105) | on click / Enter | writes session (Redis), LoginEvent + AuditLog via completeAccountLogin (W\lib\account-auth.ts:339-362) |
| 2FA | POST /api/trade/login/verify-2fa {pendingToken, code, remember:true} | `VerifyTwoFactorAsync` ApiClient.cs:116-121 | W\app\api\trade\login\verify-2fa\route.ts:17-86 (401 "login expired, please sign in again" :42/:64; 401 "invalid code" :69; lockout :52, :68) | on click | same session writes |
| Go live | symbols, chart-settings, broker-branding, prices, watchlist, /me, streams, positions, orders, history, audit, news, alerts | ApiClient.cs:151, 402, 177, 191, 162, 140 … | app/api/trade/* | once (MarketDataService.cs:1041-1087) | branding failure leaves header "FUTURIX" (T\ViewModels\MainViewModel.cs:33) |
| Forgot password | POST /api/trade/forgot-password {accountNumber, note} | `ForgotPasswordAsync` ApiClient.cs:125-126 | W\app\api\trade\forgot-password\route.ts:11-51 (3/h rate limit :24; creates Notification PASSWORD_RESET_REQUESTED only for an existing account :37-48; always {ok:true}) | on click | |
| Sign out | POST /api/trade/logout | `LogoutAsync` ApiClient.cs:130-133 (errors swallowed) | W\app\api\trade\logout\route.ts:4-22 (deletes Redis session, clears cookie) | on confirm | see answer above |
| Auto-update | Velopack feed = brand.json UpdateUrl or env VYX_UPDATE_SOURCE | `UpdateService` SU\UpdateService.cs:27-79; terminal subclass T\Services\UpdateService.cs:5 | static feed (not app/api) | login window open (LoginWindow.axaml.cs:66-70); on going live + every 6 h (T\MainWindow.axaml.cs:255) | download in background, arms apply-on-exit silently (SU\UpdateService.cs:58), then "UPDATE vX READY · click to restart" (:59) |
Loading / error texts (LoginWindow.axaml.cs): "Signing in to <host>…", "Verifying the code with <host>…" (:154); "Enter the broker server." / "Enter your account number." / "Enter your password." / "Enter the 6-digit code from your authenticator app." (:144-152); "Cancelled." / "Cannot reach <host>. Check the server name and connection." (:184); "Resuming your session…" (:87); "Session expired — sign in again." (:203); server mapping MarketDataService.cs:991-1006 ("Wrong account number or password.", "Too many sign-in attempts. Wait a minute and try again.", "This installation has been retired by your broker. Install the latest version.", …); 2FA failure always "Code not accepted — try the current one." for 400/401 (:975).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SERVER picker ▾ | LoginWindow.axaml:65-98 | sign-in form | !Busy | none (flyout) | none | – | no | no | none | flyout: "<Brand> — Live Server", "<Brand> — Demo Server", "Other server…", recent hosts | WORKS |
| "<Brand> — Live Server" / "— Demo Server" | :78-83 → LoginWindow.axaml.cs:94-101 | picker open | – | sets accountMode LIVE/DEMO for login | server rejects mode mismatch after the password (W\app\api\trade\login\route.ts:74-80) | server | no | no | none | host = brand DefaultHost | WORKS |
| "Other server…" | :85-86 | picker open (also in broker builds) | – | none | none | – | no | no | none | shows SERVER ADDRESS box; accountMode no longer sent | PARTIAL (broker build: host is locked and the box disabled (LoginWindow.axaml.cs:79-80; ApiClient.cs:50), so the item only drops the LIVE/DEMO check) |
| Recent host row | :88-92 | picker open, dev builds with history | – | none | none | – | no | no | none | host = row, server OTHER (LoginWindow.axaml.cs:102-108); max 8 kept (:173-174) | WORKS |
| SERVER ADDRESS box (watermark "broker.vyxtrader.com") | :100-103 | Other server | !Busy (disabled in broker builds) | none | none | normalised: strip http(s)://, trailing /, lowercase (:191-197) | – | – | – | – | WORKS |
| ACCOUNT NUMBER (watermark "e.g. 50005704") | :105-106 | sign-in form | !Busy | none | none | non-empty (:151) | – | – | – | – | WORKS |
| PASSWORD (Enter = sign in) | :108-109 | sign-in form | !Busy | as SIGN IN | – | non-empty (:152) | – | – | – | – | WORKS |
| AUTHENTICATOR CODE (6 digits, Enter = verify) | :111-114 | after a 2FA challenge | !Busy | POST /api/trade/login/verify-2fa | session + LoginEvent + AuditLog | ≥ 6 chars (:147) / server code + lockout | no | no | none | on success → terminal | PARTIAL (NeedsTwoFactor is never reset (only set at LoginWindow.axaml.cs:163): once the pending token expires the page cannot return to password entry; the expiry 401 is shown as "Code not accepted — try the current one." MarketDataService.cs:975) |
| "Remember me on this computer" (tooltip "Saved locally") | :117 | sign-in form | !Busy | none directly | none | – | no | no | none | on success saves the session cookie in Credential Manager or deletes it (LoginWindow.axaml.cs:177); settings.json RememberMe (:172) | PARTIAL (server session is always created with remember=true / long TTL whatever the box says (MarketDataService.cs:963, 974); plain "Sign out" keeps a cookie that logout already revoked, so resume always fails afterwards) |
| "Forgot password?" link | :118 | sign-in form | – | none | none | – | no | no | none | swaps to forgot form (:111) | WORKS |
| SEND REQUEST (orange) | :152-154 | forgot form, not yet sent | !Busy | POST /api/trade/forgot-password | Notification PASSWORD_RESET_REQUESTED (existing accounts only) | server selected + account non-empty (:121-122) / 3 per hour silent | no | no | none | "Reset request sent. Your broker will contact you." (:148) | WORKS |
| "← Back to sign in" | :151 | forgot form | – | none | none | – | – | – | – | back to form (:112) | WORKS |
| SIGN IN / VERIFY (orange, primary) | :130-132 | sign-in form | !Busy | POST /api/trade/login (or verify-2fa), then go-live GETs | Redis session, LoginEvent, AuditLog (account switch) | see texts in B | no | no | none | settings.json LastHost/LastAccount/RememberMe/LastAccountMode/RecentHosts (:171-175); terminal shown, login closed (App.axaml.cs:70-75) | WORKS |
| CANCEL | :127-129 | Busy | – | cancels the 12 s attempt token (:135, 155) | – | – | – | – | – | "Cancelled." | PARTIAL (does nothing during remember-me resume: `_attempt` is null there and ResumeAsync takes no token, LoginWindow.axaml.cs:85-88, 198-207) |
| ☾ / ☀ theme toggle | :58-60 | always | – | none | none | – | – | – | – | settings.json Theme (ThemeService.cs:28) | WORKS |
| Update banner "UPDATE vX READY · CLICK TO RESTART" | :158-160 | installed copy, update downloaded | – | Velopack ApplyUpdatesAndRestart (LoginWindow.axaml.cs:208; SU\UpdateService.cs:67-71) | none | – | NO | – | – | restarts into new version | WORKS |
| USER ▾ cell → "Switch account…" | T\Views\TopBar.axaml.cs:29-38 (item :34) | live | – | confirm "SWITCH ACCOUNT" / "Return to sign-in? Saved credential kept." → SignOutAsync(false) (MainWindow.axaml.cs:238) → POST /api/trade/logout | Redis session deleted | – | YES (always) | no | none | whole app exits (see answer) | PARTIAL (app closes instead of showing sign-in; identical code path to "Sign out") |
| USER ▾ → "Sign out" | TopBar.axaml.cs:35 | live | – | confirm "SIGN OUT" / "Sign out? Saved credential kept." → SignOutAsync(false) (:243-244) | Redis session deleted | – | YES | no | none | whole app exits; stored cookie now revoked | PARTIAL (app closes instead of showing sign-in) |
| USER ▾ → "Sign out and forget this computer" | TopBar.axaml.cs:36 | live | – | confirm "SIGN OUT AND FORGET" / "Sign out and remove the saved credential from this PC?" → SignOutAsync(true) | Redis session deleted | – | YES | no | none | Credential Manager entries deleted, RememberMe=false saved (MainWindow.axaml.cs:691); whole app exits | PARTIAL (app closes instead of showing sign-in) |
| Status-bar update pill | T\Views\StatusBar.axaml:22-25 → StatusBar.axaml.cs:14 | live AND (downloading or ready) (MainWindow.axaml.cs:253) | – | confirm "RESTART TO UPDATE" / "Restart into X? Open positions are unaffected; armed smart rules will be off." → ApplyAndRestart (:254) | none | – | YES | – | – | restart into new version | WORKS |
| THEME cell (☀ LIGHT / ☾ DARK) | TopBar.axaml:100-104 | always | – | none | none | – | – | – | – | settings.json Theme; charts redrawn (MainWindow.axaml.cs:236) | WORKS |
| Command line "FXG> SYMBOL description" | TopBar.axaml:22-28 | always | – | none | none | – | – | – | – | = F2, focuses watch search (MainWindow.axaml.cs:237) | WORKS |
| Caption buttons (min / max / close) | TopBar.axaml:120 (SU\CaptionButtons.axaml) | live | – | close = window close → Market.Dispose (MainWindow.axaml.cs:288) | none (no logout on close; server session stays valid until TTL) | – | no | – | – | app exits | WORKS |
| Refusal window CLOSE | SU\StartupGate.cs:41-42 | gate failed | – | none | none | – | no | – | – | app exits; installed copy first auto-checks the feed and restarts into a newer version if one exists (:56-65) | WORKS |

## D. Dialogs
Sign-in fields:
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| Server kind | LIVE/DEMO/OTHER | LastAccountMode=="DEMO" ? DEMO : LIVE; OTHER when LastHost ≠ brand host or no brand (LoginWindow.axaml.cs:51-58) | settings.json LastAccountMode ("" for OTHER) | login route accountMode check (W\app\api\trade\login\route.ts:30, 74-80) | – |
| Host | text | LastHost else brand DefaultHost; broker build: LockedHost (:51-57, 79) | settings.json LastHost, RecentHosts (≤ 8) | ApiClient.SetHost (ignored when LockedHost set, S\Api\ApiClient.cs:50) | shown only for OTHER |
| Account number | text | LastAccount (:59) | settings.json LastAccount | login route | – |
| Password | secret | "" | never stored | login route | – |
| Code | 6 chars | "" | never stored | verify-2fa route | after challenge |
| Remember me | bool | RememberMe (default false, TerminalSettings.cs:28) | settings.json RememberMe + Credential Manager "session:<host>" = (account, session cookie) | LoginWindow.axaml.cs:85 on next launch | – |
| Forgot note | text ≤ 500 | "" | Notification.body (forgot-password route :43) | backoffice notifications (not audited here) | forgot form |
Single instance: key = FNV-1a(appId "VyxTrader" + "|" + install dir, lowercased), scope Local\ (per Windows session) (SU\SingleInstance.cs:30-32, 65-70). Second launch → activates first window (T\App.axaml.cs:32-39). Fails open if handles are refused (:37-41). Harness `--dev-fixture-window` exempt (T\Program.cs:176-177).
Build identity: brand.json SHA-256 + BuildId pinned in assembly metadata; mismatch → refusal "brand.json build id does not match this executable." (S\Client\ClientIdentity.cs:37-60). Manifest field `minVersion` is always "" and not enforced (W\app\api\client\manifest\route.ts:30).

## E. Text
- "Return to sign-in? Saved credential kept." / "Sign out? Saved credential kept." (T\MainWindow.axaml.cs:238, 243): the app exits instead of returning to sign-in, and the kept session was revoked by the logout.
- "Switch account…" (TopBar.axaml.cs:34): there is no account switcher; it is the plain sign-out. Server has linked-accounts / sessions / change-password / two-factor routes (W\app\api\trade\linked-accounts, sessions, change-password, two-factor) that the terminal never calls (no such method in S\Api\ApiClient.cs).
- Tooltip "Saved locally" on Remember me (LoginWindow.axaml:117): it is the Windows Credential Manager, persisted per machine.
- "Code not accepted — try the current one." (MarketDataService.cs:975) also shown for an expired login challenge.
- Hard-coded broker text: command-line prefix "FXG> " (TopBar.axaml:23); default BrandName "FUTURIX" shown until/unless branding loads (MainViewModel.cs:33); XAML Title "Futurix Terminal PRO" (MainWindow.axaml:9, overwritten at MainWindow.axaml.cs:247).
- Placeholder "broker.vyxtrader.com" and "e.g. 50005704" (LoginWindow.axaml:102, 106).
- Refusal texts (SU\StartupGate.cs:27-30, 61-64): "This installation could not be verified with your broker (…). Check the connection or reinstall the official build." — shown for any network failure too.

## F. UI structure map
- Refusal window: 520x240, not resizable, dark fixed colours (not themed): product title (orange caps), message, progress line, "Build <id>", CLOSE button right (SU\StartupGate.cs:40-55).
- Sign-in window: title "<ProductTitle> — Sign in" (LoginWindow.axaml.cs:60); fitted to 1120x720 in the work area (:34). Backdrop (not clickable): top strip (logo square, PRODUCT TITLE, host text when OTHER), ticker tape, dimmed candle chart, footer "<ProductTitle> · sign in to start · dd MMM yyyy UTC" (LoginWindow.axaml:31-43; .cs:63). Centred 400 px card:
  - header: logo (or square) + PRODUCT TITLE (orange); right: theme toggle ☾/☀.
  - sign-in form: SERVER (picker ▾), [SERVER ADDRESS when Other], ACCOUNT NUMBER, PASSWORD, [AUTHENTICATOR CODE after challenge], row: checkbox "Remember me on this computer" | link "Forgot password?"; red error box; muted status line; buttons: CANCEL (outlined, only while busy) + SIGN IN / SIGNING IN… / VERIFY / VERIFYING… (orange, full width = primary).
  - forgot form: "RESET YOUR PASSWORD", "Your broker will contact you with a new password.", ACCOUNT NUMBER, NOTE FOR SUPPORT (OPTIONAL) (watermark "how to reach you, preferred time…"), error box, green "Reset request sent. Your broker will contact you.", row "← Back to sign in" | SEND REQUEST (orange).
  - update banner (orange outline) when an update is ready; version "vX" bottom-right.
  - Keyboard: Enter in PASSWORD / CODE = sign in / verify; no Esc handling. Right-click: NO menus anywhere. Tables: none.
- Server picker flyout, in order: "<Brand> — Live Server" (green dot), "<Brand> — Demo Server" (orange dot), "Other server…", then recent hosts (indented) (LoginWindow.axaml:78-92).
- Terminal top bar right side (live): ACCOUNT · EQUITY USD · MARGIN LVL · THEME · USER (initials disc, name, ▾) · caption buttons. USER ▾ is a left-click menu (right-click: NO), placement bottom-right, min width 260: header line "<NAME> · <account> <MODE>" (disabled) · separator · "Switch account…" · separator · "Sign out" · "Sign out and forget this computer" (TopBar.axaml.cs:32-37). Every item opens the chart confirm overlay (always shown) with title / sentence / button (MainWindow.axaml.cs:238, 243-244).
- Status bar update pill: text = Updater.Status while downloading ("downloading vX… n%") or ready ("UPDATE vX READY · click to restart"); orange fill only when ready (StatusBar.axaml:22-25; MainWindow.axaml.cs:253).

## Issues
- [functional] term-session · Sign out / Sign out and forget / Switch account close the whole app: SignOutAsync relaunches the exe then Shutdown(), but the child is refused by the single-instance mutex the parent still holds · T\MainWindow.axaml.cs:687-695; T\Program.cs:177; SU\SingleInstance.cs:17,30-35
- [functional] term-session · plain "Sign out"/"Switch account" keep the remember-me cookie but logout revoked that session, so the next launch always fails to resume ("Session expired") while the dialog says "Saved credential kept." · T\MainWindow.axaml.cs:238,243,691; W\app\api\trade\logout\route.ts:11-13
- [functional] term-session · 2FA step has no way back: NeedsTwoFactor is never reset; an expired challenge (401 "login expired") is shown as "Code not accepted" and the user must restart the app · T\Views\LoginWindow.axaml.cs:163; T\Services\MarketDataService.cs:975; W\app\api\trade\login\verify-2fa\route.ts:42,64
- [functional] term-session · "Switch account…" is not an account switcher (same code as Sign out); linked-accounts, sessions, change-password and 2FA-management routes are never called by the terminal · T\MainWindow.axaml.cs:238; S\Api\ApiClient.cs (no such methods)
- [ux] term-session · server session is always created with remember=true (long TTL) even when "Remember me" is off; closing the window never logs out, so the session stays valid server-side · T\Services\MarketDataService.cs:963,974; T\MainWindow.axaml.cs:288
- [ux] term-session · CANCEL does nothing during "Resuming your session…" (no token, _attempt null) · T\Views\LoginWindow.axaml.cs:85-88,135,198-207
- [functional] term-session · StartupGate fails closed on any network error / 429 / 503 of the manifest endpoint: no offline or degraded launch · SU\StartupGate.cs:26-27; W\app\api\client\manifest\route.ts:21,35
- [ux] term-session · update is armed to apply silently on the next exit (WaitExitThenApplyUpdates) before the user clicks; login-page banner restarts with no confirm · SU\UpdateService.cs:58; T\Views\LoginWindow.axaml.cs:208
- [ux] term-session · broker build still offers "Other server…", which only drops the LIVE/DEMO mode check (host locked) · T\Views\LoginWindow.axaml:85-86; T\Views\LoginWindow.axaml.cs:77-82
- [text] term-session · hard-coded "FXG> " command-line prefix and default "FUTURIX" brand in a multi-broker product · T\Views\TopBar.axaml:23; T\ViewModels\MainViewModel.cs:33
- [text] term-session · confirm texts "Return to sign-in? Saved credential kept." do not match behaviour · T\MainWindow.axaml.cs:238,243
- [text] term-session · dead code: RestoredFromStore never set, so the auto-sign-in-on-open branch never runs · T\Views\LoginWindow.axaml.cs:90

## Status counts
`STATUS-COUNTS app=terminal screen=SESSION WORKS=17 PARTIAL=7 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`


<!-- ===== entities.md ===== -->

# entities: every entity × every place it appears × the actions there

Read-only audit, 2026-09-25. Sources: all `bo-*.md` (32 files incl. `bo-SHELL.md`), all `term-*.md` (14 files) and `endpoints.md` in this folder. Status words and evidence are copied from those files. The file named in each row's evidence cell is the source. Schema lines are from `D:\VyXTrader-Tauri\vyX\prisma\schema.prisma` at commit 74b3c02 (checked directly).
Evidence short forms (same as the source files): `DS` = DealingScreen.cs; `T\` = E:\vyxtrader\src\Vyx.Trader.App\; `S\` = Vyx.Shared; `W\` = D:\VyXTrader-Tauri\vyX\. Route paths are under `app/api/manage/` (backoffice) or `app/api/trade/` (terminal) unless stated.
"Shown as" = how the entity appears. "Actions" lists every control that acts on the entity in that place, with its status from the source file. Pure view controls (chips, search, sort, column picker) are left out unless they are not WORKS.

---

### 1. Account (trading account)
- DB model: `Account` schema.prisma:599 (credit :611, maxDailyLoss :618, swapFree :680, chartSettings :719)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH 1) CLI | client list row joined to margin; KPIs ACTIVE TRADERS, NEW CLIENTS · 7D | chips PARTIAL (SUSPENDED includes CLOSED); row click → CLI WORKS; double-click DUPLICATE; ctx Open client 360 DUPLICATE; ctx Live exposure PARTIAL (no-position account lands unfiltered); ctx Deposits · withdrawals PARTIAL; ctx Wallet WORKS | bo-DASH DashboardScreen.cs:49-51, 229-239 |
| BO | CLI list | one row per account (incl. the COVERAGE hedge account) | + ACCOUNT PARTIAL (no account-type field; MANAGER leverage/initialBalance dropped silently); ctx Add new account DUPLICATE; chips PARTIAL (SUSPENDED = any non-ACTIVE; IB = IB's clients); ctx Live exposure WORKS; ctx Deposits WORKS; ctx Wallet PARTIAL (focus dropped if WAL not loaded); ctx Credit/debit, Change group, Leverage, Risk limits, Statement CSV, Reset password, Suspend/Activate all DUPLICATE (card) | bo-CLI ClientsScreen.cs:60-71, 141; accounts/route.ts:131, 165-167, 288-290; WalletsLeadsScreens.cs:57 |
| BO | CLI Client 360 card | card rows Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP (no equity) | CREDIT/DEBIT PARTIAL (toast shows empty balance); CHANGE GROUP PARTIAL (lists non-selectable groups, silently resets leverage); LEVERAGE WORKS; RISK LIMITS PARTIAL (any save clears maxDailyLoss; swap-free default wrong); STATEMENT CSV PARTIAL; RESET PASSWORD WORKS; SUSPEND/ACTIVATE WORKS (CLOSED not settable); EQ range chips WORKS; 5) NOTE PLACEHOLDER | bo-CLI ClientsScreen.cs:95, 282-304, 502-508; ApiClient.ManageG6.cs:72 |
| BO | NTF detail | PASSWORD_RESET_REQUESTED / MARGIN_CALL rows → account | OPEN → CLI WORKS for these types; RESET PASSWORD PARTIAL (e-mailed password: dialog shows no password and no mention of e-mail); ctx Reset trader password DUPLICATE | bo-NTF NotificationsAuditScreens.cs:91, 142-155 |
| BO | LAR | request → created account | Approve PARTIAL (creates Account; toast never shows number; two concurrent approvals can create two accounts); Open account WORKS | bo-LAR LiveAccountRequestsScreen.cs:72-86; live-account-requests/[id]/route.ts:32-38, 95-123, 167 |
| BO | TRX | FROM/TO lookup, balance before → after | TRANSFER WORKS (writes both balances) | bo-TRX TransfersScreen.cs:37, 83; transfers/route.ts:97-137 |
| BO | WAL | balance, credit, equity, free margin | double-click → CLI WORKS; ctx Live exposure / Deposits / Internal transfer WORKS | bo-WAL WalletsLeadsScreens.cs:31 |
| BO | RISK 2) MRG, MRG | margin row per account with open positions | double-click → CLI WORKS; ctx Live exposure WORKS; ctx Close all n positions PARTIAL (partial failures reported as success) | bo-RISK RiskScreen.cs:44, 148-153; bo-MRG RiskScreen.cs:138-153 |
| BO | RDR | 30-day behaviour row + same-IP clusters | double-click → CLI WORKS; ctx Live exposure WORKS; cluster account links PARTIAL (id key mismatch); FLAG · WHITELIST · NOTE PLACEHOLDER | bo-RDR LiquidityScreens.cs:309, 385-395; ApiClient.ManageG5.cs:61-63 |
| BO | DEAL 6) MODE / 5) COV | "Dealing-group accounts" list; coverage account strip | SET / CHANGE COVERAGE ACCOUNT UI-ONLY (local file only) | bo-DEAL DS:532-535, 594-600 |
| BO | EXP, DLS, DEP, APR, KYC, IB, TRX HIST, AUD, CRM | account number column / "Open client" menu | navigation to CLI WORKS in each | bo-EXP :184; bo-DLS DLS:97; bo-DEP :147; bo-APR; bo-KYC :51; bo-IB :35, 88; bo-TRX :31; bo-AUD :186; bo-CRM :93 |
| BO | RPT CLIENT report | CSV rows (incl. DEMO) | kind chip WORKS; SAVE CSV PARTIAL | bo-RPT reports/client/route.ts:14; IbReportsScreens.cs:190-198 |
| BO | SHELL search | accounts bucket | hit → CLI WORKS | bo-SHELL MainWindow.axaml.cs:272-284 |
| T | Shell top bar | ACCOUNT, mode, USER name, EQUITY USD, MARGIN LVL | display only | term-shell TopBar.axaml:77-117; term-account |
| T | 6) ACC panel | BALANCE, EQUITY, OPEN P/L, MARGIN USED, FREE MARGIN, DAY P/L, WEEK P/L + gauge | F7 refresh WORKS; panel has no other control | term-account T\MainWindow.axaml.cs:310; AccountPanel.axaml |
- Gaps:
  - Reset trader password: CLI card toasts "emailed to …" or shows the password (ClientsScreen.cs:453-467, WORKS); NTF shows "password reset." with neither (bo-NTF, PARTIAL).
  - No control sets an account to CLOSED (bo-CLI SUSPEND/ACTIVATE row) or changes an existing account's type (no field in + ACCOUNT or card, bo-CLI).
  - Per-account pricing overrides (GET/PATCH accounts/[id]/pricing) have no native screen; web only (endpoints.md §2).
  - Terminal has no change-password, 2FA setup or linked-accounts view; those routes are web only (endpoints.md §2: trade/change-password, two-factor/*, linked-accounts).
  - Terminal equity/margin apply no quote→account FX rate; server does (term-account S\Trading\AccountMath.cs:67-77 vs W\lib\margin.ts:67-74).

### 2. Client (portal user)
- DB model: `Client` schema.prisma:1239 (trader name/e-mail on trading accounts live on `Account`)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | KYC tab CLIENT PORTAL | ClientKycRecord row with client name | APPROVE / REJECT WORKS (see 14); ctx Open client 360 disabled for every portal row (no account link) | bo-KYC KycScreen.cs:48, 51 |
| BO | LAR | requesting client | Approve PARTIAL / Reject WORKS (see 15) | bo-LAR |
- Gaps:
  - No backoffice screen lists or opens Client records; CLI lists trading accounts only (bo-CLI accounts/route.ts:21-95).
  - Transfer "different clients" check is client-side by e-mail only; the server does not check it (bo-TRX TransfersScreen.cs:66-75 vs transfers/route.ts:57-102).
  - Terminal: none.

### 3. Position (open)
- DB model: `Position` schema.prisma:1811
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH 2) EXP | open book grouped by symbol; KPIs OPEN VOLUME, B-BOOK P/L | ctx Live exposure · this symbol PARTIAL (symbol never matches); ctx Symbol settings WORKS | bo-DASH DashboardScreen.cs:55, 154-160 |
| BO | EXP 3) POS | every open position of the broker (incl. coverage legs) | Modify SL / TP PARTIAL (no PositionModified publish); Close at market WORKS; Close part WORKS; Close by WORKS; Reverse PARTIAL (IN_PLACE skips coverage hook; maker-checker for MANAGER); Open client WORKS; double-click DUPLICATE; CLOSE BY SYMBOL DEAD (route requires accountId); EXP row "Close every position on this symbol" DUPLICATE + DEAD | bo-EXP LiveExposureScreen.cs:45, 51, 59, 174-184; close-bulk/route.ts:28-31; reverse/route.ts:68-77 |
| BO | EXP 1) EXP, 4) FEED | exposure per symbol; broker-wide activity feed | row click filters POS WORKS; ctx Filter positions DUPLICATE | bo-EXP :43-44 |
| BO | DEAL 7) GRP | dealing-group TRADES / EXPOSURE | ctx Live exposure / Open client WORKS | bo-DEAL DS:119 |
| BO | DEAL 10) SDM | UNBOOKED / BOOKED / CLOSED client positions | BOOK WORKS; BOOK ALL WORKS; UNBOOK WORKS; CLOSE WORKS; P/L chips PARTIAL (500-row cap) | bo-DEAL DS:716-729, 830, 867, 880-899 |
| BO | CLI 360 3) TRD | open rows of the account (NOW, P/L repriced) | ctx Open in Live exposure WORKS | bo-CLI ClientsScreen.cs:76-78 |
| BO | RISK 2) MRG, MRG | position count per account | ctx Close all n positions PARTIAL | bo-RISK RiskScreen.cs:153; bo-MRG |
| BO | LP 2) BOOK | open lots per symbol, A/B book | double-click PARTIAL (EXP ignores symbol); ctx Live exposure DUPLICATE; ctx Symbol settings WORKS | bo-LP LiquidityScreens.cs:64 |
| BO | SYM 1) LIM | net lots per symbol vs MAXIMUM EXPOSURE | view only (broker-wide net compared with a per-account gross cap) | bo-SYM SymbolsScreen.cs:114-116; lib/risk.ts:307-327 |
| BO | SHELL search | positions bucket | hit → EXP WORKS | bo-SHELL MainWindow.axaml.cs:272-284 |
| T | 4) TRADE tab | open positions with live CURRENT / PTS / P/L | CLOSE PROFIT / LOSS / ALL WORKS; BE WORKS; PART WORKS; MOD WORKS; SHARE WORKS; REV WORKS; ✕ WORKS; CANCEL (close awaiting dealer) WORKS; inline S/L · T/P PARTIAL (same value re-entry swallowed); COMMENT UI-ONLY (local only); ctx Close by WORKS; ctx Smart rules WORKS; ctx Modify / Close SYMBOL / Share DUPLICATE | term-positions PositionsPanel.axaml:187-253; PositionsPanel.axaml.cs:298-321 |
| T | Modify / Close window | one position | SL / TP fields PARTIAL (overwritten by 4 s refresh); MODIFY SL / TP WORKS; CLOSE POSITION / CLOSE PART WORKS | term-positions ModifyPositionWindow.axaml.cs:31, 38-43 |
| T | Share window | one position | SAVE PNG PARTIAL (no FX, account-currency label); COPY TEXT WORKS | term-positions ShareCard.cs:20-23 |
| T | 2) Chart | entry line + tag per position, SL/TP lines | drag SL/TP WORKS; drag from entry WORKS; ctx Set SL / Set TP PARTIAL (first 4 only); double-click line → Modify WORKS | term-chart CandleChartControl.cs:519-526, 694-727 |
| T | STM docked block | scoped positions | Break-even Apply WORKS; Partial close WORKS; Close profitable / losing / all WORKS | term-stm OrderTicketPanel.axaml:430-445 |
| T | 6) ACC panel | OPEN P/L | view | term-account |
- Gaps:
  - SL/TP modify by admin (EXP) publishes no PositionModified and writes AuditLog POSITION_SLTP_MODIFIED (bo-EXP positions/[id]/route.ts:88-113); trader modify publishes PositionModified and writes no AuditLog (term-positions, term-chart trade positions/[id]/route.ts:77-110).
  - Reverse: EXP uses the server reverse route (IN_PLACE / CLOSE_REOPEN, maker-checker for MANAGER) (bo-EXP reverse/route.ts:44-93); terminal REV = client-side close then a new MARKET order with no SL/TP, not opened when the close is queued (term-positions MarketDataService.cs:2040-2058).
  - Close by symbol: terminal bulk close WORKS (term-positions close-bulk/route.ts:35-101); EXP CLOSE BY SYMBOL is DEAD (bo-EXP close-bulk/route.ts:28-31).
  - Partial close lot-step check: manage close checks range only (bo-EXP close/route.ts:86); trade close checks lot step + remainder (term-positions close/route.ts:126-163).
  - Symbol focus from DASH, LP, FEED into EXP is ignored (LiveExposureScreen.cs:109-113).
  - Void on an open position: no native control (EXP menu has none, bo-EXP C; DLS Void only lists closed rows, see 6).

### 4. Coverage (hedge) position
- DB model: `Position` schema.prisma:1811 (covered :1875, coveragePositionId :1885), on the broker's coverage `Account`
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DEAL 5) COV | coverage TRADES / EXPOSURE / HISTORY | ✕ close WORKS; HISTORY FROM/TO WORKS; chips WORKS | bo-DEAL DS:1019, 1134-1136 |
| BO | DEAL chart | coverage legs on chart | Set SL / TP WORKS; drag SL/TP WORKS; double-click leg close WORKS; one-click SELL/BUY WORKS; Buy/Sell Limit/Stop @ price PLACEHOLDER | bo-DEAL DS:1205-1257 |
| BO | DEAL 8) TICKET | coverage order ticket | SELL / BUY WORKS; LIMIT / STOP PLACEHOLDER | bo-DEAL DS:1325-1336 |
| BO | DEAL 10) SDM | booked leg per client position | BOOK / BOOK ALL / UNBOOK / CLOSE WORKS | bo-DEAL DS:830-899 |
| BO | EXP | listed with client positions, not marked | same actions as client positions (see 3) | bo-EXP B "Included rows" |
- Gaps:
  - EXP, DASH KPI and CLI list count coverage legs / the coverage account as client data (bo-EXP B; bo-CLI accounts/route.ts:28-29).
  - Coverage orders and BOOK skip margin / lot-step / halt checks (bo-DEAL coverage/orders/route.ts:57-66; book/route.ts:43-70).
  - Auto-hedge is not applied to fills made by the desk-toggle flush (bo-DEAL dealing-desk-toggle/route.ts:261).

### 5. Order (pending / dealer queue)
- DB model: `Order` schema.prisma:1756
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH KPI | DEALER QUEUE count + oldest age | view | bo-DASH DashboardScreen.cs:124-147 |
| BO | DEAL 2) QUEUE | pending / requoted MARKET orders and queued closes; resting LIMIT/STOP | ACCEPT ALL PARTIAL (says "at market", fills at requested); REJECT ALL WORKS; ACCEPT ▾ Requested WORKS; ACCEPT ▾ Market WORKS; REQUOTE +1/+2/+3 PARTIAL (wrong direction on queued BUY close); REQUOTE custom WORKS; REJECT DEAD (empty reason → 400); WITHDRAW DEAD; CANCEL (resting) PLACEHOLDER; ctx Open client / Live exposure WORKS | bo-DEAL DS:338-342, 399-443, 464; dealing-queue/[id]/route.ts:99-101 |
| BO | DEAL 3) ACT | dealing activity feed | view | bo-DEAL DS:486 |
| BO | AUD | "Order" audit rows | OPEN PARTIAL (opens EXP with an order id EXP cannot match) | bo-AUD NotificationsAuditScreens.cs:229, 251-257 |
| BO | SHELL search | orders bucket | hit → CLI (account) WORKS | bo-SHELL |
| T | 3) OT ticket | MARKET / LIMIT / STOP | SELL / BUY WORKS; EXPIRY UI-ONLY (never sent) | term-ticket OrderTicketPanel.axaml:280-318 |
| T | F9 New Order | same fields + SLIPPAGE MAX | SELL / BUY WORKS; EXPIRY UI-ONLY; hint line DEAD; prefill side/type/price DEAD | term-neworder NewOrderWindow.axaml:41-115; NewOrderWindow.axaml.cs:35-41 |
| T | 2) Chart | one-click widget; right-click pending entries | one-click SELL / BUY WORKS; Buy/Sell Limit/Stop @ price PARTIAL (volume always 0.01; side gated on bid) | term-chart CandleChartControl.cs:507-516; MainViewModel.cs:15 |
| T | STM hotkeys | MARKET order on key press | hotkey press PARTIAL (block SL/TP not sent; no STM_HOTKEY_ORDER audit) | term-stm MainWindow.axaml.cs:329-337 |
| T | PENDING tab | resting, dealer-queued, queued closes, requotes | ✕ cancel WORKS; ✓ accept requote WORKS; ✕ REJECT requote WORKS | term-tabs PositionsPanel.axaml:303-308 |
| T | ORDERS tab | order log, all statuses (≤500) | rows PARTIAL (only refreshed at sign-in and after a ticket order) | term-tabs MarketDataService.cs:1073, 1774 |
| T | Market Watch | — | double-click / ctx New order opens F9 WORKS | term-marketwatch MainWindow.axaml.cs:231 |
- Gaps:
  - Dealer reject: row REJECT is DEAD (sends empty reason, DS:442); REJECT ALL prompts a reason and WORKS (DS:419).
  - No backoffice cancel of a resting LIMIT/STOP (no manage cancel route; bo-DEAL DS:464).
  - Terminal cannot modify a pending order; PATCH trade/orders/[id] is web only (term-ticket orders/[id]/route.ts:25; endpoints.md §2).
  - LIMIT/STOP fill only while a terminal/WebTrader is connected and sees the trigger (term-ticket MarketDataService.cs:809-820; engine reads `orders` status ACCEPTED, engine/order-management/src/db.rs:587-588).
  - Order entry paths differ: ticket/F9 confirm per setting; one-click confirm only when 1-click OFF; hotkeys never confirm and drop SL/TP; chart pending orders skip client volume/price-side validation (term-ticket "Entry paths").

### 6. Deal (closed trade)
- DB model: `Position` schema.prisma:1811 with status CLOSED / VOIDED
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH KPI | REALIZED TODAY | view | bo-DASH DashboardScreen.cs:124-147 |
| BO | DLS | latest 500 CLOSED/VOIDED of the broker | Replay fill WORKS; Open client WORKS; Void deal DEAD (server needs OPEN); Delete deal WORKS (maker-checker for MANAGER); double-click DUPLICATE (Delete); "DELETE" cell UI-ONLY | bo-DLS DLS:38-39, 87, 97-126; lib/position-actions.ts:47-57, 502-503 |
| BO | CLI 360 3) TRD | account's closed rows (from broker-wide latest 500) | ctx Open in Deals WORKS; STATEMENT CSV PARTIAL (500 cap) | bo-CLI ClientsScreen.cs:79, 258, 516-529 |
| BO | DEAL 7) GRP / 5) COV HISTORY, 10) SDM | closed trades by range | GRP FROM/TO PARTIAL (dealer-on counts every account); COV FROM/TO WORKS; SDM P/L chips PARTIAL (500 cap) | bo-DEAL DS:611-616, 673, 716-729, 1019 |
| BO | RPT TRADING | CSV, 30 d LIVE closed | kind chip WORKS; RANGE PARTIAL; SAVE CSV PARTIAL | bo-RPT IbReportsScreens.cs:141-198 |
| BO | RDR | 30-day closed-trade statistics | view | bo-RDR lib/risk-radar.ts:120-160 |
| T | HISTORY tab | all closed positions of the account | range chips WORKS; FROM/TO WORKS; SYMBOL WORKS; STATEMENT ⤓ WORKS; row Share WORKS | term-tabs PositionsPanel.axaml:366-385 |
| T | 6) ACC panel | DAY / WEEK P/L | view | term-account MarketDataService.cs:1609-1615 |
- Gaps:
  - Backoffice closed-trade lists stop at the latest 500 broker-wide (deals/route.ts:71); terminal HISTORY is unbounded (history/route.ts:5-37).
  - Void: DLS offers it only on closed rows where it cannot succeed (bo-DLS); no screen offers Void on an open position (bo-EXP C).

### 7. Position action request (maker-checker)
- DB model: `PositionActionRequest` schema.prisma:1933
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DLS | filed by "Delete deal…" (MANAGER) | Delete deal WORKS → row "DELETE PENDING" | bo-DLS delete/route.ts:30-39 |
| BO | EXP | filed by "Reverse…" (MANAGER) | Reverse PARTIAL (reason stored null) | bo-EXP reverse/route.ts:44-50 |
| BO | APR 2) POS | DELETE / VOID / REVERSE requests | ACTIONS double-click approve WORKS; ctx Approve DUPLICATE; ctx Reject WORKS; ctx Open client WORKS; TICKET column always "—" | bo-APR ApiClient.ManageG6.cs:35; position-action-requests/route.ts:23-35 |
| BO | SHELL | nav badge APR | view | bo-SHELL; bo-APR MainWindow.axaml.cs:199 |
- Gaps:
  - A broker whose staff is one MANAGER only can file requests that can never be approved (bo-APR "Single-admin broker").
  - Void requests can be filed by MANAGER only for OPEN positions, and no screen offers Void on one (see 6).

### 8. Balance adjustment (credit / debit)
- DB model: `Transaction` schema.prisma:1402 type ADJUSTMENT; `BalanceAdjustmentRequest` schema.prisma:1976
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CLI 360 card | CREDIT / DEBIT button | CREDIT / DEBIT PARTIAL (MANAGER files a request; toast value empty) | bo-CLI ClientsScreen.cs:297, 477-485 |
| BO | CLI 360 4) LED | ledger row | row click PARTIAL (every type opens DEP, which lists only deposits/withdrawals) | bo-CLI ClientsScreen.cs:93, 335 |
| BO | APR 1) BAL | pending requests | approve WORKS; ctx Approve DUPLICATE; ctx Reject WORKS; ctx Open client WORKS | bo-APR ApprovalsMirrorScreens.cs:33, 96 |
| T | BALANCE tab | ADJUSTMENT row | rows PARTIAL (empty after sign-in until a balance event or a close) | term-tabs MarketDataService.cs:1041-1087 |
- Gaps:
  - CREDIT / DEBIT writes Account.balance only; no native control writes Account.credit (bo-CLI lib/balance-adjustment.ts:46-86), though WAL and CLI show credit.
  - A debit has no floor (balance may go below 0 or below used margin) (bo-CLI balance-adjustment.ts:51-53).

### 9. Deposit
- DB model: `Transaction` schema.prisma:1402 type DEPOSIT (enum :99)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | KPIs NET DEPOSITS · 7D, DEPOSITS · 30D; 3) APPR queue; 4) FLOW chart | APPR row click → DEP WORKS; double-click / ctx DUPLICATE; ctx Open client WORKS | bo-DASH DashboardScreen.cs:59-61, 182-191 |
| BO | DEP | request row (≤200) + 8 KPI tiles | Approve · complete the deposit WORKS; Reject PARTIAL (trader note overwritten/erased); double-click DUPLICATE; Open client WORKS | bo-DEP FundsScreen.cs:41, 143-163; funds-requests/[id]/route.ts:49, 68 |
| BO | CLI 360 LED, WAL, CLI list ctx | ledger row; ctx "Deposits · withdrawals" | navigation WORKS / LED row click PARTIAL | bo-CLI; bo-WAL |
| BO | RPT FINANCIAL | CSV row | view (SAVE CSV PARTIAL) | bo-RPT |
| BO | NTF | FUNDS_REQUEST → DEP | OPEN WORKS | bo-NTF FundsScreen.cs:91 |
| BO | SHELL search | transactions bucket → DEP | WORKS | bo-SHELL |
| T | BALANCE tab | DEPOSIT row | rows PARTIAL (not loaded at sign-in) | term-tabs |
- Gaps:
  - Terminal cannot submit a deposit/withdrawal request; POST trade/funds-requests is web only (endpoints.md §2).
  - Approve / reject send no notification to the trader (bo-DEP).

### 10. Withdrawal
- DB model: `Transaction` schema.prisma:1402 type WITHDRAWAL (amount stored negative)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | KPI WITHDRAWALS · PENDING; 3) APPR queue | as deposit | bo-DASH |
| BO | DEP | request row | Mark for approval (maker) WORKS; Confirm · complete (checker) WORKS; Cancel my mark WORKS (server accepts from any admin); Reject PARTIAL; double-click DUPLICATE | bo-DEP FundsScreen.cs:109-163; lib/funds-approval.ts:33-35, 66-80 |
| T | BALANCE tab | WITHDRAWAL row | rows PARTIAL | term-tabs |
- Gaps:
  - Confirm has no free-margin / open-position check (bo-DEP lib/funds-approval.ts:127-132).
  - DEP shows the stored negative amount unchanged (bo-DEP B).
  - Terminal cannot request a withdrawal (endpoints.md §2).

### 11. Internal transfer
- DB model: `Transaction` schema.prisma:1402 types TRANSFER_OUT / TRANSFER_IN (enum :114-115)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | TRX | form + last 200 legs | PREVIEW WORKS (stale balances possible); TRANSFER WORKS; HIST double-click WORKS; ctx Open client DUPLICATE; ctx Use as FROM / TO WORKS | bo-TRX TransfersScreen.cs:31-37, 60-85 |
| BO | WAL | — | ctx Internal transfer (prefills FROM) WORKS | bo-WAL TransfersScreen.cs:59 |
| BO | CLI 360 LED | ledger row | row click PARTIAL (opens DEP) | bo-CLI |
- Gaps:
  - Terminal BALANCE tab never shows transfers: trade/transactions returns DEPOSIT, WITHDRAWAL, CREDIT, ADJUSTMENT, NEGATIVE_BALANCE_PROTECTION only (W\app\api\trade\transactions\route.ts:12-18).
  - Same-client check is client-side only (bo-TRX).

### 12. Wallet (account balance view)
- DB model: none; `Account.balance` / `credit` schema.prisma:611 + computed margin. `SavedWithdrawalAddress` schema.prisma:1532 appears in no bo-/term- file.
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | WAL | balance, credit, equity, free margin, floating P/L per account | chips / search WORKS; navigation to CLI / EXP / DEP / TRX WORKS; no write | bo-WAL |
| BO | DASH / CLI | ctx "Wallet" | DASH WORKS; CLI PARTIAL (focus dropped if WAL not loaded) | bo-DASH; bo-CLI WalletsLeadsScreens.cs:57 |
| T | 6) ACC panel, top bar | balance / equity / free margin | view | term-account |
- Gaps: WAL margin failure shows "—" silently (bo-WAL B).

### 13. Payment method (PSP)
- DB model: `PaymentMethod` schema.prisma:1499
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | PSP | 5 fixed rows | inline edits WORKS; ENABLED WORKS; ACTIONS SAVE PARTIAL (no audit); ctx Save DUPLICATE; ctx Revert WORKS; ctx Enable/Disable DUPLICATE | bo-PSP PaymentMethodsScreen.cs:66-103; payment-methods/route.ts:123-131 |
| BO | CFG | "PER METHOD · PSP" link | WORKS | bo-CFG SettingsScreen.cs:55 |
- Gaps:
  - Nav shows PSP to every role; routes are BROKER_ADMIN only (bo-PSP payment-methods/route.ts:29).
  - Fee is display-only, never deducted (bo-PSP lib/psp/adapter.ts:108-121).
  - Terminal: none (trade/payment-methods web only, endpoints.md §2).

### 14. KYC record / document
- DB model: `KycRecord` schema.prisma:1204 (in-app, per account); `ClientKycRecord` schema.prisma:1318 (portal, per client)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | KYC | two queues + document tiles | row click WORKS; ctx Review DUPLICATE; ctx Approve / Reject DUPLICATE; document tile WORKS (PDF never viewable); APPROVE WORKS; REJECT WORKS; ctx Open client 360 WORKS (IN-APP only) | bo-KYC KycScreen.cs:43-51, 140-234 |
| BO | CLI + ACCOUNT | optional KYC upload at account creation | part of + ACCOUNT PARTIAL | bo-CLI ApiClient.ManageG6.cs:100-112 |
| BO | CLI / DASH | chip KYC WAIT; DASH note "KYC WAIT" | view | bo-CLI; bo-DASH |
| BO | NTF | KYC_SUBMITTED / CLIENT_KYC_SUBMITTED | REVIEW KYC WORKS | bo-NTF KycScreen.cs:75 |
| BO | SHELL | nav badge KYC | view | bo-SHELL |
- Gaps:
  - An APPROVED in-app KycRecord is read by no trading or funds path (bo-KYC accounts/route.ts:89, dashboard/route.ts:62).
  - Decisions send no notification or e-mail (bo-KYC lib/kyc-decision.ts).
  - Terminal: none (trade/kyc web only, endpoints.md §2).

### 15. Live account request
- DB model: `LiveAccountRequest` schema.prisma:1366
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | LAR | request row | chips WORKS; Approve PARTIAL; double-click DUPLICATE; Reject WORKS; Open account WORKS | bo-LAR LiveAccountRequestsScreen.cs:32, 72-90 |
| BO | DASH | NEW CLIENTS note "{n} ACCOUNT REQUESTS" | view | bo-DASH |
| BO | NTF | LIVE_ACCOUNT_REQUESTED → LAR | OPEN PARTIAL (FocusRecord ignores the id) | bo-NTF LiveAccountRequestsScreen.cs:50 |
| BO | SHELL | nav badge LAR | view | bo-SHELL |
- Gaps: Terminal: none (portal only).

### 16. Lead (CRM)
- DB model: `Lead` schema.prisma:920
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CRM | lead row | + LEAD WORKS; ctx Add DUPLICATE; double-click (converted) WORKS; Mark NEW/CONTACTED/QUALIFIED/LOST WORKS; Mark CONVERTED → account WORKS | bo-CRM WalletsLeadsScreens.cs:93-142 |
| BO | NTF | NEW_LEAD → CRM | OPEN PARTIAL (no FocusRecord on CRM) | bo-NTF |
- Gaps:
  - No AuditLog on any lead write (bo-CRM leads/route.ts:45-75; leads/[id]/route.ts:20-61).
  - Lead.notes and un-converting have no control (bo-CRM).

### 17. IB relationship / commission
- DB model: `IbRelationship` schema.prisma:2133; payout = `Transaction` type COMMISSION
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | IB | partners grouped per IB + detail + referred clients | PAYOUT RUN WORKS; + PARTNER WORKS; PAY WORKS; EDIT PLAN PARTIAL (re-prices unpaid trades); referred-client double-click pay WORKS; ctx Open IB account / Open client WORKS; ctx Add / Pay / Edit / Referred DUPLICATE; ACTIONS "PAY" UI-ONLY; MTD columns PLACEHOLDER; Sub-IB / FUNNEL PLACEHOLDER | bo-IB IbReportsScreens.cs:31-114; lib/commission.ts:18-37 |
| BO | RPT IB | CSV with pending commission | view | bo-RPT reports/ib/route.ts:7 |
| BO | CLI list | chip IB | PARTIAL (filters IB's clients, not IB accounts) | bo-CLI accounts/route.ts:85 |
| BO | AUD | IbRelationship rows | OPEN PARTIAL (entity type never matches) | bo-AUD |
- Gaps: Commission payouts (COMMISSION) are not in the terminal BALANCE tab (W\app\api\trade\transactions\route.ts:12-18).

### 18. Staff user (team member)
- DB model: `AdminUser` schema.prisma:515 (role enum `AdminRole` :57; extraPermissions :531)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | USR | staff table + role matrix + member editor | + INVITE WORKS; CREATE PARTIAL (default SUPPORT cannot open the backoffice); DISABLE ACCESS WORKS; RE-ACTIVATE WORKS; matrix cell / SAVE / REVERT WORKS; editor toggles, SAVE PERMISSIONS, REVERT DUPLICATE; ctx Edit / Disable / Re-activate DUPLICATE; ACTIONS words UI-ONLY; 2FA · devices · IPs PLACEHOLDER; PASSWORD RESET · ROLE CHANGE PLACEHOLDER | bo-USR TeamScreen.cs:39-243 |
| BO | SEC | this sign-in (e-mail, role, 2FA used) | REQUEST PASSWORD RESET PARTIAL; 2FA, passkeys, sessions, API keys, IP allowlist, org policy PLACEHOLDER | bo-SEC SecurityEmergencyScreens.cs:52-77 |
| BO | SHELL login | sign-in | SIGN IN PARTIAL (SUPPORT fails at shell-info); Forgot password PARTIAL | bo-SHELL BackofficeSession.cs:54-55 |
| BO | NTF | ADMIN_PASSWORD_RESET_REQUESTED → USR | OPEN lands on a staff member with reset "not available yet" | bo-NTF TeamScreen.cs:179 |
| BO | AUD | actor e-mail; AdminUser rows | search by actor e-mail returns nothing (PARTIAL); OPEN PARTIAL | bo-AUD route.ts:31-40 |
- Gaps:
  - Staff password reset exists only for SUPER_ADMIN (app/api/admin/admins/[id]/reset-password/route.ts:13); the backoffice files requests nobody in the broker can act on (bo-SEC, bo-SHELL).
  - Role change: no control (bo-USR :179). No DEALER role exists (bo-USR schema.prisma:57-66).

### 19. Audit log entry
- DB model: `AuditLog` schema.prisma:2160
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | AUD | last 200, diff pane | search PARTIAL (entityId / order / account number only); SAVE CSV WORKS; OPEN PARTIAL (PascalCase entity types never match); ctx Open client WORKS; double-click / ctx DUPLICATE | bo-AUD NotificationsAuditScreens.cs:184-270 |
| BO | DASH 5) ACT | last 15 | view | bo-DASH route.ts:70-75 |
| BO | DEAL 3) ACT | rows whose label starts "Dealing" | view | bo-DEAL DS:216 |
| BO | DLS Replay | up to 8 audit lines | view | bo-DLS DLS:111-121 |
| T | LOG tab | server rows merged with local journal | rows PARTIAL (server rows only at sign-in; rows older than 24 h get a wrong date) | term-tabs MarketDataService.cs:1075; term-hotkeys-sounds DockViewModels.cs:310-317 |
- Gaps (writes that create no AuditLog, per source files): lead writes (bo-CRM), LP notes (bo-LP :38), LP routing rules (bo-ROUTE), symbol sessions (bo-SYM sessions/route.ts:77-80), payment methods (bo-PSP), CFG settings (bo-CFG settings/route.ts:75), trader SL/TP modify (term-chart), price alerts (term-alerts), watchlist (term-marketwatch), staff forgot-password (bo-SEC).

### 20. Notification
- DB model: `Notification` schema.prisma:2235
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | NTF | broker inbox, last 100, shared read state | MARK ALL READ WORKS; MARK READ WORKS; OPEN {CODE} PARTIAL (MirrorRule, PriceAlert, closed positions, LAR/CRM/DEAL focus); RESET PASSWORD PARTIAL; ctx DUPLICATE | bo-NTF NotificationsAuditScreens.cs:89-163 |
| BO | SHELL | bell count, nav badge | bell DUPLICATE (nav NTF) | bo-SHELL MainWindow.axaml.cs:303 |
- Gaps:
  - Trader-scoped rows (PRICE_ALERT_TRIGGERED, trader copy of MARGIN_CALL) appear in the staff inbox (bo-NTF notifications/route.ts:21).
  - Terminal has no notification list; trader events reach it only as LOG lines / sounds (term-hotkeys-sounds A).

### 21. Price alert
- DB model: `PriceAlert` schema.prisma:888
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Alerts dialog (F8) | ACTIVE alerts only | SYMBOL picker PARTIAL (hint keeps old symbol); ABOVE/BELOW WORKS; ADD WORKS; ✕ CANCEL WORKS; confirm WORKS | term-alerts AlertsWindow.axaml.cs:37-102 |
| T | 2) Chart | right-click Alert above/below | WORKS (list not refreshed, no LOG entry) | term-chart CandleChartControl.cs:527 |
| T | LOG tab | "Alert triggered …" line | view (no sound, popup or marker) | term-alerts MarketDataService.cs:303 |
| BO | DEAL chart | right-click Alert above/below | PLACEHOLDER | bo-DEAL DS:1215 |
| BO | NTF | PRICE_ALERT_TRIGGERED row | OPEN: no screen (PARTIAL) | bo-NTF |
| BO | FEED | PRICE ALERTS tile (engine reachability) | view | bo-FEED LiquidityScreens.cs:247-248 |
- Gaps: TRIGGERED / CANCELLED / EXPIRED alerts are never listed in the terminal (term-alerts alerts/route.ts:14-30). Backoffice has no alert list for any account.

### 22. Smart Trade Manager rule
- DB model: none. Client memory + `%APPDATA%\VyxTrader\smart-rules-state.json` (term-stm SmartRulesEngine.cs:21, 45-48)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | STM docked block | ENABLED pill, hotkeys, bulk actions | pill PARTIAL (does not stop armed rules); BUY/SELL HOTKEY WORKS; hotkey press PARTIAL; LOT SIZE DUPLICATE; SL/TP PARTIAL; SMART EXECUTION rows DEAD; SmartRulesRequested event DEAD | term-stm OrderTicketPanel.axaml:373-449; SmartRulesEngine.cs:104-117 |
| T | Smart rules window | per-position rules | BREAK-EVEN rule PARTIAL (retries every tick); PARTIAL AT TP1 PARTIAL (re-fires after failure); TRAILING STOP WORKS; ARM WORKS; DISARM WORKS; BREAK-EVEN NOW / CLOSE % / CLOSE DUPLICATE | term-stm SmartRules.cs:67-94; SmartRulesEngine.cs:139-141 |
| T | TRADE tab | ctx Smart rules … | WORKS | term-positions PositionsPanel.axaml.cs:79 |
| T | Shell | close ✕ / update pill | close ✕ PARTIAL (no confirm with armed rules); update confirm warns rules go off WORKS | term-shell MainWindow.axaml.cs:254, 288 |
- Gaps: Rules run only while the terminal process runs and receives ticks (term-stm B). Marker file is not scoped per host/account (term-stm B). Backoffice: none.

### 23. Liquidity provider
- DB model: `LiquidityProvider` schema.prisma:2282
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | LP | provider records | + LP WORKS; ctx Add DUPLICATE; Status ×4 WORKS; Notes WORKS (no audit); double-click → ROUTE DUPLICATE; ROUTING WORKS | bo-LP LiquidityScreens.cs:62-66 |
| BO | ROUTE detail | LP name | OPEN LP WORKS | bo-ROUTE :186 |
| BO | RPT LP | CSV (BROKER_ADMIN only) | view | bo-RPT reports/lp/route.ts:13 |
| BO | DASH 2) EXP | "LP fill quality · PENDING · NEEDS LP BRIDGE" static | none | bo-DASH |
- Gaps: No execution path reads LP records (bo-LP; bo-ROUTE A). Nav shows LP to MANAGER; routes BROKER_ADMIN only, MANAGER sees only an error (bo-LP :76). AUD cannot open LiquidityProvider rows (bo-AUD).

### 24. LP routing rule
- DB model: `LpRoutingRule` schema.prisma:2305
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | ROUTE | rule list + selected rule | + RULE WORKS (no audit); ctx Add DUPLICATE; row click WORKS; ctx Delete rule WORKS (no audit); CONDITIONS · EDIT / DELETE PLACEHOLDER | bo-ROUTE LiquidityScreens.cs:151-186 |
| BO | LP | fetched every refresh, not displayed | none | bo-LP :57, 73 |
- Gaps: No execution path reads LpRoutingRule; fills route by Group.category (bo-ROUTE A, trade/orders/route.ts:383, 593). No edit control; delete only.

### 25. Trading halt / close-only / symbol disable
- DB model: `Broker.tradingHaltedAt` :339, `Broker.closeOnlyAt` :351; `Group.tradingHaltedAt` :979, `Group.closeOnlyAt` :987; `BrokerSymbol.enabled` :1696
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | EMG | broker halt, broker close-only, groups table, symbols table | HALT ALL / RESUME WORKS; CLOSE-ONLY / RESUME WORKS; group HALT/RESUME DUPLICATE (works); symbol HALT/RE-ENABLE PARTIAL (400 below hedged-margin floor); ACTIONS text single click UI-ONLY; KICK ALL CLIENT SESSIONS PLACEHOLDER | bo-EMG SecurityEmergencyScreens.cs:95-177 |
| BO | GRP | row menu | Halt / Resume trading DUPLICATE (EMG) | bo-GRP GroupsScreen.cs:146-154 |
| BO | DEAL 9) PANIC | dealing groups | HALT DEALING GROUP WORKS; CLOSE-ONLY WORKS; RESUME WORKS | bo-DEAL DS:1397-1398 |
| BO | RISK TRADING STATE | Trading HALTED/OPEN, Close-only ON/OFF | display + EMERGENCY link WORKS | bo-RISK RiskScreen.cs:103-104 |
| BO | SYM | ENABLED column | double-click stage WORKS; SAVE WORKS | bo-SYM SymbolsScreen.cs:126 |
| BO | AUD | Broker halt rows | OPEN PARTIAL (opens CFG, not EMG) | bo-AUD |
| T | — | not shown | none; trader learns from the server rejection | term-ticket validation matrix (Halted / Close-only: client none) |
- Gaps:
  - Per-group close-only is writable only on DEAL; EMG groups table shows no close-only state (bo-EMG last line; ManageG2.cs:136).
  - Symbol disable: SYM SAVE WORKS; EMG toggle PARTIAL on symbols below the hedged floor (bo-EMG symbols/route.ts:166-167).
  - EMG symbol toggle is gated MANAGER/BROKER_ADMIN without EMERGENCY_CONTROLS; broker/group halt require EMERGENCY_CONTROLS (bo-EMG symbols/route.ts:34-40 vs halt/route.ts:18).

### 26. Dealer mode / auto-fill / auto-hedge / smart dealer
- DB model: `Broker.dealingModeAt` :359, `autoHedgeAt` :381, `dealingDeskAutoFillAt` :382, `smartDealerAcceptPct` :389, `defaultMaxSlippagePips` :399
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DEAL 6) MODE | dealer on / auto-fill, auto-hedge, max slippage, smart dealer (read-only) | SWITCH TO AUTO-FILL / DEALER ON PARTIAL (flushed fills not hedged); TURN AUTO-HEDGE ON/OFF PARTIAL; MAX SLIPPAGE EDIT PARTIAL (0 refused by server); ⚙ SAVE PARTIAL (clears slippage cap) | bo-DEAL DS:445-600; dealing-desk-toggle/route.ts:261 |
| BO | RISK 1) RISK | DEALING MODE, smart dealer % | Manual dealing TURN ON/OFF PARTIAL; Smart dealer EDIT WORKS | bo-RISK RiskScreen.cs:83-89; lib/dealing-routing.ts:10-13 |
| BO | GRP header | DESK stat | view | bo-GRP dealing-desk-toggle/route.ts:40-48 |
| BO | EMG 2) | "manual dealing" row | RISK › link WORKS | bo-EMG :139 |
| BO | CFG | "Max slippage — not available yet" | PLACEHOLDER | bo-CFG SettingsScreen.cs:53 |
- Gaps:
  - Two switches write two different fields (DEAL → dealingDeskAutoFillAt; RISK → dealingModeAt) (bo-DEAL "Where dealer mode … can be toggled"; bo-RISK).
  - Max slippage: editable on DEAL, PLACEHOLDER on CFG (bo-CFG :53 vs bo-DEAL DS:567).
  - Terminal: dealer mode not shown before sending; message after the fact (term-ticket MarketDataService.cs:1768-1770).

### 27. Risk limits (broker / account / symbol caps)
- DB model: `Broker.maxOpenPositionsPerAccount` :334, `totalExposureLimit` :402; `Account.maxDailyLoss` :618; `BrokerSymbol.maxExposure` :1709; `MirrorRule.maxDailyLoss` :2080
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RISK | limits rows, KPI strip | Limits EDIT PARTIAL (called USD, enforced in lots; one number clears the other) | bo-RISK RiskScreen.cs:98-100; lib/risk.ts:330-347 |
| BO | EXP 2) LIM | risk-limit strip | EDIT ON RISK WORKS | bo-EXP :57, 93 |
| BO | DASH 2) EXP | NET $ EXP vs totalExposureLimit | view | bo-DASH |
| BO | CLI 360 | RISK LIMITS form | PARTIAL (clears maxDailyLoss on any save) | bo-CLI ClientsScreen.cs:502-508 |
| BO | SYM | MAXIMUM EXPOSURE cell; 1) LIM panel | inline edit WORKS; LIM panel semantics differ from server | bo-SYM SymbolsScreen.cs:114-116 |
| BO | MIR | maxOpenLots / maxDailyLoss at creation | set at + RULE WORKS; no edit afterwards | bo-MIR mirror-rules/[id]/route.ts:190-205 |
| T | — | not shown | none; server rejection only | term-ticket validation matrix |
- Gaps: CLI list does not parse maxDailyLoss (bo-CLI ApiClient.ManageG1.cs:38-40), so the form never shows the current value.

### 28. Margin snapshot (computed)
- DB model: none; `lib/margin.ts` computeAccountMarginSnapshots (server), `S\Trading\AccountMath.cs` (terminal)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | MARGIN CALLS KPI, NEAREST STOP-OUT | view | bo-DASH |
| BO | RISK, MRG | margin watch, lowest level first | see 1 (navigation, close all) | bo-RISK; bo-MRG |
| BO | WAL | equity / free / P/L | view | bo-WAL |
| T | 6) ACC panel, top bar | EQUITY, MARGIN USED, FREE MARGIN, level, CALL % | view; F7 WORKS | term-account |
- Gaps: RISK KPI "OPEN EXPOSURE · USD NOTIONAL" sums lots (bo-RISK lib/margin.ts:65). Terminal computes without FX (term-account).

### 29. Risk radar flag (computed)
- DB model: none; `lib/risk-radar.ts` (from closed positions + `LoginEvent` schema.prisma:2192)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RDR | flags per account, same-IP clusters | chips WORKS; NEWS chip PLACEHOLDER (flag hard-coded false); OPEN CLIENT / EXPOSURE DUPLICATE; FLAG · WHITELIST · NOTE PLACEHOLDER | bo-RDR lib/risk-radar.ts:116; LiquidityScreens.cs:385-387 |
| BO | SHELL | nav badge RDR | view | bo-RDR MainWindow.axaml.cs:201 |
- Gaps: A flag cannot be stored, cleared or whitelisted anywhere (bo-RDR :387).

### 30. Symbol (+ broker config, trading sessions)
- DB model: `Symbol` schema.prisma:1549; `BrokerSymbol` :1668; `TradingSession` :1739
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | SYM | config grid + exposure limits | inline edits WORKS; hedged < 50 confirm WORKS; ENABLED WORKS; TRADING MODE WORKS; SESSIONS PARTIAL (empty ≠ 24/7; no audit); DISCARD / SAVE CHANGES WORKS; ctx Trading sessions / Enable-Disable DUPLICATE; ctx Revert WORKS | bo-SYM SymbolsScreen.cs:48-211 |
| BO | GRP / ATY 2) PRC | per-symbol pricing override | see 32 / 33 | bo-GRP; bo-ATY |
| BO | GRP | Allowed symbols dialog | WORKS | bo-GRP |
| BO | EMG 4) SYMBOLS | disable one symbol | PARTIAL (see 25); search WORKS | bo-EMG |
| BO | DEAL 1) MW + chart | watchlist rows, candles | row click / double-click / + ADD / ctx items WORKS; Specification opens SYM WORKS | bo-DEAL DS:173-174 |
| BO | FEED 4) SYM | per-symbol tick freshness | double-click → SYM WORKS; ctx Symbol settings DUPLICATE; ctx Live exposure PARTIAL | bo-FEED LiquidityScreens.cs:203-204 |
| BO | DASH, EXP, LP | ctx "Symbol settings" | WORKS | bo-DASH; bo-EXP; bo-LP |
| BO | SHELL search | symbols bucket → SYM | WORKS | bo-SHELL |
| T | 1) Market Watch | row per watchlist symbol | search PARTIAL; row click WORKS; double-click WORKS; ctx Specification PARTIAL (no trading hours, pip/margin labels); Columns ▸ Change % PARTIAL (not persisted); Spread / High-Low WORKS | term-marketwatch MarketWatchView.axaml.cs:28-85; MainWindow.axaml.cs:223-231 |
| T | Tape | price / CHG% | click → chart WORKS | term-shell Tape.axaml.cs:37-40 |
| T | 3) OT / F9 | SYMBOL ▾ | WORKS (group-restricted symbols still listed) | term-ticket OrderTicketPanel.axaml:218-242; term-neworder |
| T | 2) Chart | active symbol, grid cell symbol ▾ | WORKS | term-chart |
| T | Alerts | SYMBOL picker | PARTIAL | term-alerts |
- Gaps:
  - Terminal /symbols is not filtered by group allowed symbols and sends no tradingMode (term-ticket symbols/route.ts:14-45).
  - MW spread excludes the BUY markup; ticket BUY price includes it (term-marketwatch MarketWatchViewModel.cs:88 vs OrderTicketViewModel.cs:64).
  - Symbol focus from DASH / LP / FEED into EXP is ignored (bo-DASH, bo-LP, bo-FEED; LiveExposureScreen.cs:109-113).

### 31. Watchlist item
- DB model: `WatchlistItem` schema.prisma:1580 (terminal); backoffice watchlist is local `BackofficeSettings.DealingWatchlist`
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 1) Market Watch | rows | + ADD item WORKS; ctx Add symbol WORKS; ctx Remove PARTIAL (removing the last row re-seeds 10 defaults) | term-marketwatch lib/watchlist.ts:66-67 |
| T | Tape | GridCandidates (watchlist first) | view | term-shell |
| BO | DEAL 1) MW | local watchlist | + ADD WORKS; Remove WORKS (local only) | bo-DEAL DealingMarketWatch.cs:97-105 |
- Gaps: Reorder and collapsed categories are web only (term-marketwatch; endpoints.md §2 watchlist/reorder, collapsed).

### 32. Group
- DB model: `Group` schema.prisma:956; `GroupSymbol` :1191; `GroupSymbolConfig` :1099
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | GRP | groups + pricing overrides | + GROUP WORKS; ctx Add DUPLICATE; row click WORKS; Edit group PARTIAL (resets tier; swapFree inherit lost; default can be unticked; leverage not propagated); Allowed symbols WORKS; Delete WORKS (menu enabled for MANAGER, server BROKER_ADMIN); Halt / Resume DUPLICATE; PRC edit PARTIAL (TARGET mode needs pricingEngineEnabled, UNVERIFIED per tenant); ctx Edit pricing DUPLICATE; Reset override WORKS | bo-GRP GroupsScreen.cs:146-226; groups/[id]/route.ts:77-119 |
| BO | DEAL 7) GRP, 9) PANIC | dealing-group trades / exposure / history; panic | see 3, 6, 25 | bo-DEAL |
| BO | EMG 3) GROUPS | TYPE (legacy groupType), halt state | see 25 | bo-EMG groups/route.ts:84 |
| BO | EXP | GROUP chips | WORKS | bo-EXP :120 |
| BO | CLI 360 | Group row; CHANGE GROUP | PARTIAL | bo-CLI ClientsScreen.cs:298, 375, 490 |
| BO | CFG | "PER GROUP · GRP" links (margin call, stop-out) | WORKS / DUPLICATE | bo-CFG SettingsScreen.cs:49-50 |
| T | 6) ACC gauge | "CALL n%" from group marginCallLevel | view | term-account me/route.ts:42 |
- Gaps: EMG shows legacy groupType; the routing axis Group.category is not shown there (bo-EMG B). Group per-symbol pricing differs from account-type pricing only in reset/edit wording; both depend on pricingEngineEnabled (bo-GRP, bo-ATY).

### 33. Account type
- DB model: `AccountType` schema.prisma:800 (enabled :845, swapFree :836); `AccountTypeSymbolConfig` :1137
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | ATY | types + pricing overrides | + TYPE PARTIAL (pins flat pricing to 0); ctx Add DUPLICATE; row click WORKS; Edit PARTIAL (null flat pricing becomes 0); Disable / Enable DEAD (400 "name is required"); PRC edit PARTIAL (ignored unless pricingEngineEnabled); ctx Edit pricing DUPLICATE; Reset override WORKS | bo-ATY AccountTypesScreen.cs:74-75; account-types/[id]/route.ts:41-77 |
| BO | CLI 360 card | "Account type" row | view | bo-CLI ClientsScreen.cs:282-289 |
| BO | LAR | request's accountTypeId used on approve | via Approve PARTIAL | bo-LAR |
| BO | AUD | AccountType rows | OPEN PARTIAL | bo-AUD |
- Gaps: + ACCOUNT has no account-type field (server default used) (bo-CLI accounts/route.ts:165-167). Terminal: none.

### 34. Mirror rule
- DB model: `MirrorRule` schema.prisma:2051; `MirrorLink` :2115
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | MIR | rule list | + RULE WORKS; ctx Add DUPLICATE; ACTIONS DISABLE/ENABLE WORKS; ctx Disable/Enable DUPLICATE; Edit multiplier / fill / symbols WORKS | bo-MIR ApprovalsMirrorScreens.cs:142-183 |
| BO | NTF | MIRROR_KILL_SWITCH | OPEN PARTIAL ("MirrorRule has no screen yet") | bo-NTF lib/mirror.ts:145-150 |
| BO | AUD | MirrorRule rows | OPEN PARTIAL | bo-AUD |
- Gaps: KILLED rule cannot be re-enabled in the UI; server allows it (bo-MIR mirror-rules/[id]/route.ts:155-159). No delete endpoint. Rule detail / MIRROR_FAILED history is web only (endpoints.md §2). CLI list ignores the `mirror` field (bo-CLI route.ts:90).

### 35. Session / credentials
- DB model: no session table (Redis: W\lib\account-auth.ts:139, 155-157; admin cookie W\lib\auth.ts:10); `LoginEvent` schema.prisma:2192; `Account.passwordHash` :605; `AdminUser.passwordHash` :520
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Sign-in window | server, account, password, 2FA, remember me | SIGN IN WORKS; AUTHENTICATOR CODE PARTIAL; Remember me PARTIAL; Other server PARTIAL; CANCEL PARTIAL; SEND REQUEST (forgot) WORKS; update banner WORKS | term-session LoginWindow.axaml.cs:85-208 |
| T | Shell USER menu | account / name | Switch account PARTIAL (app exits; DUPLICATE of Sign out); Sign out PARTIAL (app exits, stored cookie now revoked); Sign out and forget PARTIAL (app exits) | term-session MainWindow.axaml.cs:238-244, 684-694; Program.cs:177 |
| T | Startup gate | refusal window | CLOSE WORKS | term-session StartupGate.cs:41-42 |
| BO | SHELL login | server, e-mail, password, 2FA, remember me | SIGN IN PARTIAL; VERIFY WORKS; Remember me WORKS; Forgot password PARTIAL | bo-SHELL LoginWindow.axaml.cs:81-169 |
| BO | SHELL USER menu | — | Sign out PARTIAL (no server revoke); Switch account DUPLICATE | bo-SHELL BackofficeSession.cs:83-90 |
| BO | SEC | this sign-in | SIGN OUT DUPLICATE; ACTIVE SESSIONS / Sign out everywhere PLACEHOLDER | bo-SEC :53-61 |
| BO | CLI 360 6) SES | last 50 LoginEvents | view; no revoke | bo-CLI security/route.ts:5-28 |
| BO | CLI / NTF | RESET PASSWORD revokes all trader sessions | WORKS / PARTIAL | bo-CLI; bo-NTF reset-password/route.ts:57 |
| BO | RDR | same-IP clusters from LoginEvent | view | bo-RDR |
- Gaps:
  - Sign out: terminal revokes the server session (term-session logout/route.ts:11-13); backoffice never calls /api/admin/logout, session stays valid (bo-SHELL).
  - Session list / revoke: web only for traders (trade/sessions) and staff (admin/sessions); BO SEC shows PLACEHOLDER (endpoints.md §2; bo-SEC).
  - Terminal remember-me: server session always created with remember=true (term-session MarketDataService.cs:963).

### 36. Client build / app update
- DB model: none in schema.prisma; Redis `client_build:<id>` (W\lib\client-builds.ts:34)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Startup gate, status bar | refusal window; update pill | refusal CLOSE WORKS; update pill WORKS | term-session; term-shell StatusBar.axaml:22-25 |
| BO | SHELL | startup gate; login update banner | UPDATE … READY PARTIAL (login window only, no in-shell check) | bo-SHELL LoginWindow.axaml.cs:53-57 |
- Gaps: No native screen lists, registers or revokes builds; PATCH /api/admin/client-builds is used by build tooling only (endpoints.md §2).

### 37. Settings / config
- DB model: `Broker` schema.prisma:317 (defaultAccountCurrency :428, defaultAccountLeverage :429, negativeBalanceProtection :411, requireAdmin2fa :331); `Account.chartSettings` :719; local files (terminal `%APPDATA%\VyxTrader\settings.json`, backoffice settings)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CFG | tenant facts + broker settings | SAVE PARTIAL (not audited; any 3 letters accepted, server USD only); PER GROUP / PER METHOD links WORKS / DUPLICATE; NBP, hedging, max slippage, withdrawal auto-approve, KYC L1/L2, staff 2FA, session timeout, audit retention PLACEHOLDER | bo-CFG SettingsScreen.cs:29-112 |
| BO | USR right column | 3) CFG panel | SAVE DUPLICATE (CFG) | bo-USR SettingsScreen.cs:29 |
| BO | SHELL | THEME cell | WORKS (local; PATCH /api/manage/theme not called) | bo-SHELL MainWindow.axaml.cs:289-290 |
| BO | DEAL | chart / MW view settings, requote step | local WORKS; ⚙ SAVE PARTIAL | bo-DEAL DS:445-458 |
| T | Settings (F12) | confirmations, slippage, 1-click, crosshair | confirm checkboxes WORKS; Slippage max PARTIAL (acts as a floor); 1-click default DUPLICATE; crosshair DUPLICATE; CHART APPEARANCE WORKS; RESET GRID SYMBOLS PARTIAL (no effect); SAVE / CANCEL WORKS; "Sounds and keyboard remapping" PLACEHOLDER | term-settings SettingsWindow.axaml:23-52; OrderValidation.cs:68-75 |
| T | Chart settings / indicators / drawings | server chartSettings; local studies/drawings files | Chart settings SAVE WORKS; Timezone UI-ONLY; indicators PARTIAL (local file, not server chart-indicators); sessions checkbox WORKS; SESSIONS chip DUPLICATE; Clear all drawings PARTIAL (no confirm) | term-chart ChartHost.cs:183-251 |
| T | Shell | THEME cell, splitters | WORKS (local) | term-shell |
- Gaps:
  - Broker.negativeBalanceProtection and requireAdmin2fa have no API write and no native control (bo-CFG :51, :67).
  - If the sign-in GET chart-settings failed, any later PUT overwrites the server document with defaults (term-settings MarketDataService.cs:1054-1055).
  - Terminal settings.json is per Windows user, not per account (term-settings A).

### 38. Report / statement (generated file)
- DB model: none (CSV / HTML / XLSX built from positions, transactions, accounts)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RPT | six server CSV reports + 4 KPIs | kind chips WORKS; RANGE pickers PARTIAL; range chips PARTIAL; SAVE CSV PARTIAL (unfiltered rows) | bo-RPT IbReportsScreens.cs:134-198 |
| BO | CLI 360 | STATEMENT CSV | PARTIAL | bo-CLI |
| BO | AUD | SAVE CSV | WORKS (≤200 rows) | bo-AUD |
| T | HISTORY tab | STATEMENT ⤓ (HTML / Excel / CSV) | WORKS | term-tabs MainWindow.axaml.cs:182-205 |
| T | F10 REPORTS | — | PLACEHOLDER | term-shell MainWindow.axaml.cs:313 |
| BO | SHELL F1 | — | PLACEHOLDER (help) | bo-SHELL |

### 39. Economic calendar event
- DB model: `EconomicCalendarCache` schema.prisma:2225
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 5) ECO panel | next events (≤40), impact badge | F6 refresh WORKS; rows have no click handler | term-eco MarketDataService.cs:1201-1233 |
- Gaps: No news headlines, no filter (term-eco). Backoffice: none. RDR NEWS flag is PLACEHOLDER (bo-RDR).

### 40. Price / candle (feed)
- DB model: `LivePrice` schema.prisma:1598; `Candle` :1643
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 2) Chart | candles M1…W1, live candle | timeframe 1M–1H WORKS; 4H / D / W PARTIAL (epoch bucketing vs broker grid); grid timeframe PARTIAL; VOL header UI-ONLY | term-chart Timeframe.cs:28-32; MarketDataService.cs:2257 |
| T | Market Watch, tape, ticket | bid / ask / spread / CHG% | view | term-marketwatch; term-shell; term-ticket |
| BO | DEAL chart + MW | candles, bid / ask | chart toolbar WORKS | bo-DEAL DealingChart.cs:163-164 |
| BO | FEED | core / gateway / alert-engine stats, per-symbol freshness | view (NOT REACHABLE cause UNVERIFIED) | bo-FEED LiquidityScreens.cs:247-283 |

---

## Matrix

V = shown, view / filter / navigation only. A = at least one control that writes or changes the entity (server or local), whatever its status. Blank = not present. Numbers = entity sections above.

### Backoffice
| # Entity | DASH | RPT | NTF | EXP | DEAL | DLS | SYM | GRP | ATY | MIR | RISK | RDR | EMG | MRG | LP | ROUTE | FEED | CLI | CRM | IB | KYC | LAR | DEP | APR | PSP | TRX | WAL | USR | AUD | SEC | CFG | SHELL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Account | V | V | A | V | A |  V |  |  |  |  | V | V |  | V |  |  |  | A | V | V | V | A | V | V |  | A | V |  | V |  |  | V |
| 2 Client (portal) |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |
| 3 Position (open) | V |  |  | A | A |  | V |  |  |  | A |  |  | A | V |  |  | V |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 4 Coverage position |  |  |  | A | A |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 5 Order | V |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  | V |
| 6 Deal (closed) | V | V |  |  | V | A |  |  |  |  |  | V |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 7 Position action request |  |  |  | A |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 8 Balance adjustment |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 9 Deposit | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  | A |  |  |  |  |  |  |  |  | V |
| 10 Withdrawal | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  | A |  |  |  |  |  |  |  |  | V |
| 11 Transfer |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  | A | V |  |  |  |  |  |
| 12 Wallet |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 13 Payment method |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  | V |  |
| 14 KYC record | V |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  | A |  |  |  |  |  |  |  |  |  |  | V |
| 15 Live account request | V |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  | V |
| 16 Lead |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 17 IB relationship |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  | A |  |  |  |  |  |  |  |  | V |  |  |  |
| 18 Staff user |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A | V | A |  | A |
| 19 Audit log entry | V |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 20 Notification |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 21 Price alert |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 22 STM rule |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 23 Liquidity provider |  | V |  |  |  |  |  |  |  |  |  |  |  |  | A | V |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 24 LP routing rule |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 25 Trading halt / close-only |  |  |  |  | A |  | A | A |  |  | V |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 26 Dealer mode / auto-hedge |  |  |  |  | A |  |  | V |  |  | A |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |
| 27 Risk limits | V |  |  | V |  |  | A |  |  | A | A |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 28 Margin snapshot | V | V |  |  |  |  |  |  |  |  | V |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 29 Risk radar flag |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 30 Symbol | V |  |  | V | V |  | A | A | A |  |  |  | A |  | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 31 Watchlist item |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 32 Group |  |  |  | V | A |  |  | A |  |  |  |  | A |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  | V |  |
| 33 Account type |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  | V |  |  |  | V |  |  |  |  |  |  | V |  |  |  |
| 34 Mirror rule |  |  | V |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 35 Session / credentials |  |  | A |  |  |  |  |  |  |  |  | V |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  | A |  | A |
| 36 Client build / update |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |
| 37 Settings / config |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  | A | A |
| 38 Report / statement |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 39 Economic calendar event |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 40 Price / candle |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Trader terminal
Columns: SH = shell / top bar / sign-in / status bar; MW = market watch (+ tape, spec dialog); CH = chart; OT = order ticket; F9 = New Order; TRD = TRADE tab (+ Modify / Share windows); PND = PENDING; ORD = ORDERS; HIS = HISTORY; BAL = BALANCE; LOG = LOG; ACC = account panel; ALR = alerts dialog; STM = Smart Trade Manager; SET = settings dialog; ECO = calendar.
| # Entity | SH | MW | CH | OT | F9 | TRD | PND | ORD | HIS | BAL | LOG | ACC | ALR | STM | SET | ECO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Account | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 3 Position (open) |  |  | A |  |  | A |  |  |  |  |  | V |  | A |  |  |
| 5 Order |  |  | A | A | A |  | A | V |  |  |  |  |  | A |  |  |
| 6 Deal (closed) |  |  |  |  |  |  |  |  | V |  |  | V |  |  |  |  |
| 8 Balance adjustment |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 9 Deposit |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 10 Withdrawal |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 12 Wallet | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 19 Audit log entry |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 21 Price alert |  |  | A |  |  |  |  |  |  |  | V |  | A |  |  |  |
| 22 STM rule | V |  |  |  |  | A |  |  |  |  |  |  |  | A |  |  |
| 25 Trading halt |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 28 Margin snapshot | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 30 Symbol | V | V | V | V | V |  |  |  |  |  |  |  | V |  |  |  |
| 31 Watchlist item | V | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 32 Group |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 35 Session / credentials | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 36 Client build / update | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 37 Settings / config | A | A | A |  |  |  |  |  |  |  |  |  |  |  | A |  |
| 38 Report / statement | V |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |
| 39 Economic calendar event |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 40 Price / candle | V | V | V | V | V |  |  |  |  |  |  |  |  |  |  |  |
Entities with no terminal presence (rows omitted above): 2, 4, 7, 11, 13, 14, 15, 16, 17, 18, 20, 23, 24, 26, 27, 29, 33, 34. Entity 25 (trading halt) is listed with an empty row: the terminal shows it only as a rejection message.
