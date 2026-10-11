# bo-LAR — Live account requests (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiveAccountRequestsScreen.cs` (96 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: portal clients (with APPROVED portal KYC, app/api/portal/live-account-requests/route.ts:47-49) ask for a LIVE trading account; the admin approves (server creates the account and emails credentials) or rejects with a reason.
Panels: one — `1) LAR LIVE ACCOUNT REQUESTS` (LiveAccountRequestsScreen.cs:33).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error/loading |
|---|---|---|---|---|---|---|---|
| 1) LAR | GET /api/manage/live-account-requests | FetchLiveAccountRequestsAsync ApiClient.ManageG1.cs:267 | live-account-requests/route.ts:12-44 (BROKER_ADMIN or KYC_REVIEW, :14) | poll 30 s while active (:19); no live topics; nav refetch >10 s | chips PENDING/APPROVED/REJECTED/ALL, default PENDING (:23, 52-56); order pending first then newest (:47) | server take 200 (route.ts:27) | "no live account requests" (:30); error → header status (:41); "loading…" + veil |
Nav badge LAR = pending count (:48; MainWindow.axaml.cs:204). Equity: not applicable.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Status chips PENDING / APPROVED / REJECTED / ALL | filter bar (:52-56) | always | always | none | — | — | no | no | none | re-render | WORKS |
| Menu "Approve · create the live account" | row right-click (:72) | always | status PENDING | LiveAccountRequestActionAsync PATCH /api/manage/live-account-requests/{id} {action:APPROVE} (ApiClient.ManageG1.cs:268-269) | provisionAccount: Account (LIVE, request's accountTypeId, broker default group + its leverage, balance 0, clientId) + AuditLog ACCOUNT_CREATED (live-account-requests/[id]/route.ts:84-111; lib/account-provisioning.ts:96-145); then LiveAccountRequest APPROVED + createdAccountId + AuditLog LIVE_ACCOUNT_REQUEST_APPROVED (route.ts:119-136); temp password stashed for the portal (stashRevealedCredentials :138); email with account number + password via broker mail or mock (route.ts:142-165; lib/email/adapter.ts:118-131). No NATS event, no notification | server: request PENDING (route.ts:36-38); structure check (route.ts:112-116) | yes "APPROVE LIVE ACCOUNT" (:82) | no | server BROKER_ADMIN or KYC_REVIEW; client none | toast + refetch + badges | PARTIAL (toast reads `createdAccountNumber` (:86) but the PATCH returns `accountNumber` (route.ts:167) → always "<name> · approved" without the number; account is created before the request row is flipped, outside one transaction and without a status guard on the update (route.ts:32-38, 95, 120-123) — two concurrent approvals can each create an account) |
| Row double-click → Approve | table (:32) | row | status PENDING (else silently nothing, :80) | same as Approve | same | same | same confirm | no | same | same | DUPLICATE (menu Approve :72) |
| Menu "Reject…" | row right-click (:73) | always | status PENDING | same endpoint {action:REJECT, rejectionReason} | LiveAccountRequest REJECTED + rejectionReason + reviewer; AuditLog LIVE_ACCOUNT_REQUEST_REJECTED (route.ts:50-69). No email, no notification; reason readable by the client on app/api/portal/live-account-requests/route.ts:21-29 | client: reason required; server: required, ≤500 (route.ts:45-48) | yes input dialog "REJECT LIVE ACCOUNT REQUEST" (danger) (:90) | no | same | toast + refetch | WORKS |
| Menu "Open account <no>" | row right-click (:74) | only when createdAccountNumber set | always | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS |
| Column picker | header right-click | always | always | none (not persisted) | — | — | no | no | — | — | WORKS |

## D. Dialogs
- APPROVE LIVE ACCOUNT confirm: "Create a live account for <name> (<email>)?" APPROVE (:82). No fields: group = broker default group (route.ts:84, 104), leverage = that group's (or broker default) (route.ts:103), account type = the one on the request (route.ts:101), currency = broker default (route.ts:102), balance 0. None of these are shown or choosable.
- REJECT LIVE ACCOUNT REQUEST: "Reject <name> (<email>)?"; input "REASON (SENT TO THE CLIENT)" required → LiveAccountRequest.rejectionReason; READ BY app/api/portal/live-account-requests/route.ts:21-29 (client pulls it).

## E. Text
- Input label "REASON (SENT TO THE CLIENT)" (:90): the reject path sends no email/notification (route.ts:50-69).
- ACCOUNT TYPE column shows "DEFAULT" when the request has no type (:61); the account created then gets no accountTypeId passed (route.ts:101 passes existing.accountTypeId, null) — what provisionAccount assigns for null is UNVERIFIED from this route.
- ACTIONS column text "APPROVE · REJECT" (:62) is a label; double-click always means APPROVE.
- Class comment "APPROVE creates the account (the number shows on the row)" (:14-15) — only after the refetch; the toast never has it.
- FocusRecord ignores the id and only switches to ALL (:50).

## F. UI structure map
- Layout: single full-height panel. Header left "1) LAR" "LIVE ACCOUNT REQUESTS"; header right: stat "NONE PENDING" (dim) / "<n> PENDING" (amber), status text. No buttons, no KPI strip.
- Filter bar: chips PENDING · APPROVED · REJECTED · ALL (default PENDING). No search.
- Table "lar": CLIENT · E-MAIL · COUNTRY · PHONE · ACCOUNT TYPE · STATUS · CREATED ACCOUNT · REJECTION REASON · REQUESTED · ACTIONS (:29-30). Sortable all; default pending first then newest. Single select. CREATED ACCOUNT green when set else "—".
  - Row click: select only; double-click: APPROVE confirm (PENDING rows only); Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<name> · <email>" (disabled) / separator / "Approve · create the live account" (enabled when PENDING) / "Reject…" (enabled when PENDING) / "Open account <no>" (only when an account was created). No trailing separator, no submenus (:66-76).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no live account requests".

## Issues
[money] LAR · Approve creates the Account before flipping the request, not in one transaction and with no status guard on the update: concurrent approvals can create two live accounts for one request · live-account-requests/[id]/route.ts:32-38,95-111,119-123
[functional] LAR · If the credentials email throws after the account is created, the route returns 500 though the account exists and the request is APPROVED (adapter throw behaviour on Resend errors UNVERIFIED) · live-account-requests/[id]/route.ts:157-165, lib/email/adapter.ts:124-127
[functional] LAR · Approve gives no choice of group/leverage/type; always broker default group · live-account-requests/[id]/route.ts:84,101-104
[functional] LAR · List capped at 200 · live-account-requests/route.ts:27
[ux] LAR · Success toast never shows the new account number (reads createdAccountNumber; server returns accountNumber) · LiveAccountRequestsScreen.cs:86, live-account-requests/[id]/route.ts:167
[ux] LAR · Double-click on a row opens APPROVE (never reject) · LiveAccountRequestsScreen.cs:32
[ux] LAR · No live event for new requests; 30 s poll only · LiveAccountRequestsScreen.cs:19
[text] LAR · "REASON (SENT TO THE CLIENT)" — nothing is sent on reject · LiveAccountRequestsScreen.cs:90, live-account-requests/[id]/route.ts:50-69

## Status counts
STATUS-COUNTS app=backoffice screen=LAR WORKS=4 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
