# bo-NTF — Notifications (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\NotificationsAuditScreens.cs:18-166 (class NotificationsScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Broker-wide notification inbox (shared read state across all staff): list, detail, mark read / mark all read, deep link to the owning record, trader password reset for PASSWORD_RESET_REQUESTED.
Panels: "1) NTF · NOTIFICATIONS" (left, *) and "2) DETAIL · NOTIFICATION" (right, 380 px) (NotificationsAuditScreens.cs:42-44).

## B. Data
GET /api/manage/notifications — FetchNotificationsAsync ApiClient.ManageG4.cs:65 -> app/api/manage/notifications/route.ts:14. Gate MANAGER, BROKER_ADMIN (route.ts:6-12). Filter: brokerId only (route.ts:21) — no accountId filter, so trader-scoped rows (engine PRICE_ALERT_TRIGGERED with accountId, engine/market-data/src/db.rs:450-451; trader copy of MARGIN_CALL, lib/post-close.ts:159, lib/risk-monitor.ts:317) are listed and counted. Order createdAt desc, take 100 (route.ts:22-23). No pagination.
Refresh: live topic "dealing" (:26) -> refetch; poll every 20 s while active (:27; MainWindow.axaml.cs:182-187); on nav (>10 s). Nav badge NTF and bell count = shell-info unreadNotifications (count readAt null for the broker, shell-info/route.ts:24; MainWindow.axaml.cs:206-211), refreshed every 60 s and ≤1/5 s on events.
Filters: chips ALL / UNREAD; search over title/body/type (client-side, :66). Default selection = newest row (:55).
Empty/error: "no notifications yet" / "nothing matches the current filters" (:72); detail "SELECT A NOTIFICATION"; "NO LINKED SCREEN" + "entity type {X} has no screen yet" or "this notification carries no record" (:93); errors in header status.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MARK ALL READ | panel 1 header (:42,132-141) | always | always (toast "nothing unread" when 0) | MarkAllNotificationsReadAsync ManageG4.cs:70 -> PATCH /api/manage/notifications {markAllRead:true} | Notification.readAt = now for every unread row of the broker, for all staff (route.ts:52-55). No audit | server 400 unless markAllRead true | yes ("MARK ALL") | no | MANAGER, BROKER_ADMIN | toast "{n} marked read", refetch, badges | WORKS |
| Chips ALL · UNREAD | filter bar (:57-61) | always | always | none | none | - | no | no | none | list filtered | WORKS |
| Search "title · body · type" | filter bar right (:30,40,66) | always | always | none | none | - | no | no | none | list filtered | WORKS |
| Row click | list (:37) | row | always | none | none | - | no | no | none | detail shows row | WORKS |
| OPEN {CODE} / REVIEW KYC (primary) | detail buttons (:89,117-122) | a target screen exists for the type/entity (:96-116) | always | MarkNotificationReadAsync (quiet) if unread, then Shell.Open(code, entityId) | readAt set (see MARK READ) | - | no | no | MANAGER, BROKER_ADMIN | navigates to the owning screen | PARTIAL (see gaps below) |
| Row double-click | list (:38) | row | target exists | same as OPEN | same | - | no | no | same | same | DUPLICATE (detail OPEN :89) |
| Ctx "Open the record" | row menu (:161) | row | target exists | same | same | - | no | no | same | same | DUPLICATE (detail OPEN :89) |
| MARK READ | detail buttons (:90,124-131) | notification unread | always | MarkNotificationReadAsync ManageG4.cs:67 -> PATCH /api/manage/notifications/{id} {read:true} | Notification.readAt = now (notifications/[id]/route.ts:22), shared for all staff. No audit | server: same broker (404), read must be true (400) | no | no | MANAGER, BROKER_ADMIN | row updated locally, toast "marked read", badges | WORKS |
| Ctx "Mark read" | row menu (:162) | row | unread | same | same | same | no | no | same | same | DUPLICATE (detail MARK READ :90) |
| RESET PASSWORD (danger) | detail buttons (:91,142-155) | type PASSWORD_RESET_REQUESTED and entityId set | always | ResetTraderPasswordAsync ApiClient.ManageG1.cs:199 -> POST /api/manage/accounts/{id}/reset-password | Account.passwordHash replaced + AuditLog ACCOUNT_PASSWORD_RESET (reset-password/route.ts:41-56); every trader session revoked (:57); if the account has an e-mail and broker e-mail is configured the password is e-mailed and NOT returned ({emailed:true,to}, :65-86); otherwise returned once ({password}) (:89,93) | server: account in broker | yes, danger ("RESET") then a second info dialog "NEW PASSWORD · SHOWN ONCE" | no | MANAGER, BROKER_ADMIN (route.ts:12) | toast "{label} · password reset"; notification NOT marked read | PARTIAL (when the server e-mails the password, the dialog shows "Account X: password reset." with no password and no mention of the e-mail, while the confirm text says "It is not e-mailed") |
| Ctx "Reset trader password…" | row menu (:163) | same as button | always | same | same | same | same | no | same | same | DUPLICATE (detail RESET PASSWORD :91) |
| Column header click / right-click | list (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

OPEN gaps (Target map :96-116 vs what the server writes, entityType values in PascalCase):
- MIRROR_KILL_SWITCH (entityType "MirrorRule", lib/mirror.ts:145-150): no case -> "NO LINKED SCREEN · entity type MirrorRule has no screen yet" although MIR exists.
- NEW_LEAD -> CRM and DEALING_ORDER_PENDING / DEALER_ACTIVITY -> DEAL: LeadsScreen and DealingScreen have no FocusRecord override, so the screen opens without the record.
- LIVE_ACCOUNT_REQUESTED -> LAR: LiveAccountRequestsScreen.FocusRecord ignores the id (LiveAccountRequestsScreen.cs:50).
- COVERAGE_STOP_OUT / COVERAGE_RELEASED / COVERAGE_CLOSE_* and OUTBOX_DEAD with a positionId (entityType "Position") -> EXP, which only lists OPEN positions; a closed position is never found (LiveExposureScreen.cs:109-113).
- ADMIN_PASSWORD_RESET_REQUESTED -> USR opens the staff member, where password reset is "not available yet" (TeamScreen.cs:179).
- PRICE_ALERT_TRIGGERED (entityType "PriceAlert"): no screen.
- Works: FUNDS_REQUEST -> DEP (FundsScreen.cs:91), KYC_SUBMITTED / CLIENT_KYC_SUBMITTED -> KYC (KycScreen.cs:75), PASSWORD_RESET_REQUESTED and MARGIN_CALL (Account) -> CLI (ClientsScreen.cs:123).

## D. Dialogs
- MARK ALL READ confirm: text "Mark all {n} unread notifications as read?", button MARK ALL. No fields.
- RESET TRADER PASSWORD confirm (danger): "Generate a new random password for account {label} and show it once? It is not e-mailed — pass it to the trader over a secure channel." button RESET. No fields. Then "NEW PASSWORD · SHOWN ONCE" dialog: "Account {label}\n\nNew password:  {pw}\n\nCopy it now — it cannot be shown again." (or "Account {label}: password reset." when no password returned), button DONE (no-op action, toasts "password handed over").

## E. Text
- Reset confirm says "It is not e-mailed" (:147) but the server e-mails it whenever the account has an e-mail and broker e-mail is configured (reset-password/route.ts:65-86).
- Type column shows the raw server type with "_" -> " " (e.g. "PASSWORD RESET REQUESTED", "OUTBOX DEAD") (:62).
- "NO LINKED SCREEN · entity type MirrorRule has no screen yet" while the MIR screen exists (:93).
- Detail row keys are lower-case ("state", "type", "entity", "created") while table headers are upper-case (:82-85).

## F. UI structure map
Layout: PageGrid columns * / 380. Left "1) NTF  NOTIFICATIONS"; header right in order: stat "{n} UNREAD · {n} TOTAL" (accent when unread), MARK ALL READ (plain), status text. Filter bar: chips ALL (default lit) · UNREAD; search "title · body · type" right.
Table columns: READ | WHEN | TYPE | TITLE | BODY | ENTITY. Sortable all; default order createdAt desc (server). Single selection (default newest); no checkbox. Click = detail; double-click = open record (+mark read); Enter: nothing. Per-row: READ shows "UNREAD" chip (accent) or blank; WHEN relative age ("now", "5m", "3h", "yesterday", "4d ago").
Right-click on row: YES — header = notification title (disabled), separator, "Open the record" (disabled when no target), "Mark read" (disabled when read), "Reset trader password…" (only for PASSWORD_RESET_REQUESTED with an entity). No shortcuts.
Right-click on multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Right "2) DETAIL  NOTIFICATION": title (bold, wraps), body, rows state · type · entity · created, then button row: OPEN {CODE} or REVIEW KYC (primary/orange, when a target exists), MARK READ (when unread), RESET PASSWORD (danger red text, PASSWORD_RESET_REQUESTED only); "NO LINKED SCREEN" block when no target.
Empty: "no notifications yet" / "nothing matches the current filters" / "SELECT A NOTIFICATION". Loading: page veil. Error: header status.

## Issues
[functional] NTF · staff inbox and unread badge include trader-scoped notifications (PRICE_ALERT_TRIGGERED written by the engine with accountId) because the list and count filter by brokerId only · app/api/manage/notifications/route.ts:20-24; app/api/manage/shell-info/route.ts:24; engine/market-data/src/db.rs:450-451
[functional] NTF · every MARGIN_CALL appears twice (a trader copy with accountId and a staff copy are both written, and both are listed) · lib/post-close.ts:159-160; lib/risk-monitor.ts:317-318; notifications/route.ts:21
[functional] NTF · MIRROR_KILL_SWITCH has no deep link ("no screen yet") though MIR exists; NEW_LEAD / DEALING_ORDER_PENDING / DEALER_ACTIVITY / LIVE_ACCOUNT_REQUESTED open their screen without focusing the record; coverage/outbox notices point EXP at closed positions it cannot show · NotificationsAuditScreens.cs:96-116; LiveAccountRequestsScreen.cs:50; LiveExposureScreen.cs:109-113
[functional] NTF · RESET PASSWORD: when the server e-mails the password it returns none; the app then shows "password reset" with no password and no statement that it was e-mailed · NotificationsAuditScreens.cs:151-152; app/api/manage/accounts/[id]/reset-password/route.ts:65-86
[functional] NTF · resetting the password does not mark the PASSWORD_RESET_REQUESTED notification read · NotificationsAuditScreens.cs:145-155
[ux] NTF · mark read / mark all read change shared state for every staff member and write no audit row · app/api/manage/notifications/route.ts:52-55; notifications/[id]/route.ts:22
[text] NTF · reset confirm says the password "is not e-mailed", contradicting the server · NotificationsAuditScreens.cs:147

## Status counts
STATUS-COUNTS app=backoffice screen=NTF WORKS=7 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=4
