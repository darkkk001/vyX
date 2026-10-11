# bo-MRG · Margin (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:117-183 (MarginScreen, MRG). Nav: RISK › "Margin" (ShellViewModel.cs:67); also RISK "FULL MARGIN SCREEN" button.

## A. Purpose + panels
Read-only margin table of every account with open positions, lowest margin level first, with a close-all action per account.
One panel: 1) MRG "MARGIN · LOWEST LEVEL FIRST" (:140).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) MRG | GET /api/manage/margin + GET /api/manage/positions | FetchMarginAsync ApiClient.ManageG1.cs:223; FetchManagePositionsAsync ApiClient.ManageG1.cs:224 | app/api/manage/margin/route.ts:10-43 → lib/margin.ts computeAccountMarginSnapshots (OPEN positions only, :34; exposure = Σ lots :65); positions/route.ts:47 | live topics position, margin; poll 10 s (:122-123); ticks ≤1/s re-price via LiveMath.Reprice (:128-134) | client: accounts with positions first, then level asc, no-level last (:178) | none | "no accounts with positions"; error → Status |
Role: MANAGER, BROKER_ADMIN (margin/route.ts:12).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Row double-click | table | row | always | Shell.Open("CLI", accountId) (:138) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Open client 360" | row menu | always | always | Shell.Open("CLI", accountId) (:148) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure · this account" | row menu | always | always | Shell.Open("EXP", accountNumber) (:149) | — | — | no | — | — | EXP filtered | WORKS |
| Right-click → "Close all <n> positions…" | row menu | always | PositionCount > 0 | POST /api/manage/positions/close-bulk {scope ALL, accountId} — CloseBulkAsync ApiClient.ManageG6.cs:138-139 → positions/close-bulk/route.ts:20-71 | closeBulkForAccount (lib/bulk-close.ts): closes, mirror.onClose + coverage.onClose (:185-194), NATS PositionsClosed (:199), AuditLog MANUAL_POSITION_BULK_CLOSE (close-bulk/route.ts:48-63) | — | yes (danger) | no | MANAGER, BROKER_ADMIN | toast "<acc> · positions closed" regardless of the failed count (:153) | PARTIAL (partial failures reported as success) |

## D. Dialogs
CLOSE ALL POSITIONS (Shell.ConfirmAction, RiskScreen.cs:152-153): no fields; text "Close every open position of <acc> (<name>) at market? One transaction."

## E. Text
- Class summary "the hidden Qt MarginPage … status NO FEED / STOP-OUT / MARGIN CALL / OK. Reached from Risk, search or the F-key bar" (RiskScreen.cs:117-118): the screen is in the nav (ShellViewModel.cs:67) and the status rendered is "NO PRICE", not "NO FEED" (:162); no F-key maps to MRG (ShellViewModel.cs:97-98).
- Column "EXPOSURE" (:159) shows Σ lots with format "#,##0" (:164), so e.g. 0.30 lots renders "0"; no unit.
- Header stat "<n> ACCOUNTS · <n> AT OR BELOW MARGIN CALL" (:180).
- "NO POSITIONS" status can never appear: the server returns only accounts with OPEN positions (lib/margin.ts:34).

## F. UI structure map
Layout: one full panel. Header: "1) MRG" · "MARGIN · LOWEST LEVEL FIRST"; header-right: stat "<n> ACCOUNTS · <n> AT OR BELOW MARGIN CALL" (red when > 0), Status. No KPI strip, no chips, no toolbar buttons.
Table (layout "margin"): ACCOUNT · CLIENT · EQUITY · USED MARGIN · FREE MARGIN · POSITIONS · EXPOSURE · FLOATING PROFIT / LOSS · MARGIN LEVEL · STATUS (RiskScreen.cs:157-159). MARGIN LEVEL "<n>%" or "—"; STATUS chip NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK. Headers sortable (click); default order = client sort (level asc). Single select, no checkbox. Row click: select; double-click: CLI; Enter: nothing. Live cells flash on change (DataTable.cs:193-201). Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360" / "Live exposure · this account" / separator / "Close all <n> positions…" (enabled when n > 0) (:143-156).
Right-click empty area: NO. Right-click header: YES, column picker. Empty: "no accounts with positions".

## Issues
- [functional] MRG · "Close all positions" shows success even when the response reports failed closes · RiskScreen.cs:153; positions/close-bulk/route.ts:65-70
- [ux] MRG · EXPOSURE column is lots rounded to whole numbers ("#,##0"), small positions show 0 · RiskScreen.cs:164; lib/margin.ts:65
- [text] MRG · summary calls it hidden / "NO FEED" / F-key reachable, none true · RiskScreen.cs:117-118, :162; ShellViewModel.cs:67
- [text] MRG · "NO POSITIONS" status branch is unreachable (server lists only accounts with open positions) · RiskScreen.cs:162; lib/margin.ts:34

## Status counts
STATUS-COUNTS app=backoffice screen=MRG WORKS=2 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
