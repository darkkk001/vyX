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
