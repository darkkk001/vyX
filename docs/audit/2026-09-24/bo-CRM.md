# bo-CRM · Leads (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\WalletsLeadsScreens.cs:78-146 (LeadsScreen, CRM). Nav: CLIENTS › "Leads" (ShellViewModel.cs:74).

## A. Purpose + panels
Sales leads: list with status filters and search, create, status changes, conversion to an account.
One panel: 1) CRM "LEADS · SALES" (:95).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) CRM | GET /api/manage/leads | FetchLeadsAsync ApiClient.ManageG3.cs:58 | app/api/manage/leads/route.ts:14-43 (createdAt desc; convertedAccountNumber) | on open / nav (>10 s); after writes; no poll / topic | chips OPEN (NEW+CONTACTED+QUALIFIED, default) / NEW / CONTACTED / QUALIFIED / CONVERTED / LOST / ALL; search "name · e-mail · phone" (:101-106) | none | "no leads"; error → Status |
Role: MANAGER, BROKER_ADMIN (leads/route.ts:6-12, leads/[id]/route.ts:6-12).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Status chips (7) | filter bar | always | always | none (client) | — | — | no | — | — | filtered | WORKS |
| Search box | filter bar | always | always | none (client) | — | — | no | — | — | filtered | WORKS |
| + LEAD (primary/orange) | header | always | always | POST /api/manage/leads — CreateLeadAsync ApiClient.ManageG6.cs:123-124 → leads/route.ts:45-75 | Lead create (email lower-cased); Notification NEW_LEAD (:64-72); NO AuditLog | client name + email with '@' (:131, :136) / server same (:52-54) | form | no | MANAGER, BROKER_ADMIN | toast "<name> · lead created" | WORKS |
| Right-click empty area → "Add new lead…" | table | always | always | as + LEAD | as above | as above | form | no | as above | as above | DUPLICATE (+ LEAD) |
| Row double-click | table | row | converted lead only (else nothing, :93) | Shell.Open("CLI", convertedAccountNumber) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Mark NEW" / "Mark CONTACTED" / "Mark QUALIFIED" / "Mark LOST" (4 items) | row menu | always | status ≠ item and lead not CONVERTED | PATCH /api/manage/leads/{id} {status} — SetLeadStatusAsync ApiClient.ManageG3.cs:60-61 → leads/[id]/route.ts:20-61 | Lead.status; NO AuditLog; no notification | server enum (:14, :33-40) | yes "LEAD STATUS" (danger for LOST) | no | MANAGER, BROKER_ADMIN | toast "<name> · <status>" | WORKS |
| Right-click → "Mark CONVERTED → account…" | row menu | always | not CONVERTED | GET /api/manage/accounts (whole list, client lookup by number, :140-142) then PATCH leads/{id} {status:"CONVERTED", convertedAccountId} | Lead.status + convertedAccountId (account must be in broker :41-47); NO AuditLog | client account number required and found / server convertedAccountId required for CONVERTED | yes (ConfirmWithInput "CONVERT", input "ACCOUNT NUMBER") | no | MANAGER, BROKER_ADMIN | toast "<name> · converted → <acc>" | WORKS |
Server features with no control: editing Lead.notes (leads/[id]/route.ts:48-50); un-converting (server allows any status on a CONVERTED lead; UI disables).

## D. Dialogs
NEW LEAD (:127-137):
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Full name | text, required | "" | Lead.fullName | display, notification body |
| E-mail | text, required ('@') | "" | Lead.email (lower-cased) | display |
| Phone | text | "" | Lead.phone | display |
| Country | text, hint "ISO code" (upper-cased client-side :134, not validated) | "" | Lead.country | display |
| Source | text, hint "web · referral · campaign" | "" | Lead.source | display, notification body |
| Notes | note | "" | Lead.notes | NOTES column |
CONVERT LEAD (ConfirmWithInput :138-145): "ACCOUNT NUMBER" (required) → resolved to Account.id → Lead.convertedAccountId. READ BY: this screen (CONVERTED TO), leads GET.
LEAD STATUS (Confirm :122-126): "<name>: <old> → <new>?", button = the new status.

## E. Text
- Row menu ends with a separator followed by nothing (:119).
- Summary (:78-80) "status changes (NEW → CONTACTED → QUALIFIED → LOST)" — any order is allowed; "Assign-to-staff has no endpoint" accurate.
- Chip "OPEN · <n>" shows a count; the other chips do not (:101).
- Country hint "ISO code" with no validation.

## F. UI structure map
Layout: one panel. Header: "1) CRM" · "LEADS · SALES"; header-right: stat "<shown> SHOWN OF <total> · <n> CONVERTED", Status, button "+ LEAD" (primary/orange). Filter bar: chips OPEN · <n> (default) · NEW · CONTACTED · QUALIFIED · CONVERTED · LOST · ALL, then search box. No KPI.
Table (layout "leads"): NAME · E-MAIL · PHONE · COUNTRY · SOURCE · STATUS · CONVERTED TO · NOTES · CREATED (:89-91). STATUS chip (CONVERTED green, LOST red, NEW amber, others info); CREATED as age. Sortable headers, no default sort (server createdAt desc). Single select. Row click: select; double-click: CLI when converted; Enter: nothing. Right-click on row: YES —
  "<name> · <status>" (disabled) / separator / "Mark NEW" / "Mark CONTACTED" / "Mark QUALIFIED" / "Mark LOST" (each disabled when current or lead CONVERTED) / "Mark CONVERTED → account…" (disabled when CONVERTED) / separator (trailing, nothing after) (:113-121).
Right-click empty area: YES — "LEADS · SALES" (disabled) / separator / "Add new lead…" (:96). Header: column picker. Empty: "no leads".

## Issues
- [ux] CRM · lead create and status/convert changes write no AuditLog · app/api/manage/leads/route.ts:45-75; leads/[id]/route.ts:20-61
- [ux] CRM · lead notes can only be set at creation; server PATCH supports notes, no control · leads/[id]/route.ts:48-50
- [ux] CRM · convert downloads the full accounts list to resolve one number client-side · WalletsLeadsScreens.cs:140-142
- [text] CRM · row menu ends with an empty trailing separator · WalletsLeadsScreens.cs:119

## Status counts
STATUS-COUNTS app=backoffice screen=CRM WORKS=6 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
