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
