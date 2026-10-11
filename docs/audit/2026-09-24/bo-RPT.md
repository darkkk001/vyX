# bo-RPT — Reports (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\IbReportsScreens.cs:126-200 (class ReportsScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Six server CSV reports shown as a table, 4 summary KPI tiles, client-side date-range filter, SAVE CSV. Read-only.
Panels: KPI strip (4 tiles, row 0, 54 px) and "1) RPT · REPORTS" (row 1) with filter bar and table host (IbReportsScreens.cs:138-148).

## B. Data
Refresh: no live topics, no poll. On nav (only if last refresh >10 s, Screen.cs:70-76) and on every kind-chip click (ForceRefreshAsync, IbReportsScreens.cs:189). Each refresh fetches summary + the selected report in parallel (:150-157).
| Read | ApiClient | Route | Role gate | Server scope |
|---|---|---|---|---|
| GET /api/manage/reports/summary | FetchReportSummaryAsync ApiClient.ManageG3.cs:63 | app/api/manage/reports/summary/route.ts:11 | MANAGER, BROKER_ADMIN (:13) | 30 d, LIVE only: volume of positions OPENED (:30), commission of CLOSED (:34), deposits − abs(withdrawals) COMPLETED (:38-48), new LIVE accounts (:45) |
| GET /api/manage/reports/trading | FetchReportAsync("trading") ManageG3.cs:70 (bytes via GetBytesAsync, parsed CSV :74-78) | reports/trading/route.ts:8 | MANAGER, BROKER_ADMIN | CLOSED positions 30 d, LIVE (:18), no row limit |
| GET /api/manage/reports/financial | same | reports/financial/route.ts:8 | MANAGER, BROKER_ADMIN | every transaction 30 d, LIVE (:18), amount signed |
| GET /api/manage/reports/client | same | reports/client/route.ts:6 | MANAGER, BROKER_ADMIN | every account incl. DEMO (:14) |
| GET /api/manage/reports/ib | same | reports/ib/route.ts:7 | MANAGER, BROKER_ADMIN (:9) | every IB relationship + computed pending commission |
| GET /api/manage/reports/lp | same | reports/lp/route.ts:11 | BROKER_ADMIN only (:13) | liquidity-provider records |
| GET /api/manage/reports/risk | same | reports/risk/route.ts:10 | MANAGER, BROKER_ADMIN | margin snapshot per account |
Columns are the CSV header, upper-cased, "_" -> " " (IbReportsScreens.cs:166). Right-aligned when the first 20 rows parse as numbers. Cell rendering strips the server's leading-apostrophe formula guard from numbers and reformats ISO timestamps to "dd MMM HH:mm:ss" (:180-188).
Filters: kind chip (server); RANGE from/to (client-side: first column whose values parse as a timestamp decides; rows outside hidden, :169-172). No pagination (server returns everything).
Empty/loading/error: before first load "PICK A REPORT" (:148); empty report "the report has no rows" (:167); errors in header status "summary: …" / "{kind}: …" (:155-156), previous table left in place. Header stat "{KIND} · {n} ROWS" or "{n} OF {total} ROWS" when filtered (:175).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Kind chips TRADING · FINANCIAL · CLIENT · IB · LP · RISK | filter bar left (:135,189) | always | always | FetchReportSummaryAsync + FetchReportAsync(kind) -> GET reports/summary + reports/{kind} | none (read) | - | no | no | server: LP = BROKER_ADMIN only | table rebuilt; chip lit | WORKS |
| RANGE "from" / "to" calendar pickers | filter bar after "·" (:134,141,146) | always | always | none | none | future days not pickable (Ui.cs:264) | no | no | none | table re-filtered client-side | PARTIAL (filter uses only the first timestamp column; not applied to SAVE CSV) |
| Range chips 1D · 1W · 30D | filter bar after pickers (:144) | always | always | none | none | - | no | no | none | sets FROM = today−N, clears TO, re-filter | PARTIAL (chip never shows as lit — created with on=false; no chip to clear the range) |
| SAVE CSV (primary, orange) | panel header right (:140,190-198) | always | always | none (local file via OS save picker) | none | toast "no report loaded" when nothing loaded | no | no | none | toast "{kind} report saved · {n} rows" | PARTIAL (writes the full server CSV, not the range-filtered rows; toast counts unfiltered rows) |
| Column header click | report table (DataTable.cs:299) | always | always | none | none | - | no | no | none | sort | WORKS |
| Column header right-click | report table (DataTable.cs:89) | always | always | none | none | - | no | no | none | column picker, persisted under "report-{kind}" | WORKS |

## D. Dialogs
None (the OS save-file picker only: suggested name "{kind}-report-{yyyyMMdd}.csv", filter "*.csv", :194).

## E. Text
- KPI notes: "LOTS · 30D", "USD", "USD", "ACCOUNTS" (:160-161). All four figures are 30-day, LIVE-only (summary/route.ts:30-45); only the first note says 30D.
- "TRADING VOLUME" = volume of positions OPENED in the window, any status (summary/route.ts:30); the TRADING report lists positions CLOSED in the window (trading/route.ts:18). Same word "trading", different populations.
- Class doc comment says "No date range: the server's endpoints take none" (:128) while the UI shows a RANGE filter (:141).
- Chip "LP" shows the liquidity-provider contact list (reports/lp/route.ts), not LP trading activity.
- CLIENT report includes demo accounts (client/route.ts:14); the other reports are LIVE-only.

## F. UI structure map
Layout: PageGrid rows 54 / *. Row 0: 4 KPI tiles — TRADING VOLUME | COMMISSION REVENUE | NET DEPOSITS | NEW CLIENTS. Row 1: panel "1) RPT  REPORTS"; header right items in order: row-count stat, status text, SAVE CSV (primary/orange).
Filter bar (left to right): chips TRADING (default lit) · FINANCIAL · CLIENT · IB · LP · RISK, then "·", then "RANGE", from picker ("from"), to picker ("to"), chips 1D · 1W · 30D (none lit, ever).
Table: one DataTable per loaded report (rebuilt each load, :167). Columns = CSV headers in server order:
- TRADING: CLOSED AT | ACCOUNT | SYMBOL | SIDE | VOLUME | OPEN PRICE | CLOSE PRICE | COMMISSION | SWAP | REALIZED P&L
- FINANCIAL: DATE | TYPE | STATUS | ACCOUNT | AMOUNT | NOTE
- CLIENT: ACCOUNT | FULL NAME | EMAIL | MODE | CURRENCY | BALANCE | GROUP | STATUS | CREATED AT
- IB: IB ACCOUNT | CLIENT ACCOUNT | COMMISSION TYPE | COMMISSION RATE | PENDING COMMISSION | LAST PAYOUT AT
- LP: NAME | STATUS | PROTOCOL | CONTACT NAME | CONTACT EMAIL | CONTACT PHONE | ROUTING RULES | ADDED AT
- RISK: ACCOUNT | OPEN POSITIONS | EXPOSURE (LOTS) | FLOATING P&L | MARGIN LEVEL % | MARGIN CALL THRESHOLD % | STOP-OUT THRESHOLD %
Sortable: all columns; default sort: none (server order: trading closedAt desc, financial createdAt desc, client accountNumber asc, ib createdAt desc). Selection: single; no checkbox column. Row click: select only. Double-click: nothing. Enter: nothing. No per-row buttons.
Right-click on row: NO (no RowContextRequested handler). Multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS" header, separator, checkbox per column, separator, "Reset columns".
Empty/loading/error: "PICK A REPORT"; "the report has no rows"; page veil "LOADING…" on nav; error text in header status.

## Issues
[functional] RPT · SAVE CSV writes the full server CSV even while the RANGE filter hides rows; toast reports the unfiltered count · IbReportsScreens.cs:196-197
[functional] RPT · IB report (pending commission per IB) is readable by any MANAGER, while the IB screen's endpoint requires IB_PAYOUTS · app/api/manage/reports/ib/route.ts:9; app/api/manage/ib-relationships/route.ts:14
[functional] RPT · LP chip returns 403 for MANAGER (BROKER_ADMIN only); the chip is shown to every role · reports/lp/route.ts:13; IbReportsScreens.cs:135
[ux] RPT · range chips 1D/1W/30D never show which one is active and there is no clear-range control · IbReportsScreens.cs:144
[text] RPT · KPI notes omit the 30-day / LIVE-only window on 3 of 4 tiles · IbReportsScreens.cs:160-161; reports/summary/route.ts:30-45
[text] RPT · TRADING VOLUME counts positions opened in the window while the TRADING report lists positions closed in the window · reports/summary/route.ts:30; reports/trading/route.ts:18
[text] RPT · CLIENT report includes DEMO accounts; every other report is LIVE-only · reports/client/route.ts:14

## Status counts
STATUS-COUNTS app=backoffice screen=RPT WORKS=3 PARTIAL=3 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0
