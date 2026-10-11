# bo-DASH — Dashboard (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DashboardScreen.cs (324 lines). Web: D:\VyXTrader-Tauri\vyX (main HEAD).
Convention: a pure view control (filter chip, search, sort, navigation) that does what it says is WORKS; UI-ONLY is reserved for a control that looks like it writes but does not.

## A. Purpose + panels
Broker overview: 9 KPI tiles, clients list, open book by symbol, approvals queue, 7-day deposit/withdrawal chart, recent audit activity. Read-only screen (no writes).
Panels: KPI strip (row 0, 54 px); "1) CLI · CLIENTS" (mid-left); "2) EXP · OPEN BOOK" (mid-right, 400 px); "3) APPR · APPROVALS QUEUE" (bottom-left); "4) FLOW · DEPOSITS VS WITHDRAWALS · 7D" (bottom-middle); "5) ACT · ACTIVITY" (bottom-right, 340 px). DashboardScreen.cs:66-79.

## B. Data
Refresh: live topics order/position/dealing/account (DashboardScreen.cs:25) -> active screen refetches after 400 ms debounce (MainWindow.axaml.cs:161-178); poll every 30 s while active (DashboardScreen.cs:26; MainWindow.axaml.cs:182-187; poll skipped while a TextBox has focus or a confirm/form is open); on nav when last refresh >10 s old with a LOADING… veil (Screen.cs:70-76); ticks re-render price cells at most 1/s (DashboardScreen.cs:110-116).
Nine parallel reads (DashboardScreen.cs:89-92):
| Read | ApiClient | Route handler | Role gate (server) | Limit |
|---|---|---|---|---|
| GET /api/manage/dashboard | FetchDashboardAsync ApiClient.ManageG1.cs:147 | app/api/manage/dashboard/route.ts:16 | MANAGER, BROKER_ADMIN (route.ts:18) | activity take 15 (route.ts:73) |
| GET /api/manage/accounts | FetchManageAccountsAsync ManageG1.cs:152 | app/api/manage/accounts/route.ts:21 | MANAGER, BROKER_ADMIN (route.ts:15) | none |
| GET /api/manage/positions | FetchManagePositionsAsync ManageG1.cs:224 | app/api/manage/positions/route.ts:47 | MANAGER, BROKER_ADMIN | all OPEN, demo included (route.ts:56) |
| GET /api/manage/margin | FetchMarginAsync ManageG1.cs:223 | app/api/manage/margin/route.ts:10 | MANAGER, BROKER_ADMIN | none |
| GET /api/manage/deals | FetchDealsAsync ManageG1.cs:203 | app/api/manage/deals/route.ts:15 | MANAGER, BROKER_ADMIN | take 500, CLOSED+VOIDED (route.ts:56,71) |
| GET /api/manage/funds-requests | FetchFundsRequestsAsync ManageG1.cs:235 | app/api/manage/funds-requests/route.ts:11 | BROKER_ADMIN or FUNDS_APPROVAL (route.ts:13) | take 200 |
| GET /api/manage/live-account-requests | FetchLiveAccountRequestsAsync ManageG1.cs:267 | app/api/manage/live-account-requests/route.ts:12 | BROKER_ADMIN or KYC_REVIEW (route.ts:14) | take 200 |
| GET /api/manage/risk | FetchRiskSettingsAsync ManageG2.cs:162 | app/api/manage/risk/route.ts:12 | BROKER_ADMIN or RISK_SETTINGS or EMERGENCY_CONTROLS (route.ts:15) | - |
| GET /api/manage/dealing-queue | FetchDealingQueueAsync ManageG2.cs:213 | app/api/manage/dealing-queue/route.ts:24 | MANAGER, BROKER_ADMIN | - |
Errors: only dashboard/accounts/positions/margin/deals/funds failures go to the header status text (DashboardScreen.cs:94-100); live-account-requests, risk and dealing-queue failures are silent (count 0 / no limit / tile blank).
Per panel:
- KPI strip (DashboardScreen.cs:124-147): NET DEPOSITS · 7D (dashboard.netDeposits7d, note PRIOR), DEPOSITS · 30D (depositsSum30d), WITHDRAWALS · PENDING (pendingWithdrawalCount + pendingWithdrawalSum), ACTIVE TRADERS (activeTradeAccountCount, LIVE only, route.ts:54-59; note "{activeTrades} OPEN"), OPEN VOLUME (client sum of positions volume, demo included), B-BOOK P/L · FLOATING (−sum floatingPnl of BookType B*; note REALIZED TODAY = −sum realizedPnl of deals closed today, all books, demo and VOIDED included), MARGIN CALLS (margin rows with MarginCallLevel ≥ ML > StopOut; note "{n} STOP-OUT"), NEW CLIENTS · 7D (all accounts incl. demo; note "{PendingKyc} KYC WAIT · {n} ACCOUNT REQUESTS"), DEALER QUEUE (pending count, note OLDEST age).
- 1) CLI: accounts joined to margin rows by account id; client filter chips + search; empty "no accounts". Header right "{n} TOTAL". No pagination.
- 2) EXP: positions grouped by symbol, sorted by |long−short| desc (DashboardScreen.cs:154-160); empty "no open positions". Header stats "A / B BOOK" (lots split) and "NET $ EXP" (notional vs risk.totalExposureLimit, amber ≥80 %, red ≥100 %). Facts under the table: Top floating loser/winner, A-book open, NEAREST STOP-OUT (5 lowest margin levels; "NO MARGIN DATA"), "LP fill quality · PENDING · NEEDS LP BRIDGE" (static).
- 3) APPR: funds rows with Status PENDING and Type DEPOSIT/WITHDRAWAL, oldest first (DashboardScreen.cs:182-184); empty "no pending deposits or withdrawals"; header stat "{n} DEP {sum} · {n} WDR {sum}" or "NONE PENDING".
- 4) FLOW: dashboard.depositsWithdrawalsByDay (7 buckets, route.ts:88-107); custom bar chart; "NO FLOW · 7D" when no bucket has Deposits>0 or Withdrawals>0 (DashboardScreen.cs:189-191).
- 5) ACT: dashboard.activity (server take 15, excludes super-admin actors, route.ts:70-75); client renders up to 40 (DashboardScreen.cs:196); "NO AUDIT ROWS".
Loading: whole page veiled "LOADING…" (Screen.cs:81-94); header status "loading…" then "HH:mm:ss UTC".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filter chips ALL/LIVE/DEMO/KYC WAIT/SUSPENDED/IB | 1) CLI filter bar (DashboardScreen.cs:229-239) | always | always | none (client filter) | none | - | no | no | none | re-render list | PARTIAL (SUSPENDED filters Status != ACTIVE, so CLOSED accounts too, :239) |
| Search "client · account · e-mail" | 1) CLI filter bar right (:32,62,241) | always | always | none | none | - | no | no | none | re-render | WORKS |
| Row click (any cell) | 1) CLI table (:51) | row | always | none -> Shell.Open("CLI", id) | none | - | no | no | none | navigates to CLI, ClientsScreen.FocusRecord (ClientsScreen.cs:123-128) | WORKS |
| Row double-click | 1) CLI (:49) | row | always | same as row click | none | - | no | no | none | navigates CLI | DUPLICATE (row click :51; ctx "Open client 360" :50) |
| Ctx "Open client 360" | 1) CLI row menu (:50) | row | always | Shell.Open CLI | none | - | no | no | none | navigates | DUPLICATE (row click :51) |
| Ctx "Live exposure" | 1) CLI row menu (:50) | row | always | Shell.Open("EXP", accountNumber) | none | - | no | no | none | EXP filters by account (LiveExposureScreen.cs:109-113) | PARTIAL (account with no open position: pending focus never matches, lands unfiltered with no message) |
| Ctx "Deposits · withdrawals" | 1) CLI row menu (:50) | row | always | Shell.Open("DEP", accountNumber) | none | - | no | no | none | DEP search set (FundsScreen.cs:91-95) | PARTIAL (no funds row for account: lands unfiltered) |
| Ctx "Wallet" | 1) CLI row menu (:50) | row | always | Shell.Open("WAL", id) | none | - | no | no | none | WAL search set (WalletsLeadsScreens.cs:57) | WORKS |
| Ctx "Live exposure · this symbol" | 2) EXP row menu (:55) | row | always | Shell.Open("EXP", symbol) | none | - | no | no | none | EXP FocusRecord only matches position id / account (LiveExposureScreen.cs:111) | PARTIAL (symbol never matches; EXP opens unfiltered) |
| Ctx "Symbol settings" | 2) EXP row menu (:55) | row | always | Shell.Open("SYM", symbol) | none | - | no | no | none | SYM row selected by name (SymbolsScreen.cs:71) | WORKS |
| Row click | 3) APPR table (:61) | row | always | Shell.Open("DEP", txId) | none | - | no | no | none | DEP search set to account | WORKS |
| Row double-click | 3) APPR (:59) | row | always | same | none | - | no | no | none | navigates | DUPLICATE (row click :61) |
| Ctx "Open in Deposits · withdrawals (approve / reject)" | 3) APPR row menu (:60) | row | always | Shell.Open DEP | none | - | no | no | none | navigates | DUPLICATE (row click :61) |
| Ctx "Open client 360" | 3) APPR row menu (:60) | row | row has source | Shell.Open("CLI", accountNumber) | none | - | no | no | none | CLI by number (ClientsScreen.cs:126) | WORKS |
| Column header click | all 3 tables (DataTable.cs:299) | always | always | none | none | - | no | no | none | sort asc, again desc | WORKS |
| Column header right-click | all 3 tables (DataTable.cs:89,303-319) | always | always | none | none | - | no | no | none | column picker; widths/visibility persisted | WORKS |

## D. Dialogs
None. The screen opens no form or confirm.

## E. Text
- Tile label "B-BOOK P/L · FLOATING" note "REALIZED TODAY" is computed over every book, demo and VOIDED deals (DashboardScreen.cs:131; deals/route.ts status in CLOSED,VOIDED) — label says B-book.
- "NEW CLIENTS · 7D" counts demo accounts (dashboard/route.ts:39) while RPT "NEW CLIENTS" counts LIVE only (reports/summary/route.ts) — same words, different populations.
- "ACTIVE TRADERS" is LIVE-only (route.ts:54-59) while "OPEN VOLUME" and "B-BOOK P/L" include demo positions (positions/route.ts:56).
- Chip "SUSPENDED" also shows CLOSED accounts (:239).
- ACTIONS column shows "OPEN" on every row but the whole row navigates on a single click (:51,:258).
- "LP fill quality · PENDING · NEEDS LP BRIDGE" (:178) static text.
- Column header "INTRODUCING BROKER" over a 44 px column whose cells say "IB" (:47,251).

## F. UI structure map
Layout: Ui.PageGrid rows 54 / * / 230 (DashboardScreen.cs:79). Row 0 KPI strip (9 tiles, equal widths). Row 1: "1) CLI" (width *) | "2) EXP" (400). Row 2: "3) APPR" (*) | "4) FLOW" (*) | "5) ACT" (340). No screen title bar; the shell nav shows "Dashboard DASH".
KPI strip order: NET DEPOSITS · 7D | DEPOSITS · 30D | WITHDRAWALS · PENDING | ACTIVE TRADERS | OPEN VOLUME | B-BOOK P/L · FLOATING | MARGIN CALLS | NEW CLIENTS · 7D | DEALER QUEUE.
Panel headers: "1) CLI  CLIENTS" right: "{n} TOTAL". "2) EXP  OPEN BOOK" right: A / B BOOK stat, NET $ EXP stat, status text. "3) APPR  APPROVALS QUEUE" right: dep/wdr stat. "4) FLOW  DEPOSITS VS WITHDRAWALS · 7D" right: legend DEP (green) WDR (red) NET (amber). "5) ACT  ACTIVITY" right: "ALL STAFF" (dim text). No toolbar buttons on this screen.
Filter bar (1) CLI): chips in order ALL (default lit) · LIVE · DEMO · KYC WAIT · SUSPENDED · IB; search box right.
Table 1) CLI columns: ID | CLIENT | COUNTRY | KYC | CATEGORY | GROUP | BALANCE | EQUITY | LOTS | MARGIN % | INTRODUCING BROKER | STATUS | ACTIONS. Sortable all (click header); no default sort (server order accountNumber asc, accounts/route.ts). Single selection, no checkbox column. Click = open CLI; double-click = open CLI; Enter = nothing. Per-row: KYC chip (OK/WAIT/REJ/FLAG), STATUS chip (blank when ACTIVE, SUSP/CLSD), ACTIONS "OPEN" (orange text, not a separate hit target).
Right-click on row: YES. Header "{accountNumber} · {fullName}" (disabled), separator, items: Open client 360 · Live exposure · Deposits · withdrawals · Wallet. No separators between items, no shortcuts, all always enabled.
Table 2) EXP columns: SYMBOL | LONG | SHORT | NET | PROFIT / LOSS | A / B POS. Sortable; default order |net| desc (client). Click: select only. Double-click: none. Right-click on row: YES. Header "{symbol}", separator, Live exposure · this symbol · Symbol settings.
Table 3) APPR columns: TYPE | CLIENT | AMOUNT | NOTE | STATUS | AGE | ACTIONS. Sortable; default oldest first. Click = open DEP; double-click = open DEP. Per-row: TYPE DEP (green)/WDR (amber); STATUS MARKED (blue chip)/WAITING (amber chip); ACTIONS "OPEN". Right-click on row: YES. Header "{amount} · {accountNumber}" (or "withdrawal"), separator, "Open in Deposits · withdrawals (approve / reject)" · "Open client 360" (disabled when row has no source).
Right-click on multi-selection: NO (single selection only). Right-click on empty table area: NO (no TableActions registered). Right-click on column header: YES, all three tables — header "COLUMNS" (disabled), separator, one checkbox item per column (label), separator, "Reset columns".
Empty texts: "no accounts", "no open positions", "no pending deposits or withdrawals", "NO FLOW · 7D", "NO AUDIT ROWS", "NO MARGIN DATA". Loading: page veil "LOADING…". Error: header status text of panel 2 (e.g. "funds: not allowed for this role").
5) ACT rows: time HH:mm · KIND (first word of action, ≤8 chars, toned) · "{action} · {entity} · by {email}". No interaction.

## Issues
[money] DASH · NET DEPOSITS · 7D adds withdrawals instead of subtracting: Transaction.amount is signed (withdrawal negative) and the route negates it again (signed = DEPOSIT ? amount : -amount) · app/api/manage/dashboard/route.ts:95-96; prisma/schema.prisma:1410; app/api/trade/funds-requests/route.ts:111
[money] DASH · FLOW chart withdrawal buckets and WITHDRAWALS · PENDING sum are negative numbers (signed amounts summed raw); a withdrawal-only week shows "NO FLOW · 7D" because the empty test checks Withdrawals > 0 · dashboard/route.ts:65-69,101-102; DashboardScreen.cs:190
[money] DASH · "B-BOOK P/L · FLOATING" includes demo-account positions; "REALIZED TODAY" sums every book (incl. A-book coverage), demo and VOIDED deals, limited to the latest 500 deals · DashboardScreen.cs:129-131; app/api/manage/positions/route.ts:56; app/api/manage/deals/route.ts:56,71
[functional] DASH · "Live exposure · this symbol" passes a symbol name to EXP, whose FocusRecord only matches position id / account, so EXP opens unfiltered · DashboardScreen.cs:55; LiveExposureScreen.cs:109-113
[functional] DASH · live-account-requests / risk / dealing-queue read failures (e.g. MANAGER without KYC_REVIEW or RISK_SETTINGS) are silent: tiles show 0 ACCOUNT REQUESTS / no exposure limit / blank DEALER QUEUE · DashboardScreen.cs:94-99
[functional] DASH · APPR queue shows "no pending deposits or withdrawals" when the funds read is forbidden (MANAGER without FUNDS_APPROVAL); only the header status says why · DashboardScreen.cs:98,183; funds-requests/route.ts:13
[ux] DASH · single click anywhere on a client or APPR row navigates away (no select-only click); row click, double-click and context item all duplicate the same navigation · DashboardScreen.cs:49-51,59-61
[ux] DASH · ACT panel renders up to 40 rows but the server returns 15 · DashboardScreen.cs:196; dashboard/route.ts:73
[text] DASH · NEW CLIENTS · 7D includes demo accounts while ACTIVE TRADERS is live-only and RPT NEW CLIENTS is live-only · dashboard/route.ts:39,54; reports/summary/route.ts
[text] DASH · chip "SUSPENDED" also lists CLOSED accounts · DashboardScreen.cs:239

## Status counts
STATUS-COUNTS app=backoffice screen=DASH WORKS=8 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=4
