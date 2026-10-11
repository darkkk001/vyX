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
