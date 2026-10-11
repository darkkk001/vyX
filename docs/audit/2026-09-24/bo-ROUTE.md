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
