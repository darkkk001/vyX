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
