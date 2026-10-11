# VYX-AUDIT-ALL part 3/9


<!-- ===== bo-KYC.md ===== -->

# bo-KYC — KYC review (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\KycScreen.cs` (252 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: review and approve/reject identity documents from two separate queues: IN-APP (KycRecord, one per trading Account) and CLIENT PORTAL (ClientKycRecord, one per portal Client, with suitability answers and optional address proof).
Panels (KycScreen.cs:53-55): left `1) KYC VERIFICATION QUEUE` (*), right `2) DOC <selected record>` (380 px).

## B. Data
Refresh: poll every 30 s while active (KycScreen.cs:27); no live topics; nav refetch if >10 s old (Screen.cs:70-76). Nav badge KYC = pending in both queues (KycScreen.cs:72; MainWindow.axaml.cs:202-203).
| Panel | Endpoint | ApiClient | Route handler | Filters/sort | Limits | Empty/error |
|---|---|---|---|---|---|---|
| 1) KYC tab IN-APP | GET /api/manage/kyc-requests | FetchKycRequestsAsync ApiClient.ManageG1.cs:255 | kyc-requests/route.ts:9-36 (BROKER_ADMIN or KYC_REVIEW) | status chips WAITING/APPROVED/REJECTED/ALL (default WAITING) (:90-95); pending first then oldest first (:100) | server take 200 (:20) | "queue is empty" (:42); both fail → status text; one fails → "in-app queue: <err>" / "client-portal queue: <err>" (:64-66) |
| 1) KYC tab CLIENT PORTAL | GET /api/manage/client-kyc-requests | FetchClientKycRequestsAsync ApiClient.ManageG1.cs:264 | client-kyc-requests/route.ts:13-46 (same gate) | same | take 200 (:24) | same |
| 2) DOC images | GET kyc-requests/{id}/document?side=front\|back ; GET client-kyc-requests/{id}/document?side=front\|back\|address | FetchKycDocumentAsync ApiClient.ManageG1.cs:259-260; FetchClientKycDocumentAsync :262-263 (GetBytesAsync :283-297) | kyc-requests/[id]/document/route.ts:18-54; client-kyc-requests/[id]/document/route.ts:13-34 | on select, sides fetched sequentially, cached per id+side for the session (:190-202) | — | tile "LOADING…" → image or "NO IMAGE ON THIS SIDE" (:175). Any failure (403/404/storage error/network) or a non-bitmap file (PDF) becomes null → "NO IMAGE ON THIS SIDE" (:197-199) |

Equity: not applicable on this screen (no balances shown).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Tab chips "IN-APP · <n>" / "CLIENT PORTAL · <n>" | queue filter bar left (:83-89) | always | always | none | — | — | no | no | none | re-render rows | WORKS |
| Status chips WAITING / APPROVED / REJECTED / ALL | filter bar after "·" (:90-95) | always | always | none | — | — | no | no | none | re-render | WORKS |
| Row click / double-click | queue (:43-44) | row | always | loads document images (above) | none | — | no | no | server KYC_REVIEW | DOC panel filled | WORKS |
| Row menu "Review (documents + decision)" | row right-click (:49) | always | always | same as row click | — | — | no | no | — | DOC | DUPLICATE (row click :43) |
| Row menu "Approve…" | (:50) | always | enabled when status PENDING | = DOC APPROVE | | | | | | | DUPLICATE (DOC APPROVE :140/:165) |
| Row menu "Reject…" | (:50) | always | enabled when PENDING | = DOC REJECT | | | | | | | DUPLICATE (DOC REJECT :140/:165) |
| Row menu "Open client 360" | (:51) | always | enabled only for IN-APP rows (needs accountNumber) (:48, 51) | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS (disabled for every CLIENT PORTAL row — no account link) |
| Document tile click | DOC panel tiles (:170-181) | record selected | always | none (opens DocumentViewer with loaded pages) | — | — | no | no | — | zoomable viewer; toast "no image on this side"/"still loading…" when nothing loaded (:209) | WORKS (PDF files never viewable, see B) |
| APPROVE (DOC, green text) | DOC → DECISION (:140, 165, 213-222) | status PENDING (else "ALREADY <STATUS>") | always | IN-APP: KycActionAsync PATCH kyc-requests/{id} {action:APPROVE} (ApiClient.ManageG1.cs:256-257); PORTAL: ClientKycActionAsync PATCH client-kyc-requests/{id} (:265-266) | KycRecord / ClientKycRecord status APPROVED, reviewer; AuditLog KYC_APPROVAL / CLIENT_KYC_APPROVAL (lib/kyc-decision.ts:23-75). No notification, no email, no NATS event. Effect elsewhere: an APPROVED ClientKycRecord unlocks the portal live-account request (app/api/portal/live-account-requests/route.ts:47-49); an APPROVED in-app KycRecord is read by no trading/funds path (only lists: accounts/route.ts:89, dashboard/route.ts:62) | server: record PENDING (route.ts:58-60) | yes "APPROVE KYC" (:228) | no | server BROKER_ADMIN or KYC_REVIEW; client none | toast + refetch + badges | WORKS |
| REJECT (DOC, red text) | DOC → DECISION | PENDING | always | same endpoints {action:REJECT, rejectionReason} | status REJECTED + rejectionReason; AuditLog KYC_REJECTION / CLIENT_KYC_REJECTION (lib/kyc-decision.ts:28-75). No notification/email; the reason is only readable by the trader/client on their own KYC GET (app/api/trade/kyc/route.ts, app/api/portal/kyc/route.ts) | client: reason required; server: reason required, ≤500 (route.ts:67-72; kyc-decision.ts:16-19) | yes input dialog "REJECT KYC" (danger) (:234) | no | same | toast + refetch | WORKS |
| Column picker | queue header right-click | always | always | none (not persisted) | — | — | no | no | — | — | WORKS |

## D. Dialogs
- APPROVE KYC confirm: "Approve <name> (in-app|client portal)?" APPROVE (:228).
- REJECT KYC input dialog: "Reject <name> (<queue>)?"; input "REASON (SENT TO THE CLIENT)" required → KycRecord.rejectionReason / ClientKycRecord.rejectionReason. READ BY: app/api/trade/kyc/route.ts (in-app), app/api/portal/kyc/route.ts (portal) — pulled by the client, not sent.
- DOC panel read-only fields: IN-APP — Name, Country, Phone, Document, Submitted, "Sanctions / PEP: NOT AVAILABLE YET", "Duplicate identity: NOT AVAILABLE YET", Decision, "Level to grant: L1 · IDENTITY" (:130-139). PORTAL — Annual income, Source of funds, Trading experience, Employment, Risk tolerance, Document, Address proof UPLOADED/NONE, E-mail, Country, Phone, Submitted, Decision, "Level to grant: L2 · SUITABILITY" (:146-164).

## E. Text
- "Level to grant L1 · IDENTITY" / "L2 · SUITABILITY" and queue LEVEL column "L1 · ID" / "L2 · SUITABILITY" (:101, 105, 139, 164): no level field exists on either record or anywhere on the server; approval only sets status (lib/kyc-decision.ts:30, 62).
- "Sanctions / PEP" and "Duplicate identity" rows permanently "NOT AVAILABLE YET" (:135-136).
- Input label "REASON (SENT TO THE CLIENT)" (:234): nothing is sent (no email/notification in lib/kyc-decision.ts).
- IN-APP DOCUMENTS column always "<type> · FRONT · BACK" even when no back image exists (:101).
- Column "ID" shows the account number for IN-APP rows and is blank for CLIENT PORTAL rows (:101, 105).
- Status "WAITING" shown for server status PENDING (:102, 106).

## F. UI structure map
- Layout: two columns — queue (left, *) | DOC (right, 380 px). No KPI strip.
- **1) KYC "VERIFICATION QUEUE"**; header right: stat "NOTHING WAITING" (dim) or "<n> WAITING · OLDEST <age>" (amber), status text. No buttons.
  - Filter bar: tabs IN-APP · <pending> | CLIENT PORTAL · <pending> (default IN-APP); "·"; chips WAITING · APPROVED · REJECTED · ALL (default WAITING).
  - Table "kyc": ID · CLIENT · COUNTRY · LEVEL · DOCUMENTS · STATUS · AGE · ACTIONS (:42). Sortable all; default order pending first, then oldest created first (:100, 104). Single select. ACTIONS cell text "REVIEW" (label only).
  - Row click → select + DOC; double-click → same; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<client name>" (disabled) / separator / Review (documents + decision) / Approve… (enabled when PENDING) / Reject… (enabled when PENDING) / separator / Open client 360 (enabled for IN-APP rows only) (:45-52).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "queue is empty".
- **2) DOC** header: "2) DOC" + right title "<ACC> · <NAME>" or "<NAME> · CLIENT PORTAL" or "SELECT A RECORD". Body: IN-APP → section DOCUMENTS (2 tiles FRONT, BACK) / CHECKS rows / DECISION (Level to grant + APPROVE | REJECT buttons or "ALREADY <STATUS>"). PORTAL → SUITABILITY rows / IDENTITY tiles (FRONT, BACK, + ADDRESS PROOF when present) + rows / DECISION. Empty "NO RECORD SELECTED". APPROVE green, REJECT red; no primary/orange.
- Loading: "loading…" status + veil on nav; tiles "LOADING…".

## Issues
[functional] KYC · Approving an in-app KycRecord changes nothing outside lists — no trading, funds or account path reads it · lib/kyc-decision.ts:30, grep of app/api + lib (only accounts/route.ts:89, dashboard/route.ts:62)
[functional] KYC · Document fetch errors (403/404/storage) and PDF documents all render as "NO IMAGE ON THIS SIDE"; PDFs are accepted on upload but can never be viewed · KycScreen.cs:196-199,175, ClientsScreen.cs:407 (hint "jpg, png or pdf")
[functional] KYC · An in-app KycRecord's addressProofUrl (set by accounts/{id}/kyc) cannot be viewed: the in-app document route accepts only front/back and the list does not expose it · accounts/[id]/kyc/route.ts:105,115, kyc-requests/[id]/document/route.ts:24-26
[functional] KYC · Queues are capped at 200 records each; older pending ones beyond that are not listed · kyc-requests/route.ts:20, client-kyc-requests/route.ts:24
[ux] KYC · No live event for new submissions; queue updates only on the 30 s poll · KycScreen.cs:27
[ux] KYC · "Open client 360" is always disabled for CLIENT PORTAL rows · KycScreen.cs:48,51
[text] KYC · "Level to grant L1/L2" and LEVEL column describe a level concept the server does not have · KycScreen.cs:101,105,139,164
[text] KYC · Reject label "REASON (SENT TO THE CLIENT)" — no email/notification is sent · KycScreen.cs:234, lib/kyc-decision.ts
[text] KYC · Permanent "NOT AVAILABLE YET" rows (Sanctions / PEP, Duplicate identity) · KycScreen.cs:135-136
[text] KYC · DOCUMENTS column always says FRONT · BACK for in-app rows · KycScreen.cs:101

## Status counts
STATUS-COUNTS app=backoffice screen=KYC WORKS=8 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=3


<!-- ===== bo-LAR.md ===== -->

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


<!-- ===== bo-DEP.md ===== -->

# bo-DEP — Deposits · withdrawals (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\FundsScreen.cs` (171 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: review trader-submitted DEPOSIT / WITHDRAWAL requests (Transaction rows, status PENDING). Deposit: one APPROVE completes. Withdrawal: 1st admin MARKs, a different admin CONFIRMs; the marker may CANCEL MARK; REJECT at any point.
Panels: KPI strip of 8 tiles (54 px) above `1) DEP DEPOSITS & WITHDRAWALS` (FundsScreen.cs:45-47).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error |
|---|---|---|---|---|---|---|---|
| KPI strip + 1) DEP | GET /api/manage/funds-requests | FetchFundsRequestsAsync ApiClient.ManageG1.cs:235-243 | funds-requests/route.ts:11-45 (BROKER_ADMIN or FUNDS_APPROVAL) | live topic "account" + poll 20 s while active (:24-25); nav refetch >10 s | chips PENDING/DEPOSITS/WITHDRAWALS/MARKED/COMPLETED/REJECTED/ALL, default PENDING (:31, 98-102); search account/client/note (:120); order pending first then newest (:121) | server take 200 across all statuses, PENDING first (route.ts:24-25; enum order PENDING first, prisma/schema.prisma:118-123) | "no requests" (:39); error → header status; "loading…" + veil |
KPIs are computed client-side from those ≤200 rows (:59-78). Amount sign: a WITHDRAWAL Transaction.amount is stored negative (app/api/trade/funds-requests/route.ts:111; lib/funds-approval.ts:128 "amount already signed (negative for withdrawal)"); the screen does not negate it.
Nav badge DEP = pending count (MainWindow.axaml.cs:205). Equity: not shown; BALANCE column = Account.balance now (route.ts:39), not equity/free margin.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filter chips (7) | filter bar (:98-102) | always | always | none | — | — | no | no | none | re-render | WORKS |
| Search "account · client" | filter bar right (:28, 46) | always | always | none (also matches note, :120) | — | — | no | no | none | re-render | WORKS |
| Row double-click → primary step | table (:41) | row | status PENDING (else no-op, :153) | = menu primary item | | | | | | | DUPLICATE (menu primary :143) |
| Menu "Approve · complete the deposit" | row right-click (:143) | PENDING DEPOSIT | always | FundsRequestActionAsync PATCH /api/manage/funds-requests/{id} {action:APPROVE, note:""} (ApiClient.ManageG1.cs:247-252) | approveFundsRequest: row-lock balance, Account.balance += amount, Transaction COMPLETED + reviewer, AuditLog FUNDS_REQUEST_APPROVED (lib/funds-approval.ts:115-156); NATS BalanceChanged (funds-requests/[id]/route.ts:104). No notification to the trader | server: PENDING, type DEPOSIT/WITHDRAWAL (route.ts:37-42) | yes "APPROVE DEPOSIT" (:157) | no (single approval by design, route.ts:19-20) | server BROKER_ADMIN or FUNDS_APPROVAL; client none | toast + refetch + badges | WORKS |
| Menu "Mark for approval (1st admin)" | (:143) | PENDING WITHDRAWAL, not marked | always | same PATCH {action:APPROVE} | markFundsRequestForApproval: Transaction.markedByAdminId/markedAt + AuditLog FUNDS_REQUEST_MARKED_FOR_APPROVAL; no balance change (lib/funds-approval.ts:42-63; route.ts:82-87) | — | yes "MARK WITHDRAWAL FOR APPROVAL" (:158) | YES — this is the maker step | same | toast "…marked, awaiting a second admin" (:168) | WORKS |
| Menu "Confirm · complete the withdrawal (2nd admin)" | (:143) | PENDING WITHDRAWAL marked by someone else (StepOf :110) | always | same PATCH {action:APPROVE} | approveFundsRequest: balance += (negative) amount; refused if balanceAfter < 0 (lib/funds-approval.ts:127-132); Transaction COMPLETED; AuditLog FUNDS_REQUEST_APPROVED; NATS BalanceChanged. No free-margin / open-position check; no notification | server: acting admin ≠ marker (lib/funds-approval.ts:33-35) | yes "CONFIRM WITHDRAWAL" (danger) (:159) | YES — checker step | same | toast + refetch | WORKS |
| Menu "Cancel my mark" | (:143) | PENDING WITHDRAWAL marked by the current admin (:109) | always | same PATCH {action:CANCEL_MARK} | Transaction.markedByAdminId/markedAt := null + AuditLog FUNDS_REQUEST_MARK_CANCELLED (lib/funds-approval.ts:66-80). Server accepts CANCEL_MARK from ANY admin with the permission, not only the marker (route.ts:51-63) | server: must be marked | yes "CANCEL YOUR MARK" (:160) | — | same | toast + refetch | WORKS |
| Menu "Reject…" | (:145) | status PENDING | always | same PATCH {action:REJECT, note} | rejectFundsRequest: status REJECTED, reviewer, mark cleared, Transaction.note := the typed note, AuditLog FUNDS_REQUEST_REJECTED (lib/funds-approval.ts:84-103). No notification | client: note optional; server note ≤500. Empty note is sent as "" → route uses `note ?? existing.note`, so "" (not null) overwrites the trader's original note (route.ts:49, 68) | yes input dialog "REJECT REQUEST" (danger) (:163) | no | same | toast + refetch | PARTIAL (the trader's request note is overwritten by the reject note, and erased when the note is left empty) |
| Menu "Open client <acc>" | (:147) | always | always | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS |
| Column picker | header right-click | always | always | none; persisted "funds" (:42-43) | — | — | no | no | — | — | WORKS |

## D. Dialogs
- APPROVE DEPOSIT: "Credit <amt> USD to <name> (<acc>)? Balance now <bal>." APPROVE (:157).
- MARK WITHDRAWAL FOR APPROVAL: "Mark <amt> USD for <who>? A second admin confirms the payout." MARK (:158). <amt> is the stored negative amount (e.g. "-500.00 USD") (:154).
- CONFIRM WITHDRAWAL: "Pay out <amt> USD to <who>? Marked by <email>. Balance now <bal>." CONFIRM (danger) (:159).
- CANCEL YOUR MARK: "Withdraw your approval mark on <amt> USD for <who>?" CANCEL MARK (:160).
- REJECT REQUEST: "Reject <type> <amt> USD for <name> (<acc>)?"; input "NOTE (OPTIONAL)" → Transaction.note (replaces the original) + AuditLog.newValue.note. READ BY: trader's balance history (app/api/trade/transactions/route.ts), CLI ledger REASON (ClientsScreen.cs:343).

## E. Text
- Withdrawal amounts render with a minus sign everywhere: AMOUNT column, KPI "PENDING WITHDRAWALS" and "WITHDRAWALS · 30D" values, confirm texts "Pay out -500.00 USD" (:64, 69, 71, 74, 127, 154).
- Header stat "<n> PENDING · <sum> USD" (:132) sums pending deposits (positive) and withdrawals (negative) into one net figure.
- KPI "REJECTED · ALL TIME" (:76) and 30-day KPIs (:68-75) are computed from the latest ≤200 rows only.
- KPI "PSP COST · MTD" value empty, note "NO PSP FEED ON THIS SERVER" (:77) — permanent placeholder tile.
- KPI "AVG TICKET · 30D" value empty when no deposits (:75).
- 30-day KPIs filter on CreatedAt (request date), not completion date (:68-69).
- STEP column values "AWAITING APPROVAL", "1ST ADMIN · MARK", "MARKED BY YOU · 2ND ADMIN NEEDED", "2ND ADMIN · CONFIRM" (:107-110).

## F. UI structure map
- Layout: row 1 (54 px) KPI strip, 8 tiles in order: PENDING DEPOSITS · PENDING WITHDRAWALS · AWAITING 2ND ADMIN · DEPOSITS · 30D · WITHDRAWALS · 30D · AVG TICKET · 30D · REJECTED · PSP COST · MTD (:70-77). Row 2: panel "1) DEP" "DEPOSITS & WITHDRAWALS"; header right: stat "NONE PENDING" / "<n> PENDING · <sum> USD" (amber), status text. No buttons (no primary/orange).
- Filter bar: chips PENDING · DEPOSITS · WITHDRAWALS · MARKED · COMPLETED · REJECTED · ALL (default PENDING) — PENDING = status PENDING; DEPOSITS/WITHDRAWALS = type (any status); MARKED = PENDING and marked; COMPLETED/REJECTED = status; ALL. Search "account · client" right.
- Table "funds": CLIENT · ACCOUNT · TYPE · AMOUNT · BALANCE · STATUS · STEP · MARKED BY · NOTE · CREATED · ACTIONS (:38-39). Sortable all; default pending first then newest. Single select. TYPE chip green (deposit)/accent (withdrawal); ACTIONS text "<PRIMARY> · REJECT" on pending rows (label only).
  - Row click: select; double-click: the primary step's confirm; Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<TYPE> <amount> · <acc> · <step>" (disabled) / separator / [PENDING only: primary item — one of "Approve · complete the deposit" | "Mark for approval (1st admin)" | "Confirm · complete the withdrawal (2nd admin)" | "Cancel my mark"; then "Reject…"] / "Open client <acc>" (always). No separator before "Open client", no submenus (:135-149).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no requests".

## Issues
[money] DEP · Withdrawal confirm checks only balanceAfter ≥ 0; no free-margin / open-position check, so a payout can leave open positions under-margined · lib/funds-approval.ts:127-134
[money] DEP · Withdrawal amounts are shown negative and the header "PENDING · <sum> USD" nets deposits against withdrawals · FundsScreen.cs:71,74,127,132,154, app/api/trade/funds-requests/route.ts:111
[functional] DEP · Reject overwrites the trader's request note with the admin note; an empty (optional) note erases it ("" is not null for ??) · FundsScreen.cs:163, funds-requests/[id]/route.ts:49,68, lib/funds-approval.ts:90
[functional] DEP · All KPIs (30-day totals, REJECTED all-time, averages) come from the latest 200 funds rows only · funds-requests/route.ts:25, FundsScreen.cs:59-78
[functional] DEP · CANCEL_MARK is accepted from any admin with FUNDS_APPROVAL, not only the marker (UI offers it to the marker only) · funds-requests/[id]/route.ts:51-63, FundsScreen.cs:109
[functional] DEP · No trader notification on approve / reject (only NATS BalanceChanged on completion) · lib/funds-approval.ts, funds-requests/[id]/route.ts:104
[ux] DEP · Deposit / withdrawal requests carry no live event; list relies on the 20 s poll or an "account" event · FundsScreen.cs:24-25
[text] DEP · "PSP COST · MTD" tile is a permanent placeholder ("NO PSP FEED ON THIS SERVER") · FundsScreen.cs:77
[text] DEP · Confirm texts show negative payouts ("Pay out -500.00 USD") · FundsScreen.cs:154,158-159

## Status counts
STATUS-COUNTS app=backoffice screen=DEP WORKS=8 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-APR.md ===== -->

# bo-APR · Approvals (maker-checker queue, backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:19-105 (ApprovalsScreen, APR). Nav: FINANCE › "Approvals" (ShellViewModel.cs:80); nav badge = pending balance + position requests (Views/MainWindow.axaml.cs:199).

## A. Purpose + panels
Second-admin review of (1) balance adjustments filed by a MANAGER and (2) position DELETE / VOID / REVERSE requests filed by a MANAGER.
Panels: 1) BAL "BALANCE ADJUSTMENTS · AWAITING A SECOND ADMIN" (top half), 2) POS "POSITION ACTIONS · DELETE / VOID / REVERSE" (bottom half) (:38-40).

### Maker-checker rules (lib)
- Who files: only MANAGER role needs approval; BROKER_ADMIN executes balance adjustments and position actions directly — lib/balance-adjustment.ts:40-42 (balanceAdjustmentNeedsApproval), lib/position-actions.ts:22-24 (positionActionNeedsApproval).
- Distinct admins required: 2 (requester + a different approver). Approve refuses when requestedByAdminId === approver — lib/balance-adjustment.ts:129, lib/position-actions.ts:539.
- Approver role: MANAGER or BROKER_ADMIN (approve routes :17 / :20) AND (BROKER_ADMIN or ACCOUNT_FINANCE permission) — balance-adjustment-requests/[id]/approve/route.ts:24, position-action-requests/[id]/approve/route.ts:27.
- Reject: any MANAGER/BROKER_ADMIN, no distinct-admin check (requester can reject own request) — lib/balance-adjustment.ts:157-175; reject routes :8; lib/position-actions.ts:571-577 (same shape).
- Single-admin broker: a broker whose only staff login is a BROKER_ADMIN never creates requests (direct execution), so nothing waits. A broker whose staff are one MANAGER only (no BROKER_ADMIN, no second MANAGER holding ACCOUNT_FINANCE) can file requests that can NEVER be approved (only rejected). Headcount per tenant UNVERIFIED (no DB access).
- Concurrency: approve reads status PENDING then updates by id only (lib/balance-adjustment.ts:126-142); applyBalanceAdjustment reads balance then writes balanceAfter (lib/balance-adjustment.ts:53). Two simultaneous approvals by two different admins are not excluded by a status-guarded update — double-apply UNVERIFIED (not executed; read-only audit).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) BAL | GET /api/manage/balance-adjustment-requests[?status=ALL] | FetchBalanceAdjustmentRequestsAsync ApiClient.ManageG6.cs:74-75 | app/api/manage/balance-adjustment-requests/route.ts:12-52 (createdAt desc, take 200) | live topics account, position; poll 20 s (:21-22); after writes | chip PENDING (default) / ALL (:42) | 200 rows | "no balance adjustments waiting"; error → Status "balance: …" |
| 2) POS | GET /api/manage/position-action-requests[?status=ALL] | FetchPositionActionRequestsAsync ApiClient.ManageG6.cs:78-79 | app/api/manage/position-action-requests/route.ts (createdAt desc, take 200) | same | same chip (only on panel 1's filter bar) | 200 rows | "no position actions waiting"; error → Status "positions: …" |
TICKET column: client reads position.ticket (ApiClient.ManageG6.cs:35) but the route does not send ticket (position-action-requests/route.ts:23-35, :50-58) → always "—".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Chips PENDING / ALL | BAL filter bar | always | always | refetch both lists with/without ?status=ALL | — | — | no | — | MANAGER, BROKER_ADMIN | both tables reload | WORKS |
| Double-click ACTIONS cell (BAL) → APPROVE ADJUSTMENT dialog | BAL table | row | row PENDING (no "mine" check, :33) | POST /api/manage/balance-adjustment-requests/{id}/approve {reviewNote} — ReviewBalanceAdjustmentAsync ApiClient.ManageG6.cs:76-77 → approve/route.ts:15-44 | Transaction + Account.balance via applyBalanceAdjustment; request APPROVED; AuditLog BALANCE_ADJUSTMENT_APPROVED (lib/balance-adjustment.ts:131-153); NATS BalanceChanged (approve/route.ts:39) | review note optional / server distinct admin, PENDING | yes (ConfirmWithInput "APPROVE") | yes, this IS the checker | MANAGER/BROKER_ADMIN + ACCOUNT_FINANCE or BROKER_ADMIN | toast "… approved and applied"; refetch | WORKS |
| Right-click → "Approve…" (BAL) | BAL row menu | always | PENDING (also for own request) | as above | as above | as above | yes | yes | as above | as above | DUPLICATE (ACTIONS double-click) |
| Right-click → "Reject…" (BAL) | BAL row menu | always | PENDING | POST …/{id}/reject {reviewNote} → reject/route.ts | request REJECTED; AuditLog BALANCE_ADJUSTMENT_REJECTED (lib/balance-adjustment.ts:165-177) | review note REQUIRED client-side (:96 `!approve`) / server optional | yes (danger) | reject needs no second admin | MANAGER, BROKER_ADMIN | toast "… rejected" | WORKS |
| Right-click → "Open client <acc>" (BAL) | BAL row menu | always | always | navigation Shell.Open("CLI", accountNumber) | — | — | no | — | — | CLI screen | WORKS |
| Double-click ACTIONS cell (POS) → APPROVE <ACTION> | POS table | row | PENDING | POST /api/manage/position-action-requests/{id}/approve — ReviewPositionActionAsync ApiClient.ManageG6.cs:80-81 → position-action-requests/[id]/approve/route.ts | executes DELETE / VOID / REVERSE (lib/position-actions.ts:532-570); mirror.onClose / onFillPosition; NATS PositionModified / PositionClosed / OrderFilled (approve route switch) | server distinct admin, PENDING | yes | yes | as balance | toast "… approved and executed" | WORKS |
| Right-click → "Approve…" (POS) | POS row menu | always | PENDING | as above | as above | as above | yes | yes | as above | as above | DUPLICATE (ACTIONS double-click) |
| Right-click → "Reject…" (POS) | POS row menu | always | PENDING | POST …/{id}/reject → position-action-requests/[id]/reject/route.ts | request REJECTED (lib/position-actions.ts:571+) | note required client-side | yes (danger) | no | MANAGER, BROKER_ADMIN | toast | WORKS |
| Right-click → "Open client <acc>" (POS) | POS row menu | always | always | navigation | — | — | no | — | — | CLI | WORKS |

## D. Dialogs
APPROVE / REJECT (ConfirmWithInput, :93-104): detail line "<±amount> on <acc> (<name>) · requested by <email>: \"<note>\"" / "<SYM> <SIDE> <vol> of <acc> · requested by …"; one input "REVIEW NOTE" (required for REJECT only) → BalanceAdjustmentRequest.reviewNote / PositionActionRequest.reviewNote (≤500 chars, approve/route.ts:30). READ BY: display only (this screen's REVIEW column, audit).

## E. Text
- "AWAITING OTHER ADMIN" (ACTIONS cell for own requests, :59, :67) while double-click on that cell still opens APPROVE (server answers "a different staff member must approve this request").
- Panel 2 subtitle "DELETE / VOID / REVERSE" vs action values rendered with '_' → ' ' (e.g. "REVERSE IN PLACE"), fine.
- Summary (:16-18) says balance adjustments come from "a MANAGER" and position actions from "any admin" — position actions also need approval only when filed by a MANAGER (lib/position-actions.ts:22-24).

## F. UI structure map
Layout: rows * / * (:40). No KPI strip.
Panel 1 header: "1) BAL" · "BALANCE ADJUSTMENTS · AWAITING A SECOND ADMIN"; header-right: stat "<n> PENDING · <±sum>", Status. Filter bar: chips PENDING (default) · ALL — filter both panels.
Table BAL (layout "apr-balance"): REQUESTED · ACCOUNT · CLIENT · AMOUNT · BALANCE NOW · NOTE · REQUESTED BY · STATUS · REVIEW · ACTIONS (:28-29). REQUESTED BY suffixed " (you)" for own; STATUS chip PENDING/APPROVED/REJECTED; ACTIONS "APPROVE · REJECT" (orange) or "AWAITING OTHER ADMIN". Sortable headers, no default sort (server createdAt desc). Single select, no checkbox. Row click: select; double-click on ACTIONS cell: APPROVE dialog (never REJECT); double-click elsewhere: nothing; Enter: nothing. Right-click on row: YES —
  "<±amount> · <acc>" (disabled) / separator / "Approve…" (enabled PENDING) / "Reject…" (enabled PENDING) / separator / "Open client <acc>" (:73-82).
Right-click empty area: NO. Header: column picker. Empty: "no balance adjustments waiting".
Panel 2 header: "2) POS" · "POSITION ACTIONS · DELETE / VOID / REVERSE"; header-right: stat "<n> PENDING".
Table POS (layout "apr-positions"): REQUESTED · ACTION · TICKET · POSITION · ACCOUNT · REASON · REQUESTED BY · STATUS · REVIEW · ACTIONS (:30-32). ACTION chip (DELETE red, others amber); TICKET always "—" (see B). Same interactions. Right-click row: YES — "<ACTION> · <SYM> <SIDE> <vol> · <acc>" (disabled) / separator / "Approve…" / "Reject…" / separator / "Open client <acc>" (:83-92). Empty: "no position actions waiting".

## Issues
- [money] APR · approve is check-then-act without a status-guarded update or row lock; two different admins approving at once may both apply the adjustment (UNVERIFIED, not executed) · lib/balance-adjustment.ts:126-142, :53
- [functional] APR · a tenant whose only staff login is one MANAGER can file balance/position requests that can never be approved (needs a different admin with ACCOUNT_FINANCE or BROKER_ADMIN) · lib/balance-adjustment.ts:129, approve/route.ts:24
- [functional] APR · TICKET column is always "—": route does not return position.ticket · position-action-requests/route.ts:50-58, ApiClient.ManageG6.cs:35
- [ux] APR · Approve (menu and ACTIONS double-click) is offered on the admin's own request; server rejects it · ApprovalsMirrorScreens.cs:33, :77
- [ux] APR · requester can reject (withdraw) their own request; no distinct-admin rule on reject · lib/balance-adjustment.ts:157-175
- [text] APR · summary says position actions filed by "any admin" need approval; only MANAGER-filed ones do · ApprovalsMirrorScreens.cs:16-18, lib/position-actions.ts:22-24

## Status counts
STATUS-COUNTS app=backoffice screen=APR WORKS=7 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2


<!-- ===== bo-PSP.md ===== -->

# bo-PSP · Payment methods (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\PaymentMethodsScreen.cs (PSP). Nav: FINANCE › "Payment methods" (ShellViewModel.cs:81).

## A. Purpose + panels
The broker's five deposit/withdrawal methods (USDT TRC20, USDT BEP20, BTC, ETH, bank transfer): enabled, min/max, fee, wallet address, instructions; staged inline edits saved per row.
One panel: 1) PSP "PAYMENT METHODS" (:40).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) PSP | GET /api/manage/payment-methods | FetchPaymentMethodsAsync ApiClient.ManageG3.cs:41 | app/api/manage/payment-methods/route.ts:35-60 (always the 5 types, fixed order :12; unsaved type = DEFAULTS enabled:false, min 0, id "" :14-22) | on open / nav (>10 s); after save; no poll | fixed | 5 rows | "no methods"; error → Status |
Role: BROKER_ADMIN only for GET and PATCH (payment-methods/route.ts:29); nav visible to every role.
Readers of PaymentMethod: client list app/api/trade/payment-methods/route.ts:18-31 (enabled rows only; returns walletAddress); funds request app/api/trade/funds-requests/route.ts:85-93 (enabled, minAmount, maxAmount enforced); fee is display-only, never deducted (lib/psp/adapter.ts:108-121).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Double-click MINIMUM / MAXIMUM / FEE % / FEE FIXED / WALLET ADDRESS / INSTRUCTIONS | grid | always | always | none; inline editor, Enter commits, Esc cancels, lost focus commits (:37-38, :66-85) → staged | none until SAVE | client: min / fee% / fee fixed numeric, max numeric or empty (:82-83); wallet / instructions free text | no | no | — | cell amber, "CHANGED", ACTIONS "SAVE" | WORKS |
| Double-click ENABLED | grid | always | always | none, stages toggle (:69) | — | — | no | no | — | staged | WORKS |
| Double-click ACTIONS "SAVE" | grid | row staged | row staged | PATCH /api/manage/payment-methods (whole row) — SavePaymentMethodAsync ApiClient.ManageG3.cs:43-44 → payment-methods/route.ts:83-142 | PaymentMethod upsert by (broker, type) (:123-131); NO AuditLog; no notification | server: numbers, non-negative, fee% ≤ 100, max > 0, min ≤ max; instructions truncated to 1000, wallet to 200 chars silently (:94-121) | yes "SAVE PAYMENT METHOD" (:90) | no | BROKER_ADMIN | toast "<method> saved"; refetch | PARTIAL (no audit trail for wallet-address / fee / enable changes) |
| Right-click → "Save this row…" | row menu | always | row staged | as ACTIONS SAVE | as above | as above | yes | no | BROKER_ADMIN | as above | DUPLICATE (ACTIONS double-click) |
| Right-click → "Revert this row" | row menu | always | row staged | none (:102) | — | — | no | no | — | row reset | WORKS |
| Right-click → "Disable (stage)" / "Enable (stage)" | row menu | always | always | stages (:103) | — | — | no | no | — | staged | DUPLICATE (ENABLED double-click) |

## D. Dialogs
Inline editor (no dialog); SAVE confirm text "Save <METHOD>: enabled|disabled, min <x>, max <y|none>, fee <p>% + <f>?" (:90) — wallet address and instructions changes are not shown in the confirm.
| Field | Type / default | Stored in | READ BY |
|---|---|---|---|
| ENABLED | bool / false | PaymentMethod.enabled | app/api/trade/payment-methods/route.ts:18; funds-requests/route.ts:86 |
| MINIMUM | decimal / 0 | minAmount | funds-requests/route.ts:89 |
| MAXIMUM | decimal or empty = no max | maxAmount | funds-requests/route.ts:92 |
| FEE % / FEE FIXED | decimal / 0 | feePercent / feeFixed | display estimate only, lib/psp/adapter.ts:108-121 (not deducted) |
| WALLET ADDRESS | text ≤200 | walletAddress | client deposit screen via app/api/trade/payment-methods/route.ts:31 |
| INSTRUCTIONS | text ≤1000 | instructions | client via trade/payment-methods route |

## E. Text
- WALLET cell for bank transfer "n/a · bank details in instructions" (:60).
- state column "DEFAULTS" for a method never saved (:62) — such a method has no row, so clients never see it even if the defaults look fine.
- Summary (:17-20) "The design's PSP gateways / method ORDER have no endpoint" — accurate; "SAVE per changed row" accurate.
- FEE columns imply a charge; the fee is display-only (lib/psp/adapter.ts:108-114).

## F. UI structure map
Layout: one panel. Header: "1) PSP" · "PAYMENT METHODS"; header-right: stat "<n> OF 5 ENABLED · <n> UNSAVED" (amber when unsaved), Status. No KPI, no chips, no toolbar buttons.
Table (layout "payment-methods"): METHOD · ENABLED · MINIMUM · MAXIMUM · FEE % · FEE FIXED · WALLET ADDRESS · INSTRUCTIONS · (blank: state) · ACTIONS (:32-34). METHOD labels USDT · TRC20 / USDT · BEP20 / BTC / ETH / BANK TRANSFER; ENABLED chip ON/OFF; state chip CHANGED / DEFAULTS; ACTIONS "SAVE" (orange) when staged. Sortable headers, no default sort (server fixed order). Single select. Row click: select; double-click: per cell (see C); Enter: only in editor. Right-click on row: YES —
  "<METHOD>" (disabled) / separator / "Save this row…" (enabled when staged) / "Revert this row" (enabled when staged) / "Disable (stage)" or "Enable (stage)" (:97-105).
Right-click empty area: NO. Header: column picker. Empty: "no methods".

## Issues
- [money] PSP · changing a deposit wallet address, limits, fee or enabled flag writes no AuditLog · app/api/manage/payment-methods/route.ts:83-142
- [ux] PSP · SAVE confirm omits wallet address / instructions, the fields most likely to be tampered with · PaymentMethodsScreen.cs:90
- [ux] PSP · instructions >1000 / wallet >200 chars are truncated silently by the server · payment-methods/route.ts:120-121
- [ux] PSP · screen visible to MANAGER, route BROKER_ADMIN-only (403) · ShellViewModel.cs:81; payment-methods/route.ts:29
- [text] PSP · FEE % / FEE FIXED look like charges; fees are display-only, never deducted · lib/psp/adapter.ts:108-114

## Status counts
STATUS-COUNTS app=backoffice screen=PSP WORKS=3 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2


<!-- ===== bo-TRX.md ===== -->

# bo-TRX — Internal transfers (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\TransfersScreen.cs` (92 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: move balance between two accounts of the broker (admin-initiated), with a mandatory audited note; show the last 200 transfer legs.
Panels (TransfersScreen.cs:39-41): top `1) TRX INTERNAL TRANSFER` form (150 px), bottom `2) HIST TRANSFER HISTORY · LAST 200`.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error |
|---|---|---|---|---|---|---|---|
| 1) TRX preview (account lookup) | GET /api/manage/accounts | FetchManageAccountsAsync ApiClient.ManageG1.cs:152 | accounts/route.ts:21-95 (MANAGER/BROKER_ADMIN) | on nav (>10 s) and after a transfer only — no live topics, no poll (screen overrides neither) | exact accountNumber match (:63) | all accounts | problems listed in red under the form (:65-78) |
| 2) HIST | GET /api/manage/transfers | FetchTransfersAsync ApiClient.ManageG3.cs:46 | transfers/route.ts:20-43 (BROKER_ADMIN or INTERNAL_TRANSFERS) | same | newest first (route.ts:29) | take 200 (route.ts:30) | "no transfers yet" (:30); error → header status (:49) |
If the accounts call fails, _accounts becomes empty silently and every preview says "FROM account not found" / "TO account not found" (:50, 66).
Equity: preview shows balance before → after only (:76-77); no equity / free margin.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| FROM / TO / AMOUNT / NOTE inputs | form (:21, 35) | always | always | none | — | see PREVIEW | — | — | — | — | WORKS |
| PREVIEW | form buttons (:37) | always | always | none (client-side on cached accounts, :60-80) | none | client: both accounts found, not the same, same e-mail ("different clients"), same mode, both ACTIVE, amount >0 and ≤ FROM balance, note non-empty (:66-75) | no | no | none | preview rows + problems / "ready · TRANSFER to confirm" | WORKS (uses the account list from the last refresh; balances may be stale) |
| TRANSFER (primary/orange) | form buttons (:37) | always | runs PREVIEW first; proceeds only with no problems (:83) | CreateTransferAsync POST /api/manage/transfers {fromAccountId, toAccountId, amount "0.00", note} (ApiClient.ManageG3.cs:48-49) | one DB transaction: both balances row-locked; FROM balance −amount + Transaction TRANSFER_OUT (amount negative, note "Transfer to <no>: <note>"); TO balance +amount + Transaction TRANSFER_IN ("Transfer from <no>: <note>"); AuditLog INTERNAL_TRANSFER (transfers/route.ts:97-137); NATS BalanceChanged for both accounts (:148-149). No notification | server: ids, not same, note required, amount >0, same broker, both ACTIVE, same mode, same currency, FROM balance ≥ amount (route.ts:57-102). Server does NOT check same client — only the UI (by e-mail) does. No free-margin check | yes "INTERNAL TRANSFER" (:85) | no | server BROKER_ADMIN or INTERNAL_TRANSFERS; client none | inputs cleared, "transferred", toast, refetch | WORKS |
| HIST row double-click | history (:31) | row | always | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS |
| HIST menu "Open client 360" | row right-click (:32) | always | always | same | — | — | no | no | none | Client 360 | DUPLICATE (row double-click :31) |
| HIST menu "Use as FROM account" | (:32) | always | always | none (fills FROM) | — | — | no | no | none | — | WORKS |
| HIST menu "Use as TO account" | (:32) | always | always | none (fills TO) | — | — | no | no | none | — | WORKS |
| Column picker | history header right-click | always | always | none (not persisted) | — | — | no | no | — | — | WORKS |

## D. Dialogs / form fields
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| FROM "from account no." | text (account number) | "" (or set by FocusRecord / history menu, :59) | resolved to Account.id → Transaction(TRANSFER_OUT).accountId | ledger, balance |
| TO "to account no." | text | "" | Transaction(TRANSFER_IN).accountId | ledger, balance |
| AMOUNT "amount" | text, parsed invariant double | "" | Transaction.amount (±), Account.balance ×2 | trader balance history (app/api/trade/transactions/route.ts:30-38), CLI ledger |
| NOTE "note (audited, required)" | text | "" | Transaction.note (prefixed "Transfer to/from <no>: "), AuditLog.newValue.note | CLI ledger REASON, trader balance history |
Confirm "INTERNAL TRANSFER": "Move <amt> <ccy> from <FROM> to <TO> (<from name>)? Note: "<note>"" TRANSFER (not flagged danger) (:85).

## E. Text
- Preview problem "accounts belong to different clients (server refuses)" (:70): the server has no same-client check (transfers/route.ts:77-95).
- Class comment "same client, same mode, both active" as the server's rule (:17) — server enforces mode, status, currency, balance; not client.
- Panel title "TRANSFER HISTORY · LAST 200" matches server take 200; header stat "<n> LEGS" (:57) — each transfer is 2 legs, so 200 legs = 100 transfers.
- History TYPE shows "OUT"/"IN" (:55); AMOUNT for OUT is negative with red tone.
- Placeholder text "from · to · amount → PREVIEW" (:42).

## F. UI structure map
- Layout: row 1 (150 px) panel "1) TRX" "INTERNAL TRANSFER"; header right: status text only. Body: wrap row of labelled inputs FROM · TO · AMOUNT · NOTE, then buttons PREVIEW (plain) and TRANSFER (primary/orange); below, preview area (rows "FROM <no> · <name>  <bal> → <bal after> USD", "TO …", red "· <problem>" lines, green "ready · TRANSFER to confirm").
- Row 2: panel "2) HIST" "TRANSFER HISTORY · LAST 200"; header right stat "<n> LEGS". No filters, no search, no chips.
- Table "transfers": WHEN · ACCOUNT · TYPE · AMOUNT · NOTE (:30). Sortable all; default newest first (server). Single select. TYPE chip OUT red / IN green.
  - Row click: select; double-click → Client 360 of that leg's account; Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<account number>" (disabled) / separator / Open client 360 / Use as FROM account / Use as TO account (all enabled) (:32).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no transfers yet".
- No KPI strip. Loading "loading…" + veil on nav.

## Issues
[money] TRX · Server allows transfers between accounts of different clients; only the backoffice preview (comparing e-mails) blocks it, while telling the user the server refuses · transfers/route.ts:77-95, TransfersScreen.cs:70
[money] TRX · Transfer checks only FROM balance ≥ amount; no free-margin / open-position check · transfers/route.ts:100-102
[money] TRX · Balance-moving transfer has no maker-checker (adjust-balance does for MANAGER) · transfers/route.ts:45-152, lib/balance-adjustment.ts:40-42
[functional] TRX · Preview uses the account list cached at the last nav refresh; no live topic or poll, so balances/status can be stale · TransfersScreen.cs:44-52,60-80
[functional] TRX · A failed accounts fetch is silent; every preview then reports "account not found" · TransfersScreen.cs:50,66
[functional] TRX · FocusRecord only fills FROM when the account list is already loaded (no pending focus) · TransfersScreen.cs:59
[ux] TRX · TRANSFER confirm is not marked danger although it moves money · TransfersScreen.cs:85
[text] TRX · "accounts belong to different clients (server refuses)" is false · TransfersScreen.cs:70
[text] TRX · "LAST 200" / "<n> LEGS" = 100 transfers · TransfersScreen.cs:40,57, transfers/route.ts:30

## Status counts
STATUS-COUNTS app=backoffice screen=TRX WORKS=7 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-WAL.md ===== -->

# bo-WAL · Wallets (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\WalletsLeadsScreens.cs:16-76 (WalletsScreen, WAL). Nav: FINANCE › "Wallets" (ShellViewModel.cs:83).

## A. Purpose + panels
Read-only list of every account's balance and credit, joined with live equity / free margin / floating P/L from the margin snapshot; totals in the header.
One panel: 1) WAL "WALLETS · ACCOUNT BALANCES" (:34).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) WAL | GET /api/manage/accounts + GET /api/manage/margin + GET /api/manage/positions | FetchManageAccountsAsync ApiClient.ManageG1.cs:152; FetchMarginAsync :223; FetchManagePositionsAsync :224 | app/api/manage/accounts/route.ts:21-80 (broker's accounts); margin/route.ts:10-43 (accounts WITH open positions only, lib/margin.ts:34); positions/route.ts:47 | live topics position, account; poll 15 s (:21-22); ticks ≤1/s re-price equity / free / P/L (LiveMath.Reprice :49-55) | chips ALL / LIVE / DEMO / WITH CREDIT / NEGATIVE; search "account · client" on number / name (:58-63); column sort | none | "no accounts"; error → Status (accounts failure only; margin failure silently shows "—") |
Role: MANAGER, BROKER_ADMIN (accounts/route.ts:15, margin/route.ts:12).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Chips ALL / LIVE / DEMO / WITH CREDIT / NEGATIVE | filter bar | always | always | none (client :58, :62) | — | — | no | — | — | rows filtered | WORKS |
| Search box "account · client" | filter bar | always | always | none (client :33, :63) | — | — | no | — | — | rows filtered | WORKS |
| Row double-click | table | row | always | Shell.Open("CLI", accountId) (:31) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Open client 360 (credit / debit · leverage · risk limits)" | row menu | always | always | Shell.Open("CLI", id) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure" | row menu | always | row source present | Shell.Open("EXP", accountNumber) | — | — | no | — | — | EXP filtered (LiveExposureScreen.cs:109-113) | WORKS |
| Right-click → "Deposits · withdrawals" | row menu | always | row source present | Shell.Open("DEP", accountNumber) | — | — | no | — | — | DEP focused (FundsScreen.cs:91-94) | WORKS |
| Right-click → "Internal transfer" | row menu | always | row source present | Shell.Open("TRX", accountNumber) | — | — | no | — | — | TRX with From prefilled (TransfersScreen.cs:59) | WORKS |

## D. Dialogs
None.

## E. Text
- EQUITY / FREE MARGIN / FLOATING P/L show "—" for every account without open positions (:70-71) although equity = balance + credit there; the header total uses balance + credit for the same accounts (:74) — table and header disagree in method.
- Header "<n> ACCOUNTS · LIVE BALANCE … · CREDIT … · EQUITY …" sums LIVE accounts of the current filter only (:73-74), while "<n> ACCOUNTS" counts all filtered rows.
- Column "ACCOUNT MODE" width 56 (:29) for values LIVE / DEMO; header text wider than the column.
- Summary (:16-17) "Search on the filter strip" — accurate.

## F. UI structure map
Layout: one panel. Header: "1) WAL" · "WALLETS · ACCOUNT BALANCES"; header-right: stat "<n> ACCOUNTS · LIVE BALANCE <x> · CREDIT <x> · EQUITY <x>", Status. Filter bar: chips ALL (default) · LIVE · DEMO · WITH CREDIT · NEGATIVE (balance < 0), then search box. No KPI, no toolbar buttons.
Table (layout "wallets"): ACCOUNT · CLIENT · ACCOUNT MODE · CURRENCY · BALANCE · CREDIT · EQUITY · FREE MARGIN · FLOATING PROFIT / LOSS · STATUS (:28-30). ACCOUNT MODE chip LIVE/DEMO; STATUS chip. Sortable headers, no default sort (server order). Single select. Row click: select; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360 (credit / debit · leverage · risk limits)" / "Live exposure" / "Deposits · withdrawals" / "Internal transfer" (:32).
Right-click empty area: NO. Header: column picker. Empty: "no accounts".

## Issues
- [ux] WAL · accounts without open positions show EQUITY/FREE MARGIN "—" while the header computes their equity as balance + credit · WalletsLeadsScreens.cs:70-74; lib/margin.ts:34
- [ux] WAL · a failed GET margin is not reported; equity columns silently become "—" · WalletsLeadsScreens.cs:43-44
- [text] WAL · header mixes "<n> ACCOUNTS" (all filtered) with LIVE-only money totals without saying so · WalletsLeadsScreens.cs:73-74

## Status counts
STATUS-COUNTS app=backoffice screen=WAL WORKS=6 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-USR.md ===== -->

# bo-USR — Team (staff, roles, delegated permissions) (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\TeamScreen.cs (267 lines); right column CFG panel = BrokerSettingsPanel (SettingsScreen.cs:22-113, audited in bo-CFG.md). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Broker staff list, invite (create) a staff member, disable / re-activate, delegate MANAGER extra permissions.
Panels: left "1) USR · STAFF · ROLES" containing the staff table and, below it, "2) PERM · ROLE MATRIX"; right column (380 px) swaps between "3) CFG · BROKER SETTINGS" (default), "3) EDIT · STAFF MEMBER" and "3) INVITE · ADD STAFF" (TeamScreen.cs:44-51,149-215).

## Roles that exist (web)
prisma/schema.prisma:57-66 enum AdminRole: SUPER_ADMIN (VyXTechnologies staff, brokerId null), BROKER_ADMIN (full broker backoffice), SUPPORT (broker-scoped, "restricted"), MANAGER (dealing desk, narrower than BROKER_ADMIN). No other admin role type exists.
DEALER role: NO. AdminRole has no DEALER value; "DEALER" appears in schema.prisma only inside comments (lines 1786, 1887). The dealing desk runs as MANAGER (schema.prisma:61-65). Delegation is by extraPermissions on MANAGER only: KYC_REVIEW, RISK_SETTINGS, EMERGENCY_CONTROLS, INTERNAL_TRANSFERS, FUNDS_APPROVAL, IB_PAYOUTS, ACCOUNT_FINANCE, MIRROR_MANAGE (lib/permission-labels.ts:11-20; checked per request by lib/permissions.ts:15-21).
Creatable from this screen: BROKER_ADMIN, MANAGER, SUPPORT (app/api/manage/admins/route.ts:44; TeamScreen.cs:31).
SUPPORT in practice: can pass POST /api/manage/login (app/api/manage/login/route.ts:59) but no /api/manage/* data route admits SUPPORT (every gate is MANAGER/BROKER_ADMIN or BROKER_ADMIN; e.g. shell-info/route.ts:17). The native sign-in then fails at shell-info: "Signed in, but the backoffice info could not be loaded: not allowed for this role." (BackofficeSession.cs:54-55).

## B. Data
| Read | ApiClient | Route | Gate |
|---|---|---|---|
| GET /api/manage/admins | FetchAdminsAsync ApiClient.ManageG4.cs:77 | app/api/manage/admins/route.ts:18 | BROKER_ADMIN only (route.ts:10-16) |
| GET /api/manage/settings (right column) | FetchSettingsAsync ManageG4.cs:96 | app/api/manage/settings/route.ts:17 | BROKER_ADMIN only |
Admins: every AdminUser of the broker, createdAt desc, with currentAdminId (route.ts:24-41). No limit. Table height fits up to 20 rows then scrolls (TeamScreen.cs:62).
Refresh: no live topics, no poll; on nav (>10 s) and after each write. MANAGER: header status "not allowed for this role", table empty "no staff yet" (TeamScreen.cs:58).
Header stat "{n} USERS · 3 ROLES" (:81).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + INVITE (primary) | panel 1 header (:49) | always | always | none | none | - | no | no | none (server gate on CREATE) | right column -> invite form | WORKS |
| Empty-area ctx "Invite a team member…" | staff table blank area (:39) | always | always | none | none | - | no | no | none | invite form | DUPLICATE (+ INVITE :49) |
| Invite role chips ADMIN · MANAGER · SUPPORT | invite form (:200-202) | invite open | always | none | none | - | no | no | none | chip lit; default SUPPORT | WORKS |
| CREATE (primary) | invite form (:211,223-236) | invite open | always | CreateAdminAsync ManageG4.cs:87 -> POST /api/manage/admins {email, password, role} | AdminUser insert (bcrypt hash, status ACTIVE) + AuditLog ADMIN_USER_CREATED (admins/route.ts:65-83). No notification, no e-mail | client: contains "@" and length ≥5, not already on the team (:225-226); server: email+role required, password ≥8, 409 duplicate (route.ts:58-63,87-89) | yes ("ADD STAFF MEMBER"), then "INITIAL PASSWORD · SHOWN ONCE" | no | BROKER_ADMIN | toast "{email} added as {ROLE}", right column back to CFG | PARTIAL (default role SUPPORT creates a login that cannot open the backoffice) |
| CANCEL | invite form (:211) | invite open | always | none | none | - | no | no | none | right column CFG | DUPLICATE (BACK TO CFG :213) |
| BACK TO CFG | EDIT and INVITE headers (:180,213) | member/invite open | always | none | none | - | no | no | none | right column CFG | WORKS |
| Staff row click | staff table (:40) | row | always | none | none | - | no | no | none | selects; matrix adds the manager's column | WORKS |
| Staff row double-click | staff table (:41) | row | always | none | none | - | no | no | none | right column -> member editor | WORKS |
| ACTIONS cell double-click | staff table (:42) | row | always | none | none | - | no | no | none | member editor | DUPLICATE (row double-click :41) |
| Ctx "Edit…" | staff row menu (:242) | row | always | none | none | - | no | no | none | member editor | DUPLICATE (row double-click :41) |
| DISABLE ACCESS (danger) | member editor ACCESS (:176,182-189) | selected ACTIVE and not self | always | SetAdminStatusAsync ManageG4.cs:90 -> PATCH /api/manage/admins/{id} {status:"DISABLED"} | AdminUser.status=DISABLED + AuditLog ADMIN_USER_STATUS_CHANGED (admins/[id]/route.ts:56-73); that admin's next request is rejected and its sessions revoked (lib/auth.ts:276-285) | server: not self (400), same broker (404) | yes, type tenant name (Screen.cs:110-115) | no | BROKER_ADMIN | toast "{email} · disabled", refetch | WORKS |
| RE-ACTIVATE (primary) | member editor ACCESS (:177,190-195) | selected DISABLED and not self | always | same PATCH {status:"ACTIVE"} | AdminUser.status=ACTIVE + audit | same | yes ("ACTIVATE") | no | BROKER_ADMIN | toast "{email} · active" | WORKS |
| Ctx "Disable access…" / "Re-activate…" | staff row menu (:243) | row | not self | same | same | same | same | no | same | same | DUPLICATE (member editor :176-177) |
| Matrix cell click (selected manager's column) | 2) PERM grid (:97-99,129-135) | selected is MANAGER | always | none (stages) | none | - | no | no | none | cell toggles ●/·; SAVE + REVERT appear | WORKS |
| Permission toggles (8) | member editor DELEGATED PERMISSIONS (:165) | selected is MANAGER | always | none (stages) | none | - | no | no | none | same staging | DUPLICATE (matrix cell :99) |
| SAVE (primary) | 2) PERM header right (:103,136-146) | staged set differs | always | SetAdminPermissionsAsync ManageG4.cs:93 -> PATCH /api/manage/admins/{id} {extraPermissions[]} | AdminUser.extraPermissions replaced (deduped) + AuditLog PERMISSIONS_CHANGED old/new (admins/[id]/route.ts:37-43,74-85); read fresh on every request by lib/permissions.ts:15-21 | server: values must be in PERMISSIONS, target must be MANAGER (route.ts:39-54) | yes ("DELEGATE PERMISSIONS") | no | BROKER_ADMIN | toast "{email} · {n} delegated" | WORKS |
| SAVE PERMISSIONS (primary) | member editor (:168) | staged differs | always | same | same | same | yes | no | same | same | DUPLICATE (matrix SAVE :103) |
| REVERT | 2) PERM header right (:103) | staged differs | always | none | none | - | no | no | none | staging dropped | WORKS |
| REVERT | member editor (:168) | staged differs | always | none | none | - | no | no | none | same | DUPLICATE (matrix REVERT :103) |
| ACTIONS cell words "DISABLE" / "ACTIVATE" | staff table ACTIONS (:78) | non-self rows | - | none (single click only selects the row) | none | - | - | - | - | nothing | UI-ONLY |
| "2FA · devices · IPs — not available yet" | member editor (:160) | member open | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "PASSWORD RESET · ROLE CHANGE — not available yet" | member editor (:179) | member open | - | none | none | - | - | - | - | - | PLACEHOLDER |
| Right column BROKER SETTINGS SAVE | 3) CFG panel (SettingsScreen.cs:29) | CFG mode | always | see bo-CFG.md | see bo-CFG.md | | yes | no | BROKER_ADMIN | | DUPLICATE (CFG screen, bo-CFG.md) |
| Column header click / right-click | staff table (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

## D. Dialogs
Invite form (right column, not a modal; :197-215):
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| e-mail | text (300 px) | "" | AdminUser.email (lower-cased server-side, admins/route.ts:54) | app/api/manage/login/route.ts (lookup); admin/forgot-password | - |
| ROLE | chips ADMIN / MANAGER / SUPPORT | SUPPORT | AdminUser.role | lib/auth.ts requireAdminRole (every route gate), lib/auth.ts:280 live check | - |
| (password) | generated, 16 chars (:216-222), not editable | random | AdminUser.passwordHash (bcrypt, route.ts:65) | manage/login | shown once in "INITIAL PASSWORD · SHOWN ONCE" |
Delegated permissions (matrix / member toggles): 8 booleans -> AdminUser.extraPermissions; READ BY lib/permissions.ts:15-21 and getPermissionContext (:66-) on each gated route (funds, KYC, risk, emergency, IB, transfers, account finance, mirror).
Confirms: ADD STAFF MEMBER ("Create {email} as {ROLE}? The password is shown once."), DISABLE STAFF ACCESS (typed tenant name), RE-ACTIVATE STAFF ACCESS, DELEGATE PERMISSIONS ("{email} (MANAGER) gets: {labels}?").

## E. Text
- Column "LAST ACTIVE" shows lastLoginAt (last sign-in), not last activity (:37,77; admins/route.ts:37).
- Header stat "3 ROLES" counts only creatable roles; SUPER_ADMIN exists too (:81).
- Matrix note "ADMIN: all · MANAGER: per user (n/N) · SUPPORT: none" (:105): SUPPORT has not just no delegable permissions but no usable backoffice access at all.
- Role label "ADMIN" for BROKER_ADMIN here (:70) vs "BROKER ADMIN" in the shell ROLE cell (MainWindow.axaml.cs:108).
- Invite note "Shown once after CREATE. Send it securely." (:208) — the password is not shown in the form before CREATE.
- Class doc mentions "Desk · 2FA · IP allowlist · actions/24h and custom roles" (:23-24); only "2FA · devices · IPs" is rendered.

## F. UI structure map
Layout: PageGrid columns * / 380. Left panel "1) USR  STAFF · ROLES"; header right in order: stat "{n} USERS · 3 ROLES", + INVITE (primary/orange), status text. No filter bar, no search.
Left body (stack): staff table, then "2) PERM  ROLE MATRIX" header (right: hint "SELECT A MANAGER TO DELEGATE" / "CLICK A CELL IN {NAME} TO STAGE" / "{ROLE} · NOTHING TO DELEGATE", plus SAVE (primary) and REVERT when staged), note line, matrix grid.
Staff table columns: USER | ROLE | LAST ACTIVE | STATUS | ACTIONS. Sortable all; default createdAt desc (server). Single selection; no checkbox. Click = select; double-click = member editor; Enter: nothing. Per-row: USER suffix " (you)"; ROLE orange for ADMIN; STATUS chip ACTIVE (green) / DISABLED (red); ACTIONS "LOCKED" (self, grey) or "EDIT   DISABLE" / "EDIT   ACTIVATE" (orange text, no separate hit targets).
Right-click on row: YES — header = e-mail (disabled), separator, "Edit…", "Disable access…" or "Re-activate…" (disabled on your own row).
Right-click on empty table area: YES — header "STAFF · ROLES", separator, "Invite a team member…". Multi-selection: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Matrix: columns PERMISSION | ADMIN | MANAGER | SUPPORT [| {selected manager, first 9 chars of e-mail local part}]. Rows: KYC review · Risk settings · Emergency controls · Internal transfers · Funds approval · IB payouts · Account finance · Reverse mirror rules. Cells: ADMIN "●"; MANAGER "n/m"; SUPPORT "·"; manager column "●"/"·" clickable.
Right column modes: (a) "3) CFG  BROKER SETTINGS" (default, see bo-CFG.md). (b) "3) EDIT  STAFF MEMBER" header right BACK TO CFG; rows e-mail · role · status · last sign-in · created · 2FA · devices · IPs "not available yet"; section DELEGATED PERMISSIONS (8 toggles + SAVE PERMISSIONS/REVERT or hint "click to stage · SAVE"; for non-managers "ADMIN · FULL ACCESS" or "SUPPORT · NONE DELEGABLE" / "extra permissions apply to MANAGER only"); section ACCESS (DISABLE ACCESS danger / RE-ACTIVATE primary / "your own row"); block "PASSWORD RESET · ROLE CHANGE" "not available yet". (c) "3) INVITE  ADD STAFF" header right BACK TO CFG; section NEW STAFF MEMBER; e-mail box; ROLE chips ADMIN · MANAGER · SUPPORT (SUPPORT lit); note; CREATE (primary) · CANCEL.
Empty: "no staff yet". Loading: page veil. Error: header status.

## Issues
[functional] USR · SUPPORT is the default invite role, but SUPPORT is admitted by no /api/manage data route (not even shell-info), so the new staff member cannot open the backoffice at all · TeamScreen.cs:200; app/api/manage/login/route.ts:59; app/api/manage/shell-info/route.ts:17; BackofficeSession.cs:54-55
[functional] USR · USR (and CFG) are in every role's nav, but admins/settings endpoints are BROKER_ADMIN-only; a MANAGER sees "not allowed for this role" · app/api/manage/admins/route.ts:10-16; ShellViewModel.cs:85
[functional] USR · no way to reset a staff password or change a role from the broker side; the only reset endpoint is SUPER_ADMIN-only, while ADMIN_PASSWORD_RESET_REQUESTED notifications deep-link here · TeamScreen.cs:179; app/api/admin/admins/[id]/reset-password/route.ts:13; NotificationsAuditScreens.cs:107
[ux] USR · ACTIONS column shows "DISABLE" / "ACTIVATE" as if clickable; single click only selects, the action needs the editor or the context menu · TeamScreen.cs:78
[text] USR · "LAST ACTIVE" is last sign-in time · TeamScreen.cs:37,77; app/api/manage/admins/route.ts:37
[text] USR · role naming "ADMIN" (USR) vs "BROKER ADMIN" (shell) vs BROKER_ADMIN (server) · TeamScreen.cs:70; MainWindow.axaml.cs:108

## Status counts
STATUS-COUNTS app=backoffice screen=USR WORKS=12 PARTIAL=1 UI-ONLY=1 PLACEHOLDER=2 DEAD=0 DUPLICATE=9


<!-- ===== bo-AUD.md ===== -->

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


<!-- ===== bo-SEC.md ===== -->

# bo-SEC — Security (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:17-78 (class SecurityScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Facts about the current sign-in, a staff password-reset request, sign out; a list of account-security features marked "not available yet".
Panels: "1) ME · THIS SIGN-IN" (left, *) and "2) SEC · ACCOUNT SECURITY" (right, *) (SecurityEmergencyScreens.cs:27-29).

## B. Data
No fetch. RefreshAsync only re-renders from the local session (:32-37): Session.AdminEmail / Role / Host / SignedInAtUtc / TwoFactorUsed (BackofficeSession.cs:20-27) and Session.Shell (shell-info captured at sign-in or resume).
The code comment "shell-info is already on the session (refreshed by the badge timer)" (:34) is not what happens: the badge timer calls Api.FetchShellInfoAsync directly and only copies the unread count (MainWindow.axaml.cs:196,206-211); BackofficeSession.RefreshShellAsync (BackofficeSession.cs:75-79) has no caller. "broker" and "finance rights" are therefore the values from sign-in time.
"2FA challenged this sign-in" and "Enrolment" both come from Session.TwoFactorUsed, which is true only when this session went through POST /api/manage/login/verify-2fa (BackofficeSession.cs:48) and is forced false on a remember-me resume (BackofficeSession.cs:68).
Refresh: on nav only. Empty/error: none (all rows always render; "—" for missing).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQUEST PASSWORD RESET (danger; tooltip "Files a reset request with staff. Nothing changes until they act.") | panel 1 actions (:52,69-77) | always | always | ManageForgotPasswordAsync ApiClient.Manage.cs:59 -> POST /api/admin/forgot-password {email, note} | rate limit 3/h per e-mail, silently "ok" when exceeded (forgot-password/route.ts:19-22); for a MANAGER/BROKER_ADMIN (any status) with a brokerId: Notification type ADMIN_PASSWORD_RESET_REQUESTED, entityType AdminUser (route.ts:28-38). Nothing for SUPPORT. No audit | note optional, server trims to 500 | yes, danger, optional input "NOTE FOR STAFF (optional)" | no | none (pre-auth route) | toast "reset request filed with the staff" | PARTIAL (lands in the broker staff inbox, where no staff-password reset exists; only SUPER_ADMIN can reset, app/api/admin/admins/[id]/reset-password/route.ts:13; SUPPORT requests are dropped silently) |
| SIGN OUT | panel 1 actions (:53) | always | always | Shell.SignOut (MainWindow.axaml.cs:305-308) | none on server (see bo-SHELL.md) | - | yes ("SIGN OUT") | no | none | back to sign-in window | DUPLICATE (shell USER menu "Sign out", MainWindow.axaml.cs:300) |
| "Enrol · reset · backup codes — not available yet" | 2) TWO-FACTOR (:59) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (endpoints exist: /api/admin/two-factor/status, setup, confirm, disable admit MANAGER/BROKER_ADMIN/SUPPORT — two-factor/status/route.ts:16, setup/route.ts:30) |
| "Registered keys — not available yet" | 2) PASSKEYS · HARDWARE KEYS (:60) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Other devices — not available yet" | 2) ACTIVE SESSIONS (:61) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (GET /api/admin/sessions exists, self-service for every admin role, app/api/admin/sessions/route.ts:6-10) |
| "Sign out everywhere — not available yet" | 2) ACTIVE SESSIONS (:61) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (DELETE /api/admin/sessions/{id} exists, sessions/[id]/route.ts:11-18) |
| "Personal tokens — not available yet" | 2) API KEYS (:62) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Allowed addresses — not available yet" | 2) IP ALLOWLIST (:63) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Staff 2FA mandatory — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.requireAdmin2fa exists, schema.prisma:325-331; no API writes it) |
| "Session timeout — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Password rotation — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |

## D. Dialogs
REQUEST PASSWORD RESET confirm (danger): text "Request a password reset for {email}?", button REQUEST, one field:
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| NOTE FOR STAFF (optional) | text, max 500 (ConfirmOverlay.axaml:17) | "" | Notification.body ("{email}: {note}") (forgot-password/route.ts:34) | app/api/manage/notifications (broker staff NTF), app/api/admin/notifications/route.ts:18 (Super Admin, by type) | - |
SIGN OUT confirm: "Return to sign-in?", button SIGN OUT, no fields.

## E. Text
- "2FA is not enrolled on this admin, or not required." / "Enrolment NOT ENROLLED" (:49,58) are derived from whether this session was challenged, not from the enrolment flag; after a remember-me resume an enrolled admin reads "NOT ENROLLED".
- Tooltip "Files a reset request with staff. Nothing changes until they act." (:52) and toast "reset request filed with the staff" (:75): the broker's staff cannot reset a staff password; the actor is VyX Super Admin.
- "session COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY" (:48): sign-out does not end the server session (bo-SHELL.md).
- Class doc: "The server has no security endpoints for an admin's own account" (:17-18) and BackofficeSession.cs:24-25 "there is no endpoint to read or change an admin's 2FA enrolment" — both contradicted by /api/admin/two-factor/* and /api/admin/sessions.
- Closing note "Not available yet." (:65) repeats the per-row text.

## F. UI structure map
Layout: PageGrid columns * / * (two equal halves). No filter bars, no tables.
Left "1) ME  THIS SIGN-IN" (header right: status text). Rows: signed in as · role (orange) · tenant · broker · since ("yyyy-MM-dd HH:mm UTC") · 2FA challenged this sign-in ("YES · AUTHENTICATOR CODE" green / "NO" amber) · finance rights (YES/NO) · session ("COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY"); explanatory sentence; buttons in order: REQUEST PASSWORD RESET (danger red text, tooltip) · SIGN OUT (plain).
Right "2) SEC  ACCOUNT SECURITY": sections in order TWO-FACTOR (Enrolment; Enrol · reset · backup codes) · PASSKEYS · HARDWARE KEYS (Registered keys) · ACTIVE SESSIONS (Other devices; Sign out everywhere) · API KEYS (Personal tokens) · IP ALLOWLIST (Allowed addresses) · ORG POLICY (Staff 2FA mandatory; Session timeout; Password rotation); every value "not available yet" except Enrolment; footer "Not available yet.".
Right-click anywhere: NO context menus on this screen. No primary (orange) button.
Loading: page veil on nav (no data fetched). Error: none.

## Issues
[functional] SEC · Broker.requireAdmin2fa (staff 2FA mandatory) is enforced only by the web manage shell layout; the native backoffice login and getAdminSession do not check it, so a broker that requires staff 2FA is not protected in the desktop app · app/manage/(shell)/layout.tsx:46; lib/auth.ts:288-296,327-332; app/api/manage/login/route.ts (no reference)
[functional] SEC · 2FA enrol/reset and session list/revoke endpoints exist for every admin role but the screen shows them as "not available yet" · app/api/admin/two-factor/status/route.ts:16; app/api/admin/two-factor/setup/route.ts:30; app/api/admin/sessions/route.ts:6-10; SecurityEmergencyScreens.cs:59-61
[functional] SEC · "Enrolment" / "2FA challenged" read from this session only; an enrolled admin who resumed a remembered session is shown NOT ENROLLED · SecurityEmergencyScreens.cs:46,58; BackofficeSession.cs:68
[functional] SEC · REQUEST PASSWORD RESET notifies broker staff who have no way to reset a staff password; SUPPORT requests are dropped silently; rate-limited requests return success · app/api/admin/forgot-password/route.ts:19-38; TeamScreen.cs:179
[functional] SEC · "broker" and "finance rights" are frozen at sign-in: Session.Shell is never refreshed (RefreshShellAsync has no caller) · BackofficeSession.cs:75-79; MainWindow.axaml.cs:196-211
[text] SEC · session row says the cookie session "ENDS ON SIGN OUT" but sign-out does not revoke the server session · SecurityEmergencyScreens.cs:48; ApiClient.Manage.cs:100-110; app/api/admin/logout/route.ts:8-12

## Status counts
STATUS-COUNTS app=backoffice screen=SEC WORKS=0 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=9 DEAD=0 DUPLICATE=1


<!-- ===== bo-CFG.md ===== -->

# bo-CFG — Settings (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs (155 lines): SettingsScreen (:115-155) + BrokerSettingsPanel (:16-113, also hosted in the USR right column). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Tenant facts and the two writable broker defaults (default account leverage, default account currency); every other setting row is a link elsewhere or "not available yet".
Panels: "1) TENANT · THIS BROKER" (left, *) and "3) CFG · BROKER SETTINGS" (right, 520 px) (SettingsScreen.cs:124-125).

## B. Data
GET /api/manage/settings — FetchSettingsAsync ApiClient.ManageG4.cs:96 -> app/api/manage/settings/route.ts:17. Gate BROKER_ADMIN only (route.ts:6-12). Returns name, subdomain, customDomain, tier, status, defaultAccountCurrency, defaultAccountLeverage (route.ts:23-32).
Also shown: Session.Host / AdminEmail / Role and Session.Shell (shell-info from sign-in: brokerPrimaryColor, theme, unreadNotifications, canManageFinance). Session.Shell is not refreshed after sign-in (BackofficeSession.RefreshShellAsync has no caller, BackofficeSession.cs:75-79), so "Unread notifications" and "Finance rights" are sign-in-time values.
Refresh: no live topics, no poll; on nav (>10 s) and after SAVE (:109).
Empty/error: right panel "LOADING SETTINGS…" until loaded (:32); "SETTINGS UNAVAILABLE" + reason on error (:93); left "LOADING…" (:126) and header status text; MANAGER gets "not allowed for this role".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SAVE (primary) | 3) CFG header right (:29-30,95-112) | always | always (no-op until loaded; toast "nothing changed" when equal) | SaveSettingsAsync ManageG4.cs:102 -> PATCH /api/manage/settings {defaultAccountCurrency?, defaultAccountLeverage?} (only changed keys) | Broker.defaultAccountCurrency / defaultAccountLeverage updated (settings/route.ts:75). No AuditLog, no notification | client: leverage via LeverageInput ("1:" prefix stripped, :98-100), currency 3 letters A-Z (:101); server: currency must be USD (route.ts:52-60), leverage parseLeverage (route.ts:63-69), 400 "nothing to update" | yes ("SAVE BROKER SETTINGS", lists old → new) | no | BROKER_ADMIN | toast "settings saved", refetch | PARTIAL (change is not audited; the currency box accepts any 3 letters but only USD is accepted by the server) |
| Link "PER GROUP · GRP" (Margin call) | 3) CFG TRADING (:49) | loaded | always | Shell.Navigate("GRP") | none | - | no | no | none | GRP screen | WORKS |
| Link "PER GROUP · GRP" (Stop-out) | 3) CFG TRADING (:50) | loaded | always | same | none | - | no | no | none | GRP | DUPLICATE (Margin call link :49) |
| Link "PER METHOD · PSP" (Min deposit) | 3) CFG FUNDING (:55) | loaded | always | Shell.Navigate("PSP") | none | - | no | no | none | PSP screen | WORKS |
| "Negative balance protection — not available yet" | TRADING (:51) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.negativeBalanceProtection exists, default true, read by lib/position-close.ts; schema.prisma:405-411; no API reads/writes it) |
| "Hedging allowed — not available yet" | TRADING (:52) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Max slippage — not available yet" | TRADING (:53) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.defaultMaxSlippagePips is readable/writable via GET/PATCH /api/manage/risk, risk/route.ts:38,73, and edited on DEAL, DealingScreen.cs:448-460) |
| "Withdrawal auto-approve ≤ — not available yet" | FUNDING (:56) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Require KYC L1 to deposit — not available yet" | FUNDING (:57) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Require KYC L2 above — not available yet" | FUNDING (:58) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Staff 2FA mandatory — not available yet" | SECURITY (:67) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.requireAdmin2fa exists, schema.prisma:325-331; no API writes it) |
| "Session timeout — not available yet" | SECURITY (:68) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Audit retention — not available yet" | SECURITY (:69) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |

## D. Dialogs
Inline form fields (right panel), saved by SAVE through the confirm "SAVE BROKER SETTINGS" ("default leverage 1:{old} → 1:{new}; default currency {old} → {new}. New accounts get these defaults; existing accounts keep theirs."):
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| Default leverage | text box (90 px) behind a "1:" label | server value | Broker.defaultAccountLeverage | app/api/manage/accounts/route.ts:269 and live-account-requests/[id]/route.ts:103 and portal/accounts/route.ts:119 — only when the new account gets no group and the broker has no default group (group leverage wins, accounts/route.ts:259-269) | - |
| Default account currency | text box (90 px) | server value | Broker.defaultAccountCurrency | accounts/route.ts:170 (when no currency given), live-account-requests/[id]/route.ts:102, portal/accounts/route.ts:118 | - |
Read-only rows: Broker (settings.name), Domain (customDomain or subdomain), Tier · status, Accent (shell-info brokerPrimaryColor), Terminal theme (shell-info theme), Desktop build ("v{AppVersion} · AVALONIA", :65).

## E. Text
- "Terminal theme" row (:64) shows shell-info `theme`, which is the signed-in admin's own backoffice light/dark preference (AdminUser.theme, shell-info/route.ts:23,41), not the terminal's theme.
- Confirm text "New accounts get these defaults" (:106): leverage only applies when the new account has no group and no default group exists.
- Note under the form: "Default leverage and currency" (:70) — a fragment with no verb.
- Left note "Broker defaults · pricing: GRP / SYM · deposit limits: PSP" (:152).
- "Max slippage", "Negative balance protection", "Staff 2FA mandatory" say "not available yet" although the broker settings exist (see C).
- Panel code "3) CFG" on a screen whose other panel is "1) TENANT" (no panel 2) (:30,124).

## F. UI structure map
Layout: PageGrid columns * / 520.
Left "1) TENANT  THIS BROKER" (header right: status text). Rows: Broker · Host · Subdomain · Custom domain ("none" dim) · Tier · Status (green when ACTIVE, amber otherwise) · Default account currency · Default account leverage ("1:{n}"); section SIGNED IN: Admin · Role (orange) · Unread notifications · Finance rights (YES/NO); note line.
Right "3) CFG  BROKER SETTINGS" (header right: SAVE primary/orange). Sections in order:
- TRADING: Default leverage ["1:" + box] · Default account currency [box] · Margin call [link PER GROUP · GRP] · Stop-out [link PER GROUP · GRP] · Negative balance protection · Hedging allowed · Max slippage (each "not available yet")
- FUNDING: Min deposit [link PER METHOD · PSP] · Withdrawal auto-approve ≤ · Require KYC L1 to deposit · Require KYC L2 above ("not available yet")
- BRANDING · TENANT: Broker · Domain · Tier · status · Accent · Terminal theme · Desktop build
- SECURITY: Staff 2FA mandatory · Session timeout · Audit retention ("not available yet")
- note "Default leverage and currency".
Tables: none. Right-click: NO context menus anywhere on this screen. Dropdowns: none (the fixture shows "1:100 ▾" selectors, harness only, :79-81).
Loading: "LOADING SETTINGS…" / "LOADING…" and page veil. Error: "SETTINGS UNAVAILABLE" + reason; header status.

## Issues
[functional] CFG · broker default leverage / currency changes write no AuditLog row · app/api/manage/settings/route.ts:75
[functional] CFG · "Negative balance protection: not available yet" hides a live broker setting (Broker.negativeBalanceProtection, default true, applied on every stop-out close) that no screen can show or change · SettingsScreen.cs:51; prisma/schema.prisma:405-411; lib/position-close.ts
[functional] CFG · "Max slippage: not available yet" although Broker.defaultMaxSlippagePips is live and edited on DEAL · SettingsScreen.cs:53; app/api/manage/risk/route.ts:38,73; DealingScreen.cs:448-460
[functional] CFG · "Staff 2FA mandatory: not available yet" while Broker.requireAdmin2fa exists (web-enforced only, no API to set it) · SettingsScreen.cs:67; prisma/schema.prisma:325-331
[functional] CFG · currency box accepts any 3-letter code; the server refuses anything but USD · SettingsScreen.cs:101; app/api/manage/settings/route.ts:52-60
[functional] CFG · CFG is in every role's nav but GET/PATCH settings are BROKER_ADMIN-only · app/api/manage/settings/route.ts:6-12; ShellViewModel.cs:88
[functional] CFG · "Unread notifications" and "Finance rights" are sign-in-time values (Session.Shell never refreshed) · SettingsScreen.cs:150-151; BackofficeSession.cs:75-79
[text] CFG · "Terminal theme" shows the admin's own backoffice theme preference · SettingsScreen.cs:64; app/api/manage/shell-info/route.ts:41
[text] CFG · confirm says new accounts get the default leverage; it applies only when there is no group / default group · SettingsScreen.cs:106; app/api/manage/accounts/route.ts:259-269

## Status counts
STATUS-COUNTS app=backoffice screen=CFG WORKS=2 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=9 DEAD=0 DUPLICATE=1


<!-- ===== term-shell.md ===== -->

# term-shell — Trader Terminal shell (title bar / account strip / tape / status bar / layout)

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Web/API: D: main 74b3c02. Code-only audit, nothing launched.

## A. Purpose + panels
Main window of the trader terminal: own title bar (brand, symbol command line, account strip, theme, user menu, caption buttons), a scrolling price tape, a 3-column body, and a status bar with connection state, UTC clock, open sessions, update pill and F1–F12 cells.
Panels (MainWindow.axaml:20-60): row 0 TopBar (26 px fixture / 28 px live, MainViewModel.cs:79), row 1 Tape (22 px), row 2 body grid `330 | 1 | * | 1 | 268` (MainWindow.axaml:29), row 3 StatusBar (26 px).
Body: left column = 1) MW Market Watch over 5) ECO calendar (MainWindow.axaml:33-38); middle = 2) chart over positions dock (39-44); right = 3) order ticket over account panel (45-50). Market Watch, ECO and chart are in term-marketwatch.md / term-eco.md / term-chart.md.

## B. Data
| Element | Source | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| ACCOUNT number | sign-in account string | – | – | set once in GoLiveAsync (MarketDataService.cs:1050) |
| ACCOUNT mode (DEMO/LIVE) | `/me` `accountMode` | FetchAccountAsync ApiClient.cs:140 | app/api/trade/me/route.ts:16,42 | after every trading event (MarketDataService.cs:281), F7, order results; RefreshCommandBar MarketDataService.cs:1289-1300 |
| USER name + initials | `/me` `fullName` (fallback account number) | same | me/route.ts:22 | same (MarketDataService.cs:1294-1295; MainViewModel.cs:96-105) |
| EQUITY USD / MARGIN LVL | computed client-side: balance+credit from `/me` + live WS ticks, AccountMath.ComputeAccountSummary (MarketDataService.cs:1603-1604) | – | – | every tick of a symbol with an open position (MarketDataService.cs:2197-2198), every positions/history/account refresh |
| Brand (header + window title) | `/broker-branding` `brokerName` | FetchBrokerBrandingAsync ApiClient.cs:177 | broker-branding/route.ts:21 | once at sign-in (MarketDataService.cs:1056-1058) |
| Tape items | GridCandidates = watchlist then every other `/symbols` symbol (MarketDataService.cs:1100-1102, 1262-1274) | FetchWatchlistAsync ApiClient.cs:162; FetchAllSymbolsAsync ApiClient.cs:151 | watchlist/route.ts:6-16; symbols/route.ts:20-56 | rebuilt on each watchlist load |
| Tape price / CHG% | WS bid (OnTick MarketDataService.cs:2195); CHG% vs last D1 row open (1280-1285) | FetchCandlesAsync(sym,"D1") ApiClient.cs:197 | candles/route.ts:22-27 | live per tick; D1 cached 5 min (MarketDataService.cs:1389), fetched sequentially for every GridCandidate (1329-1339) |
| Connection text + dot | PriceStreamClient state, ping (MarketDataService.cs:224-237, 860-867) | FetchWsTicketAsync ApiClient.cs:227 | ws-ticket/route.ts | live |
| UTC clock / sessions | local clock, SessionClock (MarketDataService.cs:1237-1244) | – | – | 1 s timer |
| Update pill | Velopack static feed Brand.UpdateUrl (Services/UpdateService.cs:6; Vyx.Shared.Ui/UpdateService.cs:27-35) — not an app/api route | – | – | on IsLive + every 6 h (MainWindow.axaml.cs:255) |

Empty/loading/error: before sign-in the fixture literals show. If `/me` fails, RefreshCommandBar returns early (MarketDataService.cs:1291) and the live header keeps the fixture literals `A. KHAN`, `−8,096.37`, `DEMO` (MainViewModel.cs:34-38); if branding fails the header keeps `FUTURIX` (MainViewModel.cs:33). Connection cell shows `SIGNING IN…`, `CONNECTING…`, `RECONNECTING… (attempt n)`, `OFFLINE`, `SIGNED OUT` (MarketDataService.cs:861-866, 961, 1017).
No FX conversion anywhere in the terminal (grep `QuoteCurrency|conversionRate` in E:\vyxtrader\src = 0 hits); the server converts quote→account currency (lib/margin.ts:69-73) and `/symbols` does not send `quoteCurrency` (symbols/route.ts:33-56).

## C. Controls
Status convention: WORKS also covers controls that are local by design (Server effect says "local").

| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Command line `FXG> SYMBOL description` | TopBar col 1 (TopBar.axaml:22-28) | always | always | none: RouteFKey("F2") (MainWindow.axaml.cs:237, 305) | none | – | No | No | trader session | MW search box focused; action line `F2 · market watch search` | WORKS |
| THEME cell (`☀ LIGHT` / `☾ DARK`) | TopBar right (TopBar.axaml:100-105) | IsLive | always | none: ThemeService.Toggle(Settings) (MainWindow.axaml.cs:236) | local settings.json `Theme` | – | No | No | – | theme rebound, charts redrawn | WORKS |
| USER cell | TopBar right (TopBar.axaml:106-117) | always | always | opens menu (TopBar.axaml.cs:29-39) | none | – | No | No | – | menu | WORKS |
| Switch account… | USER menu | always | always | Market.SignOutAsync → POST /api/trade/logout (ApiClient.cs:130-133) | logout/route.ts:4-21: Redis session revoked, cookie deleted | – | Yes, always: `SWITCH ACCOUNT` / `Return to sign-in? Saved credential kept.` (MainWindow.axaml.cs:238) | No | – | process relaunched to sign-in (MainWindow.axaml.cs:692-694) | DUPLICATE (identical SignOutAsync(false) as "Sign out", MainWindow.axaml.cs:238 vs 243-244) |
| Sign out | USER menu | always | always | same as above | same | – | Yes: `SIGN OUT` / `Sign out? Saved credential kept.` | No | – | relaunch | WORKS |
| Sign out and forget this computer | USER menu | always | always | same + CredentialStore.Delete(host) and ("session:"+host), RememberMe=false (MainWindow.axaml.cs:691) | same + local credential removed | – | Yes: `SIGN OUT AND FORGET` / `Sign out and remove the saved credential from this PC?` | No | – | relaunch | WORKS |
| Minimise | caption (TopBar.axaml:120; CaptionButtons.axaml.cs:16) | IsLive | always | none | local | – | No | No | – | minimised | WORKS |
| Maximise / restore | caption (CaptionButtons.axaml.cs:17-23) | IsLive | always | none | local | – | No | No | – | toggled, glyph synced (WindowChrome.cs:32-34) | WORKS |
| Close ✕ | caption (CaptionButtons.axaml.cs:24) | IsLive | always | Window.Close → Market.Dispose (MainWindow.axaml.cs:288) | none; streams closed | – | No | No | – | app exits; client-side smart rules stop (the updater's own confirm says "armed smart rules will be off", MainWindow.axaml.cs:254) | PARTIAL (no confirm when smart rules are armed) |
| Title bar drag / double-click | TopBar background (WindowChrome.cs:24-31, attached MainWindow.axaml.cs:241-242) | always | not on UserCell/ThemeCell/CommandLine | none | local | – | No | No | – | move / maximise toggle | WORKS |
| Tape item click | Tape live strip (Tape.axaml:9; Tape.axaml.cs:37-40) | IsLive | always | SelectChartAsync → GET /api/trade/candles (ApiClient.cs:197-205) | read only | – | No | No | – | active chart switches symbol | WORKS |
| Tape hover | Tape viewport (Tape.axaml:27-28) | IsLive | always | none | local | – | No | No | – | marquee pauses | WORKS |
| 5 splitters (left, right, bottom mid, bottom left, bottom right) | body gap tracks (MainWindow.axaml:37,43,49,55,56) | always | always | none | local settings.json Layout* (MainWindow.axaml.cs:665-681); caps 300–560 / 268–420 / 120–520 (661-664) | min/max clamps | No | No | – | sizes persisted | WORKS |
| Update pill | status bar (StatusBar.axaml:22-25) | UpdateText non-empty (downloading / ready) | click acts only when ReadyToApply (MainWindow.axaml.cs:254) | Updater.ApplyAndRestart (Vyx.Shared.Ui/UpdateService.cs:67) | none (static feed) | – | Yes: `RESTART TO UPDATE` / `Restart into {ver}? Open positions are unaffected; armed smart rules will be off.` | No | – | restart | WORKS |
| F1 HELP | status bar cell + key (MainWindow.axaml.cs:258, 304) | IsLive (cells) | always | none | none | – | No | No | – | action line help text | PARTIAL (text says `F6 log`, F6 refreshes the calendar; omits F8/F9/F10/F12) |
| F2 WATCH | same (305) | IsLive | always | none | none | – | No | No | – | MW search focused | WORKS |
| F3 CHART | same (306) | IsLive | always | SetGridMode(false) | local | – | No | No | – | single chart | WORKS |
| F4 TICKET | same (307) | IsLive | always | none | none | – | No | No | – | ticket VolumeBox focused | WORKS |
| F5 POSITIONS | same (308) | IsLive | always | none | none | – | No | No | – | dock tab POS | WORKS |
| F6 NEWS | same (309) | IsLive | always | RefreshCalendarAsync → GET /api/trade/news (ApiClient.cs:167) | read only | – | No | No | – | ECO panel rebuilt | WORKS |
| F7 ACCOUNT | same (310) | IsLive | always | RefreshAccountAsync → GET /api/trade/me (ApiClient.cs:140) | read only | – | No | No | – | header + account panel recomputed | WORKS |
| F8 ALERTS | same (311) | IsLive | signed in (MainWindow.axaml.cs:438) | opens AlertsWindow (term-alerts.md) | – | – | No | No | – | modal | WORKS |
| F9 NEW ORDER | same (312) | IsLive | signed in (387) | opens NewOrderWindow | – | – | No | No | – | modal | WORKS |
| F10 REPORTS | same (313) | IsLive | always | none | none | – | No | No | – | action line `F10 · reports (coming soon)` | PLACEHOLDER |
| F11 LAYOUT | same (314) | IsLive | always | SetGridMode(!IsGridMode) | local | – | No | No | – | single ↔ 2×2 | WORKS |
| F12 SETTINGS | same (315) | IsLive | always | opens SettingsWindow | – | – | No | No | – | modal | WORKS |

## D. Dialogs
- Confirm overlay (shared ChartHost.Confirm, ChartHost.cs:262-278; ChartPanel.axaml:223-239): title, detail, optional note, optional checkbox `Don't ask again until the terminal is restarted` (ChartPanelViewModel.cs:276, shown only when a session key is passed — none of the shell actions pass one), CANCEL, action button. Nothing stored.
- USER menu: disabled header `{UserName} · {AccountNumber} {AccountMode}` (MainViewModel.cs:106), then items (see F). No fields.
- Settings (F12), New order (F9), Alerts (F8) dialogs are covered elsewhere (term-alerts.md; F9/F12 by the ticket/settings audits).

## E. Text
- `FXG> ` command prefix is a literal for every broker (TopBar.axaml:23).
- `EQUITY USD` label is a literal; the value is in the account currency (TopBar.axaml:89; account currency from `/me`, MarketDataService.cs:1584).
- F1 help: `F1 HELP · F2 watch search · F3 chart single · F4 ticket · F5 positions · F6 log · F7 account refresh · F11 layout single/grid` (MainWindow.axaml.cs:304) — F6 is labelled `NEWS` in the status bar (MainViewModel.cs:48) and refreshes the calendar (309).
- `F10 · reports (coming soon)` (MainWindow.axaml.cs:313).
- Window XAML title literal `Futurix Terminal PRO` (MainWindow.axaml:9), replaced at runtime by Brand.Current.ProductTitle / broker name (MainWindow.axaml.cs:247-249).
- Fixture literals that can remain visible live: `A. KHAN`, `−8,096.37`, `DEMO`, `FUTURIX`, `CONNECTED · FUTURIX-DEMO · 257MS` (MainViewModel.cs:33-38, 55).
- Switch-account confirm `Return to sign-in? Saved credential kept.` vs Sign-out `Sign out? Saved credential kept.` — same action (MainWindow.axaml.cs:238, 243).

## F. UI structure map
**Layout** (1920×1015 design, min 1000×560; MainWindow.axaml:10): TopBar / Tape / body / StatusBar. Body 3 columns with a 1 px line between, each column split top/bottom with its own splitter; default bottom docks 232 px.

**TopBar** (TopBar.axaml), left → right:
1. Logo square + brand text (`FUTURIX` until `/broker-branding` answers; upper-cased broker name).
2. Command line: `FXG> ` + chart symbol + description (live). Fixture: `FXG> XAUUSD CURNCY GO`. Tooltip `Symbol search (F2)`. Click = F2.
3. Fixture only (hidden live): `PRO | BASIC` toggle; tags `DES desc`, `MW watch`, `OT ticket`, `POS positions`, `NEWS feed` (TopBar.axaml:30-72).
4. Spacer.
5. Stat cells (header-right): `ACCOUNT` `{number} {mode}` · `EQUITY USD` `{equity}` (green ≥0 / red <0) · `MARGIN LVL` `{n}%` or `—` · `THEME` `☀ LIGHT`/`☾ DARK` (live) · `USER` avatar initials + name + `▾` · caption buttons min / max / close (live).
KPI strip: the ACCOUNT / EQUITY / MARGIN LVL cells above; no other KPI strip in the shell.

**USER menu** (left-click on USER cell; TopBar.axaml.cs:32-38), placement bottom-right, min width 260:
```
{NAME} · {ACCOUNT} {MODE}        (disabled header)
────────────
Switch account…
────────────
Sign out
Sign out and forget this computer
```
No shortcuts, no submenus. Right-click on the title bar: NO menu (WindowChrome only handles left drag / double-click).

**Tape**: fixed label `TAPE`, then (live) a right-to-left marquee at 38 px/s (Tape.axaml.cs:17) of cells `SYMBOL price ±x.xx%` (green/red), copies repeated to fill the width (2–12 copies, Tape.axaml.cs:194). Hover pauses; click opens the symbol on the active chart. Right-click: NO. Fixture: static list (XAU, US30, BTCUSD, …, DXY; MainViewModel.cs:114-127).

**Body**: no table in the shell itself.

**StatusBar** (StatusBar.axaml), left → right: dot (green = price stream connected) + connection text (`{Broker} · Live|Demo · {ping}MS`); `HH:mm:ss UTC` (live); open sessions text (amber, or `NO SESSION`) + update pill (only while downloading / ready; accent fill when ready); spacer; F-key cells `F1 HELP · F2 WATCH · F3 CHART · F4 TICKET · F5 POSITIONS · F6 NEWS · F7 ACCOUNT · F8 ALERTS · F9 NEW ORDER · F10 REPORTS · F11 LAYOUT · F12 SETTINGS` (live, clickable; MainViewModel.cs:45-50). Fixture cells are the same except `F9 BOTS` and not clickable (MainViewModel.cs:129-134). Right-click anywhere in the status bar: NO.

**Keyboard**: F1–F12 routed globally (MainWindow.axaml.cs:258); Esc / Delete go to the chart host (259); STM buy/sell hotkeys when STM enabled (262-266, ticket audit).

## Issues
[money] shell · EQUITY / MARGIN LVL are computed client-side with no quote→account FX conversion (P&L = price diff × contract × lots in quote currency) while the server converts every leg (lib/margin.ts:69-73); `/symbols` sends no quoteCurrency · MarketDataService.cs:1603-1604; Vyx.Shared/Trading/AccountMath.cs:72-78; app/api/trade/symbols/route.ts:33-56
[text] shell · `EQUITY USD` label is a literal regardless of the account currency · Views/TopBar.axaml:89
[text] shell · command-line prefix `FXG> ` is a literal shown for every broker · Views/TopBar.axaml:23
[ux] shell · when `/me` or `/broker-branding` fails the live header keeps design-fixture values (`A. KHAN`, `−8,096.37`, `DEMO`, `FUTURIX`) · ViewModels/MainViewModel.cs:33-38; Services/MarketDataService.cs:1291
[text] shell · F1 help text says `F6 log` (F6 refreshes the calendar) and omits F8/F9/F10/F12 · MainWindow.axaml.cs:304,309
[functional] shell · F10 REPORTS is a placeholder (`reports (coming soon)`) · MainWindow.axaml.cs:313
[functional] shell · window close ✕ has no confirm although client-side smart rules stop with the process · Vyx.Shared.Ui/CaptionButtons.axaml.cs:24; MainWindow.axaml.cs:254,288
[ux] shell · "Switch account…" performs exactly the same action as "Sign out" · MainWindow.axaml.cs:238,243-244
[ux] shell · tape lists every enabled symbol (not only the watchlist) and a D1 candle GET is issued sequentially for every one of them on each watchlist load · Services/MarketDataService.cs:1101-1102,1267,1329-1331
[text] shell · XAML window title literal `Futurix Terminal PRO` (runtime-replaced) · MainWindow.axaml:9; MainWindow.axaml.cs:247

## Status counts
`STATUS-COUNTS app=terminal screen=shell WORKS=22 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=1`


<!-- ===== term-marketwatch.md ===== -->

# term-marketwatch — 1) MW Market Watch + Symbol Specification

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Live view = shared control Vyx.Shared.Ui/MarketWatch/MarketWatchView (also hosted by the backoffice Dealing screen). Code-only audit.

## A. Purpose + panels
The account's watchlist grouped by symbol category, one live row per symbol (bid / ask / spread / day high / low / change), with search, "+ ADD" flyout, row click → chart, double-click → New Order, right-click menu, and a read-only Symbol Specification dialog.
Panels: title bar `1) MW MARKET WATCH` + UTC clock (MarketWatchPanel.axaml:13-21); column header row; search + `+ ADD` row; grouped rows; status text (MarketWatchView.axaml:22-111). Fixture rows (design gate) show only before sign-in (MarketWatchPanel.axaml:40-88).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Rows (which symbols, order) | GET /api/trade/watchlist | FetchWatchlistAsync ApiClient.cs:162-163 | watchlist/route.ts:6-16 → lib/watchlist.ts:59-80 (lazy seeds 10 defaults when the account has 0 rows, :66-67) | sign-in (MarketDataService.cs:1060), after add/remove (1406, 1416), AccountUpdated when the symbol set changed (574) |
| Symbol universe / category / digits | GET /api/trade/symbols | FetchAllSymbolsAsync ApiClient.cs:151 | symbols/route.ts:20-56 (broker-enabled BrokerSymbol rows) | sign-in, AccountUpdated |
| Bid / Ask / Spread | WS ticks (PriceStreamClient) seeded by GET /api/trade/prices | FetchPricesAsync ApiClient.cs:191 | prices/route.ts | live per tick (MarketDataService.cs:2191); snapshot only at sign-in and AccountUpdated (1059, 576) |
| Day High / Low / CHG% | last D1 candle (open/high/low) then extended by live bid | FetchCandlesAsync(sym,"D1") ApiClient.cs:197 | candles/route.ts:22-27 | loaded per GridCandidate sequentially after each watchlist load (MarketDataService.cs:1327-1341), cached 5 min (1389); hourly day-roll re-read for chart slots only (1371-1384) |

Rules: a watchlist symbol not in `/symbols` is dropped client-side (MarketDataService.cs:1098). Groups = category upper-cased, first-seen order; blank category → `OTHER` (1312). Selection highlight = active chart symbol (1318, 1426). Spread = raw ask − bid in points (MarketWatchViewModel.cs:88; AccountMath.cs:129-133) — the BUY markup (`askMarkup`, prices/route.ts:165,171) is NOT added, while the ticket / one-click BUY price is ask + markup (OrderTicketViewModel.cs:64, 123). High/low follow bid only (MarketWatchViewModel.cs:83-84). CHG% = (bid − D1 open)/D1 open (MarketWatchViewModel.cs:89-95); `—` when no D1 row.
Sort/filter: no sorting; search filters rows by symbol substring only (MarketWatchViewModel.cs:44); group headers stay visible when all their rows are filtered out (group header has no visibility binding, MarketWatchView.axaml:74-76).
Pagination: none. Server fields `collapsedCategories` (watchlist/route.ts:15) and the web's reorder route (app/api/trade/watchlist/reorder) are not used by the terminal.
Empty/loading/error: `NO FEED` per row until a price exists (MarketWatchView.axaml:98). Status line bound to `Watch.Status` (MarketWatchView.axaml:111) is never set by the terminal (no writer in MarketDataService.cs) — a failed watchlist GET shows an empty panel with no text. ADD flyout empty text `all enabled symbols are on the watchlist` / `no match` (MarketWatchView.axaml.cs:76).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search box `search symbols…` | row 2 left (MarketWatchView.axaml:39) | IsLive | always | none (Filter → ApplyFilter, MarketWatchViewModel.cs:28,30,44) | none | – | No | No | trader session | rows hidden | PARTIAL (symbol-only match; empty category headers remain) |
| `+ ADD` | row 2 right (MarketWatchView.axaml:40-67) | IsLive | always | toggles flyout (MarketWatchView.axaml.cs:81-85) | none | – | No | No | – | ADD SYMBOL flyout | WORKS |
| ADD flyout `search…` | flyout (MarketWatchView.axaml:47) | flyout open | always | none (symbol OR description match, MarketWatchView.axaml.cs:69-77) | none | – | No | No | – | list filtered | WORKS |
| ADD flyout item | flyout list (MarketWatchView.axaml:52) | flyout open | always | AddToWatchlistAsync → POST /api/trade/watchlist {symbolId} (ApiClient.cs:181-182) | watchlist/route.ts:21-51: WatchlistItem upsert at max position+1; no AuditLog / notification | client: symbol must be in /symbols (MarketDataService.cs:1404); server: BrokerSymbol enabled (route :32-37) else 404 | No | No | – | watchlist re-GET, grid defaults reconciled, LOG `Added X to watchlist`, action line `OK · X added` (MarketDataService.cs:1402-1410) | WORKS |
| Row click (left) | row (MarketWatchView.axaml:81; .cs:33-61) | IsLive | always | SelectChartAsync → GET /api/trade/candles (ApiClient.cs:197) | read only | – | No | No | – | active chart (single or focused cell) switches | WORKS |
| Row double-click | row (MarketWatchView.axaml.cs:28-32) | IsLive | signed in | opens NewOrderWindow(symbol) (MainWindow.axaml.cs:231, 385-392) | – (order dialog audited separately) | – | – | – | – | modal New Order | WORKS |
| Menu: Open chart, SYM | row right-click | IsLive | always | same as row click | read only | – | No | No | – | chart switches | WORKS |
| Menu: New order, SYM | row right-click | IsLive | signed in | same as double-click | – | – | – | – | – | modal New Order | WORKS |
| Menu: Specification, SYM… | row right-click | IsLive | always | opens SymbolSpecWindow (MainWindow.axaml.cs:129, 422-426); no request, reads cached /symbols + last tick | none | – | No | No | – | modal dialog | PARTIAL (pip-value label/unit mismatch, margin ignores FX / hedged %, no trading hours although /symbols sends tradingSessions) |
| Menu: Add symbol… | row right-click | IsLive | always | opens the ADD flyout (MarketWatchView.axaml.cs:44) | none | – | No | No | – | flyout | WORKS |
| Menu: Remove SYM from watchlist | row right-click | IsLive | always | RemoveFromWatchlistAsync → DELETE /api/trade/watchlist/{symbolId} (ApiClient.cs:185-186) | watchlist/[symbolId]/route.ts:72-79: WatchlistItem deleteMany; no audit. Removing the last row → next GET re-seeds up to 10 default symbols (lib/watchlist.ts:66-67) | client: symbol in /symbols | Yes, always: `REMOVE FROM WATCHLIST` / `Remove {sym} from this account's watchlist.` / `REMOVE` (MainWindow.axaml.cs:230) | No | – | re-GET, LOG `Removed X from watchlist` | PARTIAL (removing the last symbol brings back the default set) |
| Menu: Columns ▸ Change % | row right-click submenu | IsLive | always | none (ShowChange toggle) | none | – | No | No | – | column hidden/shown; NOT persisted (MainWindow.axaml.cs:223, 226 read/write only MwShowSpread / MwShowHighLow; TerminalSettings.MwShowChange exists at TerminalSettings.cs:50 but is unused) | PARTIAL (resets to on at every launch) |
| Menu: Columns ▸ Spread | same | IsLive | always | none | local settings.json MwShowSpread | – | No | No | – | persisted | WORKS |
| Menu: Columns ▸ Daily High / Low | same | IsLive | always | none | local settings.json MwShowHighLow | – | No | No | – | persisted; left column widened to 440 px when on (MainWindow.axaml.cs:228) | WORKS |
| Spec dialog CLOSE | SymbolSpecWindow (SymbolSpecWindow.axaml:11-13) | dialog open | always | none | none | – | No | No | – | closes | WORKS |

## D. Dialogs
**ADD SYMBOL flyout**: `search…` text (not stored); list = every `/symbols` symbol not on the watchlist, API (name-asc) order, symbol + description (MarketDataService.cs:58-59; symbols/route.ts:30).

**Symbol Specification** (SymbolSpecWindow.axaml.cs:22-49), 380×470, read-only, snapshot at open (no live update). Title `{SYMBOL}  ·  {CATEGORY}`. Rows:
| Row | Value source | Stored in | Read by |
|---|---|---|---|
| Symbol id | SymbolInfo.Id | Symbol.id | internal id (display only) |
| Digits | SymbolInfo.Digits | Symbol.digits | price rounding everywhere |
| Tick size | 10^-digits (PriceRounding.TickSize) | derived | – |
| Contract size | SymbolInfo.ContractSize | Symbol.contractSize | P&L / margin (server lib/margin.ts; client AccountMath) |
| Pip value / 1 lot | lots×contract×tick (OrderValidation.cs:79-80), suffix `{ccy} per tick` | derived | – (label says pip, value is per tick, currency is the account's but value is quote-currency) |
| Stop level | `{n} ticks ({price distance})` or `none` | BrokerSymbol.stopLevel (points; schema.prisma:1715-1723) | server validateSlTp (positions/[id]/route.ts:66-73), client SlTpValidation |
| Min lot / Max lot / Lot step | SymbolInfo | BrokerSymbol.minLot/maxLot/lotStep | server checkLotStep (symbols/route.ts:46-52 comment), ticket validation |
| Bid / Ask | last tick | – | – |
| Spread | raw ask − bid in points `{n} pts` | – | – (excludes BUY markup) |
| BUY ask markup | askMarkup from /prices | derived from group/broker markup pips (prices/route.ts:165) | server BUY fill price |
| Market | `CLOSED` / `OPEN (live quote)` / `unknown` via MarketSchedule on tradingSessions (MarketDataService.cs:98-103) | TradingSession rows | server checkTradingSession |
| Margin / 1 lot @ 1:{lev} | contract × ask / leverage + account currency (SymbolSpecWindow.axaml.cs:47) | derived | – (no FX conversion, no hedged %, differs from server lib/margin.ts:69-73) |
Note line: `Swaps, commissions and trading hours: per account group (broker)` (SymbolSpecWindow.axaml.cs:48). Trading hours are not shown although tradingSessions are loaded.

## E. Text
- Spec: `Pip value / 1 lot` with value suffix `… per tick` (SymbolSpecWindow.axaml.cs:38).
- Spec: `Symbol id` exposes the internal cuid (SymbolSpecWindow.axaml.cs:34).
- Spec class doc: `the API carries no session schedule` (SymbolSpecWindow.axaml.cs:17) — /symbols sends tradingSessions (symbols/route.ts:24-27, 37).
- MarketWatchViewModel doc: `"<active> · CORRELATION 20D" section computed from real D1 closes` (MarketWatchViewModel.cs:8-10) — the section was removed (MarketDataService.cs:1398-1400).
- MarketWatchPanel.axaml.cs:34 comment `ticket focus for this symbol` — the event opens the New Order dialog.
- `FeedState` (`FEED LIVE` / `FEED RECONNECTING` …) is computed (MarketDataService.cs:228-229) but only the fixture shows a `FEED LIVE` literal (MarketWatchPanel.axaml:16); nothing live displays it.

## F. UI structure map
**Header**: `1)` `MW` `MARKET WATCH` (live) / `MARKET MONITOR` (fixture) (MainViewModel.cs:81). Header-right: live `HH:mm:ss UTC`; fixture `FEED LIVE` + `03:17:42 UTC`.
**Column header row** (not clickable, not sortable): `SYMBOL` · `BID` · `ASK` · `SPRD` (if Spread on) · `HIGH` · `LOW` (if High/Low on) · `CHG%` (if Change on) · (8 px up/down square, no header).
**Search row**: `search symbols…` box, `+ ADD` button (amber text).
**Table (grouped rows)**: group header bar = category name (e.g. `METALS`, `FOREX`, `OTHER`). Row columns in order: SYMBOL, BID, ASK, SPRD, HIGH, LOW, CHG% (green/red), square (green/red). NO FEED row: dim symbol + `NO FEED` in the CHG% slot. Not sortable; default order = watchlist position within first-seen category groups. Selection: single highlight = active chart symbol (not multi, no checkbox column).
Row click = open chart; double-click = New Order dialog; Enter: none.
**Right-click on row: YES** (MarketWatchView.axaml.cs:36-57), no header line:
```
Open chart, {SYM}
New order, {SYM}
Specification, {SYM}…
────────────
Add symbol…
Remove {SYM} from watchlist
────────────
Columns ▸
    [✓] Change %
    [✓] Spread
    [ ] Daily High / Low
```
All items always visible and enabled; no shortcuts. Right-click on multi-selection: N/A (no multi-select). Right-click on empty area / group header / column header: NO (handler only on the row Border).
**ADD SYMBOL flyout**: title `ADD SYMBOL`, `search…` box, scroll list (max 320 px) of `SYMBOL  description`, empty text `all enabled symbols are on the watchlist` / `no match`.
**Symbol Specification dialog**: title row, key/value list (order as in D), note line, `CLOSE` button bottom-right. No other buttons.

## Issues
[money] marketwatch · ASK and SPRD show the raw ask; the price a BUY pays (ticket / one-click) is ask + askMarkup, so on marked-up groups the watchlist spread is tighter than the traded spread · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:86-88; ViewModels/OrderTicketViewModel.cs:64,123; app/api/trade/prices/route.ts:165,171
[functional] marketwatch · removing the last watchlist symbol makes the next GET re-seed up to 10 default symbols · app/api/trade/watchlist/[symbolId]/route.ts:78; lib/watchlist.ts:66-67
[functional] marketwatch · Columns ▸ Change % is not persisted (MwShowChange exists but is never read or written by the terminal) · MainWindow.axaml.cs:223,226; Services/TerminalSettings.cs:50
[ux] marketwatch · a failed watchlist GET leaves an empty panel with no message (Watch.Status is never set) · Vyx.Shared.Ui/MarketWatch/MarketWatchView.axaml:111; Services/MarketDataService.cs:1092-1099
[ux] marketwatch · search matches symbol only and leaves empty category headers visible · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:44; MarketWatchView.axaml:74-76
[money] marketwatch · Specification "Margin / 1 lot" = contract × ask / leverage labelled in account currency: no FX conversion, no hedged %, not the server formula · Views/SymbolSpecWindow.axaml.cs:47; lib/margin.ts:69-73
[text] marketwatch · Specification `Pip value / 1 lot` shows a per-tick value (`… per tick`) · Views/SymbolSpecWindow.axaml.cs:38
[functional] marketwatch · Specification shows no trading hours although /symbols returns tradingSessions (note says "per account group") · Views/SymbolSpecWindow.axaml.cs:48; app/api/trade/symbols/route.ts:24-27,37
[text] marketwatch · Specification shows the internal `Symbol id` · Views/SymbolSpecWindow.axaml.cs:34
[text] marketwatch · stale doc comments: correlation section (removed) and "API carries no session schedule" · Vyx.Shared.Ui/MarketWatch/MarketWatchViewModel.cs:8-10; Views/SymbolSpecWindow.axaml.cs:17
[ux] marketwatch · the terminal ignores the server's collapsedCategories and has no reorder, both of which the web watchlist has · app/api/trade/watchlist/route.ts:15; Services/MarketDataService.cs:1092-1113

## Status counts
`STATUS-COUNTS app=terminal screen=marketwatch WORKS=11 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
