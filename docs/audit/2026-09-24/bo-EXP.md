# bo-EXP — Live exposure (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiveExposureScreen.cs` (261 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); no default sort key; single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: broker-wide open book: exposure per symbol, broker risk-limit strip, every open position with dealer actions (modify SL/TP, close, partial close, close-by, reverse, close by symbol), and the broker-wide activity feed.
Panels (LiveExposureScreen.cs:56-63): top = `1) EXP EXPOSURE BY SYMBOL` (full width) over `2) LIM RISK LIMITS` (50 px strip); bottom = `3) POS OPEN POSITIONS · DEALER VIEW` (left, *) + `4) FEED LIVE ACTIVITY · BROKER-WIDE` (right, 360 px). Row heights 300 | *.

## B. Data
One refresh fetches five endpoints in parallel (LiveExposureScreen.cs:69-70). Refresh: live events "order","position","dealing" + poll every 30 s while active (:25-26); ticks reprice NOW/P/L client-side ≤1/s via LiveMath.Reprice (:80-86). If positions fail → header status "positions: <error>" and nothing re-renders (:72); failures of the other four are silently replaced by empty lists / null (:73).
| Panel | Endpoint | ApiClient | Route handler | Filters/sort | Limits | Empty/error |
|---|---|---|---|---|---|---|
| 1) EXP | GET /api/manage/positions (+ GET groups for chips, GET symbols for MAXIMUM EXPOSURE) | FetchManagePositionsAsync ApiClient.ManageG1.cs:224-232; FetchGroupsAsync ApiClient.ManageG2.cs:118; FetchBrokerSymbolsAsync ApiClient.ManageG2.cs:140 | positions/route.ts:47-164 (MANAGER/BROKER_ADMIN; every OPEN position of the broker, no group-category filter, :55-56); groups/route.ts:18-22; symbols/route.ts:40-45 | BOOK chips ALL/A-BOOK/B-BOOK, GROUP chips ALL + every group name (:116-122); grouped by symbol, ordered by |NET| desc (:147) | none | "no open positions" (:42) |
| 2) LIM | GET /api/manage/risk | FetchRiskSettingsAsync ApiClient.ManageG2.cs:162-165 | risk/route.ts GET (:15 requires RISK_SETTINGS or EMERGENCY_CONTROLS) | — | — | "RISK SETTINGS UNAVAILABLE" when the call fails (e.g. 403 for a MANAGER without those permissions) (:93) |
| 3) POS | same positions payload | as above | as above | BOOK + GROUP + SYMBOL chips + search "account · client" (:119, 123-130, 154-155) | none | "no open positions match" (:49) |
| 4) FEED | GET /api/manage/live-activity | FetchLiveActivityAsync ApiClient.ManageG2.cs:203-210 | live-activity/route.ts:12-19 → lib/dealer-activity.ts getDealerActivityFeedRows (default limit 50, :242) | newest first | client shows ≤60 (:105) | "NO ACTIVITY" (:104) |

Included rows: the positions payload contains the broker's own COVERAGE hedge legs (BOOK NOW creates a Position on the coverage account, positions/[id]/book/route.ts:93); nothing on this screen separates them from client positions, so they count in POSITIONS, LOTS, NET, NOTIONAL, CLIENT PROFIT / LOSS and TOTAL EXPOSURE.
Equity: this screen shows no equity figure. "—" appears in PRICE / PROFIT / LOSS when the server had no LivePrice tick in the last 15 s (currentPrice/floatingPnl null, positions/route.ts:101-110, 150-151; lib/live-price.ts:122-137) and no tick arrived since; in S/L, T/P when unset; MAXIMUM EXPOSURE "—" when the symbol has no maxExposure (:146).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BOOK chips ALL / A-BOOK / B-BOOK | EXP filter bar (:56, 121) | always | always | none | — | — | no | no | none | re-render EXP + POS | WORKS |
| GROUP chips ALL + group names | EXP filter bar (:120) | always | always | none | — | — | no | no | none | re-render EXP + POS | WORKS |
| SYMBOL chips ALL + symbols with positions | POS filter bar (:60, 119) | always | always | none | — | — | no | no | none | re-render POS | WORKS |
| Search "account · client" | POS filter bar (:33, 60) | always | always | none | — | — | no | no | none | re-render POS | WORKS |
| EXP row click | by-symbol table (:43) | row | always | none (toggles SYMBOL filter) | — | — | no | no | none | POS filtered | WORKS |
| EXP row menu "Filter positions to this symbol" | by-symbol row right-click (:44) | always | always | none | — | — | no | no | none | POS filtered | DUPLICATE (EXP row click :43) |
| EXP row menu "Close every position on this symbol…" | (:45) | always | always | = CLOSE BY SYMBOL | | | | | | | DUPLICATE (CLOSE BY SYMBOL :59) — and DEAD, see next row |
| CLOSE BY SYMBOL (red/danger) | POS header right (:59) | always | always | CloseBulkAsync POST /api/manage/positions/close-bulk {scope ALL\|SYMBOL, symbol, accountId:null} (ApiClient.ManageG6.cs:138-139; call :254) | none: handler requires accountId and returns 400 "accountId is required" (close-bulk/route.ts:28-31) | client: ≥1 row in filter (:250) | yes "CLOSE ALL POSITIONS"/"CLOSE BY SYMBOL" (danger) (:252) | no | MANAGER/BROKER_ADMIN | error toast | DEAD (route exists but can never succeed for this body; also ignores the GROUP/BOOK/search filters the confirm text counts, :249-254) |
| EXP row menu "Symbol settings" | (:45) | always | always | Shell.Open("SYM", symbolName) | — | — | no | no | none | SYM screen | WORKS |
| EDIT ON RISK | LIM header right (:57) | always | always | Shell.Navigate("RISK") | — | — | no | no | none | RISK screen | WORKS |
| POS row double-click → Modify | positions table (:51) | row | always | = Modify SL / TP… | | | | | | | DUPLICATE (menu "Modify SL / TP…" :174) |
| Menu "Modify SL / TP…" | POS row right-click (:174) | always | always | AdminModifyPositionAsync PATCH /api/manage/positions/{id} {slPrice?, tpPrice?, reason} (ApiClient.ManageG2.cs:189-195) | Position.slPrice/tpPrice; AuditLog POSITION_SLTP_MODIFIED with reason (positions/[id]/route.ts:88-113). No NATS event, no dealer-activity row, no notification (imports :1-6) | client ParseModify: ≥1 level, numeric, "reason:" required (:200-216); server: reason required, numeric, live price present, validateSlTp vs live price (route.ts:42-85) | input dialog "MODIFY POSITION" (APPLY) | no | MANAGER/BROKER_ADMIN | toast + refetch | PARTIAL (no PositionModified publish → open terminals not told; engine pick-up of the new SL/TP without an event UNVERIFIED) |
| Menu "Close at market…" | (:175) | always | always | AdminClosePositionAsync POST positions/{id}/close {} (ApiClient.ManageG2.cs:197-198) | executeAdminCloseInTx → closePositionInTx: Position closed (guarded updateMany), TRADE_PNL Transaction, Account.balance, NBP write-off if broker.negativeBalanceProtection, Position.closedByAdminId, AuditLog MANUAL_POSITION_CLOSE (close/route.ts:105-110; lib/position-actions.ts:91-106; lib/position-close.ts:38-105); mirror.onClose; coverage.onClose; cancelPendingClose; NATS PositionClosed; recordDealerActivity (NATS DealerActivity + notification for dealing-group accounts) (close/route.ts:120-155; lib/dealer-activity.ts:96-113). No BalanceChanged publish | server: OPEN, trading session open, live price (close/route.ts:52-99) | yes "CLOSE POSITION" (danger) (:218) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Close part…" | (:176) | always | always | AdminClosePositionAsync {volume "0.00"} | same, partial (close/route.ts:79-94) | client 0 < lots ≤ volume (:231); server same range only — no lot-step/min-lot check (close/route.ts:86) | input dialog "CLOSE PART" (danger) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Close by" (submenu of opposite positions) | (:177-181) | always; header "Close by… (no opposite <SYM> position)" when none | enabled when same-account opposite-side same-symbol positions exist (CloseBy.cs:22-24) | AdminCloseByAsync POST /api/manage/positions/close-by {positionId, againstPositionId} (ApiClient.ManageG2.cs:201-202) | both legs closed at one mid price in one transaction via executeAdminCloseInTx (TRADE_PNL, audit ×2); mirror.onClose + coverage.onClose per leg; recordDealerActivity ×2; NATS PositionsClosed (close-by/route.ts:36-108) | server: same account, resolveCloseByPair (:44-50) | yes "CLOSE BY" (danger) (:225) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Reverse…" | (:182) | always | always | ReversePositionAsync POST positions/{id}/reverse {mode IN_PLACE\|CLOSE_REOPEN} (ApiClient.ManageG6.cs:152-156) | MANAGER: PositionActionRequest PENDING (202) (reverse/route.ts:44-50). BROKER_ADMIN: IN_PLACE → executeReverseInPlace, AuditLog POSITION_REVERSED_IN_PLACE, NATS PositionModified, no mirror/coverage hook (reverse/route.ts:68-77; lib/position-actions.ts:171-177); CLOSE_REOPEN → close + new position, mirror.onClose, coverage.onClose, mirror.onFillPosition, NATS PositionClosed + OrderFilled (reverse/route.ts:83-93) | none | form "REVERSE POSITION" (danger) | YES for MANAGER (lib/position-actions.ts:22-24) | MANAGER/BROKER_ADMIN | toast "…filed for a second admin's approval" or "reversed"; badges refresh (:241) | PARTIAL (IN_PLACE on a covered position calls no coverage hook: the hedge leg stays on the old side — reverse/route.ts:68-77; no reason field, request stored with reason null :47) |
| Menu "Open client <acc>" | (:184) | always | always | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS |
| Column picker (positions) | POS header right-click | always | always | none; persisted "exp-positions" (:52-53) | — | — | no | no | none | — | WORKS |

## D. Dialogs
- MODIFY POSITION (ConfirmWithInput, :191-198): detail "<SYM> <SIDE> <lots> of <acc> · now SL <x> TP <y>. Type the new levels, e.g. "sl 4490 tp 4430" ("sl -" clears), then the reason after "reason:"."; single free-text input "LEVELS · REASON" (required). Parsed to slPrice/tpPrice ("" → null = clear) → Position.slPrice / Position.tpPrice; reason → AuditLog.newValue.reason. READ BY: SL/TP trigger check (engine trigger path — exact reader UNVERIFIED), trader terminal on next fetch.
- CLOSE POSITION confirm: "Close <vol> of <SYM> <SIDE> <lots> for <acc> at market?" CLOSE.
- CLOSE PART (ConfirmWithInput): "<SYM> <SIDE> <lots> of <acc>: lots to close (0 < lots ≤ <lots>)", input "LOTS" required → request volume.
- CLOSE BY confirm: "Close <SYM> <SIDE> <lots> by <SIDE> <lots> for <acc>? <n> lots close on both at one price (mid). <rest text>" CLOSE BY.
- REVERSE POSITION form: "How" choice FLIP IN PLACE (IN_PLACE, default) / CLOSE + REOPEN OPPOSITE (CLOSE_REOPEN); detail "<SYM> <SIDE> <lots> of <acc> at <price|market>" → request mode; stored in PositionActionRequest.actionType (MANAGER) or applied.
- CLOSE ALL POSITIONS / CLOSE BY SYMBOL confirm: "Close all <n> shown positions (<every symbol|SYM>) at market?" CLOSE ALL.

## E. Text
- Column "CLIENT PROFIT / LOSS" and header stat "CLIENT P/L" (:41, 150) include the broker's coverage hedge legs (see B).
- "MAXIMUM EXPOSURE" column shows "|net lots| / maxExposure" per symbol broker-wide (:138, 146); BrokerSymbol.maxExposure is "Max total open volume (lots) an ACCOUNT may hold in this symbol", gross, per account (lib/risk.ts:307-326).
- LIM "TOTAL EXPOSURE" shows notional money "$x / $limit (y%)" (:96-98); Broker.totalExposureLimit is a lot count ("sum of open volume", "limit of N lots", lib/risk.ts:330-345).
- "DEALING MODE … ON · manual review / OFF · auto-fill" (:100) — broker-level flag only; per-group dealing modes are not reflected.
- Class comment says "Hedged / LP columns have no endpoint and are not drawn" (:20-21) — positions payload does carry `covered` / coveragePositionId (positions/route.ts:131-137) but the screen does not show them.
- Confirm "Close all N shown positions" (:252) — the request does not carry the shown filters.
- ACTIONS column text "MODIFY · CLOSE" (:163) is a label, not clickable.

## F. UI structure map
- Layout: top block 300 px = EXP panel (fills) above LIM strip (50 px); bottom block = POS (left, *) + FEED (right, 360 px) (:58-63). No KPI strip.
- **1) EXP "EXPOSURE BY SYMBOL"**; header right: stat "<n> POSITIONS · <lots> LOTS · CLIENT P/L ±x" (green/red), status text. Filter bar: label "BOOK", chips ALL · A-BOOK · B-BOOK (default ALL); "·"; label "GROUP", chips ALL + group names alphabetical (default ALL).
  - Table "exp-symbols": SYMBOL · POSITIONS · BUY VOLUME · SELL VOLUME · NET · NOTIONAL · A / B POS · AVERAGE OPEN · CLIENT PROFIT / LOSS · PRICE · MAXIMUM EXPOSURE (:40-42). Sortable all; default order |NET| desc (:147). Selection single.
  - Row click → toggles SYMBOL filter on POS; double-click nothing; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<SYMBOL>" (disabled) / separator / Filter positions to this symbol / Close every position on this symbol… / separator / Symbol settings (all enabled) (:44-45).
  - Right-click empty area: NO. Header: YES (COLUMNS picker; not persisted for this table). Empty "no open positions".
- **2) LIM "RISK LIMITS"**; header right button "EDIT ON RISK" (plain). Body: stats TOTAL EXPOSURE · MAX POSITIONS / ACCOUNT · DEALING MODE · TRADING (OPEN / CLOSE-ONLY / HALTED), or "RISK SETTINGS UNAVAILABLE".
- **3) POS "OPEN POSITIONS · DEALER VIEW"**; header right: stat "<shown> SHOWN OF <total>", button "CLOSE BY SYMBOL" (danger/red). No primary/orange button. Filter bar: label "SYMBOL", chips ALL + symbols (default ALL); search "account · client".
  - Table "exp-positions": TICKET · ACCOUNT · CLIENT · GROUP · SYMBOL · SIDE · LOTS · OPEN · PRICE · S/L · T/P · PROFIT / LOSS · BOOK · OPENED · ACTIONS (:47-49). Sortable all; default server order openedAt desc (positions/route.ts:71). Single select. BOOK = "A"/"B" chip.
  - Row click: select; double-click → MODIFY POSITION dialog; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<SYM> <SIDE> <lots> · <acc>" (disabled) / separator / Modify SL / TP… / Close at market… / Close part… / Close by (submenu: "<#ticket> <SIDE> <lots> @ <price>" per candidate; when none the item reads "Close by… (no opposite <SYM> position)" and is disabled) / Reverse… / separator / Open client <acc> (:168-186).
  - Right-click empty area: NO. Header: YES (COLUMNS picker, persisted). Empty "no open positions match".
- **4) FEED "LIVE ACTIVITY · BROKER-WIDE"**: log rows "HH:mm  <ACTION (≤8 chars)>  <acc> <side> <vol> <sym> <values>"; tone red for REJECT/STOP, green FILL/ACCEPT, amber REQUOTE/MODIF (:105-108). Not clickable, no right-click. Empty "NO ACTIVITY".
- Loading: "loading…" status + LOADING… veil on nav; error: header status.

## Issues
[money] EXP · CLOSE BY SYMBOL / "Close every position on this symbol…" always fail: close-bulk requires accountId and the screen sends null · LiveExposureScreen.cs:254, ApiClient.ManageG6.cs:138-139, close-bulk/route.ts:28-31
[money] EXP · Close-by-symbol request ignores the GROUP/BOOK/search filters that the confirm's "N shown positions" counts (scope ALL/SYMBOL only) · LiveExposureScreen.cs:249-254
[money] EXP · TOTAL EXPOSURE compares a notional USD sum to Broker.totalExposureLimit, which is a lot count · LiveExposureScreen.cs:96-98, lib/risk.ts:330-345
[money] EXP · MAXIMUM EXPOSURE compares broker-wide net lots to BrokerSymbol.maxExposure, a per-account gross lot limit · LiveExposureScreen.cs:138,146, lib/risk.ts:307-326
[money] EXP · Broker COVERAGE hedge legs are counted as client positions in every total (positions, lots, net, notional, CLIENT P/L, total exposure) · positions/route.ts:55-56, positions/[id]/book/route.ts:93
[money] EXP · Reverse IN_PLACE (BROKER_ADMIN) calls no coverage/mirror hook; a covered position's hedge leg is left on the old side · positions/[id]/reverse/route.ts:68-77
[functional] EXP · Modify SL/TP publishes no NATS event (terminals not notified) and records no dealer activity · positions/[id]/route.ts:1-6,88-122
[functional] EXP · Partial close validates only 0<v≤volume; no lot-step / min-lot check on the remainder · close/route.ts:86, LiveExposureScreen.cs:231
[functional] EXP · LIM strip needs RISK_SETTINGS or EMERGENCY_CONTROLS; a MANAGER without them sees "RISK SETTINGS UNAVAILABLE" · risk/route.ts:15, LiveExposureScreen.cs:93
[functional] EXP · Failures of groups/symbols/risk/feed fetches are swallowed (empty lists) with no status text · LiveExposureScreen.cs:73
[ux] EXP · Admin close publishes PositionClosed but no BalanceChanged · close/route.ts:137
[ux] EXP · Reverse dialog has no reason field; MANAGER requests are filed with reason null · LiveExposureScreen.cs:237, reverse/route.ts:47
[ux] EXP · Covered/coverage flags are in the payload but not shown · positions/route.ts:131-137, LiveExposureScreen.cs:47-49
[text] EXP · "CLIENT PROFIT / LOSS" / "CLIENT P/L" include broker hedge legs · LiveExposureScreen.cs:41,150
[text] EXP · "MAXIMUM EXPOSURE" and "TOTAL EXPOSURE" labels do not match the unit/scope of the limits they display · LiveExposureScreen.cs:42,98

## Status counts
STATUS-COUNTS app=backoffice screen=EXP WORKS=12 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=1 DUPLICATE=3
