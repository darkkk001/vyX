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
