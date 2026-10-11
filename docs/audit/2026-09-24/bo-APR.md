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
