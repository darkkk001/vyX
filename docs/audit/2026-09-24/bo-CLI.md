# bo-CLI — Clients list + Client 360 (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ClientsScreen.cs` (566 lines). Server: `D:\VyXTrader-Tauri\vyX\app\api\manage\accounts\**`.
Common DataTable behaviour (applies to every table below): left-click a header sorts that column, click again toggles asc/desc (DataTable.cs:299, 160-163); no default sort (rows keep server/code order); single selection, no checkbox column, no multi-select (DataTable.cs:186-190); right-click on header = COLUMNS picker (DataTable.cs:89, 303-319); no keyboard Enter handler on rows (DataTable.cs has no KeyDown; the only window Enter handler is the search box, MainWindow.axaml.cs:241-244).

## A. Purpose + panels
Purpose: list every trading account of the broker and open one account's "Client 360" (card + actions, balance curve, trades, ledger, notes, logins).
Panels: LIST view = `1) CLI CLIENTS & ACCOUNTS` (ClientsScreen.cs:71). DETAIL view (Client 360) = `1) CLI CLIENT` card, `2) EQ BALANCE CURVE`, `3) TRD TRADES`, `4) LED LEDGER`, `5) NOTE NOTES · CRM`, `6) SES SESSIONS · DEVICES · IP` (ClientsScreen.cs:87-98). Only one of the two views is visible at a time (ClientsScreen.cs:99, 149, 159). Navigating to CLI always shows the LIST (ClientsScreen.cs:155).

---
# PART 1 — CLIENTS LIST

## B. Data (list)
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error/loading |
|---|---|---|---|---|---|---|---|
| 1) CLI list | GET /api/manage/accounts | FetchManageAccountsAsync ApiClient.ManageG1.cs:152 | app/api/manage/accounts/route.ts:21-95 (MANAGER/BROKER_ADMIN) | live events "order","position","account" (ClientsScreen.cs:27) → RefreshAsync; nav refetch if >10 s old (Screen.cs:70-76); no poll | chips + search client-side (ClientsScreen.cs:135-147); server order accountNumber asc (route.ts:36) | none (all accounts of broker; includes the broker's COVERAGE hedge account — no group-category filter, route.ts:28-29) | empty "no accounts match" (ClientsScreen.cs:53); error → header status text (Screen.cs:103); loading → "loading…" status + LOADING… veil on nav (Screen.cs:73, 98) |

Fields read: ManageAccount.FromJson (ApiClient.ManageG1.cs:38-40). `maxDailyLoss` and `mirror` are returned by the server (route.ts:86, 90) but not parsed. `swapFree` is a tri-state (null = inherit) on the server (accounts/[id]/route.ts:213) but parsed with GetBoolOr → null reads as false (ApiClient.ManageG1.cs:40).
Equity: the list has no EQUITY column and the ManageAccount model has no equity field (ApiClient.ManageG1.cs:35-36); nothing on this screen shows "—" for equity. (Equity "—" appears on DASH/WAL when the margin row is missing: DashboardScreen.cs:249, WalletsLeadsScreens.cs:70 — out of this scope.)

## C. Controls (list)
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search box "account · name · e-mail" | filter bar right (ClientsScreen.cs:29, 71) | always | always | none (client filter, ClientsScreen.cs:143) | — | — | no | no | none | re-render | WORKS |
| Filter chips ALL/LIVE/DEMO/KYC WAIT/SUSPENDED/IB | filter bar (ClientsScreen.cs:130-134) | always | always | none (ClientsScreen.cs:138-142) | — | — | no | no | none | re-render | PARTIAL (SUSPENDED = any status ≠ ACTIVE incl. CLOSED, :141; IB = accounts that are an IB's *client* (hasIbLink = ibLinkAsClient, accounts/route.ts:85), not IB accounts) |
| + ACCOUNT (primary/orange) | panel header right (ClientsScreen.cs:71) | always | always | CreateAccountAsync POST /api/manage/accounts (ApiClient.ManageG6.cs:87-96); optional UploadAccountKycAsync POST /api/manage/accounts/{id}/kyc multipart (ApiClient.ManageG6.cs:100-112) | provisionAccount: Account row; if initialBalance>0 an ADJUSTMENT Transaction "Initial balance on account creation"; AuditLog ACCOUNT_CREATED (lib/account-provisioning.ts:96-145). KYC: blob upload + KycRecord upsert status PENDING + AuditLog KYC_DOCUMENT_UPLOADED_BY_ADMIN (accounts/[id]/kyc/route.ts:97-138). No event, no notification, no email | client: email has '@', password ≥8, group chosen, KYC file when type chosen, leverage per LeverageInput (ClientsScreen.cs:413, 435-441); server: fullName/email/mode required, password ≥8, USD only, ISO-2 country, group isClientSelectable + structure check (accounts/route.ts:143-257) | no (form) + result dialog shows password (ClientsScreen.cs:433) | no | server MANAGER/BROKER_ADMIN; leverage + initialBalance silently ignored unless BROKER_ADMIN or ACCOUNT_FINANCE (accounts/route.ts:131, 270, 288-290); client none | toast + refetch (Screen.cs:137, 144-148) + "ACCOUNT CREATED" dialog | PARTIAL (no account-type field → server default type, accounts/route.ts:165-167; a MANAGER's typed leverage is dropped with no message) |
| Right-click empty table area → "Add new account…" | list table (ClientsScreen.cs:68; Screen.cs:121-122) | always | always | same as + ACCOUNT | same | same | same | no | same | same | DUPLICATE (+ ACCOUNT, ClientsScreen.cs:71) |
| Row click / double-click | list rows (ClientsScreen.cs:54, 67) | row exists | always | none (opens Client 360 → PART 2 loads) | — | — | no | no | none | detail view | WORKS |
| Row menu "Open client 360" | row right-click (ClientsScreen.cs:60) | always | always | none | — | — | no | no | none | detail | DUPLICATE (row click, :67) |
| Row menu "Live exposure" | row menu (:60) | always | always | Shell.Open("EXP", accountNumber) → LiveExposureScreen.FocusRecord (LiveExposureScreen.cs:109-114) | — | — | no | no | none | EXP filtered to account | WORKS |
| Row menu "Deposits · withdrawals" | row menu (:61) | always | always | Shell.Open("DEP", accountNumber) → FundsScreen.FocusRecord (FundsScreen.cs:91-96) | — | — | no | no | none | DEP search = account | WORKS |
| Row menu "Wallet" | row menu (:61) | always | always | Shell.Open("WAL", a.Id) → WalletsScreen.FocusRecord (WalletsLeadsScreens.cs:57) | — | — | no | no | none | WAL search = account | PARTIAL (WAL.FocusRecord has no pending-focus: when WAL has not loaded yet the id is dropped, WalletsLeadsScreens.cs:57; Navigate starts the fetch without awaiting, MainWindow.axaml.cs:119-128) |
| Row menu "Credit / debit…" | row menu (:62) | always | always | = card CREDIT / DEBIT | | | | | | | DUPLICATE (card button, :297) |
| Row menu "Change group…" | row menu (:62) | always | always | = card CHANGE GROUP | | | | | | | DUPLICATE (card, :298) |
| Row menu "Leverage…" | row menu (:62) | always | always | = card LEVERAGE | | | | | | | DUPLICATE (card, :299) |
| Row menu "Risk limits…" | row menu (:62) | always | always | = card RISK LIMITS | | | | | | | DUPLICATE (card, :300) |
| Row menu "Statement CSV…" | row menu (:62) | always | always | = card STATEMENT CSV | | | | | | | DUPLICATE (card, :301) |
| Row menu "Reset trader password…" | row menu (:63) | always | always | = card RESET PASSWORD | | | | | | | DUPLICATE (card, :302) |
| Row menu "Suspend account…" / "Activate account…" | row menu (:64-65) | label by status (ACTIVE → Suspend, else Activate) | always | = card SUSPEND/ACTIVATE | | | | | | | DUPLICATE (card, :303-304) |
| Column header right-click → COLUMNS picker + Reset columns | header (DataTable.cs:303-319) | always | always | none; layout persisted to settings "clients" (ClientsScreen.cs:69, 106-107) | — | — | no | no | none | columns hidden/shown | WORKS |

## F. UI structure map
(PART 1 and PART 2 share this section; see PART 2 for the detail view.)

---
# PART 2 — CLIENT 360 (detail view)

## B. Data (Client 360)
Opening a client calls six requests in parallel (ClientsScreen.cs:166-168), re-run on every live event of topics order/position/account while a client is open (ClientsScreen.cs:109-117) and on every EQ range change (:215).
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error/loading |
|---|---|---|---|---|---|---|---|
| 1) CLI card | row from the list (no own fetch) + GET accounts/{id}/risk + GET accounts/{id}/security | FetchAccountRiskAsync ApiClient.ManageG1.cs:185-189; FetchAccountSecurityAsync :167-171 | accounts/[id]/risk/route.ts:1-65; accounts/[id]/security/route.ts:10-36 | with list events | — | security: last 50 LoginEvents (security/route.ts:23-28) | Risk score "—" and Last IP "—" (muted) until/unless the call succeeds (ClientsScreen.cs:187, 288-289); a failed call is silently shown as "—" (:172-173) |
| 2) EQ BALANCE CURVE | GET accounts/{id}/equity-curve?days=N | FetchAccountEquityCurveAsync ApiClient.ManageG1.cs:175-183 | accounts/[id]/equity-curve/route.ts:16-48 | on open, range chip, live event | window 7/30/90/365 d (ClientsScreen.cs:202); server caps 365 (route.ts:13, 33) | every Transaction in window + current balance point (route.ts:36-43) | error → "BALANCE CURVE · <W>" + friendly error; <2 points → "not enough history in this window" (ClientsScreen.cs:227-228) |
| 3) TRD TRADES | GET /api/manage/positions (broker-wide) + GET /api/manage/deals (broker-wide, no filter) | FetchManagePositionsAsync ApiClient.ManageG1.cs:224-232; FetchDealsAsync() :203 | positions/route.ts:47-164; deals/route.ts (take 500, :71) | on open / events; NOW + P/L repriced from ticks ≤1/s (ClientsScreen.cs:240-246) | client-side filter by AccountId / AccountNumber (ClientsScreen.cs:170-171); open first, then closed | closed rows: first 50 of this account's deals within the broker-wide latest 500 (deals/route.ts:71; ClientsScreen.cs:258) | "no trades" (:75) |
| 4) LED LEDGER | GET accounts/{id}/activity | FetchAccountActivityAsync ApiClient.ManageG1.cs:156-165 | accounts/[id]/activity/route.ts:22-93 | on open / events | only timeline rows with kind "Ledger" (ClientsScreen.cs:335) | server: last 50 transactions (activity/route.ts:40); client shows ≤80 (:335) | error → friendly error or "ledger unavailable"; empty "no ledger entries" (:332) |
| 5) NOTE NOTES · CRM | none | — | — | — | — | — | "CRM NOTES · NOT AVAILABLE YET" (ClientsScreen.cs:95; Ui.cs:176) |
| 6) SES SESSIONS · DEVICES · IP | GET accounts/{id}/security | as above | security/route.ts | on open / events | newest first (route.ts:25) | 50 | "NO LOGIN HISTORY" / "no logins recorded" (ClientsScreen.cs:198). Login events only — no live-session list, no revoke (security/route.ts:5-9) |

Equity in Client 360: there is no Equity row on the card (rows: Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP — ClientsScreen.cs:282-289). Panel 2 is labelled EQ but plots BALANCE only: the server returns Transaction.balanceAfter points plus the current balance and says so ("a live-floating equity curve would need periodic floating-P&L snapshots, which this codebase does not store", equity-curve/route.ts:5-10, 42-43). "—" in TRD: PRICE and PROFIT / LOSS of an open row show "—" when the server had no fresh price (LivePrice tickAt older than 15 s → currentPrice/floatingPnl null, positions/route.ts:101-110, 150-151; lib/live-price.ts:122-137) and no tick has arrived since (ClientsScreen.cs:255-256).

## C. Controls (Client 360)
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| "CLIENTS" breadcrumb | card header right (ClientsScreen.cs:85-87) | detail | always | none | — | — | no | no | none | back to list | WORKS |
| CREDIT / DEBIT | card action grid r1c1 (:297) | detail | always | AdjustBalanceAsync POST /api/manage/accounts/{id}/adjust-balance {amount signed "0.00", note} (ApiClient.ManageG6.cs:68-73) | BROKER_ADMIN: Account.balance, Transaction type ADJUSTMENT COMPLETED with balanceBefore/After + note, AuditLog BALANCE_ADJUSTMENT (lib/balance-adjustment.ts:46-86); then NATS BalanceChanged (adjust-balance/route.ts:80). MANAGER: BalanceAdjustmentRequest PENDING + AuditLog BALANCE_ADJUSTMENT_REQUESTED, 202 (adjust-balance/route.ts:63-68; lib/balance-adjustment.ts:89-116). Touches Account.balance only — never Account.credit. No NBP, no notification | client: amount >0, note required (ClientsScreen.cs:477, 485); server: amount ≠0, note required, trimmed to 500 (route.ts:53-61). No floor: a debit may take balance below 0 or below used margin (balance-adjustment.ts:51-53) | no confirm (form only) | YES for MANAGER (balance-adjustment.ts:40-42) | server BROKER_ADMIN or ACCOUNT_FINANCE (route.ts:35); client none | toast; badges refresh (:483) | PARTIAL (success toast reads `balanceAfter` (ApiClient.ManageG6.cs:72) but server returns `balance` (route.ts:87) → "applied · balance " with an empty value) |
| CHANGE GROUP | action grid r1c2 (:298) | detail | always | PatchAccountAsync PATCH /api/manage/accounts/{id} {groupId} (ApiClient.ManageG6.cs:114-115) | Account.groupId AND Account.leverage := group.leverage (accounts/[id]/route.ts:161-175); AuditLog ACCOUNT_GROUP_CHANGED; NATS AccountUpdated reason "account" (route.ts:242; lib/account-events.ts:21-25) | client: required; server: group exists, isClientSelectable unless COVERAGE, checkAccountStructure (COVERAGE refused, mode vs group) (route.ts:74-116) | no (form) | no | server MANAGER or BROKER_ADMIN (no finance permission) (route.ts:28-61) | toast + refetch | PARTIAL (picker lists every group — not SelectableGroups — so non-selectable/COVERAGE groups are offered and refused by the server (ClientsScreen.cs:490 vs :375); leverage is silently overwritten and not stated in the dialog) |
| LEVERAGE | action grid r2c1 (:299) | detail | always | PatchAccountAsync {leverage} | Account.leverage; AuditLog LEVERAGE_CHANGE; AccountUpdated (route.ts:186-193, 242) | client LeverageInput rule (:543); server parseLeverage (route.ts:119-124) | no (form) | no | server BROKER_ADMIN or ACCOUNT_FINANCE (route.ts:56-61) | toast + refetch | WORKS |
| RISK LIMITS | action grid r2c2 (:300) | detail | always | PatchAccountAsync {swapFree: true/false/null, maxDailyLoss: string/null} (ClientsScreen.cs:505-508) | Account.swapFree (tri-state) + AuditLog ACCOUNT_SWAP_FREE_CHANGED; Account.maxDailyLoss + AuditLog ACCOUNT_MAX_DAILY_LOSS_CHANGED; AccountUpdated (route.ts:202-220, 242) | client: number field; server: maxDailyLoss >0 or null (route.ts:134-148) | no (form) | no | body always contains maxDailyLoss → counted as a finance change → BROKER_ADMIN or ACCOUNT_FINANCE even to toggle swap-free only (route.ts:47, 56) | toast + refetch | PARTIAL (form never shows current values: swap-free default comes from a null-coerced bool so "GROUP DEFAULT" reads as NO (ApiClient.ManageG1.cs:40; ClientsScreen.cs:501); max-daily-loss default is always "" so any save CLEARS an existing limit (ClientsScreen.cs:502, 507; route.ts:136-137)) |
| STATEMENT CSV | action grid r3c1 (:301) | detail | always | FetchManagePositionsAsync + FetchDealsAsync() + FetchAccountActivityAsync (ClientsScreen.cs:516-517) → local save dialog | none (read only) | — | no | no | server MANAGER/BROKER_ADMIN | file saved, toast | PARTIAL (closed deals come from the broker-wide latest 500 (deals/route.ts:71) filtered locally — older deals of the client are missing, though the API accepts accountId (deals/route.ts:14); "LEDGER" section writes every timeline row incl. admin actions, orders and positions (ClientsScreen.cs:528-529); fetch failures produce empty sections with no message) |
| RESET PASSWORD | action grid r3c2 (:302) | detail | always | ResetTraderPasswordAsync POST accounts/{id}/reset-password (ApiClient.ManageG1.cs:199-200) | Account.passwordHash; AuditLog ACCOUNT_PASSWORD_RESET; revokeAllAccountSessions; broker email with temp password when email + mail configured, else password returned (reset-password/route.ts:41-93) | none | yes "RESET TRADER PASSWORD" (danger) (:448-470) | no | server MANAGER/BROKER_ADMIN | toast "emailed to …" or second dialog showing password once (:453-467) | WORKS |
| SUSPEND / ACTIVATE | action grid r4c1 (:303-304) | detail; label SUSPEND when status ACTIVE, else ACTIVATE | always | SetAccountStatusAsync PATCH accounts/{id} {status} (ApiClient.ManageG1.cs:154-155) | Account.status; AuditLog ACCOUNT_STATUS_CHANGED; AccountUpdated (route.ts:194-201, 242) | server status ∈ ACTIVE/SUSPENDED/CLOSED (route.ts:126-132) | yes (danger when suspending) | no | server BROKER_ADMIN or ACCOUNT_FINANCE | toast + refetch | WORKS (CLOSED accounts show "ACTIVATE"; CLOSED cannot be set from here) |
| EQ range chips 7D / 30D / 90D / 1Y | EQ header (:202-219) | detail | always | re-runs all six detail calls incl. equity-curve?days=N (:215) | none | server clamps 1..365 (equity-curve/route.ts:32-33) | no | no | MANAGER/BROKER_ADMIN | curve redrawn | WORKS |
| TRD row right-click (open row) "Open in Live exposure (modify / close / reverse)" | TRD table (:76-78) | open-position row | always | Shell.Open("EXP", positionId) | — | — | no | no | none | EXP with that position selected (LiveExposureScreen.cs:109-114) | WORKS |
| TRD row right-click (closed row) "Open in Deals (replay / void / delete)" | TRD table (:79) | closed-deal row | always | Shell.Open("DLS", dealId) | — | — | no | no | none | DLS focus (DealsScreen.cs:62) | WORKS |
| LED row click | ledger table (:93) | any row | always | Shell.Open("DEP", accountNumber) | — | — | no | no | none | DEP filtered to account | PARTIAL (every ledger type opens DEP, which lists only DEPOSIT/WITHDRAWAL rows (funds-requests/route.ts:19); ADJUSTMENT/TRADE_PNL/TRANSFER rows land on an unrelated list) |
| 5) NOTE panel | right column bottom (:95) | detail | — | none | — | — | — | — | — | — | PLACEHOLDER |
| Column pickers (trades "client-trades", ledger "client-ledger") | table headers | detail | always | none; not persisted (no LayoutChanged handler for these two) | — | — | no | no | none | columns toggle for this session | WORKS |

## D. Dialogs
### NEW ACCOUNT (form, ClientsScreen.cs:391-441), button CREATE
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| Full name * | text | "" | Account.fullName | backoffice lists, statements, emails | — |
| E-mail * | text | "" | Account.email (lower-cased, accounts/route.ts:137) | reset-password email (reset-password/route.ts:59); TRX same-client check is client-side only (TransfersScreen.cs:70) | — |
| Mode | choice LIVE/DEMO | LIVE | Account.accountMode | checkAccountStructure (lib/account-structure.ts:67-80); TRX mode check (transfers/route.ts:87) | — |
| Group | choice (client-selectable groups; "(default)" suffix) | broker default group else first selectable (:388) | Account.groupId | routing/book (Group.category), pricing, swap (lib/swap-rollover.ts:182) | — |
| Leverage | number, hint "blank = the group's own leverage" | "" | Account.leverage (only if BROKER_ADMIN/ACCOUNT_FINANCE, else group/broker default; accounts/route.ts:269-276) | engine margin (engine/order-management/src/margin_watch.rs, calc.rs — grep hit, exact line UNVERIFIED) | — |
| Opening balance | number | "" | Account.balance + ADJUSTMENT Transaction (account-provisioning.ts:115-130) | ledger, margin | visible only when Mode = DEMO (:401); a hidden field submits "" (FormOverlay.cs:224-226) |
| Country | search (ISO picker; commits code) | "" | Account.country (ISO-2 validated, accounts/route.ts:194-198) | KYC queue display (kyc-requests/route.ts:31) | — |
| Phone | text | "" | Account.phone | KYC queue display (kyc-requests/route.ts:32) | — |
| Password | text (plain, not masked) | random 14 chars (:369, 404) | Account.passwordHash (bcrypt) | account login | — |
| KYC document (optional) | choice none/PASSPORT/NATIONAL ID/DRIVER'S LICENCE | none | KycRecord.documentType | KYC screen | — |
| Document front | file (jpg/png/pdf) | none | blob kyc/{accountId}/front → KycRecord.documentFrontUrl | KYC DOC panel (Bitmap decode — a PDF never renders, KycScreen.cs:198) | three separate fields, one per KYC type (:407-409) |
Not in the form (server accepts): accountTypeId, currency, dateOfBirth (accounts/route.ts:159-213).

### CREDIT / DEBIT (ClientsScreen.cs:475-485), button APPLY; detail line "<acc> · <name> · balance <x>"
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Direction | choice CREDIT (+) / DEBIT (−) | CREDIT | sign of Transaction.amount | ledger TYPE Credit/Debit by sign (ClientsScreen.cs:352) |
| Amount * (hint "USD") | number | "" | Transaction.amount; Account.balance (or BalanceAdjustmentRequest.amount) | margin/equity everywhere |
| Note * (hint "reason — goes to the ledger and the audit log") | note | "" | Transaction.note; AuditLog.newValue.note | LED REASON column (:343) |

### CHANGE GROUP (:490-494), button MOVE — Group (choice, all groups, default current groupId) → Account.groupId (+ leverage overwrite).
### CHANGE LEVERAGE (:538-543), button SAVE — Leverage (number, default current, hint "1:200 → 200") → Account.leverage.
### RISK LIMITS (:499-510), button SAVE
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Swap-free | choice NO / YES / GROUP DEFAULT | "true" if parsed SwapFree else "false" (null inherit → "false") | Account.swapFree (null/true/false) | lib/swap-rollover.ts:242 (resolved swap-free) |
| Max daily loss (hint "USD · empty = no limit · positions close once the day's loss reaches it") | number | "" always | Account.maxDailyLoss | lib/risk.ts:479-496 checkMaxDailyLoss, called from app/api/trade/orders/route.ts:204, orders/[id]/fill/route.ts:117, requote-response/route.ts:175, manage/dealing-queue/[id]/route.ts:291, dealing-desk-toggle/route.ts:221, manage/positions/route.ts (manual open). No reference in engine/ (Rust) — enforcement on engine-routed orders UNVERIFIED. It blocks NEW orders only; open positions are untouched (lib/risk.ts:474-477) |

### Confirm dialogs
RESET TRADER PASSWORD "Reset the password of <acc> · <name>?" RESET (danger) → PASSWORD RESET dialog "…New password:  <pw>\n\nShown once — copy it now." (+ "Email is not configured for this broker — hand it to the client directly.") DONE (:448-466).
SUSPEND ACCOUNT / ACTIVATE ACCOUNT "Suspend <acc> (<name>)?" SUSPEND / ACTIVATE (:303-304).
ACCOUNT CREATED "<name> · <no>\n\nPassword:  <pw>\n\nCopy it now." DONE (:433).

## E. Text
- Panel "2) EQ" titled "BALANCE CURVE" (ClientsScreen.cs:88): code EQ suggests equity; content is balance.
- Card action "CREDIT / DEBIT" (:297) and ledger label "Credit" for positive ADJUSTMENT (:352) while the card also has a separate "Credit" row showing Account.credit (:287): "credit" names two different things; this action never touches Account.credit.
- RISK LIMITS hint "positions close once the day's loss reaches it" (:502) contradicts server behaviour "Existing open positions are untouched -- this only blocks new trading" (lib/risk.ts:474-477).
- Chip "IB" (:133) and card tag "IB" (:277) mean "client of an IB" (hasIbLink = ibLinkAsClient, accounts/route.ts:85).
- Chip "SUSPENDED" includes CLOSED accounts (:141).
- Card section "ACCOUNTS" (:290) always lists the one open account only (:291).
- Column header "ACCOUNT MODE" at 56 px (:51) vs values LIVE/DEMO; "ACTIONS" column shows only the text "OPEN" (:146), not a button.
- Class comment says the rest "is an honest 'not available yet' panel" (:22-23); only NOTE is one.
- Toast "<acc> · +X applied · balance " with blank balance (:484; ApiClient.ManageG6.cs:72 vs adjust-balance/route.ts:87).
- Form hint "demo accounts are seeded with this; live accounts are funded by a deposit" (:401) — backoffice has no "create deposit" action; deposits originate from the trader (app/api/trade/funds-requests/route.ts).

## F. UI structure map
**LIST view**
- Layout: one full-height panel. Header left "1) CLI" + "CLIENTS & ACCOUNTS"; header right: "<n> TOTAL" stat, status text (last refresh "HH:mm:ss UTC" / error), button "+ ACCOUNT" (primary/orange) (ClientsScreen.cs:71, 121). No KPI strip.
- Filter bar: chips ALL · LIVE · DEMO · KYC WAIT · SUSPENDED · IB (default ALL) (:133); search box right "account · name · e-mail" (:29).
  - ALL = all; LIVE/DEMO = accountMode; KYC WAIT = in-app KycRecord status PENDING; SUSPENDED = status ≠ ACTIVE; IB = hasIbLink (:140-141).
- Table "clients": columns in order ACCOUNT · CLIENT · E-MAIL · ACCOUNT MODE · ACCOUNT TYPE · COUNTRY · KYC · GROUP · LEVERAGE · BALANCE · CREDIT · STATUS · ACTIONS (:51-53). Sortable: all; default sort: none (server accountNumber asc). Selection single, no checkbox. KYC shows VERIFIED for APPROVED, NONE for none (DashboardScreen.cs:278). ACTIONS cell text "OPEN" (not clickable separately).
  - Row click → Client 360; double-click → Client 360; Enter → NO.
  - RIGHT-CLICK ON ROW: YES. Menu: header "<accountNumber> · <fullName>" (disabled) / separator / Open client 360 / Live exposure / Deposits · withdrawals / Wallet / separator / Credit / debit… / Change group… / Leverage… / Risk limits… / Statement CSV… / separator / Reset trader password… / Suspend account… (status ACTIVE) or Activate account… (otherwise). All items always enabled; no submenus, no shortcuts (:59-65; Screen.cs:124-134).
  - Right-click on multi-selection: N/A (no multi-select). Right-click empty area: YES — header "CLIENTS & ACCOUNTS" / separator / "Add new account…" (:68). Right-click column header: YES — "COLUMNS" (disabled) / separator / one checkbox per column / separator / "Reset columns".
  - Empty "no accounts match"; loading = status "loading…" + full LOADING… veil on nav; error = header status text.

**DETAIL view (Client 360)**, grid columns 290 | * | 350, rows * | 220 (:98)
- Left column: panel "1) CLI" "CLIENT", header right = breadcrumb "CLIENTS" (accent, clickable) + client name crumb (_crumb is never assigned text — renders empty, :84). Card: name (large), line "CLIENT <no> · <mode> · <country>", tags KYC <status> / <status> / IB / SWAP-FREE / CUSTOM PRICING, rows Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP, section "ACCOUNTS" + one row "<no> · <mode>  <balance>", then a 2-column action grid: CREDIT / DEBIT · CHANGE GROUP / LEVERAGE · RISK LIMITS / STATEMENT CSV · RESET PASSWORD / SUSPEND|ACTIVATE (:271-314). SUSPEND in red; RESET PASSWORD/ACTIVATE in accent; others dim. No primary/orange button.
- Middle column top: "2) EQ" "BALANCE CURVE", header right: range chips 7D · 30D · 90D · 1Y (default 90D) + stat "<first> → <last>" (green/red). Body: line chart, no axes, no hover (:229-236).
- Middle column bottom: "3) TRD" "TRADES", header stat "<n> OPEN · FLOATING ±x · WIN y% OF z CLOSED" (:263).
  - Table "client-trades": TICKET · SYM · SIDE · LOTS · OPEN · CLOSE · OPENED · CLOSED · PROFIT / LOSS · NOTE (:74-75). Sortable all; default: open rows then closed newest-first (server order). Open rows: CLOSE = live price, CLOSED = "OPEN" chip, NOTE = "A-BOOK"/"B-BOOK". Closed rows: OPENED always blank (ManageDeal has no openedAt, :259), NOTE = "VOIDED" when voided.
  - Row click: select only; double-click: nothing; Enter: NO.
  - RIGHT-CLICK ON ROW: YES. Open row → header "<ticket> <sym> <side> <lots> · open" / separator / "Open in Live exposure (modify / close / reverse)". Closed row → header "<ticket> <sym> <side> <lots> · closed" / separator / "Open in Deals (replay / void / delete)" (:76-80). Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no trades".
- Right column top: "4) LED" "LEDGER" (no header items). Table "client-ledger": TIME · TYPE · AMOUNT · REASON · STATUS (:91-92). TYPE humanised (Credit/Debit/Deposit/Withdrawal/Neg-bal protect/Commission/Swap/Trade P/L/Transfer in/Transfer out, :350-363). Row click → DEP for this account; double-click nothing; right-click row NO; empty area NO; header YES. Empty "no ledger entries" / error text / "ledger unavailable".
- Right column bottom: "5) NOTE" "NOTES · CRM" — "CRM NOTES · NOT AVAILABLE YET".
- Bottom full width (220 px): "6) SES" "SESSIONS · DEVICES · IP" — log rows "<dd MMM HH:mm:ss> LOGIN <ip> · <user agent>"; empty "NO LOGIN HISTORY / no logins recorded".

## Issues
[money] CLI · RISK LIMITS form always opens with Max daily loss empty and swap-free coerced from null to NO, so saving it wipes an existing daily-loss limit and converts "inherit" to explicit NO · ClientsScreen.cs:501-507, ApiClient.ManageG1.cs:40, accounts/[id]/route.ts:136-137,213
[money] CLI · CHANGE GROUP (MANAGER tier, no ACCOUNT_FINANCE needed) overwrites Account.leverage with the group's leverage, while a direct leverage edit requires BROKER_ADMIN/ACCOUNT_FINANCE · accounts/[id]/route.ts:47,56,167-169
[money] CLI · Debit adjustment has no floor: balance can go below 0 / below used margin; no margin check · lib/balance-adjustment.ts:51-53
[money] CLI · POST /api/manage/accounts accepts initialBalance on LIVE accounts for BROKER_ADMIN or any ACCOUNT_FINANCE holder with no maker-checker, while adjust-balance files a MANAGER's change for approval; the UI hides the field for LIVE only client-side · accounts/route.ts:131,279-287, lib/balance-adjustment.ts:40-42, ClientsScreen.cs:401
[functional] CLI · Client 360 closed trades and Statement CSV use the broker-wide latest 500 deals filtered client-side; older deals of the client never appear although deals accepts accountId · ClientsScreen.cs:166,171,516,526, deals/route.ts:14,71
[functional] CLI · CHANGE GROUP picker lists every group (incl. non-client-selectable and COVERAGE) which the server then refuses · ClientsScreen.cs:490 vs :375, accounts/[id]/route.ts:82-87,112-115
[functional] CLI · RISK LIMITS always sends maxDailyLoss, so toggling swap-free alone needs the finance permission · ClientsScreen.cs:507, accounts/[id]/route.ts:47,56
[functional] CLI · Clients list includes the broker's COVERAGE hedge account with all client actions available on it · accounts/route.ts:28-29
[functional] CLI · Statement CSV "LEDGER" section contains every timeline kind (admin actions, orders, positions), capped at 50 per kind; failed fetches give empty sections silently · ClientsScreen.cs:528-529, activity/route.ts:38-43
[functional] CLI · Opening/holding a client re-runs 6 requests incl. broker-wide positions+deals on every order/position/account event · ClientsScreen.cs:27,109-117,166-168
[functional] CLI · New account: a MANAGER's typed leverage is silently replaced by the group default; no account-type field (server default type) · accounts/route.ts:165-167,269-276, ClientsScreen.cs:391-409
[functional] CLI · Row menu "Wallet" can drop the focus when WAL has not loaded yet (no pending focus) · WalletsLeadsScreens.cs:57, MainWindow.axaml.cs:125-128
[functional] CLI · LED row click opens DEP for every ledger type though DEP only lists deposits/withdrawals · ClientsScreen.cs:93, funds-requests/route.ts:19
[ux] CLI · Success toast after a direct credit/debit shows "balance " with no value (client reads balanceAfter, server returns balance) · ApiClient.ManageG6.cs:72, adjust-balance/route.ts:87
[ux] CLI · Risk score / Last IP / curve errors: a failed risk or security call renders as "—" identical to "no data" · ClientsScreen.cs:172-173,187,289
[ux] CLI · Client 360 has no Equity figure; the "EQ" panel plots balance only · ClientsScreen.cs:88,282-289, equity-curve/route.ts:5-10
[ux] CLI · Header crumb TextBlock _crumb is never given text (renders empty next to "CLIENTS") · ClientsScreen.cs:84,87
[ux] CLI · Closed rows in TRD always have an empty OPENED cell · ClientsScreen.cs:259
[ux] CLI · CLOSED accounts show "ACTIVATE"; status CLOSED cannot be set from the UI · ClientsScreen.cs:294,303, accounts/[id]/route.ts:128
[text] CLI · RISK LIMITS hint says positions close at the daily loss; server only blocks new orders · ClientsScreen.cs:502, lib/risk.ts:474-477
[text] CLI · "CREDIT / DEBIT" action and "Credit" ledger label vs the separate Account.credit "Credit" row · ClientsScreen.cs:287,297,352
[text] CLI · Chip/tag "IB" means client-of-an-IB; chip "SUSPENDED" includes CLOSED · ClientsScreen.cs:133,141,277
[text] CLI · Card section "ACCOUNTS" lists only the current account · ClientsScreen.cs:290-291

## Status counts
STATUS-COUNTS app=backoffice screen=CLI WORKS=13 PARTIAL=8 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=9
