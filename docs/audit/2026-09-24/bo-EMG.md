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
