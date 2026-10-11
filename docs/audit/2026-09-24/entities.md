# entities: every entity × every place it appears × the actions there

Read-only audit, 2026-09-25. Sources: all `bo-*.md` (32 files incl. `bo-SHELL.md`), all `term-*.md` (14 files) and `endpoints.md` in this folder. Status words and evidence are copied from those files. The file named in each row's evidence cell is the source. Schema lines are from `D:\VyXTrader-Tauri\vyX\prisma\schema.prisma` at commit 74b3c02 (checked directly).
Evidence short forms (same as the source files): `DS` = DealingScreen.cs; `T\` = E:\vyxtrader\src\Vyx.Trader.App\; `S\` = Vyx.Shared; `W\` = D:\VyXTrader-Tauri\vyX\. Route paths are under `app/api/manage/` (backoffice) or `app/api/trade/` (terminal) unless stated.
"Shown as" = how the entity appears. "Actions" lists every control that acts on the entity in that place, with its status from the source file. Pure view controls (chips, search, sort, column picker) are left out unless they are not WORKS.

---

### 1. Account (trading account)
- DB model: `Account` schema.prisma:599 (credit :611, maxDailyLoss :618, swapFree :680, chartSettings :719)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH 1) CLI | client list row joined to margin; KPIs ACTIVE TRADERS, NEW CLIENTS · 7D | chips PARTIAL (SUSPENDED includes CLOSED); row click → CLI WORKS; double-click DUPLICATE; ctx Open client 360 DUPLICATE; ctx Live exposure PARTIAL (no-position account lands unfiltered); ctx Deposits · withdrawals PARTIAL; ctx Wallet WORKS | bo-DASH DashboardScreen.cs:49-51, 229-239 |
| BO | CLI list | one row per account (incl. the COVERAGE hedge account) | + ACCOUNT PARTIAL (no account-type field; MANAGER leverage/initialBalance dropped silently); ctx Add new account DUPLICATE; chips PARTIAL (SUSPENDED = any non-ACTIVE; IB = IB's clients); ctx Live exposure WORKS; ctx Deposits WORKS; ctx Wallet PARTIAL (focus dropped if WAL not loaded); ctx Credit/debit, Change group, Leverage, Risk limits, Statement CSV, Reset password, Suspend/Activate all DUPLICATE (card) | bo-CLI ClientsScreen.cs:60-71, 141; accounts/route.ts:131, 165-167, 288-290; WalletsLeadsScreens.cs:57 |
| BO | CLI Client 360 card | card rows Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP (no equity) | CREDIT/DEBIT PARTIAL (toast shows empty balance); CHANGE GROUP PARTIAL (lists non-selectable groups, silently resets leverage); LEVERAGE WORKS; RISK LIMITS PARTIAL (any save clears maxDailyLoss; swap-free default wrong); STATEMENT CSV PARTIAL; RESET PASSWORD WORKS; SUSPEND/ACTIVATE WORKS (CLOSED not settable); EQ range chips WORKS; 5) NOTE PLACEHOLDER | bo-CLI ClientsScreen.cs:95, 282-304, 502-508; ApiClient.ManageG6.cs:72 |
| BO | NTF detail | PASSWORD_RESET_REQUESTED / MARGIN_CALL rows → account | OPEN → CLI WORKS for these types; RESET PASSWORD PARTIAL (e-mailed password: dialog shows no password and no mention of e-mail); ctx Reset trader password DUPLICATE | bo-NTF NotificationsAuditScreens.cs:91, 142-155 |
| BO | LAR | request → created account | Approve PARTIAL (creates Account; toast never shows number; two concurrent approvals can create two accounts); Open account WORKS | bo-LAR LiveAccountRequestsScreen.cs:72-86; live-account-requests/[id]/route.ts:32-38, 95-123, 167 |
| BO | TRX | FROM/TO lookup, balance before → after | TRANSFER WORKS (writes both balances) | bo-TRX TransfersScreen.cs:37, 83; transfers/route.ts:97-137 |
| BO | WAL | balance, credit, equity, free margin | double-click → CLI WORKS; ctx Live exposure / Deposits / Internal transfer WORKS | bo-WAL WalletsLeadsScreens.cs:31 |
| BO | RISK 2) MRG, MRG | margin row per account with open positions | double-click → CLI WORKS; ctx Live exposure WORKS; ctx Close all n positions PARTIAL (partial failures reported as success) | bo-RISK RiskScreen.cs:44, 148-153; bo-MRG RiskScreen.cs:138-153 |
| BO | RDR | 30-day behaviour row + same-IP clusters | double-click → CLI WORKS; ctx Live exposure WORKS; cluster account links PARTIAL (id key mismatch); FLAG · WHITELIST · NOTE PLACEHOLDER | bo-RDR LiquidityScreens.cs:309, 385-395; ApiClient.ManageG5.cs:61-63 |
| BO | DEAL 6) MODE / 5) COV | "Dealing-group accounts" list; coverage account strip | SET / CHANGE COVERAGE ACCOUNT UI-ONLY (local file only) | bo-DEAL DS:532-535, 594-600 |
| BO | EXP, DLS, DEP, APR, KYC, IB, TRX HIST, AUD, CRM | account number column / "Open client" menu | navigation to CLI WORKS in each | bo-EXP :184; bo-DLS DLS:97; bo-DEP :147; bo-APR; bo-KYC :51; bo-IB :35, 88; bo-TRX :31; bo-AUD :186; bo-CRM :93 |
| BO | RPT CLIENT report | CSV rows (incl. DEMO) | kind chip WORKS; SAVE CSV PARTIAL | bo-RPT reports/client/route.ts:14; IbReportsScreens.cs:190-198 |
| BO | SHELL search | accounts bucket | hit → CLI WORKS | bo-SHELL MainWindow.axaml.cs:272-284 |
| T | Shell top bar | ACCOUNT, mode, USER name, EQUITY USD, MARGIN LVL | display only | term-shell TopBar.axaml:77-117; term-account |
| T | 6) ACC panel | BALANCE, EQUITY, OPEN P/L, MARGIN USED, FREE MARGIN, DAY P/L, WEEK P/L + gauge | F7 refresh WORKS; panel has no other control | term-account T\MainWindow.axaml.cs:310; AccountPanel.axaml |
- Gaps:
  - Reset trader password: CLI card toasts "emailed to …" or shows the password (ClientsScreen.cs:453-467, WORKS); NTF shows "password reset." with neither (bo-NTF, PARTIAL).
  - No control sets an account to CLOSED (bo-CLI SUSPEND/ACTIVATE row) or changes an existing account's type (no field in + ACCOUNT or card, bo-CLI).
  - Per-account pricing overrides (GET/PATCH accounts/[id]/pricing) have no native screen; web only (endpoints.md §2).
  - Terminal has no change-password, 2FA setup or linked-accounts view; those routes are web only (endpoints.md §2: trade/change-password, two-factor/*, linked-accounts).
  - Terminal equity/margin apply no quote→account FX rate; server does (term-account S\Trading\AccountMath.cs:67-77 vs W\lib\margin.ts:67-74).

### 2. Client (portal user)
- DB model: `Client` schema.prisma:1239 (trader name/e-mail on trading accounts live on `Account`)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | KYC tab CLIENT PORTAL | ClientKycRecord row with client name | APPROVE / REJECT WORKS (see 14); ctx Open client 360 disabled for every portal row (no account link) | bo-KYC KycScreen.cs:48, 51 |
| BO | LAR | requesting client | Approve PARTIAL / Reject WORKS (see 15) | bo-LAR |
- Gaps:
  - No backoffice screen lists or opens Client records; CLI lists trading accounts only (bo-CLI accounts/route.ts:21-95).
  - Transfer "different clients" check is client-side by e-mail only; the server does not check it (bo-TRX TransfersScreen.cs:66-75 vs transfers/route.ts:57-102).
  - Terminal: none.

### 3. Position (open)
- DB model: `Position` schema.prisma:1811
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH 2) EXP | open book grouped by symbol; KPIs OPEN VOLUME, B-BOOK P/L | ctx Live exposure · this symbol PARTIAL (symbol never matches); ctx Symbol settings WORKS | bo-DASH DashboardScreen.cs:55, 154-160 |
| BO | EXP 3) POS | every open position of the broker (incl. coverage legs) | Modify SL / TP PARTIAL (no PositionModified publish); Close at market WORKS; Close part WORKS; Close by WORKS; Reverse PARTIAL (IN_PLACE skips coverage hook; maker-checker for MANAGER); Open client WORKS; double-click DUPLICATE; CLOSE BY SYMBOL DEAD (route requires accountId); EXP row "Close every position on this symbol" DUPLICATE + DEAD | bo-EXP LiveExposureScreen.cs:45, 51, 59, 174-184; close-bulk/route.ts:28-31; reverse/route.ts:68-77 |
| BO | EXP 1) EXP, 4) FEED | exposure per symbol; broker-wide activity feed | row click filters POS WORKS; ctx Filter positions DUPLICATE | bo-EXP :43-44 |
| BO | DEAL 7) GRP | dealing-group TRADES / EXPOSURE | ctx Live exposure / Open client WORKS | bo-DEAL DS:119 |
| BO | DEAL 10) SDM | UNBOOKED / BOOKED / CLOSED client positions | BOOK WORKS; BOOK ALL WORKS; UNBOOK WORKS; CLOSE WORKS; P/L chips PARTIAL (500-row cap) | bo-DEAL DS:716-729, 830, 867, 880-899 |
| BO | CLI 360 3) TRD | open rows of the account (NOW, P/L repriced) | ctx Open in Live exposure WORKS | bo-CLI ClientsScreen.cs:76-78 |
| BO | RISK 2) MRG, MRG | position count per account | ctx Close all n positions PARTIAL | bo-RISK RiskScreen.cs:153; bo-MRG |
| BO | LP 2) BOOK | open lots per symbol, A/B book | double-click PARTIAL (EXP ignores symbol); ctx Live exposure DUPLICATE; ctx Symbol settings WORKS | bo-LP LiquidityScreens.cs:64 |
| BO | SYM 1) LIM | net lots per symbol vs MAXIMUM EXPOSURE | view only (broker-wide net compared with a per-account gross cap) | bo-SYM SymbolsScreen.cs:114-116; lib/risk.ts:307-327 |
| BO | SHELL search | positions bucket | hit → EXP WORKS | bo-SHELL MainWindow.axaml.cs:272-284 |
| T | 4) TRADE tab | open positions with live CURRENT / PTS / P/L | CLOSE PROFIT / LOSS / ALL WORKS; BE WORKS; PART WORKS; MOD WORKS; SHARE WORKS; REV WORKS; ✕ WORKS; CANCEL (close awaiting dealer) WORKS; inline S/L · T/P PARTIAL (same value re-entry swallowed); COMMENT UI-ONLY (local only); ctx Close by WORKS; ctx Smart rules WORKS; ctx Modify / Close SYMBOL / Share DUPLICATE | term-positions PositionsPanel.axaml:187-253; PositionsPanel.axaml.cs:298-321 |
| T | Modify / Close window | one position | SL / TP fields PARTIAL (overwritten by 4 s refresh); MODIFY SL / TP WORKS; CLOSE POSITION / CLOSE PART WORKS | term-positions ModifyPositionWindow.axaml.cs:31, 38-43 |
| T | Share window | one position | SAVE PNG PARTIAL (no FX, account-currency label); COPY TEXT WORKS | term-positions ShareCard.cs:20-23 |
| T | 2) Chart | entry line + tag per position, SL/TP lines | drag SL/TP WORKS; drag from entry WORKS; ctx Set SL / Set TP PARTIAL (first 4 only); double-click line → Modify WORKS | term-chart CandleChartControl.cs:519-526, 694-727 |
| T | STM docked block | scoped positions | Break-even Apply WORKS; Partial close WORKS; Close profitable / losing / all WORKS | term-stm OrderTicketPanel.axaml:430-445 |
| T | 6) ACC panel | OPEN P/L | view | term-account |
- Gaps:
  - SL/TP modify by admin (EXP) publishes no PositionModified and writes AuditLog POSITION_SLTP_MODIFIED (bo-EXP positions/[id]/route.ts:88-113); trader modify publishes PositionModified and writes no AuditLog (term-positions, term-chart trade positions/[id]/route.ts:77-110).
  - Reverse: EXP uses the server reverse route (IN_PLACE / CLOSE_REOPEN, maker-checker for MANAGER) (bo-EXP reverse/route.ts:44-93); terminal REV = client-side close then a new MARKET order with no SL/TP, not opened when the close is queued (term-positions MarketDataService.cs:2040-2058).
  - Close by symbol: terminal bulk close WORKS (term-positions close-bulk/route.ts:35-101); EXP CLOSE BY SYMBOL is DEAD (bo-EXP close-bulk/route.ts:28-31).
  - Partial close lot-step check: manage close checks range only (bo-EXP close/route.ts:86); trade close checks lot step + remainder (term-positions close/route.ts:126-163).
  - Symbol focus from DASH, LP, FEED into EXP is ignored (LiveExposureScreen.cs:109-113).
  - Void on an open position: no native control (EXP menu has none, bo-EXP C; DLS Void only lists closed rows, see 6).

### 4. Coverage (hedge) position
- DB model: `Position` schema.prisma:1811 (covered :1875, coveragePositionId :1885), on the broker's coverage `Account`
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DEAL 5) COV | coverage TRADES / EXPOSURE / HISTORY | ✕ close WORKS; HISTORY FROM/TO WORKS; chips WORKS | bo-DEAL DS:1019, 1134-1136 |
| BO | DEAL chart | coverage legs on chart | Set SL / TP WORKS; drag SL/TP WORKS; double-click leg close WORKS; one-click SELL/BUY WORKS; Buy/Sell Limit/Stop @ price PLACEHOLDER | bo-DEAL DS:1205-1257 |
| BO | DEAL 8) TICKET | coverage order ticket | SELL / BUY WORKS; LIMIT / STOP PLACEHOLDER | bo-DEAL DS:1325-1336 |
| BO | DEAL 10) SDM | booked leg per client position | BOOK / BOOK ALL / UNBOOK / CLOSE WORKS | bo-DEAL DS:830-899 |
| BO | EXP | listed with client positions, not marked | same actions as client positions (see 3) | bo-EXP B "Included rows" |
- Gaps:
  - EXP, DASH KPI and CLI list count coverage legs / the coverage account as client data (bo-EXP B; bo-CLI accounts/route.ts:28-29).
  - Coverage orders and BOOK skip margin / lot-step / halt checks (bo-DEAL coverage/orders/route.ts:57-66; book/route.ts:43-70).
  - Auto-hedge is not applied to fills made by the desk-toggle flush (bo-DEAL dealing-desk-toggle/route.ts:261).

### 5. Order (pending / dealer queue)
- DB model: `Order` schema.prisma:1756
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH KPI | DEALER QUEUE count + oldest age | view | bo-DASH DashboardScreen.cs:124-147 |
| BO | DEAL 2) QUEUE | pending / requoted MARKET orders and queued closes; resting LIMIT/STOP | ACCEPT ALL PARTIAL (says "at market", fills at requested); REJECT ALL WORKS; ACCEPT ▾ Requested WORKS; ACCEPT ▾ Market WORKS; REQUOTE +1/+2/+3 PARTIAL (wrong direction on queued BUY close); REQUOTE custom WORKS; REJECT DEAD (empty reason → 400); WITHDRAW DEAD; CANCEL (resting) PLACEHOLDER; ctx Open client / Live exposure WORKS | bo-DEAL DS:338-342, 399-443, 464; dealing-queue/[id]/route.ts:99-101 |
| BO | DEAL 3) ACT | dealing activity feed | view | bo-DEAL DS:486 |
| BO | AUD | "Order" audit rows | OPEN PARTIAL (opens EXP with an order id EXP cannot match) | bo-AUD NotificationsAuditScreens.cs:229, 251-257 |
| BO | SHELL search | orders bucket | hit → CLI (account) WORKS | bo-SHELL |
| T | 3) OT ticket | MARKET / LIMIT / STOP | SELL / BUY WORKS; EXPIRY UI-ONLY (never sent) | term-ticket OrderTicketPanel.axaml:280-318 |
| T | F9 New Order | same fields + SLIPPAGE MAX | SELL / BUY WORKS; EXPIRY UI-ONLY; hint line DEAD; prefill side/type/price DEAD | term-neworder NewOrderWindow.axaml:41-115; NewOrderWindow.axaml.cs:35-41 |
| T | 2) Chart | one-click widget; right-click pending entries | one-click SELL / BUY WORKS; Buy/Sell Limit/Stop @ price PARTIAL (volume always 0.01; side gated on bid) | term-chart CandleChartControl.cs:507-516; MainViewModel.cs:15 |
| T | STM hotkeys | MARKET order on key press | hotkey press PARTIAL (block SL/TP not sent; no STM_HOTKEY_ORDER audit) | term-stm MainWindow.axaml.cs:329-337 |
| T | PENDING tab | resting, dealer-queued, queued closes, requotes | ✕ cancel WORKS; ✓ accept requote WORKS; ✕ REJECT requote WORKS | term-tabs PositionsPanel.axaml:303-308 |
| T | ORDERS tab | order log, all statuses (≤500) | rows PARTIAL (only refreshed at sign-in and after a ticket order) | term-tabs MarketDataService.cs:1073, 1774 |
| T | Market Watch | — | double-click / ctx New order opens F9 WORKS | term-marketwatch MainWindow.axaml.cs:231 |
- Gaps:
  - Dealer reject: row REJECT is DEAD (sends empty reason, DS:442); REJECT ALL prompts a reason and WORKS (DS:419).
  - No backoffice cancel of a resting LIMIT/STOP (no manage cancel route; bo-DEAL DS:464).
  - Terminal cannot modify a pending order; PATCH trade/orders/[id] is web only (term-ticket orders/[id]/route.ts:25; endpoints.md §2).
  - LIMIT/STOP fill only while a terminal/WebTrader is connected and sees the trigger (term-ticket MarketDataService.cs:809-820; engine reads `orders` status ACCEPTED, engine/order-management/src/db.rs:587-588).
  - Order entry paths differ: ticket/F9 confirm per setting; one-click confirm only when 1-click OFF; hotkeys never confirm and drop SL/TP; chart pending orders skip client volume/price-side validation (term-ticket "Entry paths").

### 6. Deal (closed trade)
- DB model: `Position` schema.prisma:1811 with status CLOSED / VOIDED
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH KPI | REALIZED TODAY | view | bo-DASH DashboardScreen.cs:124-147 |
| BO | DLS | latest 500 CLOSED/VOIDED of the broker | Replay fill WORKS; Open client WORKS; Void deal DEAD (server needs OPEN); Delete deal WORKS (maker-checker for MANAGER); double-click DUPLICATE (Delete); "DELETE" cell UI-ONLY | bo-DLS DLS:38-39, 87, 97-126; lib/position-actions.ts:47-57, 502-503 |
| BO | CLI 360 3) TRD | account's closed rows (from broker-wide latest 500) | ctx Open in Deals WORKS; STATEMENT CSV PARTIAL (500 cap) | bo-CLI ClientsScreen.cs:79, 258, 516-529 |
| BO | DEAL 7) GRP / 5) COV HISTORY, 10) SDM | closed trades by range | GRP FROM/TO PARTIAL (dealer-on counts every account); COV FROM/TO WORKS; SDM P/L chips PARTIAL (500 cap) | bo-DEAL DS:611-616, 673, 716-729, 1019 |
| BO | RPT TRADING | CSV, 30 d LIVE closed | kind chip WORKS; RANGE PARTIAL; SAVE CSV PARTIAL | bo-RPT IbReportsScreens.cs:141-198 |
| BO | RDR | 30-day closed-trade statistics | view | bo-RDR lib/risk-radar.ts:120-160 |
| T | HISTORY tab | all closed positions of the account | range chips WORKS; FROM/TO WORKS; SYMBOL WORKS; STATEMENT ⤓ WORKS; row Share WORKS | term-tabs PositionsPanel.axaml:366-385 |
| T | 6) ACC panel | DAY / WEEK P/L | view | term-account MarketDataService.cs:1609-1615 |
- Gaps:
  - Backoffice closed-trade lists stop at the latest 500 broker-wide (deals/route.ts:71); terminal HISTORY is unbounded (history/route.ts:5-37).
  - Void: DLS offers it only on closed rows where it cannot succeed (bo-DLS); no screen offers Void on an open position (bo-EXP C).

### 7. Position action request (maker-checker)
- DB model: `PositionActionRequest` schema.prisma:1933
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DLS | filed by "Delete deal…" (MANAGER) | Delete deal WORKS → row "DELETE PENDING" | bo-DLS delete/route.ts:30-39 |
| BO | EXP | filed by "Reverse…" (MANAGER) | Reverse PARTIAL (reason stored null) | bo-EXP reverse/route.ts:44-50 |
| BO | APR 2) POS | DELETE / VOID / REVERSE requests | ACTIONS double-click approve WORKS; ctx Approve DUPLICATE; ctx Reject WORKS; ctx Open client WORKS; TICKET column always "—" | bo-APR ApiClient.ManageG6.cs:35; position-action-requests/route.ts:23-35 |
| BO | SHELL | nav badge APR | view | bo-SHELL; bo-APR MainWindow.axaml.cs:199 |
- Gaps:
  - A broker whose staff is one MANAGER only can file requests that can never be approved (bo-APR "Single-admin broker").
  - Void requests can be filed by MANAGER only for OPEN positions, and no screen offers Void on one (see 6).

### 8. Balance adjustment (credit / debit)
- DB model: `Transaction` schema.prisma:1402 type ADJUSTMENT; `BalanceAdjustmentRequest` schema.prisma:1976
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CLI 360 card | CREDIT / DEBIT button | CREDIT / DEBIT PARTIAL (MANAGER files a request; toast value empty) | bo-CLI ClientsScreen.cs:297, 477-485 |
| BO | CLI 360 4) LED | ledger row | row click PARTIAL (every type opens DEP, which lists only deposits/withdrawals) | bo-CLI ClientsScreen.cs:93, 335 |
| BO | APR 1) BAL | pending requests | approve WORKS; ctx Approve DUPLICATE; ctx Reject WORKS; ctx Open client WORKS | bo-APR ApprovalsMirrorScreens.cs:33, 96 |
| T | BALANCE tab | ADJUSTMENT row | rows PARTIAL (empty after sign-in until a balance event or a close) | term-tabs MarketDataService.cs:1041-1087 |
- Gaps:
  - CREDIT / DEBIT writes Account.balance only; no native control writes Account.credit (bo-CLI lib/balance-adjustment.ts:46-86), though WAL and CLI show credit.
  - A debit has no floor (balance may go below 0 or below used margin) (bo-CLI balance-adjustment.ts:51-53).

### 9. Deposit
- DB model: `Transaction` schema.prisma:1402 type DEPOSIT (enum :99)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | KPIs NET DEPOSITS · 7D, DEPOSITS · 30D; 3) APPR queue; 4) FLOW chart | APPR row click → DEP WORKS; double-click / ctx DUPLICATE; ctx Open client WORKS | bo-DASH DashboardScreen.cs:59-61, 182-191 |
| BO | DEP | request row (≤200) + 8 KPI tiles | Approve · complete the deposit WORKS; Reject PARTIAL (trader note overwritten/erased); double-click DUPLICATE; Open client WORKS | bo-DEP FundsScreen.cs:41, 143-163; funds-requests/[id]/route.ts:49, 68 |
| BO | CLI 360 LED, WAL, CLI list ctx | ledger row; ctx "Deposits · withdrawals" | navigation WORKS / LED row click PARTIAL | bo-CLI; bo-WAL |
| BO | RPT FINANCIAL | CSV row | view (SAVE CSV PARTIAL) | bo-RPT |
| BO | NTF | FUNDS_REQUEST → DEP | OPEN WORKS | bo-NTF FundsScreen.cs:91 |
| BO | SHELL search | transactions bucket → DEP | WORKS | bo-SHELL |
| T | BALANCE tab | DEPOSIT row | rows PARTIAL (not loaded at sign-in) | term-tabs |
- Gaps:
  - Terminal cannot submit a deposit/withdrawal request; POST trade/funds-requests is web only (endpoints.md §2).
  - Approve / reject send no notification to the trader (bo-DEP).

### 10. Withdrawal
- DB model: `Transaction` schema.prisma:1402 type WITHDRAWAL (amount stored negative)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | KPI WITHDRAWALS · PENDING; 3) APPR queue | as deposit | bo-DASH |
| BO | DEP | request row | Mark for approval (maker) WORKS; Confirm · complete (checker) WORKS; Cancel my mark WORKS (server accepts from any admin); Reject PARTIAL; double-click DUPLICATE | bo-DEP FundsScreen.cs:109-163; lib/funds-approval.ts:33-35, 66-80 |
| T | BALANCE tab | WITHDRAWAL row | rows PARTIAL | term-tabs |
- Gaps:
  - Confirm has no free-margin / open-position check (bo-DEP lib/funds-approval.ts:127-132).
  - DEP shows the stored negative amount unchanged (bo-DEP B).
  - Terminal cannot request a withdrawal (endpoints.md §2).

### 11. Internal transfer
- DB model: `Transaction` schema.prisma:1402 types TRANSFER_OUT / TRANSFER_IN (enum :114-115)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | TRX | form + last 200 legs | PREVIEW WORKS (stale balances possible); TRANSFER WORKS; HIST double-click WORKS; ctx Open client DUPLICATE; ctx Use as FROM / TO WORKS | bo-TRX TransfersScreen.cs:31-37, 60-85 |
| BO | WAL | — | ctx Internal transfer (prefills FROM) WORKS | bo-WAL TransfersScreen.cs:59 |
| BO | CLI 360 LED | ledger row | row click PARTIAL (opens DEP) | bo-CLI |
- Gaps:
  - Terminal BALANCE tab never shows transfers: trade/transactions returns DEPOSIT, WITHDRAWAL, CREDIT, ADJUSTMENT, NEGATIVE_BALANCE_PROTECTION only (W\app\api\trade\transactions\route.ts:12-18).
  - Same-client check is client-side only (bo-TRX).

### 12. Wallet (account balance view)
- DB model: none; `Account.balance` / `credit` schema.prisma:611 + computed margin. `SavedWithdrawalAddress` schema.prisma:1532 appears in no bo-/term- file.
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | WAL | balance, credit, equity, free margin, floating P/L per account | chips / search WORKS; navigation to CLI / EXP / DEP / TRX WORKS; no write | bo-WAL |
| BO | DASH / CLI | ctx "Wallet" | DASH WORKS; CLI PARTIAL (focus dropped if WAL not loaded) | bo-DASH; bo-CLI WalletsLeadsScreens.cs:57 |
| T | 6) ACC panel, top bar | balance / equity / free margin | view | term-account |
- Gaps: WAL margin failure shows "—" silently (bo-WAL B).

### 13. Payment method (PSP)
- DB model: `PaymentMethod` schema.prisma:1499
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | PSP | 5 fixed rows | inline edits WORKS; ENABLED WORKS; ACTIONS SAVE PARTIAL (no audit); ctx Save DUPLICATE; ctx Revert WORKS; ctx Enable/Disable DUPLICATE | bo-PSP PaymentMethodsScreen.cs:66-103; payment-methods/route.ts:123-131 |
| BO | CFG | "PER METHOD · PSP" link | WORKS | bo-CFG SettingsScreen.cs:55 |
- Gaps:
  - Nav shows PSP to every role; routes are BROKER_ADMIN only (bo-PSP payment-methods/route.ts:29).
  - Fee is display-only, never deducted (bo-PSP lib/psp/adapter.ts:108-121).
  - Terminal: none (trade/payment-methods web only, endpoints.md §2).

### 14. KYC record / document
- DB model: `KycRecord` schema.prisma:1204 (in-app, per account); `ClientKycRecord` schema.prisma:1318 (portal, per client)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | KYC | two queues + document tiles | row click WORKS; ctx Review DUPLICATE; ctx Approve / Reject DUPLICATE; document tile WORKS (PDF never viewable); APPROVE WORKS; REJECT WORKS; ctx Open client 360 WORKS (IN-APP only) | bo-KYC KycScreen.cs:43-51, 140-234 |
| BO | CLI + ACCOUNT | optional KYC upload at account creation | part of + ACCOUNT PARTIAL | bo-CLI ApiClient.ManageG6.cs:100-112 |
| BO | CLI / DASH | chip KYC WAIT; DASH note "KYC WAIT" | view | bo-CLI; bo-DASH |
| BO | NTF | KYC_SUBMITTED / CLIENT_KYC_SUBMITTED | REVIEW KYC WORKS | bo-NTF KycScreen.cs:75 |
| BO | SHELL | nav badge KYC | view | bo-SHELL |
- Gaps:
  - An APPROVED in-app KycRecord is read by no trading or funds path (bo-KYC accounts/route.ts:89, dashboard/route.ts:62).
  - Decisions send no notification or e-mail (bo-KYC lib/kyc-decision.ts).
  - Terminal: none (trade/kyc web only, endpoints.md §2).

### 15. Live account request
- DB model: `LiveAccountRequest` schema.prisma:1366
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | LAR | request row | chips WORKS; Approve PARTIAL; double-click DUPLICATE; Reject WORKS; Open account WORKS | bo-LAR LiveAccountRequestsScreen.cs:32, 72-90 |
| BO | DASH | NEW CLIENTS note "{n} ACCOUNT REQUESTS" | view | bo-DASH |
| BO | NTF | LIVE_ACCOUNT_REQUESTED → LAR | OPEN PARTIAL (FocusRecord ignores the id) | bo-NTF LiveAccountRequestsScreen.cs:50 |
| BO | SHELL | nav badge LAR | view | bo-SHELL |
- Gaps: Terminal: none (portal only).

### 16. Lead (CRM)
- DB model: `Lead` schema.prisma:920
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CRM | lead row | + LEAD WORKS; ctx Add DUPLICATE; double-click (converted) WORKS; Mark NEW/CONTACTED/QUALIFIED/LOST WORKS; Mark CONVERTED → account WORKS | bo-CRM WalletsLeadsScreens.cs:93-142 |
| BO | NTF | NEW_LEAD → CRM | OPEN PARTIAL (no FocusRecord on CRM) | bo-NTF |
- Gaps:
  - No AuditLog on any lead write (bo-CRM leads/route.ts:45-75; leads/[id]/route.ts:20-61).
  - Lead.notes and un-converting have no control (bo-CRM).

### 17. IB relationship / commission
- DB model: `IbRelationship` schema.prisma:2133; payout = `Transaction` type COMMISSION
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | IB | partners grouped per IB + detail + referred clients | PAYOUT RUN WORKS; + PARTNER WORKS; PAY WORKS; EDIT PLAN PARTIAL (re-prices unpaid trades); referred-client double-click pay WORKS; ctx Open IB account / Open client WORKS; ctx Add / Pay / Edit / Referred DUPLICATE; ACTIONS "PAY" UI-ONLY; MTD columns PLACEHOLDER; Sub-IB / FUNNEL PLACEHOLDER | bo-IB IbReportsScreens.cs:31-114; lib/commission.ts:18-37 |
| BO | RPT IB | CSV with pending commission | view | bo-RPT reports/ib/route.ts:7 |
| BO | CLI list | chip IB | PARTIAL (filters IB's clients, not IB accounts) | bo-CLI accounts/route.ts:85 |
| BO | AUD | IbRelationship rows | OPEN PARTIAL (entity type never matches) | bo-AUD |
- Gaps: Commission payouts (COMMISSION) are not in the terminal BALANCE tab (W\app\api\trade\transactions\route.ts:12-18).

### 18. Staff user (team member)
- DB model: `AdminUser` schema.prisma:515 (role enum `AdminRole` :57; extraPermissions :531)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | USR | staff table + role matrix + member editor | + INVITE WORKS; CREATE PARTIAL (default SUPPORT cannot open the backoffice); DISABLE ACCESS WORKS; RE-ACTIVATE WORKS; matrix cell / SAVE / REVERT WORKS; editor toggles, SAVE PERMISSIONS, REVERT DUPLICATE; ctx Edit / Disable / Re-activate DUPLICATE; ACTIONS words UI-ONLY; 2FA · devices · IPs PLACEHOLDER; PASSWORD RESET · ROLE CHANGE PLACEHOLDER | bo-USR TeamScreen.cs:39-243 |
| BO | SEC | this sign-in (e-mail, role, 2FA used) | REQUEST PASSWORD RESET PARTIAL; 2FA, passkeys, sessions, API keys, IP allowlist, org policy PLACEHOLDER | bo-SEC SecurityEmergencyScreens.cs:52-77 |
| BO | SHELL login | sign-in | SIGN IN PARTIAL (SUPPORT fails at shell-info); Forgot password PARTIAL | bo-SHELL BackofficeSession.cs:54-55 |
| BO | NTF | ADMIN_PASSWORD_RESET_REQUESTED → USR | OPEN lands on a staff member with reset "not available yet" | bo-NTF TeamScreen.cs:179 |
| BO | AUD | actor e-mail; AdminUser rows | search by actor e-mail returns nothing (PARTIAL); OPEN PARTIAL | bo-AUD route.ts:31-40 |
- Gaps:
  - Staff password reset exists only for SUPER_ADMIN (app/api/admin/admins/[id]/reset-password/route.ts:13); the backoffice files requests nobody in the broker can act on (bo-SEC, bo-SHELL).
  - Role change: no control (bo-USR :179). No DEALER role exists (bo-USR schema.prisma:57-66).

### 19. Audit log entry
- DB model: `AuditLog` schema.prisma:2160
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | AUD | last 200, diff pane | search PARTIAL (entityId / order / account number only); SAVE CSV WORKS; OPEN PARTIAL (PascalCase entity types never match); ctx Open client WORKS; double-click / ctx DUPLICATE | bo-AUD NotificationsAuditScreens.cs:184-270 |
| BO | DASH 5) ACT | last 15 | view | bo-DASH route.ts:70-75 |
| BO | DEAL 3) ACT | rows whose label starts "Dealing" | view | bo-DEAL DS:216 |
| BO | DLS Replay | up to 8 audit lines | view | bo-DLS DLS:111-121 |
| T | LOG tab | server rows merged with local journal | rows PARTIAL (server rows only at sign-in; rows older than 24 h get a wrong date) | term-tabs MarketDataService.cs:1075; term-hotkeys-sounds DockViewModels.cs:310-317 |
- Gaps (writes that create no AuditLog, per source files): lead writes (bo-CRM), LP notes (bo-LP :38), LP routing rules (bo-ROUTE), symbol sessions (bo-SYM sessions/route.ts:77-80), payment methods (bo-PSP), CFG settings (bo-CFG settings/route.ts:75), trader SL/TP modify (term-chart), price alerts (term-alerts), watchlist (term-marketwatch), staff forgot-password (bo-SEC).

### 20. Notification
- DB model: `Notification` schema.prisma:2235
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | NTF | broker inbox, last 100, shared read state | MARK ALL READ WORKS; MARK READ WORKS; OPEN {CODE} PARTIAL (MirrorRule, PriceAlert, closed positions, LAR/CRM/DEAL focus); RESET PASSWORD PARTIAL; ctx DUPLICATE | bo-NTF NotificationsAuditScreens.cs:89-163 |
| BO | SHELL | bell count, nav badge | bell DUPLICATE (nav NTF) | bo-SHELL MainWindow.axaml.cs:303 |
- Gaps:
  - Trader-scoped rows (PRICE_ALERT_TRIGGERED, trader copy of MARGIN_CALL) appear in the staff inbox (bo-NTF notifications/route.ts:21).
  - Terminal has no notification list; trader events reach it only as LOG lines / sounds (term-hotkeys-sounds A).

### 21. Price alert
- DB model: `PriceAlert` schema.prisma:888
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Alerts dialog (F8) | ACTIVE alerts only | SYMBOL picker PARTIAL (hint keeps old symbol); ABOVE/BELOW WORKS; ADD WORKS; ✕ CANCEL WORKS; confirm WORKS | term-alerts AlertsWindow.axaml.cs:37-102 |
| T | 2) Chart | right-click Alert above/below | WORKS (list not refreshed, no LOG entry) | term-chart CandleChartControl.cs:527 |
| T | LOG tab | "Alert triggered …" line | view (no sound, popup or marker) | term-alerts MarketDataService.cs:303 |
| BO | DEAL chart | right-click Alert above/below | PLACEHOLDER | bo-DEAL DS:1215 |
| BO | NTF | PRICE_ALERT_TRIGGERED row | OPEN: no screen (PARTIAL) | bo-NTF |
| BO | FEED | PRICE ALERTS tile (engine reachability) | view | bo-FEED LiquidityScreens.cs:247-248 |
- Gaps: TRIGGERED / CANCELLED / EXPIRED alerts are never listed in the terminal (term-alerts alerts/route.ts:14-30). Backoffice has no alert list for any account.

### 22. Smart Trade Manager rule
- DB model: none. Client memory + `%APPDATA%\VyxTrader\smart-rules-state.json` (term-stm SmartRulesEngine.cs:21, 45-48)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | STM docked block | ENABLED pill, hotkeys, bulk actions | pill PARTIAL (does not stop armed rules); BUY/SELL HOTKEY WORKS; hotkey press PARTIAL; LOT SIZE DUPLICATE; SL/TP PARTIAL; SMART EXECUTION rows DEAD; SmartRulesRequested event DEAD | term-stm OrderTicketPanel.axaml:373-449; SmartRulesEngine.cs:104-117 |
| T | Smart rules window | per-position rules | BREAK-EVEN rule PARTIAL (retries every tick); PARTIAL AT TP1 PARTIAL (re-fires after failure); TRAILING STOP WORKS; ARM WORKS; DISARM WORKS; BREAK-EVEN NOW / CLOSE % / CLOSE DUPLICATE | term-stm SmartRules.cs:67-94; SmartRulesEngine.cs:139-141 |
| T | TRADE tab | ctx Smart rules … | WORKS | term-positions PositionsPanel.axaml.cs:79 |
| T | Shell | close ✕ / update pill | close ✕ PARTIAL (no confirm with armed rules); update confirm warns rules go off WORKS | term-shell MainWindow.axaml.cs:254, 288 |
- Gaps: Rules run only while the terminal process runs and receives ticks (term-stm B). Marker file is not scoped per host/account (term-stm B). Backoffice: none.

### 23. Liquidity provider
- DB model: `LiquidityProvider` schema.prisma:2282
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | LP | provider records | + LP WORKS; ctx Add DUPLICATE; Status ×4 WORKS; Notes WORKS (no audit); double-click → ROUTE DUPLICATE; ROUTING WORKS | bo-LP LiquidityScreens.cs:62-66 |
| BO | ROUTE detail | LP name | OPEN LP WORKS | bo-ROUTE :186 |
| BO | RPT LP | CSV (BROKER_ADMIN only) | view | bo-RPT reports/lp/route.ts:13 |
| BO | DASH 2) EXP | "LP fill quality · PENDING · NEEDS LP BRIDGE" static | none | bo-DASH |
- Gaps: No execution path reads LP records (bo-LP; bo-ROUTE A). Nav shows LP to MANAGER; routes BROKER_ADMIN only, MANAGER sees only an error (bo-LP :76). AUD cannot open LiquidityProvider rows (bo-AUD).

### 24. LP routing rule
- DB model: `LpRoutingRule` schema.prisma:2305
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | ROUTE | rule list + selected rule | + RULE WORKS (no audit); ctx Add DUPLICATE; row click WORKS; ctx Delete rule WORKS (no audit); CONDITIONS · EDIT / DELETE PLACEHOLDER | bo-ROUTE LiquidityScreens.cs:151-186 |
| BO | LP | fetched every refresh, not displayed | none | bo-LP :57, 73 |
- Gaps: No execution path reads LpRoutingRule; fills route by Group.category (bo-ROUTE A, trade/orders/route.ts:383, 593). No edit control; delete only.

### 25. Trading halt / close-only / symbol disable
- DB model: `Broker.tradingHaltedAt` :339, `Broker.closeOnlyAt` :351; `Group.tradingHaltedAt` :979, `Group.closeOnlyAt` :987; `BrokerSymbol.enabled` :1696
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | EMG | broker halt, broker close-only, groups table, symbols table | HALT ALL / RESUME WORKS; CLOSE-ONLY / RESUME WORKS; group HALT/RESUME DUPLICATE (works); symbol HALT/RE-ENABLE PARTIAL (400 below hedged-margin floor); ACTIONS text single click UI-ONLY; KICK ALL CLIENT SESSIONS PLACEHOLDER | bo-EMG SecurityEmergencyScreens.cs:95-177 |
| BO | GRP | row menu | Halt / Resume trading DUPLICATE (EMG) | bo-GRP GroupsScreen.cs:146-154 |
| BO | DEAL 9) PANIC | dealing groups | HALT DEALING GROUP WORKS; CLOSE-ONLY WORKS; RESUME WORKS | bo-DEAL DS:1397-1398 |
| BO | RISK TRADING STATE | Trading HALTED/OPEN, Close-only ON/OFF | display + EMERGENCY link WORKS | bo-RISK RiskScreen.cs:103-104 |
| BO | SYM | ENABLED column | double-click stage WORKS; SAVE WORKS | bo-SYM SymbolsScreen.cs:126 |
| BO | AUD | Broker halt rows | OPEN PARTIAL (opens CFG, not EMG) | bo-AUD |
| T | — | not shown | none; trader learns from the server rejection | term-ticket validation matrix (Halted / Close-only: client none) |
- Gaps:
  - Per-group close-only is writable only on DEAL; EMG groups table shows no close-only state (bo-EMG last line; ManageG2.cs:136).
  - Symbol disable: SYM SAVE WORKS; EMG toggle PARTIAL on symbols below the hedged floor (bo-EMG symbols/route.ts:166-167).
  - EMG symbol toggle is gated MANAGER/BROKER_ADMIN without EMERGENCY_CONTROLS; broker/group halt require EMERGENCY_CONTROLS (bo-EMG symbols/route.ts:34-40 vs halt/route.ts:18).

### 26. Dealer mode / auto-fill / auto-hedge / smart dealer
- DB model: `Broker.dealingModeAt` :359, `autoHedgeAt` :381, `dealingDeskAutoFillAt` :382, `smartDealerAcceptPct` :389, `defaultMaxSlippagePips` :399
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DEAL 6) MODE | dealer on / auto-fill, auto-hedge, max slippage, smart dealer (read-only) | SWITCH TO AUTO-FILL / DEALER ON PARTIAL (flushed fills not hedged); TURN AUTO-HEDGE ON/OFF PARTIAL; MAX SLIPPAGE EDIT PARTIAL (0 refused by server); ⚙ SAVE PARTIAL (clears slippage cap) | bo-DEAL DS:445-600; dealing-desk-toggle/route.ts:261 |
| BO | RISK 1) RISK | DEALING MODE, smart dealer % | Manual dealing TURN ON/OFF PARTIAL; Smart dealer EDIT WORKS | bo-RISK RiskScreen.cs:83-89; lib/dealing-routing.ts:10-13 |
| BO | GRP header | DESK stat | view | bo-GRP dealing-desk-toggle/route.ts:40-48 |
| BO | EMG 2) | "manual dealing" row | RISK › link WORKS | bo-EMG :139 |
| BO | CFG | "Max slippage — not available yet" | PLACEHOLDER | bo-CFG SettingsScreen.cs:53 |
- Gaps:
  - Two switches write two different fields (DEAL → dealingDeskAutoFillAt; RISK → dealingModeAt) (bo-DEAL "Where dealer mode … can be toggled"; bo-RISK).
  - Max slippage: editable on DEAL, PLACEHOLDER on CFG (bo-CFG :53 vs bo-DEAL DS:567).
  - Terminal: dealer mode not shown before sending; message after the fact (term-ticket MarketDataService.cs:1768-1770).

### 27. Risk limits (broker / account / symbol caps)
- DB model: `Broker.maxOpenPositionsPerAccount` :334, `totalExposureLimit` :402; `Account.maxDailyLoss` :618; `BrokerSymbol.maxExposure` :1709; `MirrorRule.maxDailyLoss` :2080
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RISK | limits rows, KPI strip | Limits EDIT PARTIAL (called USD, enforced in lots; one number clears the other) | bo-RISK RiskScreen.cs:98-100; lib/risk.ts:330-347 |
| BO | EXP 2) LIM | risk-limit strip | EDIT ON RISK WORKS | bo-EXP :57, 93 |
| BO | DASH 2) EXP | NET $ EXP vs totalExposureLimit | view | bo-DASH |
| BO | CLI 360 | RISK LIMITS form | PARTIAL (clears maxDailyLoss on any save) | bo-CLI ClientsScreen.cs:502-508 |
| BO | SYM | MAXIMUM EXPOSURE cell; 1) LIM panel | inline edit WORKS; LIM panel semantics differ from server | bo-SYM SymbolsScreen.cs:114-116 |
| BO | MIR | maxOpenLots / maxDailyLoss at creation | set at + RULE WORKS; no edit afterwards | bo-MIR mirror-rules/[id]/route.ts:190-205 |
| T | — | not shown | none; server rejection only | term-ticket validation matrix |
- Gaps: CLI list does not parse maxDailyLoss (bo-CLI ApiClient.ManageG1.cs:38-40), so the form never shows the current value.

### 28. Margin snapshot (computed)
- DB model: none; `lib/margin.ts` computeAccountMarginSnapshots (server), `S\Trading\AccountMath.cs` (terminal)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | DASH | MARGIN CALLS KPI, NEAREST STOP-OUT | view | bo-DASH |
| BO | RISK, MRG | margin watch, lowest level first | see 1 (navigation, close all) | bo-RISK; bo-MRG |
| BO | WAL | equity / free / P/L | view | bo-WAL |
| T | 6) ACC panel, top bar | EQUITY, MARGIN USED, FREE MARGIN, level, CALL % | view; F7 WORKS | term-account |
- Gaps: RISK KPI "OPEN EXPOSURE · USD NOTIONAL" sums lots (bo-RISK lib/margin.ts:65). Terminal computes without FX (term-account).

### 29. Risk radar flag (computed)
- DB model: none; `lib/risk-radar.ts` (from closed positions + `LoginEvent` schema.prisma:2192)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RDR | flags per account, same-IP clusters | chips WORKS; NEWS chip PLACEHOLDER (flag hard-coded false); OPEN CLIENT / EXPOSURE DUPLICATE; FLAG · WHITELIST · NOTE PLACEHOLDER | bo-RDR lib/risk-radar.ts:116; LiquidityScreens.cs:385-387 |
| BO | SHELL | nav badge RDR | view | bo-RDR MainWindow.axaml.cs:201 |
- Gaps: A flag cannot be stored, cleared or whitelisted anywhere (bo-RDR :387).

### 30. Symbol (+ broker config, trading sessions)
- DB model: `Symbol` schema.prisma:1549; `BrokerSymbol` :1668; `TradingSession` :1739
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | SYM | config grid + exposure limits | inline edits WORKS; hedged < 50 confirm WORKS; ENABLED WORKS; TRADING MODE WORKS; SESSIONS PARTIAL (empty ≠ 24/7; no audit); DISCARD / SAVE CHANGES WORKS; ctx Trading sessions / Enable-Disable DUPLICATE; ctx Revert WORKS | bo-SYM SymbolsScreen.cs:48-211 |
| BO | GRP / ATY 2) PRC | per-symbol pricing override | see 32 / 33 | bo-GRP; bo-ATY |
| BO | GRP | Allowed symbols dialog | WORKS | bo-GRP |
| BO | EMG 4) SYMBOLS | disable one symbol | PARTIAL (see 25); search WORKS | bo-EMG |
| BO | DEAL 1) MW + chart | watchlist rows, candles | row click / double-click / + ADD / ctx items WORKS; Specification opens SYM WORKS | bo-DEAL DS:173-174 |
| BO | FEED 4) SYM | per-symbol tick freshness | double-click → SYM WORKS; ctx Symbol settings DUPLICATE; ctx Live exposure PARTIAL | bo-FEED LiquidityScreens.cs:203-204 |
| BO | DASH, EXP, LP | ctx "Symbol settings" | WORKS | bo-DASH; bo-EXP; bo-LP |
| BO | SHELL search | symbols bucket → SYM | WORKS | bo-SHELL |
| T | 1) Market Watch | row per watchlist symbol | search PARTIAL; row click WORKS; double-click WORKS; ctx Specification PARTIAL (no trading hours, pip/margin labels); Columns ▸ Change % PARTIAL (not persisted); Spread / High-Low WORKS | term-marketwatch MarketWatchView.axaml.cs:28-85; MainWindow.axaml.cs:223-231 |
| T | Tape | price / CHG% | click → chart WORKS | term-shell Tape.axaml.cs:37-40 |
| T | 3) OT / F9 | SYMBOL ▾ | WORKS (group-restricted symbols still listed) | term-ticket OrderTicketPanel.axaml:218-242; term-neworder |
| T | 2) Chart | active symbol, grid cell symbol ▾ | WORKS | term-chart |
| T | Alerts | SYMBOL picker | PARTIAL | term-alerts |
- Gaps:
  - Terminal /symbols is not filtered by group allowed symbols and sends no tradingMode (term-ticket symbols/route.ts:14-45).
  - MW spread excludes the BUY markup; ticket BUY price includes it (term-marketwatch MarketWatchViewModel.cs:88 vs OrderTicketViewModel.cs:64).
  - Symbol focus from DASH / LP / FEED into EXP is ignored (bo-DASH, bo-LP, bo-FEED; LiveExposureScreen.cs:109-113).

### 31. Watchlist item
- DB model: `WatchlistItem` schema.prisma:1580 (terminal); backoffice watchlist is local `BackofficeSettings.DealingWatchlist`
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 1) Market Watch | rows | + ADD item WORKS; ctx Add symbol WORKS; ctx Remove PARTIAL (removing the last row re-seeds 10 defaults) | term-marketwatch lib/watchlist.ts:66-67 |
| T | Tape | GridCandidates (watchlist first) | view | term-shell |
| BO | DEAL 1) MW | local watchlist | + ADD WORKS; Remove WORKS (local only) | bo-DEAL DealingMarketWatch.cs:97-105 |
- Gaps: Reorder and collapsed categories are web only (term-marketwatch; endpoints.md §2 watchlist/reorder, collapsed).

### 32. Group
- DB model: `Group` schema.prisma:956; `GroupSymbol` :1191; `GroupSymbolConfig` :1099
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | GRP | groups + pricing overrides | + GROUP WORKS; ctx Add DUPLICATE; row click WORKS; Edit group PARTIAL (resets tier; swapFree inherit lost; default can be unticked; leverage not propagated); Allowed symbols WORKS; Delete WORKS (menu enabled for MANAGER, server BROKER_ADMIN); Halt / Resume DUPLICATE; PRC edit PARTIAL (TARGET mode needs pricingEngineEnabled, UNVERIFIED per tenant); ctx Edit pricing DUPLICATE; Reset override WORKS | bo-GRP GroupsScreen.cs:146-226; groups/[id]/route.ts:77-119 |
| BO | DEAL 7) GRP, 9) PANIC | dealing-group trades / exposure / history; panic | see 3, 6, 25 | bo-DEAL |
| BO | EMG 3) GROUPS | TYPE (legacy groupType), halt state | see 25 | bo-EMG groups/route.ts:84 |
| BO | EXP | GROUP chips | WORKS | bo-EXP :120 |
| BO | CLI 360 | Group row; CHANGE GROUP | PARTIAL | bo-CLI ClientsScreen.cs:298, 375, 490 |
| BO | CFG | "PER GROUP · GRP" links (margin call, stop-out) | WORKS / DUPLICATE | bo-CFG SettingsScreen.cs:49-50 |
| T | 6) ACC gauge | "CALL n%" from group marginCallLevel | view | term-account me/route.ts:42 |
- Gaps: EMG shows legacy groupType; the routing axis Group.category is not shown there (bo-EMG B). Group per-symbol pricing differs from account-type pricing only in reset/edit wording; both depend on pricingEngineEnabled (bo-GRP, bo-ATY).

### 33. Account type
- DB model: `AccountType` schema.prisma:800 (enabled :845, swapFree :836); `AccountTypeSymbolConfig` :1137
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | ATY | types + pricing overrides | + TYPE PARTIAL (pins flat pricing to 0); ctx Add DUPLICATE; row click WORKS; Edit PARTIAL (null flat pricing becomes 0); Disable / Enable DEAD (400 "name is required"); PRC edit PARTIAL (ignored unless pricingEngineEnabled); ctx Edit pricing DUPLICATE; Reset override WORKS | bo-ATY AccountTypesScreen.cs:74-75; account-types/[id]/route.ts:41-77 |
| BO | CLI 360 card | "Account type" row | view | bo-CLI ClientsScreen.cs:282-289 |
| BO | LAR | request's accountTypeId used on approve | via Approve PARTIAL | bo-LAR |
| BO | AUD | AccountType rows | OPEN PARTIAL | bo-AUD |
- Gaps: + ACCOUNT has no account-type field (server default used) (bo-CLI accounts/route.ts:165-167). Terminal: none.

### 34. Mirror rule
- DB model: `MirrorRule` schema.prisma:2051; `MirrorLink` :2115
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | MIR | rule list | + RULE WORKS; ctx Add DUPLICATE; ACTIONS DISABLE/ENABLE WORKS; ctx Disable/Enable DUPLICATE; Edit multiplier / fill / symbols WORKS | bo-MIR ApprovalsMirrorScreens.cs:142-183 |
| BO | NTF | MIRROR_KILL_SWITCH | OPEN PARTIAL ("MirrorRule has no screen yet") | bo-NTF lib/mirror.ts:145-150 |
| BO | AUD | MirrorRule rows | OPEN PARTIAL | bo-AUD |
- Gaps: KILLED rule cannot be re-enabled in the UI; server allows it (bo-MIR mirror-rules/[id]/route.ts:155-159). No delete endpoint. Rule detail / MIRROR_FAILED history is web only (endpoints.md §2). CLI list ignores the `mirror` field (bo-CLI route.ts:90).

### 35. Session / credentials
- DB model: no session table (Redis: W\lib\account-auth.ts:139, 155-157; admin cookie W\lib\auth.ts:10); `LoginEvent` schema.prisma:2192; `Account.passwordHash` :605; `AdminUser.passwordHash` :520
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Sign-in window | server, account, password, 2FA, remember me | SIGN IN WORKS; AUTHENTICATOR CODE PARTIAL; Remember me PARTIAL; Other server PARTIAL; CANCEL PARTIAL; SEND REQUEST (forgot) WORKS; update banner WORKS | term-session LoginWindow.axaml.cs:85-208 |
| T | Shell USER menu | account / name | Switch account PARTIAL (app exits; DUPLICATE of Sign out); Sign out PARTIAL (app exits, stored cookie now revoked); Sign out and forget PARTIAL (app exits) | term-session MainWindow.axaml.cs:238-244, 684-694; Program.cs:177 |
| T | Startup gate | refusal window | CLOSE WORKS | term-session StartupGate.cs:41-42 |
| BO | SHELL login | server, e-mail, password, 2FA, remember me | SIGN IN PARTIAL; VERIFY WORKS; Remember me WORKS; Forgot password PARTIAL | bo-SHELL LoginWindow.axaml.cs:81-169 |
| BO | SHELL USER menu | — | Sign out PARTIAL (no server revoke); Switch account DUPLICATE | bo-SHELL BackofficeSession.cs:83-90 |
| BO | SEC | this sign-in | SIGN OUT DUPLICATE; ACTIVE SESSIONS / Sign out everywhere PLACEHOLDER | bo-SEC :53-61 |
| BO | CLI 360 6) SES | last 50 LoginEvents | view; no revoke | bo-CLI security/route.ts:5-28 |
| BO | CLI / NTF | RESET PASSWORD revokes all trader sessions | WORKS / PARTIAL | bo-CLI; bo-NTF reset-password/route.ts:57 |
| BO | RDR | same-IP clusters from LoginEvent | view | bo-RDR |
- Gaps:
  - Sign out: terminal revokes the server session (term-session logout/route.ts:11-13); backoffice never calls /api/admin/logout, session stays valid (bo-SHELL).
  - Session list / revoke: web only for traders (trade/sessions) and staff (admin/sessions); BO SEC shows PLACEHOLDER (endpoints.md §2; bo-SEC).
  - Terminal remember-me: server session always created with remember=true (term-session MarketDataService.cs:963).

### 36. Client build / app update
- DB model: none in schema.prisma; Redis `client_build:<id>` (W\lib\client-builds.ts:34)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | Startup gate, status bar | refusal window; update pill | refusal CLOSE WORKS; update pill WORKS | term-session; term-shell StatusBar.axaml:22-25 |
| BO | SHELL | startup gate; login update banner | UPDATE … READY PARTIAL (login window only, no in-shell check) | bo-SHELL LoginWindow.axaml.cs:53-57 |
- Gaps: No native screen lists, registers or revokes builds; PATCH /api/admin/client-builds is used by build tooling only (endpoints.md §2).

### 37. Settings / config
- DB model: `Broker` schema.prisma:317 (defaultAccountCurrency :428, defaultAccountLeverage :429, negativeBalanceProtection :411, requireAdmin2fa :331); `Account.chartSettings` :719; local files (terminal `%APPDATA%\VyxTrader\settings.json`, backoffice settings)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | CFG | tenant facts + broker settings | SAVE PARTIAL (not audited; any 3 letters accepted, server USD only); PER GROUP / PER METHOD links WORKS / DUPLICATE; NBP, hedging, max slippage, withdrawal auto-approve, KYC L1/L2, staff 2FA, session timeout, audit retention PLACEHOLDER | bo-CFG SettingsScreen.cs:29-112 |
| BO | USR right column | 3) CFG panel | SAVE DUPLICATE (CFG) | bo-USR SettingsScreen.cs:29 |
| BO | SHELL | THEME cell | WORKS (local; PATCH /api/manage/theme not called) | bo-SHELL MainWindow.axaml.cs:289-290 |
| BO | DEAL | chart / MW view settings, requote step | local WORKS; ⚙ SAVE PARTIAL | bo-DEAL DS:445-458 |
| T | Settings (F12) | confirmations, slippage, 1-click, crosshair | confirm checkboxes WORKS; Slippage max PARTIAL (acts as a floor); 1-click default DUPLICATE; crosshair DUPLICATE; CHART APPEARANCE WORKS; RESET GRID SYMBOLS PARTIAL (no effect); SAVE / CANCEL WORKS; "Sounds and keyboard remapping" PLACEHOLDER | term-settings SettingsWindow.axaml:23-52; OrderValidation.cs:68-75 |
| T | Chart settings / indicators / drawings | server chartSettings; local studies/drawings files | Chart settings SAVE WORKS; Timezone UI-ONLY; indicators PARTIAL (local file, not server chart-indicators); sessions checkbox WORKS; SESSIONS chip DUPLICATE; Clear all drawings PARTIAL (no confirm) | term-chart ChartHost.cs:183-251 |
| T | Shell | THEME cell, splitters | WORKS (local) | term-shell |
- Gaps:
  - Broker.negativeBalanceProtection and requireAdmin2fa have no API write and no native control (bo-CFG :51, :67).
  - If the sign-in GET chart-settings failed, any later PUT overwrites the server document with defaults (term-settings MarketDataService.cs:1054-1055).
  - Terminal settings.json is per Windows user, not per account (term-settings A).

### 38. Report / statement (generated file)
- DB model: none (CSV / HTML / XLSX built from positions, transactions, accounts)
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| BO | RPT | six server CSV reports + 4 KPIs | kind chips WORKS; RANGE pickers PARTIAL; range chips PARTIAL; SAVE CSV PARTIAL (unfiltered rows) | bo-RPT IbReportsScreens.cs:134-198 |
| BO | CLI 360 | STATEMENT CSV | PARTIAL | bo-CLI |
| BO | AUD | SAVE CSV | WORKS (≤200 rows) | bo-AUD |
| T | HISTORY tab | STATEMENT ⤓ (HTML / Excel / CSV) | WORKS | term-tabs MainWindow.axaml.cs:182-205 |
| T | F10 REPORTS | — | PLACEHOLDER | term-shell MainWindow.axaml.cs:313 |
| BO | SHELL F1 | — | PLACEHOLDER (help) | bo-SHELL |

### 39. Economic calendar event
- DB model: `EconomicCalendarCache` schema.prisma:2225
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 5) ECO panel | next events (≤40), impact badge | F6 refresh WORKS; rows have no click handler | term-eco MarketDataService.cs:1201-1233 |
- Gaps: No news headlines, no filter (term-eco). Backoffice: none. RDR NEWS flag is PLACEHOLDER (bo-RDR).

### 40. Price / candle (feed)
- DB model: `LivePrice` schema.prisma:1598; `Candle` :1643
| App | Screen/area | Shown as | Actions available | Evidence |
|---|---|---|---|---|
| T | 2) Chart | candles M1…W1, live candle | timeframe 1M–1H WORKS; 4H / D / W PARTIAL (epoch bucketing vs broker grid); grid timeframe PARTIAL; VOL header UI-ONLY | term-chart Timeframe.cs:28-32; MarketDataService.cs:2257 |
| T | Market Watch, tape, ticket | bid / ask / spread / CHG% | view | term-marketwatch; term-shell; term-ticket |
| BO | DEAL chart + MW | candles, bid / ask | chart toolbar WORKS | bo-DEAL DealingChart.cs:163-164 |
| BO | FEED | core / gateway / alert-engine stats, per-symbol freshness | view (NOT REACHABLE cause UNVERIFIED) | bo-FEED LiquidityScreens.cs:247-283 |

---

## Matrix

V = shown, view / filter / navigation only. A = at least one control that writes or changes the entity (server or local), whatever its status. Blank = not present. Numbers = entity sections above.

### Backoffice
| # Entity | DASH | RPT | NTF | EXP | DEAL | DLS | SYM | GRP | ATY | MIR | RISK | RDR | EMG | MRG | LP | ROUTE | FEED | CLI | CRM | IB | KYC | LAR | DEP | APR | PSP | TRX | WAL | USR | AUD | SEC | CFG | SHELL |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Account | V | V | A | V | A |  V |  |  |  |  | V | V |  | V |  |  |  | A | V | V | V | A | V | V |  | A | V |  | V |  |  | V |
| 2 Client (portal) |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |
| 3 Position (open) | V |  |  | A | A |  | V |  |  |  | A |  |  | A | V |  |  | V |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 4 Coverage position |  |  |  | A | A |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 5 Order | V |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  | V |
| 6 Deal (closed) | V | V |  |  | V | A |  |  |  |  |  | V |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 7 Position action request |  |  |  | A |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 8 Balance adjustment |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  | A |  |  |  |  |  |  |  | V |
| 9 Deposit | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  | A |  |  |  |  |  |  |  |  | V |
| 10 Withdrawal | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  | A |  |  |  |  |  |  |  |  | V |
| 11 Transfer |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  | A | V |  |  |  |  |  |
| 12 Wallet |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 13 Payment method |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  | V |  |
| 14 KYC record | V |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  | A |  |  |  |  |  |  |  |  |  |  | V |
| 15 Live account request | V |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  | V |
| 16 Lead |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 17 IB relationship |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  | A |  |  |  |  |  |  |  |  | V |  |  |  |
| 18 Staff user |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A | V | A |  | A |
| 19 Audit log entry | V |  |  |  | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 20 Notification |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 21 Price alert |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 22 STM rule |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 23 Liquidity provider |  | V |  |  |  |  |  |  |  |  |  |  |  |  | A | V |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 24 LP routing rule |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 25 Trading halt / close-only |  |  |  |  | A |  | A | A |  |  | V |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 26 Dealer mode / auto-hedge |  |  |  |  | A |  |  | V |  |  | A |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |
| 27 Risk limits | V |  |  | V |  |  | A |  |  | A | A |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 28 Margin snapshot | V | V |  |  |  |  |  |  |  |  | V |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 29 Risk radar flag |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 30 Symbol | V |  |  | V | V |  | A | A | A |  |  |  | A |  | V | V | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 31 Watchlist item |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 32 Group |  |  |  | V | A |  |  | A |  |  |  |  | A |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  | V |  |
| 33 Account type |  |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  | V |  |  |  | V |  |  |  |  |  |  | V |  |  |  |
| 34 Mirror rule |  |  | V |  |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 35 Session / credentials |  |  | A |  |  |  |  |  |  |  |  | V |  |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  | A |  | A |
| 36 Client build / update |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |
| 37 Settings / config |  |  |  |  | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | A |  |  | A | A |
| 38 Report / statement |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |
| 39 Economic calendar event |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 40 Price / candle |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |

### Trader terminal
Columns: SH = shell / top bar / sign-in / status bar; MW = market watch (+ tape, spec dialog); CH = chart; OT = order ticket; F9 = New Order; TRD = TRADE tab (+ Modify / Share windows); PND = PENDING; ORD = ORDERS; HIS = HISTORY; BAL = BALANCE; LOG = LOG; ACC = account panel; ALR = alerts dialog; STM = Smart Trade Manager; SET = settings dialog; ECO = calendar.
| # Entity | SH | MW | CH | OT | F9 | TRD | PND | ORD | HIS | BAL | LOG | ACC | ALR | STM | SET | ECO |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 Account | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 3 Position (open) |  |  | A |  |  | A |  |  |  |  |  | V |  | A |  |  |
| 5 Order |  |  | A | A | A |  | A | V |  |  |  |  |  | A |  |  |
| 6 Deal (closed) |  |  |  |  |  |  |  |  | V |  |  | V |  |  |  |  |
| 8 Balance adjustment |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 9 Deposit |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 10 Withdrawal |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |  |
| 12 Wallet | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 19 Audit log entry |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |  |
| 21 Price alert |  |  | A |  |  |  |  |  |  |  | V |  | A |  |  |  |
| 22 STM rule | V |  |  |  |  | A |  |  |  |  |  |  |  | A |  |  |
| 25 Trading halt |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 28 Margin snapshot | V |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 30 Symbol | V | V | V | V | V |  |  |  |  |  |  |  | V |  |  |  |
| 31 Watchlist item | V | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 32 Group |  |  |  |  |  |  |  |  |  |  |  | V |  |  |  |  |
| 35 Session / credentials | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 36 Client build / update | A |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  |
| 37 Settings / config | A | A | A |  |  |  |  |  |  |  |  |  |  |  | A |  |
| 38 Report / statement | V |  |  |  |  |  |  |  | A |  |  |  |  |  |  |  |
| 39 Economic calendar event |  |  |  |  |  |  |  |  |  |  |  |  |  |  |  | V |
| 40 Price / candle | V | V | V | V | V |  |  |  |  |  |  |  |  |  |  |  |
Entities with no terminal presence (rows omitted above): 2, 4, 7, 11, 13, 14, 15, 16, 17, 18, 20, 23, 24, 26, 27, 29, 33, 34. Entity 25 (trading halt) is listed with an empty row: the terminal shows it only as a rejection message.
