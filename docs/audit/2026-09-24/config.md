# Configuration truth table (2026-09-24 audit, read-only)

Scope: every configurable field on backoffice CFG, GRP, SYM, ATY, RISK (+ DEAL dealer settings), EMG, PSP, MIR, and the trader terminal settings.
Paths: backoffice = `E:\vyxtrader\src\Vyx.Backoffice.App`, terminal = `E:\vyxtrader\src\Vyx.Trader.App`, shared = `E:\vyxtrader\src\Vyx.Shared*`, web = `D:\VyXTrader-Tauri\vyX`.

Which path counts as live. Live money path = the Next.js web API (`app/api/trade/**`, `lib/**`). The Rust engine readers (`engine/**`) are cited but are in shadow/cutover only (docs/RUST-CUTOVER-PLAN.md:1-5, Stage 5 = shadow), so they do not make a field "effective".

Pricing flag. `Broker.pricingEngineEnabled` (schema.prisma:424, default false) picks which pricing resolver runs at fill time (`lib/pricing-engine.ts:314-321`). When false, fills read only GroupSymbolConfig.spreadMarkup/commissionPerLot over BrokerSymbol (`lib/group-pricing.ts:80-96`), and swaps read only the GroupSymbolConfig swaps over BrokerSymbol, with swap-free ignored (`lib/swap-rollover.ts:250-255`). Only Super Admin sets the flag (`app/api/admin/brokers/[id]/route.ts:131`). Its value for futurixglobal is UNVERIFIED because this agent may not query the DB. In the table, "FLAG" means the field is read only when the flag is true.

Legend for the "Effective today?" column:
- YES
- NEW-ONLY: copied at creation, later edits don't reach existing records.
- FLAG
- PARTIAL: named in the cell.
- NO: saved, never read.
- DISPLAY: read only for display.
- DB-ONLY: read at runtime, but no UI writes it.

## 1. CFG · Settings (Screens/SettingsScreen.cs)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Default leverage | SettingsScreen.cs:43,47 (Save :95-112) | Broker.defaultAccountLeverage | 100 (schema.prisma:429) | app/api/manage/accounts/route.ts:269, portal/accounts/route.ts:119, manage/live-account-requests/[id]/route.ts:103. Each is `group?.leverage ?? broker.default…` | PARTIAL: used only when the new account has no group and the broker has no default group. Otherwise Group.leverage wins. NEW-ONLY. |
| Default account currency | SettingsScreen.cs:44,48 | Broker.defaultAccountCurrency | "USD" (schema.prisma:428) | manage/accounts/route.ts:170, live-account-requests/[id]/route.ts:102, portal/accounts/route.ts:118 | PARTIAL: the UI accepts any 3-letter code (SettingsScreen.cs:101). The server rejects anything other than USD (app/api/manage/settings/route.ts:52-60). |
| Margin call / Stop-out | SettingsScreen.cs:49-50 (link to GRP) | per group (see GRP) | — | — | link only |
| Negative balance protection | SettingsScreen.cs:51, shown as "not available yet" | Broker.negativeBalanceProtection | true (schema.prisma:411) | lib/position-close.ts:135-136; engine book.rs:336 (shadow) | DB-ONLY. It is on and enforced, but the UI says "not available yet". |
| Hedging allowed | SettingsScreen.cs:52 "not available yet" | none | — | — | no field exists |
| Max slippage | SettingsScreen.cs:53 "not available yet" | Broker.defaultMaxSlippagePips (edited on DEAL, see §5) | null | see §5 | The CFG text contradicts DEAL, which does edit this field. |
| Min deposit | SettingsScreen.cs:55 (link to PSP) | PaymentMethod.minAmount | — | see §7 | link only |
| Withdrawal auto-approve, KYC L1/L2 | SettingsScreen.cs:56-58 "not available yet" | none | — | — | no field exists |
| Broker, domain, tier, status, accent, theme, desktop build | SettingsScreen.cs:60-65 | Broker.name/subdomain/customDomain/tier/status/primaryColor; shell-info theme | — | — | read-only display |
| Staff 2FA mandatory | SettingsScreen.cs:67 "not available yet"; SecurityEmergencyScreens.cs:64 | Broker.requireAdmin2fa | false (schema.prisma:331) | app/manage/(shell)/layout.tsx:46 only, via lib/auth.ts:327-333. Not checked by app/api/manage/login/route.ts:77. | DB-ONLY. No route writes it. The web manager shell enforces it; the native backoffice login does not. |
| Session timeout, audit retention | SettingsScreen.cs:68-69 | none | — | — | no field exists |

## 2. GRP · Group form and new-group dialog (Screens/GroupsScreen.cs:169-204)

The new-group dialog and the edit dialog are the same form (`GroupForm(null)` at :42 and :47; `GroupForm(g)` at :142). POST is groups/route.ts:92-220. PATCH is groups/[id]/route.ts:22-190. PATCH resends every field and has no "absent = keep" handling (groups/[id]/route.ts:74-80).

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Name | GroupsScreen.cs:179 | Group.name | — | display | YES |
| Leverage | :179 (UI default "100") | Group.leverage | 100 (schema.prisma:961) | copied into Account.leverage at account creation or group move (manage/accounts/route.ts:269, accounts/[id]/route.ts:163-168). Margin reads Account.leverage (lib/margin.ts:74,299). | NEW-ONLY. Editing a group's leverage leaves existing accounts unchanged; groups/[id]/route.ts:119 writes only the Group row. |
| Margin call % | :180 ("100") | Group.marginCallLevel | 100 (schema.prisma:962) | lib/margin.ts:37,62,213 (pre-trade + monitor); lib/risk-monitor.ts:229; engine book.rs:232 (shadow) | YES |
| Stop out % | :180 ("50") | Group.stopOutLevel | 50 (schema.prisma:963) | lib/margin.ts:63; lib/risk-monitor.ts:229 | YES |
| Book / routing | :181 (B_BOOK, A_BOOK, DEALING; REVERSAL/COVERAGE only when already set, :162-167) | Group.category, plus shadow Group.groupType = legacyGroupTypeFor (groups/route.ts:153) | B_BOOK (schema.prisma:1022) | Book type: resolveBookType(category) (orders/route.ts:383,593; lib/group-pricing.ts:19-24). Dealer queue: reads **groupType**, not category (orders/route.ts:295; lib/dealing-routing.ts:41-44). | PARTIAL: B_BOOK, DEALING and REVERSAL all map to groupType DEALING (lib/group-routing.ts:103-107) and all book B. On the order path, choosing B-BOOK and choosing DEALING DESK behave identically: with the desk ON, an INHERIT group of either kind queues. |
| Account mode | :182 | Group.modeRestriction | ANY | lib/account-structure.ts:74-78,107-108; groups/[id]/route.ts:99-110 | YES (account creation and moves) |
| Advanced dealing options | :183 | not stored (only shows or hides Dealer and Force) | — | — | UI-only toggle |
| Dealer | :184-187 | Group.dealingMode | INHERIT | lib/dealing-routing.ts:41-42; orders/route.ts:292 | YES |
| Trading (sides) | :188 | Group.tradingRestriction | BOTH | lib/risk.ts checkGroupTradingRestriction; orders/route.ts:191, fill/route.ts:104, requote-response/route.ts:162 | YES |
| Max lot | :189 | Group.maxLotSize | null | orders/route.ts:190 (checkGroupMaxLot), fill/route.ts:103, requote-response/route.ts:161 | YES (per order, not cumulative; lib/risk.ts:60) |
| Swap-free | :189 | Group.swapFree (the UI always sends true/false, never null, :198) | null (schema.prisma:995) | lib/pricing-engine.ts:168,253 (FLAG path only). Flag-off swap job: `isSwapFree = false; // nothing reads any swapFree field` (lib/swap-rollover.ts:255) | FLAG. With the flag off, the toggle has no effect. |
| Force dealer mode | :190 | Group.forceDealingMode | false | lib/dealing-routing.ts:44; orders/route.ts:294 | YES |
| Default group for new accounts | :190 | Group.isDefault | false | manage/accounts/route.ts:258; portal/accounts/route.ts:100; live-account-requests/[id]/route.ts:84 | YES (NEW-ONLY) |
| (not in UI) Client-selectable | — | Group.isClientSelectable | **false** (schema.prisma:1040) | manage/accounts/route.ts:252 refuses non-selectable groups; accounts/[id]/route.ts:82; portal/groups/route.ts | Not editable anywhere in the backoffice. POST groups (route.ts:163) never sets it, so every group created in the backoffice rejects client accounts (`GROUP_NOT_CLIENT_SELECTABLE`). |
| (not in UI) Tier | — | Group.tier | STANDARD | no reader outside the groups routes (grep lib, app/api, engine) | NO. Every PATCH from the backoffice also resets it to STANDARD, because the UI never sends `tier` (groups/[id]/route.ts:80,119). |
| Allowed symbols: restrict | GroupsScreen.cs:216 | Group.restrictSymbols | false | lib/risk.ts:84-88; orders/route.ts:196, fill/route.ts:109, requote-response/route.ts:167 | YES |
| Allowed symbols: list | :217 | GroupSymbol rows | none | same as above | YES (when restrict is on) |
| Halt / Resume (row menu) | :149-156 | Group.tradingHaltedAt | null | lib/risk.ts:34; orders/route.ts:192 | YES |
| Pricing per symbol: spread mode + points | Controls/PricingPanel.cs:193-194 (MARKUP or TARGET, in points, stored as pips via PricingMath) | GroupSymbolConfig.spreadMarkup / targetTotalSpreadPips | null | spreadMarkup: lib/group-pricing.ts:82-94 (always). targetTotalSpreadPips: only in lib/pricing-engine.ts:123-124 and trade/prices/route.ts:117-143 (FLAG). The flag-off select omits it (group-pricing.ts:82). | MARKUP: YES. TARGET: FLAG. With the flag off, a TARGET row fills at BrokerSymbol markup while the panel's CLIENT SPREAD column shows the target (PricingPanel.cs:111,132). |
| Pricing: commission / lot | PricingPanel.cs:195 | GroupSymbolConfig.commissionPerLot | null | lib/group-pricing.ts:95 | YES |
| Pricing: swap long / short | PricingPanel.cs:196-197 | GroupSymbolConfig.swapLong/swapShort | null | lib/swap-rollover.ts:250-254 (flag-off path) | YES |
| Precedence line | PricingPanel.cs:60-62 | — | — | — | Text states account › type › group › broker. That order exists only on the FLAG path (pricing-engine.ts:135-142). |

## 3. SYM · Symbols (Screens/SymbolsScreen.cs)

All row edits PATCH `/api/manage/symbols` with the full row (ApiClient.ManageG2.cs:142-144 → symbols/route.ts:121-260).

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| MARKUP | SymbolsScreen.cs:41 col, :156 edit | BrokerSymbol.spreadMarkup (pips) | 0 | lib/group-pricing.ts:84-94; orders/route.ts:375,549 → applySpreadMarkup (BUY side only, group-pricing.ts:45-54) | YES. The column shows raw **pips** with no unit, while GRP and ATY show **points** (PricingPanel.cs:21). |
| COMMISSION / LOT | :41, :156 | BrokerSymbol.commissionPerLot | 0 | group-pricing.ts:95 fallback | YES |
| SWAP LONG / SHORT | :42, :156 | BrokerSymbol.swapLong/swapShort | 0 | lib/swap-rollover.ts:218-219 | YES |
| MINIMUM LOT / MAXIMUM LOT | :42, :157 | BrokerSymbol.minLot/maxLot | 0.01 / 100 | orders/route.ts:148; positions/[id]/close/route.ts:149-154; lib/mirror.ts:335 | YES |
| STEP | :42, :157 | BrokerSymbol.lotStep | 0.01 | orders/route.ts:189 (checkLotStep); fill/route.ts:100 | YES |
| MAXIMUM EXPOSURE | :43, :157 | BrokerSymbol.maxExposure | null | lib/risk.ts:311-327 (per **account**, sum of open lots in the symbol); orders/route.ts:202 | YES. The panel "1) LIM · EXPOSURE LIMITS · NET LOTS PER SYMBOL" (:57, :110-119) compares the **broker-wide net** against this per-account gross limit, so its OK/NEAR/OVER status does not match what the server enforces. |
| HEDGED MARGIN % | :43, :143-153 (below-50 confirm) | BrokerSymbol.hedgedMarginPct | 200 (schema.prisma:1678) | lib/margin.ts:46,76,242,268 (monitor + pre-trade); engine margin_watch.rs:95 (shadow) | YES |
| TRADING MODE | :43, :127 (cycles) | BrokerSymbol.tradingMode | BOTH | lib/risk.ts:52-54; orders/route.ts:187; lib/mirror.ts:328 | YES |
| ENABLED | :43, :126 | BrokerSymbol.enabled | true | orders/route.ts:132 (`enabled: true` lookup); lib/mirror.ts:296 | YES. Enabling a non-USD-quoted symbol is refused (symbols/route.ts:219-226). |
| SESSIONS | :128, :193-209 (PUT symbols/{id}/sessions) | TradingSession rows | none = 24/7 | lib/risk.ts checkTradingSession via orders/route.ts:188; lib/risk-monitor.ts:93; lib/close-by.ts:89; lib/bulk-close.ts:81 | YES. The parser rejects windows that cross midnight (:219, close must be after open). |
| (not in UI) Stop level | — | BrokerSymbol.stopLevel | 0 | orders/route.ts:227; orders/[id]/route.ts:110; positions/[id]/route.ts:72 | DB-ONLY (no manage route writes it) |
| (not in UI) Default book type | — | BrokerSymbol.defaultBookType | B_BOOK | none on the order path (symbols/route.ts:149-155 says routing = group) | NO (legacy column) |

## 4. ATY · Account types (Screens/AccountTypesScreen.cs)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Name | AccountTypesScreen.cs:82 | AccountType.name | — | display, portal/account-types/route.ts:17 | YES |
| Description | :82 | AccountType.description | null | portal/account-types/route.ts:17 | YES (client picker) |
| Pricing hint | :83 (hint says "shown to clients") | AccountType.pricingHint | null | admin web pages only (AccountsManager.tsx, SettingsManager.tsx). portal/account-types/route.ts:17 does not select it. | NO for clients. The UI hint is wrong. |
| Sort order | :83 | AccountType.sortOrder | 0 | portal/account-types/route.ts:18 | YES |
| Default for new accounts | :84 | AccountType.isDefault | false | manage/accounts/route.ts:166; portal/accounts/route.ts:96 | YES (NEW-ONLY) |
| Enable / Disable (row menu) | :74-75 | AccountType.enabled | true | manage/accounts/route.ts:161; portal/account-types/route.ts:15 | YES |
| (not in form) Flat spreadMarkup / commissionPerLot / swapLong / swapShort / swapFree | shown in list columns :32,56, not editable | AccountType.* | null (schema.prisma:828-836) | lib/pricing-engine.ts:138-168 (FLAG) | FLAG. POST from the backoffice writes explicit **0 / 0 / 0 / 0 / false**, not null (account-types/route.ts:61-79). With the flag on, that type-level 0 markup outranks every GroupSymbolConfig spread (pricing-engine.ts:135-142), and swapFree=false outranks Group.swapFree (:168). |
| Per-symbol pricing (spread mode/points, commission, swaps) | PricingPanel.cs:193-197 (Level.AccountType) | AccountTypeSymbolConfig.* | null | lib/pricing-engine.ts:136-165 (FLAG); swap-rollover.ts FLAG branch | FLAG |
| MARKUP · PTS column | :56 | — | — | converts with hard-coded digits=2 (`PipsToPoints(t.SpreadMarkup, 2)`) | display |

## 5. RISK (Screens/RiskScreen.cs) and DEAL dealer settings (Screens/DealingScreen.cs)

All writes go through PATCH /api/manage/risk (app/api/manage/risk/route.ts). Dealer desk and auto-hedge go through PATCH /api/manage/dealing-desk-toggle.

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Manual dealing (broker) | RiskScreen.cs:80-82 | Broker.dealingModeAt | null | lib/dealing-routing.ts:44; orders/route.ts:293; fill/route.ts:138 | YES |
| Smart dealer accept % / reject % | RiskScreen.cs:83-91 | Broker.smartDealerAcceptPct / smartDealerRejectPct | null | orders/route.ts:359-364,457 | PARTIAL: evaluated only for MARKET orders that route to the queue (inside `if (type === "MARKET" && wantsQueue)`, orders/route.ts:300,355-359), and only once at submission. |
| Total exposure limit | RiskScreen.cs:93,95-100 (prompt "EXPOSURE USD", shown as money + " USD") | Broker.totalExposureLimit | null | lib/risk.ts:332-348: sum of open **lots** broker-wide; orders/route.ts:203 | PARTIAL: the UI unit is USD, the server unit is lots. "5000000" typed as USD means 5,000,000 lots. |
| Max open positions / account | RiskScreen.cs:94-100 | Broker.maxOpenPositionsPerAccount | null | orders/route.ts:201; fill/route.ts:114; engine db.rs:483 (shadow) | YES |
| Trading halted / close-only | RiskScreen.cs:103-104 (display), set on EMG | see §6 | | | |
| Dealer ON / auto-fill (desk) | DealingScreen.cs:514 | Broker.dealingDeskAutoFillAt | null (= dealer ON) | lib/dealing-routing.ts:43; orders/route.ts:296 | YES |
| Auto-hedge | DealingScreen.cs:576-591 | Broker.autoHedgeAt | null | lib/coverage.ts:441-444 (only while desk auto-fill) | YES (conditional as labelled) |
| MAX SLIPPAGE (MODE panel) | DealingScreen.cs:545-570 | Broker.defaultMaxSlippagePips | null | orders/route.ts:563-565 and positions/[id]/close/route.ts:220-224, only when the request body carries no maxSlippagePips | PARTIAL: the terminal always sends it on opens (MarketDataService.cs:1680, "unlimited" by default), and WebTrader always sends "unlimited" on opens and closes (lib/trade-api.ts:230,263). That leaves native-terminal closes as the only reader (ApiClient.cs:264-268 sends none). The UI shows "5 pips · platform default" when blank (:542,549,560); the server treats blank as **unlimited** (lib/risk.ts:442-464). |
| Requote step (DEALER SETTINGS gear) | DealingScreen.cs:445-461 | local backoffice settings.json RequoteStepPoints | 10 (BackofficeSettings.cs:31) | DealingScreen RenderQueue presets | YES (local). Saving this form also PATCHes `defaultMaxSlippagePips = null`: the form has no "slip" field, so `slip` is always "" (:455,458). That **clears the broker slippage setting**. |
| Coverage account (SET) | DealingScreen.cs:594-600 | local settings.json CoverageAccountNumber | "" | DealingScreen.cs:912-931 display fallback only. BOOK NOW / auto-hedge use Broker.coverageAccountId (lib/coverage.ts, schema.prisma:511-512). | UI-only. Read from a different source than the UI edits; overwritten by the server value (:926-931). |
| Group halt / close-only (desk emergency) | DealingScreen.cs:1397-1398 | Group.tradingHaltedAt / Group.closeOnlyAt | null | lib/risk.ts:34,44; orders/route.ts:192-193 | YES |

## 6. EMG · Emergency (Screens/SecurityEmergencyScreens.cs:85-178)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Halt all new trading | :126,:160-162 | Broker.tradingHaltedAt | null | lib/risk.ts:11-12; orders/route.ts:185; lib/mirror.ts:301 | YES |
| Close-only mode | :133,:163-165 | Broker.closeOnlyAt | null | lib/risk.ts:24-25; orders/route.ts:186 | YES |
| Halt one group | :95-96,:166-171 | Group.tradingHaltedAt | null | orders/route.ts:192 | YES. There is no per-group close-only control here; that one is only on DEAL. |
| Disable one symbol | :97-98,:172-177 | BrokerSymbol.enabled (full-row PATCH) | true | orders/route.ts:132 | YES. Re-enabling a non-USD symbol fails server-side (symbols/route.ts:219). |
| Groups table TYPE column | :93,:145 | shows legacy Group.groupType | — | — | display of the shadow column; B_BOOK groups show "DEALING" |

## 7. PSP · Payment methods (Screens/PaymentMethodsScreen.cs)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| ENABLED | PaymentMethodsScreen.cs:33,73 | PaymentMethod.enabled | true | trade/payment-methods/route.ts:18; trade/funds-requests/route.ts:86 | YES |
| MINIMUM | :28,:33 | PaymentMethod.minAmount | 0 | trade/funds-requests/route.ts:89 | YES |
| MAXIMUM | :28,:33 | PaymentMethod.maxAmount | null | trade/funds-requests/route.ts:92 | YES |
| FEE % / FEE FIXED | :28,:33 | PaymentMethod.feePercent / feeFixed | 0 / 0 | lib/psp/adapter.ts:108-122 estimatePspFee (no callers in app/lib; WebTrader.tsx shows an estimate) | DISPLAY. The fee is never deducted from Transaction.amount (adapter.ts:108-114). |
| WALLET ADDRESS | :28 | PaymentMethod.walletAddress | null | trade/payment-methods/route.ts:31 (shown to trader) | YES |
| INSTRUCTIONS | :28 | PaymentMethod.instructions | null | trade/payment-methods/route.ts:30 | YES |
| (not in UI) pspProvider / pspApiKey | — | PaymentMethod.pspProvider/pspApiKey | null | nothing (schema.prisma:1497,1517-1518) | NO (no UI either) |

## 8. MIR · Mirror rules (Screens/ApprovalsMirrorScreens.cs:110-190)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| Source type + source | :172-173 (create only) | MirrorRule.sourceType / sourceId | — | lib/mirror.ts:217-218 | YES |
| Target account | :174 (create only) | MirrorRule.targetAccountId | — | lib/mirror.ts | YES |
| Direction | :174 (create only) | MirrorRule.direction | REVERSE | lib/mirror.ts:313 | YES. It cannot be edited after create; PATCH has no field for it (mirror-rules/[id]/route.ts:151-183). |
| Multiplier | :159 edit, :175 create | MirrorRule.multiplier | 1 | lib/mirror.ts:335 | YES |
| Fill price | :159, :175 | MirrorRule.fillPriceMode | SOURCE_PRICE | lib/mirror.ts:354,523 | YES |
| Symbol filter | :159, :175 | MirrorRule.symbolFilter | null | lib/mirror.ts:230 | YES |
| Max open lots / Max daily loss | :176 (create only) | MirrorRule.maxOpenLots / maxDailyLoss | null | lib/mirror.ts:162-202 (kill switch) | YES. Not editable after create; PATCH has no field for them. |
| Enable / Disable | :143-144 | MirrorRule.enabled | true | lib/mirror.ts:231 | YES |

## 9. Trader terminal settings

### 9a. Local file %APPDATA%\VyxTrader\settings.json (Services/TerminalSettings.cs)

| Field | UI location | Stored in | Default | Read by | Effective today? |
|---|---|---|---|---|---|
| ConfirmTicketOrders | Views/SettingsWindow.axaml:29 | settings.json | true (TerminalSettings.cs:18) | MainWindow.axaml.cs:361,611 (17 uses) | YES |
| ConfirmChartOrders | SettingsWindow.axaml:30 | settings.json | true | MainWindow.axaml.cs:277 | YES |
| ConfirmSlTpDrag | SettingsWindow.axaml:31 | settings.json | true | MainWindow.axaml.cs:476,627 | YES |
| ConfirmAlerts | SettingsWindow.axaml:32 | settings.json | true | MainWindow.axaml.cs:283 | YES |
| DefaultSlippagePts (M = unlimited) | SettingsWindow.axaml:34-39; validate SettingsWindow.axaml.cs:52-60 | settings.json | 0 = unlimited (:36) | MarketDataService.cs:1680 (sent as maxSlippagePips = pts/10, or "unlimited"); :2054 | YES (opens only; closes send none, ApiClient.cs:264-268) |
| CrosshairSync | SettingsWindow.axaml:44 | settings.json | true | MarketDataService.cs:221 | YES |
| GridSymbols / GridTimeframes | chart grid, Reset at SettingsWindow.axaml.cs:41-46 | settings.json | null / H1 | MarketDataService.cs:838,1121,1142-1143 | YES |
| LastHost / LastAccount / RememberMe / LastAccountMode / RecentHosts | LoginWindow | settings.json | "" / false | Views/LoginWindow.axaml.cs:45,55,84-85,172-173 | YES |
| Layout* widths/heights | splitters | settings.json | 0 = design default | MainWindow.axaml.cs:653-675 | YES |
| ShowEma | chart EMA chip | settings.json | false | MainWindow.axaml.cs:41,55 | YES |
| ShowOneClickPanel | chart | settings.json | true | MainWindow.axaml.cs:40,56 | YES |
| MwShowSpread / MwShowHighLow | Market Watch | settings.json | true / false | MainWindow.axaml.cs:223,226 | YES |
| MwShowChange | — | settings.json | true | none (0 references outside TerminalSettings.cs) | NO (dead field) |
| StmEnabled | — | settings.json | false | none. Vm.StmEnabled is forced false at launch (MainWindow.axaml.cs:90); the setting itself has no reference. | NO (dead field) |
| BuyHotkey / SellHotkey | ticket STM | settings.json | "" | MainWindow.axaml.cs:115 (12/10 uses) | YES |
| TradeComments | positions comment | settings.json (grows per position id, pruned only on empty text, MarketDataService.cs:2032) | {} | MarketDataService.cs:2027 | YES (local only; the server has no comment field) |
| TradeOrigins | — | settings.json (never pruned, MarketDataService.cs:2018) | {} | MarketDataService.cs:472 | YES |
| PositionColumns | — | settings.json | {} | none (superseded by TableColumns) | NO (dead field) |
| TableColumns | column picker | settings.json | {} | MarketDataService.cs:2007; ViewModels/TableLayout.cs:28 | YES |
| Theme | toggle | settings.json | "light" | App.axaml.cs:20 | YES |
| "Sounds and keyboard remapping" | SettingsWindow.axaml:52 "coming soon" | — | — | — | not built |

### 9b. Server chart-settings document (GET/PUT /api/trade/chart-settings; Vyx.Shared/Charting/ChartVisualSettings.cs)

| Field | UI location | Stored in | Default | Read by (native) | Effective today? |
|---|---|---|---|---|---|
| candle*Color (6) | Vyx.Shared.Ui/Charting/ChartSettingsViewModel.cs:38-43 | chart-settings JSON (per account, lib/chart-settings.ts) | #3CC98A / #F0506E (ChartVisualSettings.cs:12-17) | ChartDrawOperation.cs:139 | YES |
| showGrid / showLastPriceLine / showSessionHighLow / showSessionMap / showOhlcBar | ChartSettingsViewModel.cs:44-48 | chart-settings | true/true/false/false/true | ChartDrawOperation.cs:284,690,712,885; MarketDataService.cs:1994,2067 | YES |
| oneClickDefault | SettingsWindow.axaml:42 | chart-settings | false | MarketDataService.cs:1982-1985,2066 | YES |
| soundsEnabled | none in native | chart-settings | true | no native reader. SoundService.Enabled (Vyx.Shared/Audio/SoundService.cs:26) is never set; the web reads it (components/webtrader/SettingsDialog.tsx). | NO in the native terminal |

### 9c. Backoffice local settings (Services/BackofficeSettings.cs), for completeness

All 22 properties have readers (grep counts 2-11). Exception: CoverageAccountNumber is a display fallback that is overridden by the server (see §5).

## Summary counts
- Saved but never read, unconditionally: **6**
  - Group.tier (reset on every save)
  - AccountType.pricingHint (no client reader, although the UI says "shown to clients")
  - TerminalSettings.MwShowChange
  - TerminalSettings.StmEnabled
  - TerminalSettings.PositionColumns
  - chart-settings soundsEnabled (native terminal)
- Saved but read only when Broker.pricingEngineEnabled = true (FLAG; value UNVERIFIED): **12**
  - Group.swapFree
  - GroupSymbolConfig.targetTotalSpreadPips
  - AccountType.spreadMarkup, commissionPerLot, swapLong, swapShort, swapFree
  - AccountTypeSymbolConfig.spreadMarkup, targetTotalSpreadPips, commissionPerLot, swapLong, swapShort
- Read from a different source than the UI edits:
  - Group.category is edited, but dealer routing reads groupType.
  - The local CoverageAccountNumber is edited, but coverage uses Broker.coverageAccountId.
  - Broker.defaultMaxSlippagePips is displaced by client-sent values.
  - Group.leverage is copied to Account.leverage.
  - SettingsScreen default leverage is displaced by Group.leverage.
- Unit mismatch:
  - totalExposureLimit is USD in the UI, lots on the server.
  - The SYM MARKUP column is pips, while GRP and ATY show points.
  - The SYM LIM panel compares broker net against a per-account gross limit.

## Issues
[functional] GRP · groups created in the backoffice are never client-selectable (isClientSelectable defaults false, no UI or route sets it), so account creation into them is refused · app/api/manage/groups/route.ts:163; prisma/schema.prisma:1040; app/api/manage/accounts/route.ts:252
[functional] GRP · Group.tier is reset to STANDARD on every backoffice group save (UI never sends tier) · app/api/manage/groups/[id]/route.ts:80,119; E:\vyxtrader\src\Vyx.Backoffice.App\Screens\GroupsScreen.cs:193-199
[functional] GRP · routing choice B-BOOK vs DEALING DESK has no effect on the order path: both map to groupType DEALING and dealer routing reads groupType · lib/group-routing.ts:103-107; app/api/trade/orders/route.ts:295; lib/dealing-routing.ts:44
[money] GRP · TARGET spread mode is saved and shown as the client spread, but fills ignore targetTotalSpreadPips unless Broker.pricingEngineEnabled (flag value UNVERIFIED) · lib/group-pricing.ts:80-96; lib/pricing-engine.ts:314-321; E:\vyxtrader\src\Vyx.Backoffice.App\Controls\PricingPanel.cs:111,132
[money] GRP · group Swap-free toggle is not read by the swap job unless pricingEngineEnabled · lib/swap-rollover.ts:255
[money] ATY · new account types are written with explicit 0 markup/commission/swaps and swapFree=false (not null); with pricingEngineEnabled on, the type-level 0 markup outranks every group spread override · app/api/manage/account-types/route.ts:61-79; lib/pricing-engine.ts:135-142,168
[money] ATY · per-type pricing (PricingPanel level AccountType) only applies when pricingEngineEnabled; PricingPanel precedence text states it applies · lib/pricing-engine.ts:314-321; E:\vyxtrader\src\Vyx.Backoffice.App\Controls\PricingPanel.cs:60-62
[functional] GRP · editing group leverage does not change existing accounts' leverage (margin uses Account.leverage) · app/api/manage/groups/[id]/route.ts:119; lib/margin.ts:74
[money] RISK · Total exposure limit is entered and displayed as USD, server enforces it as lots · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:93,95; lib/risk.ts:332-345
[functional] DEAL · saving DEALER SETTINGS (requote step) always PATCHes defaultMaxSlippagePips=null, clearing the broker slippage setting · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs:445-458
[text] DEAL · blank max slippage shown as "5 pips · platform default"; server treats blank as unlimited · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs:542,549,560; lib/risk.ts:442-464
[functional] DEAL · Broker.defaultMaxSlippagePips is displaced on every terminal and WebTrader open (both always send maxSlippagePips); only native-terminal closes read it · E:\vyxtrader\src\Vyx.Trader.App\Services\MarketDataService.cs:1680; lib/trade-api.ts:230,263; app/api/trade/orders/route.ts:563-565
[functional] DEAL · SET coverage account writes only a local file; BOOK NOW/auto-hedge use Broker.coverageAccountId · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs:594-600,912-931
[ux] SYM · LIM panel shows broker-wide NET lots against maxExposure, which the server enforces per account as gross lots · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs:57,110-119; lib/risk.ts:311-327
[ux] SYM · MARKUP column is raw pips with no unit while GRP/ATY pricing is in points · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs:41,99; E:\vyxtrader\src\Vyx.Backoffice.App\Controls\PricingPanel.cs:21
[functional] SYM · stopLevel has no editor anywhere in the backoffice (read by SL/TP validation) · app/api/trade/orders/route.ts:227
[ux] SYM · sessions editor cannot express a window crossing midnight · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs:219
[text] CFG · "Negative balance protection: not available yet" while Broker.negativeBalanceProtection defaults true and is enforced on stop-out closes · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs:51; lib/position-close.ts:135-136
[text] CFG · "Max slippage: not available yet" while DEAL edits Broker.defaultMaxSlippagePips · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs:53; E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs:545-570
[functional] CFG · default currency accepts any 3-letter code client-side; server rejects all but USD · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs:101; app/api/manage/settings/route.ts:52-60
[functional] CFG · Broker.requireAdmin2fa has no writer and is enforced only by the web manager layout, not by the API login the native backoffice uses · app/manage/(shell)/layout.tsx:46; app/api/manage/login/route.ts:77
[text] ATY · "Pricing hint … shown to clients", but no client route returns pricingHint · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\AccountTypesScreen.cs:83; app/api/portal/account-types/route.ts:17
[money] PSP · fee % / fee fixed are saved and displayed but never deducted from any transaction · lib/psp/adapter.ts:108-122
[functional] MIR · direction, max open lots and max daily loss cannot be changed after a rule is created · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:157-160; app/api/manage/mirror-rules/[id]/route.ts:151-183
[ux] EMG · groups table TYPE shows the legacy groupType (B-BOOK groups read "DEALING") · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:145
[functional] TERM · chart-settings soundsEnabled is ignored by the native terminal (SoundService.Enabled never set) · E:\vyxtrader\src\Vyx.Shared\Audio\SoundService.cs:26,45
[ux] TERM · dead settings.json fields MwShowChange, StmEnabled, PositionColumns · E:\vyxtrader\src\Vyx.Trader.App\Services\TerminalSettings.cs:50,53,60
[ux] TERM · TradeOrigins/TradeComments in settings.json grow per position id without pruning · E:\vyxtrader\src\Vyx.Trader.App\Services\MarketDataService.cs:2018,2032
