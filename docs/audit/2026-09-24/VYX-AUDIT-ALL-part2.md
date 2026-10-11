# VYX-AUDIT-ALL part 2/9


<!-- ===== bo-GRP.md ===== -->

# bo-GRP · Groups (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\GroupsScreen.cs (GRP) + Controls\PricingPanel.cs (Level.Group). Nav: TRADING › "Groups" (ShellViewModel.cs:60).

## A. Purpose + panels
The broker's groups (routing category, dealer mode, trading restriction, default, halt) plus create/edit, allow-list, delete, halt; and per-group per-symbol pricing overrides.
Panels: 1) GRP "GROUPS" (left half) and 2) PRC "PRICING OVERRIDES" (right half) (GroupsScreen.cs:47-49). The class summary (GroupsScreen.cs:18-22) still says create/edit "arrive with G4 Settings" and "HALT per group is on Emergency" — both are now on this screen.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) GRP | GET /api/manage/groups | FetchGroupsAsync ApiClient.ManageG2.cs:118 | app/api/manage/groups/route.ts:19-90 (name asc; symbolConfigCount, hasMirrorRule) | on open / nav (>10 s); after writes; no poll, no live topic | none; column sort | none | "no groups"; error → Status |
| header DESK stat | GET /api/manage/dealing-desk-toggle | FetchDealerOnAsync ApiClient.ManageG2.cs:230 | app/api/manage/dealing-desk-toggle/route.ts:40-48 (dealerOn = Broker.dealingDeskAutoFillAt == null); needs RISK_SETTINGS (:43) | with GRP | — | — | "—" when forbidden/failed |
| 2) PRC | GET /api/manage/groups/{id}/pricing + GET /api/manage/symbols (≤ every 60 s, digits + broker markup) | FetchGroupPricingAsync ApiClient.ManageG2.cs:119; FetchBrokerSymbolsAsync :140 | app/api/manage/groups/[id]/pricing/route.ts:34-81 (enabled BrokerSymbols only) | on row click; after GRP refresh; RAW / CLIENT SPREAD re-rendered on ticks ≤1/s (PricingPanel.cs:89-93) | symbol name asc (server) | none | "select a group" / "loading…" / "no enabled symbols" / "pricing: <error>" (PricingPanel.cs:50, 69, 77, 125) |
| Allowed symbols dialog | GET /api/manage/groups/{id}/symbols | FetchGroupSymbolsAsync ApiClient.ManageG2.cs:124 | groups/[id]/symbols/route.ts:19-43 | on open | category, name | — | toast "<group>: <error>" |

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + GROUP (primary/orange) | GRP header | always | always | POST /api/manage/groups — CreateGroupAsync ApiClient.ManageG6.cs:118 → groups/route.ts:92-220 | Group create; clears other isDefault (:159-161); AuditLog GROUP_CREATED (:165-189) | client leverage rule, SO < MC, both > 0 (GroupsScreen.cs:202-203) / server same (:105-123), name unique 409 | form submit | no | MANAGER, BROKER_ADMIN (:11-17) | toast "<name> · created", refetch | WORKS |
| Right-click empty area → "Add new group…" | GRP table | always | always | as + GROUP | as above | as above | form | no | as above | as above | DUPLICATE (+ GROUP) |
| Row click | GRP table | always | always | GET groups/{id}/pricing | — | — | no | no | MANAGER, BROKER_ADMIN | loads PRC panel, title = group name | WORKS |
| Right-click → "Edit group…" | row menu | always | always | PATCH /api/manage/groups/{id} — PatchGroupAsync ApiClient.ManageG6.cs:119 → groups/[id]/route.ts:21-197 | Group update (all fields resent); AuditLog GROUP_CONFIG_UPDATED (:121-161); publishAccountsUpdated "group" (:164); 409 when a routing/mode change would strand accounts (:98-110) | as + GROUP | form submit | no | MANAGER, BROKER_ADMIN | toast "<name> · saved" | PARTIAL (body never sends tier → server resets Group.tier to STANDARD (:80, :119); swapFree always true/false so the tri-state "inherit" (null) cannot be kept (:77); unticking Default on the default group leaves the broker with no default group (no guard, :114-119) → new accounts fail NO_GROUP_AVAILABLE lib/account-provisioning.ts:76-81; Leverage edit does not change existing accounts' leverage (only applied at create / group move, app/api/manage/accounts/[id]/route.ts:168)) |
| Right-click → "Allowed symbols…" | row menu | always | always | GET then PUT /api/manage/groups/{id}/symbols — UpdateGroupSymbolsAsync ApiClient.ManageG2.cs:130 → groups/[id]/symbols/route.ts:49-103 | Group.restrictSymbols; GroupSymbol delete+createMany (non-enabled ids dropped silently :72-80); AuditLog GROUP_SYMBOLS_UPDATED (:88-98); publishAccountsUpdated "group_symbols" | client: ≥1 symbol when restricted (GroupsScreen.cs:226) / server array of strings | form submit | no | MANAGER, BROKER_ADMIN | toast "restricted to n symbols" / "every enabled symbol" | WORKS |
| Right-click → "Delete group…" | row menu | always | not IsDefault | DELETE /api/manage/groups/{id} — DeleteGroupAsync ApiClient.ManageG6.cs:120 → groups/[id]/route.ts:211-282 | Group delete (GroupSymbol / GroupSymbolConfig cascade); AuditLog GROUP_DELETED; 409 if any account in group | typed tenant name (Screen.cs:110-115) / server: not default, 0 accounts | yes, typed | no | server BROKER_ADMIN only (:213); menu enabled for MANAGER too | toast "<name> · deleted" | WORKS |
| Right-click → "Halt trading…" / "Resume trading…" | row menu | always | always | PATCH /api/manage/groups/{id}/halt {halted} — SetGroupHaltAsync ApiClient.ManageG2.cs:132 → groups/[id]/halt/route.ts:16-71 | Group.tradingHaltedAt; AuditLog GROUP_HALT_TOGGLED; publishAccountsUpdated "group_halt"; read by lib/risk.ts checkGroupTradingHalted via app/api/trade/orders/route.ts:192 | — | yes (danger on halt) | no | BROKER_ADMIN or EMERGENCY_CONTROLS (halt/route.ts:18) | toast "<name> · halted/resumed" | DUPLICATE (EMG screen, same endpoint per GroupsScreen.cs:146-148) |
| PRC row double-click → pricing dialog | PRC table | row | group selected | PATCH /api/manage/groups/{id}/pricing — UpdateGroupPricingAsync ApiClient.ManageG2.cs:121 → groups/[id]/pricing/route.ts:91-198 | GroupSymbolConfig upsert (all-null → delete) ; AuditLog GROUP_SYMBOL_PRICING_UPDATED / _RESET; publishAccountsUpdated "group_pricing" | client points ≥ 0, comm/swaps numbers (PricingPanel.cs:211-212) / server lib/pricing-editor-shared.ts:42-64 | form submit | no | MANAGER, BROKER_ADMIN | toast "<group> · SYM: target/markup … saved" (server read-back), reload | PARTIAL (TARGET mode is read only when Broker.pricingEngineEnabled; flag off → lib/group-pricing.ts:80-96 reads spreadMarkup + commission only; flag value per tenant UNVERIFIED (no DB access)) |
| PRC right-click → "Edit pricing…" | PRC row menu | always | always | as double-click | as above | as above | form | no | as above | as above | DUPLICATE (PRC row double-click) |
| PRC right-click → "Reset override (inherit)…" | PRC row menu | always | row HasOverride | PATCH …/pricing {reset:true} | GroupSymbolConfig deleteMany; AuditLog GROUP_SYMBOL_PRICING_RESET (pricing/route.ts:125-148) | — | yes (danger) | no | MANAGER, BROKER_ADMIN | toast "… override reset, now <source>" | WORKS |

## D. Dialogs
NEW GROUP / EDIT GROUP (GroupsScreen.cs:169-204):
| Field | Type | Default | Stored in | READ BY | Visibility |
|---|---|---|---|---|---|
| Name | text, required | "" | Group.name | display only | always |
| Leverage | number, required (LeverageInput rule) | 100 | Group.leverage | copied to Account.leverage at account create / group move only: app/api/manage/accounts/route.ts:269, accounts/[id]/route.ts:168; lib/coverage.ts:114. Fills use Account.leverage (app/api/trade/orders/route.ts:393, :581) | always |
| Margin call % | number, required | 100 | Group.marginCallLevel | lib/margin.ts:37, :63; lib/risk-monitor.ts:229; orders/route.ts:394 | always |
| Stop out % | number, required, < MC | 50 | Group.stopOutLevel | lib/margin.ts:63; lib/risk-monitor.ts:29, :229 (stop-out); engine margin_watch (UNVERIFIED column name) | always |
| Book / routing | choice B_BOOK / A_BOOK / DEALING (+ current REVERSAL/COVERAGE "(set elsewhere)") | group's category or B_BOOK | Group.category (+ shadow groupType lib/group-routing.ts:103-108) | resolveBookType app/api/trade/orders/route.ts:383, :593; lib/dealing-routing.ts via groupType | always |
| Account mode | choice ANY / LIVE_ONLY / DEMO_ONLY | ANY | Group.modeRestriction (A_BOOK forced LIVE_ONLY lib/group-routing.ts:78) | lib/account-structure.ts:74-108; lib/account-provisioning.ts:84 | always |
| Advanced dealing options | toggle (not sent) | on when dealer ≠ INHERIT or forced | nowhere (UI switch) | — | routing ≠ DEALING |
| Dealer | choice INHERIT / AUTO / MANUAL | group's or INHERIT | Group.dealingMode (hidden → group's own value resent, :197) | lib/dealing-routing.ts:3-14 via app/api/trade/orders/route.ts:292 | routing = DEALING or Advanced on |
| Trading | choice BOTH / BUY_ONLY / SELL_ONLY | BOTH | Group.tradingRestriction | lib/risk.ts checkGroupTradingRestriction via orders/route.ts:191 | always |
| Max lot | number, empty = no cap | "" | Group.maxLotSize | checkGroupMaxLot orders/route.ts:190 (per order) | always |
| Swap-free | toggle | group's (false) | Group.swapFree (sent as true/false only) | lib/pricing-engine.ts:168 (v2 path only); lib/swap-rollover.ts:166, :182 | always |
| Force dealer mode | toggle | group's | Group.forceDealingMode (hidden → group's own value) | lib/dealing-routing.ts:13 | routing = DEALING or Advanced on |
| Default group for new accounts | toggle | group's | Group.isDefault | lib/account-provisioning.ts:72-81 and callers | always |
Not in the form but written by PATCH: Group.tier (reset to STANDARD, groups/[id]/route.ts:80); Group.closeOnlyAt has no control on this screen (halt route supports {closeOnly}, halt/route.ts:29-39; ApiClient SetGroupCloseOnlyAsync ManageG2.cs:136 is unused here).

ALLOWED SYMBOLS · <GROUP> (GroupsScreen.cs:208-227): "Restrict to the chosen symbols" toggle → Group.restrictSymbols; "Symbols this group may trade" multi (visible when restrict = true) → GroupSymbol rows. READ BY lib/risk.ts checkGroupAllowedSymbol via orders/route.ts:194-199. Turning restriction off resends the stored list (:222).

PRICING · <GROUP> · <SYMBOL> (PricingPanel.cs:191-213):
| Field | Type | Default | Stored in | READ BY | Visibility |
|---|---|---|---|---|---|
| Spread | choice INHERIT / MARKUP / TARGET | from row | selects which column is written | — | always |
| Points | number ≥ 0, converted points → pips (PricingMath.cs:30-36) | row value in points | GroupSymbolConfig.spreadMarkup (MARKUP) or .targetTotalSpreadPips (TARGET) | markup: lib/group-pricing.ts:94 (flag off) and lib/pricing-engine.ts:143 (flag on); target: lib/pricing-engine.ts:124-126, :198-222 only when Broker.pricingEngineEnabled (:314-322) | mode ≠ INHERIT |
| Commission per lot | number, empty = inherit | row | GroupSymbolConfig.commissionPerLot | lib/group-pricing.ts:95; lib/pricing-engine.ts:152-158 | always |
| Swap long / Swap short | number, empty = inherit | row | GroupSymbolConfig.swapLong / swapShort | lib/swap-rollover.ts:77-78 (flag off, whole-row override), :233 (flag on) | always |
Live preview line: "raw x pts → client spread y pts … saved as z pips" (PricingPanel.cs:176-190). Saving TARGET sends spreadMarkup = null, dropping any fallback markup a web editor stored alongside the target (lib/pricing-engine.ts:36-43).

## E. Text
- "Desk is ON right now: desk-controlled groups QUEUE." (GroupsScreen.cs:186) and header "DEALER ON · INHERIT GROUPS QUEUE" (:83) are derived from Broker.dealingDeskAutoFillAt; the separate RISK "Manual dealing" switch (Broker.dealingModeAt) also feeds queueing (lib/dealing-routing.ts:13) and is not mentioned.
- Hint "points (1 pip = 10 points)" is a TextBox watermark (FormOverlay.cs:178), invisible whenever the field is prefilled.
- "Mode" choice labels "LIVE + DEMO" etc. fine; hint "A-BOOK is live-only whatever is chosen." accurate (lib/group-routing.ts:78).
- Class summary GroupsScreen.cs:18-22 refers to create/edit "with G4 Settings" and halt "on Emergency" (stale).
- PRICING column value "Source" for no overrides (GroupsScreen.cs:70) — unclear wording; PricingPanel calls the same level "BROKER SYMBOL".
- PricingPanel precedence line (PricingPanel.cs:61) is long and in upper case.

## F. UI structure map
Layout: two columns * / * (GroupsScreen.cs:49). No KPI strip.
Panel 1 header: "1) GRP" · "GROUPS"; header-right: stat "<n> GROUPS · <n> HALTED", stat "DESK <state>", Status text, button "+ GROUP" (primary/orange) (:47, :79-84).
Table GRP (layout "groups"): NAME · ROUTING · PRICING · DEALER · TRADING · DEFAULT · STATUS (:39-41). Values: ROUTING A-BOOK · LP / B-BOOK / DEALING DESK / REVERSAL / COVERAGE · SYS; PRICING "Source" or "Custom (n symbols)"; DEALER AUTO-FILL / MANUAL / BROKER DEFAULT (+ " · FORCED", " · MIRROR"); TRADING chip BOTH SIDES / BUY ONLY / SELL ONLY; DEFAULT "DEFAULT" chip; STATUS chip TRADING / HALTED. All headers sortable, no default sort (server name asc). Single select, no checkbox. Row click: select + load PRC. Double-click: nothing extra. Enter: nothing. Right-click on row: YES —
  "<Group name>" (disabled) / separator / "Edit group…" / "Allowed symbols…" / "Delete group…" (enabled when not default) / separator / "Halt trading…" or "Resume trading…" (:137-158).
Right-click empty area: YES — "GROUPS" (disabled) / separator / "Add new group…" (:42, Screen.cs:121-134). Right-click column header: YES, column picker (DataTable.cs:303-318). Empty: "no groups".
Panel 2 header: "2) PRC" · "PRICING OVERRIDES"; header-right: selected group name (accent). Under header: precedence text line (PricingPanel.cs:53-57).
Table PRC (layout "group-pricing-v2"): SYMBOL · RAW · PTS · MODE · VALUE · PTS · CLIENT SPREAD · PTS · SOURCE · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ACTIONS (PricingPanel.cs:46-50). MODE chip TARGET / MARKUP / INHERIT; VALUE "= x" (target) or "+ x"; SOURCE THIS GROUP / BROKER SYMBOL; comm/swaps own value or "inherits"; ACTIONS "EDIT" (orange text, not a separate button: double-click anywhere on the row opens the dialog). Sortable headers, no default sort. Single select. Row click: select; double-click: pricing dialog; Enter: nothing. Right-click on row: YES —
  "<Group> · <SYMBOL>" (disabled) / separator / "Edit pricing…" / "Reset override (inherit)…" (enabled when the row has an override) (PricingPanel.cs:149-163).
Right-click empty area: NO. Right-click header: YES, column picker. Empty: "select a group" / "loading…" / "no enabled symbols".
Dialog buttons: CREATE / SAVE (form), SAVE (pricing), "SAVE" (allowed symbols). Filter chips: none.

## Issues
- [money] GRP · group TARGET spread overrides take effect only when Broker.pricingEngineEnabled; with the flag off the fill path reads only markup + commission, the panel still shows the target as the client spread · lib/pricing-engine.ts:314-322, lib/group-pricing.ts:80-96, PricingPanel.cs:111, :132
- [functional] GRP · editing a group resets Group.tier to STANDARD (form never sends tier) · groups/[id]/route.ts:80, :119; GroupsScreen.cs:193-199
- [functional] GRP · unticking "Default group for new accounts" on the default group is accepted and leaves the broker with no default group; account creation then fails NO_GROUP_AVAILABLE · groups/[id]/route.ts:114-119, lib/account-provisioning.ts:76-81
- [functional] GRP · changing a group's Leverage does not change leverage of accounts already in the group · app/api/manage/accounts/[id]/route.ts:168, groups/[id]/route.ts:117-120
- [functional] GRP · Swap-free is always sent as true/false, so a group can never be put back to "inherit" (null) from this app · GroupsScreen.cs:198, groups/[id]/route.ts:77
- [ux] GRP · "Delete group…" is enabled for MANAGER, server allows BROKER_ADMIN only (403 after typing the tenant name) · GroupsScreen.cs:144, groups/[id]/route.ts:213
- [ux] GRP · per-group close-only exists on the server but has no control on this screen · halt/route.ts:29-39, ApiClient.ManageG2.cs:136
- [ux] GRP · saving TARGET mode sends spreadMarkup=null, silently dropping a fallback markup stored with the target · PricingPanel.cs:203, lib/pricing-engine.ts:36-43
- [text] GRP · DESK header / dealer hints describe only dealingDeskAutoFillAt; the RISK "Manual dealing" switch (dealingModeAt) also decides queueing · GroupsScreen.cs:83-84, :185-187, lib/dealing-routing.ts:10-13
- [text] GRP · class summary says create/edit arrive "with G4 Settings" and halt is "on Emergency" · GroupsScreen.cs:18-22

## Status counts
STATUS-COUNTS app=backoffice screen=GRP WORKS=5 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=3


<!-- ===== bo-ATY.md ===== -->

# bo-ATY · Account types (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\AccountTypesScreen.cs (ATY) + Controls\PricingPanel.cs (Level.AccountType). Nav: TRADING › "Account types" (ShellViewModel.cs:61).

## A. Purpose + panels
The broker's account-type tiers (Standard / Raw / …): list, create, edit, enable/disable; and the selected type's per-symbol pricing overrides.
Panels: 1) ATY "ACCOUNT TYPES" (left) and 2) PRC "PRICING OVERRIDES" (right) (AccountTypesScreen.cs:39-41).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) ATY | GET /api/manage/account-types | FetchAccountTypesAsync ApiClient.ManageG7.cs:29 | app/api/manage/account-types/route.ts:19-50 (sortOrder asc; flat pricing null → "0" :43-46) | on open / nav (>10 s); after writes; no poll | none; column sort | none | "no account types yet"; error → Status |
| 2) PRC | GET /api/manage/account-types/{id}/pricing + GET /api/manage/symbols (≤60 s) | FetchAccountTypePricingAsync ApiClient.ManageG7.cs:35 | app/api/manage/account-types/[id]/pricing/route.ts (GET: enabled BrokerSymbols, own override per field, defaults = the type's flat fields) | on row click; ticks ≤1/s re-render RAW / CLIENT | server symbol asc | none | "select an account type" / "loading…" / "no enabled symbols" / "pricing: <error>" |

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + TYPE (primary/orange) | ATY header | always | always | POST /api/manage/account-types — CreateAccountTypeAsync ApiClient.ManageG7.cs:31 → account-types/route.ts:82-158 | AccountType create; clears other isDefault; AuditLog ACCOUNT_TYPE_CREATED. Body has no pricing fields, so parsePricingFields writes spreadMarkup=0, commissionPerLot=0, swapLong=0, swapShort=0, swapFree=false (NOT null) (:61-79, :98, :109) | client Name required / server name, unique 409 | form | no | MANAGER, BROKER_ADMIN (:6-12) | toast "<name> · created" | PARTIAL (new type pins flat pricing to 0 and swapFree=false, which under the pricing engine beats every group override, see Issues) |
| Right-click empty area → "Add new type…" | ATY table | always | always | as + TYPE | as above | as above | form | no | as above | as above | DUPLICATE (+ TYPE) |
| Row click | ATY table | always | always | GET account-types/{id}/pricing | — | — | no | no | MANAGER, BROKER_ADMIN | loads PRC | WORKS |
| Right-click → "Edit…" | row menu | always | always | PATCH /api/manage/account-types/{id} — PatchAccountTypeAsync ApiClient.ManageG7.cs:33 → account-types/[id]/route.ts:60-171 | AccountType update; flat pricing fields absent from body fall back to existing value OR 0 when existing is null (:41-55) → a null (inherit) flat field becomes 0 on any edit; AuditLog ACCOUNT_TYPE_UPDATED; publishAccountsUpdated "account_type" | client Name required / server name; cannot untick the only default (:96-101) | form | no | MANAGER, BROKER_ADMIN | toast "<name> · saved" | PARTIAL (turns null flat pricing into 0) |
| Right-click → "Disable…" / "Enable…" | row menu | always | always | PATCH /api/manage/account-types/{id} body {enabled} only (AccountTypesScreen.cs:74-75) | server requires name: returns 400 "name is required" before anything is written (account-types/[id]/route.ts:74-77) | — | yes (danger on disable) | no | MANAGER, BROKER_ADMIN | toast with the 400 error | DEAD (always rejected; endpoint exists but this body can never pass) |
| PRC row double-click → pricing dialog | PRC table | row | type selected | PATCH /api/manage/account-types/{id}/pricing — UpdateAccountTypePricingAsync ApiClient.ManageG7.cs:37 → account-types/[id]/pricing/route.ts (PATCH) | AccountTypeSymbolConfig upsert / delete when all-null; AuditLog ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED / _RESET (:118, :149); publishAccountsUpdated "account_type_pricing" | client PricingPanel.cs:211-212 / server lib/pricing-editor-shared.ts:42-64 | form | no | MANAGER, BROKER_ADMIN | toast with server read-back | PARTIAL (read only when Broker.pricingEngineEnabled; flag off → the whole account-type level is ignored at fill, lib/pricing-engine.ts:314-322; flag per tenant UNVERIFIED) |
| PRC right-click → "Edit pricing…" | PRC row menu | always | always | as double-click | as above | as above | form | no | as above | as above | DUPLICATE (PRC row double-click) |
| PRC right-click → "Reset override (inherit)…" | PRC row menu | always | row HasOverride | PATCH …/pricing {reset:true} | AccountTypeSymbolConfig deleteMany; AuditLog ACCOUNT_TYPE_SYMBOL_PRICING_RESET | — | yes (danger) | no | MANAGER, BROKER_ADMIN | toast "… now <source>" | WORKS |

## D. Dialogs
NEW / EDIT ACCOUNT TYPE (AccountTypesScreen.cs:78-91):
| Field | Type | Default | Stored in | READ BY | Visibility |
|---|---|---|---|---|---|
| Name | text, required | "" | AccountType.name | portal type picker app/api/portal/account-types/route.ts:15-18 | always |
| Description | note | "" | AccountType.description | app/api/portal/account-types/route.ts:17 | always |
| Pricing hint | text, hint "shown to clients, e.g. …" | "" | AccountType.pricingHint | NOT sent to clients (portal select omits it, portal/account-types/route.ts:17); read only by web manager UI app/manage/(shell)/accounts/AccountsManager.tsx:670 | always |
| Sort order | number | 0 | AccountType.sortOrder | portal/account-types/route.ts:18 | always |
| Default for new accounts | toggle | type's | AccountType.isDefault | app/api/portal/accounts/route.ts:96-97, portal/live-account-requests/route.ts:68, manage/accounts/route.ts:166 | always |
Not editable here but written: spreadMarkup / commissionPerLot / swapLong / swapShort / swapFree (flat type defaults) — 0/false on create, 0 when null on edit (above). READ BY lib/pricing-engine.ts:141-168 (resolvePricingV2: type flat level sits ABOVE GroupSymbolConfig), lib/swap-rollover.ts:168-170. Enabled (menu only) READ BY portal/account-types/route.ts:16 and portal/accounts/route.ts:91.

PRICING · <TYPE> · <SYMBOL>: same fields as bo-GRP §D (PricingPanel.cs:191-213), stored in AccountTypeSymbolConfig.spreadMarkup / targetTotalSpreadPips / commissionPerLot / swapLong / swapShort. READ BY lib/pricing-engine.ts:132-168, :241-250 and lib/swap-rollover.ts:233 — only when Broker.pricingEngineEnabled (lib/pricing-engine.ts:314; swap-rollover.ts:153, :181). INHERIT preview shows "type default +x pts" or "the client's group decides" (PricingPanel.cs:220-224).

## E. Text
- Hint "shown to clients, e.g. \"spreads from 0.0 + $3.5/lot\"" (AccountTypesScreen.cs:83) — false, the client API never returns pricingHint.
- Column "MARKUP · PTS" converts with digits hard-coded to 2 (AccountTypesScreen.cs:56); GET returns "0" for a null markup (route.ts:43) so "0" and "not set" look the same; COMMISSION / SWAP columns show raw strings, "0" for null.
- Summary line (AccountTypesScreen.cs:17-20) says "empty inherits, RESET clears" — true for per-symbol rows, not for the type's flat fields which this screen cannot clear.
- Menu confirm text "no new accounts can pick it" (:74) describes an action that always fails.

## F. UI structure map
Layout: two columns * / * (:41). No KPI strip.
Panel 1 header: "1) ATY" · "ACCOUNT TYPES"; header-right: stat "<n> TYPES · <n> ENABLED", Status, button "+ TYPE" (primary/orange).
Table ATY (layout "account-types"): NAME · DESCRIPTION · PRICING · MARKUP · PTS · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ORDER · DEFAULT · STATUS (:32-33). DEFAULT chip "DEFAULT"; STATUS chip ENABLED / DISABLED. Sortable headers, no default sort (server sortOrder asc). Single select, no checkbox. Row click: select + load PRC. Double-click / Enter: nothing. Right-click on row: YES —
  "<Type name>" (disabled) / separator / "Edit…" / "Disable…" or "Enable…" (:68-77).
Right-click empty area: YES — "ACCOUNT TYPES" (disabled) / separator / "Add new type…". Right-click header: YES, column picker. Empty: "no account types yet".
Panel 2 header: "2) PRC" · "PRICING OVERRIDES"; header-right: selected type name. Precedence text line: "WHO DECIDES A CLIENT'S SPREAD: account › THIS ACCOUNT TYPE · symbol › this type's default › the client's group › broker symbol. …" (PricingPanel.cs:62).
Table PRC (layout "account-type-pricing-v2"): SYMBOL · RAW · PTS · MODE · VALUE · PTS · CLIENT SPREAD · PTS · SOURCE · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ACTIONS. SOURCE THIS TYPE · SYMBOL / TYPE DEFAULT / CLIENT'S GROUP; CLIENT SPREAD "per group" when the group decides; comm/swaps own value, "<x> (type)", or "inherits". Sortable, single select. Double-click: dialog. Right-click row: YES — "<Type> · <SYMBOL>" (disabled) / separator / "Edit pricing…" / "Reset override (inherit)…" (enabled when HasOverride). Right-click empty area: NO. Header: column picker. Empty: "select an account type".
Because every type created here has flat markup 0 (non-null), SOURCE for rows without a per-symbol override shows "TYPE DEFAULT +0", never "CLIENT'S GROUP" (PricingPanel.cs:113-117).

## Issues
- [money] ATY · creating a type writes flat spreadMarkup/commission/swaps = 0 and swapFree = false; in resolvePricingV2 the type flat level beats GroupSymbolConfig, so every account of that type gets 0 markup, 0 commission, 0 swaps and swap-free=false regardless of group overrides (when pricingEngineEnabled) · account-types/route.ts:61-79, :98; lib/pricing-engine.ts:141-168; AccountTypesScreen.cs:87
- [money] ATY · editing a type converts null (inherit) flat pricing to 0 · account-types/[id]/route.ts:41-55; AccountTypesScreen.cs:87-88
- [functional] ATY · Disable/Enable always fails: PATCH body {enabled} lacks the required name → 400 · AccountTypesScreen.cs:75, account-types/[id]/route.ts:74-77
- [functional] ATY · account-type per-symbol pricing is ignored at fill unless Broker.pricingEngineEnabled, the panel gives no sign of that · lib/pricing-engine.ts:314-322
- [functional] ATY · the type's flat pricing (markup/commission/swaps/swap-free) has no editor in this app · AccountTypesScreen.cs:80-85
- [text] ATY · "Pricing hint … shown to clients" is not sent to clients · AccountTypesScreen.cs:83, app/api/portal/account-types/route.ts:17
- [text] ATY · MARKUP · PTS uses digits=2 for every type and cannot show "not set" (server sends "0") · AccountTypesScreen.cs:56, account-types/route.ts:43

## Status counts
STATUS-COUNTS app=backoffice screen=ATY WORKS=2 PARTIAL=3 UI-ONLY=0 PLACEHOLDER=0 DEAD=1 DUPLICATE=2


<!-- ===== bo-MIR.md ===== -->

# bo-MIR · Mirror rules (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:107-190 (MirrorScreen, MIR). Nav: TRADING › "Mirror rules" (ShellViewModel.cs:62).

## A. Purpose + panels
Copy / reverse trading rules: a source account or group mirrored into a target account at a multiplier, with symbol filter and kill-switch caps.
One panel: 1) MIR "MIRROR · REVERSE TRADING RULES" (:121).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) MIR | GET /api/manage/mirror-rules | FetchMirrorRulesAsync ApiClient.ManageG6.cs:159 | app/api/manage/mirror-rules/route.ts:75-102 (status ACTIVE / DISABLED / KILLED from enabled + killedAt, :19-22) | live topics order, position (:112); on open; after writes | none | none | "no mirror rules"; error → Status |
| NEW RULE pickers | GET /api/manage/accounts + GET /api/manage/groups | FetchManageAccountsAsync ApiClient.ManageG1.cs:152; FetchGroupsAsync ManageG2.cs:118 | accounts/route.ts:21; groups/route.ts:19 | on "+ RULE" | — | — | — |
Role: GET/POST/PATCH require BROKER_ADMIN or MIRROR_MANAGE permission (mirror-rules/route.ts:15, mirror-rules/[id]/route.ts:13).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + RULE (primary/orange) | header | always | always | GET accounts, GET groups, then POST /api/manage/mirror-rules — CreateMirrorRuleAsync ApiClient.ManageG6.cs:160 → mirror-rules/route.ts:104-191 | MirrorRule create; AuditLog MIRROR_RULE_CREATED (:176-188) | client: source account required when ACCOUNT, multiplier > 0, target/source account numbers resolved client-side (:179-183) / server: source + target in broker, no self-mirror, multiplier > 0, caps decimal (:110-158) | form | no | BROKER_ADMIN or MIRROR_MANAGE | toast "mirror rule → <acc> created" | WORKS |
| Right-click empty area → "Add new mirror rule…" | table | always | always | as + RULE | as above | as above | form | no | as above | as above | DUPLICATE (+ RULE) |
| Double-click ACTIONS cell ("DISABLE" / "ENABLE") | table | status ≠ KILLED (cell empty when KILLED) | not KILLED (toast "a killed rule stays off" :142) | PATCH /api/manage/mirror-rules/{id} {enabled} — PatchMirrorRuleAsync ApiClient.ManageG6.cs:161 → mirror-rules/[id]/route.ts:134-232 | MirrorRule.enabled; AuditLog MIRROR_RULE_UPDATED (:217-231); read by lib/mirror.ts:276 | — | yes (danger on disable) | no | as above | toast "rule · enabled/disabled" | WORKS |
| Right-click → "Disable…" / "Enable…" | row menu | always | not KILLED | as above | as above | — | yes | no | as above | as above | DUPLICATE (ACTIONS double-click) |
| Right-click → "Edit multiplier / fill / symbols…" | row menu | always | always (also for KILLED) | PATCH /api/manage/mirror-rules/{id} {multiplier, fillPriceMode, symbolFilter} | MirrorRule.multiplier / fillPriceMode / symbolFilter (upper-cased, :182-187); AuditLog MIRROR_RULE_UPDATED | client multiplier > 0 / server same (:166-175) | form | no | as above | toast "rule saved" | WORKS |
Server features with no control: re-enabling a KILLED rule (PATCH enabled:true clears killedAt, mirror-rules/[id]/route.ts:155-159) — blocked in the UI (:142, :150); editing maxOpenLots / maxDailyLoss after creation (mirror-rules/[id]/route.ts:190-205); rule detail with MIRROR_FAILED audit history (GET mirror-rules/[id], :28-127); no delete endpoint exists.

## D. Dialogs
NEW MIRROR RULE (:166-189):
| Field | Type | Default | Stored in | READ BY | Visibility |
|---|---|---|---|---|---|
| Source | choice ONE ACCOUNT / A GROUP | ACCOUNT | MirrorRule.sourceType | lib/mirror.ts (rule lookup by source) | always |
| Source account number | text | "" | resolved to Account.id → MirrorRule.sourceId | lib/mirror.ts | always (hint "when source = account"; not hidden for GROUP) |
| Source group | choice (group names) | first group | MirrorRule.sourceId when GROUP | lib/mirror.ts | always (not hidden for ACCOUNT) |
| Target account number | text, required | "" | MirrorRule.targetAccountId | lib/mirror.ts (opens mirror position on target) | always |
| Direction | choice REVERSE / COPY (SAME) | REVERSE | MirrorRule.direction | lib/mirror.ts:313 | always |
| Multiplier | number, required > 0 | 1 | MirrorRule.multiplier | lib/mirror.ts:335 (roundMirrorVolume, clamped to BrokerSymbol min/max/step) | always |
| Fill price | choice SOURCE PRICE / MARKET | SOURCE_PRICE | MirrorRule.fillPriceMode | lib/mirror.ts:354, :523 | always |
| Symbol filter | text, comma list, empty = all | "" | MirrorRule.symbolFilter (upper-cased) | lib/mirror.ts:230 matchesSymbolFilter | always |
| Max open lots | number, empty = no cap | "" | MirrorRule.maxOpenLots | lib/mirror.ts:162-172 (kill switch) | always |
| Max daily loss | number, empty = no cap | "" | MirrorRule.maxDailyLoss | lib/mirror.ts:176-203 (kill switch → enabled=false, killedAt, :141) | always |
EDIT MIRROR RULE (:155-165): Multiplier (required), Fill price, Symbol filter — same columns/readers as above; detail line "<source> → <target>".

## E. Text
- Toast "a killed rule stays off" (:142) — server supports re-enabling a killed rule (mirror-rules/[id]/route.ts:155-159).
- "Source account number" / "Source group" both always visible with "when source = …" hints (:172-173) instead of conditional visibility.
- LIMITS column "loss <x>/day" (:136).

## F. UI structure map
Layout: single panel. Header: "1) MIR" · "MIRROR · REVERSE TRADING RULES"; header-right: stat "<n> ACTIVE OF <n>" (green when any active), Status, button "+ RULE" (primary/orange). No KPI strip, no filter chips.
Table (layout "mirror-rules"): SOURCE · DIRECTION · TARGET ACCOUNT · MULTIPLIER · FILL PRICE · SYMBOLS · LIMITS · STATUS · SINCE · ACTIONS (:116-118). SOURCE "<ACCOUNT|GROUP> · <label>"; DIRECTION amber for REVERSE; MULTIPLIER "× n"; SYMBOLS list or "ALL"; LIMITS "max n lots · loss n/day" or "—"; STATUS chip ACTIVE / DISABLED / KILLED; ACTIONS "DISABLE"/"ENABLE" (empty for KILLED). Sortable headers, no default sort (server order). Single select, no checkbox. Row click: select. Double-click: only on the ACTIONS cell (toggle); elsewhere nothing. Enter: nothing. Right-click on row: YES —
  "<source> → <target>" (disabled) / separator / "Disable…" or "Enable…" (disabled when KILLED) / "Edit multiplier / fill / symbols…" (:146-153).
Right-click empty area: YES — "MIRROR RULES" (disabled) / separator / "Add new mirror rule…" (:122). Right-click header: YES, column picker. Empty: "no mirror rules".

## Issues
- [functional] MIR · a KILLED rule cannot be re-enabled from the app although the server supports it (clears killedAt) · ApprovalsMirrorScreens.cs:142, :150 vs mirror-rules/[id]/route.ts:155-159
- [functional] MIR · Max open lots / Max daily loss (the kill-switch caps) cannot be changed after creation from the app; server PATCH supports both · ApprovalsMirrorScreens.cs:157-163, mirror-rules/[id]/route.ts:190-205
- [ux] MIR · rules cannot be deleted (no endpoint, no control); failure history (MIRROR_FAILED audit) not shown · mirror-rules/[id]/route.ts:28-127
- [ux] MIR · NEW RULE shows both source account and source group fields regardless of Source choice · ApprovalsMirrorScreens.cs:172-173
- [text] MIR · "a killed rule stays off" contradicts server behaviour · ApprovalsMirrorScreens.cs:142

## Status counts
STATUS-COUNTS app=backoffice screen=MIR WORKS=3 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2


<!-- ===== bo-RISK.md ===== -->

# bo-RISK · Risk (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:17-115 (RiskScreen, RISK). Nav: RISK › "Risk" (ShellViewModel.cs:64), F9 "RISK".

## A. Purpose + panels
Broker-wide risk settings (manual dealing switch, smart dealer %, total exposure / max positions limits, trading state) plus a margin watch.
Layout: KPI strip (4 tiles, 54 px) on top; below: 1) RISK "BROKER RISK SETTINGS" (left, 380 px) and 2) MRG "MARGIN WATCH · LOWEST FIRST" (fills) (RiskScreen.cs:46-51).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) RISK | GET /api/manage/risk | FetchRiskSettingsAsync ApiClient.ManageG2.cs:162-166 | app/api/manage/risk/route.ts:12-42 (needs RISK_SETTINGS or EMERGENCY_CONTROLS :15) | live topics position, margin; poll 10 s (:24-25); after writes | — | — | "RISK SETTINGS UNAVAILABLE" (:76); Status "risk: …" |
| KPI + 2) MRG | GET /api/manage/margin + GET /api/manage/positions | FetchMarginAsync ApiClient.ManageG1.cs:223; FetchManagePositionsAsync :224 | app/api/manage/margin/route.ts:10-43 → lib/margin.ts computeAccountMarginSnapshots (accounts with OPEN positions, :34) | same + ticks ≤1/s re-price equity / free / P/L / level (LiveMath.Reprice, :32-38) | server sorted by margin level asc (margin/route.ts:40) | first 200 rows (:106) | "no accounts with positions"; Status "margin: …" |
KPI tiles (:69-74): OPEN EXPOSURE (Σ MarginRow.Exposure, note "USD NOTIONAL"); FLOATING P/L · CLIENTS (Σ floating, "USD"); OPEN POSITIONS ("<n> ACCOUNTS"); ACCOUNTS AT RISK (level ≤ margin call; note "<n> AT STOP-OUT"). MarginRow.Exposure is the sum of LOTS (lib/margin.ts:65), not USD notional.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Manual dealing "TURN ON" / "TURN OFF" | RISK › DEALING MODE | settings loaded | always | PATCH /api/manage/risk {dealingMode} — PatchRiskAsync ApiClient.ManageG2.cs:169 → risk/route.ts:44-236 | Broker.dealingModeAt (:97-103); AuditLog (:203-215) | server boolean | yes "DEALING MODE ON/OFF" (danger on ON) | no | BROKER_ADMIN or RISK_SETTINGS (:74) | toast "dealing mode on/off"; refetch | PARTIAL (confirm says "Every market order will wait in the dealer queue" but with the desk auto-fill on, B_BOOK/DEALING INHERIT groups still fill automatically, lib/dealing-routing.ts:10-13; AUTO groups never queue) |
| Smart dealer "EDIT" | RISK › reject % row | settings loaded | always | PATCH /api/manage/risk {smartDealerAcceptPct, smartDealerRejectPct} (both null = clear) | Broker.smartDealerAcceptPct / RejectPct (:148-164); AuditLog; READ BY app/api/trade/orders/route.ts:355-460 (dealing-queue auto accept/reject by slippage %) | client "a b", b ≥ a (:89) / server each > 0 or blank (:140-147) → "0 2" passes client, fails server | dialog (ConfirmWithInput "SAVE") | no | BROKER_ADMIN or RISK_SETTINGS | toast "smart dealer a / b %" | WORKS |
| Limits "EDIT" | RISK › max positions row | settings loaded | always | PATCH /api/manage/risk {totalExposureLimit, maxOpenPositionsPerAccount} | Broker.totalExposureLimit (LOTS, lib/risk.ts:330-347 via orders/route.ts:203), Broker.maxOpenPositionsPerAccount (lib/risk.ts checkMaxOpenPositions via orders/route.ts:201; engine db.rs); AuditLog | client: "exposure positions"; a missing/invalid part is sent as null = clears that limit (:98-100) / server positive (:105-135) | dialog | no | BROKER_ADMIN or RISK_SETTINGS | toast "limits saved" | PARTIAL (prompt and display call the exposure limit USD; server enforces it in LOTS; typing one number clears the other limit) |
| "EMERGENCY" | RISK › TRADING STATE | settings loaded | always | navigation Shell.Navigate("EMG") (:103) | — | — | no | — | — | EMG screen | WORKS |
| "FULL MARGIN SCREEN" | MRG panel header | always | always | navigation to MRG (:49) | — | — | no | — | — | MRG screen | WORKS |
| Margin row double-click | MRG table | row | always | Shell.Open("CLI", accountId) (:44) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Open client 360" | MRG row menu | always | always | Shell.Open("CLI", accountId) (RiskScreen.cs:148) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure · this account" | MRG row menu | always | always | Shell.Open("EXP", accountNumber) (:149) | — | — | no | — | — | EXP filtered to the account (LiveExposureScreen.cs:109-113) | WORKS |
| Right-click → "Close all <n> positions…" | MRG row menu | always | PositionCount > 0 | POST /api/manage/positions/close-bulk {scope:"ALL", accountId} — CloseBulkAsync ApiClient.ManageG6.cs:138-139 → positions/close-bulk/route.ts:20-71 → lib/bulk-close.ts closeBulkForAccount | Positions closed + P/L transactions; mirror.onClose + coverage.onClose per position (lib/bulk-close.ts:185-194); NATS PositionsClosed (:199); AuditLog MANUAL_POSITION_BULK_CLOSE (close-bulk/route.ts:48-63) | — | yes (danger) "CLOSE ALL POSITIONS" | no | MANAGER, BROKER_ADMIN (close-bulk/route.ts:10) | toast "<acc> · positions closed" even when some failed (response failed count ignored, :153) | PARTIAL (partial failures reported as success) |
Display-only rows (no control): Smart dealer accept %, Total exposure limit, Trading HALTED/OPEN, Close-only ON/OFF (:83, :93, :103-104).

## D. Dialogs
- DEALING MODE ON / OFF (Confirm): no fields.
- SMART DEALER (ConfirmWithInput :85-91): input "ACCEPT % · REJECT %" text "a b" or empty. Stored Broker.smartDealerAcceptPct / smartDealerRejectPct. READ BY app/api/trade/orders/route.ts:359-364, :457.
- LIMITS (ConfirmWithInput :95-101): input "EXPOSURE USD · MAX POSITIONS" text "e.g. \"5000000 50\"". Stored Broker.totalExposureLimit (Decimal(18,2), prisma/schema.prisma:402, unit LOTS per lib/risk.ts:330-346) and Broker.maxOpenPositionsPerAccount. READ BY app/api/trade/orders/route.ts:201-203, dealing-desk-toggle/route.ts, dealing-queue/[id]/route.ts, positions/route.ts, engine/order-management/src/db.rs (max positions).
- CLOSE ALL POSITIONS (Confirm): no fields; text "… at market? One transaction."

## E. Text
- "Total exposure limit … USD" (:93) and dialog "EXPOSURE USD", example "5000000" (:95) — server unit is lots (lib/risk.ts:346 message "… of X lots").
- KPI "OPEN EXPOSURE" note "USD NOTIONAL" formatted as money (:69) — value is Σ lots (lib/margin.ts:65).
- "Every market order will wait in the dealer queue." (:81) — not true while the desk auto-fill switch is on (lib/dealing-routing.ts:12).
- "Manual dealing" here vs "DESK … DEALER ON" on GRP / dealing desk: two different broker switches (Broker.dealingModeAt vs Broker.dealingDeskAutoFillAt) with overlapping names.
- "Slippage %: auto-accept below, auto-reject above. Type \"accept reject\", e.g. \"0.5 2\". Empty = clear." (:85) — free-text two-number input instead of two fields.
- Summary (:17-20) says "4 stat tiles … every write is a PATCH risk" — close-all is a positions write.

## F. UI structure map
Layout: KPI row (4 equal tiles) / body: left 380 px settings, right margin watch (:46-51).
KPI tiles in order: OPEN EXPOSURE · FLOATING P/L · CLIENTS · OPEN POSITIONS · ACCOUNTS AT RISK.
Panel 1 header: "1) RISK" · "BROKER RISK SETTINGS"; header-right: Status. Body sections: DEALING MODE (Manual dealing + TURN ON/OFF button; Smart dealer accept %; Smart dealer reject % + EDIT), EXPOSURE & POSITION LIMITS (Total exposure limit; Max open positions / account + EDIT), TRADING STATE (Trading + EMERGENCY; Close-only).
Panel 2 header: "2) MRG" · "MARGIN WATCH · LOWEST FIRST"; header-right: stat "<n> WITH POSITIONS · <n> AT RISK", button "FULL MARGIN SCREEN" (not primary).
Table (layout "risk-margin", RiskScreen.cs:157-159): ACCOUNT · CLIENT · EQUITY · USED MARGIN · FREE MARGIN · POSITIONS · EXPOSURE · FLOATING PROFIT / LOSS · MARGIN LEVEL · STATUS. STATUS chip NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK (:162). Sortable headers, no default sort (server level asc). Single select. Row click: select; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360" / "Live exposure · this account" / separator / "Close all <n> positions…" (enabled when n > 0) (:143-156).
Right-click empty area: NO. Header: column picker. Empty: "no accounts with positions". Buttons: TURN ON/OFF, EDIT ×2, EMERGENCY, FULL MARGIN SCREEN; none primary.

## Issues
- [money] RISK · total exposure limit is shown and prompted as USD (example 5,000,000) but enforced in lots; a broker following the prompt sets an effectively unlimited cap · RiskScreen.cs:93, :95; lib/risk.ts:330-346
- [money] RISK · OPEN EXPOSURE KPI labels a sum of lots as "USD NOTIONAL" money · RiskScreen.cs:69; lib/margin.ts:65
- [functional] RISK · "Manual dealing ON" confirm promises every market order queues; with desk auto-fill on, INHERIT B_BOOK/DEALING groups still auto-fill · RiskScreen.cs:81; lib/dealing-routing.ts:10-13
- [functional] RISK · LIMITS dialog sends null for a missing second number, silently clearing the max-positions limit · RiskScreen.cs:98-100
- [functional] RISK · "Close all positions" reports success when some positions failed to close · RiskScreen.cs:153; close-bulk/route.ts:65-70
- [ux] RISK · smart dealer "0 x" passes client validation and is refused by the server (must be > 0) · RiskScreen.cs:89; risk/route.ts:140-151
- [text] RISK · two broker switches named "Manual dealing" (dealingModeAt) and "DESK / dealer on" (dealingDeskAutoFillAt) · RiskScreen.cs:80; GroupsScreen.cs:83

## Status counts
STATUS-COUNTS app=backoffice screen=RISK WORKS=5 PARTIAL=3 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-RDR.md ===== -->

# bo-RDR · Risk radar (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:293-398 (RiskRadarScreen, RDR). Nav: RISK › "Risk radar" (ShellViewModel.cs:65); nav badge = flagged accounts + same-IP clusters (Views/MainWindow.axaml.cs:201).

## A. Purpose + panels
30-day behavioural flags per account (scalp, martingale, latency arbitrage, news) and same-IP clusters; read-only.
Layout: KPI strip (8 tiles); 1) RDR "RISK RADAR · 30-DAY BEHAVIOUR" (fills) and 2) ACCT "FLAGGED ACCOUNT" (right, 380 px) (:312-315).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| all | GET /api/manage/risk-radar → {rows, sameIpClusters} | FetchRiskRadarAsync ApiClient.ManageG5.cs:81-96 | app/api/manage/risk-radar/route.ts:16-38 → lib/risk-radar.ts computeRiskRadar :120-160 (CLOSED positions, closedAt ≥ now−30 d; accounts with ≥1 trade) + computeSameIpClusters :166-210 (LoginEvent by IP, ≥2 accounts and ≥2 distinct emails) | on open / nav (>10 s); no poll, no topic; server in-memory cache 5 min per broker (route.ts:12-36) | chips ALL / FLAGGED / SCALP / MARTINGALE / LATENCY ARB / NEWS (client :330); order flags desc, P/L per day desc (:348) | none | "no accounts with 30-day activity" / "no accounts match this flag" (:359); error → Status |
Role: MANAGER, BROKER_ADMIN (route.ts:18).
Flag sources: scalp = avg hold < 2 min (lib/risk-radar.ts:39, :113); martingale = size ≥ 1.5× after a loss, ≥ 3 hits (:46-47); latency arb = ≥10 trades held ≤3 s with win rate ≥25 pts above the rest (:72-80); newsTraderFlag hard-coded false (:116).
Cluster shape mismatch: server account key is accountId (lib/risk-radar.ts:163, :184-189); client reads "id" (ApiClient.ManageG5.cs:61-63) → SameIpAccount.Id is always "".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Chips ALL / FLAGGED / SCALP / MARTINGALE / LATENCY ARB | filter bar | always | always | none (client :327-331, :347) | — | — | no | — | — | rows filtered | WORKS |
| Chip NEWS | filter bar | always | always | none | — | — | no | — | — | always empty: server never sets the flag (lib/risk-radar.ts:116) | PLACEHOLDER |
| Row click | table | row | always | none (:308) | — | — | no | — | — | detail panel | WORKS |
| Row double-click | table | row | always | Shell.Open("CLI", accountId) (:309) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Flags · stats (detail)" | row menu | always | always | detail render (:310) | — | — | no | — | — | detail | DUPLICATE (row click) |
| Right-click → "Open client 360" | row menu | always | always | Shell.Open("CLI", accountId) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure" | row menu | always | row source present | Shell.Open("EXP", accountNumber) | — | — | no | — | — | EXP filtered to account | WORKS |
| OPEN CLIENT (primary/orange) | detail | account selected | always | Shell.Open("CLI", accountId) (:385) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| EXPOSURE | detail | account selected | always | Shell.Open("EXP", accountId) (:385) | — | — | no | — | — | EXP filtered | DUPLICATE (row menu "Live exposure") |
| Cluster account links "<acc> · <name>" | detail, SAME-IP CLUSTERS | cluster exists | always | Shell.Open("CLI", a.Id) (:395) with a.Id = "" | — | — | no | — | — | CLI opens without selecting the account | PARTIAL (id key mismatch) |
| "FLAG · WHITELIST · NOTE — not available yet" | detail | account selected | — | none (:387) | — | — | — | — | — | — | PLACEHOLDER |

## D. Dialogs
None.

## E. Text
- Detail "same-IP clusters: none" for every account (:382-383): the membership test compares a.Id ("" after parsing) with AccountId.
- "News trader" row / NEWS chip / NEWS TRADER KPI (:300, :375) for a flag the server never computes.
- Score labels LOW / MED / HIGH (:326) for flag counts 1 / 2 / ≥3; column header says "FLAGS".
- "Martingale (size ×1.5 after loss, ≥ 3×)" (:373), "Scalper (avg hold < 2 m)" (:372) match lib thresholds.
- Summary (:293-297) "Flag / whitelist / notes have no endpoint" — accurate.

## F. UI structure map
KPI tiles in order: ACCOUNTS TRACKED · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS TRADER · SAME-IP CLUSTERS · TOP PROFIT / DAY (:300, :312).
Panel 1 header: "1) RDR" · "RISK RADAR · 30-DAY BEHAVIOUR"; header-right: stat "<shown> OF <total> · <n> SAME-IP", Status. Filter bar chips in order: ALL (default) · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS.
Table (layout "risk-radar"): ACCOUNT · FLAGS · WHICH · TRADES · 30D · WIN RATE · AVERAGE HOLD · AVERAGE LOT · P/L PER DAY (:306-307). FLAGS chip — / LOW / MED / HIGH. Sortable headers; default = client order (flag count desc, P/L per day desc). Single select (first load auto-selects the top row, :335). Row click: detail; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc>" (disabled) / separator / "Flags · stats (detail)" / "Open client 360" / "Live exposure" (:310).
Right-click empty area: NO. Header: column picker.
Panel 2 header: "2) ACCT" · "FLAGGED ACCOUNT". Body: account; score; section FLAGS · 30 DAYS (Scalper / Martingale / Latency arbitrage / News trader: FLAGGED or clear); section STATS (trades, win rate, avg hold, avg lot, profit velocity / day, same-IP clusters); buttons OPEN CLIENT (primary/orange), EXPOSURE; "FLAG · WHITELIST · NOTE — not available yet"; section "SAME-IP CLUSTERS · <n>" with up to 20 clusters, each "<ip> <n> ACCOUNTS" and account links; "NONE" when empty; "SELECT AN ACCOUNT" when nothing selected.

## Issues
- [functional] RDR · same-IP cluster accounts parse with empty Id (server sends accountId, client reads id): per-account "same-IP clusters" is always "none" and cluster links open CLI without the account · lib/risk-radar.ts:163, :184-189; ApiClient.ManageG5.cs:61-63; LiquidityScreens.cs:382-383, :395
- [functional] RDR · news-trader flag is never computed (hard-coded false) but has a chip, KPI and detail row · lib/risk-radar.ts:116; LiquidityScreens.cs:300, :330, :375
- [ux] RDR · results cached 5 min server-side per broker with no "as of" time shown · app/api/manage/risk-radar/route.ts:12-36
- [text] RDR · FLAGS column shows LOW/MED/HIGH words, not the flag count its header names · LiquidityScreens.cs:306, :326

## Status counts
STATUS-COUNTS app=backoffice screen=RDR WORKS=4 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=2 DEAD=0 DUPLICATE=4


<!-- ===== bo-EMG.md ===== -->

# bo-EMG — Trading halt / Emergency (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:80-178 (class EmergencyScreen). Nav title "Trading halt" (ShellViewModel.cs:66). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Broker-wide halt of new trading, broker-wide close-only mode, per-group halt, per-symbol disable. Open positions are not touched.
Panels (2×2 grid, top row 190 px): "1) HALT · HALT ALL NEW TRADING" (top-left), "2) CLOSE-ONLY · CLOSE-ONLY MODE" (top-right), "3) GROUPS · HALT ONE GROUP" (bottom-left), "4) SYMBOLS · DISABLE ONE SYMBOL" (bottom-right) (SecurityEmergencyScreens.cs:100-104).

## B. Data
| Read | ApiClient | Route | Gate |
|---|---|---|---|
| GET /api/manage/risk | FetchRiskSettingsAsync ApiClient.ManageG2.cs:162 | app/api/manage/risk/route.ts:12 | BROKER_ADMIN, or MANAGER with RISK_SETTINGS or EMERGENCY_CONTROLS (route.ts:14-17) |
| GET /api/manage/groups | FetchGroupsAsync ManageG2.cs:118 | app/api/manage/groups/route.ts:19 | MANAGER, BROKER_ADMIN |
| GET /api/manage/symbols | FetchBrokerSymbolsAsync ManageG2.cs:140 | app/api/manage/symbols/route.ts:42 | MANAGER, BROKER_ADMIN |
Refresh: no live topics, no poll; on nav (>10 s) and after each write. If the risk read fails the method returns before rendering groups and symbols, so both tables stay empty (:112). Groups/symbols failures are toasts (:115-116).
Groups table: sorted by name (:145). TYPE column = ManageGroup.GroupType (:145) = JSON "groupType" (ApiClient.ManageG2.cs:22) = legacyGroupTypeFor(g) (groups/route.ts:84) = COVERAGE if category COVERAGE, DEMO if modeRestriction DEMO_ONLY, LP if category A_BOOK, otherwise DEALING (lib/group-routing.ts:103-108). The routing axis Group.category (groups/route.ts:78) is not shown. ApiClient.ManageG2.cs:15-16 states GroupType is a pre-Stage-1 shadow "nothing here reads".
Symbols table: search by name, disabled first then name (:153).
Header stats: "{n} OF {m} HALTED" (groups), "{n} OF {m} DISABLED" (symbols).
Empty: "no groups", "no symbols" / "no symbols match". Status rows show "—" until risk loads.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| HALT ALL NEW TRADING (danger) / RESUME ALL TRADING (primary) | 1) HALT (:126,160-162) | always (label by state) | always | PatchRiskAsync ManageG2.cs:169 -> PATCH /api/manage/risk {tradingHalted} | Broker.tradingHaltedAt = now / null + AuditLog RISK_HALT_TOGGLED, entityType Broker (risk/route.ts:81-87,200-215); READ BY lib/risk.ts:11-13 checkTradingHalted, lib/mirror.ts:301, engine/market-data/src/gap_fill.rs | server: boolean | yes, type tenant name (Screen.cs:110-115) | no | BROKER_ADMIN or EMERGENCY_CONTROLS (risk/route.ts:64) | toast "ALL NEW TRADING HALTED" / "trading resumed", refetch | WORKS |
| ENABLE CLOSE-ONLY (danger) / RESUME NORMAL TRADING (primary) | 2) CLOSE-ONLY (:133,163-165) | always | always | PatchRiskAsync -> PATCH /api/manage/risk {closeOnly} | Broker.closeOnlyAt = now / null + AuditLog RISK_CLOSE_ONLY_TOGGLED (risk/route.ts:89-95,206-210); READ BY lib/risk.ts:24-26 checkCloseOnly, lib/mirror.ts:301 | server: boolean | yes, typed tenant name | no | BROKER_ADMIN or EMERGENCY_CONTROLS | toast "CLOSE-ONLY MODE ON" / "normal trading resumed" | WORKS |
| "RISK ›" link | 2) CLOSE-ONLY "manual dealing" row (:139) | risk loaded | always | Shell.Navigate("RISK") | none | - | no | no | none | RISK screen | WORKS |
| Group ACTIONS cell double-click (HALT / RESUME) | 3) GROUPS (:95,166-171) | row | always | SetGroupHaltAsync ManageG2.cs:132 -> PATCH /api/manage/groups/{id}/halt {halted} | Group.tradingHaltedAt = now / null + AuditLog GROUP_HALT_TOGGLED (groups/[id]/halt/route.ts:41-60); publishAccountsUpdatedAfterResponse (:62); READ BY lib/risk.ts:34-36 checkGroupTradingHalted, lib/mirror.ts:293 | server: boolean, group of this broker | yes, typed tenant name | no | BROKER_ADMIN or EMERGENCY_CONTROLS (halt/route.ts:18) | toast "{group} · HALTED/resumed" | DUPLICATE (GroupsScreen.cs:154; DealingScreen.cs:1397) |
| Ctx "Halt group…" / "Resume group…" | 3) GROUPS row menu (:96) | row | always | same | same | same | same | no | same | same | DUPLICATE (cell double-click :95) |
| Symbol ACTIONS cell double-click (HALT / RE-ENABLE) | 4) SYMBOLS (:97,172-177) | row | always | SaveBrokerSymbolAsync ManageG2.cs:142 -> PATCH /api/manage/symbols (whole config row, enabled flipped, confirmBelowFloor=false) | BrokerSymbol.enabled + every other config field rewritten from the loaded row + AuditLog SYMBOL_CONFIG_UPDATED (symbols/route.ts:121-190) | server re-validates every field; refuses hedgedMarginPct below floor without confirmBelowFloor (symbols/route.ts:166-167); refuses enabling a non-USD-quote symbol (:219) | yes, typed tenant name | no | MANAGER or BROKER_ADMIN, no EMERGENCY_CONTROLS check (symbols/route.ts:34-40,124) | toast "{symbol} · DISABLED/re-enabled" | PARTIAL (a symbol whose hedged margin % is below the floor cannot be disabled here: the row is sent without confirmBelowFloor and the server answers 400; also DUPLICATE of the SYM screen's Enabled flag) |
| Ctx "Halt symbol…" / "Re-enable symbol…" | 4) SYMBOLS row menu (:98) | row | always | same | same | same | same | no | same | same | DUPLICATE (cell double-click :97) |
| Symbol search "symbol" | 4) SYMBOLS filter bar (:87,99,152) | always | always | none | none | - | no | no | none | table filtered | WORKS |
| ACTIONS cell text HALT / RESUME / RE-ENABLE on single click | 3) and 4) ACTIONS columns (:146,155) | row | - | none (single click only selects the row) | none | - | - | - | - | nothing | UI-ONLY |
| "KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE — not available yet" | 1) HALT (:129) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| Column header click / right-click | both tables (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

Not on this screen although the server supports it: per-group close-only (PATCH groups/{id}/halt {closeOnly}, groups/[id]/halt/route.ts:29-47; client SetGroupCloseOnlyAsync ManageG2.cs:136 is used only by DealingScreen.cs:1398). The groups table shows no close-only state.

## D. Dialogs
All four actions use the typed-tenant confirm (danger): detail text + "Type the tenant name \"{host}\" to confirm.", input "TENANT NAME ({host})", required, must equal Session.Host case-insensitively (Screen.cs:110-115). Titles/buttons: HALT ALL NEW TRADING/HALT, RESUME ALL TRADING/RESUME, ENABLE CLOSE-ONLY MODE/CLOSE-ONLY, RESUME NORMAL TRADING/RESUME, HALT GROUP/HALT, RESUME GROUP/RESUME, DISABLE SYMBOL/DISABLE, RE-ENABLE SYMBOL/RE-ENABLE. The typed value is not stored.

## E. Text
- Symbols: panel "DISABLE ONE SYMBOL", action cell "HALT", menu "Halt symbol…", confirm "DISABLE SYMBOL", status "DISABLED" — halt and disable used for the same flag (:94,98,103,155,175).
- TYPE column shows legacy values LP / DEALING / DEMO / COVERAGE; B_BOOK and REVERSAL groups both read "DEALING" (lib/group-routing.ts:103-108).
- "type the tenant name to confirm" hint next to each button (:127,134); the value asked for is the server host (Screen.cs:112), not the broker name.
- Nav title "Trading halt" vs panel titles "HALT ALL NEW TRADING" / "CLOSE-ONLY MODE"; class doc calls it EmergencyPage.
- Halt note "including hedge legs of closes" (:123): UNVERIFIED (no hedge-leg check found in lib/risk.ts:11-13).

## F. UI structure map
Layout: PageGrid columns * / *, rows 190 / *.
Top-left "1) HALT  HALT ALL NEW TRADING" (header right: status text): note sentence; row "status" (TRADING NORMALLY green / HALTED · NO NEW TRADING red / —); button HALT ALL NEW TRADING (danger) or RESUME ALL TRADING (primary/orange) + hint "type the tenant name to confirm"; block "KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE" / "not available yet".
Top-right "2) CLOSE-ONLY  CLOSE-ONLY MODE": note; row "status" (OPENS ALLOWED / CLOSE-ONLY · OPENS BLOCKED); button ENABLE CLOSE-ONLY (danger) or RESUME NORMAL TRADING (primary) + hint; row "manual dealing" ("ON · orders wait for a dealer" amber / "OFF · auto-fill") + link "RISK ›".
Bottom-left "3) GROUPS  HALT ONE GROUP" (header right "{n} OF {m} HALTED"). Table columns: GROUP | TYPE | LEVERAGE | STATUS | ACTIONS. Sortable; default name asc. Single selection; no checkbox. Click: select; double-click on ACTIONS cell: halt/resume; double-click elsewhere: nothing; Enter: nothing. Per-row: GROUP suffix " · default"; STATUS chip TRADING (green) / HALTED (red); ACTIONS "HALT" (red) / "RESUME" (green).
Right-click on group row: YES — no header line; single item "Halt group…" or "Resume group…".
Bottom-right "4) SYMBOLS  DISABLE ONE SYMBOL" (header right "{n} OF {m} DISABLED"); filter bar with search "symbol" only. Table columns: SYMBOL | CATEGORY | TRADING MODE | STATUS | ACTIONS. Sortable; default disabled-first then name. Per-row: TRADING MODE chip (BOTH grey, BUY ONLY / SELL ONLY amber); STATUS ENABLED (green) / DISABLED (red); ACTIONS "HALT" (red) / "RE-ENABLE" (green). Double-click on ACTIONS cell toggles.
Right-click on symbol row: YES — no header line; single item "Halt symbol…" or "Re-enable symbol…".
Right-click on multi-selection: NO. Empty area: NO. Column header: YES (both) — "COLUMNS", checkbox per column, "Reset columns".
Empty: "no groups", "no symbols", "no symbols match". Loading: page veil. Error: header status (risk) / toasts (groups, symbols).

## Issues
[functional] EMG · TYPE column shows the legacy derived groupType (LP/DEALING/DEMO/COVERAGE), not the routing Group.category; B_BOOK and REVERSAL groups both display DEALING · SecurityEmergencyScreens.cs:145; app/api/manage/groups/route.ts:78,84; lib/group-routing.ts:103-108; ApiClient.ManageG2.cs:15-16
[functional] EMG · disabling a symbol re-sends its whole config without confirmBelowFloor; a symbol with hedged margin % below the floor is refused (400), so it cannot be halted from the emergency screen · SecurityEmergencyScreens.cs:176; ApiClient.ManageG2.cs:142-144; app/api/manage/symbols/route.ts:166-167
[functional] EMG · per-symbol disable needs no EMERGENCY_CONTROLS (any MANAGER can do it) while per-group and broker halts require it · app/api/manage/symbols/route.ts:34-40; app/api/manage/groups/[id]/halt/route.ts:18; risk/route.ts:64
[functional] EMG · a MANAGER without RISK_SETTINGS/EMERGENCY_CONTROLS gets a 403 on risk and the screen then renders no groups or symbols at all (early return) · SecurityEmergencyScreens.cs:112; risk/route.ts:15
[functional] EMG · per-group close-only exists on the server and on DEAL but not here; the groups table does not show a group's close-only state · app/api/manage/groups/[id]/halt/route.ts:29-47; DealingScreen.cs:1398; SecurityEmergencyScreens.cs:93
[ux] EMG · HALT / RESUME / RE-ENABLE cells look clickable but act only on double-click; context menus have no title line · SecurityEmergencyScreens.cs:95-98
[text] EMG · halt vs disable wording for the same symbol flag; "tenant name" prompt actually requires the server host · SecurityEmergencyScreens.cs:103,155,175; Screen.cs:112

## Status counts
STATUS-COUNTS app=backoffice screen=EMG WORKS=6 PARTIAL=1 UI-ONLY=1 PLACEHOLDER=1 DEAD=0 DUPLICATE=3


<!-- ===== bo-MRG.md ===== -->

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


<!-- ===== bo-LP.md ===== -->

# bo-LP · Liquidity (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:48-117 (LiquidityScreen, LP) + RoutingRules helper :23-46. Nav: LIQUIDITY › "Liquidity" (ShellViewModel.cs:69).

## A. Purpose + panels
Configured liquidity-provider RECORDS (no FIX session / connection exists on the server) and open volume per symbol split A-book / B-book.
Panels: 1) LP "LIQUIDITY PROVIDERS" (fills) and 2) BOOK "BOOK EXPOSURE · OPEN LOTS" (right, 460 px) (:66-69). The class summary lists a third panel "3) the intended routing rules" and says the screen is "Read-only by decision … POST/PATCH liquidity-providers and POST/DELETE lp-routing, unwired" (:48-51) — neither is true now.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) LP | GET /api/manage/liquidity-providers | FetchLiquidityProvidersAsync ApiClient.ManageG5.cs:71 | app/api/manage/liquidity-providers/route.ts:18-44 (createdAt desc; routingRuleCount) | live topic position; poll 30 s (:55-56); after writes | none | none | "no liquidity providers configured"; failure → EmptyText "providers: <error>" (:78) |
| 2) BOOK | GET /api/manage/liquidity | FetchBookExposureAsync ApiClient.ManageG5.cs:70 | app/api/manage/liquidity/route.ts (OPEN positions grouped by symbol + Position.bookType, symbol asc) | same | none | none | "no open positions · nothing on either book"; failure → Status and the WHOLE screen is not rendered (:76) |
| (discarded) | GET /api/manage/lp-routing | FetchLpRoutingAsync ApiClient.ManageG5.cs:72 | lp-routing/route.ts:15-42 | fetched every refresh (:73), passed to Render but not displayed; field `_rules` is declared and never constructed (:57) | — | — | — |
Role: all three routes BROKER_ADMIN only (liquidity/route.ts:7, liquidity-providers/route.ts:7, lp-routing/route.ts:7). The nav shows the screen to every role (no role gate in ShellViewModel.cs:68-71); a MANAGER gets 403 on BOOK and sees only the error.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ROUTING | LP header | always | always | navigation to ROUTE (:66) | — | — | no | — | — | ROUTE | WORKS |
| + LP (primary/orange) | LP header | always | always | POST /api/manage/liquidity-providers — CreateLiquidityProviderAsync ApiClient.ManageG6.cs:127-128 → liquidity-providers/route.ts:46-79 | LiquidityProvider create (status PROSPECTIVE); AuditLog LP_CREATED (:67-76) | client Name required / server name | form | no | BROKER_ADMIN | toast "<name> · added" | WORKS |
| Right-click empty area → "Add new LP…" | LP table | always | always | as + LP | as above | as above | form | no | BROKER_ADMIN | as above | DUPLICATE (+ LP) |
| LP row double-click | LP table | row | always | navigation to ROUTE (:62) | — | — | no | — | — | ROUTE (unfiltered) | DUPLICATE (ROUTING button) |
| Right-click → "Status: PROSPECTIVE / NEGOTIATING / CONTRACTED / CONNECTED" (4 items) | LP row menu | always | item ≠ current status | PATCH /api/manage/liquidity-providers/{id} {status} — PatchLiquidityProviderAsync ApiClient.ManageG6.cs:130-131 → liquidity-providers/[id]/route.ts:7-55 | LiquidityProvider.status; AuditLog LP_STATUS_CHANGED (:38-49). READ BY: nothing operational (no execution path reads LP records or routing, see bo-ROUTE) | server enum (:5, :23-27) | no | no | BROKER_ADMIN | toast "<name> · <status>" | WORKS |
| Right-click → "Notes…" | LP row menu | always | always | PATCH …/{id} {notes} | LiquidityProvider.notes; NO audit (audit only when status changes, :38) | — | form | no | BROKER_ADMIN | toast "<name> · notes saved" | WORKS |
| BOOK row double-click | BOOK table | row | always | Shell.Open("EXP", symbol) (:64) | — | — | no | — | — | EXP opens but is NOT filtered: LiveExposureScreen.FocusRecord matches only position id / account number / account id (LiveExposureScreen.cs:109-113) | PARTIAL (symbol focus ignored) |
| Right-click → "Live exposure · this symbol" | BOOK row menu | always | always | as double-click | — | — | no | — | — | as above | DUPLICATE (BOOK row double-click) |
| Right-click → "Symbol settings" | BOOK row menu | always | always | Shell.Open("SYM", symbol) → SymbolsScreen.FocusRecord (SymbolsScreen.cs:71) | — | — | no | — | — | SYM, row selected | WORKS |

## D. Dialogs
NEW LIQUIDITY PROVIDER (:81-91):
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Name | text, required | "" | LiquidityProvider.name | display (LP, ROUTE) |
| Protocol | text, hint "FIX 4.4 · REST · …" | "" | LiquidityProvider.protocol | display only |
| Contact / Contact e-mail / Contact phone | text | "" | contactName / contactEmail / contactPhone | display only (phone not shown anywhere in this app) |
| Notes | note | "" | notes | display only (ROUTE detail shows RULE notes, not LP notes) |
LP NOTES (:98): Notes (note, prefilled) → LiquidityProvider.notes; read nowhere else.
All LP fields: READ BY nowhere in lib/ or engine/ (grep liquidityProvider in lib, engine/order-management/src, services/api-gateway/src: no hits).

## E. Text
- Status "ACTIVE" is tested everywhere (:33, :109, :112, RoutingRules :33-36) but the enum is PROSPECTIVE / NEGOTIATING / CONTRACTED / CONNECTED (prisma/schema.prisma:2275-2280): header always "<n> LPS · 0 ACTIVE", status chip never green.
- Class summary (:48-51) describes a routing panel and "read-only … unwired" writes that are wired.
- Column "ROUTING RULES" counts rules that nothing executes; panel does not repeat the "planned · not executed yet" note ROUTE shows.

## F. UI structure map
Layout: columns * / 460 (:69). No KPI strip, no chips.
Panel 1 header: "1) LP" · "LIQUIDITY PROVIDERS"; header-right: stat "<n> LPS · <n> ACTIVE", Status, button "ROUTING", button "+ LP" (primary/orange).
Table LP (layout "lps"): PROVIDER · PROTOCOL · STATUS · ROUTING RULES · CONTACT · SINCE (:60). STATUS chip (always neutral "b"). Sortable headers, no default sort (server createdAt desc). Single select. Row click: select; double-click: ROUTE; Enter: nothing. Right-click on row: YES —
  "<LP name>" (disabled) / separator / "Status: PROSPECTIVE" / "Status: NEGOTIATING" / "Status: CONTRACTED" / "Status: CONNECTED" (the current one disabled) / separator / "Notes…" (:92-100).
Right-click empty area: YES — "LIQUIDITY PROVIDERS" (disabled) / separator / "Add new LP…" (:67). Header: column picker. Empty: "no liquidity providers configured" or "providers: <error>".
Panel 2 header: "2) BOOK" · "BOOK EXPOSURE · OPEN LOTS"; header-right: stats "A <money>" (accent) and "B <money>" (blue) — lot totals formatted with Ui.Money (:115).
Table BOOK (layout "book-exposure"): SYMBOL · A-BOOK LOTS · B-BOOK LOTS · TOTAL · A-BOOK % (:61). Sortable, single select. Row click: select; double-click: EXP; Right-click on row: YES — "<SYMBOL>" (disabled) / separator / "Live exposure · this symbol" / "Symbol settings" (:65). Right-click empty area: NO. Header: column picker. Empty: "no open positions · nothing on either book".

## Issues
- [functional] LP · UI checks LP status == "ACTIVE", a value the LpStatus enum does not have; ACTIVE count is always 0 and routing rules always render OFF · LiquidityScreens.cs:33, :109, :112; prisma/schema.prisma:2275-2280
- [functional] LP · BOOK "Live exposure · this symbol" / double-click open EXP unfiltered (FocusRecord ignores symbol names) · LiquidityScreens.cs:64-65; LiveExposureScreen.cs:109-113
- [functional] LP · screen is visible to MANAGER but every route is BROKER_ADMIN-only; a MANAGER sees only a 403 in the status line · ShellViewModel.cs:69; app/api/manage/liquidity/route.ts:7
- [ux] LP · GET lp-routing is fetched on every 30 s poll and discarded; `_rules` never constructed · LiquidityScreens.cs:57, :73, :77
- [ux] LP · LP notes changes write no audit log · liquidity-providers/[id]/route.ts:38-49
- [text] LP · header B/A book totals are lots rendered with the money formatter · LiquidityScreens.cs:115
- [text] LP · class summary describes a routing panel and "unwired" writes that are wired · LiquidityScreens.cs:48-51

## Status counts
STATUS-COUNTS app=backoffice screen=LP WORKS=5 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=3


<!-- ===== bo-ROUTE.md ===== -->

# bo-ROUTE · Liquidity routing (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:119-188 (LiquidityRoutingScreen, ROUTE) + RoutingRules :23-46. Nav: LIQUIDITY › "Liquidity routing" (ShellViewModel.cs:70).

## A. Purpose + panels
LP routing rules (LP × symbol × priority). Stored only: no execution path reads LpRoutingRule (grep lpRoutingRule / LpRoutingRule in lib/, engine/order-management/src, services/api-gateway/src: no hits); fills route by Group.category (app/api/trade/orders/route.ts:383, :593). The screen states this ("planned · not executed yet", :25).
Panels: 1) ROUTE "ROUTING RULES" (fills) and 2) RULE "SELECTED RULE" (right, 380 px) (:153-157).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) ROUTE | GET /api/manage/lp-routing | FetchLpRoutingAsync ApiClient.ManageG5.cs:72 | app/api/manage/lp-routing/route.ts:15-42 (priority asc, createdAt desc) | on open / nav (>10 s); after writes; no poll / topic | client priority asc then createdAt ASC (:30) | none | "no routing rules · none saved on the server yet" (:27); error → Status |
| NEW RULE pickers | GET liquidity-providers, GET symbols | FetchLiquidityProvidersAsync ManageG5.cs:71; FetchBrokerSymbolsAsync ManageG2.cs:140 | liquidity-providers/route.ts:18; symbols/route.ts:42 | on "+ RULE" | — | — | toast "add a liquidity provider first" when none (:128) |
Role: BROKER_ADMIN only (lp-routing/route.ts:7, lp-routing/[id]/route.ts:7); nav visible to all roles.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + RULE (primary/orange) | ROUTE header | always | always | POST /api/manage/lp-routing — CreateRoutingRuleAsync ApiClient.ManageG6.cs:132-133 → lp-routing/route.ts:44-81 | LpRoutingRule create; NO audit log; READ BY nothing | client priority positive int (:138) / server LP + symbol exist, priority positive (:54-72) | form | no | BROKER_ADMIN | toast "routing rule added" | WORKS |
| Right-click empty area → "Add new routing rule…" | ROUTE table | always | always | as + RULE | as above | as above | form | no | BROKER_ADMIN | as above | DUPLICATE (+ RULE) |
| Row click | ROUTE table | row | always | none (detail render :151) | — | — | no | — | — | detail panel | WORKS |
| Right-click → "Delete rule…" | row menu | always | always | DELETE /api/manage/lp-routing/{id} — DeleteRoutingRuleAsync ApiClient.ManageG6.cs:134 → lp-routing/[id]/route.ts:5-19 | LpRoutingRule delete; NO audit log | — | yes (danger) | no | BROKER_ADMIN | toast "rule deleted" | WORKS |
| "OPEN LP" | RULE detail | a rule selected | always | navigation to LP (:186) | — | — | no | — | — | LP screen | WORKS |
| "CONDITIONS · EDIT / DELETE — not available yet" | RULE detail | a rule selected | — | none (:185) | — | — | — | — | — | — | PLACEHOLDER (delete exists in the row menu) |

## D. Dialogs
NEW ROUTING RULE (:125-139):
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Liquidity provider | choice (LP names) | first LP | LpRoutingRule.liquidityProviderId | nowhere (display) |
| Symbol | choice "ANY SYMBOL" + every symbol (incl. disabled) | ANY | LpRoutingRule.symbolId (null = any) | nowhere |
| Priority | number, required, positive | rules count + 1 | LpRoutingRule.priority | nowhere (display order) |
| Notes | note | "" | LpRoutingRule.notes | detail panel |
DELETE ROUTING RULE (Confirm): "Delete rule #<priority> <LP> · <symbol>?".

## E. Text
- Column "PRIORITY" shows the row rank (i + 1), not the stored priority (RoutingRules :34); the delete confirm uses the stored priority "#<n>" (:144) → two different numbers for the same rule.
- "ENABLED" column = LP record status == "ACTIVE" (:33-36); that status does not exist in LpStatus (prisma/schema.prisma:2275-2280) → always "OFF".
- Detail "route A-BOOK (LP)" (:181) and "LP record status" amber (never "ACTIVE").
- "CONDITIONS · EDIT / DELETE" "not available yet" (:185) while delete is available.
- Summary "read-only (server POST/DELETE unwired)" (:119-120) — both are wired.
- Filter-bar label "planned · not executed yet" (:25) — accurate.

## F. UI structure map
Layout: columns * / 380 (:157). No KPI strip.
Panel 1 header: "1) ROUTE" · "ROUTING RULES"; header-right: stat "<n> RULES · <n> LPS" (amber when > 0), button "+ RULE" (primary/orange). No Status element in this header. Filter bar: label "planned · not executed yet" (no chips).
Table (layout "route-rules"): PRIORITY · RULE · SYMBOL · LIQUIDITY PROVIDER · ENABLED (:27). RULE "<LP> · <SYMBOL>" or "<LP> · default"; SYMBOL name or "ANY"; LIQUIDITY PROVIDER "<LP> · <status>"; ENABLED chip ON/OFF. Sortable headers, no default sort (client priority order). Single select. Row click: detail; double-click: nothing; Enter: nothing. Right-click on row: YES —
  "<LP> · <SYMBOL|ANY>" (disabled) / separator / "Delete rule…" (:140-147).
Right-click empty area: YES — "ROUTING RULES" (disabled) / separator / "Add new routing rule…" (:155). Header: column picker. Empty: "no routing rules · none saved on the server yet".
Panel 2 header: "2) RULE" · "SELECTED RULE". Body: rows priority / liquidity provider / LP record status / symbol / route "A-BOOK (LP)" / created; section NOTES; "CONDITIONS · EDIT / DELETE — not available yet"; button "OPEN LP". Empty: "SELECT A RULE".

## Issues
- [functional] ROUTE · routing rules are stored but no execution path reads them; routing is decided by Group.category · lib/, engine/ (no lpRoutingRule reader); app/api/trade/orders/route.ts:383
- [functional] ROUTE · ENABLED is always OFF: tests LP status "ACTIVE", which LpStatus does not contain · LiquidityScreens.cs:33-36; prisma/schema.prisma:2275-2280
- [ux] ROUTE · routing rule create/delete write no audit log · lp-routing/route.ts:44-81, lp-routing/[id]/route.ts:5-19
- [ux] ROUTE · PRIORITY column shows rank, delete confirm shows stored priority · LiquidityScreens.cs:34, :144
- [text] ROUTE · "CONDITIONS · EDIT / DELETE not available yet" while delete exists; summary says writes unwired · LiquidityScreens.cs:185, :119-120

## Status counts
STATUS-COUNTS app=backoffice screen=ROUTE WORKS=4 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=1


<!-- ===== bo-FEED.md ===== -->

# bo-FEED · Feed health (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:190-291 (FeedHealthScreen, FEED). Nav: LIQUIDITY › "Feed health" (ShellViewModel.cs:71).

## A. Purpose + panels
Reachability and counters of the trading core (Rust engine), API gateway and price-alert engine, plus per-symbol tick freshness.
Layout: KPI strip (8 tiles, 54 px); row 2 (250 px): 1) CORE "TRADING CORE · FEED STATS", 2) GW "API GATEWAY", 3) ALERTS "PRICE-ALERT ENGINE"; row 3: 4) SYM "PER-SYMBOL FEED" full width (:205-210).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Sort | Empty / error |
|---|---|---|---|---|---|---|
| all | GET /api/manage/feed-health → {feedStats, gatewayStats, alertStats} | FetchFeedHealthAsync ApiClient.ManageG5.cs:74-78; FeedHealth.FromJson :33-44 (a missing/non-object section = null = "down") | app/api/manage/feed-health/route.ts:97-110 | poll 5 s while active (:197); ticks ≤1/s overwrite BID / ASK / LAST TICK per symbol from the live price stream (:227-243) | per-symbol: live first, then symbol asc (:284) | tiles "—" / "not loaded" before first load (:213); error → Status |
Route fan-out (feed-health/route.ts:103-107), each via fetchStats (:75-90: header x-internal-secret = INTERNAL_SERVICE_SECRET, 2 s abort, non-2xx or any exception → null):
- feedStats ← `${TRADING_CORE_URL}/internal/feed-stats` (default http://127.0.0.1:8081, :71)
- gatewayStats ← `${GATEWAY_URL}/internal/gateway-stats` (default http://127.0.0.1:8080, :72)
- alertStats ← `${TRADING_CORE_URL}/internal/alert-stats`
Role: MANAGER, BROKER_ADMIN (:99).

### Where "PRICE ALERTS" status comes from and why it can show NOT REACHABLE
- Tile value = FeedHealth.AlertsUp = (alertStats section is a JSON object) (ApiClient.ManageG5.cs:35); tile text "CONNECTED" / "NOT REACHABLE", note "snapshot ok" / "no snapshot" (LiquidityScreens.cs:247-248).
- There is no separate alert service: alert-stats is a route on the same engine process as feed-stats — engine/server/src/main.rs:1602 → alert_stats :1075-1077, behind the same require_internal_secret layer (:1595-1603, :177-190).
- NOT REACHABLE therefore means the web route got null for `${TRADING_CORE_URL}/internal/alert-stats`: (a) TRADING_CORE_URL unset in the Vercel env → 127.0.0.1:8081 (unreachable from Vercel); (b) INTERNAL_SERVICE_SECRET in the web env ≠ the engine's → 401 (main.rs:186-188); (c) the reverse proxy in front of the loopback-bound engine (Caddy, referenced in deploy/market-data-vps-runbook.md:136-138; its config is not in the repo) does not forward /internal/alert-stats; (d) a running engine binary older than the alert-stats route → 404; (e) > 2 s response. Which one applies is UNVERIFIED (env values, Caddy config and the VPS binary are not readable from the repo; no endpoint calls allowed).
- If CORE is CONNECTED but ALERTS is not, (a) and (b) are excluded (same URL, same secret); the panel then says "alert-stats not answering" (LiquidityScreens.cs:283). If CORE is also down, the panel says "core not reachable".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Per-symbol row double-click | SYM table | row | always | Shell.Open("SYM", symbol) (:203) | — | — | no | — | — | Symbols screen, row selected | WORKS |
| Right-click → "Symbol settings" | SYM row menu | always | always | as double-click (:204) | — | — | no | — | — | as above | DUPLICATE (row double-click) |
| Right-click → "Live exposure · this symbol" | SYM row menu | always | always | Shell.Open("EXP", symbol) (:204) | — | — | no | — | — | EXP opens unfiltered (LiveExposureScreen.cs:109-113 ignores symbol names) | PARTIAL (symbol focus ignored) |

## D. Dialogs
None.

## E. Text
- Table empty text "no per-symbol feed stats · trading core not reachable" (:202) is shown also when the core answers with an empty per_symbol list.
- SOURCE column is the constant "ENGINE" for every row (:285).
- Tiles "EA → ENGINE p50 / p95", "ROUND TRIP", "ORDER ACK p50 / p95" (:198); CORE rows use snake_case-derived labels ("dropped invalid / missing t0", "mono → UTC offset", :257, :262).
- t0_invalid (route type :22) is not displayed.
- Summary (:190-193) "a missing snapshot = \"not reachable\", which the Qt page notes usually means not deployed yet" — the causes above are broader.

## F. UI structure map
KPI tiles in order: TRADING CORE · GATEWAY · PRICE ALERTS · SYMBOLS TICKING · STALE · > 60 S · EA → ENGINE p50 / p95 · ROUND TRIP · ORDER ACK p50 / p95 (:198, :205).
Panel 1 header: "1) CORE" · "TRADING CORE · FEED STATS"; header-right: Status. Body rows: EA → engine last / p50 / p95; p99 / max; samples; ticks in; queue length; dropped invalid / missing t0; NATS out / publish failures; candle write failures; DB ok / fail (lag); round-trip time; mono → UTC offset — or "NO SNAPSHOT · trading core not reachable".
Panel 2 header: "2) GW" · "API GATEWAY". Rows: WS connections / disconnections; ticks forwarded; NATS messages received; order-ack p50 / p95; order-ack samples — or "NO SNAPSHOT · gateway not reachable".
Panel 3 header: "3) ALERTS" · "PRICE-ALERT ENGINE". Rows: active alerts; triggered (total); persist failures; hot-reload add / cancel / malformed — or "NO SNAPSHOT · alert-stats not answering" / "… core not reachable".
Panel 4 header: "4) SYM" · "PER-SYMBOL FEED"; header-right: stat "<n> LIVE · <n> STALE" or "CORE NOT REACHABLE".
Table (layout "feed-symbols"): SYMBOL · TICKS · 60 S · LAST TICK · BID · ASK · SOURCE · FEED (:202). LAST TICK tone green/amber (>5 s)/red (>60 s); FEED chip LIVE / STALE. Sortable headers, default = client order (live first). Single select. Row click: select; double-click: SYM; Enter: nothing. Right-click on row: YES — "<SYMBOL>" (disabled) / separator / "Symbol settings" / "Live exposure · this symbol" (:204). Right-click empty area: NO. Header: column picker. No toolbar buttons, no chips.

## Issues
- [functional] FEED · PRICE ALERTS "NOT REACHABLE" = web route got null from TRADING_CORE_URL/internal/alert-stats (same engine + secret as feed-stats); env / proxy / binary cause UNVERIFIED · app/api/manage/feed-health/route.ts:71-90, :106; engine/server/src/main.rs:1595-1603, :1075
- [functional] FEED · "Live exposure · this symbol" opens EXP without filtering to the symbol · LiquidityScreens.cs:204; LiveExposureScreen.cs:109-113
- [ux] FEED · every failure mode (timeout, 401, 404, network) collapses to the same "NOT REACHABLE"; the route discards the status code · feed-health/route.ts:85-89
- [text] FEED · empty-table text blames the core even when the core answered with no symbols · LiquidityScreens.cs:202

## Status counts
STATUS-COUNTS app=backoffice screen=FEED WORKS=1 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-CLI.md ===== -->

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


<!-- ===== bo-CRM.md ===== -->

# bo-CRM · Leads (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\WalletsLeadsScreens.cs:78-146 (LeadsScreen, CRM). Nav: CLIENTS › "Leads" (ShellViewModel.cs:74).

## A. Purpose + panels
Sales leads: list with status filters and search, create, status changes, conversion to an account.
One panel: 1) CRM "LEADS · SALES" (:95).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) CRM | GET /api/manage/leads | FetchLeadsAsync ApiClient.ManageG3.cs:58 | app/api/manage/leads/route.ts:14-43 (createdAt desc; convertedAccountNumber) | on open / nav (>10 s); after writes; no poll / topic | chips OPEN (NEW+CONTACTED+QUALIFIED, default) / NEW / CONTACTED / QUALIFIED / CONVERTED / LOST / ALL; search "name · e-mail · phone" (:101-106) | none | "no leads"; error → Status |
Role: MANAGER, BROKER_ADMIN (leads/route.ts:6-12, leads/[id]/route.ts:6-12).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Status chips (7) | filter bar | always | always | none (client) | — | — | no | — | — | filtered | WORKS |
| Search box | filter bar | always | always | none (client) | — | — | no | — | — | filtered | WORKS |
| + LEAD (primary/orange) | header | always | always | POST /api/manage/leads — CreateLeadAsync ApiClient.ManageG6.cs:123-124 → leads/route.ts:45-75 | Lead create (email lower-cased); Notification NEW_LEAD (:64-72); NO AuditLog | client name + email with '@' (:131, :136) / server same (:52-54) | form | no | MANAGER, BROKER_ADMIN | toast "<name> · lead created" | WORKS |
| Right-click empty area → "Add new lead…" | table | always | always | as + LEAD | as above | as above | form | no | as above | as above | DUPLICATE (+ LEAD) |
| Row double-click | table | row | converted lead only (else nothing, :93) | Shell.Open("CLI", convertedAccountNumber) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Mark NEW" / "Mark CONTACTED" / "Mark QUALIFIED" / "Mark LOST" (4 items) | row menu | always | status ≠ item and lead not CONVERTED | PATCH /api/manage/leads/{id} {status} — SetLeadStatusAsync ApiClient.ManageG3.cs:60-61 → leads/[id]/route.ts:20-61 | Lead.status; NO AuditLog; no notification | server enum (:14, :33-40) | yes "LEAD STATUS" (danger for LOST) | no | MANAGER, BROKER_ADMIN | toast "<name> · <status>" | WORKS |
| Right-click → "Mark CONVERTED → account…" | row menu | always | not CONVERTED | GET /api/manage/accounts (whole list, client lookup by number, :140-142) then PATCH leads/{id} {status:"CONVERTED", convertedAccountId} | Lead.status + convertedAccountId (account must be in broker :41-47); NO AuditLog | client account number required and found / server convertedAccountId required for CONVERTED | yes (ConfirmWithInput "CONVERT", input "ACCOUNT NUMBER") | no | MANAGER, BROKER_ADMIN | toast "<name> · converted → <acc>" | WORKS |
Server features with no control: editing Lead.notes (leads/[id]/route.ts:48-50); un-converting (server allows any status on a CONVERTED lead; UI disables).

## D. Dialogs
NEW LEAD (:127-137):
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Full name | text, required | "" | Lead.fullName | display, notification body |
| E-mail | text, required ('@') | "" | Lead.email (lower-cased) | display |
| Phone | text | "" | Lead.phone | display |
| Country | text, hint "ISO code" (upper-cased client-side :134, not validated) | "" | Lead.country | display |
| Source | text, hint "web · referral · campaign" | "" | Lead.source | display, notification body |
| Notes | note | "" | Lead.notes | NOTES column |
CONVERT LEAD (ConfirmWithInput :138-145): "ACCOUNT NUMBER" (required) → resolved to Account.id → Lead.convertedAccountId. READ BY: this screen (CONVERTED TO), leads GET.
LEAD STATUS (Confirm :122-126): "<name>: <old> → <new>?", button = the new status.

## E. Text
- Row menu ends with a separator followed by nothing (:119).
- Summary (:78-80) "status changes (NEW → CONTACTED → QUALIFIED → LOST)" — any order is allowed; "Assign-to-staff has no endpoint" accurate.
- Chip "OPEN · <n>" shows a count; the other chips do not (:101).
- Country hint "ISO code" with no validation.

## F. UI structure map
Layout: one panel. Header: "1) CRM" · "LEADS · SALES"; header-right: stat "<shown> SHOWN OF <total> · <n> CONVERTED", Status, button "+ LEAD" (primary/orange). Filter bar: chips OPEN · <n> (default) · NEW · CONTACTED · QUALIFIED · CONVERTED · LOST · ALL, then search box. No KPI.
Table (layout "leads"): NAME · E-MAIL · PHONE · COUNTRY · SOURCE · STATUS · CONVERTED TO · NOTES · CREATED (:89-91). STATUS chip (CONVERTED green, LOST red, NEW amber, others info); CREATED as age. Sortable headers, no default sort (server createdAt desc). Single select. Row click: select; double-click: CLI when converted; Enter: nothing. Right-click on row: YES —
  "<name> · <status>" (disabled) / separator / "Mark NEW" / "Mark CONTACTED" / "Mark QUALIFIED" / "Mark LOST" (each disabled when current or lead CONVERTED) / "Mark CONVERTED → account…" (disabled when CONVERTED) / separator (trailing, nothing after) (:113-121).
Right-click empty area: YES — "LEADS · SALES" (disabled) / separator / "Add new lead…" (:96). Header: column picker. Empty: "no leads".

## Issues
- [ux] CRM · lead create and status/convert changes write no AuditLog · app/api/manage/leads/route.ts:45-75; leads/[id]/route.ts:20-61
- [ux] CRM · lead notes can only be set at creation; server PATCH supports notes, no control · leads/[id]/route.ts:48-50
- [ux] CRM · convert downloads the full accounts list to resolve one number client-side · WalletsLeadsScreens.cs:140-142
- [text] CRM · row menu ends with an empty trailing separator · WalletsLeadsScreens.cs:119

## Status counts
STATUS-COUNTS app=backoffice screen=CRM WORKS=6 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1


<!-- ===== bo-IB.md ===== -->

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
