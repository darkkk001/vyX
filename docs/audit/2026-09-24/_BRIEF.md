# Shared brief for every audit agent (VyX full functional audit, READ-ONLY)

## Hard rules
1. READ-ONLY. No code edits, commits, branches, migrations, deploys, installs. Only create/overwrite files inside
   D:\VyXTrader-Tauri\vyX\docs\audit\2026-09-24\ (this folder; leave untracked, never git add).
2. No write actions against any live tenant. Never call write endpoints. Never launch the GUI apps.
3. DB: only the "questions" agent may query, SELECT only, after printing the endpoint host. Everyone else: code only.
4. Every claim cites evidence as path:line (or endpoint + handler file:line). If you cannot confirm: write UNVERIFIED + why. Never guess.
5. Plain terse language. No recommendations in descriptions (only in the issues lines, as facts).

## Code locations
- Native apps (Avalonia, .NET 8): E:\vyxtrader\src
  - Backoffice: Vyx.Backoffice.App (Screens/*.cs, Controls/*.cs: DataTable, FormOverlay, ConfirmOverlay, PricingPanel, Ui.cs; Services/*.cs: BackofficeSession, LiveService, DealingChart, DealingMarketWatch, LiveMath, MenuHost; Views/MainWindow.axaml(.cs) = shell + nav)
  - Trader terminal: Vyx.Trader.App (Views/*.axaml(.cs), ViewModels/*.cs, Services/MarketDataService.cs (main logic), TerminalSettings.cs, SmartRulesEngine.cs, UpdateService.cs, ...; MainWindow.axaml(.cs); Program.cs = harness)
  - Shared: Vyx.Shared (Api/ApiClient*.cs = every HTTP call, Models.cs; Trading/*.cs math), Vyx.Shared.Ui (Charting, MenuHost, UpdateService, StartupGate)
- Web/API (Next.js 15): D:\VyXTrader-Tauri\vyX (app/api/**/route.ts, lib/*.ts, prisma/schema.prisma)
- Rust engine: D:\VyXTrader-Tauri\vyX\engine ; API gateway: D:\VyXTrader-Tauri\vyX\services\api-gateway
- Versions live: terminal 1.0.45, backoffice 1.0.22 (futurixglobal). Web = D: main HEAD.

## Per-screen file format (bo-<CODE>.md / term-<area>.md), sections exactly:
A. Purpose (1-2 lines) + panels
B. Data (per panel: endpoint(s) with ApiClient method file:line + route handler file:line; refresh = live event / poll N s / on open / manual; filters/sort; pagination/limits; empty/error/loading text)
C. Controls table with columns:
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect (tables written; audit / notification / mirror / coverage / NBP / commission) | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
   Status is exactly one of: WORKS | PARTIAL (name the gap) | UI-ONLY | PLACEHOLDER | DEAD | DUPLICATE (list where)
D. Dialogs: every field: type, default, stored in (table.column), READ BY (cite the reader in engine/pricing/risk/web or "nowhere"), conditional visibility
E. Text: verbose / AI-style / inconsistent labels or help text, or ones referring to removed concepts (quote them, file:line)
F. UI structure map, exactly as the user sees it: layout (panels + positions, header title + code, header-right items, KPI strip);
   EVERY table separately: columns in order (exact header text), sortable, default sort; selection none/single/multi, checkbox col;
   row click / double-click / Enter; per-row buttons/badges/links; RIGHT-CLICK ON ROW: YES/NO + full menu exactly as rendered
   (header line, items in order, separators, submenus, shortcuts, visible-when / enabled-when per item); right-click on multi-selection,
   empty area, column header: YES/NO + contents; empty/loading/error text; dropdown/split buttons contents; toolbar buttons in order
   (which is primary/orange); filter chips/tabs in order + default + what each filters.
   START section F with the exact heading "## F. UI structure map" and end it before "## Issues".
Then two machine-readable trailers at the end of every file:
## Issues
One line each: `[SEVERITY money|functional|ux|text] <screen> · <what> · <evidence file:line>` (facts only, no fixes)
## Status counts
`STATUS-COUNTS app=<backoffice|terminal> screen=<CODE> WORKS=n PARTIAL=n UI-ONLY=n PLACEHOLDER=n DEAD=n DUPLICATE=n`

To decide a status you MUST trace: UI handler -> ApiClient method -> route file exists -> handler writes what it claims. A control whose
endpoint does not exist in app/api is DEAD. Server effects: read the route handler and the lib it calls.
