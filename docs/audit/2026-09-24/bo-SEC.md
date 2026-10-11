# bo-SEC — Security (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SecurityEmergencyScreens.cs:17-78 (class SecurityScreen). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Facts about the current sign-in, a staff password-reset request, sign out; a list of account-security features marked "not available yet".
Panels: "1) ME · THIS SIGN-IN" (left, *) and "2) SEC · ACCOUNT SECURITY" (right, *) (SecurityEmergencyScreens.cs:27-29).

## B. Data
No fetch. RefreshAsync only re-renders from the local session (:32-37): Session.AdminEmail / Role / Host / SignedInAtUtc / TwoFactorUsed (BackofficeSession.cs:20-27) and Session.Shell (shell-info captured at sign-in or resume).
The code comment "shell-info is already on the session (refreshed by the badge timer)" (:34) is not what happens: the badge timer calls Api.FetchShellInfoAsync directly and only copies the unread count (MainWindow.axaml.cs:196,206-211); BackofficeSession.RefreshShellAsync (BackofficeSession.cs:75-79) has no caller. "broker" and "finance rights" are therefore the values from sign-in time.
"2FA challenged this sign-in" and "Enrolment" both come from Session.TwoFactorUsed, which is true only when this session went through POST /api/manage/login/verify-2fa (BackofficeSession.cs:48) and is forced false on a remember-me resume (BackofficeSession.cs:68).
Refresh: on nav only. Empty/error: none (all rows always render; "—" for missing).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| REQUEST PASSWORD RESET (danger; tooltip "Files a reset request with staff. Nothing changes until they act.") | panel 1 actions (:52,69-77) | always | always | ManageForgotPasswordAsync ApiClient.Manage.cs:59 -> POST /api/admin/forgot-password {email, note} | rate limit 3/h per e-mail, silently "ok" when exceeded (forgot-password/route.ts:19-22); for a MANAGER/BROKER_ADMIN (any status) with a brokerId: Notification type ADMIN_PASSWORD_RESET_REQUESTED, entityType AdminUser (route.ts:28-38). Nothing for SUPPORT. No audit | note optional, server trims to 500 | yes, danger, optional input "NOTE FOR STAFF (optional)" | no | none (pre-auth route) | toast "reset request filed with the staff" | PARTIAL (lands in the broker staff inbox, where no staff-password reset exists; only SUPER_ADMIN can reset, app/api/admin/admins/[id]/reset-password/route.ts:13; SUPPORT requests are dropped silently) |
| SIGN OUT | panel 1 actions (:53) | always | always | Shell.SignOut (MainWindow.axaml.cs:305-308) | none on server (see bo-SHELL.md) | - | yes ("SIGN OUT") | no | none | back to sign-in window | DUPLICATE (shell USER menu "Sign out", MainWindow.axaml.cs:300) |
| "Enrol · reset · backup codes — not available yet" | 2) TWO-FACTOR (:59) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (endpoints exist: /api/admin/two-factor/status, setup, confirm, disable admit MANAGER/BROKER_ADMIN/SUPPORT — two-factor/status/route.ts:16, setup/route.ts:30) |
| "Registered keys — not available yet" | 2) PASSKEYS · HARDWARE KEYS (:60) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Other devices — not available yet" | 2) ACTIVE SESSIONS (:61) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (GET /api/admin/sessions exists, self-service for every admin role, app/api/admin/sessions/route.ts:6-10) |
| "Sign out everywhere — not available yet" | 2) ACTIVE SESSIONS (:61) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (DELETE /api/admin/sessions/{id} exists, sessions/[id]/route.ts:11-18) |
| "Personal tokens — not available yet" | 2) API KEYS (:62) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Allowed addresses — not available yet" | 2) IP ALLOWLIST (:63) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Staff 2FA mandatory — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.requireAdmin2fa exists, schema.prisma:325-331; no API writes it) |
| "Session timeout — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Password rotation — not available yet" | 2) ORG POLICY (:64) | always | - | none | none | - | - | - | - | - | PLACEHOLDER |

## D. Dialogs
REQUEST PASSWORD RESET confirm (danger): text "Request a password reset for {email}?", button REQUEST, one field:
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| NOTE FOR STAFF (optional) | text, max 500 (ConfirmOverlay.axaml:17) | "" | Notification.body ("{email}: {note}") (forgot-password/route.ts:34) | app/api/manage/notifications (broker staff NTF), app/api/admin/notifications/route.ts:18 (Super Admin, by type) | - |
SIGN OUT confirm: "Return to sign-in?", button SIGN OUT, no fields.

## E. Text
- "2FA is not enrolled on this admin, or not required." / "Enrolment NOT ENROLLED" (:49,58) are derived from whether this session was challenged, not from the enrolment flag; after a remember-me resume an enrolled admin reads "NOT ENROLLED".
- Tooltip "Files a reset request with staff. Nothing changes until they act." (:52) and toast "reset request filed with the staff" (:75): the broker's staff cannot reset a staff password; the actor is VyX Super Admin.
- "session COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY" (:48): sign-out does not end the server session (bo-SHELL.md).
- Class doc: "The server has no security endpoints for an admin's own account" (:17-18) and BackofficeSession.cs:24-25 "there is no endpoint to read or change an admin's 2FA enrolment" — both contradicted by /api/admin/two-factor/* and /api/admin/sessions.
- Closing note "Not available yet." (:65) repeats the per-row text.

## F. UI structure map
Layout: PageGrid columns * / * (two equal halves). No filter bars, no tables.
Left "1) ME  THIS SIGN-IN" (header right: status text). Rows: signed in as · role (orange) · tenant · broker · since ("yyyy-MM-dd HH:mm UTC") · 2FA challenged this sign-in ("YES · AUTHENTICATOR CODE" green / "NO" amber) · finance rights (YES/NO) · session ("COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY"); explanatory sentence; buttons in order: REQUEST PASSWORD RESET (danger red text, tooltip) · SIGN OUT (plain).
Right "2) SEC  ACCOUNT SECURITY": sections in order TWO-FACTOR (Enrolment; Enrol · reset · backup codes) · PASSKEYS · HARDWARE KEYS (Registered keys) · ACTIVE SESSIONS (Other devices; Sign out everywhere) · API KEYS (Personal tokens) · IP ALLOWLIST (Allowed addresses) · ORG POLICY (Staff 2FA mandatory; Session timeout; Password rotation); every value "not available yet" except Enrolment; footer "Not available yet.".
Right-click anywhere: NO context menus on this screen. No primary (orange) button.
Loading: page veil on nav (no data fetched). Error: none.

## Issues
[functional] SEC · Broker.requireAdmin2fa (staff 2FA mandatory) is enforced only by the web manage shell layout; the native backoffice login and getAdminSession do not check it, so a broker that requires staff 2FA is not protected in the desktop app · app/manage/(shell)/layout.tsx:46; lib/auth.ts:288-296,327-332; app/api/manage/login/route.ts (no reference)
[functional] SEC · 2FA enrol/reset and session list/revoke endpoints exist for every admin role but the screen shows them as "not available yet" · app/api/admin/two-factor/status/route.ts:16; app/api/admin/two-factor/setup/route.ts:30; app/api/admin/sessions/route.ts:6-10; SecurityEmergencyScreens.cs:59-61
[functional] SEC · "Enrolment" / "2FA challenged" read from this session only; an enrolled admin who resumed a remembered session is shown NOT ENROLLED · SecurityEmergencyScreens.cs:46,58; BackofficeSession.cs:68
[functional] SEC · REQUEST PASSWORD RESET notifies broker staff who have no way to reset a staff password; SUPPORT requests are dropped silently; rate-limited requests return success · app/api/admin/forgot-password/route.ts:19-38; TeamScreen.cs:179
[functional] SEC · "broker" and "finance rights" are frozen at sign-in: Session.Shell is never refreshed (RefreshShellAsync has no caller) · BackofficeSession.cs:75-79; MainWindow.axaml.cs:196-211
[text] SEC · session row says the cookie session "ENDS ON SIGN OUT" but sign-out does not revoke the server session · SecurityEmergencyScreens.cs:48; ApiClient.Manage.cs:100-110; app/api/admin/logout/route.ts:8-12

## Status counts
STATUS-COUNTS app=backoffice screen=SEC WORKS=0 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=9 DEAD=0 DUPLICATE=1
