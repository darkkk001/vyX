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
