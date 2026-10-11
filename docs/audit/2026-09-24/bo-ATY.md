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
