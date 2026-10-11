# bo-IB — IB partners (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\IbReportsScreens.cs:18-124 (class IbScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
IB relationships grouped per IB account: create a relationship, edit the commission plan, pay pending commission (per client, per partner, or all).
Panels: "1) IB · PARTNERS · INTRODUCING BROKERS" (left, *) and "2) IB · {IB no} · {NAME}" detail (right, 380 px) (IbReportsScreens.cs:39-43).

## B. Data
One read: GET /api/manage/ib-relationships — FetchIbRelationshipsAsync ApiClient.ManageG3.cs:51 -> app/api/manage/ib-relationships/route.ts:20. Gate: BROKER_ADMIN or MANAGER with IB_PAYOUTS (route.ts:12-18). Returns every relationship of the broker, createdAt desc, each with pendingCommission computed live by lib/commission.ts:9-38 (route.ts:47). No limit/pagination.
Refresh: no live topics, no poll; on nav (>10 s, Screen.cs:70-76) and after every successful write (Screen.cs:144-148).
Partners table: rows grouped by ibAccountId, sorted by payable desc (IbReportsScreens.cs:53-56); chip filter ALL / PAYOUT DUE (payable>0) / PER LOT / PERCENTAGE. Header stat "{n} PARTNERS · {n} CLIENTS · PAYABLE {sum}".
Detail: rows for the selected IB (Owner, Plan, Referred clients, Payable now, Last payout, "Sub-IB levels · link · schedule NOT AVAILABLE", FUNNEL · MTD "NOT AVAILABLE YET", REFERRED CLIENTS table, PAY / EDIT PLAN buttons) (:61-86).
Empty/error: partners "no IB relationships"; clients "no referred clients"; detail "SELECT A PARTNER" / "NO PARTNER SELECTED"; 403 -> header status "not allowed for this role" (Screen.cs:103; BackofficeSession.cs:117).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| PAYOUT RUN | panel 1 header (:39,107) | always | always (toast "nothing payable" if none) | PayIbCommissionAsync ManageG3.cs:53 × N in parallel -> PATCH /api/manage/ib-relationships/{id} {action:"PAY"} | per relationship in one tx: pending recomputed; Account.balance += pending (row lock); Transaction type COMMISSION status COMPLETED; IbRelationship.lastPayoutAt=now; AuditLog IB_COMMISSION_PAID; after commit NATS BalanceChanged ([id]/route.ts:31-87). No notification, no mirror/coverage/NBP | server: 400 "no pending commission to pay" if ≤0 (:38,97) | yes, danger ("RUN PAYOUT") | no | BROKER_ADMIN or IB_PAYOUTS ([id]/route.ts:18) | toast "{ok} of {n} paid", refetch, badges | WORKS |
| + PARTNER (primary, orange) | panel 1 header (:39,92-106) | always | always | FetchManageAccountsAsync (GET accounts, resolve numbers) then CreateIbRelationshipAsync ManageG6.cs:125 -> POST /api/manage/ib-relationships | IbRelationship insert + AuditLog IB_RELATIONSHIP_CREATED (route.ts:99-115) | client: both numbers required, rate > 0 (:105); server: type PER_LOT/PERCENTAGE, rate > 0, not self, same broker, one IB per client (409) (route.ts:68-97,128-129) | form only | no | BROKER_ADMIN or IB_PAYOUTS | toast "IB {ib} → {client} · {rate} USD/lot|%", refetch | WORKS |
| Empty-area ctx "Add new partner…" | partners table blank area (:41) | always | always | same as + PARTNER | same | same | form | no | same | same | DUPLICATE (+ PARTNER :39) |
| Chips ALL · PAYOUT DUE · PER LOT · PERCENTAGE | filter bar (:49,54) | always | always | none | none | - | no | no | none | list re-filtered | WORKS |
| Partner row click | partners table (:33) | row | always | none | none | - | no | no | none | detail panel shows the IB | WORKS |
| Ctx "Referred clients (detail)" | partner row menu (:35) | row | always | none | none | - | no | no | none | detail | DUPLICATE (row click :33) |
| Ctx "Pay {due} pending…" | partner row menu (:35) | row | due > 0 | same PATCH {action:PAY} per due relationship | same as PAYOUT RUN for that IB | same | yes (not danger) | no | same | toast "{ok} of {n} paid" | DUPLICATE (detail PAY button :82) |
| Ctx "Edit commission plan…" | partner row menu (:35) | row | always | same as EDIT PLAN | same | same | same | no | same | same | DUPLICATE (detail EDIT PLAN :83) |
| Ctx "Open IB account 360" | partner row menu (:35) | row | always | Shell.Open("CLI", ibAccountNumber) | none | - | no | no | none | CLI opens the account (ClientsScreen.cs:126) | WORKS |
| PAY {amount} | detail action grid (:82,90) | partner selected | always (amber when payable>0, dim otherwise; toast "nothing payable") | PayIbCommissionAsync × due relationships | as PAYOUT RUN, scoped to one IB | server ≤0 guard | yes ("PAY PARTNER") | no | BROKER_ADMIN or IB_PAYOUTS | toast, refetch | WORKS |
| EDIT PLAN | detail action grid (:83,108-114) | partner selected | always | SetIbCommissionAsync ManageG3.cs:55 × every relationship of the IB -> PATCH /api/manage/ib-relationships/{id} {commissionType, commissionRate} | IbRelationship.commissionType/Rate updated + AuditLog IB_RELATIONSHIP_UPDATED with old/new ([id]/route.ts:104-138) | client: "PER_LOT <rate>" or "PERCENTAGE <rate>", rate numeric (:111); server: rate > 0 ([id]/route.ts:115) | yes, with required text input "TYPE · RATE" | no | BROKER_ADMIN or IB_PAYOUTS | toast "plan set on {ok} of {n}" | PARTIAL (new rate re-prices every unpaid closed trade since the last payout — pending is computed at read/pay time with the current rate, lib/commission.ts:18-37; the dialog does not say so) |
| Referred-client row double-click | detail clients table (:38,89) | row | pending > 0 (silently returns otherwise) | PayIbCommissionAsync (one) | as PAYOUT RUN for one relationship | server ≤0 guard | yes ("PAY IB COMMISSION") | no | same | toast "{ib} · paid {amount}" | WORKS |
| Ctx "Pay {x} pending…" | referred-client row menu (:88) | row | pending > 0 | same | same | same | yes | no | same | same | DUPLICATE (row double-click :38) |
| Ctx "Open client {number}" | referred-client row menu (:88) | row | always | Shell.Open("CLI", clientAccountNumber) | none | - | no | no | none | CLI | WORKS |
| ACTIONS cell words "PAY" (partners "VIEW PAY", clients "PAY") | ACTIONS columns (:56,77) | payable > 0 | - | none (no cell click handler; row click only selects) | none | - | no | no | none | nothing | UI-ONLY |
| Columns ACTIVE · LOTS · MONTH TO DATE · NET DEP · MTD · COMMISSION · MONTH TO DATE | partners table (:31-32,56) | always | - | none (always "—") | none | - | - | - | - | - | PLACEHOLDER |
| Detail rows "Sub-IB levels · link · schedule NOT AVAILABLE" and "FUNNEL · MTD / NOT AVAILABLE YET" | detail (:73-75) | partner selected | - | none | none | - | - | - | - | - | PLACEHOLDER |
| Column header click / right-click | both tables (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

## D. Dialogs
NEW IB RELATIONSHIP (FormOverlay, button CREATE, IbReportsScreens.cs:94-105):
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| IB account number | text, required | "" | resolved client-side to Account.id -> IbRelationship.ibAccountId | lib/commission.ts (target of payout via [id]/route.ts:42-45); reports/ib/route.ts | - |
| Referred client account number | text, required | "" | IbRelationship.clientAccountId | lib/commission.ts:20 (positions summed) | - |
| Commission | choice PER_LOT ("PER LOT (USD)") / PERCENTAGE ("% OF COMMISSION") | PER_LOT | IbRelationship.commissionType | lib/commission.ts:27-37 | - |
| Rate | number, required | "5" | IbRelationship.commissionRate (sent as "0.####", ManageG6.cs:126) | lib/commission.ts:29,37 | - |
EDIT PLAN (ConfirmWithInput, button APPLY): one text field "TYPE · RATE", required, free text "PER_LOT 5" / "PERCENTAGE 40" -> IbRelationship.commissionType + commissionRate on every relationship of the IB; read by lib/commission.ts.
Confirms: PAY IB COMMISSION ("Credit {x} to {ib} for client {c}?"), PAY PARTNER ("… across {n} clients? One request per client."), PAYOUT RUN (danger, "Pay every pending commission: {x} across {n} relationships?"). The amounts in the text are from the list; the server recomputes and credits its own figure ([id]/route.ts:37).

## E. Text
- Plan shown as "$5 / LOT" or "REV-SHARE 40%" (:50); the form says "% OF COMMISSION" (:97); the server enum is PERCENTAGE. Three names for one plan type.
- EDIT PLAN asks the admin to type raw enum text: 'type "PER_LOT 5" or "PERCENTAGE 40"' (:108).
- Column header "INTRODUCING BROKER ACCOUNT" (90 px) while the panel title already says INTRODUCING BROKERS (:31,39).
- Class doc lists "SUSPEND" among features with no endpoint (:22); nothing named SUSPEND is rendered.
- Toast after create uses "USD/lot" or "%" (:104).

## F. UI structure map
Layout: PageGrid columns * / 380. Left panel "1) IB  PARTNERS · INTRODUCING BROKERS"; header right in order: stat "{n} PARTNERS · {n} CLIENTS · PAYABLE {x}", status text, PAYOUT RUN (plain), + PARTNER (primary/orange). Filter bar: chips ALL (default lit) · PAYOUT DUE · PER LOT · PERCENTAGE; no search.
Partners table columns: INTRODUCING BROKER ACCOUNT | NAME | COMMISSION PLAN | CLIENTS | ACTIVE | LOTS · MONTH TO DATE | NET DEP · MTD | COMMISSION · MONTH TO DATE | PENDING COMMISSION | ACTIONS. Sortable all; default order payable desc (client). Single selection, no checkbox. Click = select + detail; double-click: nothing; Enter: nothing. ACTIONS shows "VIEW PAY" / "VIEW" (orange text, not a hit target).
Right-click on partner row: YES — header "IB {no} · {name}" (disabled), separator, "Referred clients (detail)", "Pay {x} pending…" (disabled when nothing due), "Edit commission plan…", separator, "Open IB account 360".
Right-click on empty partners area: YES — header "PARTNERS", separator, "Add new partner…".
Right detail panel "2) IB" title "{no} · {NAME}" or "SELECT A PARTNER". Content (scroll): Owner · Plan · Referred clients · Payable now · Last payout ("never" if none) · Sub-IB levels · link · schedule = NOT AVAILABLE; section FUNNEL · MTD -> "NOT AVAILABLE YET"; section REFERRED CLIENTS -> table; action grid of two equal buttons: "PAY {amount}" (left) | "EDIT PLAN" (right).
Referred clients table columns: CLIENT | NAME | PENDING COMMISSION | ACTIONS ("PAY" when >0). Sortable; default pending desc. Click: select only; double-click: pay. Right-click on row: YES — no header line; items "Pay {x} pending…" (disabled when 0) and "Open client {number}". Empty area: NO.
Column header right-click (both tables): YES — "COLUMNS", checkbox per column, "Reset columns". Multi-selection: NO.
Empty: "no IB relationships", "no referred clients", "NO PARTNER SELECTED". Loading: page veil. Error: header status.

## Issues
[money] IB · payout credits real balance with one admin's click: no maker-checker, unlike balance adjustments which go through APR approval · app/api/manage/ib-relationships/[id]/route.ts:31-84; ApiClient.ManageG6.cs:68-73
[money] IB · editing the plan re-prices already-accrued unpaid commission: pending is recomputed at pay time from every closed trade since lastPayoutAt using the current rate/type · lib/commission.ts:18-37; IbReportsScreens.cs:108-114
[money] IB · relationships can be created with DEMO client or DEMO IB accounts (no accountMode check), so demo trading volume accrues commission payable into the IB account balance · app/api/manage/ib-relationships/route.ts:88-97; lib/commission.ts:18-25
[money] IB · payout does not check the IB account status (SUSPENDED / CLOSED accounts are credited) · app/api/manage/ib-relationships/[id]/route.ts:24-45
[functional] IB · PAY PARTNER / PAYOUT RUN fire N parallel PATCHes; a partial failure only reports "{ok} of {n} paid" with no list of failures · IbReportsScreens.cs:90,107
[functional] IB · MANAGER without IB_PAYOUTS gets 403 on the whole screen, but the same pending-commission data is available to any MANAGER on RPT → IB · ib-relationships/route.ts:14; reports/ib/route.ts:9
[ux] IB · "PAY" / "VIEW PAY" in ACTIONS columns look like actions but are not clickable; paying needs a double-click, a context item or the detail button · IbReportsScreens.cs:56,77
[ux] IB · four partner columns (ACTIVE, LOTS · MONTH TO DATE, NET DEP · MTD, COMMISSION · MONTH TO DATE) are always "—" · IbReportsScreens.cs:56
[text] IB · plan type named "REV-SHARE", "% OF COMMISSION" and PERCENTAGE in three places; EDIT PLAN requires typing raw enum text · IbReportsScreens.cs:50,97,108

## Status counts
STATUS-COUNTS app=backoffice screen=IB WORKS=10 PARTIAL=1 UI-ONLY=1 PLACEHOLDER=2 DEAD=0 DUPLICATE=5
