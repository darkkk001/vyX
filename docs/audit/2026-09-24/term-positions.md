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
