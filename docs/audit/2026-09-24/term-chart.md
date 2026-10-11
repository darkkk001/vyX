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
