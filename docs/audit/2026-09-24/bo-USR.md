# bo-USR — Team (staff, roles, delegated permissions) (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\TeamScreen.cs (267 lines); right column CFG panel = BrokerSettingsPanel (SettingsScreen.cs:22-113, audited in bo-CFG.md). Web: D:\VyXTrader-Tauri\vyX.
Convention: a pure view control that does what it says is WORKS.

## A. Purpose + panels
Broker staff list, invite (create) a staff member, disable / re-activate, delegate MANAGER extra permissions.
Panels: left "1) USR · STAFF · ROLES" containing the staff table and, below it, "2) PERM · ROLE MATRIX"; right column (380 px) swaps between "3) CFG · BROKER SETTINGS" (default), "3) EDIT · STAFF MEMBER" and "3) INVITE · ADD STAFF" (TeamScreen.cs:44-51,149-215).

## Roles that exist (web)
prisma/schema.prisma:57-66 enum AdminRole: SUPER_ADMIN (VyXTechnologies staff, brokerId null), BROKER_ADMIN (full broker backoffice), SUPPORT (broker-scoped, "restricted"), MANAGER (dealing desk, narrower than BROKER_ADMIN). No other admin role type exists.
DEALER role: NO. AdminRole has no DEALER value; "DEALER" appears in schema.prisma only inside comments (lines 1786, 1887). The dealing desk runs as MANAGER (schema.prisma:61-65). Delegation is by extraPermissions on MANAGER only: KYC_REVIEW, RISK_SETTINGS, EMERGENCY_CONTROLS, INTERNAL_TRANSFERS, FUNDS_APPROVAL, IB_PAYOUTS, ACCOUNT_FINANCE, MIRROR_MANAGE (lib/permission-labels.ts:11-20; checked per request by lib/permissions.ts:15-21).
Creatable from this screen: BROKER_ADMIN, MANAGER, SUPPORT (app/api/manage/admins/route.ts:44; TeamScreen.cs:31).
SUPPORT in practice: can pass POST /api/manage/login (app/api/manage/login/route.ts:59) but no /api/manage/* data route admits SUPPORT (every gate is MANAGER/BROKER_ADMIN or BROKER_ADMIN; e.g. shell-info/route.ts:17). The native sign-in then fails at shell-info: "Signed in, but the backoffice info could not be loaded: not allowed for this role." (BackofficeSession.cs:54-55).

## B. Data
| Read | ApiClient | Route | Gate |
|---|---|---|---|
| GET /api/manage/admins | FetchAdminsAsync ApiClient.ManageG4.cs:77 | app/api/manage/admins/route.ts:18 | BROKER_ADMIN only (route.ts:10-16) |
| GET /api/manage/settings (right column) | FetchSettingsAsync ManageG4.cs:96 | app/api/manage/settings/route.ts:17 | BROKER_ADMIN only |
Admins: every AdminUser of the broker, createdAt desc, with currentAdminId (route.ts:24-41). No limit. Table height fits up to 20 rows then scrolls (TeamScreen.cs:62).
Refresh: no live topics, no poll; on nav (>10 s) and after each write. MANAGER: header status "not allowed for this role", table empty "no staff yet" (TeamScreen.cs:58).
Header stat "{n} USERS · 3 ROLES" (:81).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + INVITE (primary) | panel 1 header (:49) | always | always | none | none | - | no | no | none (server gate on CREATE) | right column -> invite form | WORKS |
| Empty-area ctx "Invite a team member…" | staff table blank area (:39) | always | always | none | none | - | no | no | none | invite form | DUPLICATE (+ INVITE :49) |
| Invite role chips ADMIN · MANAGER · SUPPORT | invite form (:200-202) | invite open | always | none | none | - | no | no | none | chip lit; default SUPPORT | WORKS |
| CREATE (primary) | invite form (:211,223-236) | invite open | always | CreateAdminAsync ManageG4.cs:87 -> POST /api/manage/admins {email, password, role} | AdminUser insert (bcrypt hash, status ACTIVE) + AuditLog ADMIN_USER_CREATED (admins/route.ts:65-83). No notification, no e-mail | client: contains "@" and length ≥5, not already on the team (:225-226); server: email+role required, password ≥8, 409 duplicate (route.ts:58-63,87-89) | yes ("ADD STAFF MEMBER"), then "INITIAL PASSWORD · SHOWN ONCE" | no | BROKER_ADMIN | toast "{email} added as {ROLE}", right column back to CFG | PARTIAL (default role SUPPORT creates a login that cannot open the backoffice) |
| CANCEL | invite form (:211) | invite open | always | none | none | - | no | no | none | right column CFG | DUPLICATE (BACK TO CFG :213) |
| BACK TO CFG | EDIT and INVITE headers (:180,213) | member/invite open | always | none | none | - | no | no | none | right column CFG | WORKS |
| Staff row click | staff table (:40) | row | always | none | none | - | no | no | none | selects; matrix adds the manager's column | WORKS |
| Staff row double-click | staff table (:41) | row | always | none | none | - | no | no | none | right column -> member editor | WORKS |
| ACTIONS cell double-click | staff table (:42) | row | always | none | none | - | no | no | none | member editor | DUPLICATE (row double-click :41) |
| Ctx "Edit…" | staff row menu (:242) | row | always | none | none | - | no | no | none | member editor | DUPLICATE (row double-click :41) |
| DISABLE ACCESS (danger) | member editor ACCESS (:176,182-189) | selected ACTIVE and not self | always | SetAdminStatusAsync ManageG4.cs:90 -> PATCH /api/manage/admins/{id} {status:"DISABLED"} | AdminUser.status=DISABLED + AuditLog ADMIN_USER_STATUS_CHANGED (admins/[id]/route.ts:56-73); that admin's next request is rejected and its sessions revoked (lib/auth.ts:276-285) | server: not self (400), same broker (404) | yes, type tenant name (Screen.cs:110-115) | no | BROKER_ADMIN | toast "{email} · disabled", refetch | WORKS |
| RE-ACTIVATE (primary) | member editor ACCESS (:177,190-195) | selected DISABLED and not self | always | same PATCH {status:"ACTIVE"} | AdminUser.status=ACTIVE + audit | same | yes ("ACTIVATE") | no | BROKER_ADMIN | toast "{email} · active" | WORKS |
| Ctx "Disable access…" / "Re-activate…" | staff row menu (:243) | row | not self | same | same | same | same | no | same | same | DUPLICATE (member editor :176-177) |
| Matrix cell click (selected manager's column) | 2) PERM grid (:97-99,129-135) | selected is MANAGER | always | none (stages) | none | - | no | no | none | cell toggles ●/·; SAVE + REVERT appear | WORKS |
| Permission toggles (8) | member editor DELEGATED PERMISSIONS (:165) | selected is MANAGER | always | none (stages) | none | - | no | no | none | same staging | DUPLICATE (matrix cell :99) |
| SAVE (primary) | 2) PERM header right (:103,136-146) | staged set differs | always | SetAdminPermissionsAsync ManageG4.cs:93 -> PATCH /api/manage/admins/{id} {extraPermissions[]} | AdminUser.extraPermissions replaced (deduped) + AuditLog PERMISSIONS_CHANGED old/new (admins/[id]/route.ts:37-43,74-85); read fresh on every request by lib/permissions.ts:15-21 | server: values must be in PERMISSIONS, target must be MANAGER (route.ts:39-54) | yes ("DELEGATE PERMISSIONS") | no | BROKER_ADMIN | toast "{email} · {n} delegated" | WORKS |
| SAVE PERMISSIONS (primary) | member editor (:168) | staged differs | always | same | same | same | yes | no | same | same | DUPLICATE (matrix SAVE :103) |
| REVERT | 2) PERM header right (:103) | staged differs | always | none | none | - | no | no | none | staging dropped | WORKS |
| REVERT | member editor (:168) | staged differs | always | none | none | - | no | no | none | same | DUPLICATE (matrix REVERT :103) |
| ACTIONS cell words "DISABLE" / "ACTIVATE" | staff table ACTIONS (:78) | non-self rows | - | none (single click only selects the row) | none | - | - | - | - | nothing | UI-ONLY |
| "2FA · devices · IPs — not available yet" | member editor (:160) | member open | - | none | none | - | - | - | - | - | PLACEHOLDER |
| "PASSWORD RESET · ROLE CHANGE — not available yet" | member editor (:179) | member open | - | none | none | - | - | - | - | - | PLACEHOLDER |
| Right column BROKER SETTINGS SAVE | 3) CFG panel (SettingsScreen.cs:29) | CFG mode | always | see bo-CFG.md | see bo-CFG.md | | yes | no | BROKER_ADMIN | | DUPLICATE (CFG screen, bo-CFG.md) |
| Column header click / right-click | staff table (DataTable.cs:89,299) | always | always | none | none | - | no | no | none | sort / column picker | WORKS (2 controls) |

## D. Dialogs
Invite form (right column, not a modal; :197-215):
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| e-mail | text (300 px) | "" | AdminUser.email (lower-cased server-side, admins/route.ts:54) | app/api/manage/login/route.ts (lookup); admin/forgot-password | - |
| ROLE | chips ADMIN / MANAGER / SUPPORT | SUPPORT | AdminUser.role | lib/auth.ts requireAdminRole (every route gate), lib/auth.ts:280 live check | - |
| (password) | generated, 16 chars (:216-222), not editable | random | AdminUser.passwordHash (bcrypt, route.ts:65) | manage/login | shown once in "INITIAL PASSWORD · SHOWN ONCE" |
Delegated permissions (matrix / member toggles): 8 booleans -> AdminUser.extraPermissions; READ BY lib/permissions.ts:15-21 and getPermissionContext (:66-) on each gated route (funds, KYC, risk, emergency, IB, transfers, account finance, mirror).
Confirms: ADD STAFF MEMBER ("Create {email} as {ROLE}? The password is shown once."), DISABLE STAFF ACCESS (typed tenant name), RE-ACTIVATE STAFF ACCESS, DELEGATE PERMISSIONS ("{email} (MANAGER) gets: {labels}?").

## E. Text
- Column "LAST ACTIVE" shows lastLoginAt (last sign-in), not last activity (:37,77; admins/route.ts:37).
- Header stat "3 ROLES" counts only creatable roles; SUPER_ADMIN exists too (:81).
- Matrix note "ADMIN: all · MANAGER: per user (n/N) · SUPPORT: none" (:105): SUPPORT has not just no delegable permissions but no usable backoffice access at all.
- Role label "ADMIN" for BROKER_ADMIN here (:70) vs "BROKER ADMIN" in the shell ROLE cell (MainWindow.axaml.cs:108).
- Invite note "Shown once after CREATE. Send it securely." (:208) — the password is not shown in the form before CREATE.
- Class doc mentions "Desk · 2FA · IP allowlist · actions/24h and custom roles" (:23-24); only "2FA · devices · IPs" is rendered.

## F. UI structure map
Layout: PageGrid columns * / 380. Left panel "1) USR  STAFF · ROLES"; header right in order: stat "{n} USERS · 3 ROLES", + INVITE (primary/orange), status text. No filter bar, no search.
Left body (stack): staff table, then "2) PERM  ROLE MATRIX" header (right: hint "SELECT A MANAGER TO DELEGATE" / "CLICK A CELL IN {NAME} TO STAGE" / "{ROLE} · NOTHING TO DELEGATE", plus SAVE (primary) and REVERT when staged), note line, matrix grid.
Staff table columns: USER | ROLE | LAST ACTIVE | STATUS | ACTIONS. Sortable all; default createdAt desc (server). Single selection; no checkbox. Click = select; double-click = member editor; Enter: nothing. Per-row: USER suffix " (you)"; ROLE orange for ADMIN; STATUS chip ACTIVE (green) / DISABLED (red); ACTIONS "LOCKED" (self, grey) or "EDIT   DISABLE" / "EDIT   ACTIVATE" (orange text, no separate hit targets).
Right-click on row: YES — header = e-mail (disabled), separator, "Edit…", "Disable access…" or "Re-activate…" (disabled on your own row).
Right-click on empty table area: YES — header "STAFF · ROLES", separator, "Invite a team member…". Multi-selection: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Matrix: columns PERMISSION | ADMIN | MANAGER | SUPPORT [| {selected manager, first 9 chars of e-mail local part}]. Rows: KYC review · Risk settings · Emergency controls · Internal transfers · Funds approval · IB payouts · Account finance · Reverse mirror rules. Cells: ADMIN "●"; MANAGER "n/m"; SUPPORT "·"; manager column "●"/"·" clickable.
Right column modes: (a) "3) CFG  BROKER SETTINGS" (default, see bo-CFG.md). (b) "3) EDIT  STAFF MEMBER" header right BACK TO CFG; rows e-mail · role · status · last sign-in · created · 2FA · devices · IPs "not available yet"; section DELEGATED PERMISSIONS (8 toggles + SAVE PERMISSIONS/REVERT or hint "click to stage · SAVE"; for non-managers "ADMIN · FULL ACCESS" or "SUPPORT · NONE DELEGABLE" / "extra permissions apply to MANAGER only"); section ACCESS (DISABLE ACCESS danger / RE-ACTIVATE primary / "your own row"); block "PASSWORD RESET · ROLE CHANGE" "not available yet". (c) "3) INVITE  ADD STAFF" header right BACK TO CFG; section NEW STAFF MEMBER; e-mail box; ROLE chips ADMIN · MANAGER · SUPPORT (SUPPORT lit); note; CREATE (primary) · CANCEL.
Empty: "no staff yet". Loading: page veil. Error: header status.

## Issues
[functional] USR · SUPPORT is the default invite role, but SUPPORT is admitted by no /api/manage data route (not even shell-info), so the new staff member cannot open the backoffice at all · TeamScreen.cs:200; app/api/manage/login/route.ts:59; app/api/manage/shell-info/route.ts:17; BackofficeSession.cs:54-55
[functional] USR · USR (and CFG) are in every role's nav, but admins/settings endpoints are BROKER_ADMIN-only; a MANAGER sees "not allowed for this role" · app/api/manage/admins/route.ts:10-16; ShellViewModel.cs:85
[functional] USR · no way to reset a staff password or change a role from the broker side; the only reset endpoint is SUPER_ADMIN-only, while ADMIN_PASSWORD_RESET_REQUESTED notifications deep-link here · TeamScreen.cs:179; app/api/admin/admins/[id]/reset-password/route.ts:13; NotificationsAuditScreens.cs:107
[ux] USR · ACTIONS column shows "DISABLE" / "ACTIVATE" as if clickable; single click only selects, the action needs the editor or the context menu · TeamScreen.cs:78
[text] USR · "LAST ACTIVE" is last sign-in time · TeamScreen.cs:37,77; app/api/manage/admins/route.ts:37
[text] USR · role naming "ADMIN" (USR) vs "BROKER ADMIN" (shell) vs BROKER_ADMIN (server) · TeamScreen.cs:70; MainWindow.axaml.cs:108

## Status counts
STATUS-COUNTS app=backoffice screen=USR WORKS=12 PARTIAL=1 UI-ONLY=1 PLACEHOLDER=2 DEAD=0 DUPLICATE=9
