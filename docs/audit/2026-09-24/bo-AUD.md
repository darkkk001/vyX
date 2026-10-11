# bo-AUD — Audit log (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\NotificationsAuditScreens.cs:168-271 (class AuditScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Read-only view of the broker's AuditLog: server search, before → after diff of the selected entry, deep link to the record, CSV export.
Panels: "1) AUD · AUDIT LOG" (left, *) and "2) DIFF · BEFORE → AFTER" (right, 380 px) (NotificationsAuditScreens.cs:190-192).

## B. Data
GET /api/manage/audit[?q=] — FetchAuditAsync ApiClient.ManageG4.cs:74 -> app/api/manage/audit/route.ts:19. Gate MANAGER, BROKER_ADMIN (route.ts:21). Where brokerId, excluding super-admin actors (route.ts:29-30, excludeSuperAdminActor); with q: entityId contains q (case-insensitive) OR oldValue/newValue JSON orderNumber / accountNumber string_contains q (route.ts:31-40). Order createdAt desc, take 200 (route.ts:43-44). Each row: actorEmail ("system" when no admin), humanized actionLabel, entityType/Id/Label, href, order identity (symbol side lots ticket accountNumber), diffLines ("key: before → after"), createdAtLabel (route.ts:49-61). No pagination.
Refresh: live topics order/position/dealing (:174); no poll; on nav (>10 s); search re-fetch 400 ms after typing stops or on Enter (:187-189,196).
Empty/error: "no audit entries yet" / "no audit entries match that search" (:211); detail "SELECT AN ENTRY", "NO FIELD CHANGES RECORDED" (:219,227); errors in header status.
Header stat "{n} ENTRIES" (+ ' · "q"') (:210).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search box "search" | filter bar (:176,187-189) | always | always | FetchAuditAsync(q) -> GET /api/manage/audit?q= | none (read) | - | no | no | MANAGER, BROKER_ADMIN | table replaced | PARTIAL (server matches only entityId, orderNumber, accountNumber — typing an actor e-mail or action word returns nothing, route.ts:31-40) |
| SAVE CSV | panel header right (:190,259-270) | always | always (toast "nothing to save" when empty) | none (local file) | none | - | no | no | none | toast "audit · {n} rows saved" | WORKS (exports only the ≤200 loaded rows) |
| Row click | list (:184) | row | always | none | none | - | no | no | none | diff pane shows the entry | WORKS |
| OPEN {CODE} (primary) | diff pane bottom (:229,258) | Target(entityType) exists (:251-257) | always | Shell.Open(code, entityId) or Shell.Navigate(code) | none | - | no | no | none | navigates | PARTIAL (Target keys are UPPER_SNAKE; server entityType values are PascalCase, so AdminUser, Transaction, KycRecord, ClientKycRecord, LiveAccountRequest, IbRelationship, BrokerSymbol, MirrorRule, AccountType, LiquidityProvider never match; "Broker" rows (halt / close-only / dealing-mode / risk limits) open CFG instead of RISK/EMG; "Order" opens EXP with an order id EXP cannot match) |
| Row double-click | list (:185) | row | target exists | same as OPEN | none | - | no | no | none | navigates | DUPLICATE (diff OPEN :229) |
| Ctx "Before → after (detail)" | row menu (:186) | row | always | none | none | - | no | no | none | diff pane | DUPLICATE (row click :184) |
| Ctx "Open the record" | row menu (:186) | row | target exists | same as OPEN | none | - | no | no | none | navigates | DUPLICATE (diff OPEN :229) |
| Ctx "Open client" | row menu (:186) | row | row has an order account number | Shell.Open("CLI", accountNumber) | none | - | no | no | none | CLI by number (ClientsScreen.cs:126) | WORKS |
| Column header click / right-click | list (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

## D. Dialogs
None (OS save picker only: suggested "audit-{yyyyMMdd-HHmm}.csv", filter *.csv; CSV header "when_utc,actor,action,entity_type,record,order,account,changes", diff lines joined with " | ", :263-266).

## E. Text
- Screen doc and ApiClient doc say the server searches "actor / action / entity" (NotificationsAuditScreens.cs:168-169; ApiClient.ManageG4.cs:73); the route searches entityId, orderNumber, accountNumber only (audit/route.ts:31-40). Placeholder is just "search".
- Detail "entity" row shows the raw PascalCase type (e.g. "AdminUser"), the table ENTITY column shows the label or the upper-cased type ("ADMINUSER") (:207,222).
- FIELDS CHANGED shows a count ("3"), header says FIELDS CHANGED (:183,208).
- Super-admin (VyXTechnologies) actions on the broker are excluded without any on-screen note (route.ts:30).

## F. UI structure map
Layout: PageGrid columns * / 380. Left "1) AUD  AUDIT LOG"; header right in order: stat "{n} ENTRIES[ · "q"]", status text, SAVE CSV (plain, not primary). Filter bar: no chips; search box ("search") right.
Table columns: WHEN | ACTOR | ACTION | ENTITY | ORDER | ACCOUNT | FIELDS CHANGED. Sortable all; default createdAt desc (server). Single selection (default newest); no checkbox. Click = diff; double-click = open record; Enter in table: nothing (Enter in the search box runs the search). Per-row: ACTION orange text; ORDER "—" when none; FIELDS CHANGED amber count.
Right-click on row: YES — header = action label (disabled), separator, "Before → after (detail)", "Open the record" (disabled when no target), "Open client" (disabled when no order account).
Right-click on multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Right "2) DIFF  BEFORE → AFTER": rows actor · action · entity · record · order (only for order rows) · when; section CHANGES: one block per diff line (key dim, before red, "→", after green; "(removed)" red); OPEN {CODE} button (primary/orange) when a target exists.
Empty: "no audit entries yet" / "no audit entries match that search" / "SELECT AN ENTRY" / "NO FIELD CHANGES RECORDED". Loading: page veil. Error: header status.

## Issues
[functional] AUD · search matches only entityId, orderNumber and accountNumber; searching an actor e-mail, action or entity type returns no rows although the screen's own doc promises it · app/api/manage/audit/route.ts:31-40; NotificationsAuditScreens.cs:168-169
[functional] AUD · OPEN / double-click deep links compare UPPER_SNAKE keys against PascalCase entityType values: AdminUser, Transaction, KycRecord, ClientKycRecord, LiveAccountRequest, IbRelationship, BrokerSymbol, MirrorRule, AccountType, LiquidityProvider rows get no link · NotificationsAuditScreens.cs:251-257; entityType writes e.g. app/api/manage/admins/route.ts:77, ib-relationships/route.ts:109
[functional] AUD · broker risk rows (RISK_HALT_TOGGLED, RISK_CLOSE_ONLY_TOGGLED, DEALING_MODE_TOGGLED, RISK_LIMITS_UPDATED; entityType "Broker") open CFG, which shows none of those settings · NotificationsAuditScreens.cs:255; app/api/manage/risk/route.ts:202-215
[functional] AUD · list is capped at the latest 200 rows (server) with no paging or date filter; SAVE CSV exports only those · app/api/manage/audit/route.ts:44; NotificationsAuditScreens.cs:264
[functional] AUD · broker-settings saves (default leverage / currency) write no audit row, so they never appear here · app/api/manage/settings/route.ts:75
[text] AUD · super-admin actions are silently excluded from the broker's audit view · app/api/manage/audit/route.ts:30

## Status counts
STATUS-COUNTS app=backoffice screen=AUD WORKS=5 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=3
