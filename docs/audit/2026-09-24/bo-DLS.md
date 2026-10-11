# bo-DLS — Trade history (Deals)

Code: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealsScreen.cs (DLS), Controls\DataTable.cs. API: Vyx.Shared\Api\ApiClient.ManageG1.cs, ApiClient.ManageG6.cs. Routes under D:\VyXTrader-Tauri\vyX\app\api\manage.

## A. Purpose + panels
Closed-trade history for the broker (latest 500 CLOSED/VOIDED positions) with search, filter chips, replay, void and delete (maker-checker for MANAGER). One panel: header "1) DLS TRADE HISTORY" + filter bar + table (DLS:43).

## B. Data
- Table: GET /api/manage/deals — ApiClient.ManageG1.cs:203 → app/api/manage/deals/route.ts:15. Server: status CLOSED or VOIDED, deletedAt null, orderBy closedAt desc, take 500 (deals/route.ts:53-74). No query params sent (no date range, no paging).
- Refresh: on open + live topic "position" (DLS:21); no poll (Screen.cs:45 default 0). After a write: AfterWriteAsync refetch (Screen.cs:144-148).
- Filters (client-side, DLS:74-81): chips ALL / PROFIT (realizedPnl > 0) / LOSS (< 0) / VOIDED (status VOIDED) / TODAY (closedAt starts with today's UTC date); search box matches account number, client name, symbol (contains, case-insensitive).
- Sort: none applied by the screen (server order closedAt desc); header click sorts (DataTable.cs:160-182,299).
- Pagination/limits: server hard cap 500; header stat "N SHOWN OF M · NET ±x" (DLS:88-89) where M ≤ 500.
- Empty: "no closed trades" (DLS:36). Error: header Status text (DLS:51). Loading: header Status "loading…" (Screen.cs:98).
- Replay: GET /api/manage/positions/{id}/replay — ApiClient.ManageG6.cs:146 → positions/[id]/replay/route.ts:16 (MANAGER/BROKER_ADMIN; candles around the fill + audit lines).
- Pending delete tracking: local set; a row stays "DELETE PENDING" until the list no longer returns it (DLS:26,59).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search "account · client · symbol" | filter bar | always | always | none | none | – | no | no | – | rows filtered, stat updates (DLS:42) | WORKS |
| Chips ALL / PROFIT / LOSS / VOIDED / TODAY | filter bar | always | always | none | none | – | no | no | – | rows filtered (DLS:69-80) | WORKS |
| Column header click | table header | always | always | none | none | – | no | no | – | sort toggle ▲/▼ | WORKS |
| Column header right-click → COLUMNS / Reset columns | table header | always | always | none | local Settings.TableColumns["deals"] (DLS:40-41) | – | no | no | – | columns shown/hidden, persisted | WORKS |
| Open client | row right-click | any row | always | none | none | – | no | no | – | opens CLI for the account (DLS:97) | WORKS |
| Replay fill… | row right-click | any row | always | FetchPositionReplayAsync GET /api/manage/positions/{id}/replay | none (read) | – | – | no | MANAGER/BROKER_ADMIN (replay/route.ts:18) | dialog "REPLAY · #T" with order type, requested/filled/requoted, open/close + times, candle count, up to 8 audit lines; button "CLOSE" (DLS:111-121) | WORKS |
| Void deal… | row right-click | any row | status ≠ VOIDED and not delete-pending (DLS:99) | VoidPositionAsync POST /api/manage/positions/{id}/void (ManageG6.cs:141-144) | none for a closed deal: MANAGER path requestPositionAction → loadOpenPosition throws "position is not open" → 409 (lib/position-actions.ts:502-503, 47-57; void/route.ts:31-39); BROKER_ADMIN path executeVoid → same 409 (position-actions.ts:346-347; void/route.ts:42-48). Every row on this screen is CLOSED or VOIDED | server: position must be OPEN | yes "Void … ? Reverses the result on the account." (danger) | would be (MANAGER) | MANAGER/BROKER_ADMIN | error toast | DEAD |
| Delete deal… | row right-click | any row | status ≠ VOIDED and not delete-pending (DLS:100) | DeleteDealAsync POST /api/manage/positions/{id}/delete {reason} (ManageG1.cs:216-222) | MANAGER: PositionActionRequest (DELETE, reason) + audit POSITION_ACTION_REQUESTED, HTTP 202 (delete/route.ts:30-39; position-actions.ts:506-525). BROKER_ADMIN: Position.deletedAt / deletedByAdminId / deleteReason + audit POSITION_DELETED (position-actions.ts:445-466); no balance change, no NATS publish (delete/route.ts:51-54) | client: reason required (DLS:126) / server: reason required, not OPEN, not already deleted (delete/route.ts:26-29; position-actions.ts:442-443) | yes + REASON input (danger) | yes for MANAGER (position-actions.ts:22-23) | MANAGER/BROKER_ADMIN | 202: row → "DELETE PENDING", toast "…filed for another admin's approval"; 200: refetch, toast "…deleted" | WORKS |
| Row double-click | table row | any row | not VOIDED / not pending (DLS:125) | same as Delete deal… (DLS:39) | same | same | yes | same | same | same | DUPLICATE (Delete deal… right-click item) |
| "DELETE" text in ACTIONS column | table cell | status ≠ VOIDED and not pending (DLS:87) | – | none: RowActivated handler is an empty block (DLS:38) | none | – | – | – | – | nothing happens on click | UI-ONLY |

## D. Dialogs
| Dialog | Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|---|
| DELETE DEAL | REASON | text, required | "" | BROKER_ADMIN: Position.deleteReason + AuditLog newValue.reason; MANAGER: PositionActionRequest.reason + AuditLog | approvals flow approvePositionActionRequest → executeDelete (lib/position-actions.ts:531-537, 480-486); audit views | – |
| VOID DEAL | (none) | – | – | – | – | confirm only |
| REPLAY · #T | (read-only text) | – | – | – | – | uses the confirm dialog with button "CLOSE"; after close an empty success toast is raised (DLS:120, MainWindow.axaml.cs:331) |

## E. Text
- Void confirm "Reverses the result on the account." (DLS:104): void is refused for every closed deal; the server void reverses only commission/swap of an OPEN position (lib/position-actions.ts:330-347).
- Class docstring "(the server's most recent 500)" matches server; header stat "N SHOWN OF M" does not say M is capped at 500 (DLS:89).
- Panel title "TRADE HISTORY" vs nav code DLS / docstring "Deals"; menu "Open client" vs DEAL screen "Open client 360" (DLS:97, DealingScreen.cs:119).
- Empty text "no closed trades" lowercase vs sibling tables "No open trades" (DLS:36, DealingScreen.cs:118).
- "DELETE" rendered as a red chip-styled cell that looks clickable (DLS:87).
- Replay audit lines: time parsed by splitting on " · " (DLS:119); lines without that separator print whole.

## F. UI structure map
Layout: single full-content panel (DLS:43).
- Header: code "1) DLS", title "TRADE HISTORY"; header-right: stat "N SHOWN OF M · NET ±x" (green ≥ 0 / red < 0), then refresh Status text. No KPI strip.
- Filter bar: chips ALL | PROFIT | LOSS | VOIDED | TODAY (default ALL; single-select); search box (220 px, placeholder "account · client · symbol").
- No toolbar buttons (no primary/orange button).

Table "deals" (DataTable, DLS:33-36): columns in order TICKET · ACCOUNT · CLIENT · SYMBOL · SIDE · VOLUME · OPEN · CLOSE · COMMISSION · SWAP · PROFIT / LOSS · CLOSED · STATUS · ACTIONS.
- Sortable: every header (click toggles ▲/▼). Default sort: none (server closedAt desc).
- Selection: single; no checkbox column.
- Row click: selects (handler no-op, DLS:38). Double-click: opens DELETE DEAL dialog (DLS:39). Enter: none.
- Per-row badges: STATUS chip "CLOSED" (b) / "VOIDED" (bad) / "DELETE PENDING" (wait); ACTIONS cell "DELETE" (bad tone, not a button). TICKET "—" when no ticket; PROFIT / LOSS "—" when null.
- Right-click on row: YES — header "SYM SIDE VOL · ACC" (disabled), separator, "Open client", "Replay fill…", "Void deal…" (enabled when not VOIDED and not delete-pending), "Delete deal…" (same enable rule). No submenus, no shortcuts (DLS:91-101).
- Right-click on multi-selection: n/a (single select). Right-click on empty area: NO (no TableContextRequested handler). Right-click on column header: YES — "COLUMNS" (disabled), separator, one checkbox per column, separator, "Reset columns" (DataTable.cs:303-318).
- Empty: "no closed trades". Loading: header Status "loading…". Error: header Status text.
- FocusRecord from other screens (e.g. CLI "Open in Deals") sets the search box to the deal's account number, not the single deal (DLS:62-67).

## Issues
[functional] DLS · "Void deal…" can never succeed: every row is CLOSED/VOIDED and both void paths require status OPEN (409 "position is not open") · DealsScreen.cs:99,103-110, app/api/manage/positions/[id]/void/route.ts:31-48, lib/position-actions.ts:47-57,502-503
[text] DLS · Void confirm claims "Reverses the result on the account." · DealsScreen.cs:104
[ux] DLS · double-clicking any row opens the DELETE DEAL dialog · DealsScreen.cs:39
[ux] DLS · "DELETE" in the ACTIONS column looks like a button but has no click handler · DealsScreen.cs:38,87
[functional] DLS · list is capped at the latest 500 closed trades with no date range or paging; older trades are unreachable here · app/api/manage/deals/route.ts:73, ApiClient.ManageG1.cs:203
[ux] DLS · header "N SHOWN OF M" does not state that M is a 500-row cap · DealsScreen.cs:89
[ux] DLS · CLI "Open in Deals" focuses by account (search box) rather than the chosen deal · DealsScreen.cs:62-67, ClientsScreen.cs:79
[ux] DLS · Replay viewer reuses the confirm dialog and raises an empty toast on CLOSE · DealsScreen.cs:120, Views/MainWindow.axaml.cs:331
[text] DLS · "Open client" vs "Open client 360" elsewhere; "no closed trades" casing differs from sibling tables · DealsScreen.cs:36,97

## Status counts
STATUS-COUNTS app=backoffice screen=DLS WORKS=7 PARTIAL=0 UI-ONLY=1 PLACEHOLDER=0 DEAD=1 DUPLICATE=1
