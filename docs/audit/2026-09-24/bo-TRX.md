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
