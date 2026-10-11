# bo-CFG — Settings (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SettingsScreen.cs (155 lines): SettingsScreen (:115-155) + BrokerSettingsPanel (:16-113, also hosted in the USR right column). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Tenant facts and the two writable broker defaults (default account leverage, default account currency); every other setting row is a link elsewhere or "not available yet".
Panels: "1) TENANT · THIS BROKER" (left, *) and "3) CFG · BROKER SETTINGS" (right, 520 px) (SettingsScreen.cs:124-125).

## B. Data
GET /api/manage/settings — FetchSettingsAsync ApiClient.ManageG4.cs:96 -> app/api/manage/settings/route.ts:17. Gate BROKER_ADMIN only (route.ts:6-12). Returns name, subdomain, customDomain, tier, status, defaultAccountCurrency, defaultAccountLeverage (route.ts:23-32).
Also shown: Session.Host / AdminEmail / Role and Session.Shell (shell-info from sign-in: brokerPrimaryColor, theme, unreadNotifications, canManageFinance). Session.Shell is not refreshed after sign-in (BackofficeSession.RefreshShellAsync has no caller, BackofficeSession.cs:75-79), so "Unread notifications" and "Finance rights" are sign-in-time values.
Refresh: no live topics, no poll; on nav (>10 s) and after SAVE (:109).
Empty/error: right panel "LOADING SETTINGS…" until loaded (:32); "SETTINGS UNAVAILABLE" + reason on error (:93); left "LOADING…" (:126) and header status text; MANAGER gets "not allowed for this role".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SAVE (primary) | 3) CFG header right (:29-30,95-112) | always | always (no-op until loaded; toast "nothing changed" when equal) | SaveSettingsAsync ManageG4.cs:102 -> PATCH /api/manage/settings {defaultAccountCurrency?, defaultAccountLeverage?} (only changed keys) | Broker.defaultAccountCurrency / defaultAccountLeverage updated (settings/route.ts:75). No AuditLog, no notification | client: leverage via LeverageInput ("1:" prefix stripped, :98-100), currency 3 letters A-Z (:101); server: currency must be USD (route.ts:52-60), leverage parseLeverage (route.ts:63-69), 400 "nothing to update" | yes ("SAVE BROKER SETTINGS", lists old → new) | no | BROKER_ADMIN | toast "settings saved", refetch | PARTIAL (change is not audited; the currency box accepts any 3 letters but only USD is accepted by the server) |
| Link "PER GROUP · GRP" (Margin call) | 3) CFG TRADING (:49) | loaded | always | Shell.Navigate("GRP") | none | - | no | no | none | GRP screen | WORKS |
| Link "PER GROUP · GRP" (Stop-out) | 3) CFG TRADING (:50) | loaded | always | same | none | - | no | no | none | GRP | DUPLICATE (Margin call link :49) |
| Link "PER METHOD · PSP" (Min deposit) | 3) CFG FUNDING (:55) | loaded | always | Shell.Navigate("PSP") | none | - | no | no | none | PSP screen | WORKS |
| "Negative balance protection — not available yet" | TRADING (:51) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.negativeBalanceProtection exists, default true, read by lib/position-close.ts; schema.prisma:405-411; no API reads/writes it) |
| "Hedging allowed — not available yet" | TRADING (:52) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Max slippage — not available yet" | TRADING (:53) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.defaultMaxSlippagePips is readable/writable via GET/PATCH /api/manage/risk, risk/route.ts:38,73, and edited on DEAL, DealingScreen.cs:448-460) |
| "Withdrawal auto-approve ≤ — not available yet" | FUNDING (:56) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Require KYC L1 to deposit — not available yet" | FUNDING (:57) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Require KYC L2 above — not available yet" | FUNDING (:58) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Staff 2FA mandatory — not available yet" | SECURITY (:67) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER (Broker.requireAdmin2fa exists, schema.prisma:325-331; no API writes it) |
| "Session timeout — not available yet" | SECURITY (:68) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "Audit retention — not available yet" | SECURITY (:69) | loaded | - | none | none | - | - | - | - | - | PLACEHOLDER |

## D. Dialogs
Inline form fields (right panel), saved by SAVE through the confirm "SAVE BROKER SETTINGS" ("default leverage 1:{old} → 1:{new}; default currency {old} → {new}. New accounts get these defaults; existing accounts keep theirs."):
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| Default leverage | text box (90 px) behind a "1:" label | server value | Broker.defaultAccountLeverage | app/api/manage/accounts/route.ts:269 and live-account-requests/[id]/route.ts:103 and portal/accounts/route.ts:119 — only when the new account gets no group and the broker has no default group (group leverage wins, accounts/route.ts:259-269) | - |
| Default account currency | text box (90 px) | server value | Broker.defaultAccountCurrency | accounts/route.ts:170 (when no currency given), live-account-requests/[id]/route.ts:102, portal/accounts/route.ts:118 | - |
Read-only rows: Broker (settings.name), Domain (customDomain or subdomain), Tier · status, Accent (shell-info brokerPrimaryColor), Terminal theme (shell-info theme), Desktop build ("v{AppVersion} · AVALONIA", :65).

## E. Text
- "Terminal theme" row (:64) shows shell-info `theme`, which is the signed-in admin's own backoffice light/dark preference (AdminUser.theme, shell-info/route.ts:23,41), not the terminal's theme.
- Confirm text "New accounts get these defaults" (:106): leverage only applies when the new account has no group and no default group exists.
- Note under the form: "Default leverage and currency" (:70) — a fragment with no verb.
- Left note "Broker defaults · pricing: GRP / SYM · deposit limits: PSP" (:152).
- "Max slippage", "Negative balance protection", "Staff 2FA mandatory" say "not available yet" although the broker settings exist (see C).
- Panel code "3) CFG" on a screen whose other panel is "1) TENANT" (no panel 2) (:30,124).

## F. UI structure map
Layout: PageGrid columns * / 520.
Left "1) TENANT  THIS BROKER" (header right: status text). Rows: Broker · Host · Subdomain · Custom domain ("none" dim) · Tier · Status (green when ACTIVE, amber otherwise) · Default account currency · Default account leverage ("1:{n}"); section SIGNED IN: Admin · Role (orange) · Unread notifications · Finance rights (YES/NO); note line.
Right "3) CFG  BROKER SETTINGS" (header right: SAVE primary/orange). Sections in order:
- TRADING: Default leverage ["1:" + box] · Default account currency [box] · Margin call [link PER GROUP · GRP] · Stop-out [link PER GROUP · GRP] · Negative balance protection · Hedging allowed · Max slippage (each "not available yet")
- FUNDING: Min deposit [link PER METHOD · PSP] · Withdrawal auto-approve ≤ · Require KYC L1 to deposit · Require KYC L2 above ("not available yet")
- BRANDING · TENANT: Broker · Domain · Tier · status · Accent · Terminal theme · Desktop build
- SECURITY: Staff 2FA mandatory · Session timeout · Audit retention ("not available yet")
- note "Default leverage and currency".
Tables: none. Right-click: NO context menus anywhere on this screen. Dropdowns: none (the fixture shows "1:100 ▾" selectors, harness only, :79-81).
Loading: "LOADING SETTINGS…" / "LOADING…" and page veil. Error: "SETTINGS UNAVAILABLE" + reason; header status.

## Issues
[functional] CFG · broker default leverage / currency changes write no AuditLog row · app/api/manage/settings/route.ts:75
[functional] CFG · "Negative balance protection: not available yet" hides a live broker setting (Broker.negativeBalanceProtection, default true, applied on every stop-out close) that no screen can show or change · SettingsScreen.cs:51; prisma/schema.prisma:405-411; lib/position-close.ts
[functional] CFG · "Max slippage: not available yet" although Broker.defaultMaxSlippagePips is live and edited on DEAL · SettingsScreen.cs:53; app/api/manage/risk/route.ts:38,73; DealingScreen.cs:448-460
[functional] CFG · "Staff 2FA mandatory: not available yet" while Broker.requireAdmin2fa exists (web-enforced only, no API to set it) · SettingsScreen.cs:67; prisma/schema.prisma:325-331
[functional] CFG · currency box accepts any 3-letter code; the server refuses anything but USD · SettingsScreen.cs:101; app/api/manage/settings/route.ts:52-60
[functional] CFG · CFG is in every role's nav but GET/PATCH settings are BROKER_ADMIN-only · app/api/manage/settings/route.ts:6-12; ShellViewModel.cs:88
[functional] CFG · "Unread notifications" and "Finance rights" are sign-in-time values (Session.Shell never refreshed) · SettingsScreen.cs:150-151; BackofficeSession.cs:75-79
[text] CFG · "Terminal theme" shows the admin's own backoffice theme preference · SettingsScreen.cs:64; app/api/manage/shell-info/route.ts:41
[text] CFG · confirm says new accounts get the default leverage; it applies only when there is no group / default group · SettingsScreen.cs:106; app/api/manage/accounts/route.ts:259-269

## Status counts
STATUS-COUNTS app=backoffice screen=CFG WORKS=2 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=9 DEAD=0 DUPLICATE=1
