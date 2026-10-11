# VYX-AUDIT-ALL part 1/9


<!-- ===== 00-INDEX.md ===== -->

# 00-INDEX: VyX functional audit (read-only), 2026-09-24/25

## Repos and paths
| Part | Path | Commit audited |
|---|---|---|
| Native apps (Avalonia, .NET 8, Native AOT) | `E:\vyxtrader` (origin darkkk001/VyxTrader, master) | `1c8b0d3` |
| Web / API (Next.js 15, Prisma) + Rust engine + API gateway | `D:\VyXTrader-Tauri\vyX` (newrepo darkkk001/vyX, main) | `74b3c02` |
| Backoffice app | `E:\vyxtrader\src\Vyx.Backoffice.App` | live build 1.0.22 |
| Trader terminal app | `E:\vyxtrader\src\Vyx.Trader.App` | live build 1.0.45 |
| Shared (API client, models, trading math) | `E:\vyxtrader\src\Vyx.Shared` (`Api\ApiClient*.cs`, `Api\Models.cs`, `Trading\*.cs`, `Charting\*.cs`) | |
| Shared UI (title bar, StartupGate, UpdateService, chart host, MenuHost) | `E:\vyxtrader\src\Vyx.Shared.Ui` | |
| Web routes | `D:\VyXTrader-Tauri\vyX\app\api\**\route.ts` | |
| Web business logic | `D:\VyXTrader-Tauri\vyX\lib\*.ts` | |
| Rust engine | `D:\VyXTrader-Tauri\vyX\engine` (server, order-management, market-data, risk, margin, parity) | |
| API gateway (Node) | `D:\VyXTrader-Tauri\vyX\services\api-gateway` | |
| DB schema | `D:\VyXTrader-Tauri\vyX\prisma\schema.prisma` | live DB: Neon ep-morning-glade |

## Build / run
- Native, debug: `dotnet build E:\vyxtrader\Vyx.Native.sln -c Debug`; tests `dotnet test tests\Vyx.Shared.Tests`.
- Native, release (per broker, tenant-bound, AOT): `tools\publish-terminal.ps1` / `tools\publish-backoffice.ps1 -Brand -Slug -DefaultHost -Version -FeedRoot -Notes` (registers the build, packs with vpk; feed staged to the web repo's `public\native-*-updates\<slug>`).
- Web: `npm run dev` (next dev), `npm run build` (prisma generate + next build), `npm test` (vitest; DB tests need the local scratch DB, `vitest.setup.db-guard.ts`).
- Engine: `cargo build --release` in `engine`; tests `bash scripts/test-engine.sh`; parity `bash scripts/parity/run-db.sh`; shadow gate `bash scripts/load/shadow-gate.sh`.
- Harness (headless): terminal `Vyx.Trader.App.exe --screenshot --dev-dock-demo ...`; backoffice `--screenshot --fixture`, `--live-check`, `--manifest-check`.

## Backoffice navigation (exact order and titles)
Source: `E:\vyxtrader\src\Vyx.Backoffice.App\ViewModels\ShellViewModel.cs:50-88`.
| Group | Code | Title | Screen file |
|---|---|---|---|
| OVERVIEW | DASH | Dashboard | Screens\DashboardScreen.cs |
| OVERVIEW | RPT | Reports | Screens\IbReportsScreens.cs |
| OVERVIEW | NTF | Notifications | Screens\NotificationsAuditScreens.cs |
| TRADING | EXP | Live exposure | Screens\LiveExposureScreen.cs |
| TRADING | DEAL | Dealing | Screens\DealingScreen.cs (+ Services\DealingChart.cs, DealingMarketWatch.cs) |
| TRADING | DLS | Trade history | Screens\DealsScreen.cs |
| TRADING | SYM | Symbols | Screens\SymbolsScreen.cs |
| TRADING | GRP | Groups | Screens\GroupsScreen.cs (+ Controls\PricingPanel.cs) |
| TRADING | ATY | Account types | Screens\AccountTypesScreen.cs (+ Controls\PricingPanel.cs) |
| TRADING | MIR | Mirror rules | Screens\ApprovalsMirrorScreens.cs |
| RISK | RISK | Risk | Screens\RiskScreen.cs |
| RISK | RDR | Risk radar | Screens\LiquidityScreens.cs |
| RISK | EMG | Trading halt | Screens\SecurityEmergencyScreens.cs |
| RISK | MRG | Margin | Screens\RiskScreen.cs |
| LIQUIDITY | LP | Liquidity | Screens\LiquidityScreens.cs |
| LIQUIDITY | ROUTE | Liquidity routing | Screens\LiquidityScreens.cs |
| LIQUIDITY | FEED | Feed health | Screens\LiquidityScreens.cs |
| CLIENTS | CLI | Clients (+ Client 360) | Screens\ClientsScreen.cs |
| CLIENTS | CRM | Leads | Screens\WalletsLeadsScreens.cs |
| CLIENTS | IB | IB partners | Screens\IbReportsScreens.cs |
| CLIENTS | KYC | KYC review | Screens\KycScreen.cs |
| CLIENTS | LAR | Account requests | Screens\LiveAccountRequestsScreen.cs |
| FINANCE | DEP | Deposits · withdrawals | Screens\FundsScreen.cs |
| FINANCE | APR | Approvals | Screens\ApprovalsMirrorScreens.cs |
| FINANCE | PSP | Payment methods | Screens\PaymentMethodsScreen.cs |
| FINANCE | TRX | Transfers | Screens\TransfersScreen.cs |
| FINANCE | WAL | Wallets | Screens\WalletsLeadsScreens.cs |
| SYSTEM | USR | Team | Screens\TeamScreen.cs |
| SYSTEM | AUD | Audit log | Screens\NotificationsAuditScreens.cs |
| SYSTEM | SEC | Security | Screens\SecurityEmergencyScreens.cs |
| SYSTEM | CFG | Settings | Screens\SettingsScreen.cs |

Backoffice shared components: `Controls\DataTable.cs` (every table), `Controls\FormOverlay.cs` (every form dialog), `Controls\ConfirmOverlay.axaml(.cs)` (confirm / typed confirm / input confirm), `Controls\PricingPanel.cs` (GRP + ATY pricing), `Controls\KpiTile.cs`, `Controls\Ui.cs` (text/badge helpers), `Controls\DocumentViewer.cs` (KYC docs), `Controls\ScreenPlaceholder.axaml`, `Services\MenuHost.cs` (context menus), `Services\LiveService.cs` (event stream), `Screens\Screen.cs` (base: Confirm / Form / Toast / AfterWriteAsync).

## Trader terminal areas and files
| Area | Files |
|---|---|
| Shell / header / account strip / status bar / tape | MainWindow.axaml(.cs), Views\TopBar, Views\StatusBar, Views\Tape |
| Market watch | Views\MarketWatchPanel, ViewModels\MarketWatchViewModels, Views\SymbolSpecWindow |
| Chart | Vyx.Shared.Ui\Charting (ChartHost, StudiesStore, DrawingsStore), Vyx.Shared\Charting, Vyx.Trader.App\Charting |
| Order ticket (dock) | Views\OrderTicketPanel, ViewModels\OrderTicketViewModel(s) |
| F9 new order | Views\NewOrderWindow, ViewModels\NewOrderViewModel |
| Positions + tabs (pending / orders / history / balance / log) | Views\PositionsPanel, ViewModels\DockViewModels, PositionsViewModels, Services\StatementExport |
| Modify / close | Views\ModifyPositionWindow, ViewModels\ModifyPositionViewModel |
| Smart Trade Manager | Views\SmartRulesWindow, Services\SmartRulesEngine |
| Account panel | Views\AccountPanel, ViewModels\AccountViewModel |
| Economic calendar / news | Views\EcoPanel |
| Alerts | Views\AlertsWindow |
| Settings | Views\SettingsWindow, Services\TerminalSettings |
| Share card | Views\ShareCardWindow, Services\ShareCard |
| Session / update | Views\LoginWindow, Services\CredentialStore, Services\UpdateService + Vyx.Shared.Ui UpdateService / StartupGate |
| All logic hub | Services\MarketDataService.cs |

## Audit files (this folder)
Per screen: `bo-<CODE>.md` (backoffice, incl. `bo-SHELL.md`) and `term-<area>.md` (terminal); cross-cutting: `ui-map.md`, `entities.md`, `endpoints.md`, `config.md`, `cross-cutting.md`, `questions.md`, `issues.md`, `recommendations.md`; everything combined: `VYX-AUDIT-ALL*.md`; zip: `vyx-audit-2026-09-24.zip`. `_BRIEF.md` = the method every file follows.


<!-- ===== bo-SHELL.md ===== -->

# bo-SHELL — Backoffice shell: main window, nav, header, login, theme, updater, sign-out

Sources: E:\vyxtrader\src\Vyx.Backoffice.App\Views\MainWindow.axaml (194 lines), MainWindow.axaml.cs (344), Views\LoginWindow.axaml(.cs) (149/171), ViewModels\ShellViewModel.cs, Services\BackofficeSession.cs, Services\ThemeService.cs, App.axaml.cs, Controls\ConfirmOverlay.axaml(.cs), Vyx.Shared.Ui\UpdateService.cs. Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view/navigation control that does what it says is WORKS.

## A. Purpose + panels
Startup gate → sign-in window → main shell: 30 px command bar (title bar), left nav (176 px) with grouped screen codes, content host (one Screen per code), 22 px F-key/status bar, search popover, shared form and confirm overlays.
Launch flow (App.axaml.cs:19-87): theme applied from local settings (or VYX_THEME env) → single-instance listener → StartupGate.CheckAsync("backoffice") (brand file + ACTIVE tenant manifest; refusal window otherwise, :57-65) → LoginWindow → on SignedIn a new MainWindow (InstallScreens, lands on DASH every launch, MainWindow.axaml.cs:138-150) → SignedOut returns to a new LoginWindow (App.axaml.cs:73-79).

## B. Data
| Read / write | ApiClient | Route | When |
|---|---|---|---|
| POST /api/manage/login {email,password,remember} | ManageLoginAsync ApiClient.Manage.cs:36 | app/api/manage/login/route.ts | SIGN IN; rate limit 5/60 s per broker+email (:37); roles MANAGER/BROKER_ADMIN/SUPPORT (:59); sets vyx_admin_session; AdminUser.lastLoginAt (:93) |
| POST /api/manage/login/verify-2fa | ManageVerifyTwoFactorAsync Manage.cs:45 | app/api/manage/login/verify-2fa/route.ts | code step; code longer than 6 chars is sent as backupCode (BackofficeSession.cs:46) |
| GET /api/manage/shell-info | FetchShellInfoAsync Manage.cs:62 | app/api/manage/shell-info/route.ts:15 (MANAGER, BROKER_ADMIN) | after sign-in / resume (BackofficeSession.cs:54,66) and in every badge refresh (unread count only) |
| POST /api/admin/forgot-password | ManageForgotPasswordAsync Manage.cs:59 | app/api/admin/forgot-password/route.ts:11 | login "Forgot password?" |
| GET /api/manage/search?q= | ManageSearchAsync Manage.cs:70 | app/api/manage/search/route.ts (MANAGER, BROKER_ADMIN :24; <2 chars → empty :30; 5-6 per bucket :47-74) | command line, 250 ms debounce (MainWindow.axaml.cs:253-271) |
| Badge reads: kyc-requests, client-kyc-requests, live-account-requests, funds-requests, shell-info, risk-radar, balance-adjustment-requests, position-action-requests | ManageG1/G5/G6 | app/api/manage/* | every 60 s (MainWindow.axaml.cs:141-142) and at most every 5 s on a live event (:178); a 403 sets the badge to 0 |
| Gateway admin event + price streams | LiveService (Services/LiveService.cs) via AdminSessionCookie | services/api-gateway | started after InstallScreens (MainWindow.axaml.cs:149); stopped on sign-out |
Session state lives in BackofficeSession (Host, AdminEmail, Role, TwoFactorUsed, SignedInAtUtc, Shell). Session.Shell is set at sign-in/resume only; RefreshShellAsync (BackofficeSession.cs:75-79) has no caller.
Updater: UpdateService (Velopack, feed = brand.json UpdateUrl) created in App.axaml.cs:58; the only check runs when a LoginWindow is constructed for an installed copy (LoginWindow.axaml.cs:53-57). The shell has no update check, timer or banner.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BROKER SERVER box + ▾ recent-hosts picker | login card (LoginWindow.axaml:68-79; .cs:74-80) | sign-in mode | not busy; read-only on broker builds (.cs:59-64) | none | none | "Enter the broker server." ; bare name → "{name}.vyxtrader.com" (.cs:151-159) | no | no | none | host set | WORKS |
| ADMIN E-MAIL / PASSWORD (Enter submits) | login card (axaml:89-93) | sign-in mode | not busy | none | none | required (.cs:114-115) | no | no | none | - | WORKS |
| Remember me on this computer | login card (axaml:101) | sign-in mode | not busy | none (local) | none | - | no | no | none | session cookie saved to Windows Credential Manager "session:{host}" (.cs:137); next launch resumes without password (.cs:67-71,160-169) | WORKS |
| SIGN IN (primary) | login card (axaml:114; .cs:105-148) | always | not busy | ManageLoginAsync -> POST /api/manage/login; then FetchShellInfoAsync -> GET shell-info | session created, lastLoginAt set | 12 s timeout -> "Cannot reach {host}…"; 401/403/429/426 mapped to sentences (BackofficeSession.cs:92-100) | no | no | MANAGER, BROKER_ADMIN (SUPPORT passes login then fails shell-info) | shell opens; host/e-mail/recent hosts saved | PARTIAL (a SUPPORT admin gets "Signed in, but the backoffice info could not be loaded: not allowed for this role."; the server session is left open) |
| AUTHENTICATOR CODE + VERIFY | login card (axaml:95-97) | server asked for 2FA | not busy | ManageVerifyTwoFactorAsync -> POST login/verify-2fa | session created | ≥6 chars (.cs:111) | no | no | same | shell opens | WORKS |
| CANCEL | login card (axaml:111) | busy | busy | cancels the attempt | none | - | no | no | none | "Cannot reach {host}…" shown | WORKS |
| Forgot password? → SEND REQUEST | login card (axaml:102,121-137; .cs:81-98) | sign-in mode / forgot mode | not busy | ManageForgotPasswordAsync -> POST /api/admin/forgot-password | Notification ADMIN_PASSWORD_RESET_REQUESTED for MANAGER/BROKER_ADMIN only; rate limit 3/h silently ok (forgot-password/route.ts:19-38) | host + e-mail required | no | no | none | "Reset request sent." | PARTIAL (SUPPORT and unknown e-mails get the same success; broker staff receiving it cannot reset a staff password — only SUPER_ADMIN can) |
| ← Back to sign in | forgot mode (axaml:135) | forgot mode | always | none | none | - | no | no | none | sign-in mode | WORKS |
| UPDATE v{X} READY · CLICK TO RESTART | login card (axaml:142-143; .cs:55,170) | update downloaded | always | UpdateService.ApplyAndRestart (UpdateService.cs:67-71) | none (Velopack local apply) | - | no | no | none | app restarts into the new version | PARTIAL (only reachable on the login window; checked once per login-window construction; a remember-me resume closes the window before the banner can appear; no in-shell check) |
| Nav item click (31 items) | left nav (MainWindow.axaml:112; .cs:219) | always, every role | always | Navigate(code) → screen EnsureFreshAsync | none | - | no | no | none (no role filtering) | screen shown; LastNavItem saved (never used to land) | WORKS |
| Command line / search (Ctrl+K) | command bar (axaml:70; .cs:228,234-285) | always | always | ManageSearchAsync -> GET /api/manage/search?q= | none | ≥2 chars | no | no | MANAGER, BROKER_ADMIN | popover: up to 3 NAV hits + accounts/orders/positions/transactions/symbols; ↑↓ move, Enter open, Esc close; typing a code + Enter jumps | WORKS |
| Search hit click / Enter | search popover (axaml:177; .cs:272-284) | popover open | always | Shell.Open(code, id): CLI→CLI, POS→EXP, ORD→CLI (account), TRX→DEP, SYM→SYM | none | - | no | no | none | toast "{kind} {title} → {code}" | WORKS |
| F1 | status bar F-keys / keyboard (ShellViewModel.cs:96; MainWindow.axaml.cs:221-227) | always | always | none | none | - | no | no | none | toast "F1 · help — not in this build" | PLACEHOLDER |
| F2–F12 (CLIENTS, EXPOSURE, DEPOSITS, DEALING, KYC, IB, SYMBOLS, RISK, REPORTS, AUDIT, SETTINGS) | status bar / keyboard (ShellViewModel.cs:96-98) | always | always | Navigate(code) | none | - | no | no | none | screen shown | DUPLICATE (nav items) |
| USER cell ▾ → "Security…" | command bar user menu (MainWindow.axaml.cs:292-302) | signed in | always | Navigate("SEC") | none | - | no | no | none | SEC | WORKS |
| USER menu → "Sign out" | same (:300,305-308) | signed in | always | Session.SignOut (BackofficeSession.cs:83-90): deletes saved credentials, stops streams, expires local cookies | NONE on the server: POST /api/admin/logout (app/api/admin/logout/route.ts:8-20, same vyx_admin_session cookie, lib/auth.ts:10) is never called, so the Redis session stays valid until expiry | - | yes ("SIGN OUT" / "Return to sign-in?") | no | none | new login window | PARTIAL (no server-side revocation) |
| USER menu → "Switch account…" | same (:299) | signed in | always | same SignOut | same | - | yes | no | none | same | DUPLICATE (Sign out :300) |
| THEME cell (☾ DARK / ☀ LIGHT) | command bar (axaml:85-87; .cs:289-290) | always | always | ThemeService.Toggle (local settings file) | none (PATCH /api/manage/theme exists, not called) | - | no | no | none | theme switches, persisted locally | WORKS |
| Bell cell (unread count) | command bar (axaml:88-93; .cs:303) | always | always | Navigate("NTF") | none | - | no | no | none | NTF | DUPLICATE (nav NTF) |
| Caption buttons (minimise / maximise / close) + drag / double-click title bar | command bar right (axaml:94; .cs:69-71) | always | always | window ops | none | - | no | no | none | - | WORKS |
| Confirm overlay CANCEL / OK (Enter in input = OK, Esc = cancel, backdrop ignored) | overlay (ConfirmOverlay.axaml:21-22; .axaml.cs:12-16; MainWindow.axaml.cs:78-84,229) | a confirm is open | always | runs the screen's action | per action | required input / validator (tenant name) | - | - | - | dialog closes before the action runs; result toasted in the status bar (:82,329-333) | WORKS |

## D. Dialogs
Login card fields: BROKER SERVER (text, default last host; stored locally in BackofficeSettings.LastHost/RecentHosts, max 8), ADMIN E-MAIL (text, default last e-mail), PASSWORD (masked), AUTHENTICATOR CODE (text, max 16, visible only after the server asks), Remember me (checkbox, default last choice; stores the session cookie, never the password — legacy stored passwords are deleted, LoginWindow.axaml.cs:65-66). Forgot mode: ADMIN E-MAIL, NOTE (OPTIONAL) max 500 → Notification.body (forgot-password/route.ts:34), read by manage NTF and admin/notifications.
SIGN OUT confirm: "Return to sign-in?", button SIGN OUT.
Startup refusal window (StartupGate.Refusal, App.axaml.cs:61): gate message + updater.

## E. Text
- Login forgot text "Another administrator of your broker will receive the request." (LoginWindow.axaml:123): the actor who can reset a staff password is VyX Super Admin (app/api/admin/admins/[id]/reset-password/route.ts:13).
- ApiClient comment "There is no /api/manage/logout route: … the session cookies for the host are expired" (ApiClient.Manage.cs:100-101) while POST /api/admin/logout revokes the same cookie server-side.
- ROLE cell "BROKER ADMIN" (MainWindow.axaml.cs:108) vs "ADMIN" on USR (TeamScreen.cs:70).
- F1 toast "F1 · help — not in this build" (:223).
- Login decorative sidebar lists OVERVIEW, TRADING, RISK, CLIENTS, FINANCE, SYSTEM (LoginWindow.axaml:36-41); the real nav also has LIQUIDITY.
- Login version "v{AssemblyVersion(3)}" (LoginWindow.axaml.cs:49) vs CFG "v{InformationalVersion}" (SettingsScreen.cs:34): UNVERIFIED whether they can differ for a release build.
- Search popover footer "↑ ↓ move · Enter open · Esc close" (MainWindow.axaml:187).
- ScreenPlaceholder ActiveGroupText "not available yet" (ShellViewModel.cs:108) — never shown now: all 31 codes have a screen (Screen.cs:151-184).

## F. UI structure map
Window: title "{BrokerName} Backoffice" (MainWindow.axaml.cs:104), 1920×1015 clamped to work area, min 1000×560, custom chrome. Rows 30 / * / 22.
Command bar (left → right): brand tile (orange, square glyph, first word of broker name upper-cased, "BACKOFFICE") · command line TextBox "search · Ctrl+K" · BROKER cell (name + orange "LIVE" when signed in) · SERVER cell (host + "OK") · STREAM cell (pulsing green dot + state text; tooltip "Gateway event + price streams (the same feed the terminal uses)") · ROLE cell · USER cell (e-mail ▾, tooltip "Account") · THEME cell ("☾ DARK" / "☀ LIGHT" = the theme you switch TO; tooltip "Light / dark") · bell cell (🔔 + red unread count; tooltip "Notifications") · caption buttons (Minimise, Maximise, Close).
Left nav (176 px), groups and items in order, "Title  CODE  badge":
- OVERVIEW: Dashboard DASH · Reports RPT · Notifications NTF (badge = unread, not hot)
- TRADING: Live exposure EXP · Dealing DEAL (badge hot: +1 per DealingQueued event, reset by DEAL refresh, DealingScreen.cs:298) · Trade history DLS · Symbols SYM · Groups GRP · Account types ATY · Mirror rules MIR
- RISK: Risk RISK · Risk radar RDR (badge hot: flagged accounts + IP clusters) · Trading halt EMG · Margin MRG
- LIQUIDITY: Liquidity LP · Liquidity routing ROUTE · Feed health FEED
- CLIENTS: Clients CLI · Leads CRM · IB partners IB · KYC review KYC (badge hot: both queues pending) · Account requests LAR (badge hot)
- FINANCE: Deposits · withdrawals DEP (badge hot: pending funds) · Approvals APR (badge hot: pending balance + position action requests) · Payment methods PSP · Transfers TRX · Wallets WAL
- SYSTEM: Team USR · Audit log AUD · Security SEC · Settings CFG
(ShellViewModel.cs:51-89). Active item: orange left border + accent wash. Nav footer: "TENANT {host}" / "NOT SIGNED IN". No role-based hiding.
Status bar (left → right): green/red dot + "{HOST} · {ROLE}" · F-key strip F1 HELP · F2 CLIENTS · F3 EXPOSURE · F4 DEPOSITS · F5 DEALING · F6 KYC · F7 IB · F8 SYMBOLS · F9 RISK · F10 REPORTS · F11 AUDIT · F12 SETTINGS · toast text (green/red, 4 s) · UTC clock "HH:mm:ss UTC".
Search popover (560 px, under the command line): header "SEARCH" + status ("searching…", "{n} results", "no match"); rows KIND · title · detail (kinds NAV, CLI, ORD, POS, TRX, SYM); footer hint.
Right-click: USER cell opens a menu on left-click (header "{email} · {ROLE}" disabled, separator, "Security…", "Switch account…", "Sign out"). No right-click menus on nav, command bar or status bar.
Alerts: DealingQueued event → system beep + toast "NEW DEALING REQUEST · F5" (MainWindow.axaml.cs:165-170); unread count increase → notification sound (:209).
Login window (1120×720): title bar with brand; left decorative column (group names); card: brand, BROKER SERVER (+ ▾ recent hosts flyout), ADMIN E-MAIL, PASSWORD, [AUTHENTICATOR CODE], Remember me, "Forgot password?" link, error box (red), status line, CANCEL (while busy) + SIGN IN / VERIFY (orange); forgot mode: "RESET YOUR PASSWORD", sentence, ADMIN E-MAIL, NOTE (OPTIONAL), error, "Reset request sent." (green), "← Back to sign in", SEND REQUEST; update banner; version text; footer "BACKOFFICE · SIGN IN TO START · {date} UTC".

## Issues
[functional] SHELL · sign-out (and "Switch account…") only expires the local cookie; POST /api/admin/logout, which revokes the Redis session for the same vyx_admin_session cookie, is never called, so a captured or remembered token stays valid until expiry · BackofficeSession.cs:83-90; ApiClient.Manage.cs:100-110; app/api/admin/logout/route.ts:8-20; lib/auth.ts:10
[functional] SHELL · Broker.requireAdmin2fa is not enforced for the native backoffice (only the web manage layout checks it; manage/login and getAdminSession do not) · app/manage/(shell)/layout.tsx:46; lib/auth.ts:288-296,327-332
[functional] SHELL · update check runs once when the login window is built; the shell never checks, a remember-me resume closes the login window before the banner can show, and nothing stages the update on exit, so a long-running or auto-resumed backoffice never offers updates · LoginWindow.axaml.cs:53-57,67-71; App.axaml.cs:66-84; UpdateService.cs:74-78 (ApplyOnExit unused by backoffice); cf. Vyx.Trader.App/MainWindow.axaml.cs:255
[functional] SHELL · nav shows all 31 screens to every role; MANAGER hits 403 on USR, CFG, IB (without IB_PAYOUTS), DEP (without FUNDS_APPROVAL) etc.; SUPPORT cannot get past shell-info at all · ShellViewModel.cs:51-89; app/api/manage/admins/route.ts:10-16; settings/route.ts:6-12; shell-info/route.ts:17
[functional] SHELL · Session.Shell (broker name, finance rights, theme) is never refreshed after sign-in; RefreshShellAsync has no caller · BackofficeSession.cs:75-79; MainWindow.axaml.cs:196-211
[functional] SHELL · theme toggle is local only; the server-side admin theme (AdminUser.theme, PATCH /api/manage/theme) is neither read at launch nor written · App.axaml.cs:29; MainWindow.axaml.cs:289; app/api/manage/theme/route.ts:12
[ux] SHELL · DEAL badge is incremented client-side per DealingQueued event and only corrected when the DEAL screen refreshes; RefreshBadgesAsync never sets it · MainWindow.axaml.cs:169,194-211; DealingScreen.cs:298
[ux] SHELL · deep links call FocusRecord right after Navigate while the target screen's fetch is still in flight; screens without a pending-focus mechanism (e.g. USR, IB) ignore the id on a first visit · MainWindow.axaml.cs:125-130; TeamScreen.cs:69; IbReportsScreens.cs:48
[text] SHELL · login forgot-password text says another broker administrator will receive the request; only Super Admin can reset a staff password · LoginWindow.axaml:123; app/api/admin/admins/[id]/reset-password/route.ts:13

## Status counts
STATUS-COUNTS app=backoffice screen=SHELL WORKS=13 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=3


<!-- ===== bo-DASH.md ===== -->

# bo-DASH — Dashboard (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DashboardScreen.cs (324 lines). Web: D:\VyXTrader-Tauri\vyX (main HEAD).
Convention: a pure view control (filter chip, search, sort, navigation) that does what it says is WORKS; UI-ONLY is reserved for a control that looks like it writes but does not.

## A. Purpose + panels
Broker overview: 9 KPI tiles, clients list, open book by symbol, approvals queue, 7-day deposit/withdrawal chart, recent audit activity. Read-only screen (no writes).
Panels: KPI strip (row 0, 54 px); "1) CLI · CLIENTS" (mid-left); "2) EXP · OPEN BOOK" (mid-right, 400 px); "3) APPR · APPROVALS QUEUE" (bottom-left); "4) FLOW · DEPOSITS VS WITHDRAWALS · 7D" (bottom-middle); "5) ACT · ACTIVITY" (bottom-right, 340 px). DashboardScreen.cs:66-79.

## B. Data
Refresh: live topics order/position/dealing/account (DashboardScreen.cs:25) -> active screen refetches after 400 ms debounce (MainWindow.axaml.cs:161-178); poll every 30 s while active (DashboardScreen.cs:26; MainWindow.axaml.cs:182-187; poll skipped while a TextBox has focus or a confirm/form is open); on nav when last refresh >10 s old with a LOADING… veil (Screen.cs:70-76); ticks re-render price cells at most 1/s (DashboardScreen.cs:110-116).
Nine parallel reads (DashboardScreen.cs:89-92):
| Read | ApiClient | Route handler | Role gate (server) | Limit |
|---|---|---|---|---|
| GET /api/manage/dashboard | FetchDashboardAsync ApiClient.ManageG1.cs:147 | app/api/manage/dashboard/route.ts:16 | MANAGER, BROKER_ADMIN (route.ts:18) | activity take 15 (route.ts:73) |
| GET /api/manage/accounts | FetchManageAccountsAsync ManageG1.cs:152 | app/api/manage/accounts/route.ts:21 | MANAGER, BROKER_ADMIN (route.ts:15) | none |
| GET /api/manage/positions | FetchManagePositionsAsync ManageG1.cs:224 | app/api/manage/positions/route.ts:47 | MANAGER, BROKER_ADMIN | all OPEN, demo included (route.ts:56) |
| GET /api/manage/margin | FetchMarginAsync ManageG1.cs:223 | app/api/manage/margin/route.ts:10 | MANAGER, BROKER_ADMIN | none |
| GET /api/manage/deals | FetchDealsAsync ManageG1.cs:203 | app/api/manage/deals/route.ts:15 | MANAGER, BROKER_ADMIN | take 500, CLOSED+VOIDED (route.ts:56,71) |
| GET /api/manage/funds-requests | FetchFundsRequestsAsync ManageG1.cs:235 | app/api/manage/funds-requests/route.ts:11 | BROKER_ADMIN or FUNDS_APPROVAL (route.ts:13) | take 200 |
| GET /api/manage/live-account-requests | FetchLiveAccountRequestsAsync ManageG1.cs:267 | app/api/manage/live-account-requests/route.ts:12 | BROKER_ADMIN or KYC_REVIEW (route.ts:14) | take 200 |
| GET /api/manage/risk | FetchRiskSettingsAsync ManageG2.cs:162 | app/api/manage/risk/route.ts:12 | BROKER_ADMIN or RISK_SETTINGS or EMERGENCY_CONTROLS (route.ts:15) | - |
| GET /api/manage/dealing-queue | FetchDealingQueueAsync ManageG2.cs:213 | app/api/manage/dealing-queue/route.ts:24 | MANAGER, BROKER_ADMIN | - |
Errors: only dashboard/accounts/positions/margin/deals/funds failures go to the header status text (DashboardScreen.cs:94-100); live-account-requests, risk and dealing-queue failures are silent (count 0 / no limit / tile blank).
Per panel:
- KPI strip (DashboardScreen.cs:124-147): NET DEPOSITS · 7D (dashboard.netDeposits7d, note PRIOR), DEPOSITS · 30D (depositsSum30d), WITHDRAWALS · PENDING (pendingWithdrawalCount + pendingWithdrawalSum), ACTIVE TRADERS (activeTradeAccountCount, LIVE only, route.ts:54-59; note "{activeTrades} OPEN"), OPEN VOLUME (client sum of positions volume, demo included), B-BOOK P/L · FLOATING (−sum floatingPnl of BookType B*; note REALIZED TODAY = −sum realizedPnl of deals closed today, all books, demo and VOIDED included), MARGIN CALLS (margin rows with MarginCallLevel ≥ ML > StopOut; note "{n} STOP-OUT"), NEW CLIENTS · 7D (all accounts incl. demo; note "{PendingKyc} KYC WAIT · {n} ACCOUNT REQUESTS"), DEALER QUEUE (pending count, note OLDEST age).
- 1) CLI: accounts joined to margin rows by account id; client filter chips + search; empty "no accounts". Header right "{n} TOTAL". No pagination.
- 2) EXP: positions grouped by symbol, sorted by |long−short| desc (DashboardScreen.cs:154-160); empty "no open positions". Header stats "A / B BOOK" (lots split) and "NET $ EXP" (notional vs risk.totalExposureLimit, amber ≥80 %, red ≥100 %). Facts under the table: Top floating loser/winner, A-book open, NEAREST STOP-OUT (5 lowest margin levels; "NO MARGIN DATA"), "LP fill quality · PENDING · NEEDS LP BRIDGE" (static).
- 3) APPR: funds rows with Status PENDING and Type DEPOSIT/WITHDRAWAL, oldest first (DashboardScreen.cs:182-184); empty "no pending deposits or withdrawals"; header stat "{n} DEP {sum} · {n} WDR {sum}" or "NONE PENDING".
- 4) FLOW: dashboard.depositsWithdrawalsByDay (7 buckets, route.ts:88-107); custom bar chart; "NO FLOW · 7D" when no bucket has Deposits>0 or Withdrawals>0 (DashboardScreen.cs:189-191).
- 5) ACT: dashboard.activity (server take 15, excludes super-admin actors, route.ts:70-75); client renders up to 40 (DashboardScreen.cs:196); "NO AUDIT ROWS".
Loading: whole page veiled "LOADING…" (Screen.cs:81-94); header status "loading…" then "HH:mm:ss UTC".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filter chips ALL/LIVE/DEMO/KYC WAIT/SUSPENDED/IB | 1) CLI filter bar (DashboardScreen.cs:229-239) | always | always | none (client filter) | none | - | no | no | none | re-render list | PARTIAL (SUSPENDED filters Status != ACTIVE, so CLOSED accounts too, :239) |
| Search "client · account · e-mail" | 1) CLI filter bar right (:32,62,241) | always | always | none | none | - | no | no | none | re-render | WORKS |
| Row click (any cell) | 1) CLI table (:51) | row | always | none -> Shell.Open("CLI", id) | none | - | no | no | none | navigates to CLI, ClientsScreen.FocusRecord (ClientsScreen.cs:123-128) | WORKS |
| Row double-click | 1) CLI (:49) | row | always | same as row click | none | - | no | no | none | navigates CLI | DUPLICATE (row click :51; ctx "Open client 360" :50) |
| Ctx "Open client 360" | 1) CLI row menu (:50) | row | always | Shell.Open CLI | none | - | no | no | none | navigates | DUPLICATE (row click :51) |
| Ctx "Live exposure" | 1) CLI row menu (:50) | row | always | Shell.Open("EXP", accountNumber) | none | - | no | no | none | EXP filters by account (LiveExposureScreen.cs:109-113) | PARTIAL (account with no open position: pending focus never matches, lands unfiltered with no message) |
| Ctx "Deposits · withdrawals" | 1) CLI row menu (:50) | row | always | Shell.Open("DEP", accountNumber) | none | - | no | no | none | DEP search set (FundsScreen.cs:91-95) | PARTIAL (no funds row for account: lands unfiltered) |
| Ctx "Wallet" | 1) CLI row menu (:50) | row | always | Shell.Open("WAL", id) | none | - | no | no | none | WAL search set (WalletsLeadsScreens.cs:57) | WORKS |
| Ctx "Live exposure · this symbol" | 2) EXP row menu (:55) | row | always | Shell.Open("EXP", symbol) | none | - | no | no | none | EXP FocusRecord only matches position id / account (LiveExposureScreen.cs:111) | PARTIAL (symbol never matches; EXP opens unfiltered) |
| Ctx "Symbol settings" | 2) EXP row menu (:55) | row | always | Shell.Open("SYM", symbol) | none | - | no | no | none | SYM row selected by name (SymbolsScreen.cs:71) | WORKS |
| Row click | 3) APPR table (:61) | row | always | Shell.Open("DEP", txId) | none | - | no | no | none | DEP search set to account | WORKS |
| Row double-click | 3) APPR (:59) | row | always | same | none | - | no | no | none | navigates | DUPLICATE (row click :61) |
| Ctx "Open in Deposits · withdrawals (approve / reject)" | 3) APPR row menu (:60) | row | always | Shell.Open DEP | none | - | no | no | none | navigates | DUPLICATE (row click :61) |
| Ctx "Open client 360" | 3) APPR row menu (:60) | row | row has source | Shell.Open("CLI", accountNumber) | none | - | no | no | none | CLI by number (ClientsScreen.cs:126) | WORKS |
| Column header click | all 3 tables (DataTable.cs:299) | always | always | none | none | - | no | no | none | sort asc, again desc | WORKS |
| Column header right-click | all 3 tables (DataTable.cs:89,303-319) | always | always | none | none | - | no | no | none | column picker; widths/visibility persisted | WORKS |

## D. Dialogs
None. The screen opens no form or confirm.

## E. Text
- Tile label "B-BOOK P/L · FLOATING" note "REALIZED TODAY" is computed over every book, demo and VOIDED deals (DashboardScreen.cs:131; deals/route.ts status in CLOSED,VOIDED) — label says B-book.
- "NEW CLIENTS · 7D" counts demo accounts (dashboard/route.ts:39) while RPT "NEW CLIENTS" counts LIVE only (reports/summary/route.ts) — same words, different populations.
- "ACTIVE TRADERS" is LIVE-only (route.ts:54-59) while "OPEN VOLUME" and "B-BOOK P/L" include demo positions (positions/route.ts:56).
- Chip "SUSPENDED" also shows CLOSED accounts (:239).
- ACTIONS column shows "OPEN" on every row but the whole row navigates on a single click (:51,:258).
- "LP fill quality · PENDING · NEEDS LP BRIDGE" (:178) static text.
- Column header "INTRODUCING BROKER" over a 44 px column whose cells say "IB" (:47,251).

## F. UI structure map
Layout: Ui.PageGrid rows 54 / * / 230 (DashboardScreen.cs:79). Row 0 KPI strip (9 tiles, equal widths). Row 1: "1) CLI" (width *) | "2) EXP" (400). Row 2: "3) APPR" (*) | "4) FLOW" (*) | "5) ACT" (340). No screen title bar; the shell nav shows "Dashboard DASH".
KPI strip order: NET DEPOSITS · 7D | DEPOSITS · 30D | WITHDRAWALS · PENDING | ACTIVE TRADERS | OPEN VOLUME | B-BOOK P/L · FLOATING | MARGIN CALLS | NEW CLIENTS · 7D | DEALER QUEUE.
Panel headers: "1) CLI  CLIENTS" right: "{n} TOTAL". "2) EXP  OPEN BOOK" right: A / B BOOK stat, NET $ EXP stat, status text. "3) APPR  APPROVALS QUEUE" right: dep/wdr stat. "4) FLOW  DEPOSITS VS WITHDRAWALS · 7D" right: legend DEP (green) WDR (red) NET (amber). "5) ACT  ACTIVITY" right: "ALL STAFF" (dim text). No toolbar buttons on this screen.
Filter bar (1) CLI): chips in order ALL (default lit) · LIVE · DEMO · KYC WAIT · SUSPENDED · IB; search box right.
Table 1) CLI columns: ID | CLIENT | COUNTRY | KYC | CATEGORY | GROUP | BALANCE | EQUITY | LOTS | MARGIN % | INTRODUCING BROKER | STATUS | ACTIONS. Sortable all (click header); no default sort (server order accountNumber asc, accounts/route.ts). Single selection, no checkbox column. Click = open CLI; double-click = open CLI; Enter = nothing. Per-row: KYC chip (OK/WAIT/REJ/FLAG), STATUS chip (blank when ACTIVE, SUSP/CLSD), ACTIONS "OPEN" (orange text, not a separate hit target).
Right-click on row: YES. Header "{accountNumber} · {fullName}" (disabled), separator, items: Open client 360 · Live exposure · Deposits · withdrawals · Wallet. No separators between items, no shortcuts, all always enabled.
Table 2) EXP columns: SYMBOL | LONG | SHORT | NET | PROFIT / LOSS | A / B POS. Sortable; default order |net| desc (client). Click: select only. Double-click: none. Right-click on row: YES. Header "{symbol}", separator, Live exposure · this symbol · Symbol settings.
Table 3) APPR columns: TYPE | CLIENT | AMOUNT | NOTE | STATUS | AGE | ACTIONS. Sortable; default oldest first. Click = open DEP; double-click = open DEP. Per-row: TYPE DEP (green)/WDR (amber); STATUS MARKED (blue chip)/WAITING (amber chip); ACTIONS "OPEN". Right-click on row: YES. Header "{amount} · {accountNumber}" (or "withdrawal"), separator, "Open in Deposits · withdrawals (approve / reject)" · "Open client 360" (disabled when row has no source).
Right-click on multi-selection: NO (single selection only). Right-click on empty table area: NO (no TableActions registered). Right-click on column header: YES, all three tables — header "COLUMNS" (disabled), separator, one checkbox item per column (label), separator, "Reset columns".
Empty texts: "no accounts", "no open positions", "no pending deposits or withdrawals", "NO FLOW · 7D", "NO AUDIT ROWS", "NO MARGIN DATA". Loading: page veil "LOADING…". Error: header status text of panel 2 (e.g. "funds: not allowed for this role").
5) ACT rows: time HH:mm · KIND (first word of action, ≤8 chars, toned) · "{action} · {entity} · by {email}". No interaction.

## Issues
[money] DASH · NET DEPOSITS · 7D adds withdrawals instead of subtracting: Transaction.amount is signed (withdrawal negative) and the route negates it again (signed = DEPOSIT ? amount : -amount) · app/api/manage/dashboard/route.ts:95-96; prisma/schema.prisma:1410; app/api/trade/funds-requests/route.ts:111
[money] DASH · FLOW chart withdrawal buckets and WITHDRAWALS · PENDING sum are negative numbers (signed amounts summed raw); a withdrawal-only week shows "NO FLOW · 7D" because the empty test checks Withdrawals > 0 · dashboard/route.ts:65-69,101-102; DashboardScreen.cs:190
[money] DASH · "B-BOOK P/L · FLOATING" includes demo-account positions; "REALIZED TODAY" sums every book (incl. A-book coverage), demo and VOIDED deals, limited to the latest 500 deals · DashboardScreen.cs:129-131; app/api/manage/positions/route.ts:56; app/api/manage/deals/route.ts:56,71
[functional] DASH · "Live exposure · this symbol" passes a symbol name to EXP, whose FocusRecord only matches position id / account, so EXP opens unfiltered · DashboardScreen.cs:55; LiveExposureScreen.cs:109-113
[functional] DASH · live-account-requests / risk / dealing-queue read failures (e.g. MANAGER without KYC_REVIEW or RISK_SETTINGS) are silent: tiles show 0 ACCOUNT REQUESTS / no exposure limit / blank DEALER QUEUE · DashboardScreen.cs:94-99
[functional] DASH · APPR queue shows "no pending deposits or withdrawals" when the funds read is forbidden (MANAGER without FUNDS_APPROVAL); only the header status says why · DashboardScreen.cs:98,183; funds-requests/route.ts:13
[ux] DASH · single click anywhere on a client or APPR row navigates away (no select-only click); row click, double-click and context item all duplicate the same navigation · DashboardScreen.cs:49-51,59-61
[ux] DASH · ACT panel renders up to 40 rows but the server returns 15 · DashboardScreen.cs:196; dashboard/route.ts:73
[text] DASH · NEW CLIENTS · 7D includes demo accounts while ACTIVE TRADERS is live-only and RPT NEW CLIENTS is live-only · dashboard/route.ts:39,54; reports/summary/route.ts
[text] DASH · chip "SUSPENDED" also lists CLOSED accounts · DashboardScreen.cs:239

## Status counts
STATUS-COUNTS app=backoffice screen=DASH WORKS=8 PARTIAL=4 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=4


<!-- ===== bo-RPT.md ===== -->

# bo-RPT — Reports (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\IbReportsScreens.cs:126-200 (class ReportsScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Six server CSV reports shown as a table, 4 summary KPI tiles, client-side date-range filter, SAVE CSV. Read-only.
Panels: KPI strip (4 tiles, row 0, 54 px) and "1) RPT · REPORTS" (row 1) with filter bar and table host (IbReportsScreens.cs:138-148).

## B. Data
Refresh: no live topics, no poll. On nav (only if last refresh >10 s, Screen.cs:70-76) and on every kind-chip click (ForceRefreshAsync, IbReportsScreens.cs:189). Each refresh fetches summary + the selected report in parallel (:150-157).
| Read | ApiClient | Route | Role gate | Server scope |
|---|---|---|---|---|
| GET /api/manage/reports/summary | FetchReportSummaryAsync ApiClient.ManageG3.cs:63 | app/api/manage/reports/summary/route.ts:11 | MANAGER, BROKER_ADMIN (:13) | 30 d, LIVE only: volume of positions OPENED (:30), commission of CLOSED (:34), deposits − abs(withdrawals) COMPLETED (:38-48), new LIVE accounts (:45) |
| GET /api/manage/reports/trading | FetchReportAsync("trading") ManageG3.cs:70 (bytes via GetBytesAsync, parsed CSV :74-78) | reports/trading/route.ts:8 | MANAGER, BROKER_ADMIN | CLOSED positions 30 d, LIVE (:18), no row limit |
| GET /api/manage/reports/financial | same | reports/financial/route.ts:8 | MANAGER, BROKER_ADMIN | every transaction 30 d, LIVE (:18), amount signed |
| GET /api/manage/reports/client | same | reports/client/route.ts:6 | MANAGER, BROKER_ADMIN | every account incl. DEMO (:14) |
| GET /api/manage/reports/ib | same | reports/ib/route.ts:7 | MANAGER, BROKER_ADMIN (:9) | every IB relationship + computed pending commission |
| GET /api/manage/reports/lp | same | reports/lp/route.ts:11 | BROKER_ADMIN only (:13) | liquidity-provider records |
| GET /api/manage/reports/risk | same | reports/risk/route.ts:10 | MANAGER, BROKER_ADMIN | margin snapshot per account |
Columns are the CSV header, upper-cased, "_" -> " " (IbReportsScreens.cs:166). Right-aligned when the first 20 rows parse as numbers. Cell rendering strips the server's leading-apostrophe formula guard from numbers and reformats ISO timestamps to "dd MMM HH:mm:ss" (:180-188).
Filters: kind chip (server); RANGE from/to (client-side: first column whose values parse as a timestamp decides; rows outside hidden, :169-172). No pagination (server returns everything).
Empty/loading/error: before first load "PICK A REPORT" (:148); empty report "the report has no rows" (:167); errors in header status "summary: …" / "{kind}: …" (:155-156), previous table left in place. Header stat "{KIND} · {n} ROWS" or "{n} OF {total} ROWS" when filtered (:175).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Kind chips TRADING · FINANCIAL · CLIENT · IB · LP · RISK | filter bar left (:135,189) | always | always | FetchReportSummaryAsync + FetchReportAsync(kind) -> GET reports/summary + reports/{kind} | none (read) | - | no | no | server: LP = BROKER_ADMIN only | table rebuilt; chip lit | WORKS |
| RANGE "from" / "to" calendar pickers | filter bar after "·" (:134,141,146) | always | always | none | none | future days not pickable (Ui.cs:264) | no | no | none | table re-filtered client-side | PARTIAL (filter uses only the first timestamp column; not applied to SAVE CSV) |
| Range chips 1D · 1W · 30D | filter bar after pickers (:144) | always | always | none | none | - | no | no | none | sets FROM = today−N, clears TO, re-filter | PARTIAL (chip never shows as lit — created with on=false; no chip to clear the range) |
| SAVE CSV (primary, orange) | panel header right (:140,190-198) | always | always | none (local file via OS save picker) | none | toast "no report loaded" when nothing loaded | no | no | none | toast "{kind} report saved · {n} rows" | PARTIAL (writes the full server CSV, not the range-filtered rows; toast counts unfiltered rows) |
| Column header click | report table (DataTable.cs:299) | always | always | none | none | - | no | no | none | sort | WORKS |
| Column header right-click | report table (DataTable.cs:89) | always | always | none | none | - | no | no | none | column picker, persisted under "report-{kind}" | WORKS |

## D. Dialogs
None (the OS save-file picker only: suggested name "{kind}-report-{yyyyMMdd}.csv", filter "*.csv", :194).

## E. Text
- KPI notes: "LOTS · 30D", "USD", "USD", "ACCOUNTS" (:160-161). All four figures are 30-day, LIVE-only (summary/route.ts:30-45); only the first note says 30D.
- "TRADING VOLUME" = volume of positions OPENED in the window, any status (summary/route.ts:30); the TRADING report lists positions CLOSED in the window (trading/route.ts:18). Same word "trading", different populations.
- Class doc comment says "No date range: the server's endpoints take none" (:128) while the UI shows a RANGE filter (:141).
- Chip "LP" shows the liquidity-provider contact list (reports/lp/route.ts), not LP trading activity.
- CLIENT report includes demo accounts (client/route.ts:14); the other reports are LIVE-only.

## F. UI structure map
Layout: PageGrid rows 54 / *. Row 0: 4 KPI tiles — TRADING VOLUME | COMMISSION REVENUE | NET DEPOSITS | NEW CLIENTS. Row 1: panel "1) RPT  REPORTS"; header right items in order: row-count stat, status text, SAVE CSV (primary/orange).
Filter bar (left to right): chips TRADING (default lit) · FINANCIAL · CLIENT · IB · LP · RISK, then "·", then "RANGE", from picker ("from"), to picker ("to"), chips 1D · 1W · 30D (none lit, ever).
Table: one DataTable per loaded report (rebuilt each load, :167). Columns = CSV headers in server order:
- TRADING: CLOSED AT | ACCOUNT | SYMBOL | SIDE | VOLUME | OPEN PRICE | CLOSE PRICE | COMMISSION | SWAP | REALIZED P&L
- FINANCIAL: DATE | TYPE | STATUS | ACCOUNT | AMOUNT | NOTE
- CLIENT: ACCOUNT | FULL NAME | EMAIL | MODE | CURRENCY | BALANCE | GROUP | STATUS | CREATED AT
- IB: IB ACCOUNT | CLIENT ACCOUNT | COMMISSION TYPE | COMMISSION RATE | PENDING COMMISSION | LAST PAYOUT AT
- LP: NAME | STATUS | PROTOCOL | CONTACT NAME | CONTACT EMAIL | CONTACT PHONE | ROUTING RULES | ADDED AT
- RISK: ACCOUNT | OPEN POSITIONS | EXPOSURE (LOTS) | FLOATING P&L | MARGIN LEVEL % | MARGIN CALL THRESHOLD % | STOP-OUT THRESHOLD %
Sortable: all columns; default sort: none (server order: trading closedAt desc, financial createdAt desc, client accountNumber asc, ib createdAt desc). Selection: single; no checkbox column. Row click: select only. Double-click: nothing. Enter: nothing. No per-row buttons.
Right-click on row: NO (no RowContextRequested handler). Multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS" header, separator, checkbox per column, separator, "Reset columns".
Empty/loading/error: "PICK A REPORT"; "the report has no rows"; page veil "LOADING…" on nav; error text in header status.

## Issues
[functional] RPT · SAVE CSV writes the full server CSV even while the RANGE filter hides rows; toast reports the unfiltered count · IbReportsScreens.cs:196-197
[functional] RPT · IB report (pending commission per IB) is readable by any MANAGER, while the IB screen's endpoint requires IB_PAYOUTS · app/api/manage/reports/ib/route.ts:9; app/api/manage/ib-relationships/route.ts:14
[functional] RPT · LP chip returns 403 for MANAGER (BROKER_ADMIN only); the chip is shown to every role · reports/lp/route.ts:13; IbReportsScreens.cs:135
[ux] RPT · range chips 1D/1W/30D never show which one is active and there is no clear-range control · IbReportsScreens.cs:144
[text] RPT · KPI notes omit the 30-day / LIVE-only window on 3 of 4 tiles · IbReportsScreens.cs:160-161; reports/summary/route.ts:30-45
[text] RPT · TRADING VOLUME counts positions opened in the window while the TRADING report lists positions closed in the window · reports/summary/route.ts:30; reports/trading/route.ts:18
[text] RPT · CLIENT report includes DEMO accounts; every other report is LIVE-only · reports/client/route.ts:14

## Status counts
STATUS-COUNTS app=backoffice screen=RPT WORKS=3 PARTIAL=3 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0


<!-- ===== bo-NTF.md ===== -->

# bo-NTF — Notifications (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\NotificationsAuditScreens.cs:18-166 (class NotificationsScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Broker-wide notification inbox (shared read state across all staff): list, detail, mark read / mark all read, deep link to the owning record, trader password reset for PASSWORD_RESET_REQUESTED.
Panels: "1) NTF · NOTIFICATIONS" (left, *) and "2) DETAIL · NOTIFICATION" (right, 380 px) (NotificationsAuditScreens.cs:42-44).

## B. Data
GET /api/manage/notifications — FetchNotificationsAsync ApiClient.ManageG4.cs:65 -> app/api/manage/notifications/route.ts:14. Gate MANAGER, BROKER_ADMIN (route.ts:6-12). Filter: brokerId only (route.ts:21) — no accountId filter, so trader-scoped rows (engine PRICE_ALERT_TRIGGERED with accountId, engine/market-data/src/db.rs:450-451; trader copy of MARGIN_CALL, lib/post-close.ts:159, lib/risk-monitor.ts:317) are listed and counted. Order createdAt desc, take 100 (route.ts:22-23). No pagination.
Refresh: live topic "dealing" (:26) -> refetch; poll every 20 s while active (:27; MainWindow.axaml.cs:182-187); on nav (>10 s). Nav badge NTF and bell count = shell-info unreadNotifications (count readAt null for the broker, shell-info/route.ts:24; MainWindow.axaml.cs:206-211), refreshed every 60 s and ≤1/5 s on events.
Filters: chips ALL / UNREAD; search over title/body/type (client-side, :66). Default selection = newest row (:55).
Empty/error: "no notifications yet" / "nothing matches the current filters" (:72); detail "SELECT A NOTIFICATION"; "NO LINKED SCREEN" + "entity type {X} has no screen yet" or "this notification carries no record" (:93); errors in header status.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| MARK ALL READ | panel 1 header (:42,132-141) | always | always (toast "nothing unread" when 0) | MarkAllNotificationsReadAsync ManageG4.cs:70 -> PATCH /api/manage/notifications {markAllRead:true} | Notification.readAt = now for every unread row of the broker, for all staff (route.ts:52-55). No audit | server 400 unless markAllRead true | yes ("MARK ALL") | no | MANAGER, BROKER_ADMIN | toast "{n} marked read", refetch, badges | WORKS |
| Chips ALL · UNREAD | filter bar (:57-61) | always | always | none | none | - | no | no | none | list filtered | WORKS |
| Search "title · body · type" | filter bar right (:30,40,66) | always | always | none | none | - | no | no | none | list filtered | WORKS |
| Row click | list (:37) | row | always | none | none | - | no | no | none | detail shows row | WORKS |
| OPEN {CODE} / REVIEW KYC (primary) | detail buttons (:89,117-122) | a target screen exists for the type/entity (:96-116) | always | MarkNotificationReadAsync (quiet) if unread, then Shell.Open(code, entityId) | readAt set (see MARK READ) | - | no | no | MANAGER, BROKER_ADMIN | navigates to the owning screen | PARTIAL (see gaps below) |
| Row double-click | list (:38) | row | target exists | same as OPEN | same | - | no | no | same | same | DUPLICATE (detail OPEN :89) |
| Ctx "Open the record" | row menu (:161) | row | target exists | same | same | - | no | no | same | same | DUPLICATE (detail OPEN :89) |
| MARK READ | detail buttons (:90,124-131) | notification unread | always | MarkNotificationReadAsync ManageG4.cs:67 -> PATCH /api/manage/notifications/{id} {read:true} | Notification.readAt = now (notifications/[id]/route.ts:22), shared for all staff. No audit | server: same broker (404), read must be true (400) | no | no | MANAGER, BROKER_ADMIN | row updated locally, toast "marked read", badges | WORKS |
| Ctx "Mark read" | row menu (:162) | row | unread | same | same | same | no | no | same | same | DUPLICATE (detail MARK READ :90) |
| RESET PASSWORD (danger) | detail buttons (:91,142-155) | type PASSWORD_RESET_REQUESTED and entityId set | always | ResetTraderPasswordAsync ApiClient.ManageG1.cs:199 -> POST /api/manage/accounts/{id}/reset-password | Account.passwordHash replaced + AuditLog ACCOUNT_PASSWORD_RESET (reset-password/route.ts:41-56); every trader session revoked (:57); if the account has an e-mail and broker e-mail is configured the password is e-mailed and NOT returned ({emailed:true,to}, :65-86); otherwise returned once ({password}) (:89,93) | server: account in broker | yes, danger ("RESET") then a second info dialog "NEW PASSWORD · SHOWN ONCE" | no | MANAGER, BROKER_ADMIN (route.ts:12) | toast "{label} · password reset"; notification NOT marked read | PARTIAL (when the server e-mails the password, the dialog shows "Account X: password reset." with no password and no mention of the e-mail, while the confirm text says "It is not e-mailed") |
| Ctx "Reset trader password…" | row menu (:163) | same as button | always | same | same | same | same | no | same | same | DUPLICATE (detail RESET PASSWORD :91) |
| Column header click / right-click | list (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

OPEN gaps (Target map :96-116 vs what the server writes, entityType values in PascalCase):
- MIRROR_KILL_SWITCH (entityType "MirrorRule", lib/mirror.ts:145-150): no case -> "NO LINKED SCREEN · entity type MirrorRule has no screen yet" although MIR exists.
- NEW_LEAD -> CRM and DEALING_ORDER_PENDING / DEALER_ACTIVITY -> DEAL: LeadsScreen and DealingScreen have no FocusRecord override, so the screen opens without the record.
- LIVE_ACCOUNT_REQUESTED -> LAR: LiveAccountRequestsScreen.FocusRecord ignores the id (LiveAccountRequestsScreen.cs:50).
- COVERAGE_STOP_OUT / COVERAGE_RELEASED / COVERAGE_CLOSE_* and OUTBOX_DEAD with a positionId (entityType "Position") -> EXP, which only lists OPEN positions; a closed position is never found (LiveExposureScreen.cs:109-113).
- ADMIN_PASSWORD_RESET_REQUESTED -> USR opens the staff member, where password reset is "not available yet" (TeamScreen.cs:179).
- PRICE_ALERT_TRIGGERED (entityType "PriceAlert"): no screen.
- Works: FUNDS_REQUEST -> DEP (FundsScreen.cs:91), KYC_SUBMITTED / CLIENT_KYC_SUBMITTED -> KYC (KycScreen.cs:75), PASSWORD_RESET_REQUESTED and MARGIN_CALL (Account) -> CLI (ClientsScreen.cs:123).

## D. Dialogs
- MARK ALL READ confirm: text "Mark all {n} unread notifications as read?", button MARK ALL. No fields.
- RESET TRADER PASSWORD confirm (danger): "Generate a new random password for account {label} and show it once? It is not e-mailed — pass it to the trader over a secure channel." button RESET. No fields. Then "NEW PASSWORD · SHOWN ONCE" dialog: "Account {label}\n\nNew password:  {pw}\n\nCopy it now — it cannot be shown again." (or "Account {label}: password reset." when no password returned), button DONE (no-op action, toasts "password handed over").

## E. Text
- Reset confirm says "It is not e-mailed" (:147) but the server e-mails it whenever the account has an e-mail and broker e-mail is configured (reset-password/route.ts:65-86).
- Type column shows the raw server type with "_" -> " " (e.g. "PASSWORD RESET REQUESTED", "OUTBOX DEAD") (:62).
- "NO LINKED SCREEN · entity type MirrorRule has no screen yet" while the MIR screen exists (:93).
- Detail row keys are lower-case ("state", "type", "entity", "created") while table headers are upper-case (:82-85).

## F. UI structure map
Layout: PageGrid columns * / 380. Left "1) NTF  NOTIFICATIONS"; header right in order: stat "{n} UNREAD · {n} TOTAL" (accent when unread), MARK ALL READ (plain), status text. Filter bar: chips ALL (default lit) · UNREAD; search "title · body · type" right.
Table columns: READ | WHEN | TYPE | TITLE | BODY | ENTITY. Sortable all; default order createdAt desc (server). Single selection (default newest); no checkbox. Click = detail; double-click = open record (+mark read); Enter: nothing. Per-row: READ shows "UNREAD" chip (accent) or blank; WHEN relative age ("now", "5m", "3h", "yesterday", "4d ago").
Right-click on row: YES — header = notification title (disabled), separator, "Open the record" (disabled when no target), "Mark read" (disabled when read), "Reset trader password…" (only for PASSWORD_RESET_REQUESTED with an entity). No shortcuts.
Right-click on multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Right "2) DETAIL  NOTIFICATION": title (bold, wraps), body, rows state · type · entity · created, then button row: OPEN {CODE} or REVIEW KYC (primary/orange, when a target exists), MARK READ (when unread), RESET PASSWORD (danger red text, PASSWORD_RESET_REQUESTED only); "NO LINKED SCREEN" block when no target.
Empty: "no notifications yet" / "nothing matches the current filters" / "SELECT A NOTIFICATION". Loading: page veil. Error: header status.

## Issues
[functional] NTF · staff inbox and unread badge include trader-scoped notifications (PRICE_ALERT_TRIGGERED written by the engine with accountId) because the list and count filter by brokerId only · app/api/manage/notifications/route.ts:20-24; app/api/manage/shell-info/route.ts:24; engine/market-data/src/db.rs:450-451
[functional] NTF · every MARGIN_CALL appears twice (a trader copy with accountId and a staff copy are both written, and both are listed) · lib/post-close.ts:159-160; lib/risk-monitor.ts:317-318; notifications/route.ts:21
[functional] NTF · MIRROR_KILL_SWITCH has no deep link ("no screen yet") though MIR exists; NEW_LEAD / DEALING_ORDER_PENDING / DEALER_ACTIVITY / LIVE_ACCOUNT_REQUESTED open their screen without focusing the record; coverage/outbox notices point EXP at closed positions it cannot show · NotificationsAuditScreens.cs:96-116; LiveAccountRequestsScreen.cs:50; LiveExposureScreen.cs:109-113
[functional] NTF · RESET PASSWORD: when the server e-mails the password it returns none; the app then shows "password reset" with no password and no statement that it was e-mailed · NotificationsAuditScreens.cs:151-152; app/api/manage/accounts/[id]/reset-password/route.ts:65-86
[functional] NTF · resetting the password does not mark the PASSWORD_RESET_REQUESTED notification read · NotificationsAuditScreens.cs:145-155
[ux] NTF · mark read / mark all read change shared state for every staff member and write no audit row · app/api/manage/notifications/route.ts:52-55; notifications/[id]/route.ts:22
[text] NTF · reset confirm says the password "is not e-mailed", contradicting the server · NotificationsAuditScreens.cs:147

## Status counts
STATUS-COUNTS app=backoffice screen=NTF WORKS=7 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=4


<!-- ===== bo-EXP.md ===== -->

# bo-EXP — Live exposure (backoffice 1.0.22)

Source: `E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiveExposureScreen.cs` (261 lines). Common DataTable behaviour: header left-click sorts/toggles (DataTable.cs:160-163, 299); no default sort key; single select, no checkbox; header right-click = COLUMNS picker + "Reset columns" (DataTable.cs:303-319); no row Enter handler.

## A. Purpose + panels
Purpose: broker-wide open book: exposure per symbol, broker risk-limit strip, every open position with dealer actions (modify SL/TP, close, partial close, close-by, reverse, close by symbol), and the broker-wide activity feed.
Panels (LiveExposureScreen.cs:56-63): top = `1) EXP EXPOSURE BY SYMBOL` (full width) over `2) LIM RISK LIMITS` (50 px strip); bottom = `3) POS OPEN POSITIONS · DEALER VIEW` (left, *) + `4) FEED LIVE ACTIVITY · BROKER-WIDE` (right, 360 px). Row heights 300 | *.

## B. Data
One refresh fetches five endpoints in parallel (LiveExposureScreen.cs:69-70). Refresh: live events "order","position","dealing" + poll every 30 s while active (:25-26); ticks reprice NOW/P/L client-side ≤1/s via LiveMath.Reprice (:80-86). If positions fail → header status "positions: <error>" and nothing re-renders (:72); failures of the other four are silently replaced by empty lists / null (:73).
| Panel | Endpoint | ApiClient | Route handler | Filters/sort | Limits | Empty/error |
|---|---|---|---|---|---|---|
| 1) EXP | GET /api/manage/positions (+ GET groups for chips, GET symbols for MAXIMUM EXPOSURE) | FetchManagePositionsAsync ApiClient.ManageG1.cs:224-232; FetchGroupsAsync ApiClient.ManageG2.cs:118; FetchBrokerSymbolsAsync ApiClient.ManageG2.cs:140 | positions/route.ts:47-164 (MANAGER/BROKER_ADMIN; every OPEN position of the broker, no group-category filter, :55-56); groups/route.ts:18-22; symbols/route.ts:40-45 | BOOK chips ALL/A-BOOK/B-BOOK, GROUP chips ALL + every group name (:116-122); grouped by symbol, ordered by |NET| desc (:147) | none | "no open positions" (:42) |
| 2) LIM | GET /api/manage/risk | FetchRiskSettingsAsync ApiClient.ManageG2.cs:162-165 | risk/route.ts GET (:15 requires RISK_SETTINGS or EMERGENCY_CONTROLS) | — | — | "RISK SETTINGS UNAVAILABLE" when the call fails (e.g. 403 for a MANAGER without those permissions) (:93) |
| 3) POS | same positions payload | as above | as above | BOOK + GROUP + SYMBOL chips + search "account · client" (:119, 123-130, 154-155) | none | "no open positions match" (:49) |
| 4) FEED | GET /api/manage/live-activity | FetchLiveActivityAsync ApiClient.ManageG2.cs:203-210 | live-activity/route.ts:12-19 → lib/dealer-activity.ts getDealerActivityFeedRows (default limit 50, :242) | newest first | client shows ≤60 (:105) | "NO ACTIVITY" (:104) |

Included rows: the positions payload contains the broker's own COVERAGE hedge legs (BOOK NOW creates a Position on the coverage account, positions/[id]/book/route.ts:93); nothing on this screen separates them from client positions, so they count in POSITIONS, LOTS, NET, NOTIONAL, CLIENT PROFIT / LOSS and TOTAL EXPOSURE.
Equity: this screen shows no equity figure. "—" appears in PRICE / PROFIT / LOSS when the server had no LivePrice tick in the last 15 s (currentPrice/floatingPnl null, positions/route.ts:101-110, 150-151; lib/live-price.ts:122-137) and no tick arrived since; in S/L, T/P when unset; MAXIMUM EXPOSURE "—" when the symbol has no maxExposure (:146).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| BOOK chips ALL / A-BOOK / B-BOOK | EXP filter bar (:56, 121) | always | always | none | — | — | no | no | none | re-render EXP + POS | WORKS |
| GROUP chips ALL + group names | EXP filter bar (:120) | always | always | none | — | — | no | no | none | re-render EXP + POS | WORKS |
| SYMBOL chips ALL + symbols with positions | POS filter bar (:60, 119) | always | always | none | — | — | no | no | none | re-render POS | WORKS |
| Search "account · client" | POS filter bar (:33, 60) | always | always | none | — | — | no | no | none | re-render POS | WORKS |
| EXP row click | by-symbol table (:43) | row | always | none (toggles SYMBOL filter) | — | — | no | no | none | POS filtered | WORKS |
| EXP row menu "Filter positions to this symbol" | by-symbol row right-click (:44) | always | always | none | — | — | no | no | none | POS filtered | DUPLICATE (EXP row click :43) |
| EXP row menu "Close every position on this symbol…" | (:45) | always | always | = CLOSE BY SYMBOL | | | | | | | DUPLICATE (CLOSE BY SYMBOL :59) — and DEAD, see next row |
| CLOSE BY SYMBOL (red/danger) | POS header right (:59) | always | always | CloseBulkAsync POST /api/manage/positions/close-bulk {scope ALL\|SYMBOL, symbol, accountId:null} (ApiClient.ManageG6.cs:138-139; call :254) | none: handler requires accountId and returns 400 "accountId is required" (close-bulk/route.ts:28-31) | client: ≥1 row in filter (:250) | yes "CLOSE ALL POSITIONS"/"CLOSE BY SYMBOL" (danger) (:252) | no | MANAGER/BROKER_ADMIN | error toast | DEAD (route exists but can never succeed for this body; also ignores the GROUP/BOOK/search filters the confirm text counts, :249-254) |
| EXP row menu "Symbol settings" | (:45) | always | always | Shell.Open("SYM", symbolName) | — | — | no | no | none | SYM screen | WORKS |
| EDIT ON RISK | LIM header right (:57) | always | always | Shell.Navigate("RISK") | — | — | no | no | none | RISK screen | WORKS |
| POS row double-click → Modify | positions table (:51) | row | always | = Modify SL / TP… | | | | | | | DUPLICATE (menu "Modify SL / TP…" :174) |
| Menu "Modify SL / TP…" | POS row right-click (:174) | always | always | AdminModifyPositionAsync PATCH /api/manage/positions/{id} {slPrice?, tpPrice?, reason} (ApiClient.ManageG2.cs:189-195) | Position.slPrice/tpPrice; AuditLog POSITION_SLTP_MODIFIED with reason (positions/[id]/route.ts:88-113). No NATS event, no dealer-activity row, no notification (imports :1-6) | client ParseModify: ≥1 level, numeric, "reason:" required (:200-216); server: reason required, numeric, live price present, validateSlTp vs live price (route.ts:42-85) | input dialog "MODIFY POSITION" (APPLY) | no | MANAGER/BROKER_ADMIN | toast + refetch | PARTIAL (no PositionModified publish → open terminals not told; engine pick-up of the new SL/TP without an event UNVERIFIED) |
| Menu "Close at market…" | (:175) | always | always | AdminClosePositionAsync POST positions/{id}/close {} (ApiClient.ManageG2.cs:197-198) | executeAdminCloseInTx → closePositionInTx: Position closed (guarded updateMany), TRADE_PNL Transaction, Account.balance, NBP write-off if broker.negativeBalanceProtection, Position.closedByAdminId, AuditLog MANUAL_POSITION_CLOSE (close/route.ts:105-110; lib/position-actions.ts:91-106; lib/position-close.ts:38-105); mirror.onClose; coverage.onClose; cancelPendingClose; NATS PositionClosed; recordDealerActivity (NATS DealerActivity + notification for dealing-group accounts) (close/route.ts:120-155; lib/dealer-activity.ts:96-113). No BalanceChanged publish | server: OPEN, trading session open, live price (close/route.ts:52-99) | yes "CLOSE POSITION" (danger) (:218) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Close part…" | (:176) | always | always | AdminClosePositionAsync {volume "0.00"} | same, partial (close/route.ts:79-94) | client 0 < lots ≤ volume (:231); server same range only — no lot-step/min-lot check (close/route.ts:86) | input dialog "CLOSE PART" (danger) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Close by" (submenu of opposite positions) | (:177-181) | always; header "Close by… (no opposite <SYM> position)" when none | enabled when same-account opposite-side same-symbol positions exist (CloseBy.cs:22-24) | AdminCloseByAsync POST /api/manage/positions/close-by {positionId, againstPositionId} (ApiClient.ManageG2.cs:201-202) | both legs closed at one mid price in one transaction via executeAdminCloseInTx (TRADE_PNL, audit ×2); mirror.onClose + coverage.onClose per leg; recordDealerActivity ×2; NATS PositionsClosed (close-by/route.ts:36-108) | server: same account, resolveCloseByPair (:44-50) | yes "CLOSE BY" (danger) (:225) | no | MANAGER/BROKER_ADMIN | toast + refetch | WORKS |
| Menu "Reverse…" | (:182) | always | always | ReversePositionAsync POST positions/{id}/reverse {mode IN_PLACE\|CLOSE_REOPEN} (ApiClient.ManageG6.cs:152-156) | MANAGER: PositionActionRequest PENDING (202) (reverse/route.ts:44-50). BROKER_ADMIN: IN_PLACE → executeReverseInPlace, AuditLog POSITION_REVERSED_IN_PLACE, NATS PositionModified, no mirror/coverage hook (reverse/route.ts:68-77; lib/position-actions.ts:171-177); CLOSE_REOPEN → close + new position, mirror.onClose, coverage.onClose, mirror.onFillPosition, NATS PositionClosed + OrderFilled (reverse/route.ts:83-93) | none | form "REVERSE POSITION" (danger) | YES for MANAGER (lib/position-actions.ts:22-24) | MANAGER/BROKER_ADMIN | toast "…filed for a second admin's approval" or "reversed"; badges refresh (:241) | PARTIAL (IN_PLACE on a covered position calls no coverage hook: the hedge leg stays on the old side — reverse/route.ts:68-77; no reason field, request stored with reason null :47) |
| Menu "Open client <acc>" | (:184) | always | always | Shell.Open("CLI", accountNumber) | — | — | no | no | none | Client 360 | WORKS |
| Column picker (positions) | POS header right-click | always | always | none; persisted "exp-positions" (:52-53) | — | — | no | no | none | — | WORKS |

## D. Dialogs
- MODIFY POSITION (ConfirmWithInput, :191-198): detail "<SYM> <SIDE> <lots> of <acc> · now SL <x> TP <y>. Type the new levels, e.g. "sl 4490 tp 4430" ("sl -" clears), then the reason after "reason:"."; single free-text input "LEVELS · REASON" (required). Parsed to slPrice/tpPrice ("" → null = clear) → Position.slPrice / Position.tpPrice; reason → AuditLog.newValue.reason. READ BY: SL/TP trigger check (engine trigger path — exact reader UNVERIFIED), trader terminal on next fetch.
- CLOSE POSITION confirm: "Close <vol> of <SYM> <SIDE> <lots> for <acc> at market?" CLOSE.
- CLOSE PART (ConfirmWithInput): "<SYM> <SIDE> <lots> of <acc>: lots to close (0 < lots ≤ <lots>)", input "LOTS" required → request volume.
- CLOSE BY confirm: "Close <SYM> <SIDE> <lots> by <SIDE> <lots> for <acc>? <n> lots close on both at one price (mid). <rest text>" CLOSE BY.
- REVERSE POSITION form: "How" choice FLIP IN PLACE (IN_PLACE, default) / CLOSE + REOPEN OPPOSITE (CLOSE_REOPEN); detail "<SYM> <SIDE> <lots> of <acc> at <price|market>" → request mode; stored in PositionActionRequest.actionType (MANAGER) or applied.
- CLOSE ALL POSITIONS / CLOSE BY SYMBOL confirm: "Close all <n> shown positions (<every symbol|SYM>) at market?" CLOSE ALL.

## E. Text
- Column "CLIENT PROFIT / LOSS" and header stat "CLIENT P/L" (:41, 150) include the broker's coverage hedge legs (see B).
- "MAXIMUM EXPOSURE" column shows "|net lots| / maxExposure" per symbol broker-wide (:138, 146); BrokerSymbol.maxExposure is "Max total open volume (lots) an ACCOUNT may hold in this symbol", gross, per account (lib/risk.ts:307-326).
- LIM "TOTAL EXPOSURE" shows notional money "$x / $limit (y%)" (:96-98); Broker.totalExposureLimit is a lot count ("sum of open volume", "limit of N lots", lib/risk.ts:330-345).
- "DEALING MODE … ON · manual review / OFF · auto-fill" (:100) — broker-level flag only; per-group dealing modes are not reflected.
- Class comment says "Hedged / LP columns have no endpoint and are not drawn" (:20-21) — positions payload does carry `covered` / coveragePositionId (positions/route.ts:131-137) but the screen does not show them.
- Confirm "Close all N shown positions" (:252) — the request does not carry the shown filters.
- ACTIONS column text "MODIFY · CLOSE" (:163) is a label, not clickable.

## F. UI structure map
- Layout: top block 300 px = EXP panel (fills) above LIM strip (50 px); bottom block = POS (left, *) + FEED (right, 360 px) (:58-63). No KPI strip.
- **1) EXP "EXPOSURE BY SYMBOL"**; header right: stat "<n> POSITIONS · <lots> LOTS · CLIENT P/L ±x" (green/red), status text. Filter bar: label "BOOK", chips ALL · A-BOOK · B-BOOK (default ALL); "·"; label "GROUP", chips ALL + group names alphabetical (default ALL).
  - Table "exp-symbols": SYMBOL · POSITIONS · BUY VOLUME · SELL VOLUME · NET · NOTIONAL · A / B POS · AVERAGE OPEN · CLIENT PROFIT / LOSS · PRICE · MAXIMUM EXPOSURE (:40-42). Sortable all; default order |NET| desc (:147). Selection single.
  - Row click → toggles SYMBOL filter on POS; double-click nothing; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<SYMBOL>" (disabled) / separator / Filter positions to this symbol / Close every position on this symbol… / separator / Symbol settings (all enabled) (:44-45).
  - Right-click empty area: NO. Header: YES (COLUMNS picker; not persisted for this table). Empty "no open positions".
- **2) LIM "RISK LIMITS"**; header right button "EDIT ON RISK" (plain). Body: stats TOTAL EXPOSURE · MAX POSITIONS / ACCOUNT · DEALING MODE · TRADING (OPEN / CLOSE-ONLY / HALTED), or "RISK SETTINGS UNAVAILABLE".
- **3) POS "OPEN POSITIONS · DEALER VIEW"**; header right: stat "<shown> SHOWN OF <total>", button "CLOSE BY SYMBOL" (danger/red). No primary/orange button. Filter bar: label "SYMBOL", chips ALL + symbols (default ALL); search "account · client".
  - Table "exp-positions": TICKET · ACCOUNT · CLIENT · GROUP · SYMBOL · SIDE · LOTS · OPEN · PRICE · S/L · T/P · PROFIT / LOSS · BOOK · OPENED · ACTIONS (:47-49). Sortable all; default server order openedAt desc (positions/route.ts:71). Single select. BOOK = "A"/"B" chip.
  - Row click: select; double-click → MODIFY POSITION dialog; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<SYM> <SIDE> <lots> · <acc>" (disabled) / separator / Modify SL / TP… / Close at market… / Close part… / Close by (submenu: "<#ticket> <SIDE> <lots> @ <price>" per candidate; when none the item reads "Close by… (no opposite <SYM> position)" and is disabled) / Reverse… / separator / Open client <acc> (:168-186).
  - Right-click empty area: NO. Header: YES (COLUMNS picker, persisted). Empty "no open positions match".
- **4) FEED "LIVE ACTIVITY · BROKER-WIDE"**: log rows "HH:mm  <ACTION (≤8 chars)>  <acc> <side> <vol> <sym> <values>"; tone red for REJECT/STOP, green FILL/ACCEPT, amber REQUOTE/MODIF (:105-108). Not clickable, no right-click. Empty "NO ACTIVITY".
- Loading: "loading…" status + LOADING… veil on nav; error: header status.

## Issues
[money] EXP · CLOSE BY SYMBOL / "Close every position on this symbol…" always fail: close-bulk requires accountId and the screen sends null · LiveExposureScreen.cs:254, ApiClient.ManageG6.cs:138-139, close-bulk/route.ts:28-31
[money] EXP · Close-by-symbol request ignores the GROUP/BOOK/search filters that the confirm's "N shown positions" counts (scope ALL/SYMBOL only) · LiveExposureScreen.cs:249-254
[money] EXP · TOTAL EXPOSURE compares a notional USD sum to Broker.totalExposureLimit, which is a lot count · LiveExposureScreen.cs:96-98, lib/risk.ts:330-345
[money] EXP · MAXIMUM EXPOSURE compares broker-wide net lots to BrokerSymbol.maxExposure, a per-account gross lot limit · LiveExposureScreen.cs:138,146, lib/risk.ts:307-326
[money] EXP · Broker COVERAGE hedge legs are counted as client positions in every total (positions, lots, net, notional, CLIENT P/L, total exposure) · positions/route.ts:55-56, positions/[id]/book/route.ts:93
[money] EXP · Reverse IN_PLACE (BROKER_ADMIN) calls no coverage/mirror hook; a covered position's hedge leg is left on the old side · positions/[id]/reverse/route.ts:68-77
[functional] EXP · Modify SL/TP publishes no NATS event (terminals not notified) and records no dealer activity · positions/[id]/route.ts:1-6,88-122
[functional] EXP · Partial close validates only 0<v≤volume; no lot-step / min-lot check on the remainder · close/route.ts:86, LiveExposureScreen.cs:231
[functional] EXP · LIM strip needs RISK_SETTINGS or EMERGENCY_CONTROLS; a MANAGER without them sees "RISK SETTINGS UNAVAILABLE" · risk/route.ts:15, LiveExposureScreen.cs:93
[functional] EXP · Failures of groups/symbols/risk/feed fetches are swallowed (empty lists) with no status text · LiveExposureScreen.cs:73
[ux] EXP · Admin close publishes PositionClosed but no BalanceChanged · close/route.ts:137
[ux] EXP · Reverse dialog has no reason field; MANAGER requests are filed with reason null · LiveExposureScreen.cs:237, reverse/route.ts:47
[ux] EXP · Covered/coverage flags are in the payload but not shown · positions/route.ts:131-137, LiveExposureScreen.cs:47-49
[text] EXP · "CLIENT PROFIT / LOSS" / "CLIENT P/L" include broker hedge legs · LiveExposureScreen.cs:41,150
[text] EXP · "MAXIMUM EXPOSURE" and "TOTAL EXPOSURE" labels do not match the unit/scope of the limits they display · LiveExposureScreen.cs:42,98

## Status counts
STATUS-COUNTS app=backoffice screen=EXP WORKS=12 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=0 DEAD=1 DUPLICATE=3


<!-- ===== bo-DEAL.md ===== -->

# bo-DEAL — Dealing desk (backoffice)

Code: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealingScreen.cs (DS), Services\DealingChart.cs, Services\DealingMarketWatch.cs, shared Vyx.Shared.Ui\MarketWatch\MarketWatchView.axaml(.cs), Vyx.Shared.Ui\Charting\ChartPanel.axaml / CandleChartControl.cs, Controls\DataTable.cs.
API client paths: Vyx.Shared\Api\ApiClient.ManageG1/G2/G4/G6.cs, ApiClient.cs. Routes: D:\VyXTrader-Tauri\vyX\app\api\manage\...
Status convention: a control whose purpose is local view state (chips, filters, watchlist, chart view) is WORKS when it does that; UI-ONLY = implies a server effect but only changes local state.

## A. Purpose + panels
Dealer workstation: dealer queue (accept / requote / reject), coverage account (hedge legs), Smart Dealer Manager (book / unbook, dealer P/L), desk switches (dealer review, auto-hedge, max slippage), dealing chart + market watch, coverage order ticket, per-group panic. DS:23-33.
Panels: 1) MW MARKET WATCH, 2) QUEUE PENDING QUEUE, 3) ACT DEALING ACTIVITY, 4) chart (no panel header), 5) COV COVERAGE ACCOUNT, 6) MODE DEALER MODE, 7) GRP DEALING-GROUP, 8) TICKET ORDER TICKET, 9) PANIC EMERGENCY · DEALING GROUP, 10) SDM SMART DEALER MANAGER, NET strip (bottom). DS:149-206.

## B. Data
Refresh: live topics order / position / dealing + poll every 10 s (DS:36-37); each refresh runs 11 GETs in parallel (DS:209-221). Aborts whole render if the queue GET fails ("dealing-queue: <err>" in header Status, DS:215). Prices repriced client-side at most 1/s from LiveService (DS:240-246).

| Panel | Endpoint | ApiClient | Route handler | Notes |
|---|---|---|---|---|
| QUEUE pending + requoted | GET /api/manage/dealing-queue | ManageG2.cs:213 | dealing-queue/route.ts:24 (MARKET orders status PENDING / REQUOTED) | role MANAGER/BROKER_ADMIN |
| QUEUE resting, ACT feed, MODE "Dealing-group accounts" | GET /api/manage/dealing-desk | ManageG2.cs:247 | dealing-desk/route.ts:16; lib/dealer-activity.ts:238 (feed limit 50), :410 (resting), :449 (accounts) | |
| MODE dealer/auto-hedge state | GET /api/manage/dealing-desk-toggle | ManageG2.cs:237 | dealing-desk-toggle/route.ts:40 (dealerOn = Broker.dealingDeskAutoFillAt == null; autoHedge = Broker.autoHedgeAt != null) | RISK_SETTINGS permission; on 403 both are null |
| ACT audit decisions | GET /api/manage/audit | ManageG4.cs:74 | audit/route.ts:19 (last 200 broker rows) | client keeps rows whose humanized label starts "Dealing" (DS:216) |
| GRP / COV / SDM / NET / chart overlays | GET /api/manage/positions | ManageG1.cs:224 | positions/route.ts:47 (status OPEN; bookType, covered, coveragePositionId at :139-146) | |
| COV account strip | GET /api/manage/margin | ManageG1.cs:223 | margin/route.ts:10 | |
| GRP / panic groups | GET /api/manage/groups | ManageG2.cs:118 | groups/route.ts:19 (groupType legacy mapping :84, tradingHalted :73, closeOnly :75) | |
| MODE smart-dealer %, slippage, coverage acct | GET /api/manage/risk | ManageG2.cs:162 | risk/route.ts:12 (coverageAccountNumber) | RISK_SETTINGS or EMERGENCY_CONTROLS |
| accounts (coverage balance, dealer accounts) | GET /api/manage/accounts | ManageG1.cs:152 | accounts/route.ts:21 | |
| NET realized, SDM closed (unranged) | GET /api/manage/deals | ManageG1.cs:203 | deals/route.ts:15 (CLOSED+VOIDED, deletedAt null, take 500, closedAt desc) | no date range: "last 500 closed trades broker-wide" |
| GRP HISTORY / COV HISTORY / SDM range | GET /api/manage/deals?from&to[&accountId] | ManageG1.cs:206 | deals/route.ts:15 | also capped at 500 rows |
| MW + chart symbols | GET /api/manage/symbols | ManageG2.cs:140 | symbols/route.ts:42 | |
| chart candles, D1 day levels | GET /api/manage/candles?symbol&tf | ApiClient.cs:213 | candles/route.ts:15 | DealingChart.cs:359, :392 |

Empty / loading texts: queue "nothing awaiting · nothing resting" (DS:297); activity "NO DEALING ACTIVITY" (DS:486); GRP trades "No open trades", exposure "No exposure", history "No closed trades in this range" (DS:118-124); COV trades "NO COVERAGE ACCOUNT" / "NONE OPEN" (DS:986), exposure "No coverage account" / "No open coverage legs" (DS:979), history "No closed coverage legs in this range" (DS:129); COV strip "no coverage account: the first BOOK NOW provisions it" (DS:938); SDM sections "NONE" (DS:788-803); MW "no symbols yet" / "watchlist empty — + ADD a symbol" (DealingMarketWatch.cs:71); MW feed state LIVE / RECONNECTING / FEED OFFLINE (DealingMarketWatch.cs:133). No loading text on any panel; history loads show nothing while loading. Fetch errors on history: toast "history: …", "coverage history: …", "dealer p/l: …" (DS:674, 1020, 724).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Row click | MW row | always | always | FetchManageCandlesAsync GET /api/manage/candles | none | – | no | no | MANAGER/BROKER_ADMIN (candles/route.ts:17) | active chart switches symbol, ticket symbol follows (DS:1288-1295) | WORKS |
| Row double-click | MW row | always | always | none | none | – | no | no | – | ticket symbol set, toast "order ticket · X" (DS:173) | WORKS |
| search symbols… | MW top | always | always | none | none | – | no | no | – | filters rows | WORKS |
| + ADD → pick symbol | MW top flyout | always | always | none | local BackofficeSettings.DealingWatchlist (DealingMarketWatch.cs:97-105) | – | no | no | – | row added | WORKS |
| Open chart, X | MW row menu | right-click | always | GET candles | none | – | no | no | – | = row click | WORKS |
| New order, X | MW row menu | right-click | always | none | none | – | no | no | – | ticket symbol set; chart not switched (DS:173) | WORKS |
| Specification, X… | MW row menu | right-click | always | none | none | – | no | no | – | opens SYM screen (DS:174) | WORKS |
| Add symbol… | MW row menu | right-click | always | none | local watchlist | – | no | no | – | opens + ADD flyout | WORKS |
| Remove X from watchlist | MW row menu | right-click | always | none | local watchlist | – | no | no | – | row removed | WORKS |
| Columns ▸ Change % / Spread / Daily High / Low | MW row menu | right-click | always | none | local DealingMwShow* (DealingMarketWatch.cs:115-119) | – | no | no | – | column shown/hidden | WORKS |
| ⚙ (Dealer settings) → SAVE | QUEUE header | always | always | PatchRiskAsync PATCH /api/manage/risk {defaultMaxSlippagePips:null} (DS:458) | local RequoteStepPoints; ALSO sets Broker.defaultMaxSlippagePips = NULL every save (form has no "slip" field, DS:445-455; JsonBody writes null, risk/route.ts:166-172); audit RISK_LIMITS_UPDATED (risk/route.ts:202-213) | client: step positive int (DS:454) / server: RISK_SETTINGS (risk/route.ts:74) | no | no | RISK_SETTINGS | toast "requote step · N pts · default slippage · broker default" | PARTIAL (silently clears the broker slippage cap) |
| ACCEPT ALL (orange/primary) | QUEUE header | always | always (toast "nothing awaiting a dealer" if 0) | DealingActionAsync PATCH /api/manage/dealing-queue/{id} {action:ACCEPT, fillMode:null} × N in parallel (DS:413) | per order as ACCEPT (below) at the REQUESTED price (fillMode null → REQUESTED, dealing-queue/[id]/route.ts:74) | server risk battery per order | yes: "Fill all N orders awaiting a dealer at market?" | no | MANAGER/BROKER_ADMIN | sound, toast "k of N filled", refresh | PARTIAL (confirm says "at market", fills at requested) |
| REJECT ALL (danger) | QUEUE header | always | always | DealingActionAsync {action:REJECT, reason} × N (DS:419) | Order.status REJECTED + rejectionReason; open-close lock cleared on Position.closePendingOrderId; audit DEALING_ORDER_REJECTED / DEALING_CLOSE_REJECTED; NATS OrderRejected (route.ts:104-137) | reason required (client + server route.ts:99-101) | yes + REASON (AUDIT TRAIL) input | no | MANAGER/BROKER_ADMIN | sound, toast "k of N rejected" | WORKS |
| ACCEPT ▾ → Requested · price | QUEUE row (AWAITING DEALER) | pending order | always | DealingActionAsync {ACCEPT, fillMode:REQUESTED} (DS:438) | OPEN: Order ACCEPTED, Position created (openPositionFromOrder) at requested + spread markup, commission per resolveFillPricing; audit DEALING_ORDER_ACCEPTED; mirror.onFillPosition; coverage.onFillAutoHedge (no-op unless auto-fill + auto-hedge); NATS OrderFilled; dealer activity POSITION_OPENED (route.ts:302-387). CLOSE: executeQueuedCloseInTx at requested, audit DEALING_CLOSE_ACCEPTED, afterQueuedCloseExecuted (route.ts:218-267) | server: halt/close-only/session/lot/group/exposure/daily-loss battery (route.ts:271-291); close: halt + session only (route.ts:224) | no (instant) | no | MANAGER/BROKER_ADMIN | sound, toast "X ACC · filled @ requested", refresh | WORKS |
| ACCEPT ▾ → Market · price | QUEUE row | pending order | always | DealingActionAsync {ACCEPT, fillMode:MARKET} (DS:439) | same, base = live at click (route.ts:96, 319; close 228) | same; 409 if no live price | no | no | MANAGER/BROKER_ADMIN | toast "… @ market" | WORKS |
| REQUOTE ▾ → +1 / +2 / +3 | QUEUE row flyout | pending order | always | DealingActionAsync {REQUOTE, price} (DS:441) | Order REQUOTED + requotedPrice; audit DEALING_ORDER_REQUOTED / DEALING_CLOSE_REQUOTED; NATS OrderRequoted (route.ts:151-189); read by trade/orders/[id]/requote-response/route.ts:55,120 | preset = requested (else live ask for BUY / bid for SELL) + N×step toward "BUY higher, SELL lower" (DS:399-407), regardless of IsClose | no | no | MANAGER/BROKER_ADMIN | sound, toast "requoted P" | PARTIAL (on a queued CLOSE of a BUY position the +N offer is ABOVE the requested close = better for the client; live fallback uses ask although a BUY close settles at bid) |
| REQUOTE custom price + Enter | QUEUE row flyout | pending order | always | same | same | client: positive number (DS:380) / server: positive decimal (route.ts:152-160) | no | no | MANAGER/BROKER_ADMIN | same | WORKS |
| REJECT | QUEUE row | pending order | always | DealingActionAsync {REJECT, reason:""} (DS:442) | none: server returns 400 "reason is required for the audit trail" (route.ts:99-101) | server reason required; client sends "" | no | no | MANAGER/BROKER_ADMIN | error toast | DEAD |
| WITHDRAW | QUEUE row (AWAITING CLIENT) | requoted order | always | DealingActionAsync {REJECT, reason:""} (DS:443) | none: same 400 (route.ts:99-101) | same | no | no | MANAGER/BROKER_ADMIN | error toast | DEAD |
| CANCEL | QUEUE row (RESTING) | resting LIMIT/STOP | always | none | none; toast "cancel resting not available" (DS:464); no manage cancel route exists under app/api/manage | – | no | no | – | toast | PLACEHOLDER |
| Open client 360 / Live exposure | QUEUE row right-click | row | always | none | none | – | no | no | – | opens CLI / EXP (DS:338-342) | WORKS |
| Chart toolbar (layout Single/2×2, TF 1M…W, INDICATORS, ⚙ chart menu, EMA/SESSIONS/DRAW, drawing tools) | chart | always | always | GET candles on symbol/TF change | local only (backoffice-studies.json, backoffice-drawings.json, DealingShowEma/OneClickPanel/GridMode settings, DealingChart.cs:163-164, 251) | – | no | no | – | chart redraw | WORKS |
| One-click SELL / BUY | chart one-click widget | chart live | symbol selected | PlaceCoverageOrderAsync POST /api/manage/coverage/orders {type:MARKET} (DS:1216-1225) | Order FILLED + Position A_BOOK on coverage account at live ask/bid, zero commission; ensureCoverageAccount provisions account on first use; audit COVERAGE_ORDER_PLACED; NATS OrderFilled (coverage/orders/route.ts:83-138) | server: min/max lot, live price required (route.ts:57-66); no lot-step / margin / halt check | confirm unless 1-click ON | no | MANAGER/BROKER_ADMIN | sound, full refresh, report "filled @ P · #T" | WORKS |
| 1-click toggle | chart one-click widget | always | always | none | local _chartVm.OneClick (not persisted) (DS:1226) | – | no | no | – | report text | WORKS |
| Buy Limit / Sell Stop / Sell Limit / Buy Stop @ price | chart right-click | full chart, candles loaded | always | none | none; report "only MARKET orders on the coverage account…" (DS:1214) | – | no | no | – | report | PLACEHOLDER |
| Set SL / Set TP @ price | chart right-click | coverage leg on this symbol (max 4) | always | AdminModifyPositionAsync PATCH /api/manage/positions/{id} {sl/tp, reason:"dealer chart"} (DS:1257) | Position.slPrice/tpPrice; audit POSITION_SLTP_MODIFIED (positions/[id]/route.ts:88-114); no NATS publish | client side rule (DS:1250-1252) / server validateSlTp + stopLevel (route.ts:75-85) | yes (MODIFY) | no | MANAGER/BROKER_ADMIN | refresh | WORKS |
| Drag SL / TP handle | chart | coverage leg | always | same (DS:1205) | same | same | yes | no | MANAGER/BROKER_ADMIN | line snaps back on cancel | WORKS |
| Alert above/below price | chart right-click | full chart | always | none | none; "price alerts not available" (DS:1215) | – | no | no | – | report | PLACEHOLDER |
| Double-click leg | chart | coverage leg | always | AdminClosePositionAsync POST /api/manage/positions/{id}/close (DS:1207-1212) | see ✕ close coverage row | – | yes (CLOSE COVERAGE) | no | MANAGER/BROKER_ADMIN | – | WORKS |
| Collapse / Expand one-click panel | chart right-click | full chart | always | none | local DealingOneClickPanel | – | no | no | – | – | WORKS |
| TRADES / EXPOSURE / HISTORY chips | COV header | always | always | HISTORY: FetchDealsAsync GET deals?from&to&accountId (DS:1019) | none | – | no | no | MANAGER/BROKER_ADMIN | view swap | WORKS |
| ✕ (Close coverage position) | COV TRADES row | open coverage leg | always | AdminClosePositionAsync POST /api/manage/positions/{id}/close {} (DS:1134-1136) | executeAdminCloseInTx: Position CLOSED, TRADE_PNL Transaction, balance, closedByAdminId, audit MANUAL_POSITION_CLOSE; mirror.onClose; coverage.onClose (a) releases the client: Position.covered=false, audit POSITION_COVERAGE_RELEASED, notification COVERAGE_RELEASED; cancelPendingClose; NATS PositionClosed; dealer activity POSITION_CLOSED (close/route.ts:104-160; lib/coverage.ts:239-265) | server: session open, live price (close/route.ts:70-99) | yes "Close coverage X? Realizes P&L on the coverage account." | no | MANAGER/BROKER_ADMIN | refresh; history reload flagged | WORKS |
| FROM / TO date pickers + APPLY | COV HISTORY bar | HISTORY tab | always | GET deals?from&to&accountId | none | – | no | no | – | table reload (pick applies at once) | WORKS |
| SWITCH TO AUTO-FILL / SWITCH TO DEALER ON | MODE | always (also when state unknown: label "SWITCH TO DEALER ON", DS:509-514) | always | SetDealerOnAsync PATCH /api/manage/dealing-desk-toggle {dealerOn} (ManageG2.cs:243) | Broker.dealingDeskAutoFillAt (null = dealer on, now() = auto-fill); audit DEALING_DESK_TOGGLED (toggle/route.ts:76-95). To AUTO-FILL: flushDealingQueueToMarket fills every PENDING market order no longer wanting review at live price (+markup): Position, audit DEALING_DESK_AUTO_FLUSHED / _CLOSE with no actorAdminId, mirror.onFillPosition, NATS OrderFilled, dealer activity (toggle/route.ts:102-104, 128-296); flush does NOT call coverage.onFillAutoHedge (route.ts:261 mirror only) | server RISK_SETTINGS (route.ts:59) | yes "Auto-fill every market order at the live price (no dealer review)?" / "Route every market order to the dealer queue for manual review?" | no | RISK_SETTINGS | toast "auto-fill on"/"dealer on"; `flushed` result ignored | PARTIAL (flushed fills never auto-hedged; flush outcome not shown) |
| TURN AUTO-HEDGE ON / OFF | MODE | autoHedge known (shown also while DEALER ON, DS:582-592) | always | SetAutoHedgeAsync PATCH dealing-desk-toggle {autoHedge} (ManageG2.cs:246) | Broker.autoHedgeAt; audit AUTO_HEDGE_TOGGLED (toggle/route.ts:81-91). Read by lib/coverage.ts:435-460 (only when dealingDeskAutoFillAt set, group.groupType DEALING, B_BOOK) at trade/orders/route.ts:424,652, orders/[id]/fill:329, requote-response:230, dealing-queue/[id]:355 | server RISK_SETTINGS | yes | no | RISK_SETTINGS | toast | PARTIAL (desk-toggle flush path and forceDealingMode groups are never hedged although confirm says "every dealing-group fill") |
| EDIT (MAX SLIPPAGE) → SAVE | MODE row | _risk loaded | always | PatchRiskAsync PATCH /api/manage/risk {defaultMaxSlippagePips} (DS:567) | Broker.defaultMaxSlippagePips; audit RISK_LIMITS_UPDATED (risk/route.ts:166-213) | client: ≥0 or blank (DS:565) / server: >0 or blank (risk/route.ts:138-146,169-171) → "0" is rejected 400 | no | no | RISK_SETTINGS | row updates | PARTIAL (0 accepted by UI, refused by server; "platform default 5" is wrong, see E) |
| SET / CHANGE COVERAGE ACCOUNT | MODE | server names no coverage account (DS:532-535) | always | none | local BackofficeSettings.CoverageAccountNumber only (DS:594-600); overwritten by server value when one appears (DS:926-931) | LIVE accounts only | form | no | – | panels re-render | UI-ONLY |
| TRADES / EXPOSURE / HISTORY chips | GRP header | always | always | HISTORY: GET deals?from&to (DS:673) | none | – | no | no | – | view swap | WORKS |
| FROM / TO + APPLY | GRP HISTORY bar | HISTORY tab | always | GET deals?from&to | none | – | no | no | – | reload | PARTIAL (with DEALER ON every broker account incl. coverage + A-book counts as dealer-managed, DS:611-616) |
| Live exposure / Open client 360 | GRP TRADES right-click | row | always | none | none | – | no | no | – | opens EXP / CLI (DS:119) | WORKS |
| Symbol ▾ | TICKET | always | always | none | none | – | no | no | – | menu of watchlist symbols; selects chart (DS:1343-1348) | WORKS |
| MKT chip | TICKET Type | always | always | none | local | – | no | no | – | captions SELL / BUY | WORKS |
| LIMIT / STOP chips | TICKET Type | always | always | none | none; BUY/SELL then toast "limit orders need the coverage bridge" (DS:1329) | – | no | no | – | captions "BUY LIMIT" etc. | PLACEHOLDER |
| SELL (danger) / BUY (primary) | TICKET | always | always | PlaceCoverageOrderAsync POST /api/manage/coverage/orders {symbol, side, volume, slPrice?, tpPrice?, type:MARKET} (DS:1325-1336) | as one-click row above | client: symbol, positive volume (DS:1328-1330) / server: lot bounds, SL/TP side (coverage/orders/route.ts:61-80) | yes "…at market on the coverage account? … Fills at the live price, no commission." | no | MANAGER/BROKER_ADMIN | sound, refresh, toast | WORKS |
| HALT DEALING GROUP (danger) | PANIC | always | always (toast if no dealing groups) | SetGroupHaltAsync PATCH /api/manage/groups/{id}/halt {halted:true} per group (DS:1397) | Group.tradingHaltedAt; audit GROUP_HALT_TOGGLED; accounts-updated event (groups/[id]/halt/route.ts:42-62); read by lib/risk checkGroupTradingHalted in trade/orders, fill, requote-response, dealing-queue accept | server EMERGENCY_CONTROLS (halt/route.ts:19) | yes | no | EMERGENCY_CONTROLS | toast "N groups · halt" | WORKS |
| CLOSE-ONLY (danger) | PANIC | always | always | SetGroupCloseOnlyAsync {closeOnly:true} (DS:1398) | Group.closeOnlyAt; audit GROUP_CLOSE_ONLY_TOGGLED | same | yes | no | EMERGENCY_CONTROLS | toast | WORKS |
| RESUME | PANIC | always | always | two PATCHes per group {halted:false} then {closeOnly:false} | both cleared; two audits per group | same | yes | no | EMERGENCY_CONTROLS | toast | WORKS |
| P/L 1D / 5D / 7D / 1M chips | SDM filter bar | always | always | FetchDealsAsync GET deals?from (DS:716-729) | none | – | no | no | – | DEALER P/L recomputed | PARTIAL (server caps at 500 closed trades broker-wide, deals/route.ts:73; 1M window can be truncated silently) |
| BOOK ALL · N (primary) | SDM UNBOOKED | unbooked > 0 | always | BookPositionAsync POST /api/manage/positions/{id}/book × N sequential (DS:884-899) | per position as BOOK | as BOOK | yes "Hedge all N unbooked (L lot) to coverage?" | no | MANAGER/BROKER_ADMIN | toast "k of N booked · err" | WORKS |
| BOOK | SDM UNBOOKED row | unbooked row | always | BookPositionAsync (DS:880-882) | ensureCoverageAccount; Order FILLED + Position A_BOOK same side on coverage account at raw live ask/bid, no markup/commission; client Position.covered=true, coveredAt, coveragePositionId; audit POSITION_COVERAGE_BOOKED; NATS OrderFilled (book/route.ts:65-146) | server: OPEN, not covered, B_BOOK, not coverage acct, live price (book/route.ts:43-70); no margin / balance check on coverage account | yes "Hedge X to coverage? (client position stays open)" | no | MANAGER/BROKER_ADMIN | sound, refresh | WORKS |
| UNBOOK | SDM BOOKED row | booked row with leg found | always | AdminClosePositionAsync POST positions/{legId}/close (DS:830) | = ✕ close coverage (leg closed at live, client released to UNBOOKED) | as ✕ | yes CLOSE COVERAGE | no | MANAGER/BROKER_ADMIN | refresh | WORKS |
| CLOSE | SDM CLOSED row | leg still open after client closed | always | AdminClosePositionAsync (DS:867) | = ✕ close coverage | as ✕ | yes | no | MANAGER/BROKER_ADMIN | refresh | WORKS |
| Open client 360 / Live exposure | SDM UNBOOKED/BOOKED row right-click | row | always | none | none | – | no | no | – | opens CLI / EXP (DS:834) | WORKS |
| Column header click (sort) / right-click (COLUMNS picker, Reset columns) | every DataTable (GRP trades/exposure/history, COV exposure/history) | always | always | none | local, not persisted on this screen (no LayoutChanged handler) | – | no | no | – | sort / column toggle | WORKS |

### Where dealer mode / auto-fill / auto-hedge can be toggled on DEAL (and what it writes)
1. MODE "SWITCH TO AUTO-FILL" / "SWITCH TO DEALER ON" → Broker.dealingDeskAutoFillAt (dealing-desk-toggle/route.ts:80). Only affects groups with groupType DEALING at dealingMode INHERIT (lib/dealing-routing.ts:41-44). Switching to auto-fill also flushes the queue (route.ts:102-104).
2. MODE "TURN AUTO-HEDGE ON/OFF" → Broker.autoHedgeAt (route.ts:81).
3. Nothing on this screen writes Broker.dealingModeAt (broker-wide review), Group.dealingMode, Group.forceDealingMode or Broker.smartDealerAcceptPct/RejectPct; "Smart dealer" row is read-only (DS:519-523).
4. Related desk writes: MAX SLIPPAGE EDIT and the ⚙ gear SAVE → Broker.defaultMaxSlippagePips; PANIC → Group.tradingHaltedAt / closeOnlyAt; SET COVERAGE ACCOUNT → local file only.

## D. Dialogs
| Dialog | Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|---|
| DEALER SETTINGS (⚙) | Requote step (points) | text, required | Settings.RequoteStepPoints | local backoffice settings RequoteStepPoints | DS:401 PresetPrice (0/neg → 10) | – ; hidden side effect: writes Broker.defaultMaxSlippagePips = null (DS:455-458) |
| MAX SLIPPAGE | "Pips (blank = platform default 5, 0 = reject any slippage)" | text | current broker value | Broker.defaultMaxSlippagePips | app/api/trade/orders/route.ts:565 and app/api/trade/positions/[id]/close/route.ts:224 only when the client sends no maxSlippagePips; lib/risk.ts:442-450 (null = unlimited) | – |
| COVERAGE ACCOUNT | Coverage account | choice (LIVE accounts) | local value or first | local Settings.CoverageAccountNumber | DS:912 only when server has none; never sent to server | only while server coverage account unknown |
| REJECT ALL | REASON (AUDIT TRAIL) | text, required | "" | Order.rejectionReason; AuditLog newValue.reason; NATS OrderRejected.reason | trader event payload (dealing-queue/[id]/route.ts:137) | – |
| REQUOTE flyout | +1/+2/+3 presets, custom price | buttons / text | presets computed (DS:399-407) | Order.requotedPrice | trade/orders/[id]/requote-response/route.ts:55,120 | – |
| Confirm-only dialogs | ACCEPT ALL, BOOK NOW, BOOK ALL, CLOSE COVERAGE, AUTO-FILL / DEALER ON, AUTO-HEDGE ON/OFF, HALT DEALING GROUP / CLOSE-ONLY / RESUME, "<SIDE> <SYM> AT MARKET" (ticket + one-click), MOVE/SET SL/TP (MODIFY) | – | – | – | – | – |
| ORDER TICKET (inline) | Volume / Take profit / Stop loss | text | "0.10" / "" / "" | Order + Position volume/tpPrice/slPrice on coverage account | engine SL/TP trigger (UNVERIFIED which reader watches coverage legs) | – |

## E. Text
- "Pips (blank = platform default 5, 0 = reject any slippage)" and "5 pips · platform default" (DS:560, DS:549, const DS:542): server has no 5-pip default any more (null = unlimited, lib/risk.ts:442-450) and rejects 0 (risk/route.ts:138-146).
- "Fill all {n} orders awaiting a dealer at market?" (DS:412): fills at requested price.
- "Route every market order to the dealer queue for manual review?" / "Auto-fill every market order at the live price (no dealer review)?" (DS:513): switch only touches DEALING-type groups at INHERIT; the auto-fill confirm does not say the current queue is filled at market.
- "Cover every dealing-group fill on the coverage account automatically…" (DS:587): not applied to desk-flush fills or forceDealingMode groups.
- Docstring vs code: "the button is not offered" in DEALER ON (DS:573-575) — button is rendered (DS:584-592).
- "Coverage never auto-closes: booking is the only automatic action" (DS:1131 comment) — auto-hedged legs auto-close (lib/coverage.ts:342-380).
- "no coverage account: the first BOOK NOW provisions it" (DS:938): coverage orders and auto-hedge also provision.
- "Dealing group only. Broker-wide: Trading-halt." (DS:1361): nav item is "TRADING HALT (EMG)" per DS:1355 comment.
- "Limit and stop need the coverage bridge." / "limit orders need the coverage bridge" / "only MARKET orders on the coverage account (limit / stop wait for the coverage bridge)" (DS:1339, 1329, 1214): internal project term.
- "cancel resting not available", "price alerts not available" (DS:464, 1215).
- Header codes numbered "1) MW … 10) SDM" with no visible "4)"; SDM code comments number DEALER P/L "5)" (DS:774) and BOOK ALL "6)" (DS:883).
- Label inconsistency between sibling tables: GRP "LOTS / OPENING / CURRENT PRICE / PROFIT / LOSS" vs COV "LOT / OPENING / CMP / P/L" (DS:117-118 vs 1037-1038); GRP history "TIME" vs COV history "CLOSED" (DS:123 vs 128); history "OPEN" vs trades "OPENING".
- Queue header column "ACT" (DS:287); kind "CLOSE #n PART" (DS:317).
- Case mix: "nothing awaiting · nothing resting" vs "NO DEALING ACTIVITY" vs "No open trades" (DS:297, 486, 118).
- Summary docstring still says ORDER TICKET "phase-2 placeholder" and coverage account "client-side designation" (DS:30-33) — both replaced.
- UNBOOK label: the action closes the coverage position and realizes P&L (DS:830, confirm DS:1135).

## F. UI structure map
Layout (DS:197-206): 3 resizable columns (GridSplitters, sizes persisted per key) + 24 px NET strip at the bottom.
- Left rail (312 px): 1) MW MARKET WATCH (156 px) over 3) ACT DEALING ACTIVITY (*).
- Centre (*): 4) chart (*) / 2) QUEUE PENDING QUEUE (170 px) / bottom row (212 px) split horizontally: 5) COV COVERAGE ACCOUNT (1.1*) | 7) GRP DEALING-GROUP (*).
- Right rail (244 px): 10) SDM SMART DEALER MANAGER (1.4*) / 6) MODE DEALER MODE (1.3*) / 8) TICKET ORDER TICKET (1*) / 9) PANIC EMERGENCY · DEALING GROUP (0.8*).
- No page header, no KPI strip; nav badge DEAL = pending count (hot) (DS:298).
- NET strip (DS:1169-1179): TOTAL "n · L lot" · COVERED · OPEN RISK · NET · ‖ · DEALING-GROUP P/L · "vs" · COVERAGE P/L · "=" · DEALER NET P/L.

Panel headers (header-right items in order):
- 1) MW: none. Body = shared MarketWatchView: search "search symbols…", "+ ADD" (amber) flyout ("ADD SYMBOL", search "search…", candidate list, empty "all enabled symbols are on the watchlist" / "no match"), feed state.
- 2) QUEUE: stat "0 AWAITING DEALER" / "N AWAITING · OLDEST 12S", refresh Status text, "⚙" (tip "Dealer settings"), "ACCEPT ALL" (primary/orange), "REJECT ALL" (danger).
- 3) ACT: none.
- 5) COV: chips TRADES | EXPOSURE | HISTORY (default TRADES).
- 6) MODE: stat "DEALER ON" (amber) / "AUTO-FILL" (green) / "—".
- 7) GRP: chips TRADES | EXPOSURE | HISTORY (default TRADES). The "P/L" header stat is only placed inside the HISTORY bar (DS:662), so it is not visible on TRADES/EXPOSURE.
- 8) TICKET: none.
- 9) PANIC: stat "no dealing groups" / "h/N HALTED" / "c/N CLOSE-ONLY" / "TRADING".
- 10) SDM: none; filter bar "P/L" label + chips 1D | 5D | 7D | 1M (default 1D).

Tables:
1. MW (shared control): columns SYMBOL · BID · ASK · [SPRD] · [HIGH · LOW] · [CHG%] (optional via Columns); grouped by category title; not sortable; single selection = active chart symbol. Row click = chart; double-click = ticket symbol; Enter: none. Right-click on row: YES — no header line; "Open chart, X" · "New order, X" · "Specification, X…" · separator · "Add symbol…" · "Remove X from watchlist" · separator · "Columns" ▸ (checkbox) "Change %", "Spread", "Daily High / Low". Empty area / column header right-click: NO. No-feed rows show "NO FEED".
2. PENDING QUEUE (bespoke rows, DS:271-342): columns STATUS · KIND · ACCOUNT · CLIENT · SYMBOL · SIDE · LOTS · PRICE · AGE · ACT. Not sortable; order = awaiting dealer, then awaiting client, then resting (server order within each). No selection, no checkbox. Row click / double-click / Enter: none. Per-row buttons: AWAITING DEALER → "ACCEPT ▾" (menu header "ACCEPT AT" or "CLOSE AT": "Requested · <price>", "Market · <price>"), "REQUOTE ▾" (flyout: "REQUOTE SYM SIDE VOL · step N pts", +1/+2/+3 buttons each with price, "custom price" box, Enter submits), "REJECT"; AWAITING CLIENT → "WITHDRAW"; RESTING → "CANCEL". Right-click row: YES — dealing order: header "[CLOSE ]SYM SIDE VOL · ACC", items "Open client 360", "Live exposure"; resting: header "SYM · ACC", item "Open client 360". Multi-select / empty area / header right-click: NO. Repeating alert sound every 4 s while any order awaits (DS:304).
3. DEALING ACTIVITY (log rows, DS:467-488): time HH:mm · kind (CLOSE/OPEN/PLACED/MODIFY/CANCEL/TRIGGER or 8-char verb) · text; newest first by HH:mm string, max 60. No interaction, no right-click.
4. Chart (shared ChartPanel): toolbar layout button (menu "CHART LAYOUT": Single, Grid 2×2, "Crosshair sync (grid)", hint "Double-click a cell: maximize / restore"), OHLC header LAST · CHG · O · H · L · VOL, TF 1M 5M 15M 30M 1H 4H D W, INDICATORS, ⚙ (CHART: One-click panel, Sessions; EMA 20/50, VWAP, SESSIONS; DRAWING TOOLS: Trend line, Horizontal line, Ray, Rectangle, Fibonacci retracement; Chart settings…), FIB / OB / FVG chips, one-click widget SELL − lots + BUY with ‹ collapse (ChartPanel.axaml:19-232; arrangement UNVERIFIED beyond the axaml text). Overlays: coverage-account legs only (DS:258). Right-click on full chart: YES — header "<price> · below|above market" (disabled), separator, "Buy Limit @ P" + "Sell Stop @ P" (below market) or "Sell Limit @ P" + "Buy Stop @ P" (above), separator, per leg (max 4) "Set SL P[ · SIDE VOL]" / "Set TP P[…]", separator (if legs), "Alert below|above P", separator, "Collapse one-click panel" / "Expand one-click panel", separator, [if drawings: "<Kind> settings…" (near a drawing), "Remove drawing", "Clear all drawings (n)", separator], "Reset view" (CandleChartControl.cs:483-535). Grid cell right-click: "Reset view", "Maximize". Leg double-click = close coverage.
5. COV TRADES (bespoke, DS:1035-1121): columns by width tier — <480 px ACCOUNT · SYMBOL · SIDE · LOT · CMP · P/L; <700 px + OPENING; else TICKET · ACCOUNT · SYMBOL · OPENED · SIDE · LOT · OPENING · CMP · P/L; then ✕ button (tip "Close coverage position"). Not sortable; no selection; no row click/double-click; right-click row: NO. Account strip beneath: ACCOUNT · BALANCE · EQUITY · FLOATING · FREE · MARGIN LVL ("none used" when no margin) · "UNFUNDED: any loss stops out" (DS:951-959).
6. COV EXPOSURE (DataTable deal-cov-exp): SYMBOL · LONG · SHORT · NET · PROFIT / LOSS; header click sorts; default order |net| desc; single select; right-click row NO; header right-click YES (COLUMNS: each column checkbox, separator, "Reset columns"); empty area NO.
7. COV HISTORY (DataTable deal-cov-hist): bar FROM [date] TO [date] APPLY (primary) REALIZED stat; columns CLOSED · TICKET · SYMBOL · SIDE · LOTS · OPEN · CLOSE · PROFIT / LOSS; default closedAt desc; sortable; right-click row NO; header right-click COLUMNS.
8. GRP TRADES (DataTable deal-grp-trades2): TICKET · ACCOUNT · SYMBOL · OPENED · SIDE · LOTS · OPENING · CURRENT PRICE · PROFIT / LOSS; default openedAt asc; sortable; single select; double-click / Enter: none; right-click row: YES — header "ACC · SYM", "Live exposure", "Open client 360"; header right-click COLUMNS; empty area NO. Scope: every open B-book position broker-wide (DS:608).
9. GRP EXPOSURE (deal-grp-exp): SYMBOL · LONG · SHORT · NET · PROFIT / LOSS; |net| desc; right-click row NO.
10. GRP HISTORY (deal-grp-hist): bar FROM · TO · APPLY (primary) · REALIZED; columns TIME · ACCOUNT · SYMBOL · SIDE · LOTS · OPEN · CLOSE · PROFIT / LOSS; server order closedAt desc; right-click row NO. Default range last 7 days (DS:650-651).
11. MODE rows (DS:507-536): Execution · [SWITCH button] · Auto-hedge · [TURN AUTO-HEDGE button] · Dealing-group accounts · Smart dealer ("Off" / "accept ≤ a% · reject ≥ r%") · MAX SLIPPAGE value + EDIT (tip "Broker-wide maximum slippage, in pips") · section "COVERAGE ACCOUNT" · Coverage account "number · name" / "not set" · [SET/CHANGE COVERAGE ACCOUNT].
12. TICKET (DS:1299-1342): Symbol "<SYM> ▾" (menu header "SYMBOL", watchlist items) · Type chips MKT | LIMIT | STOP (default MKT) · Volume · Take profit · Stop loss · SELL (danger) | BUY (primary) (captions "SELL LIMIT"/"BUY STOP" when non-market) · note "Fills on the coverage account at the live price." / "Limit and stop need the coverage bridge." (amber).
13. PANIC: note "Dealing group only. Broker-wide: Trading-halt." · HALT DEALING GROUP (danger) · CLOSE-ONLY (danger) · RESUME.
14. SDM (DS:730-869): head "DEALER P/L · 1D", large signed number, breakdown "open … · booked … · closed … (1D)"; section "UNBOOKED · n" + "BOOK ALL · n" (primary, tip "Hedge every unbooked B-book position onto the coverage account") + rows (caption "SYM · SIDE VOL · ACC · #T", CLIENT / DEALER P&L, "BOOK"); "BOOKED · n" rows (CLIENT / COVERAGE / NET, "UNBOOK", or amber "hedge leg not found on the coverage account"); "CLOSED · n" (max 12; "CLOSED MM-DD HH:mm · …", CLIENT / COVERAGE or "COVERAGE (OPEN)" / NET, note "AWAITING DEALER · close the coverage leg" or "ORPHAN · auto-hedged leg did not close", "CLOSE"). Right-click on UNBOOKED/BOOKED row: YES — header "SYM · ACC", "Open client 360", "Live exposure". CLOSED rows: NO. Max 60 rows per open section.

## Issues
[functional] DEAL · per-row REJECT always fails: client sends reason "" and the route returns 400 "reason is required for the audit trail" · DealingScreen.cs:442, ApiClient.ManageG2.cs:228-229, app/api/manage/dealing-queue/[id]/route.ts:99-101
[functional] DEAL · WITHDRAW (requote withdraw) always fails for the same reason · DealingScreen.cs:443, dealing-queue/[id]/route.ts:99-101
[money] DEAL · saving the ⚙ requote step sends defaultMaxSlippagePips:null and wipes Broker.defaultMaxSlippagePips (form has no "slip" field) · DealingScreen.cs:445-458, JsonBody.cs:29, app/api/manage/risk/route.ts:166-172
[money] DEAL · ACCEPT ALL confirm says "at market" but sends no fillMode, so every order fills at the client's requested price · DealingScreen.cs:412-413, dealing-queue/[id]/route.ts:74,319
[money] DEAL · requote presets ignore IsClose: on a queued close of a BUY position +N raises the close price (client's favour); live fallback uses ask for a BUY close that settles at bid · DealingScreen.cs:399-407, dealing-queue/[id]/route.ts:96
[money] DEAL · switching to AUTO-FILL flushes queued orders into fills that never call coverage.onFillAutoHedge, so with auto-hedge ON those fills stay unhedged · app/api/manage/dealing-desk-toggle/route.ts:245-283, lib/coverage.ts:435
[money] DEAL · auto-hedge only hedges group.groupType DEALING, while the screen's dealing scope (SDM/GRP/panic) also includes forceDealingMode groups · lib/coverage.ts:457, DealingScreen.cs:603,1380
[money] DEAL · with DEALER ON every broker account (coverage, A-book, demo) is treated as dealer-managed: GRP HISTORY lists them, NET "DEALING-GROUP P/L" includes coverage realized which then cancels out of DEALER NET P/L · DealingScreen.cs:611-616,1159-1167
[money] DEAL · NET strip realized parts use the unranged deals list (last 500 closed trades broker-wide), no period stated · DealingScreen.cs:212,1160-1163, app/api/manage/deals/route.ts:73
[money] DEAL · BOOK / BOOK ALL / coverage orders have no balance or free-margin check on the coverage account (provisioned at 0 balance) · app/api/manage/positions/[id]/book/route.ts:43-80, app/api/manage/coverage/orders/route.ts:52-86
[functional] DEAL · MAX SLIPPAGE EDIT accepts 0 ("reject any slippage") but the server rejects 0 with 400 · DealingScreen.cs:560-566, app/api/manage/risk/route.ts:138-146
[text] DEAL · "platform default 5 pips" is false; server default is unlimited when blank · DealingScreen.cs:542,549,560, lib/risk.ts:442-450
[functional] DEAL · ACT feed drops the dealer's own ACCEPT/REJECT/REQUOTE audits: their labels ("Accepted dealing order" etc.) do not start with "Dealing" · DealingScreen.cs:216, lib/audit-labels.ts:106-113
[functional] DEAL · desk-flush audits DEALING_DESK_AUTO_FLUSHED / _CLOSE carry no actorAdminId · app/api/manage/dealing-desk-toggle/route.ts:174-183,249-258
[ux] DEAL · auto-fill switch ignores the `flushed` result; dealer is not told which queued orders were filled or skipped · DealingScreen.cs:514, dealing-desk-toggle/route.ts:106-112
[ux] DEAL · when GET dealing-desk-toggle fails (403 without RISK_SETTINGS) the MODE button still reads "SWITCH TO DEALER ON" · DealingScreen.cs:509-514
[functional] DEAL · RESTING row CANCEL is a toast only; no manage cancel endpoint exists · DealingScreen.cs:464
[functional] DEAL · chart limit/stop-at-price and price alert menu items do nothing but report "not available" · DealingScreen.cs:1214-1215
[functional] DEAL · ticket LIMIT/STOP types are selectable but cannot be placed · DealingScreen.cs:1310-1329
[functional] DEAL · SDM P/L range and history views are silently capped at 500 closed trades · app/api/manage/deals/route.ts:73, DealingScreen.cs:723
[ux] DEAL · SET COVERAGE ACCOUNT writes only a local setting, never the server · DealingScreen.cs:594-600
[ux] DEAL · GRP "P/L" header stat is only mounted inside the HISTORY bar, invisible on TRADES/EXPOSURE · DealingScreen.cs:185,632,662
[ux] DEAL · auto-hedge button shown while DEALER ON although its docstring says it is not offered · DealingScreen.cs:573-592
[ux] DEAL · activity feed merges and sorts by HH:mm string only, wrong order across midnight · DealingScreen.cs:476-487
[ux] DEAL · SL/TP modify from the chart publishes no live event · app/api/manage/positions/[id]/route.ts:88-122
[text] DEAL · dealer-mode confirm texts say "every market order"; the switch only affects DEALING-type groups at INHERIT · DealingScreen.cs:513, lib/dealing-routing.ts:41-44
[text] DEAL · "Coverage never auto-closes" comment contradicts auto-hedged leg auto-close · DealingScreen.cs:1131, lib/coverage.ts:342-380
[text] DEAL · sibling tables use different labels for the same fields (LOTS/LOT, CURRENT PRICE/CMP, PROFIT / LOSS/P/L, TIME/CLOSED) · DealingScreen.cs:117-129,1037-1038

## Status counts
STATUS-COUNTS app=backoffice screen=DEAL WORKS=39 PARTIAL=8 UI-ONLY=1 PLACEHOLDER=4 DEAD=2 DUPLICATE=0


<!-- ===== bo-DLS.md ===== -->

# bo-DLS — Trade history (Deals)

Code: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\DealsScreen.cs (DLS), Controls\DataTable.cs. API: Vyx.Shared\Api\ApiClient.ManageG1.cs, ApiClient.ManageG6.cs. Routes under D:\VyXTrader-Tauri\vyX\app\api\manage.

## A. Purpose + panels
Closed-trade history for the broker (latest 500 CLOSED/VOIDED positions) with search, filter chips, replay, void and delete (maker-checker for MANAGER). One panel: header "1) DLS TRADE HISTORY" + filter bar + table (DLS:43).

## B. Data
- Table: GET /api/manage/deals — ApiClient.ManageG1.cs:203 → app/api/manage/deals/route.ts:15. Server: status CLOSED or VOIDED, deletedAt null, orderBy closedAt desc, take 500 (deals/route.ts:53-74). No query params sent (no date range, no paging).
- Refresh: on open + live topic "position" (DLS:21); no poll (Screen.cs:45 default 0). After a write: AfterWriteAsync refetch (Screen.cs:144-148).
- Filters (client-side, DLS:74-81): chips ALL / PROFIT (realizedPnl > 0) / LOSS (< 0) / VOIDED (status VOIDED) / TODAY (closedAt starts with today's UTC date); search box matches account number, client name, symbol (contains, case-insensitive).
- Sort: none applied by the screen (server order closedAt desc); header click sorts (DataTable.cs:160-182,299).
- Pagination/limits: server hard cap 500; header stat "N SHOWN OF M · NET ±x" (DLS:88-89) where M ≤ 500.
- Empty: "no closed trades" (DLS:36). Error: header Status text (DLS:51). Loading: header Status "loading…" (Screen.cs:98).
- Replay: GET /api/manage/positions/{id}/replay — ApiClient.ManageG6.cs:146 → positions/[id]/replay/route.ts:16 (MANAGER/BROKER_ADMIN; candles around the fill + audit lines).
- Pending delete tracking: local set; a row stays "DELETE PENDING" until the list no longer returns it (DLS:26,59).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Search "account · client · symbol" | filter bar | always | always | none | none | – | no | no | – | rows filtered, stat updates (DLS:42) | WORKS |
| Chips ALL / PROFIT / LOSS / VOIDED / TODAY | filter bar | always | always | none | none | – | no | no | – | rows filtered (DLS:69-80) | WORKS |
| Column header click | table header | always | always | none | none | – | no | no | – | sort toggle ▲/▼ | WORKS |
| Column header right-click → COLUMNS / Reset columns | table header | always | always | none | local Settings.TableColumns["deals"] (DLS:40-41) | – | no | no | – | columns shown/hidden, persisted | WORKS |
| Open client | row right-click | any row | always | none | none | – | no | no | – | opens CLI for the account (DLS:97) | WORKS |
| Replay fill… | row right-click | any row | always | FetchPositionReplayAsync GET /api/manage/positions/{id}/replay | none (read) | – | – | no | MANAGER/BROKER_ADMIN (replay/route.ts:18) | dialog "REPLAY · #T" with order type, requested/filled/requoted, open/close + times, candle count, up to 8 audit lines; button "CLOSE" (DLS:111-121) | WORKS |
| Void deal… | row right-click | any row | status ≠ VOIDED and not delete-pending (DLS:99) | VoidPositionAsync POST /api/manage/positions/{id}/void (ManageG6.cs:141-144) | none for a closed deal: MANAGER path requestPositionAction → loadOpenPosition throws "position is not open" → 409 (lib/position-actions.ts:502-503, 47-57; void/route.ts:31-39); BROKER_ADMIN path executeVoid → same 409 (position-actions.ts:346-347; void/route.ts:42-48). Every row on this screen is CLOSED or VOIDED | server: position must be OPEN | yes "Void … ? Reverses the result on the account." (danger) | would be (MANAGER) | MANAGER/BROKER_ADMIN | error toast | DEAD |
| Delete deal… | row right-click | any row | status ≠ VOIDED and not delete-pending (DLS:100) | DeleteDealAsync POST /api/manage/positions/{id}/delete {reason} (ManageG1.cs:216-222) | MANAGER: PositionActionRequest (DELETE, reason) + audit POSITION_ACTION_REQUESTED, HTTP 202 (delete/route.ts:30-39; position-actions.ts:506-525). BROKER_ADMIN: Position.deletedAt / deletedByAdminId / deleteReason + audit POSITION_DELETED (position-actions.ts:445-466); no balance change, no NATS publish (delete/route.ts:51-54) | client: reason required (DLS:126) / server: reason required, not OPEN, not already deleted (delete/route.ts:26-29; position-actions.ts:442-443) | yes + REASON input (danger) | yes for MANAGER (position-actions.ts:22-23) | MANAGER/BROKER_ADMIN | 202: row → "DELETE PENDING", toast "…filed for another admin's approval"; 200: refetch, toast "…deleted" | WORKS |
| Row double-click | table row | any row | not VOIDED / not pending (DLS:125) | same as Delete deal… (DLS:39) | same | same | yes | same | same | same | DUPLICATE (Delete deal… right-click item) |
| "DELETE" text in ACTIONS column | table cell | status ≠ VOIDED and not pending (DLS:87) | – | none: RowActivated handler is an empty block (DLS:38) | none | – | – | – | – | nothing happens on click | UI-ONLY |

## D. Dialogs
| Dialog | Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|---|
| DELETE DEAL | REASON | text, required | "" | BROKER_ADMIN: Position.deleteReason + AuditLog newValue.reason; MANAGER: PositionActionRequest.reason + AuditLog | approvals flow approvePositionActionRequest → executeDelete (lib/position-actions.ts:531-537, 480-486); audit views | – |
| VOID DEAL | (none) | – | – | – | – | confirm only |
| REPLAY · #T | (read-only text) | – | – | – | – | uses the confirm dialog with button "CLOSE"; after close an empty success toast is raised (DLS:120, MainWindow.axaml.cs:331) |

## E. Text
- Void confirm "Reverses the result on the account." (DLS:104): void is refused for every closed deal; the server void reverses only commission/swap of an OPEN position (lib/position-actions.ts:330-347).
- Class docstring "(the server's most recent 500)" matches server; header stat "N SHOWN OF M" does not say M is capped at 500 (DLS:89).
- Panel title "TRADE HISTORY" vs nav code DLS / docstring "Deals"; menu "Open client" vs DEAL screen "Open client 360" (DLS:97, DealingScreen.cs:119).
- Empty text "no closed trades" lowercase vs sibling tables "No open trades" (DLS:36, DealingScreen.cs:118).
- "DELETE" rendered as a red chip-styled cell that looks clickable (DLS:87).
- Replay audit lines: time parsed by splitting on " · " (DLS:119); lines without that separator print whole.

## F. UI structure map
Layout: single full-content panel (DLS:43).
- Header: code "1) DLS", title "TRADE HISTORY"; header-right: stat "N SHOWN OF M · NET ±x" (green ≥ 0 / red < 0), then refresh Status text. No KPI strip.
- Filter bar: chips ALL | PROFIT | LOSS | VOIDED | TODAY (default ALL; single-select); search box (220 px, placeholder "account · client · symbol").
- No toolbar buttons (no primary/orange button).

Table "deals" (DataTable, DLS:33-36): columns in order TICKET · ACCOUNT · CLIENT · SYMBOL · SIDE · VOLUME · OPEN · CLOSE · COMMISSION · SWAP · PROFIT / LOSS · CLOSED · STATUS · ACTIONS.
- Sortable: every header (click toggles ▲/▼). Default sort: none (server closedAt desc).
- Selection: single; no checkbox column.
- Row click: selects (handler no-op, DLS:38). Double-click: opens DELETE DEAL dialog (DLS:39). Enter: none.
- Per-row badges: STATUS chip "CLOSED" (b) / "VOIDED" (bad) / "DELETE PENDING" (wait); ACTIONS cell "DELETE" (bad tone, not a button). TICKET "—" when no ticket; PROFIT / LOSS "—" when null.
- Right-click on row: YES — header "SYM SIDE VOL · ACC" (disabled), separator, "Open client", "Replay fill…", "Void deal…" (enabled when not VOIDED and not delete-pending), "Delete deal…" (same enable rule). No submenus, no shortcuts (DLS:91-101).
- Right-click on multi-selection: n/a (single select). Right-click on empty area: NO (no TableContextRequested handler). Right-click on column header: YES — "COLUMNS" (disabled), separator, one checkbox per column, separator, "Reset columns" (DataTable.cs:303-318).
- Empty: "no closed trades". Loading: header Status "loading…". Error: header Status text.
- FocusRecord from other screens (e.g. CLI "Open in Deals") sets the search box to the deal's account number, not the single deal (DLS:62-67).

## Issues
[functional] DLS · "Void deal…" can never succeed: every row is CLOSED/VOIDED and both void paths require status OPEN (409 "position is not open") · DealsScreen.cs:99,103-110, app/api/manage/positions/[id]/void/route.ts:31-48, lib/position-actions.ts:47-57,502-503
[text] DLS · Void confirm claims "Reverses the result on the account." · DealsScreen.cs:104
[ux] DLS · double-clicking any row opens the DELETE DEAL dialog · DealsScreen.cs:39
[ux] DLS · "DELETE" in the ACTIONS column looks like a button but has no click handler · DealsScreen.cs:38,87
[functional] DLS · list is capped at the latest 500 closed trades with no date range or paging; older trades are unreachable here · app/api/manage/deals/route.ts:73, ApiClient.ManageG1.cs:203
[ux] DLS · header "N SHOWN OF M" does not state that M is a 500-row cap · DealsScreen.cs:89
[ux] DLS · CLI "Open in Deals" focuses by account (search box) rather than the chosen deal · DealsScreen.cs:62-67, ClientsScreen.cs:79
[ux] DLS · Replay viewer reuses the confirm dialog and raises an empty toast on CLOSE · DealsScreen.cs:120, Views/MainWindow.axaml.cs:331
[text] DLS · "Open client" vs "Open client 360" elsewhere; "no closed trades" casing differs from sibling tables · DealsScreen.cs:36,97

## Status counts
STATUS-COUNTS app=backoffice screen=DLS WORKS=7 PARTIAL=0 UI-ONLY=1 PLACEHOLDER=0 DEAD=1 DUPLICATE=1


<!-- ===== bo-SYM.md ===== -->

# bo-SYM · Symbols (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs (SYM). Nav: TRADING › "Symbols" (ViewModels/ShellViewModel.cs:59), F8 "SYMBOLS" (ShellViewModel.cs:97).

## A. Purpose + panels
Broker-wide per-symbol config (BrokerSymbol): markup, commission, swaps, lot limits, max exposure, hedged margin %, trading mode, enabled, weekly sessions.
Panels: 1) LIM "EXPOSURE LIMITS · NET LOTS PER SYMBOL" (top, 220 px) and 2) SYM "SYMBOLS · SPREADS · SESSIONS" (fills) (SymbolsScreen.cs:57-60).
The class summary (SymbolsScreen.cs:18-25) still describes a "BOOK routing rules" panel and "HDG" panel that do not exist, and contains a duplicated "Esc reverts." line.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error / loading |
|---|---|---|---|---|---|---|---|
| 2) SYM grid | GET /api/manage/symbols | FetchBrokerSymbolsAsync ApiClient.ManageG2.cs:140 | app/api/manage/symbols/route.ts:42-77 (every Symbol row, merged with this broker's BrokerSymbol or DEFAULTS :19-32) | on open / nav (>10 s stale, Screen.cs:70-76); no poll, no live topic; after SAVE (AfterWriteAsync Screen.cs:144-148) | chips ALL / each category / ENABLED / DISABLED (client, SymbolsScreen.cs:85-94); column-click sort | none (all symbols) | "no symbols" (:43); error → header Status text (Screen.cs:103) |
| 1) LIM | same GET symbols + GET /api/manage/positions | FetchManagePositionsAsync ApiClient.ManageG1.cs:224 | app/api/manage/positions/route.ts:47 (OPEN positions, broker) | same as SYM | enabled symbols only (SymbolsScreen.cs:112) | none | "no symbols" (:56) |
| Sessions dialog | GET /api/manage/symbols/{brokerSymbolId}/sessions | FetchSymbolSessionsAsync ApiClient.ManageG2.cs:146 | app/api/manage/symbols/[id]/sessions/route.ts:19-37 | on dialog open | day, openTime asc | — | toast "sessions: <error>" (SymbolsScreen.cs:197) |

LIM math: NOW = Σ(BUY volume) − Σ(SELL volume) over ALL broker positions in that symbol (SymbolsScreen.cs:114); status OK / NEAR LIMIT (>90 %) / OVER LIMIT vs MAXIMUM EXPOSURE (:116). The server meaning of maxExposure is different: per ACCOUNT total open volume (gross, both sides) in the symbol — lib/risk.ts:307-327 (web order path), engine/risk/src/lib.rs:146-168 (engine). The LIM panel therefore compares a broker-wide net against a per-account gross cap.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filter chips ALL / <CATEGORY…> / ENABLED / DISABLED | SYM filter bar | always | always | none (client filter) SymbolsScreen.cs:85-94 | — | — | no | no | — | re-render | WORKS |
| Double-click cell MARKUP / COMMISSION / LOT / SWAP LONG / SWAP SHORT / MINIMUM LOT / MAXIMUM LOT / STEP / MAXIMUM EXPOSURE / HEDGED MARGIN % | SYM grid | always | always | none; opens inline editor, Enter commits, Esc reverts, lost focus commits (SymbolsScreen.cs:48-49, 123-160) → stages row | none until SAVE | client: number required (maxexp may be empty) :140-141; hedged 0-200 :143 / server symbols/route.ts:138-208 | no (staged) | no | — | row tone amber + "CHANGED", save bar appears | WORKS |
| Hedged margin < 50 → confirm "HEDGED MARGIN x% ON SYM" / "SET x%" | editor commit | value < 50 | — | stages with ConfirmBelowFloor=true (SymbolsScreen.cs:145-152) | server requires confirmBelowFloor for <50 (symbols/route.ts:163-179), audit newValue.confirmedBelowHedgedFloor (:295) | client 0-200 / server 0-200 + floor | yes (danger) | no | — | toast "… staged, press SAVE" | WORKS |
| Double-click ENABLED cell | SYM grid | always | always | none, stages Enabled toggle (:126) | on SAVE: BrokerSymbol.enabled; enabling a non-USD-quoted symbol → 400 (symbols/route.ts:219-226) | server | no (staged) | no | — | staged | WORKS |
| Double-click TRADING MODE cell (BOTH → BUY_ONLY → SELL_ONLY) | SYM grid | always | always | none, stages (:127) | on SAVE: BrokerSymbol.tradingMode | server enum (symbols/route.ts:148) | no | no | — | staged | WORKS |
| Double-click SESSIONS cell ("EDIT…" / "24/7 · DEFAULTS") | SYM grid | always | BrokerSymbolId set, else toast "save the symbol first" (:195) | GET then PUT /api/manage/symbols/{brokerSymbolId}/sessions — SaveSymbolSessionsAsync ApiClient.ManageG2.cs:155 → sessions/route.ts:42-84 | TradingSession delete+createMany in one transaction (:77-80); NO audit log; no live event | client ParseSessions "DAY HH:MM-HH:MM ; …", close > open (:211-224) / server HH:MM, 0-6, close > open (:60-75) | the dialog is the confirm (ConfirmWithInput "SAVE SESSIONS") | no | MANAGER, BROKER_ADMIN (sessions/route.ts:5-11) | toast "SYM · n sessions saved"; no grid refetch | PARTIAL (dialog says "Empty = trades 24/7" but empty = default FX weekend close + daily break, lib/risk.ts:201-209; ignored for continuously traded categories, lib/risk.ts:206; no audit) |
| DISCARD | save bar | ≥1 staged row | always | none (:168) | — | — | no | no | — | toast "changes discarded" | WORKS |
| SAVE CHANGES (primary/orange) | save bar | ≥1 staged row | always | PATCH /api/manage/symbols once per staged row, sequential — SaveBrokerSymbolAsync ApiClient.ManageG2.cs:142-144 → symbols/route.ts:121-316 | BrokerSymbol upsert (:253-257); AuditLog SYMBOL_CONFIG_UPDATED old/new (:259-298); no notification / mirror / coverage / live event | client per-cell / server all fields (:181-208) | yes "SAVE SYMBOL CHANGES" (:172) | no | MANAGER, BROKER_ADMIN (:34-40) | saved rows leave dirty set; failures listed "SYM: error · …"; refetch | WORKS |
| Right-click row → "Trading sessions…" | row menu | always | BrokerSymbolId set | as SESSIONS cell | as above | as above | dialog | no | as above | as above | DUPLICATE (SESSIONS cell double-click) |
| Right-click row → "Disable (stage)" / "Enable (stage)" | row menu | always | always | stages (:186) | on SAVE | — | no | no | — | staged | DUPLICATE (ENABLED cell double-click) |
| Right-click row → "Revert this row" | row menu | row staged | always | none (:187) | — | — | no | no | — | row reset | WORKS |

## D. Dialogs
Inline editor fields (stored in BrokerSymbol.*; readers):
| Field (column) | Type / default | Stored in | READ BY |
|---|---|---|---|
| MARKUP | decimal, stored in PIPS (no unit shown) / "0" | BrokerSymbol.spreadMarkup | fill: lib/pricing-engine.ts:299-336 → lib/group-pricing.ts:63-97 (base level); engine/order-management/src/lib.rs:236-240 (engine path) |
| COMMISSION / LOT | decimal / "0" | BrokerSymbol.commissionPerLot | lib/pricing-engine.ts:152-159 / group-pricing.ts:95; charged via chargeCommission app/api/trade/orders/route.ts:627 |
| SWAP LONG / SWAP SHORT | decimal / "0" | BrokerSymbol.swapLong / swapShort | lib/swap-rollover.ts:77-78, :218 |
| MINIMUM LOT / MAXIMUM LOT / STEP | decimal / 0.01 / 100 / 0.01 | minLot / maxLot / lotStep | app/api/trade/orders/route.ts:148, :189 (lib/risk.ts:98-105); engine/risk/src/lib.rs (check_lot_size, engine/order-management/src/lib.rs:205); mirror clamp lib/mirror.ts:335 |
| MAXIMUM EXPOSURE | decimal or empty (= no limit) | BrokerSymbol.maxExposure | per-ACCOUNT gross cap: lib/risk.ts:312-327 via app/api/trade/orders/route.ts:202; engine/order-management/src/lib.rs:225-226 |
| HEDGED MARGIN % | 0-200 / "200" | BrokerSymbol.hedgedMarginPct | lib/margin.ts:76, :119-137; engine/order-management/src/calc.rs + margin_watch.rs (grep hedged_margin_pct) |
| TRADING MODE | BOTH/BUY_ONLY/SELL_ONLY / BOTH | BrokerSymbol.tradingMode | lib/risk.ts:52-55 via app/api/trade/orders/route.ts:187, lib/mirror.ts:328, manage positions/dealing-queue routes; NOT read by engine (no trading_mode in engine/**/*.rs) |
| ENABLED | bool / true | BrokerSymbol.enabled | engine check_symbol_enabled (engine/order-management/src/lib.rs:201); group pricing / allow-list lists (enabled:true filters) |
Sessions dialog (ConfirmWithInput, SymbolsScreen.cs:200): one text input "SESSIONS", prefilled with existing "MON 00:00-23:59 ; …" (:198-199); stored in TradingSession(dayOfWeek, openTime, closeTime); READ BY lib/risk.ts:201-222 checkTradingSession (web order/close/mirror/bulk-close paths) and engine/order-management/src/session.rs. closeTime is exclusive (lib/risk.ts:219), so "00:00-23:59" leaves 23:59-24:00 closed; a window cannot cross midnight (server :71).

## E. Text
- "Windows (UTC), e.g. \"MON 00:00-23:59 ; TUE 00:00-23:59\". Empty = trades 24/7." (SymbolsScreen.cs:200) — wrong: empty = default FX weekend schedule (lib/risk.ts:207-209).
- Cell label "24/7 · DEFAULTS" (SymbolsScreen.cs:103) — same wrong claim; also shown for a symbol that simply has no BrokerSymbol row.
- Sessions cell shows "EDIT…" for every configured row whether or not any session exists (SymbolsScreen.cs:103).
- Column "MARKUP" (SymbolsScreen.cs:41) is in pips without unit, while Groups/Account types PRICING panels show points ("VALUE · PTS", PricingPanel.cs:48).
- Panel "EXPOSURE LIMITS · NET LOTS PER SYMBOL" (SymbolsScreen.cs:57) misdescribes maxExposure (per-account gross, lib/risk.ts:307-310).
- Hedged-margin toast "hedged margin %: 0 to 200 (200 = both legs in full, 50 = MT5 FX default, 0 = hedge is free)" (:143) — verbose.
- Class summary (SymbolsScreen.cs:18-25) refers to removed BOOK/HDG panels; duplicated "Esc reverts." (:24-25).

## F. UI structure map
Layout: page grid rows 220 px / * (SymbolsScreen.cs:60). Header title per shell: "Symbols" code SYM.
- Panel 1 header: "1) LIM" · "EXPOSURE LIMITS · NET LOTS PER SYMBOL"; header-right: none. No KPI strip.
- Panel 2 header: "2) SYM" · "SYMBOLS · SPREADS · SESSIONS"; header-right: stat "<n> ENABLED · <n> TOTAL" (:107), Status text. Below: filter bar (chips), then save bar (hidden until a row is staged: text "<n> SYMBOL(S) CHANGED · NOT SAVED", buttons DISCARD, SAVE CHANGES primary/orange) (:51-54, :106), then grid.

Table 1 (LIM, layout "sym-hedge"): columns SYMBOL · NET LIMIT · NOW · STATUS (:55-56). Values: "<n> LOTS" or "—"; NOW signed "+x"/"−x"; STATUS OK / NEAR LIMIT / OVER LIMIT / NO LIMIT. All headers sortable (click), no default sort (server order = name asc). Selection single, no checkbox. Row click: select only; double-click: nothing; Enter: nothing. Right-click on row: NO (no handler). Right-click empty area: NO. Right-click column header: YES, column picker ("COLUMNS" disabled header, separator, one checkbox item per column, separator, "Reset columns") (DataTable.cs:89, :303-318). Empty: "no symbols".

Table 2 (SYM, layout "symbols", persisted per user :46-47): columns SYMBOL · CATEGORY · DIGITS · MARKUP · COMMISSION / LOT · SWAP LONG · SWAP SHORT · MINIMUM LOT · MAXIMUM LOT · STEP · MAXIMUM EXPOSURE · HEDGED MARGIN % · TRADING MODE · SESSIONS · ENABLED · (blank header: state "CHANGED") (:41-43). All sortable, no default sort (server order name asc). Selection single, no checkbox. Row click: select. Double-click: per cell (see C); DIGITS/SYMBOL/CATEGORY/state: nothing. Enter: only inside the inline editor. Per-row badges: TRADING MODE chip, ENABLED ON/OFF chip, "CHANGED" chip, SESSIONS "EDIT…" orange text. Right-click on row: YES —
  header "<SYMBOL>" (disabled) / separator / "Trading sessions…" (enabled when BrokerSymbolId set) / "Disable (stage)" or "Enable (stage)" / "Revert this row" (visible only when staged) (:181-189). No shortcuts, no submenus.
Right-click multi-selection: n/a (single select). Right-click empty area: NO (no TableActions). Right-click column header: YES, column picker as above. Empty: "no symbols". Loading: shell LOADING veil (Screen.cs:66-76).
Filter chips (in order): ALL (default) · each distinct CATEGORY upper-case, alphabetical · ENABLED · DISABLED (:88).
Toolbar buttons: none besides the save bar.

## Issues
- [money] SYM · LIM panel compares broker-wide NET lots (buy−sell) with maxExposure, which the server enforces as a per-ACCOUNT gross open-volume cap · SymbolsScreen.cs:114-116 vs lib/risk.ts:307-327, engine/risk/src/lib.rs:146-168
- [functional] SYM · sessions dialog and cell say empty = 24/7; server applies the default FX weekend close + daily break when no rows exist · SymbolsScreen.cs:103, :200 vs lib/risk.ts:207-209
- [functional] SYM · TradingSession PUT writes no AuditLog · app/api/manage/symbols/[id]/sessions/route.ts:77-83
- [functional] SYM · sessions edits have no effect on continuously traded categories (crypto), the dialog does not say so · lib/risk.ts:206
- [functional] SYM · tradingMode (BUY_ONLY/SELL_ONLY) is not read by the Rust engine order path; only the web routes enforce it (UNVERIFIED which path is live for fills) · engine (no trading_mode match), lib/risk.ts:52
- [ux] SYM · a session "HH:MM-23:59" leaves the last minute of the day closed (closeTime exclusive, no midnight crossing) · lib/risk.ts:219, sessions/route.ts:71
- [ux] SYM · symbol config save publishes no live event, open terminals keep old config until they refetch · app/api/manage/symbols/route.ts:253-315
- [text] SYM · MARKUP column is pips with no unit while PRICING panels are points · SymbolsScreen.cs:41, PricingPanel.cs:48
- [text] SYM · class summary describes removed BOOK/HDG panels, duplicated "Esc reverts." · SymbolsScreen.cs:18-25

## Status counts
STATUS-COUNTS app=backoffice screen=SYM WORKS=8 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2
