# bo-MIR · Mirror rules (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\ApprovalsMirrorScreens.cs:107-190 (MirrorScreen, MIR). Nav: TRADING › "Mirror rules" (ShellViewModel.cs:62).

## A. Purpose + panels
Copy / reverse trading rules: a source account or group mirrored into a target account at a multiplier, with symbol filter and kill-switch caps.
One panel: 1) MIR "MIRROR · REVERSE TRADING RULES" (:121).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) MIR | GET /api/manage/mirror-rules | FetchMirrorRulesAsync ApiClient.ManageG6.cs:159 | app/api/manage/mirror-rules/route.ts:75-102 (status ACTIVE / DISABLED / KILLED from enabled + killedAt, :19-22) | live topics order, position (:112); on open; after writes | none | none | "no mirror rules"; error → Status |
| NEW RULE pickers | GET /api/manage/accounts + GET /api/manage/groups | FetchManageAccountsAsync ApiClient.ManageG1.cs:152; FetchGroupsAsync ManageG2.cs:118 | accounts/route.ts:21; groups/route.ts:19 | on "+ RULE" | — | — | — |
Role: GET/POST/PATCH require BROKER_ADMIN or MIRROR_MANAGE permission (mirror-rules/route.ts:15, mirror-rules/[id]/route.ts:13).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| + RULE (primary/orange) | header | always | always | GET accounts, GET groups, then POST /api/manage/mirror-rules — CreateMirrorRuleAsync ApiClient.ManageG6.cs:160 → mirror-rules/route.ts:104-191 | MirrorRule create; AuditLog MIRROR_RULE_CREATED (:176-188) | client: source account required when ACCOUNT, multiplier > 0, target/source account numbers resolved client-side (:179-183) / server: source + target in broker, no self-mirror, multiplier > 0, caps decimal (:110-158) | form | no | BROKER_ADMIN or MIRROR_MANAGE | toast "mirror rule → <acc> created" | WORKS |
| Right-click empty area → "Add new mirror rule…" | table | always | always | as + RULE | as above | as above | form | no | as above | as above | DUPLICATE (+ RULE) |
| Double-click ACTIONS cell ("DISABLE" / "ENABLE") | table | status ≠ KILLED (cell empty when KILLED) | not KILLED (toast "a killed rule stays off" :142) | PATCH /api/manage/mirror-rules/{id} {enabled} — PatchMirrorRuleAsync ApiClient.ManageG6.cs:161 → mirror-rules/[id]/route.ts:134-232 | MirrorRule.enabled; AuditLog MIRROR_RULE_UPDATED (:217-231); read by lib/mirror.ts:276 | — | yes (danger on disable) | no | as above | toast "rule · enabled/disabled" | WORKS |
| Right-click → "Disable…" / "Enable…" | row menu | always | not KILLED | as above | as above | — | yes | no | as above | as above | DUPLICATE (ACTIONS double-click) |
| Right-click → "Edit multiplier / fill / symbols…" | row menu | always | always (also for KILLED) | PATCH /api/manage/mirror-rules/{id} {multiplier, fillPriceMode, symbolFilter} | MirrorRule.multiplier / fillPriceMode / symbolFilter (upper-cased, :182-187); AuditLog MIRROR_RULE_UPDATED | client multiplier > 0 / server same (:166-175) | form | no | as above | toast "rule saved" | WORKS |
Server features with no control: re-enabling a KILLED rule (PATCH enabled:true clears killedAt, mirror-rules/[id]/route.ts:155-159) — blocked in the UI (:142, :150); editing maxOpenLots / maxDailyLoss after creation (mirror-rules/[id]/route.ts:190-205); rule detail with MIRROR_FAILED audit history (GET mirror-rules/[id], :28-127); no delete endpoint exists.

## D. Dialogs
NEW MIRROR RULE (:166-189):
| Field | Type | Default | Stored in | READ BY | Visibility |
|---|---|---|---|---|---|
| Source | choice ONE ACCOUNT / A GROUP | ACCOUNT | MirrorRule.sourceType | lib/mirror.ts (rule lookup by source) | always |
| Source account number | text | "" | resolved to Account.id → MirrorRule.sourceId | lib/mirror.ts | always (hint "when source = account"; not hidden for GROUP) |
| Source group | choice (group names) | first group | MirrorRule.sourceId when GROUP | lib/mirror.ts | always (not hidden for ACCOUNT) |
| Target account number | text, required | "" | MirrorRule.targetAccountId | lib/mirror.ts (opens mirror position on target) | always |
| Direction | choice REVERSE / COPY (SAME) | REVERSE | MirrorRule.direction | lib/mirror.ts:313 | always |
| Multiplier | number, required > 0 | 1 | MirrorRule.multiplier | lib/mirror.ts:335 (roundMirrorVolume, clamped to BrokerSymbol min/max/step) | always |
| Fill price | choice SOURCE PRICE / MARKET | SOURCE_PRICE | MirrorRule.fillPriceMode | lib/mirror.ts:354, :523 | always |
| Symbol filter | text, comma list, empty = all | "" | MirrorRule.symbolFilter (upper-cased) | lib/mirror.ts:230 matchesSymbolFilter | always |
| Max open lots | number, empty = no cap | "" | MirrorRule.maxOpenLots | lib/mirror.ts:162-172 (kill switch) | always |
| Max daily loss | number, empty = no cap | "" | MirrorRule.maxDailyLoss | lib/mirror.ts:176-203 (kill switch → enabled=false, killedAt, :141) | always |
EDIT MIRROR RULE (:155-165): Multiplier (required), Fill price, Symbol filter — same columns/readers as above; detail line "<source> → <target>".

## E. Text
- Toast "a killed rule stays off" (:142) — server supports re-enabling a killed rule (mirror-rules/[id]/route.ts:155-159).
- "Source account number" / "Source group" both always visible with "when source = …" hints (:172-173) instead of conditional visibility.
- LIMITS column "loss <x>/day" (:136).

## F. UI structure map
Layout: single panel. Header: "1) MIR" · "MIRROR · REVERSE TRADING RULES"; header-right: stat "<n> ACTIVE OF <n>" (green when any active), Status, button "+ RULE" (primary/orange). No KPI strip, no filter chips.
Table (layout "mirror-rules"): SOURCE · DIRECTION · TARGET ACCOUNT · MULTIPLIER · FILL PRICE · SYMBOLS · LIMITS · STATUS · SINCE · ACTIONS (:116-118). SOURCE "<ACCOUNT|GROUP> · <label>"; DIRECTION amber for REVERSE; MULTIPLIER "× n"; SYMBOLS list or "ALL"; LIMITS "max n lots · loss n/day" or "—"; STATUS chip ACTIVE / DISABLED / KILLED; ACTIONS "DISABLE"/"ENABLE" (empty for KILLED). Sortable headers, no default sort (server order). Single select, no checkbox. Row click: select. Double-click: only on the ACTIONS cell (toggle); elsewhere nothing. Enter: nothing. Right-click on row: YES —
  "<source> → <target>" (disabled) / separator / "Disable…" or "Enable…" (disabled when KILLED) / "Edit multiplier / fill / symbols…" (:146-153).
Right-click empty area: YES — "MIRROR RULES" (disabled) / separator / "Add new mirror rule…" (:122). Right-click header: YES, column picker. Empty: "no mirror rules".

## Issues
- [functional] MIR · a KILLED rule cannot be re-enabled from the app although the server supports it (clears killedAt) · ApprovalsMirrorScreens.cs:142, :150 vs mirror-rules/[id]/route.ts:155-159
- [functional] MIR · Max open lots / Max daily loss (the kill-switch caps) cannot be changed after creation from the app; server PATCH supports both · ApprovalsMirrorScreens.cs:157-163, mirror-rules/[id]/route.ts:190-205
- [ux] MIR · rules cannot be deleted (no endpoint, no control); failure history (MIRROR_FAILED audit) not shown · mirror-rules/[id]/route.ts:28-127
- [ux] MIR · NEW RULE shows both source account and source group fields regardless of Source choice · ApprovalsMirrorScreens.cs:172-173
- [text] MIR · "a killed rule stays off" contradicts server behaviour · ApprovalsMirrorScreens.cs:142

## Status counts
STATUS-COUNTS app=backoffice screen=MIR WORKS=3 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2
