# VYX-AUDIT-ALL part 4/9


<!-- ===== term-chart.md ===== -->

# term-chart — 2) GP chart workspace (single chart, 2×2 grid, studies, drawings, positions on chart, one-click, settings)

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Chart code is shared with the backoffice Dealing screen: Vyx.Shared.Ui/Charting (ChartPanel, ChartHost, CandleChartControl, ChartDrawOperation, ChartGridCell, dialogs) + Vyx.Shared/Charting; terminal glue in MainWindow.axaml.cs and Services/MarketDataService.cs. Code-only audit.

## A. Purpose + panels
Price chart of the active symbol with timeframe toolbar, indicators, drawing tools, the trader's positions / SL / TP drawn and draggable, right-click order / SL-TP / alert menu, a floating one-click SELL/BUY widget, an inline confirm overlay + action line, a Single ↔ 2×2 grid layout, and three dialogs (Chart settings, Indicator settings, Drawing settings).
Panels (ChartPanel.axaml): title bar (13-71); Grid view of 4 ChartGridCells (77-82); Single view = toolbar (86-166) + CandleChartControl (171) with overlays: one-click widget (174-208), drawing mini-toolbar (210-217), one-click handle (219-222), confirm overlay (223-239), action line (240-243).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Candles (single + each cell) | GET /api/trade/candles?symbol&tf | FetchCandlesAsync ApiClient.cs:197-205 | candles/route.ts:22-27 → lib/candles.ts fetchCandleHistory (newest 300, VPS store with Neon fallback) | on symbol / timeframe change (MarketDataService.cs:2108-2169); stale responses dropped by generation (2131, 2135) |
| Live candle | WS ticks (bid) | PriceStreamClient | gateway | per tick: CandleChartControl.ApplyTick (CandleChartControl.cs:601-621) → CandleSeries.ApplyTick buckets with Timeframe.BucketStart (Vyx.Shared/Charting/CandleSeries.cs:186) |
| Day open / PDH / PDL / header CHG | GET candles tf=D1 | same | same | at load + hourly roll (MarketDataService.cs:1347-1384) |
| Positions on chart | GET /api/trade/positions | FetchPositionsAsync ApiClient.cs:237 | positions/route.ts | 4 s poll + every trading event (MarketDataService.cs:1083-1085, 275); P&L tags per tick (2189) |
| Chart appearance + one-click default + session map | GET /api/trade/chart-settings (on sign-in) / PUT | FetchChartSettingsAsync ApiClient.cs:402-408; SaveChartSettingsAsync ApiClient.cs:411-412 | chart-settings/route.ts:6-16, 22-38 (Account.chartSettings, whole-document replace merged over defaults) | sign-in (MarketDataService.cs:1054-1055) |
| Indicators | local file studies@{host}_{account}.json | – | – (the web uses GET/PUT /api/trade/chart-indicators, app/api/trade/chart-indicators/route.ts; the terminal does not call it) | loaded on account change (MainWindow.axaml.cs:218-219; ChartHost.cs:179-192) |
| Drawings | local file drawings@{host}_{account}.json, one set per SYMBOL (all timeframes) | – | – | reloaded on account change (MarketDataService.cs:1024-1031); saved on every change (2080-2084) |
| EMA 20/50, one-click panel shown, crosshair sync, grid symbols/timeframes | local settings.json (TerminalSettings.cs:20-23, 45-47) — global, not per account | – | – | on change |

Header cluster (title bar right): LAST / O / H / L = last candle of the displayed timeframe; CHG = last close vs D1 open (MarketDataService.cs:2234-2256); VOL is always `—` (2257). O/H/L hide below 620 px, VOL below 680 px (ChartPanel.axaml.cs:18-24).
Chart types: candles only — no bar / line / Heikin-Ashi switch exists (no ChartType in the code base).
Timeframes: toolbar M1 M5 M15 M30 H1 H4 D1 W1 (ChartPanel.axaml:89-96); grid cells M1…D1, no W1 (ChartGridCell.axaml:43-49).
Live bucketing: Timeframe.BucketStart floors to the Unix epoch (Vyx.Shared/Charting/Timeframe.cs:28-32; its doc says W1 lands on Thursday, 24-27). The engine buckets H4 / D1 / W1 on the broker-day grid, W1 on the broker Monday (engine/market-data/src/lib.rs:158-176). The fix "forming candle opens where the broker's bar opens" is on unmerged branch origin/fix/chart-open-reconcile (80ed185), not on master.

**On-chart position labels (asked explicitly)**: built PER POSITION, not aggregated. MarketDataService.PushPositionOverlay (MarketDataService.cs:1889-1905): primary = first open position found on the slot symbol (1876), plus one overlay for EVERY other open position on the same symbol (1901-1903); no cap. Each overlay's P&L = price difference × contract size × lots from the last tick (AccountMath.TryComputePositionPnl, Vyx.Shared/Trading/AccountMath.cs:107-116) — no swap, no commission, no FX conversion. Drawing (ChartDrawOperation.cs:754-824): each position gets its own entry line and a LEFT-edge tag `Buy 0.01 · +1.23` / `Sell 0.02 · −0.11` (765-774); tags sorted by price and pushed down 14 px when they overlap, without limit (775-782). SL / TP: one line + drag handle + right-edge tag `SL 4450.00` / `TP 4490.00` per position (788-814), same stacking. Grid cells draw entry line + tag only, no SL/TP (801). The only cap is in the right-click menu: `Set SL` / `Set TP` items for the first 4 positions (CandleChartControl.cs:519).

Empty/loading/error: chart status `loading {SYM} {TF}…`, `candles failed: {error}`, `no candles` (MarketDataService.cs:2132, 2138, 2153); grid cell status `loading…` / same texts (2133, 2139, 2154). Right-click on a chart with 0 candles shows nothing (CandleChartControl.cs:485).

## C. Controls
Status convention: WORKS also covers local-by-design controls (Server effect says "local").

| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| LAYOUT button (left click) | title bar right (ChartPanel.axaml:18-44) | IsLive | always | SetGridMode(!grid) (ChartPanel.axaml.cs:133-139; MarketDataService.cs:1152-1160) | local; grid cells load candles on first show | – | No | No | trader session | Single ↔ 2×2 | WORKS |
| Layout flyout: Single | LAYOUT right-click flyout (ChartPanel.axaml:33) | IsLive | always | SetGridMode(false) | local | – | No | No | – | single | WORKS |
| Layout flyout: Grid 2×2 | same (34) | IsLive | always | SetGridMode(true) | local | – | No | No | – | grid | WORKS |
| Layout flyout: Crosshair sync (grid) | same (36-38) | IsLive | always | none | local settings.json CrosshairSync (MarketDataService.cs:218-222) | – | No | No | – | vertical line mirrored in other cells (ChartHost.cs:104-109) | WORKS |
| Timeframe 1M / 5M / 15M / 30M / 1H | toolbar (ChartPanel.axaml:89-93) | single view | always | SelectChartAsync → GET /api/trade/candles | read only | – | No | No | – | active chart reloads | WORKS |
| Timeframe 4H / D / W | toolbar (94-96) | single view | always | same | read only | – | No | No | – | reload; live candle rolls on the epoch grid, not the broker grid | PARTIAL (forming candle bucketed on UTC-epoch grid vs engine broker-day / Monday grid) |
| INDICATORS button | toolbar (99-136) | single view | always | toggles flyout | none | – | No | No | – | flyout | WORKS |
| Indicator checkbox ×10 (MA, EMA, BOLL, SAR, RSI, MACD, KDJ, ATR, CCI, WR) | INDICATORS flyout (106-120) | flyout | always | ChartHost.ApplyStudies (ChartHost.cs:194-203) → StudiesStore.Save | local per-account file (StudiesStore.cs:19-28, 53-62) | – | No | No | – | study drawn; label `INDICATORS (n)` | PARTIAL (local file only, not the server chart-indicators document the web uses; one instance per kind, ChartHost.cs:183-190) |
| Indicator gear ⚙ | each flyout row (116) | flyout | always | opens IndicatorSettingsWindow (ChartPanel.axaml.cs:94-98; ChartHost.cs:216-228) | – | see D | No | No | – | dialog | WORKS |
| One-click panel checkbox | INDICATORS › CHART (123-125) | IsLive | always | Vm.OneClickPanelShown | local settings.json ShowOneClickPanel (MainWindow.axaml.cs:56) | – | No | No | – | widget shown / collapsed | WORKS |
| Sessions checkbox `ASIA · LONDON · NY` | INDICATORS › CHART (126-131) | always | always | SetSessionsAsync → PUT /api/trade/chart-settings (MarketDataService.cs:1992-2000) | Account.chartSettings.showSessionMap (chart-settings/route.ts:32-36); no audit | – | No | No | – | bands drawn M1–H4 only (ChartDrawOperation.cs:276); LOG `Sessions shown/hidden` | WORKS |
| EMA 20/50 chip | toolbar (137) | always (acts IsLive) | IsLive | Vm.EmaOn (ChartPanel.axaml.cs:88-92) | local settings.json ShowEma, global not per account | – | No | No | – | EMA lines on single + cells | WORKS |
| SESSIONS chip | toolbar (139) | always (acts IsLive) | IsLive | same as Sessions checkbox (ChartPanel.axaml.cs:37-41) | same | – | No | No | – | same | DUPLICATE (INDICATORS › Sessions checkbox; Chart settings › Session map toggle) |
| DRAW button | toolbar (140-159) | single view | always | toggles flyout | none | – | No | No | – | flyout | WORKS |
| Trend line / Horizontal line / Ray / Rectangle / Fibonacci retracement | DRAW flyout (147-151) | flyout | always | CandleChartControl.SetTool → PlaceAt clicks (CandleChartControl.cs:126, 244-261) | local per-account per-symbol file | price snapped to tick (248) | No | No | – | action line hint; drawing saved | WORKS |
| Clear all drawings (n) | DRAW flyout (153) | flyout | always | CandleChartControl.ClearDrawings (CandleChartControl.cs:130) | local file rewritten | – | No | No | – | all drawings of the symbol deleted | PARTIAL (no confirm, irreversible) |
| Chart settings… | DRAW flyout (154) | flyout | always | opens ChartSettingsWindow (ChartHost.cs:243-251) | – | – | No | No | – | dialog | WORKS |
| Drawing toolbar colour dots ×9 | next to selected drawing (ChartPanel.axaml:212; .cs:60-83) | a drawing selected | always | RecolorSelectedDrawing (CandleChartControl.cs:191-195) | local | – | No | No | – | recoloured, saved | WORKS |
| Drawing toolbar ⚙ | same (214) | a drawing selected | always | opens DrawingSettingsWindow (ChartHost.cs:135, 233-240) | – | – | No | No | – | dialog | WORKS |
| Drawing toolbar ✕ | same (215) | a drawing selected | always | RemoveSelectedDrawing (ChartHost.cs:136) | local | – | No | No | – | action line `{Kind} removed` | WORKS |
| One-click SELL / BUY | widget (178-195) | IsLive && panel shown | always | SubmitOneClick → PlaceTicketOrderAsync → POST /api/trade/orders type MARKET, volume = live ticket lots (MainWindow.axaml.cs:339-347; MarketDataService.cs:1645-1778; ApiClient.cs:296-302) | orders/route.ts:66-: Order (+ Position when filled), AuditLog, OrderFilled/OrderAccepted/DealingQueued events, dealer activity | client PrepareOrder (lots / tick / market closed / SL-TP side) + send-time slippage re-check (MarketDataService.cs:1655-1667); server risk checks | Yes when 1-CLICK OFF (MainWindow.axaml.cs:344); none when ON | No | – | action line `OK · BUY 0.01 XAUUSD filled` / `… awaiting dealer review` | WORKS |
| One-click − / + lots | widget (185, 188) | same | always | Ticket.StepVolume (ChartHost.cs:119) | local (shared with ticket panel) | min/max/step | No | No | – | lots changed | WORKS |
| One-click lots box | widget (186-187) | same | always | Ticket.Volume; Enter commits, blur repairs (ChartPanel.axaml.cs:159-165) | local | EnsureVolume | No | No | – | – | WORKS |
| `1-CLICK · ON/OFF` | widget (200-205) | same | always | SetOneClickAsync → PUT /api/trade/chart-settings oneClickDefault (MarketDataService.cs:1980-1988) | Account.chartSettings.oneClickDefault | – | No | No | – | `OK · 1-click ON` | WORKS |
| ‹ collapse / › expand handle | widget (199) / handle (219-222) | IsLive | always | Vm.OneClickPanelShown (ChartHost.cs:123-124) | local settings.json | – | No | No | – | widget hidden / shown | DUPLICATE (INDICATORS › One-click panel checkbox; chart right-click Collapse/Expand) |
| Confirm overlay CANCEL / action button / "Don't ask again until the terminal is restarted" | overlay (223-239) | a confirm pending | always | runs / drops the pending action (ChartHost.cs:149-150, 262-289) | per action | – | – | No | – | action line `OK · …` / `FAILED · …`, fades after 3 s (ChartHost.cs:74-80) | WORKS |
| Wheel on plot / on price axis | canvas (CandleChartControl.cs:669-678) | always | always | none | local | zoom 0.15–12 (674) | No | No | – | time zoom / price zoom | WORKS |
| Price-axis drag / double-click | canvas right axis (686-693, 749-755) | live | always | none | local | – | No | No | – | price scale / reset | WORKS |
| Plot drag | canvas (729-733, 757-768) | always | no tool armed | none | local | – | No | No | – | pan (x and y) | WORKS |
| Double-click on plot | canvas (694-707) | live | no tool armed | position line → OpenModifyPositionAsync (MainWindow.axaml.cs:275); legend / overlay line / sub-pane → indicator settings; drawing → drawing settings; else RestoreRequested (back to grid if maximised) | – | – | No | No | – | dialog / layout | WORKS |
| Drag SL / TP line of any position | canvas handle (709-717, 461-481) | single chart, position has SL/TP | always | RequestLegChange → ModifyPositionLegAsync → PATCH /api/trade/positions/{id} {currentPrice, slPrice/tpPrice} (MainWindow.axaml.cs:273, 467-478; ApiClient.cs:253-258) | positions/[id]/route.ts:12-101: Position.slPrice/tpPrice, PositionModified event, dealer activity (+ notification for dealing groups, lib/dealer-activity.ts:112-121); no AuditLog | client CheckLegChange (wrong side / stop level → refused, line snaps back); server validateSlTp against the client-sent currentPrice (route :23, 66-73) + trading session | Yes per ConfirmSlTpDrag (default ON, TerminalSettings.cs:14) | No | – | server truth refetched | WORKS |
| Drag from a position's entry line | canvas (719-727; 450-451) | single chart | always | same PATCH; below/above entry decides SL or TP | same | same | same | No | – | same | WORKS |
| Right-click: Buy Limit @ / Sell Stop @ (below bid) · Sell Limit @ / Buy Stop @ (at/above bid) | chart menu (CandleChartControl.cs:507-516) | single chart, candles loaded | always | OrderAtPriceRequested → PlaceChartOrderAsync → POST /api/trade/orders type LIMIT/STOP, no SL/TP, volume = Vm.TicketVolume (MainWindow.axaml.cs:276-281; MarketDataService.cs:1938-1944; ApiClient.cs:306-311) | orders/route.ts:679-719: Order PENDING, AuditLog ORDER_PLACED, OrderAccepted event, dealer activity | server direction check vs ask (BUY) / bid (SELL) (orders/route.ts:273-280); client gates on bid only | Yes per ConfirmChartOrders (default ON) | No | – | action line; no LOG entry, no orders refresh (poll / event) | PARTIAL (volume always the fixture `0.01`: Vm.TicketVolume is never written, MainViewModel.cs:15; side gating on bid lets a Buy Stop between bid and ask through to a server reject) |
| Right-click: Set SL {px} / Set TP {px} [· BUY 0.01] | chart menu (519-526) | ≥1 position on symbol | always | SetLegAtPriceRequested → RequestLegChange → PATCH /api/trade/positions/{id} (MainWindow.axaml.cs:274) | as drag | as drag | Yes per ConfirmSlTpDrag | No | – | as drag | PARTIAL (only the first 4 positions listed; labels distinguish by side + lots only) |
| Right-click: Alert above/below {px} | chart menu (527) | candles loaded | always | AlertRequested → CreateChartAlertAsync → POST /api/trade/alerts {symbol, ABOVE/BELOW, price} (MainWindow.axaml.cs:282-287; MarketDataService.cs:1946-1952) | PriceAlert row + NATS cfg.alerts.{broker} (alerts/route.ts:61-86); no audit | server: symbol enabled, price > 0, ≤ 50 active (alerts/route.ts:39-59) | Yes per ConfirmAlerts | No | – | action line only (no LOG entry, alert list not refreshed) | WORKS |
| Right-click: Collapse / Expand one-click panel | chart menu (529) | single chart | always | Vm.OneClickPanelShown toggle (ChartHost.cs:125) | local | – | No | No | – | – | DUPLICATE (‹ / › handle; INDICATORS › One-click panel) |
| Right-click: {Kind} settings… | chart menu (533) | a drawing within 10 px | always | DrawingEditRequested → DrawingSettingsWindow | local | – | No | No | – | dialog | WORKS |
| Right-click: Remove drawing | chart menu (534) | any drawing exists on the symbol | always | RemoveDrawingNear (279-292) | local | within 8 px | No | No | – | removed, or nothing when none is near (silent) | PARTIAL (shown even when no drawing is under the pointer; silent no-op) |
| Right-click: Clear all drawings (n) | chart menu (535) | any drawing | always | ClearDrawings | local | – | No | No | – | all removed | DUPLICATE (DRAW flyout › Clear all drawings; neither confirms) |
| Right-click: Reset view | chart menu (538) | candles loaded | always | viewport + price scale reset | local | – | No | No | – | – | WORKS |
| Grid cell symbol ▾ | cell header (ChartGridCell.axaml:18-37) | grid view | always | CellSymbolRequested → SelectCellAsync → GET candles (MainWindow.axaml.cs:49; MarketDataService.cs:2098-2103) | local settings.json GridSymbols | – | No | No | – | cell reloads, focused | WORKS |
| Grid cell timeframe 1m…D | cell header (43-49) | grid view | always | SelectCellAsync → GET candles | local GridTimeframes | – | No | No | – | cell reloads | PARTIAL (4H / D same epoch-bucket gap as the toolbar) |
| Grid cell click / double-click | cell (ChartGridCell.axaml.cs:21, 23-28; ChartHost.cs:98, 101) | grid view | always | FocusCell / MaximizeCellAsync (MarketDataService.cs:1162-1181) | local | – | No | No | – | focus border; maximise into single chart | WORKS |
| Grid cell right-click: Reset view | cell menu (CandleChartControl.cs:490) | candles loaded | always | local | local | – | No | No | – | – | WORKS |
| Grid cell right-click: Maximize | cell menu (491) | candles loaded | always | DoubleClicked → MaximizeCellAsync | local | – | No | No | – | maximised | DUPLICATE (cell double-click) |
| Esc / Delete keys | window KeyDown → ChartHost.HandleKey (ChartHost.cs:169-175) | – | not in a TextBox, no confirm open | none | local | – | No | No | – | tool/selection dropped; selected drawing removed | WORKS |
| Chart settings: SAVE | ChartSettingsWindow (ChartSettingsWindow.axaml:15-17) | dialog | always | PUT /api/trade/chart-settings whole document (ChartSettingsWindow.axaml.cs:35-44; MainWindow.axaml.cs:59) | Account.chartSettings (chart-settings/route.ts:32-36); unknown keys preserved (ChartVisualSettings.cs:30) | invalid colour → previous value (ChartSettingsViewModel.cs:56) | No | No | – | applied to every chart on success only; `FAILED · …` in dialog on error | WORKS |
| Chart settings: CANCEL | same (12-14) | dialog | always | none | none | – | No | No | – | closes | WORKS |
| Chart settings: Timezone `UTC` | same (48-53) | dialog | not editable | none | none | – | – | – | – | – | UI-ONLY |
| Indicator settings: APPLY / Enter | IndicatorSettingsWindow (IndicatorSettingsWindow.axaml:24) | dialog | always | ChartHost Applied → ApplyStudies(persist) (ChartHost.cs:219-224) | local per-account file | see D | No | No | – | study switched on; `{label} applied` | WORKS |
| Indicator settings: CANCEL / Esc | same (23) | dialog | always | none | none | – | No | No | – | closes | WORKS |
| Drawing settings: APPLY | DrawingSettingsWindow (DrawingSettingsWindow.axaml:24) | dialog | always | ReplaceDrawing (ChartHost.cs:236) | local | see D | No | No | – | `{Kind} updated` | WORKS |
| Drawing settings: CANCEL | same (23) | dialog | always | none | none | – | No | No | – | closes | WORKS |
| VOL header cell | title bar (ChartPanel.axaml:65-68) | ≥680 px | – | none | none | – | – | – | – | always `—` (MarketDataService.cs:2257) | UI-ONLY |

## D. Dialogs
**Chart Settings** (ChartSettingsWindow, 380×560). Stored in Account.chartSettings (JSON) via PUT /api/trade/chart-settings.
| Field | Type | Default (ChartVisualSettings.cs) | Stored in | Read by |
|---|---|---|---|---|
| Up body / Down body / Up border / Down border / Up wick / Down wick | hex text + swatch | #3CC98A / #F0506E (12-17) | chartSettings.candleUp/DownColor, …BorderColor, …WickColor | ChartDrawOperation via ParseArgb (accepts `#RRGGBB` only, ChartVisualSettings.cs:48-52); web chart |
| Grid lines | checkbox | on (18) | showGrid | chart render |
| Last-price line | checkbox | on (19) | showLastPriceLine | ChartDrawOperation.cs:690 |
| Previous day high/low (PDH/PDL) | checkbox | off (20) | showSessionHighLow | ChartDrawOperation.cs:712 |
| Session map (Asia/London/NY) | checkbox | off (21) | showSessionMap | ChartDrawOperation.cs:276 (M1–H4 only) |
| OHLC info bar | checkbox | on (22) | showOhlcBar | ChartDrawOperation.cs:885 |
| Timezone | static `UTC` | – | nowhere | nowhere |
Colour validation: Avalonia Color.TryParse, so named colours and `#AARRGGBB` pass and are saved upper-cased (ChartSettingsViewModel.cs:56); the renderer then falls back to its default for anything not `#RRGGBB`.

**Indicator settings** (IndicatorSettingsWindow, 360×440): title = kind, `overlay on the price` / `own pane`; PARAMETERS fields per kind (defaults Indicators.cs:30-43: MA/EMA period 9; BOLL 20 / 2; SAR 2/2/20; RSI 14, 70/30; MACD 12/26/9; KDJ 9/3/3, 80/20; ATR 14; CCI 20, ±100; WR 14, −20/−80); Source (close/open/high/low/hl2/hlc3/ohlc4; hidden for SAR/ATR/KDJ/WR); Colour (9 swatches, first = theme); Line width (0.5–6, blank = 1). Validation: numbers only; >0 except levels; period-type fields whole 1–1000; Fast < Slow; Lower < Upper (IndicatorSettingsViewModel.cs:47-63). Stored in the local studies@{host}_{account}.json only; read by the chart only.

**Drawing settings** (DrawingSettingsWindow, 360×360): title = kind, anchors `y1 → y2`; LEVELS (%) (Fibonacci only; watermark `0, 23.6, 38.2, 50, 61.8, 78.6, 100`; at least one number); Colour (9 swatches); Line width 0.5–6 (DrawingSettingsViewModel.cs:41-61). Stored in local drawings@{host}_{account}.json; read by the chart only.

## E. Text
- DrawingsStore doc: `one document keyed by SYMBOL|TF` (DrawingsStore.cs:7-8) — the set is per symbol across all timeframes (Vyx.Shared/Charting/Drawings.cs:43-54).
- StudiesStore doc: `Persists the STUDIES picker's choice per user at %APPDATA%\VyxTrader\studies.json` (StudiesStore.cs:9-10) — terminal file is per account.
- Button word `INDICATORS` live, `STUDIES` in the fixture (ChartHost.cs:32, 199).
- `VOL` header always `—` (MarketDataService.cs:2257).
- Chart settings `Timezone` shows a fixed `UTC` box that looks like a picker (ChartSettingsWindow.axaml:48-53).
- Right-click Set SL/TP labels `Set SL {px} · BUY 0.01` — no ticket number (CandleChartControl.cs:522-524).
- Code-comment in ChartPanel.axaml:16-17 still calls the account strip "a stage-2 region".

## F. UI structure map
**Title bar**: `2)` `GP` + subtitle `{SYMBOL} · {description}` (live; ChartPanelViewModel.cs:40-41; MainViewModel.cs:89). Header-right in order: LAYOUT button (two pane glyphs + `LAYOUT · SINGLE` / `LAYOUT · 2×2`, live only) · `LAST` · `CHG` (green/red) · `O` · `H` · `L` · `VOL`.
**Layout flyout** (right-click on LAYOUT): `CHART LAYOUT` / `Single` / `Grid 2×2` / ─── / `[✓] Crosshair sync (grid)` / hint `Double-click a cell: maximize / restore`. Left-click toggles directly.
**Toolbar (single view)**, left: `1M 5M 15M 30M 1H 4H D W` (active = accent). Right: `INDICATORS (n)` (flyout) · `EMA 20/50` (amber when on) · `VWAP` (fixture only) · `SESSIONS` (amber when on) · `DRAW` (amber while a tool is armed; flyout) · `FIB`, `OB`, `FVG` (fixture only). No primary/orange button.
**INDICATORS flyout**: `INDICATORS` / 10 rows `[ ] {label e.g. MA(9)}  overlay|pane  ⚙` / ─── / `CHART` / `[✓] One-click panel` (live) / `[ ] Sessions  ASIA · LONDON · NY`.
**DRAW flyout**: `DRAWING TOOLS` / `Trend line` / `Horizontal line` / `Ray` / `Rectangle` / `Fibonacci retracement` / ─── / `Clear all drawings (n)` (red) / `Chart settings…`.
**Canvas overlays**: one-click widget top-left (`SELL {bid}` · `−` `{lots}` `+` · `BUY {ask+markup}` / `{SYMBOL}` · `1-CLICK · OFF|ON` · `‹`); collapsed = `›` handle; drawing mini-toolbar (9 colour dots · ⚙ · ✕); confirm overlay top-centre (amber title, detail, optional note, optional `Don't ask again until the terminal is restarted`, `CANCEL`, orange action button e.g. `PLACE ORDER` / `MODIFY` / `ADD ALERT`); action line bottom-left (`sending…`, `OK · …`, `FAILED · …`).
**Canvas content**: candles, grid, last-price line + plate + candle countdown, PDH/PDL (if on), session bands (if on, M1–H4), studies (overlays + 96 px sub-panes), drawings, per-position entry lines + left tags, SL/TP lines + handles + right tags, crosshair with price / time plates and OHLC readout.
**Tables**: none on the chart.
**Right-click on single chart: YES** (CandleChartControl.cs:495-539), exactly:
```
{price} · below market | {price} · above market      (disabled header)
────────────
Buy Limit @ {price}            (below)   |  Sell Limit @ {price}   (at/above)
Sell Stop @ {price}            (below)   |  Buy Stop @ {price}     (at/above)
────────────
Set SL {price}[ · BUY|SELL {lots}]        ┐ per open position on the symbol,
Set TP {price}[ · BUY|SELL {lots}]        ┘ first 4 only; suffix only when >1
────────────                              (only when ≥1 position)
Alert below {price} | Alert above {price}
────────────
Collapse one-click panel | Expand one-click panel
────────────
{Kind} settings…                          (only when a drawing is within 10 px)
Remove drawing                            ┐
Clear all drawings ({n})                  ├ only when the symbol has drawings
────────────                              ┘
Reset view
```
No shortcuts, no submenus; all items enabled. Right-click with no candles: nothing. Right-click on price axis / time axis: same menu (no separate handler).
**Right-click on a grid cell: YES** (CandleChartControl.cs:486-493): `Reset view` / `Maximize`.
**Grid cell header**: `{SYMBOL}  ▾` (picker flyout, watchlist then all enabled symbols) · live price (green) · `H x  L y` · status (amber) · `1m 5m 15m 30m 1H 4H D`. Focused cell = accent border 1.5 px.

## Issues
[money] chart · right-click Buy/Sell Limit/Stop orders are always sent with 0.01 lots: they use Vm.TicketVolume, a design-fixture property that nothing ever writes (the one-click widget uses the live Ticket.Volume) · ViewModels/MainViewModel.cs:15; MainWindow.axaml.cs:276-281; Services/MarketDataService.cs:1938-1941
[functional] chart · H4 / D1 / W1 forming candle is bucketed on the UTC-epoch grid (W1 on Thursday) while the engine uses the broker-day / broker-Monday grid; the reconcile fix sits on unmerged origin/fix/chart-open-reconcile (80ed185) · Vyx.Shared/Charting/Timeframe.cs:24-32; Vyx.Shared/Charting/CandleSeries.cs:186; engine/market-data/src/lib.rs:158-176
[money] chart · on-chart position tag P&L = price diff × contract × lots in quote currency (no FX, no swap/commission) · Services/MarketDataService.cs:1896-1899; Vyx.Shared/Trading/AccountMath.cs:107-116
[money] chart · SL/TP PATCH is validated server-side against the currentPrice the client sends, not a server price (exploit not executed: read-only audit) · app/api/trade/positions/[id]/route.ts:23,66-73
[functional] chart · right-click order side gating uses the bid for both sides; the server checks BUY against the ask, so a Buy Stop between bid and ask is offered then rejected · Vyx.Shared.Ui/Charting/CandleChartControl.cs:496-516; app/api/trade/orders/route.ts:273-280
[functional] chart · indicators are stored only in a local per-account file; the web stores them server-side (/api/trade/chart-indicators), so terminal and web never share them; only one instance per indicator kind · Vyx.Shared.Ui/Charting/StudiesStore.cs:19-28; Vyx.Shared.Ui/Charting/ChartHost.cs:183-190; app/api/trade/chart-indicators/route.ts
[ux] chart · "Clear all drawings" (DRAW flyout and right-click) deletes every drawing of the symbol with no confirm · Vyx.Shared.Ui/Charting/CandleChartControl.cs:130,535; Vyx.Shared.Ui/Charting/ChartPanel.axaml:153
[ux] chart · right-click "Remove drawing" is shown whenever the symbol has any drawing and silently does nothing when none is under the pointer · Vyx.Shared.Ui/Charting/CandleChartControl.cs:279-292,534
[ux] chart · right-click Set SL/TP lists only the first 4 positions, identified by side + lots only · Vyx.Shared.Ui/Charting/CandleChartControl.cs:519-525
[ux] chart · per-position entry tags stack downward 14 px each with no limit and sit at x=4 under the one-click widget (legend is inset, tags are not) · Vyx.Shared.Ui/Charting/ChartDrawOperation.cs:775-782; Vyx.Shared.Ui/Charting/ChartPanel.axaml:174
[functional] chart · right-click pending order and alert: no LOG journal entry and no orders/alerts refresh after success (ticket orders do both) · Services/MarketDataService.cs:1938-1952
[ux] chart · EMA 20/50, one-click panel and crosshair sync are global settings.json values while indicators and drawings are per account · Services/TerminalSettings.cs:45-47; MainWindow.axaml.cs:55-56
[ux] chart · chart settings accept named / 8-digit colours (saved upper-cased) that the renderer cannot parse and replaces with the default · Vyx.Shared.Ui/Charting/ChartSettingsViewModel.cs:56; Vyx.Shared/Charting/ChartVisualSettings.cs:48-52
[text] chart · VOL header is always `—`; chart settings Timezone is a fixed `UTC` box · Services/MarketDataService.cs:2257; Vyx.Shared.Ui/Charting/ChartSettingsWindow.axaml:48-53
[text] chart · DrawingsStore / StudiesStore doc comments describe SYMBOL|TF keys and a per-user file; actual = per symbol, per account · Vyx.Shared.Ui/Charting/DrawingsStore.cs:7-8; Vyx.Shared.Ui/Charting/StudiesStore.cs:9-10
[functional] chart · no chart type other than candles (no bars / line) · Vyx.Shared.Ui/Charting/ChartDrawOperation.cs (no chart-type code in src)

## Status counts
`STATUS-COUNTS app=terminal screen=chart WORKS=40 PARTIAL=7 UI-ONLY=2 PLACEHOLDER=0 DEAD=0 DUPLICATE=5`


<!-- ===== term-ticket.md ===== -->

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


<!-- ===== term-neworder.md ===== -->

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


<!-- ===== term-positions.md ===== -->

# term-positions · Trader terminal · 4) TRADE tab (open positions), row actions, bulk closes, Modify/Close window, share card

## A. Purpose + panels
Dock tab `TRADE` (internal key POS) under the chart: every open position with live CURRENT / PTS / P/L, per-row action chips, inline S/L · T/P edit, right-click menu, bulk CLOSE PROFIT / CLOSE LOSS / CLOSE ALL, footer totals. Satellite windows: Modify / Close Position (D2) and Share Trade (D6).
Evidence: E:\vyxtrader\src\Vyx.Trader.App\Views\PositionsPanel.axaml:156-263, 506-514; PositionsPanel.axaml.cs; ModifyPositionWindow.axaml(.cs); ViewModels\ModifyPositionViewModel.cs; ShareCardWindow.axaml(.cs); Services\ShareCard.cs; MainWindow.axaml.cs:83-215.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort / limits |
|---|---|---|---|---|---|
| TRADE rows | GET /api/trade/positions | FetchPositionsAsync ApiClient.cs:237-247 | app/api/trade/positions/route.ts:5-28 | poll every 4 s (MarketDataService.cs:1083-1085) + every trading event (275) + after every action; stale responses dropped by sequence (1844-1850) | server order; no client sort; no pagination |
| CURRENT / PTS / P/L | WS ticks | – | – | per tick of the row's symbol (MarketDataService.cs:2197; DockViewModels.cs:199-212) | P/L = diff×contract×lots, no FX conversion (AccountMath.cs:107-116) |
| DURATION | local clock | – | – | 1 s timer (MainWindow.axaml.cs:146-148) | column hidden by default (TableLayout.cs:141) |
| COMMENT | local settings.json TradeComments | – | – | on row set change (MainWindow.axaml.cs:153) | no server field (MarketDataService.cs:2024-2035) |
| Footer | computed | – | – | positions refresh + ticks (MarketDataService.cs:494-508) | "N POSITIONS · L LOTS · EXPOSURE X CUR", swap, P/L |
| Modify window | same position + ticks | FindPosition / PositionTick / PositionsChanged | – | tick + every positions refresh (ModifyPositionWindow.axaml.cs:30-43) | – |
Empty: "No open positions" (PositionsPanel.axaml:262). Stream down: amber "STREAM OFFLINE / RECONNECTING / CONNECTING" left of the bulk buttons (PositionsPanel.axaml:183-184; MarketDataService.cs:255). No loading text.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| CLOSE PROFIT | tab row right, PositionsPanel.axaml:187 | TRADE tab | always | CloseFilteredAsync("profitable") (MainWindow.axaml.cs:138-139; MarketDataService.cs:711-751) → CloseBulkAsync scope PROFIT (ApiClient.cs:280-285) → POST /api/trade/positions/close-bulk | non-dealer: lib/bulk-close.ts closePositionInTx per position (Position CLOSED, Account.balance, Transaction TRADE_PNL, credit/NBP rows position-close.ts:142-215), mirror.onClose + coverage.onClose (bulk-close.ts:185-194), NATS; dealer mode: queued close Order + AuditLog DEALING_CLOSE_QUEUED per position (close-bulk/route.ts:35-101; queued-close.ts:10-40) | server classifies profit/loss and prices each close (close-bulk/route.ts:104-116) | always (Confirm(true), MainWindow.axaml.cs:138) | no | trader session | journal per position + summary; refresh positions/orders/history/balance/account (MarketDataService.cs:748) | WORKS |
| CLOSE LOSS | :188 | TRADE tab | always | same, scope LOSS | same | same | always | no | – | same | WORKS |
| CLOSE ALL | :189 | TRADE tab | always | same, scope ALL | same | same | always | no | – | same | WORKS |
| BE chip | row actions, :248 | chips shown (no notice, no close pending) | – | RowActionRequested "BE" → BreakEvenAsync([id]) (MainWindow.axaml.cs:158; MarketDataService.cs:600-617) → ModifyPositionAsync → PATCH /api/trade/positions/{id} (ApiClient.cs:253-259) | Position.slPrice update, NATS PositionModified, dealer activity ORDER_MODIFIED (positions/[id]/route.ts:77-110); no AuditLog | client: skipped when not in profit (MarketDataService.cs:609-610), SlTpValidation (1547); server: checkTradingSession + validateSlTp vs client currentPrice (positions/[id]/route.ts:52-76) | ConfirmSlTpDrag (default true), "don't ask again" key break-even | no | – | "break-even on N position(s), M not in profit" | WORKS |
| PART chip | :249 | chips shown | – | menu `Close 25% now` / `Close 50% now` / `Close 75% now` (PositionsPanel.axaml.cs:198-205) → PartialCloseAsync (MarketDataService.cs:641-653) → CloseManyAsync → ClosePositionAsync(id, price, volume) → POST /api/trade/positions/{id}/close | closePositionInTx partial (position-close.ts), mirror.onClose, coverage.onClose, NATS PositionClosed, dealer activity POSITION_CLOSED (close/route.ts:232-302); dealer mode: queued close 202 (close/route.ts:168-214) | min-lot position → row notice "min lot — cannot split", nothing sent (PositionsPanel.axaml.cs:200); server lot-step + remainder ≥ minLot (close/route.ts:126-163) | ConfirmTicketOrders, key partial-close (MainWindow.axaml.cs:159-162) | no | – | "N% closed on K position(s)" | WORKS |
| MOD chip | :250 | chips shown | – | opens Modify / Close window | – | – | – | – | – | – | WORKS |
| SHARE chip | :251 | chips shown | – | opens Share Trade window (MainWindow.axaml.cs:444-460) | none | – | – | – | – | – | WORKS |
| REV chip | :252 | chips shown | – | ReversePositionAsync (MarketDataService.cs:2040-2058): ClosePositionByIdAsync then PlaceTicketOrderAsync MARKET opposite side same lots → POST close + POST /api/trade/orders | close effects + order-fill effects (route.ts:594-676) | close queued for the dealer → opposite NOT opened (2048); opposite order has no SL/TP; slippage default (2054) | always (Confirm(true), MainWindow.axaml.cs:170-178) | no | – | origin "Reverse of #…" stored locally (177) | WORKS |
| ✕ close chip | :253 | chips shown | – | ClosePositionRequested → ClosePositionByIdAsync (MarketDataService.cs:512-536) → POST /api/trade/positions/{id}/close {closePrice, source:"DESKTOP_NATIVE"} (ApiClient.cs:264-269) | as PART (full close) | client: live price present (518), not close-pending (521); server: session, live price, slippage vs body maxSlippagePips (never sent by the terminal) else broker default (close/route.ts:101-121, 218-229) | ConfirmTicketOrders, key close-position (MainWindow.axaml.cs:130) | no | – | row dropped at once on full close (MarketDataService.cs:533, 1862-1868) | WORKS |
| CANCEL (close awaiting dealer) | :243-246 | ClosePending | – | CancelPendingCloseAsync (MarketDataService.cs:586-594) → DELETE /api/trade/orders/{closePendingOrderId} (ApiClient.cs:373-374) | queued close Order CANCELLED, position lock released, AuditLog, NATS OrderCancelled, dealer activity (orders/[id]/route.ts:206-283) | – | always (MainWindow.axaml.cs:165-169) | no | – | row unlocks | WORKS |
| Inline S/L ✎ and T/P ✎ cells | :231-232 | column visible | always (also on a close-pending row) | Enter / click-away → LegEditRequested → RequestLegChange (MainWindow.axaml.cs:210-215, 467-478) → ModifyPositionLegAsync (MarketDataService.cs:782-805) → PATCH /api/trade/positions/{id} | as BE | client CheckLegChange (770-780) → row notice + snap back; empty = clear leg; server validateSlTp | ConfirmSlTpDrag, no key; cancel refreshes positions | no | – | server level read back, "not applied" when the server shows another level (802) | PARTIAL (re-entering the same value after a cancelled/failed attempt is swallowed by the `_lastLegRequest` de-dupe, PositionsPanel.axaml.cs:298-321) |
| COMMENT ✎ cell | :237 | column visible (hidden by default, TableLayout.cs:143) | always | SetComment (MarketDataService.cs:2029-2035) | none (local settings.json only) | – | no | – | – | tooltip shows the note | UI-ONLY |
| Row double-click | row, :219 | – | – | Modify / Close window (PositionsPanel.axaml.cs:89-92) | – | – | – | – | – | – | WORKS |
| Right-click › Modify / close … | menu item 1 (PositionsPanel.axaml.cs:76) | – | always | Modify window | – | – | – | – | – | – | DUPLICATE (MOD chip, double-click) |
| Right-click › Smart rules … | item 2 (:79) | – | always | SmartRulesWindow (MainWindow.axaml.cs:88, 408-414) | see term-stm.md | – | – | – | – | – | WORKS |
| Right-click › Close SYMBOL LOTS | item 3 (:77) | – | always (also on a close-pending row; server answers "close already awaiting the dealer", MarketDataService.cs:521) | as ✕ | as ✕ | as ✕ | ConfirmTicketOrders | no | – | – | DUPLICATE (✕ chip) |
| Right-click › Close by › "#T SIDE LOTS @ price" | item 4 (:80-83) | – | ≥1 opposite, not close-pending, same symbol (CloseBy.cs:16-18) | CloseByAsync (MarketDataService.cs:540-559) → POST /api/trade/positions/close-by (ApiClient.cs:273-274) | closePositionsByEachOther: two closePositionInTx at mid (close-by.ts:106-160), mirror + coverage per leg, NATS PositionsClosed; dealer mode: two queued close Orders, 202 (close-by/route.ts:25-76) | server resolveCloseByPair (close-by.ts) | always (MainWindow.axaml.cs:131-137) | no | – | journal "Closed N lots SYMBOL: … @ price" | WORKS |
| Right-click › Share … | item 6 (:78) | – | always | Share window | – | – | – | – | – | – | DUPLICATE (SHARE chip) |
| Header right-click (column picker) | header row, :199 | – | – | ShowColumnPicker (PositionsPanel.axaml.cs:221-241) | none (settings.json TableColumns) | – | – | – | – | persisted (MarketDataService.cs:2003-2011) | WORKS |
| Header grip resize | header cell right edge, :207 | – | – | OnGrip* (PositionsPanel.axaml.cs:245-264) | none | 28-600 px | – | – | – | switches table to manual widths | WORKS |
| Modify window · STOP LOSS / TAKE PROFIT + CLEAR | ModifyPositionWindow.axaml:55-64 | – | – | none | – | – | – | – | – | – | PARTIAL (typed values are overwritten by every 4 s positions refresh: PositionsChanged → Vm.Refresh sets Sl/Tp, ModifyPositionWindow.axaml.cs:31, 38-43; ModifyPositionViewModel.cs:67-68) |
| Modify window · MODIFY SL / TP | :66-68 | – | always | SubmitModify → ModifyPositionAsync (MarketDataService.cs:1538-1554) → PATCH /api/trade/positions/{id} (only changed legs; other = Keep) | as BE | PrepareLegs: parse, "Nothing changed", SlTpValidation (ModifyPositionViewModel.cs:89-109) | in-dialog strip if ConfirmSlTpDrag | no | – | "OK · SL x · TP y" | WORKS |
| Modify window · LOTS TO CLOSE + 25% / 50% / 100% | :72-80 | – | – | none (fills the box, lot-step rounded, ModifyPositionWindow.axaml.cs:46-53) | – | – | – | – | – | button caption becomes "CLOSE x OF y (PARTIAL)" | WORKS |
| Modify window · CLOSE POSITION / CLOSE x OF y (PARTIAL) | :82-84 | – | always | SubmitClose → ClosePositionByIdAsync(id, partial ? lots : null) → POST /api/trade/positions/{id}/close | as ✕ / PART | PrepareClose: >0, ≤ volume, ValidateVolume, remainder valid (ModifyPositionViewModel.cs:115-126) | in-dialog strip if ConfirmTicketOrders | no | – | "position is no longer open" after full close (ModifyPositionWindow.axaml.cs:41) | WORKS |
| Modify window · confirm CANCEL / MODIFY·CLOSE·CLOSE PART | :25-35 | ConfirmVisible | – | AcceptAsync | – | – | – | – | – | – | WORKS |
| Modify window · CLOSE WINDOW | :42 | – | – | Close() | – | – | – | – | – | – | WORKS |
| Share window · SAVE PNG | ShareCardWindow.axaml:12 | – | – | writes %USERPROFILE%\Pictures\VyxTrader\share-SYMBOL-yyyyMMdd-HHmmss.png (ShareCard.cs:77-82; ShareCardWindow.axaml.cs:29-36) | none | – | no | – | – | "Saved <path> (N KB)" | PARTIAL (P/L is quote-currency diff×contract×lots labelled with the account currency, no FX, ShareCard.cs:20-23) |
| Share window · COPY TEXT | :11 | – | – | clipboard SummaryText (ShareCardWindow.axaml.cs:39-43) | none | – | no | – | – | "Summary text copied to the clipboard" | WORKS |
| Share window · CLOSE | :13 | – | – | Close() | – | – | – | – | – | – | WORKS |

## D. Dialogs
Modify / Close Position (ModifyPositionWindow.axaml:7, 420×690):
| Field | Type | Default | Stored in | Read by | Conditional |
|---|---|---|---|---|---|
| STOP LOSS | text | position SL or "" | Position.slPrice | lib/risk-monitor.ts:110-128; engine/market-data/src/risk_hook.rs | empty = remove |
| TAKE PROFIT | text | position TP or "" | Position.tpPrice | same | empty = remove |
| LOTS TO CLOSE | text | full volume | Position.volume (reduced) / Transaction TRADE_PNL | position-close.ts:142-160 | – |
Header "SYMBOL  SIDE LOTS @ OPEN  ·  #TICKET"; live OPEN / CURRENT / P/L (P/L no FX, ModifyPositionViewModel.cs:79-80). Hints: "BUY: SL below · TP above the price · min N ticks · empty = remove" (25); "Partial close: rest stays open · step 0.01" (26).
Confirm strips (in-window): MODIFY SL / MODIFY TP / MODIFY SL / TP · button MODIFY; CLOSE POSITION / PARTIAL CLOSE · buttons CLOSE / CLOSE PART (ModifyPositionWindow.axaml.cs:62-86).
Main-window confirm overlays (ChartHost.Confirm): `CLOSE POSITION` "Close XAUUSD 0.01?" [CLOSE]; `CLOSE BY` CloseBy.Describe text [CLOSE BY]; `CLOSE ALL POSITIONS` "Close all positions?" / `CLOSE PROFITABLE POSITIONS` "Close profitable positions?" / `CLOSE LOSING POSITIONS` "Close losing positions?" [CLOSE]; `BREAK-EVEN` [BREAK-EVEN]; `PARTIAL CLOSE 50%` "Close 50% of XAUUSD 0.10?" [CLOSE PART]; `REVERSE POSITION?` "Reverse XAUUSD 0.10 · Buy → Sell?" [BUY → SELL]; `WITHDRAW CLOSE REQUEST` [WITHDRAW]; `MODIFY SL` / `MODIFY TP` [MODIFY] (MainWindow.axaml.cs:130-178, 476-477).
Share Trade (ShareCardWindow.axaml, 660×470): preview of a 1200×630 PNG (brand, date UTC, symbol, side+lots, P/L, % on margin, entry → current/close, masked account, "Trade with <brand>") + one-line summary; no inputs.

## E. Text
- P/L column header "P/L USD" is fixed whatever the account currency (TableLayout.cs:143); footer uses the account currency (MarketDataService.cs:503-504).
- Column "PTS" shows pips (move / (tick×10)) (TableLayout.cs:143; PositionMath.cs:34-39).
- Close-pending row text "CLOSE · AWAITING DEALER" / "CLOSE 0.05 REQUOTED @ x · see PENDING" (DockViewModels.cs:174-183).
- Right-click label "Close by… (no opposite XAUUSD position)" is the disabled state (PositionsPanel.axaml.cs:82).
- Share summary uses ASCII "->" while the PNG uses "→" (ShareCard.cs:32 vs 62).
- Share PNG folder is hard-coded "VyxTrader" regardless of broker brand (ShareCard.cs:79).
- Tooltip names: "Break-even", "Partial close", "Modify", "Share", "Reverse", "Close" on chips labelled BE / PART / MOD / SHARE / REV / ✕ (PositionsPanel.axaml:248-253).

## F. UI structure map
Layout: middle column bottom (MidCol row 2, 232 px default, 120-520, MainWindow.axaml:39-43). Tab strip row: tabs `4) TRADE` (prefix "4) " only on the active tab) · `PENDING` · `ORDERS` · `HISTORY` · `BALANCE` · `LOG` (DockViewModels.cs:16-19, 90); right side: stream warning (amber, only when down) · `CLOSE PROFIT` (green outline) · `CLOSE LOSS` (red) · `CLOSE ALL` (red) — shown only on TRADE. No orange/primary button.
TRADE table columns in order (TableLayout.cs:139-143; visible by default unless noted): `TICKET` · `OPENED` · `SYMBOL` · `SIDE` · `LOTS` · `OPEN` · `CURRENT` · `DURATION` (hidden) · `S/L ✎` · `T/P ✎` · `SWAP` · `COMM` (hidden) · `PTS` · `P/L USD` · `COMMENT ✎` (hidden) · fixed `ACTIONS` (224 px).
Sortable: NO (no sort handler). Default order: server order. Selection: none, no checkbox column.
Row click: nothing. Double-click: Modify / Close window. Enter: only inside the S/L / T/P / COMMENT editors (commit); Esc in S/L / T/P reverts.
Per-row: action chips `BE` `PART` `MOD` `SHARE` `REV` `✕` (red); while a close awaits the dealer: amber status text + `CANCEL`; transient red row notice replaces chips for 2.5-4 s. Hover tooltip (2 s): origin (hotkey / 1-click / reverse / source) + note.
RIGHT-CLICK ON ROW: YES (PositionsPanel.axaml.cs:73-87). No header line. Items in order:
1. `Modify / close #TICKET SYMBOL…`
2. `Smart rules #TICKET SYMBOL…`
3. `Close SYMBOL LOTS`
4. `Close by` → submenu, one item per opposite same-symbol position `#TICKET SIDE LOTS @ OPEN` (enabled when ≥1 candidate and the row is not close-pending); when none: disabled `Close by… (no opposite SYMBOL position)`
5. separator
6. `Share #TICKET SYMBOL…`
No shortcuts shown. All items visible on every row.
PART chip menu: `Close 25% now` · `Close 50% now` · `Close 75% now`.
Right-click multi-selection: N/A (no selection). Right-click empty area of the table: NO. Right-click column header: YES → `COLUMNS` (disabled header) · separator · one checkbox item per column (TICKET … COMMENT, "✎" stripped) staying open on click · separator · `Fit columns to width` (checkbox, default on) · `Reset columns` (PositionsPanel.axaml.cs:221-241).
Footer: left "N POSITIONS · L LOTS · EXPOSURE X CUR"; right swap (muted) and total P/L (green/red bold).
Empty: "No open positions".
Modify / Close window: title `Modify / Close Position`; header line; OPEN | CURRENT | P/L; section `STOP LOSS / TAKE PROFIT` (SL + CLEAR, TP + CLEAR, hint, `MODIFY SL / TP` amber); section `CLOSE` (`LOTS TO CLOSE`, `25%` `50%` `100%`, hint, red `CLOSE POSITION` / `CLOSE x OF y (PARTIAL)`); bottom: confirm strip, error, result, `CLOSE WINDOW`. No right-click.
Share Trade window: caption `SHARE CARD · 1200×630 PNG`, preview, summary; buttons `COPY TEXT` · `SAVE PNG` (accent-filled) · `CLOSE`. No right-click.

## Issues
[ux] term-positions · Modify window's SL/TP (and header) are overwritten by every 4 s positions refresh while the trader is typing · ModifyPositionWindow.axaml.cs:31, 38-43; ModifyPositionViewModel.cs:63-71; MarketDataService.cs:1084, 1857
[money] term-positions · P/L on rows, footer, Modify window and share card has no FX conversion (quote currency shown as account currency / "USD") while the server margin path converts · AccountMath.cs:107-116; ModifyPositionViewModel.cs:79-80; ShareCard.cs:20-23; TableLayout.cs:143; margin.ts:271-279
[ux] term-positions · after switching tabs, returning to TRADE leaves no tab highlighted (IsOn compares Label "TRADE" with key "POS") · DockViewModels.cs:27-29, 90; PositionsPanel.axaml.cs:101
[functional] term-positions · inline S/L / T/P: re-submitting the same value after a cancelled confirm or failed PATCH does nothing (de-dupe tuple never cleared) · PositionsPanel.axaml.cs:298-321
[functional] term-positions · inline S/L / T/P stay editable on a close-pending row; the chips are locked but the PATCH path is not · PositionsPanel.axaml.cs:190, 231-232, 313-322
[functional] term-positions · the terminal never sends maxSlippagePips on closes, so the broker default slippage applies to every close regardless of the trader's SLIPPAGE MAX · ApiClient.cs:264-269; close/route.ts:218-229
[functional] term-positions · server SL/TP modify validates against the client-supplied currentPrice, not a server price · positions/[id]/route.ts:65-76
[functional] term-positions · STM / bulk closes send source "DESKTOP_NATIVE", so the server's STM_BULK_CLOSE audit is never written for the native terminal · ApiClient.cs:266; close/route.ts:63, 256-269
[text] term-positions · column "PTS" shows pips; P/L header fixed to "USD" · TableLayout.cs:143; PositionMath.cs:34-39
[text] term-positions · share PNG folder hard-coded "VyxTrader"; summary "->" vs card "→" · ShareCard.cs:32, 62, 79
[ux] term-positions · right-click "Close SYMBOL LOTS" and "Modify / close…" duplicate the ✕ / MOD chips and double-click · PositionsPanel.axaml.cs:76-77

## Status counts
STATUS-COUNTS app=terminal screen=term-positions WORKS=22 PARTIAL=3 UI-ONLY=1 PLACEHOLDER=0 DEAD=0 DUPLICATE=3


<!-- ===== term-tabs.md ===== -->

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


<!-- ===== term-stm.md ===== -->

# term-stm · Trader terminal · Smart Trade Manager (docked block, Smart rules window, SmartRulesEngine)

## A. Purpose + panels
Two surfaces:
1. Docked "SMART TRADE MANAGER" block under the order ticket: ENABLED/DISABLED switch (off at every launch), lot size / SL / TP (the ticket's own fields), BUY / SELL hotkeys, and bulk position actions (scope + direction, Break-even, Partial close %, Close profitable / losing / all).
2. "Smart Trade Manager" window per position (row right-click › Smart rules …): arm automated BREAK-EVEN / PARTIAL CLOSE AT TP1 / TRAILING STOP rules executed client-side by SmartRulesEngine on ticks, plus manual chips.
Evidence: E:\vyxtrader\src\Vyx.Trader.App\Views\OrderTicketPanel.axaml:364-449; OrderTicketPanel.axaml.cs:20-53; MainWindow.axaml.cs:89-127, 256-266, 326-337, 593-643; Views\SmartRulesWindow.axaml(.cs); Services\SmartRulesEngine.cs; Vyx.Shared\Trading\SmartRules.cs.

## B. Data
| Panel | Source | Refresh | Notes |
|---|---|---|---|
| Docked block fields | MainViewModel StmEnabled / BuyHotkey / SellHotkey / StmScopeIndex / StmDirectionIndex / StmPartialPct (MainViewModel.cs:64-76) + Ticket.Symbol/OrderType/Volume/Sl/Tp | live binding | StmEnabled forced false at launch (MainWindow.axaml.cs:90); hotkeys persisted in settings.json (MainWindow.axaml.cs:117-118) |
| Scoped positions | MarketDataService.Positions (GET /api/trade/positions, ApiClient.cs:237) | 4 s poll + events | scope filter MainWindow.axaml.cs:621 |
| Rules window | SmartRulesEngine entries (session-only config) + fired markers from %APPDATA%\VyxTrader\smart-rules-state.json (SmartRulesEngine.cs:45-48, 153-176) | Rules.Changed, PositionTick, PositionsChanged (SmartRulesWindow.axaml.cs:36-39) | markers keyed by position id, file not scoped per host/account |
| Engine | every tick of a symbol (MarketDataService.cs:2193 → SmartRulesEngine.OnTick :104-117) | per tick; only while the price stream delivers ticks | no server-side component (SmartRulesEngine.cs:21) |
Empty / status: docked results go to the chart action line (Vm.ActionResult); rules window StatusText "STATUS · OFF (nothing will fire on this position)" / "STATUS · ARMED (…) · terminal connected" / "TERMINAL OFFLINE — rules paused" / "POSITION CLOSED" (SmartRulesWindow.axaml.cs:73-86).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ENABLED / DISABLED pill | docked header, OrderTicketPanel.axaml:373-375 | live | always | StmToggleRequested → Vm.StmEnabled flip (MainWindow.axaml.cs:97) | none | – | no | no | trader session | action line "Smart Trade Manager ON · hotkeys live" / "OFF"; block below dimmed + not clickable when off (:378) | PARTIAL (does not stop rules armed in the Smart rules window: SmartRulesEngine.OnTick never reads StmEnabled, SmartRulesEngine.cs:104-117; MarketDataService.cs:2193) |
| SYMBOL · TYPE readout | :380-386 | live | – | – | – | – | – | – | – | – | PARTIAL (shows the ticket type, e.g. LIMIT, but hotkeys always send MARKET, MainWindow.axaml.cs:331) |
| LOT SIZE | :387-392 | live | STM on | bound to Ticket.Volume; blur → EnsureVolume (OrderTicketPanel.axaml.cs:53) | – | empty → symbol min lot (OrderTicketViewModel.cs:82) | – | – | – | – | DUPLICATE (ticket VOLUME LOTS, OrderTicketPanel.axaml:250-255) |
| SL / TP | :393-400 | live | STM on | bound to Ticket.Sl / Ticket.Tp | – | – | – | – | – | – | PARTIAL (duplicate of the ticket fields and NOT used by the hotkeys, OrderTicketViewModel.cs:194-205) |
| BUY HOTKEY / SELL HOTKEY capture | :402-413 | live | STM on | key capture (OrderTicketPanel.axaml.cs:37-52); blur / Enter → HotkeysChanged (MainWindow.axaml.cs:98-120) | none (settings.json BuyHotkey / SellHotkey) | refuses unparsable, bare F1-F12, Esc/Enter/Tab/Delete/Space/Back, same as the other hotkey (MainWindow.axaml.cs:102-111) | no | – | – | "hotkeys: buy X, sell Y" | WORKS |
| Hotkey press (BUY / SELL) | window KeyDown (MainWindow.axaml.cs:256-266) | – | live, STM enabled, focus not in a TextBox | SubmitHotkey → PrepareOneClickOrder → PlaceTicketOrderAsync → POST /api/trade/orders MARKET (MainWindow.axaml.cs:329-337; ApiClient.cs:296) | as a ticket MARKET order (route.ts:594-676; dealer queue 315-534) | lots / price / closed market / slippage (OrderTicketViewModel.cs:194-205); full server battery (see term-ticket.md) | NO confirm (by design) | no | – | origin "<gesture> hotkey" saved locally (MainWindow.axaml.cs:335) | PARTIAL (SL/TP shown in the block are not sent; no `source:"hotkey"` so no STM_HOTKEY_ORDER audit, route.ts:101, 653) |
| Scope combo `All symbols` / `This symbol` | :420-422 | live | STM on | StmScopeIndex (MainViewModel.cs:71, 75) | – | – | – | – | – | – | WORKS |
| Direction combo `All` / `Buy` / `Sell` | :423-425 | live | STM on | StmDirectionIndex → SmartScope (MainViewModel.cs:72, 76) | – | – | – | – | – | – | WORKS |
| Break-even `Apply` | :430-431 | live | STM on | SmartTradeAction "BE" → BreakEvenAsync(scoped) (MainWindow.axaml.cs:626-628; MarketDataService.cs:600-617) → PATCH /api/trade/positions/{id} per position in profit (ApiClient.cs:253) | Position.slPrice, NATS PositionModified, dealer activity (positions/[id]/route.ts:77-110) | skips positions not in profit; SlTpValidation (MarketDataService.cs:1547); server validateSlTp | ConfirmSlTpDrag, no key | no | – | "break-even on N position(s), M not in profit" | WORKS |
| Partial close `%` + `Close` | :432-438 | live | STM on | StmPartialTotal → PlanPartialClose (MarketDataService.cs:622-627) → ExecutePartialPlanAsync → CloseManyAsync (8 parallel) → POST /api/trade/positions/{id}/close (ApiClient.cs:264) | per leg closePositionInTx, mirror.onClose, coverage.onClose, PositionClosed, dealer activity (close/route.ts:232-302); dealer mode queued 202 | "enter 1–99 %" (MainWindow.axaml.cs:632); legs below min lot skipped per symbol, all below → "below min lot" and nothing sent (600-606) | ConfirmTicketOrders, key partial-close (611-613) | no | – | "P% of total: N closed" | WORKS |
| `Close profitable` | :443 | live | STM on | CloseFilteredAsync("profitable", scope, symbol?) (MainWindow.axaml.cs:639) → bulk route PROFIT when scope ALL + all symbols, else CloseManyAsync on row P/L (MarketDataService.cs:711-763) | as term-positions.md bulk / single close | row P/L classification client-side on the non-bulk path (758-759) | ConfirmTicketOrders | no | – | summary | WORKS |
| `Close losing` | :444 | live | STM on | same, "losing" | same | same | ConfirmTicketOrders | no | – | – | WORKS |
| `Close all` | :445 | live | STM on | same, "all" → bulk ALL / SYMBOL, or CloseManyAsync when a direction is set | same | – | ConfirmTicketOrders | no | – | – | WORKS |
| Rules window · BREAK-EVEN (checkbox, trigger pips, lock pips) | SmartRulesWindow.axaml:48-56 | – | – | armed via ARM; engine → ModifyPositionAsync → PATCH /api/trade/positions/{id} (SmartRulesEngine.cs:127-133) | as Break-even Apply | numbers ≥ 0 (SmartRulesWindow.axaml.cs:112-118); only tightens, valid side (SmartRules.cs:67-75) | at ARM | no | – | state "armed" / "DONE (SL at/beyond open)" | PARTIAL (a rejected PATCH is retried on every following tick: no repeat guard on the BE branch, SmartRules.cs:67-75, SmartRulesEngine.cs:109-115) |
| Rules window · PARTIAL CLOSE AT TP1 (checkbox, TP1 price, close %) | :57-65 | – | – | engine → ClosePositionByIdAsync(id, lots) → POST close (SmartRulesEngine.cs:134-142) | as partial close | TP1 required, not already reached, 0 < % ≤ 100 (SmartRulesWindow.axaml.cs:121-127) | at ARM | no | – | "DONE (fired once)" | PARTIAL (failure clears PartialDone so the next tick fires again, SmartRulesEngine.cs:139-141) |
| Rules window · TRAILING STOP (checkbox, distance, step) | :66-74 | – | – | engine → PATCH per step (SmartRules.cs:83-94) | as Break-even Apply | distance > 0; step min 0.1 pip; repeat guard LastRequestedSl (SmartRules.cs:90) | at ARM | no | – | "armed · last SL x" | WORKS |
| Rules window · ARM SELECTED RULES | :77 | – | always | BuildConfig → confirm → Rules.Arm (SmartRulesEngine.cs:58-70) | none at arming (client memory + markers file); fires PATCH / close later | see above | always "ARM SMART RULES" (SmartRulesWindow.axaml.cs:136-137) | no | – | journal "Smart rules armed on #T: …" | WORKS |
| Rules window · DISARM ALL | :76 | – | always | Rules.Disarm (SmartRulesEngine.cs:72-75) | none | – | no | – | – | "OK · rules disarmed" | WORKS |
| Rules window · BREAK-EVEN NOW | :82 | – | always | ModifyPositionAsync SL = open (SmartRulesWindow.axaml.cs:151-157) → PATCH | as Break-even Apply | "not in profit yet" | ConfirmSlTpDrag | no | – | – | DUPLICATE (row BE chip, term-positions.md; docked Break-even Apply) |
| Rules window · CLOSE 25% / 50% / 75% | :83-85 | – | always | ClosePositionByIdAsync(id, lots) (SmartRulesWindow.axaml.cs:161-169) → POST close | as partial close | PartialLots; min-lot position = full close | ConfirmTicketOrders | no | – | – | DUPLICATE (row PART chip menu) |
| Rules window · CLOSE | :86 | – | always | ClosePositionByIdAsync(id) → POST close | as full close | – | ConfirmTicketOrders | no | – | – | DUPLICATE (row ✕ chip) |
| Rules window · confirm CANCEL / ARM·MODIFY·CLOSE·CLOSE PART | :27-37 | ConfirmVisible | – | AcceptAsync (SmartRulesWindow.axaml.cs:178-186) | – | – | – | – | – | – | WORKS |
| Rules window · CLOSE WINDOW | :41 | – | – | Close() | – | – | – | – | – | – | WORKS |
| SMART EXECUTION rows (live data) | computed by RefreshSmartRows (MarketDataService.cs:1467-1481) | only rendered in the design fixture (OrderTicketPanel.axaml:157-174, IsVisible=!IsLive) | – | – | – | – | – | – | – | never visible live | DEAD |
| OrderTicketPanel.SmartRulesRequested event | OrderTicketPanel.axaml.cs:20-21 | – | – | handler MainWindow.axaml.cs:122-127, but nothing in the panel raises it | – | – | – | – | – | – | DEAD |

## D. Dialogs
Smart Trade Manager window (SmartRulesWindow.axaml:7, 560×740):
| Field | Type | Default | Stored in | Read by | Conditional |
|---|---|---|---|---|---|
| BREAK-EVEN on | checkbox | off (or armed config) | engine memory only; BreakEvenDone marker in smart-rules-state.json | SmartRules.Evaluate (SmartRules.cs:67-75) | – |
| trigger (pips in profit) | text | 10 | memory | same | – |
| lock (pips, 0 = open) | text | 0 | memory | same | – |
| PARTIAL CLOSE AT TP1 on | checkbox | off | memory; PartialDone marker | SmartRules.cs:77-81 | – |
| TP1 price | text | position TP if any (SmartRulesWindow.axaml.cs:35) | memory | same | – |
| close (%) | text | 50 | memory | PartialLots (SmartRules.cs:100-108) | – |
| TRAILING STOP on | checkbox | off | memory; LastRequestedSl marker | SmartRules.cs:83-94 | – |
| distance (pips) / step (pips) | text | 20 / 1 | memory | same | – |
Server storage: none; effects only through PATCH /api/trade/positions/{id} and POST …/close. Pip = 10 ticks (SmartRules.cs:46).
Docked-block confirms (ChartHost): `BREAK-EVEN` "SL → open on every open position in profit (N)?" [BREAK-EVEN]; `PARTIAL CLOSE 50%` "Close 50% of every open position?\nXAUUSD · 0.07 of 0.14 lots · 7 full" [CLOSE PART]; `CLOSE PROFITABLE` / `CLOSE LOSING` "Close every open position in profit?" [CLOSE]; `CLOSE ALL` "Close every open position (N)?" [CLOSE ALL] (MainWindow.axaml.cs:596-643).

## E. Text
- Hotkey hint suggests "F9" ("set hotkey: 1, b, F9, Ctrl+Shift+B…", MainViewModel.cs:67) but F1-F12 without modifier are refused "F9 already opens a panel" (MainWindow.axaml.cs:107).
- Hotkey hint "hotkeys: instant market orders" (MainViewModel.cs:67) sits under SL/TP fields that the hotkeys do not send (OrderTicketPanel.axaml:393-416).
- Partial % validation: docked "enter 1–99 %" (MainWindow.axaml.cs:632) vs window "partial % must be between 1 and 100" (SmartRulesWindow.axaml.cs:124), and the window check is `pct <= 0 || pct > 100` (accepts 0.5).
- Banner "Rules run while this terminal is connected · off at launch · armed per position" (SmartRulesWindow.axaml:47).
- Docked toggle labelled ENABLED / DISABLED while the action line says "Smart Trade Manager ON · hotkeys live" / "OFF" (MainWindow.axaml.cs:97).
- Doc comment on OnSmartChip lists actions "BE / 25 / 50 / 75 / PROFIT / LOSS / ALL" and scope "ALL / BUY / SELL" (OrderTicketPanel.axaml.cs:22); the panel sends BE / PARTIAL / PROFIT / LOSS / ALL.

## F. UI structure map
Docked block (right column, below the ticket splitter, OrderTicketPanel.axaml:369-449):
- Header `SMART TRADE MANAGER` + pill `ENABLED` (green) / `DISABLED` (grey), tooltip "Smart Trade Manager".
- Rows (dimmed + not clickable while disabled): `SYMBOL · TYPE` (symbol, type in amber) · `LOT SIZE` · `SL` [..] `TP` [..] · `BUY HOTKEY` (wm "set hotkey", tooltip "Press a key") · `SELL HOTKEY` · hint line.
- Section header `POSITION ACTIONS` with combos: scope (`All symbols` default, `This symbol`), direction (`All` default, `Buy`, `Sell`).
- `Break-even` … `Apply` (amber chip); `Partial close` [50] `%` (+ red error text) … `Close` (chip).
- Chip row: `Close profitable` (green) | `Close losing` (red) | `Close all` (red).
- No primary/orange button, no tables, no right-click anywhere in the block.
Smart Trade Manager window (per position):
- Header "SYMBOL  SIDE LOTS @ OPEN  ·  #TICKET", live line "bid x · +n pips · SL … · TP … · lots", amber banner, status line, fired count.
- `AUTOMATED RULES`: three boxes, each checkbox + state text + two numeric fields: `BREAK-EVEN` (trigger (pips in profit), lock (pips, 0 = open)); `PARTIAL CLOSE AT TP1` (TP1 price, close (%)); `TRAILING STOP` (distance (pips), step (pips)).
- Buttons: `DISARM ALL` · `ARM SELECTED RULES` (amber, primary).
- `MANUAL ACTIONS`: `BREAK-EVEN NOW` (amber) · `CLOSE 25%` · `CLOSE 50%` · `CLOSE 75%` · `CLOSE` (red); last action text.
- Bottom: confirm strip, result box, `CLOSE WINDOW`.
- No tables, no right-click, no keyboard shortcuts.
Entry point: only TRADE row right-click › `Smart rules #TICKET SYMBOL…` (PositionsPanel.axaml.cs:79).

## Issues
[functional] term-stm · STM hotkeys send MARKET orders without the SL/TP displayed in the STM block and regardless of the ticket's order type · MainWindow.axaml.cs:329-337; OrderTicketViewModel.cs:194-205; OrderTicketPanel.axaml:380-400
[functional] term-stm · the DISABLED switch does not stop armed automated rules; they keep firing PATCH / close requests · SmartRulesEngine.cs:104-117; MarketDataService.cs:2193; MainWindow.axaml.cs:620
[functional] term-stm · a failing break-even or TP1 partial rule is re-sent on every tick (no back-off / repeat guard) · SmartRules.cs:67-81; SmartRulesEngine.cs:109-115, 139-141
[functional] term-stm · hotkey orders carry no `source:"hotkey"`, so the server never writes STM_HOTKEY_ORDER; STM bulk closes send source DESKTOP_NATIVE, so STM_BULK_CLOSE is never written · ApiClient.cs:266, 296-303; route.ts:101, 653; close/route.ts:63, 256-269
[ux] term-stm · SMART EXECUTION rows are recomputed on every refresh but only rendered in the design fixture · MarketDataService.cs:1467-1481; OrderTicketPanel.axaml:157-174
[ux] term-stm · OrderTicketPanel.SmartRulesRequested is wired in MainWindow but never raised · OrderTicketPanel.axaml.cs:20-21; MainWindow.axaml.cs:122-127
[text] term-stm · hotkey hint suggests F9, which the validator refuses · MainViewModel.cs:67; MainWindow.axaml.cs:107
[text] term-stm · partial % rules differ: "1–99 %" docked vs "between 1 and 100" (accepts 0.5) in the window · MainWindow.axaml.cs:632; SmartRulesWindow.axaml.cs:124
[functional] term-stm · smart-rules marker file is global (%APPDATA%\VyxTrader\smart-rules-state.json), not scoped per broker host / account · SmartRulesEngine.cs:45-48

## Status counts
STATUS-COUNTS app=terminal screen=term-stm WORKS=13 PARTIAL=6 UI-ONLY=0 PLACEHOLDER=0 DEAD=2 DUPLICATE=4


<!-- ===== term-account.md ===== -->

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


<!-- ===== term-eco.md ===== -->

# term-eco — 5) ECO calendar / news panel

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Code-only audit.

## A. Purpose + panels
Bottom-left panel under Market Watch (MainWindow.axaml:36): the economic calendar — time, country · event with forecast / previous / actual, impact badge. Title `5) ECO CALENDAR · NEWS`, header-right summary (EcoPanel.axaml:11-15). There is no news-headline feed; only calendar events are shown.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Event rows | GET /api/trade/news | FetchCalendarAsync ApiClient.cs:167-174 | news/route.ts:47-62 → lib/economic-calendar-source.ts getEconomicCalendar (ForexFactory weekly feed, DB-cached 1 h, holidays dropped :44, sorted by time :61); Finnhub fallback only when a key exists and FF fails (news/route.ts:20-45); 503 `news feed unavailable` when both fail | on sign-in (MarketDataService.cs:1076), every 15 min (1079-1081), F6 (MainWindow.axaml.cs:309) |

Client shaping (MarketDataService.cs:1201-1233): events older than now − 2 h dropped (1219); impact `high` → HIGH, `medium`/`med` → MED, anything else → LOW (1220); title = `COUNTRY · event  F est · P prev · A act` (1222-1226); time `HH:mm` for today, `dd HH:mm` for other days, UTC (1227-1228); cap 40 rows (1229). Header-right `{n} EVENTS · {h} HIGH · UTC` (1231).
Filters / sort: none in the UI (no currency, impact or date filter); order = server time ascending. Pagination: none; vertical scroll (EcoPanel.axaml:20).
Empty/loading/error: before the first answer the live header shows the fixture literal `USD · XAU` (MainViewModel.cs:29) and no rows; zero rows → `no calendar events in the next days` (1232); failure → header `CALENDAR OFFLINE` + `calendar unavailable ({error})`, previous rows are kept (1206-1211).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F6 NEWS (refresh) — the panel's only control; same key/cell as in term-shell.md | status bar cell / F6 key (MainWindow.axaml.cs:309) | IsLive | always | RefreshCalendarAsync → GET /api/trade/news | read only | – | No | No | trader session | rows rebuilt; action line `F6 · calendar refreshed` | WORKS |

Rows have no click, double-click, hover or right-click handler (EcoPanel.axaml:25-32).

## D. Dialogs
None.

## E. Text
- Title `CALENDAR · NEWS` (EcoPanel.axaml:11) and F-key label `F6 NEWS` (MainViewModel.cs:48): no news feed exists; the XAML comment says the panel states this "in the last row instead of fixture headlines" (EcoPanel.axaml:17-18) but no such row or text is produced (MarketDataService.cs:1231-1232).
- Live header shows the fixture literal `USD · XAU` until the first response (MainViewModel.cs:29) although no currency filter exists.
- `no calendar events in the next days` (MarketDataService.cs:1232) while the source is a single weekly feed.
- F1 help calls F6 `log` (MainWindow.axaml.cs:304).

## F. UI structure map
Header: `5)` `ECO` `CALENDAR · NEWS`; header-right `{n} EVENTS · {h} HIGH · UTC` / `CALENDAR OFFLINE` / (before load) `USD · XAU`.
**Table (event list)**, no column header row: columns in order = time (44 px, muted) · event text (wrapping) · impact badge (40 px, right-aligned, `HIGH` / `MED` / `LOW`, coloured by ImpactToBrushConverter). Not sortable; order = time ascending. Selection: none; no checkbox column. Row click / double-click / Enter: none. Per-row buttons: none.
Right-click on row / empty area: NO.
Status text under the list (dim, wrapping) when empty or failed.
Time cell width: 44 px (EcoPanel.axaml:26) for values up to 8 characters (`dd HH:mm`, MarketDataService.cs:1227-1228); rendered overlap/clipping UNVERIFIED (app not launched).
Fixture (before sign-in): 8 static rows incl. 3 `NEWS` headlines (MainViewModel.cs:212-222).

## Issues
[text] eco · panel title `CALENDAR · NEWS` and F-key `F6 NEWS`, but no news feed exists and nothing in the panel says so (the XAML comment claims it does) · Views/EcoPanel.axaml:11,17-18; ViewModels/MainViewModel.cs:48; Services/MarketDataService.cs:1231-1232
[text] eco · live header shows the design literal `USD · XAU` until the first calendar response, implying a currency filter that does not exist · ViewModels/MainViewModel.cs:29
[functional] eco · no filter by currency / impact / symbol; all countries are listed, capped at 40, and events older than 2 h are dropped only at refresh time (15 min) · Services/MarketDataService.cs:1216-1230,1079
[ux] eco · time column is 44 px wide while non-today rows use `dd HH:mm` (8 chars); visual effect unverified · Views/EcoPanel.axaml:26; Services/MarketDataService.cs:1227-1228
[ux] eco · on a failed refresh the previous rows stay under `CALENDAR OFFLINE` with no age indication · Services/MarketDataService.cs:1206-1211
[ux] eco · rows are not interactive (no detail, no link to the affected symbols) · Views/EcoPanel.axaml:25-32
[text] eco · F1 help text names F6 `log` · MainWindow.axaml.cs:304

## Status counts
`STATUS-COUNTS app=terminal screen=eco WORKS=1 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`


<!-- ===== term-alerts.md ===== -->

# term-alerts — Price Alerts dialog (F8) + chart alert entry point

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Code-only audit.

## A. Purpose + panels
Modal dialog (560×520, not resizable; AlertsWindow.axaml:8) to create ABOVE/BELOW price alerts on any enabled symbol and cancel active ones. Opened by F8 / status-bar `F8 ALERTS` (MainWindow.axaml.cs:311, 436-441). Alerts are also created from the chart right-click (`Alert above/below {px}`, term-chart.md). Evaluation is server-side in the engine against the bid (engine/market-data/src/ingest.rs:126; alerts.rs:74-).
Panels: caption `PRICE ALERTS · F8`; add row (SYMBOL · condition · PRICE · ADD); hint line; list header + rows; bottom stack: inline confirm, result line, CLOSE.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Alert list | GET /api/trade/alerts (no `?status`) | FetchAlertsAsync ApiClient.cs:382-390 | alerts/route.ts:14-30 — default returns ACTIVE only, newest first | on open (AlertsWindow.axaml.cs:41), after each add/cancel (MarketDataService.cs:1501, 1508), on AlertTriggered event (MarketDataService.cs:278); list rebuilt through AlertsChanged (AlertsWindow.axaml.cs:38-39, 44-49) |
| Symbol list | cached GridCandidates (watchlist, then all /symbols) | – | – | at open (AlertsWindow.axaml.cs:31) |
| Hint (live bid) | last WS tick | – | – | at open only (AlertsWindow.axaml.cs:37) |

Row mapping (Models.cs:276-286): symbol comes back as a plain string (PriceAlert.symbol is `String`, schema.prisma:894), so `Digits` falls back to 5 for every alert (Models.cs:283) and PRICE is formatted with 5 decimals (AlertsWindow.axaml.cs:127). Status is always ACTIVE in practice because only ACTIVE rows are fetched; TRIGGERED / CANCELLED / EXPIRED rows never appear.
Trigger path: engine persists TRIGGERED (engine/server/src/main.rs:642) → NATS `alert.triggered` (main.rs:654-667) → gateway `alert.>` subscription (services/api-gateway/src/ws.ts:429) → terminal event `AlertTriggered` → LOG line `Alert triggered, {SYM} reached {price}` (MarketDataService.cs:303) + list refresh. No sound, no popup, no chart marker (no `Sound.*` call for alerts; SoundService has none wired for this event).
Sort: server `createdAt desc`. Pagination: none; list ScrollViewer max 230 px (AlertsWindow.axaml:70). Server cap: 50 ACTIVE alerts per account (lib/price-alerts.ts:11, 68-73).
Empty/loading/error: `no alerts on this account` (AlertsWindow.axaml.cs:48); `sending…`, `OK · alert {SYM} {COND} {px}` / `OK · alert cancelled`, `FAILED · {server error}` (95-102; MarketDataService.cs:1495-1510); `FAILED · enter a price` (74). A failed GET keeps the previous list silently (MarketDataService.cs:1491).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SYMBOL picker | add row (AlertsWindow.axaml:42-57) | always | always | flyout of GridCandidates (no ScrollViewer in the flyout, 46-54); pick → AlertsWindow.axaml.cs:52-59 sets symbol and prefills PRICE with the bid | none | – | No | No | trader session (F8 requires sign-in, MainWindow.axaml.cs:438) | symbol + price updated | PARTIAL (hint line keeps the previous symbol and bid, AlertsWindow.axaml.cs:37 vs 52-59) |
| Condition `ABOVE` / `BELOW` | add row (58) | always | always | toggle (AlertsWindow.axaml.cs:60) | none | – | No | No | – | condition flips | WORKS |
| PRICE box | add row (60) | always | always | none | none | client: number > 0, rounded to the symbol tick (AlertsWindow.axaml.cs:74-77) | No | No | – | – | WORKS |
| ADD | add row (61) | always | always | CreateAlertAsync → POST /api/trade/alerts {symbol, condition, price} (MarketDataService.cs:1495-1503; ApiClient.cs:397-398) | alerts/route.ts:32-89: PriceAlert row (status ACTIVE, expiresAt null) + NATS `cfg.alerts.{brokerId}` hot-reload (lib/nats.ts:139-184); no AuditLog, no notification | server: symbol/condition/price required, price > 0, condition ∈ ABOVE/BELOW/CROSSES (lib/price-alerts.ts:28-59); symbol enabled for the broker (route :48-53); ≤ 50 active (:55-59) | Yes per Settings.ConfirmAlerts (default ON, TerminalSettings.cs:16): `Alert when {SYM} {COND} {px}.` / `ADD ALERT` | No | – | LOG `Alert {SYM} {COND} {px} created`; list refreshed; result line | WORKS |
| ✕ CANCEL (per row) | list row (81) | IsActive | always | DeleteAlertAsync → DELETE /api/trade/alerts/{id} (MarketDataService.cs:1504-1510; ApiClient.cs:393-394) | alerts/[id]/route.ts:11-30: PriceAlert.status = CANCELLED (row kept) + NATS cancel; 404 not own, 409 not ACTIVE | server ownership + status | Yes per ConfirmAlerts: `Cancel the alert {SYM} {COND} {px}.` / `CANCEL ALERT` | No | – | LOG `Alert cancelled`; row disappears (list is ACTIVE-only) | WORKS |
| Confirm CANCEL | bottom confirm (27) | confirm pending | always | none | none | – | – | No | – | pending dropped | WORKS |
| Confirm action button (`ADD ALERT` / `CANCEL ALERT`) | bottom confirm (28) | confirm pending | always | runs the pending call (AlertsWindow.axaml.cs:95-102) | as above | – | – | No | – | result line | WORKS |
| CLOSE | bottom (35) | always | always | none | none | – | No | No | – | dialog closes | WORKS |

## D. Dialogs
Price Alerts (this window). Fields:
| Field | Type | Default | Stored in | Read by |
|---|---|---|---|---|
| SYMBOL | flyout pick | active chart symbol (AlertsWindow.axaml.cs:32) | PriceAlert.symbol | engine AlertCache.check_tick (engine/market-data/src/alerts.rs:161; ingest.rs:126) |
| Condition | toggle ABOVE/BELOW | ABOVE (AlertsWindow.axaml.cs:110) | PriceAlert.condition | engine evaluate_alert (alerts.rs:74) — CROSSES exists server-side but is not offered |
| PRICE | text | current bid of the symbol (AlertsWindow.axaml.cs:36) | PriceAlert.price (Decimal 18,5) | engine, compared with the bid |
| (expiry) | – not exposed | – | PriceAlert.expiresAt stays null | – |
Hint line: `{SYM} bid {px} · ABOVE: bid ≥ price · BELOW: bid ≤ price` (AlertsWindow.axaml.cs:37).

## E. Text
- Hint is computed once at open and not updated when another symbol is picked (AlertsWindow.axaml.cs:37).
- PRICE column shows 5 decimals for every symbol, e.g. gold `4456.35000` (Models.cs:283; AlertsWindow.axaml.cs:127).
- STATUS column exists (AlertsWindow.axaml:68, 79) but can only ever show ACTIVE (GET without `?status=all`).
- Class doc `PENDING` treated as active (Models.cs:285) — the server enum has no PENDING alert status (prisma/schema.prisma:869-874).
- Header caption `PRICE ALERTS · F8`.

## F. UI structure map
Window title `Price Alerts`, 560×520, centred on owner, fixed size.
Layout top → bottom: caption `PRICE ALERTS · F8` · add row [`SYMBOL` label, symbol button, condition button (amber), `PRICE` label, price box (right-aligned), `ADD` (primary, amber on accent border)] · hint line · 1 px rule · list header · list · empty text · (bottom-docked) confirm box, result line, `CLOSE`.
**Table (alert list)**: columns in order `SYMBOL` · `COND` · `PRICE` · `STATUS` · `CREATED` · (button column, no header). Not sortable; order = server createdAt desc. Selection: none; no checkbox column. Row click / double-click / Enter: nothing. Per-row button `✕ CANCEL` (red text) when active. Status text amber when active.
Right-click on row: NO. Right-click on empty area / header: NO.
Dropdown: SYMBOL flyout = plain list of symbol names (watchlist first, then every enabled symbol).
Toolbar: none. Filter chips / tabs: none.

## Issues
[ux] alerts · a triggered alert only produces a LOG line and disappears from the list; no sound, popup or chart marker · Services/MarketDataService.cs:278,303; Views/AlertsWindow.axaml.cs:44-49
[functional] alerts · the list fetches ACTIVE alerts only, so the STATUS column can never show TRIGGERED / CANCELLED and no alert history is visible · Vyx.Shared/Api/ApiClient.cs:384; app/api/trade/alerts/route.ts:20-25; Views/AlertsWindow.axaml:68
[text] alerts · PRICE column formats every alert with 5 decimals (digits default 5 because the server returns symbol as a string) · Vyx.Shared/Api/Models.cs:283; Views/AlertsWindow.axaml.cs:127; prisma/schema.prisma:894
[ux] alerts · hint line (symbol + bid) is not updated when a different symbol is picked · Views/AlertsWindow.axaml.cs:37,52-59
[ux] alerts · SYMBOL flyout lists every enabled symbol with no ScrollViewer · Views/AlertsWindow.axaml:46-54
[functional] alerts · CROSSES condition and expiry (expiresAt) are supported by the server but not offered · lib/price-alerts.ts:12,49-56; Views/AlertsWindow.axaml.cs:60
[functional] alerts · alerts created from the chart right-click do not refresh the cached alert list or write a LOG line · Services/MarketDataService.cs:1946-1952
[ux] alerts · a failed alert-list GET keeps the previous list with no error text · Services/MarketDataService.cs:1487-1494

## Status counts
`STATUS-COUNTS app=terminal screen=alerts WORKS=7 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
