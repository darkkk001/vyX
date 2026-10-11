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
