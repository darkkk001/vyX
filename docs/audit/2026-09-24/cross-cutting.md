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
