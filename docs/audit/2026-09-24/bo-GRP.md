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
