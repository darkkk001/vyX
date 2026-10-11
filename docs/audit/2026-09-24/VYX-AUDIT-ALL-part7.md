# VYX-AUDIT-ALL part 7/9


<!-- ===== cross-cutting.md ===== -->

# Cross-cutting audit (2026-09-24, read-only)

Paths: BO = `E:\vyxtrader\src\Vyx.Backoffice.App`, TERM = `E:\vyxtrader\src\Vyx.Trader.App`, SH = `E:\vyxtrader\src\Vyx.Shared`, SHUI = `E:\vyxtrader\src\Vyx.Shared.Ui`, WEB = `D:\VyXTrader-Tauri\vyX`.

## 1. Real-time behaviour

### 1a. Backoffice mechanism

- **Event stream.** LiveService (BO Services/LiveService.cs:24-40) opens `wss://feed.{root}/v1/events/stream` (SH Api/AdminEventStreamClient.cs:70).
  - An event's family comes from its `type` prefix (AdminEventStreamClient.cs:19-31): order, position, dealing, margin, account. Any other type returns the raw lowercased type.
  - The shell, MainWindow.OnLiveEvent (BO Views/MainWindow.axaml.cs:161-179), handles each event:
    - It calls every screen's OnLiveEvent.
    - For each screen whose LiveTopics contains the family: the active screen refetches after a 400 ms debounce (:152,:175, :57); inactive screens are only marked stale (:176).
    - Badges refresh at most once per 5 s (:178).
- **Poll.** A 1 s tick (MainWindow.axaml.cs:153, PollTick :182-187) refetches the active screen when `LivePollSeconds` has elapsed. It skips while a confirm or form is open or a TextBox has focus.
- **Navigation.** EnsureFreshAsync refetches on nav when the last refresh is more than 10 s old (Screens/Screen.cs:70-76).
- **Prices.** `wss://feed.{root}/v1/prices/stream` (SH Api/PriceStreamClient.cs:77). PricesChanged fires at most 4 times per second (LiveService.cs:40), which calls the active screen's OnLivePrices (MainWindow.axaml.cs:55).
- **Badges.** Separate 60 s timer (MainWindow.axaml.cs:141).
- **What the server actually sends on the admin stream:**
  - The gateway admin stream subscribes only `order.>`, `position.>`, `dealing.>`, `account.>` (WEB services/api-gateway/src/ws.ts:521).
  - The web publishes these types (WEB lib/nats.ts:32-67): OrderAccepted/Rejected/Filled/Cancelled/Requoted/Modified, DealingQueued, PositionClosed, PositionsClosed, PositionModified, DealerActivity, BalanceChanged (`account.balance`), AccountUpdated.
  - Consequences:
    - The `margin` family is never delivered to the backoffice: `margin.>` is not subscribed at ws.ts:521, and the web publishes no margin type.
    - `BalanceChanged` maps to family `balancechanged` (AdminEventStreamClient.cs:23-29), which matches no screen's LiveTopics.

### 1b. Backoffice per screen

| Screen | Event topics (file:line) | Poll | Tick repaint (OnLivePrices) | Net behaviour |
|---|---|---|---|---|
| DASH Dashboard | order, position, dealing, account (DashboardScreen.cs:25) | 30 s (:26) | yes (:110) | live |
| CLI Clients | order, position, account (ClientsScreen.cs:27) | none | yes (:240) | events; deposits/credits (BalanceChanged) do not trigger |
| DEALS | position (DealsScreen.cs:21) | none | no | events |
| FUNDS | account (FundsScreen.cs:24) | 20 s (:25) | no | poll; BalanceChanged never matches "account" |
| KYC | none | 30 s (KycScreen.cs:27) | no | poll |
| LAR Live account requests | none | 30 s (LiveAccountRequestsScreen.cs:19) | no | poll |
| EXP Live exposure | order, position, dealing (LiveExposureScreen.cs:25) | 30 s (:26) | yes (:80) | live |
| DEAL Dealing | order, position, dealing (DealingScreen.cs:36) + OnLiveEvent (:227) | 10 s (:37) | yes (:240); chart per tick via LiveService.Tick; 1 s chart clock (:91) | live |
| SYM Symbols | none | none | no | nav-only (10 s throttle). The LIM panel (net lots) does not follow fills. |
| GRP Groups | none | none | pricing panel RAW/CLIENT spread (GroupsScreen.cs:62, PricingPanel.cs:89-93, ≤1/s) | nav-only |
| RISK | position, margin (RiskScreen.cs:24) | 10 s (:25) | yes (:32-38) | poll + position events; the "margin" topic never fires |
| MRG Margin | position, margin (RiskScreen.cs:122) | 10 s (:123) | yes (:128-134) | same as RISK |
| PSP | none | none | no | nav-only |
| TRF Transfers | none | none | no | nav-only |
| WAL Wallets | position, account (WalletsLeadsScreens.cs:21) | 15 s (:22) | yes (:49) | live |
| IB | none | none | no | nav-only |
| LEADS | none | none | no | nav-only |
| REP Reports | none | none | no | nav-only (manual) |
| NOTIF Notifications | dealing (NotificationsAuditScreens.cs:26) | 20 s (:27) | no | poll |
| AUDIT | order, position, dealing (NotificationsAuditScreens.cs:174) | none | no | events (debounce :177) |
| TEAM | none | none | no | nav-only |
| SEC | none (RefreshAsync re-renders session state, SecurityEmergencyScreens.cs:32-37) | none | no | static |
| CFG Settings | none | none | no | nav-only |
| EMG Emergency | none | none | no | nav-only. A halt set by another admin or tab is not shown until nav (10 s throttle). |
| LIQ Liquidity | position (LiquidityScreens.cs:55) | 30 s (:56) | no | events + poll |
| LPR LP routing | none | none | no | nav-only |
| FEED Feed health | none | 5 s (LiquidityScreens.cs:197) | yes (:227) | poll |
| RADAR Risk radar | none | none | no | nav-only |
| APPR Approvals | account, position (ApprovalsMirrorScreens.cs:21) | 20 s (:22) | no | events + poll |
| MIR Mirror | order, position (ApprovalsMirrorScreens.cs:112) | none | no | events. A kill-switch trip (MirrorRule.killedAt, WEB lib/mirror.ts:162-202) publishes no event on these topics, so the status stays stale until a fill or close arrives. |
| ATY Account types | none | none | pricing RAW/CLIENT (AccountTypesScreen.cs:51) | nav-only |

### 1c. Trader terminal per panel (TERM Services/MarketDataService.cs)

- **Event stream.** `wss://feed.{root}/v1/trading/stream` (SH Api/TradingEventStreamClient.cs:58). The gateway subscribes `order.>`, `margin.>`, `position.>`, `alert.>`, `account.>` (WEB services/api-gateway/src/ws.ts:429).
- **Event handler.** OnTradingEvent (MarketDataService.cs:268-283) always refetches positions, orders and account (:275-276, :281).
- **Poll.** Positions and orders are re-polled every 4 s while `PollingEnabled` (:1083-1085).

| Panel | Source | Evidence |
|---|---|---|
| Market Watch / ticket prices / tape / charts | price stream ticks | SH Api/PriceStreamClient.cs:77; TERM Services/TickStream.cs:24; Views/Tape.axaml.cs:78 (33 ms render timer) |
| Positions | event → refetch, plus 4 s poll | MarketDataService.cs:275, :1083-1084 |
| Pending orders | event → refetch, plus 4 s poll | :276, :1084 |
| History (closed) | on PositionClosed / PositionsClosed / OrderFilled events and after own closes | :277; :534, :557, :701, :748 |
| All orders tab | sign-in and after placing an order only | :1073, :1774 |
| Account strip (balance/equity/margin) | refetch on every event; balance on BalanceChanged/BalanceAdjusted; F7 | :279, :281; MainWindow.axaml.cs:310 |
| Symbol terms (min/max lot, spreads, sessions, allowed symbols) | only on `AccountUpdated` | :280, :564-576 |
| Watchlist | sign-in; after a terms refresh that changes the symbol set | :1060, :574 |
| Server LOG (audit) | sign-in only; local journal entries are live | :1075; :312-318 |
| Calendar | 15 min timer; F6 | :1079-1081; MainWindow.axaml.cs:309 |
| Alerts | AlertTriggered event; sign-in | :278, :1077 |
| Updater | timer once live | MainWindow.axaml.cs:255, :295 |

Symbol configuration (SYM screen and EMG symbol disable) never reaches an open terminal. `AccountUpdated` is published only by the account-type, account, group, group-halt, group-pricing and group-symbols routes (grep of WEB app/api for publishAccountUpdated / publishAccountsUpdatedAfterResponse: 8 files, none of them `app/api/manage/symbols/**` or `app/api/manage/risk`). A symbol's new min lot, markup or disabled state therefore reaches the terminal only after re-sign-in.

## 2. UI-thread blocking

| Where | What | Worst case |
|---|---|---|
| BO App.axaml.cs:57 | `Task.Run(() => StartupGate.CheckAsync("backoffice")).GetAwaiter().GetResult()` on the UI thread before any window exists | HTTP manifest check, 12 s timeout (SH Client/ClientManifest.cs:35) |
| TERM App.axaml.cs:43 | same pattern for "terminal" | 12 s |
| SH Api/AdminEventStreamClient.cs:90, Api/PriceStreamClient.cs:95, Api/TradingEventStreamClient.cs:76 | `Stop()` does `_loop.Wait(TimeSpan.FromSeconds(2))` | BO sign-out calls LiveService.Stop from a menu click, so two waits: up to 4 s (BackofficeSession.cs:86 → LiveService.cs:83). TERM sign-out: MarketDataService.cs:1014 (`Stream.Stop(); Events.Stop();`), same pattern |
| BO Services/BackofficeSettings.cs:84 | sync `File.WriteAllText` of settings.json | called from UI handlers, e.g. every column resize (SymbolsScreen.cs:46), dealer settings (DealingScreen.cs:457,599), panel layouts (Controls/Ui.cs:229) |
| TERM Services/TerminalSettings.cs:94 | sync `File.WriteAllText` | called from UI handlers (MainWindow.axaml.cs:55-56, :226; MarketDataService.cs:2018) |
| SHUI Charting/DrawingsStore.cs:47 | sync `File.WriteAllText` per drawing change | small file |
| SHUI Charting/StudiesStore.cs:59 | sync write | small file |
| TERM Services/SmartRulesEngine.cs:160,169 | sync read/write of rule markers | small file |
| TERM Views/ShareCardWindow.axaml.cs:32 | `File.WriteAllBytes(path, _png)` in Save handler | PNG size |
| SH Charting/ChartAccountScope.cs:65-68 | sync `File.Copy` / `File.Move` on account switch | small file |

No `.Result` or `.Wait()` on an incomplete task was found in screen code: every `.Result` use follows `await Task.WhenAll(...)`, e.g. RiskScreen.cs:56-61, SymbolsScreen.cs:66-69, SecurityEmergencyScreens.cs:109-113. CSV exports are async (ClientsScreen.cs:533, IbReportsScreens.cs:196, NotificationsAuditScreens.cs:268).

## 3. Hard-coded values that should be data

| Value | Where | Note |
|---|---|---|
| Stream hosts `wss://feed.{root}/v1/...` | SH Api/AdminEventStreamClient.cs:70, PriceStreamClient.cs:77, TradingEventStreamClient.cs:58 | host shape fixed in code |
| Update feed root `https://www.vyxtrader.com/native-` | SH Client/ClientIdentity.cs:19 | |
| Bare host gets `.vyxtrader.com` appended | BO Views/LoginWindow.axaml.cs:157 | |
| Manifest URL `https://{host}/api/client/manifest` | SH Client/ClientManifest.cs:36 | |
| Default chart symbol "XAUUSD" | TERM Services/MarketDataService.cs:28; BO Screens/DealingScreen.cs:263 | |
| Platform default slippage "5" pips | BO Screens/DealingScreen.cs:542 | Also wrong: the server default is unlimited (WEB lib/risk.ts:442-464) |
| Pending-trigger slippage 5 pips | WEB lib/risk.ts:451 `PENDING_TRIGGER_MAX_SLIPPAGE_PIPS = "5"` | not broker-configurable |
| Hedged margin floor 50 % | WEB app/api/manage/symbols/route.ts:17; BO SymbolsScreen.cs:145 | duplicated client and server |
| Symbol defaults (0.01 / 100 / 0.01 / 200 …) restated | WEB app/api/manage/symbols/route.ts:19-32 (schema restated) | |
| Margin-call/stop-out fallback 100 / 50 | WEB lib/margin.ts:62-63 | used when an account has no group |
| Requote step default 10 pts | BO Services/BackofficeSettings.cs:31 | local per machine, not per broker |
| "NEAR LIMIT" at 90 % | BO Screens/SymbolsScreen.cs:116 | |
| Margin watch capped at 200 rows | BO Screens/RiskScreen.cs:106 | no "more" indicator |
| Digits hard-coded 2 for ATY markup column | BO Screens/AccountTypesScreen.cs:56 | |
| Digits fallback 5 | BO Controls/PricingPanel.cs:96 | |
| Symbol cache 60 s, live repaint 1 s | BO Controls/PricingPanel.cs:70,91 | |
| Poll cadences 5–30 s per screen | see §1b | |
| Terminal positions poll 4 s, calendar 15 min | TERM MarketDataService.cs:1079,1083 | |
| Ticket default volume "0.01", min 0.01 / max 100 / step 0.01 before symbol load | TERM ViewModels/OrderTicketViewModel.cs:23,34; MainViewModel.cs:15 | |
| Demo helper places a 0.01 BUY with SL/TP on the live API | TERM Services/MarketDataService.cs:1954-1965 (`OpenDemoPositionAsync`) | harness helper compiled into the shipped service |
| StartupGate colours #9AA4B2, #E6E9EE, #57606C | SHUI StartupGate.cs:43-52 | dark-only, not themed |
| Chart candle colours #3CC98A / #F0506E | SH Charting/ChartVisualSettings.cs:12-17 | per-account defaults |
| Fixture sample data (names, tickets, prices) | BO Screens/DealingScreen.cs:1416-1514; TERM MainWindow.axaml.cs:501-529; BO SettingsScreen.cs:81-91 | harness-only paths |

## 4. TODO / FIXME / HACK / "not available" / "coming soon"

A search for TODO, FIXME, HACK and XXX across the native apps and across WEB lib, app/api, engine and the gateway found only one hit, the cosmetic `XXXX-XXXX` comment at WEB lib/totp.ts:191.

User-visible "not available" / "coming soon" / phase-2 occurrences:

| Where | Text |
|---|---|
| BO SettingsScreen.cs:51-53 | Negative balance protection / Hedging allowed / Max slippage: "not available yet". Two of these exist: NBP is on (schema.prisma:411), and max slippage is edited on DEAL. |
| BO SettingsScreen.cs:56-58 | Withdrawal auto-approve, KYC L1 to deposit, KYC L2 above: "not available yet" |
| BO SettingsScreen.cs:67-69 | Staff 2FA mandatory, Session timeout, Audit retention: "not available yet". Broker.requireAdmin2fa exists (schema.prisma:331) but has no writer. |
| BO SecurityEmergencyScreens.cs:59-66,68 | Enrol/reset/backup codes, passkeys, sessions, API keys, IP allowlist, org policy: "not available yet" |
| BO SecurityEmergencyScreens.cs:129 | "KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE · not available yet" |
| BO ClientsScreen.cs:95 | "CRM notes · NOT AVAILABLE YET" |
| BO DealingScreen.cs:463-464 | `// phase-2: MANAGE has no cancel-resting-order endpoint` → toast "cancel resting not available" |
| BO DealingScreen.cs:1215 | chart alert → "price alerts not available" |
| BO DealingScreen.cs:30,1182,1297 | "ORDER TICKET (phase-2 placeholder)", "chart (phase-2 placeholder)", "Order PLACEMENT is still phase-2" |
| BO Services/DealingChart.cs:18 | doc: SELL/BUY "order entry not available". The coverage market order route exists (SH Api/ApiClient.ManageG2.cs:184). |
| BO IbReportsScreens.cs:73,75 | "Sub-IB levels · link · schedule: NOT AVAILABLE", "NOT AVAILABLE YET" |
| BO KycScreen.cs:135-136 | Sanctions / PEP, Duplicate identity: "NOT AVAILABLE YET" |
| BO LiquidityScreens.cs:185,387 | "CONDITIONS · EDIT / DELETE", "FLAG · WHITELIST · NOTE": "not available yet" |
| BO TeamScreen.cs:160,179 | "2FA · devices · IPs", "PASSWORD RESET · ROLE CHANGE": "not available yet" |
| BO ViewModels/ShellViewModel.cs:111 | `ActiveGroupText => "not available yet"` |
| BO DashboardScreen.cs:42 | NET DEP and LAST LOGIN have no endpoint (render "—") |
| TERM MainWindow.axaml.cs:313 | "F10 · reports (coming soon)" |
| TERM Views/SettingsWindow.axaml:52 | "Sounds and keyboard remapping: coming soon." |

Notable web and lib dormant or display-only markers:

| Where | Marker |
|---|---|
| WEB lib/pricing-engine.ts:346 | "dormant code until a broker's flag is on" |
| WEB lib/swap-rollover.ts:255 | "nothing reads any swapFree field on this path" |
| WEB app/api/manage/account-types/route.ts:52-60 | "Storage-only pricing fields" |
| WEB lib/psp/adapter.ts:108-114 | "Display-only fee estimate … NOT deducted" |
| WEB prisma/schema.prisma:1497 | pspProvider/pspApiKey: "nothing reads them yet" |

## 5. Error handling

### 5a. Swallowed errors (empty or comment-only catch)

36 sites in the native code (grep `catch(...) { /*…*/ }`). The ones that lose user data or state silently:

| Where | Effect |
|---|---|
| TERM Services/TerminalSettings.cs:88, :95 | A corrupt file loads defaults; a failed save is silent. Confirm-step and slippage preferences can revert without notice. |
| TERM Services/SmartRulesEngine.cs:162, :175 | A failed save or load of smart-rule markers is silent (armed rules can be lost) |
| BO Services/BackofficeSettings.cs:77, :85 | Same for the backoffice local settings, which include CoverageAccountNumber and RequoteStepPoints |
| SHUI Charting/DrawingsStore.cs:47; StudiesStore.cs:61; SH Charting/ChartAccountScope.cs:71 | Chart drawings and studies are lost silently |
| SH Api/TradingEventStreamClient.cs:119 | `catch (Exception) { /* connect/read failure -> backoff */ }`. No error text is kept, so the terminal shows only the state (MarketDataService.cs:258) |
| SH Api/ApiClient.cs:481; ApiClient.ManageG1.cs:292 | A non-JSON error body is ignored, which leads to "request failed (status)" |
| TERM Services/MarketDataService.cs:157 | JsonException in BodyField ignored |
| SH Api/ApiClient.cs:132; TERM MarketDataService.cs:1013 | A failed logout is ignored. The session is not revoked, yet the UI proceeds. |
| TERM Services/Brand.cs:35,51,76 | A broken brand file falls back silently |
| Others (cosmetic, audio, window placement) | BO MainWindow.axaml.cs:167; SH Audio/SoundService.cs:47,72; SHUI SingleInstance.cs:34,57; SHUI UpdateService.cs:58; SHUI WindowFit.cs:53; TERM Services/WindowsShell.cs:41; SHUI Charting/CandleChartControl.cs:582; BO Services/DealingChart.cs:353; TERM MarketDataService.cs:2121 |

### 5b. Raw exception or server text shown to users

| Where | What |
|---|---|
| BO Screens/Screen.cs:100 | `Status.Text = BackofficeSession.Friendly(ex.Message)`, where ex is any exception from RefreshAsync |
| BO Controls/FormOverlay.cs:245 | `ShowError(ex.Message)` |
| BO Views/MainWindow.axaml.cs:332 | `Toast(ex.Message, false)` for any confirm action exception |
| BO Views/LoginWindow.axaml.cs:167; TERM Views/LoginWindow.axaml.cs:205 | "Could not resume: " + ex.Message |
| SHUI UpdateService.cs:40, :63 | "updater unavailable: {ex.Message}", "update check failed: {ex.Message}" |
| SH Api/ApiClient.cs:508 | "network error: {HttpRequestException.Message}" (raw .NET text, e.g. socket errors) |
| BO Services/BackofficeSession.cs:111-120 | `Friendly()` passes any server error containing a space through verbatim. Long server messages therefore reach toasts unchanged, e.g. WEB app/api/manage/symbols/route.ts:173 (hedged margin), :222 (non-USD), app/api/manage/settings/route.ts:56 ("Contact engineering once currency conversion ships."). |
| BO Screens/SymbolsScreen.cs:193; ApprovalsMirrorScreens.cs:167 | `async void` handlers (EditSessions, NewRule). An exception escaping them goes to the dispatcher, not to a toast. |

## 6. Role and permission checks

**Client side.** The backoffice has no role-based gating. `Session.Role` is used only for display (SettingsScreen.cs:149, SecurityEmergencyScreens.cs:42, Views/MainWindow.axaml.cs:99-108,296); a grep for `Session.Role`, `"MANAGER"`, `"SUPPORT"`, `CanManageFinance` shows no conditional visibility. Every nav item, button and menu item is shown to every role. The server's 403 becomes "not allowed for this role" (BackofficeSession.cs:117). The only client restriction is TeamScreen.cs:99,131: extra permissions are toggled on MANAGER rows only, which is data validity rather than a role gate.

**Server side** (WEB app/api/manage/**, per route guard):

| Backoffice control | Route guard | Evidence |
|---|---|---|
| CFG save (and the CFG panel embedded in TEAM) | BROKER_ADMIN only | app/api/manage/settings/route.ts:8 |
| TEAM admin CRUD / permissions | BROKER_ADMIN | app/api/manage/admins/route.ts, admins/[id]/route.ts |
| GRP create / edit / allowed symbols / group pricing | MANAGER or BROKER_ADMIN, no permission key | groups/route.ts:13; groups/[id]/route.ts:15; groups/[id]/pricing/route.ts:9 |
| GRP delete | BROKER_ADMIN | groups/[id]/route.ts:213 |
| GRP / EMG / DEAL group halt, group close-only | EMERGENCY_CONTROLS (BROKER_ADMIN implicit) | groups/[id]/halt/route.ts:18 |
| SYM all edits, sessions | MANAGER or BROKER_ADMIN, no permission key | symbols/route.ts:36; symbols/[id]/sessions/route.ts |
| EMG "Disable one symbol" | same symbols PATCH, so **not** EMERGENCY_CONTROLS | SecurityEmergencyScreens.cs:176 → symbols/route.ts:36 |
| ATY create / edit / pricing | MANAGER or BROKER_ADMIN, no permission key | account-types/route.ts:8; [id]/route.ts:9; [id]/pricing/route.ts:9 |
| RISK dealing mode, limits, smart dealer, slippage | RISK_SETTINGS | risk/route.ts:15,74 |
| EMG halt all / close-only | EMERGENCY_CONTROLS | risk/route.ts:64 |
| DEAL dealer ON/OFF, auto-hedge | RISK_SETTINGS | dealing-desk-toggle/route.ts:43,59 |
| PSP | BROKER_ADMIN | payment-methods/route.ts:29 |
| MIR | MIRROR_MANAGE | mirror-rules/route.ts, mirror-rules/[id]/route.ts |
| LIQ / LPR | BROKER_ADMIN | liquidity/route.ts, liquidity-providers/**, lp-routing/** |
| FUNDS / KYC / LAR / transfers / IB | FUNDS_APPROVAL / KYC_REVIEW / KYC_REVIEW / INTERNAL_TRANSFERS / IB_PAYOUTS | respective route.ts |
| Balance adjust / approve position actions | ACCOUNT_FINANCE | accounts/[id]/adjust-balance/route.ts; position-action-requests/[id]/approve/route.ts |
| Shell info (role, finance rights, badges) | MANAGER or BROKER_ADMIN; SUPPORT gets 403 | shell-info/route.ts:17 |

Facts from the comparison:
1. Spread, commission, swap and hedged-margin edits (SYM, GRP pricing, ATY pricing) are open to any MANAGER with no delegated permission. Emergency and risk flags, by contrast, require RISK_SETTINGS or EMERGENCY_CONTROLS.
2. EMG's "Disable one symbol" is gated only by MANAGER/BROKER_ADMIN, while "Halt one group" on the same screen needs EMERGENCY_CONTROLS.
3. Broker.requireAdmin2fa is enforced only in the web manager layout (app/manage/(shell)/layout.tsx:46 → lib/auth.ts:327-333). The API login the native backoffice uses checks only the admin's own twoFactorEnabled (app/api/manage/login/route.ts:77).
4. Backoffice sign-out only expires local cookies and never calls a server logout (SH Api/ApiClient.Manage.cs:100-110; BO Services/BackofficeSession.cs:83-89). The terminal does call `/api/trade/logout` (SH Api/ApiClient.cs:128-132).
5. SUPPORT is excluded from nearly every manage route, including shell-info, yet every screen is shown in the backoffice. Whether a SUPPORT admin can sign in to the native backoffice at all is UNVERIFIED (login flow not traced).

## Issues
[functional] BO shell · BalanceChanged admin events map to family "balancechanged" and match no screen topic; deposits/credits never refresh FUNDS/CLI/WAL via events · E:\vyxtrader\src\Vyx.Shared\Api\AdminEventStreamClient.cs:23-29; D:\VyXTrader-Tauri\vyX\lib\nats.ts:64
[functional] RISK/MRG · "margin" LiveTopic never fires: the admin stream does not subscribe margin.> and the web publishes no margin event · D:\VyXTrader-Tauri\vyX\services\api-gateway\src\ws.ts:521; E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:24,122
[functional] TERM · symbol config changes (SYM edits, EMG symbol disable, sessions, hedged margin) never reach an open terminal: symbols routes publish no AccountUpdated, and terms refresh only on AccountUpdated · E:\vyxtrader\src\Vyx.Trader.App\Services\MarketDataService.cs:280,564-576; D:\VyXTrader-Tauri\vyX\app\api\manage\symbols\route.ts
[ux] EMG · halt/close-only state has no event or poll; another admin's halt shows only after nav + 10 s throttle · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:85-117; E:\vyxtrader\src\Vyx.Backoffice.App\Screens\Screen.cs:70-76
[ux] MIR · kill-switch trips publish no event; rule status stays stale until a fill/close event · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:112; D:\VyXTrader-Tauri\vyX\lib\mirror.ts:162-202
[ux] SYM · LIM panel net lots do not update on fills (no topics, no poll) · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs:26-70
[ux] TERM · server LOG (audit) and ALL ORDERS tabs refresh only at sign-in / own placement · E:\vyxtrader\src\Vyx.Trader.App\Services\MarketDataService.cs:1073,1075,1774
[ux] BO/TERM startup · UI thread blocked on the startup-gate HTTP check (up to 12 s) via GetAwaiter().GetResult() · E:\vyxtrader\src\Vyx.Backoffice.App\App.axaml.cs:57; E:\vyxtrader\src\Vyx.Trader.App\App.axaml.cs:43; E:\vyxtrader\src\Vyx.Shared\Client\ClientManifest.cs:35
[ux] BO/TERM sign-out · stream Stop() blocks the UI thread up to 2 s per stream (_loop.Wait) · E:\vyxtrader\src\Vyx.Shared\Api\AdminEventStreamClient.cs:90; E:\vyxtrader\src\Vyx.Shared\Api\PriceStreamClient.cs:95; E:\vyxtrader\src\Vyx.Shared\Api\TradingEventStreamClient.cs:76
[ux] BO/TERM · settings, drawings, studies and smart-rule markers written with sync File IO from UI handlers · E:\vyxtrader\src\Vyx.Backoffice.App\Services\BackofficeSettings.cs:84; E:\vyxtrader\src\Vyx.Trader.App\Services\TerminalSettings.cs:94; E:\vyxtrader\src\Vyx.Shared.Ui\Charting\DrawingsStore.cs:47; E:\vyxtrader\src\Vyx.Trader.App\Services\SmartRulesEngine.cs:160
[functional] TERM · failed saves of settings.json and smart-rule markers are swallowed silently · E:\vyxtrader\src\Vyx.Trader.App\Services\TerminalSettings.cs:95; E:\vyxtrader\src\Vyx.Trader.App\Services\SmartRulesEngine.cs:162,175
[text] BO · raw exception text shown in status/toasts/forms · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\Screen.cs:100; E:\vyxtrader\src\Vyx.Backoffice.App\Controls\FormOverlay.cs:245; E:\vyxtrader\src\Vyx.Backoffice.App\Views\MainWindow.axaml.cs:332; E:\vyxtrader\src\Vyx.Shared\Api\ApiClient.cs:508
[text] BO · Friendly() passes long server messages verbatim (e.g. "Contact engineering once currency conversion ships.") · E:\vyxtrader\src\Vyx.Backoffice.App\Services\BackofficeSession.cs:111-120; D:\VyXTrader-Tauri\vyX\app\api\manage\settings\route.ts:56
[functional] BO · async void handlers (sessions editor, new mirror rule) route exceptions to the dispatcher, not to a toast · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs:193; E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:167
[text] DEAL · hard-coded "platform default 5 pips" contradicts the server (unlimited) · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs:542; D:\VyXTrader-Tauri\vyX\lib\risk.ts:442-464
[ux] TERM · harness helper OpenDemoPositionAsync (0.01 BUY on the live API) compiled into the shipped MarketDataService · E:\vyxtrader\src\Vyx.Trader.App\Services\MarketDataService.cs:1954-1965
[ux] RISK · margin watch silently capped at 200 rows · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:106
[text] CFG · "not available yet" shown for NBP (enabled) and max slippage (editable on DEAL) · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs:51,53
[text] DEAL · DealingChart doc says order entry not available while a coverage order route exists · E:\vyxtrader\src\Vyx.Backoffice.App\Services\DealingChart.cs:18; E:\vyxtrader\src\Vyx.Shared\Api\ApiClient.ManageG2.cs:184
[ux] BO · no client-side role gating: every screen/control shown to every role, server 403 is the only gate · E:\vyxtrader\src\Vyx.Backoffice.App\Views\MainWindow.axaml.cs:99-108
[money] SYM/GRP/ATY · spread, commission, swap and hedged-margin edits need only MANAGER role, no delegated permission · D:\VyXTrader-Tauri\vyX\app\api\manage\symbols\route.ts:36; D:\VyXTrader-Tauri\vyX\app\api\manage\groups\[id]\pricing\route.ts:9; D:\VyXTrader-Tauri\vyX\app\api\manage\account-types\[id]\pricing\route.ts:9
[functional] EMG · "Disable one symbol" is not gated by EMERGENCY_CONTROLS (uses symbols PATCH) while group halt is · E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:176; D:\VyXTrader-Tauri\vyX\app\api\manage\groups\[id]\halt\route.ts:18
[functional] SEC · Broker.requireAdmin2fa not enforced on the API login used by the native backoffice · D:\VyXTrader-Tauri\vyX\app\api\manage\login\route.ts:77; D:\VyXTrader-Tauri\vyX\app\manage\(shell)\layout.tsx:46
[functional] SEC · backoffice sign-out never revokes the server session (cookies expired locally only) · E:\vyxtrader\src\Vyx.Shared\Api\ApiClient.Manage.cs:100-110; E:\vyxtrader\src\Vyx.Backoffice.App\Services\BackofficeSession.cs:83-89
[ux] BO · SUPPORT role is refused by shell-info and nearly all manage routes, but every screen is shown · D:\VyXTrader-Tauri\vyX\app\api\manage\shell-info\route.ts


<!-- ===== questions.md ===== -->

# Audit questions: answers (2026-09-25)

DB evidence comes from the LIVE DB only. Before every run, the host was printed as `ep-morning-glade-b23tui1g-pooler.c-6.eu-central-1.aws.neon.tech`. Every query ran inside `prisma.$transaction` and started with `SET TRANSACTION READ ONLY`. Only SELECT was used. Web code is at D: main HEAD `74b3c02`. Native code is from E:\vyxtrader\src.

---

## 1. Is AccountType symbol pricing read by the pricing engine? Does Standard spreadMarkup=30 affect fills now?

**Answer: YES, the resolver reads it. NO, the 30 does not affect fills now, because the row was deleted at 2026-09-24 11:45:48 UTC. It did affect 13 LIVE fills on 50005708 between 04:23 and 04:32 UTC on 24 Sep.**

Code path:
- Every fill site calls `resolveFillPricing`. Examples: MARKET fill at `app/api/trade/orders/route.ts:543`, Smart-Dealer accept at `:369`, triggered pending order at `app/api/trade/orders/[id]/fill/route.ts:229`, dealer queue at `app/api/manage/dealing-queue/[id]/route.ts:302`, requote at `.../requote-response/route.ts:188`, mirror at `lib/mirror.ts:367`.
- `lib/pricing-engine.ts:314`: when `pricingEngineEnabled` is false, it uses the old group-only resolver `lib/group-pricing.ts:63`. That resolver reads only GroupSymbolConfig and falls back to BrokerSymbol (`:80-94`). It never reads AccountType.
- `lib/pricing-engine.ts:324`: when the flag is true, it calls `resolveSymbolPricingV2`. That function fetches AccountSymbolConfig, AccountTypeSymbolConfig, AccountType, Group and GroupSymbolConfig (`:242-257`). The precedence is set in `resolvePricingV2` (`:134-141`): AccountSymbolConfig > AccountTypeSymbolConfig > AccountType flat > GroupSymbolConfig > BrokerSymbol. `targetTotalSpreadPips` is turned into a markup by `resolveEffectiveSpreadMarkup` (`:199`).
- The fill price is `applySpreadMarkup(...pricing.spreadMarkup...)` at `app/api/trade/orders/route.ts:557`. The quote display uses the same resolver when the flag is on (`app/api/trade/prices/route.ts:117-150`).
- The Rust engine does not read AccountType pricing. Its only markup source is `COALESCE(bs."spreadMarkup",0)` from BrokerSymbol (`engine/order-management/src/db.rs:447`). This does not matter today because every broker has `executionEngine = LEGACY`, so fills go through the web routes above.

DB state now:
```
SELECT name,"pricingEngineEnabled" FROM "Broker"  -> Futurix Global: true (all 4 brokers true)
SELECT * FROM "AccountTypeSymbolConfig"            -> [] (0 rows, every broker)
SELECT * FROM "AccountSymbolConfig"                -> [] (0 rows)
AccountType Futurix Standard (caf6eafd…): spreadMarkup NULL, commissionPerLot NULL
GroupSymbolConfig for Futurix Standard group       -> [] (0 rows)
BrokerSymbol Futurix XAUUSD                        -> spreadMarkup 0, commissionPerLot 0
```
So Standard XAUUSD now resolves to BrokerSymbol markup 0, which is the raw feed spread.

Audit trail (`AuditLog`, entityId = Standard type caf6eafd…, symbolId cmsz4t3k5000gvcz4vgh48uuw = XAUUSD):
| UTC | action | effect |
|---|---|---|
| 24 Sep 03:07:49 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (admin cmt3okaj…) | targetTotalSpreadPips 30 |
| 24 Sep 03:23:10 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (admin cmt3okaj…) | target → null, **spreadMarkup 30 (pips = 300 points)** |
| 24 Sep 05:04:46 | ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED (actor null, script) | spreadMarkup null, targetTotalSpreadPips 3 |
| 24 Sep 11:45:48 | ACCOUNT_TYPE_SYMBOL_PRICING_RESET (actor null, script) | row deleted ("remove the Standard XAUUSD override entirely (raw spread)") |

Fills that the override affected. Query: Standard-type XAUUSD positions bucketed by `openedAt`:
```
before 03:23: 167 | 03:23-05:04 (markup 30 pips): 13 | 05:04-11:45 (target 3 pips): 0 | after reset: 15
```
All 13 fills in the markup window are on **50005708 (LIVE)**, 0.01 lot each. There were 8 BUYs at 04:23:54-04:24:04 (open 4288.33-4288.47) and 5 SELLs at 04:32:02-03 (open 4286.90). All 13 are CLOSED.

---

## 2. Is there an active MirrorRule for Reverse Trading / Reverse Master 50005702? Why does MIR show 0 rules?

**Answer: YES, there is 1 ENABLED rule in the DB. MIR shows 0 because of a client-side parsing bug.**

```
SELECT … FROM "MirrorRule" JOIN "Account" target …
-> id cmti5p021000die04mc1ovjwe, broker Futurix Global, sourceType GROUP,
   sourceId cmti5dibe0001jy04m4zhlbsj (= "Reverse Trading" group, category REVERSAL),
   target 50005702, direction REVERSE, enabled true, killedAt null, failureCount 0, created 2026-09-01 04:17
```
- Accounts in the Reverse Trading group: 50005698, 50005699, 50005700, 50005701, 50005703, 50005706 (all ACTIVE). Any new fill on these accounts is still mirrored. The rule lookup matches on source account id or source group id (`lib/mirror.ts:225-227`). The last MIRROR_FILLED audit row is dated 2026-09-15 20:53.
- The target 50005702 is no longer in a REVERSAL group. An `ACCOUNT_GROUP_CHANGED` audit row dated 2026-09-21 03:36 ("Stage 3a") moved it to Futurix **Standard** (category B_BOOK).
- Why MIR is empty:
  - `GET /api/manage/mirror-rules` returns an object `{ rows, groups, accounts }` (`app/api/manage/mirror-rules/route.ts:93-101`).
  - The backoffice calls `FetchMirrorRulesAsync` → `ListAsync` (`Vyx.Shared/Api/ApiClient.ManageG6.cs:159`).
  - `ListAsync` adds items only when the response root is a JSON **array** (`Vyx.Shared/Api/ApiClient.ManageG1.cs:272-279`). An object root produces an empty list with Ok = true.
  - `MirrorScreen.RefreshAsync` → `Render([])` → "no mirror rules" and "0 ACTIVE OF 0" (`Vyx.Backoffice.App/Screens/ApprovalsMirrorScreens.cs:124-137`).
  - The same file already handles `rows` for other calls (`:229`, `:240`), but the rules list does not.
- Side effect: the MIR screen cannot show, disable or kill this live rule. The toggle at `:140-144` needs a row to act on.
- The GRP screen does show "· MIRROR" on the Reverse Trading row, because `hasMirrorRule` comes from `app/api/manage/groups/route.ts:87`.

---

## 3. Maker-checker: how many distinct admins are required? Can a single-admin broker ever approve?

**Answer: 2 distinct admins are required, but only for 3 flows. A broker with one BROKER_ADMIN can never complete a withdrawal. Futurix is in exactly that position.**

| Flow | When two admins are needed | Self-approval block | Who can be the checker |
|---|---|---|---|
| Withdrawal | Always, for any role. The first APPROVE only marks the request, and a different admin must complete it. | `lib/funds-approval.ts:29-35` | BROKER_ADMIN, or MANAGER with FUNDS_APPROVAL (`app/api/manage/funds-requests/[id]/route.ts:27`, `lib/permissions.ts:15-21`) |
| Deposit | Never. One approval completes it. | `lib/funds-approval.ts:26-28` | same |
| Balance adjustment | Only when a MANAGER makes the request (`lib/balance-adjustment.ts:40-42`). BROKER_ADMIN applies it directly (`app/api/manage/accounts/[id]/adjust-balance/route.ts:63-75`). | `lib/balance-adjustment.ts:129` | BROKER_ADMIN, or MANAGER with ACCOUNT_FINANCE (`app/api/manage/balance-adjustment-requests/[id]/approve/route.ts:17-25`) |
| Position void / reverse / delete | Only when a MANAGER makes the request (`lib/position-actions.ts:22-24`). BROKER_ADMIN runs it directly. | `lib/position-actions.ts:539` | BROKER_ADMIN, or MANAGER with ACCOUNT_FINANCE (`app/api/manage/position-action-requests/[id]/approve/route.ts:20-28`) |

- SUPPORT can never hold FUNDS_APPROVAL, because `hasPermission` returns false for any role that is not MANAGER (`lib/permissions.ts:18`).
- SUPER_ADMIN has no brokerId, so every manage route rejects it (`lib/permissions.ts:27`).
- Futurix admins (live DB): 1 BROKER_ADMIN (ACTIVE, no extra permissions) and 1 SUPPORT (ACTIVE, `extraPermissions` []). So only one admin can act on withdrawals, and the second APPROVE always fails with "a different staff member must confirm this withdrawal". The Futurix withdrawal count in the live DB is 0 today, so nothing is stuck yet.
- Balance adjustments and position actions still work for a single-admin broker, because the BROKER_ADMIN path skips maker-checker entirely.
- AcmeFX has 1 BROKER_ADMIN and 1 MANAGER. Nova Markets has 2 BROKER_ADMIN, which is the only broker able to run withdrawal maker-checker as it stands.

---

## 4. EMG groups table: which field feeds the TYPE column?

**Answer: `groupType`, the legacy pre-Stage-1 shadow column, not `category`.**
- `Vyx.Backoffice.App/Screens/SecurityEmergencyScreens.cs:93` defines the column `("type","TYPE")`. `:145` fills it with `.Set("type", g.GroupType, …)`.
- `GroupType` is parsed from JSON `groupType` (`Vyx.Shared/Api/ApiClient.ManageG2.cs:22`). The record comment at `:15-16` says "GroupType and Tier are the pre-Stage-1 shadow columns … nothing here reads them". EMG and DEAL do read GroupType (`DealingScreen.cs:603`, `:1380`), so the comment is wrong.
- The server derives `groupType` from category on each write through `legacyGroupTypeFor`: COVERAGE→COVERAGE, DEMO_ONLY→DEMO, A_BOOK→LP, everything else→DEALING (`lib/group-routing.ts:104-107`).
- Live effect (Futurix): EMG shows **DEALING** for "Reverse Trading" (category REVERSAL), "Standard" and "Demo" (B_BOOK). It shows **LP** for "Seawolf" (A_BOOK). GRP shows ROUTING from `Category` (`GroupsScreen.cs:68`), so the two screens label the same group differently.

---

## 5. Price-alert engine on FEED: where is it read from, and why "NOT REACHABLE"?

**Answer: FEED reads `alertStats` from `GET /api/manage/feed-health`. The server fills it by calling `${TRADING_CORE_URL}/internal/alert-stats`. "NOT REACHABLE" means that server-side call returned no JSON object.**
- Client:
  - `FetchFeedHealthAsync` → `/api/manage/feed-health` (`Vyx.Shared/Api/ApiClient.ManageG5.cs:74-78`).
  - `AlertsUp => AlertStats is not null` (`:35`). `Sec("alertStats")` is null unless the value is a JSON object (`:38-41`).
  - Tile text is `up ? "CONNECTED" : "NOT REACHABLE"` (`Vyx.Backoffice.App/Screens/LiquidityScreens.cs:247-248`). The panel empty text is "alert-stats not answering" if the core is up and "core not reachable" if not (`:283`).
- Server (Vercel):
  - `fetchStats(`${TRADING_CORE_URL}/internal/alert-stats`)` has a 2 s timeout and sends header `x-internal-secret` (`app/api/manage/feed-health/route.ts:71-90`, `:103-106`).
  - Any non-2xx response, timeout or network error becomes `null`.
  - `TRADING_CORE_URL` defaults to `http://127.0.0.1:8081` (`:71`), which cannot be reached from Vercel.
- Engine:
  - `/internal/alert-stats` is registered in the same secret-guarded sub-router as `/internal/feed-stats` (`engine/server/src/main.rs:1601-1602`). The handler always returns JSON (`:1075-1077`).
  - The route has existed since 3101568 (2026-09-03).
  - So in the current engine code, alert-stats fails only when feed-stats also fails: same URL, same secret, same process.
- If TRADING CORE also shows NOT REACHABLE, the cause is that Vercel cannot reach `TRADING_CORE_URL`. That could be unset, a loopback default, not exposed, or a wrong secret. `docs/RUST-CUTOVER-PLAN.md:1337-1341` already records that "whether Vercel reaches TRADING_CORE_URL" is unverified.
- If TRADING CORE shows CONNECTED but alerts do not, the deployed engine binary does not match D: code.
- Live cause: **UNVERIFIED**. The Vercel env value is a secret, and live HTTP probes were out of scope for this read-only audit.

---

## 6. Which roles exist, and is there a DEALER role?

**Answer: 4 admin roles: SUPER_ADMIN, BROKER_ADMIN, SUPPORT, MANAGER. There is NO DEALER role.**
- Schema: `enum AdminRole` (`prisma/schema.prisma:57-66`). Live DB check: `SELECT unnest(enum_range(null::"AdminRole"))` returns exactly those 4.
- Dealing routes accept `MANAGER` or `BROKER_ADMIN` (for example `app/api/manage/dealing-queue/[id]/route.ts:35`), so the dealer desk is run by MANAGER.
- The Team screen offers `BROKER_ADMIN, MANAGER, SUPPORT` (`Vyx.Backoffice.App/Screens/TeamScreen.cs:31`).
- Delegation is through `extraPermissions` from a fixed list of 8 (`lib/permission-labels.ts:11-20`). None of them is a dealing permission.
- Live counts: SUPER_ADMIN 1. Futurix: BROKER_ADMIN 1, SUPPORT 1. AcmeFX: BROKER_ADMIN 1, MANAGER 1. Nova: BROKER_ADMIN 2, MANAGER 2 (DISABLED). QA: BROKER_ADMIN 1, MANAGER 1.
- Traders (Account, Client) are separate models, not roles.

---

## 7. Equity shows "—" for accounts without positions (CLI, WAL). Where is that decided?

**Answer: on the server, `computeAccountMarginSnapshots` only builds rows for accounts that have OPEN positions. Screens that look an account up in that list show "—" when it is missing.**
- `lib/margin.ts:32-34` iterates `position.findMany({ where: { brokerId, status: "OPEN" } })`. An account with no open position gets no snapshot. `/api/manage/margin` returns only those rows (`app/api/manage/margin/route.ts:16-42`).
- WAL:
  - `FetchMarginAsync` (`WalletsLeadsScreens.cs:39`).
  - Missing row gives `m is null ? "—"` for EQUITY and FREE MARGIN (`WalletsLeadsScreens.cs:70`).
  - The header total falls back to `Balance + Credit` for the same accounts (`:74`), so the header and the rows disagree.
- DSH does the same (`DashboardScreen.cs:249`).
- CLI: the CLI list columns (`ClientsScreen.cs:51-53`) and the client card (`:282-290`) have **no Equity field** in the code. The "—" the user reported on CLI is **UNVERIFIED**, because no CLI element renders equity.

---

## 8. Is a new order rejected server-side when free margin < 0 or the margin level is below the margin-call level?

**Answer: YES for margin-increasing orders on the auto-fill paths. NO for hedging orders, by design. NO margin check at all on the dealer-queue accept path.**
- `checkAccountPreTradeMargin` (`lib/margin.ts:238-330`):
  - Equity = balance + credit + floating P/L.
  - Used margin is hedged (from 2026-09-25).
  - If the order does not increase hedged used margin, it returns null and is allowed "whatever the level" (`:318-320`).
  - Otherwise `checkPreTradeMargin` rejects when the projected level ≤ `Group.marginCallLevel` (`:199-213`), returning INSUFFICIENT_MARGIN or INSUFFICIENT_BALANCE.
- It is called at MARKET auto-fill (`app/api/trade/orders/route.ts:579`, 400 at `:591`), Smart-Dealer accept (`:391`), triggered pending fill (`app/api/trade/orders/[id]/fill/route.ts:261`) and mirror target (`lib/mirror.ts:392`).
- It is **not called** in `app/api/manage/dealing-queue/[id]/route.ts` (no "margin" string in the file). A queued order is stored without a margin check (`orders/route.ts:300-349`, `:483-534`), and a dealer accept opens it unchecked. The same applies to `dealing-desk-toggle`'s auto-flush fill (`app/api/manage/dealing-desk-toggle/route.ts:227`).
- 50005708 (live DB):
  - Group Standard, marginCallLevel 100, stopOutLevel 20, leverage 1:1000, balance 499.30, credit 0.
  - 2 open XAUUSD BUY 0.5 (tickets 100002413/100002414, 03:37-03:38 UTC 25 Sep). `marginCallNotifiedAt` 2026-09-25 03:44:55.
  - At 95% any new BUY, or any order that adds margin, would be refused server-side with INSUFFICIENT_MARGIN.
  - A SELL XAUUSD up to the hedged size would be allowed, because it lowers used margin (`lib/margin.ts:318-320`).
  - The Standard group is `dealingMode AUTO`, so its orders never reach the unchecked queue path (`lib/dealing-routing.ts:42`).
- Terminal: the order ticket has no margin-based enable gate. `OrderTicketPanel.axaml` has no IsEnabled binding. The rejection is shown after the fact as "not enough free margin" (`Vyx.Trader.App/Services/MarketDataService.cs:896`).

---

## 9. Dealer mode: every place that can toggle it, and which field each writes

Backoffice (Avalonia):
| Where | Control | Endpoint | Field written |
|---|---|---|---|
| DEAL header (`DealingScreen.cs:513-514`) | SWITCH TO DEALER ON / SWITCH TO AUTO-FILL | PATCH `/api/manage/dealing-desk-toggle` `{dealerOn}` (`ApiClient.ManageG2.cs:243`) | `Broker.dealingDeskAutoFillAt` (null = dealer on) (`app/api/manage/dealing-desk-toggle/route.ts:80`). Turning it off auto-flushes the queue (audit DEALING_DESK_AUTO_FLUSHED, 24 Sep 02:31) |
| DEAL (`DealingScreen.cs:590`) | auto-hedge toggle | same route `{autoHedge}` (`ApiClient.ManageG2.cs:246`) | `Broker.autoHedgeAt` (a related switch, not queueing) |
| RSK settings (`RiskScreen.cs:80-82`) | Manual dealing TURN ON / TURN OFF | PATCH `/api/manage/risk` `{dealingMode}` | `Broker.dealingModeAt` (`app/api/manage/risk/route.ts:101`) |
| GRP edit form (`GroupsScreen.cs:184`, `:190`, `:197-198`) | "Dealer" choice INHERIT / AUTO / MANUAL, "Force dealer mode" toggle | PUT `/api/manage/groups/{id}` | `Group.dealingMode`, `Group.forceDealingMode` (`app/api/manage/groups/[id]/route.ts:78-79`, `:119`) |

- Trader terminal: none. There is no dealing endpoint in `Vyx.Trader.App`. The only "dealing" string is a requote comment at `ViewModels/DockViewModels.cs:244`.
- Web (still deployed): `components/admin/DealerDeskToggle.tsx`, `app/manage/(shell)/risk/RiskSettingsManager.tsx` and `app/manage/(shell)/groups/GroupsManager.tsx` write the same 3 fields.
- How the fields combine is decided by `resolveWantsDealingQueue` (`lib/dealing-routing.ts:41-44`):
  - MANUAL means always queue. AUTO means never queue, and ignores both broker switches.
  - For INHERIT: the DEALING type with the desk in auto-fill gives no queue. Otherwise the order queues when `dealingModeAt`, `forceDealingMode` or groupType DEALING is set.
- Live Futurix state:
  - `dealingModeAt` null, `dealingDeskAutoFillAt` 2026-09-24 02:31 (desk = AUTO-FILL), `autoHedgeAt` null.
  - Standard, Demo and Reverse Trading groups are AUTO, so neither RSK "Manual dealing ON" nor DEAL "DEALER ON" would queue their orders.
  - The RSK confirm text "Every market order will wait in the dealer queue." (`RiskScreen.cs:81`) and the DEAL confirm "Route every market order to the dealer queue" (`DealingScreen.cs:513`) are both inaccurate for AUTO groups.

---

## 10. Terminal sign-out and switch-account close the whole app. Why?

**Answer: both run `SignOutAsync`, which starts a new copy of the exe and then shuts down. The new copy loses the single-instance lock to the process that is still exiting, so it exits too.**
- Both menu items call `SignOutAsync`. "Switch account…" calls `SignOutAsync(false)` (`Vyx.Trader.App/MainWindow.axaml.cs:238`). "Sign out" and "Sign out and forget this computer" call it too (`:243-244`). The menu is built at `Views/TopBar.axaml.cs:34-36`.
- `SignOutAsync` (`MainWindow.axaml.cs:687-695`): server sign-out → `Process.Start(exe)` → `desktop.Shutdown()`.
- The new process runs `SingleInstance.TryAcquire("VyxTrader")` first (`Vyx.Trader.App/Program.cs:177`).
  - The old process still owns the named mutex, which is held for the whole process lifetime (`Vyx.Shared.Ui/SingleInstance.cs:17`, `:32-35`).
  - So `createdNew` is false. The new process signals the old one to "surface" and returns without opening a window (`Program.cs:177`).
  - The old process then finishes `Shutdown()`, and no process is left.
- There is no in-process path back to the sign-in window. `App.axaml.cs:66-76` builds the login window only once, at startup.

---

## Issues
[money] MIR · Enabled REVERSE MirrorRule cmti5p02… (Reverse Trading group → 50005702) is live in DB but the screen lists 0 rules. ListAsync drops the `{rows}` object response, so the rule cannot be seen, disabled or killed from the backoffice · Vyx.Shared/Api/ApiClient.ManageG1.cs:272-279, ApiClient.ManageG6.cs:159, app/api/manage/mirror-rules/route.ts:93
[money] MIR · Mirror target 50005702 was moved from a REVERSAL group to Standard (B_BOOK) on 2026-09-21 while the rule targeting it stayed enabled · AuditLog ACCOUNT_GROUP_CHANGED 2026-09-21 03:36, MirrorRule.enabled=true
[money] pricing · Standard XAUUSD spreadMarkup=30 (pips = 300 points) was applied to 13 LIVE fills on 50005708 (24 Sep 04:23-04:32 UTC) before the unit fix · AuditLog ACCOUNT_TYPE_SYMBOL_PRICING_UPDATED 03:23:10 / 05:04:46, lib/pricing-engine.ts:137
[functional] pricing · AccountTypeSymbolConfig is empty for every broker; Standard XAUUSD now fills at raw spread (BrokerSymbol markup 0) · DB SELECT AccountTypeSymbolConfig = 0 rows, AuditLog RESET 2026-09-24 11:45:48
[money] DEAL · Dealer-queue accept and desk-off auto-flush open positions with no pre-trade margin check · app/api/manage/dealing-queue/[id]/route.ts (no checkAccountPreTradeMargin), app/api/manage/dealing-desk-toggle/route.ts:227
[functional] FUN · Withdrawal maker-checker needs 2 distinct BROKER_ADMIN/MANAGER+FUNDS_APPROVAL admins; Futurix has 1 BROKER_ADMIN + 1 SUPPORT, so it cannot complete any withdrawal · lib/funds-approval.ts:29-35, lib/permissions.ts:18
[functional] EMG · TYPE column shows legacy groupType (DEALING/LP) not category (REVERSAL/B_BOOK/A_BOOK); differs from GRP ROUTING · Vyx.Backoffice.App/Screens/SecurityEmergencyScreens.cs:145, GroupsScreen.cs:68
[text] shared · ManageGroup doc comment says GroupType is read by nothing, but EMG and DEAL read it · Vyx.Shared/Api/ApiClient.ManageG2.cs:15-16, DealingScreen.cs:603
[functional] FEED · PRICE ALERTS tile is only as reachable as Vercel→TRADING_CORE_URL; default is 127.0.0.1:8081; live cause UNVERIFIED · app/api/manage/feed-health/route.ts:71,106
[ux] WAL · EQUITY / FREE MARGIN show "—" for any account with no open position while header EQUITY total uses balance+credit for them · Vyx.Backoffice.App/Screens/WalletsLeadsScreens.cs:70,74, lib/margin.ts:33-34
[ux] DSH · EQUITY shows "—" for accounts with no open position · Vyx.Backoffice.App/Screens/DashboardScreen.cs:249
[ux] terminal · Order ticket has no margin-level gate; stays enabled at 95% level / negative free margin (server rejects afterwards) · Vyx.Trader.App/Views/OrderTicketPanel.axaml (no IsEnabled binding), Services/MarketDataService.cs:896
[text] RSK · "Every market order will wait in the dealer queue." is false for groups with dealingMode AUTO (all Futurix client groups) · Vyx.Backoffice.App/Screens/RiskScreen.cs:81, lib/dealing-routing.ts:42
[text] DEAL · "Route every market order to the dealer queue for manual review?" is false for AUTO / non-DEALING groups · Vyx.Backoffice.App/Screens/DealingScreen.cs:513, lib/dealing-routing.ts:41-44
[functional] terminal · Sign out / Switch account close the app: relaunched process loses the single-instance mutex to the exiting one and exits · Vyx.Trader.App/MainWindow.axaml.cs:692-694, Program.cs:177, Vyx.Shared.Ui/SingleInstance.cs:32-35
[functional] roles · No DEALER role; dealing desk requires MANAGER or BROKER_ADMIN, no dealing permission in the delegation list · prisma/schema.prisma:57-66, lib/permission-labels.ts:11-20
