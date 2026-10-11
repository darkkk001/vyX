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
