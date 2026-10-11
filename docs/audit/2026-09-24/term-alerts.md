# term-alerts — Price Alerts dialog (F8) + chart alert entry point

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Code-only audit.

## A. Purpose + panels
Modal dialog (560×520, not resizable; AlertsWindow.axaml:8) to create ABOVE/BELOW price alerts on any enabled symbol and cancel active ones. Opened by F8 / status-bar `F8 ALERTS` (MainWindow.axaml.cs:311, 436-441). Alerts are also created from the chart right-click (`Alert above/below {px}`, term-chart.md). Evaluation is server-side in the engine against the bid (engine/market-data/src/ingest.rs:126; alerts.rs:74-).
Panels: caption `PRICE ALERTS · F8`; add row (SYMBOL · condition · PRICE · ADD); hint line; list header + rows; bottom stack: inline confirm, result line, CLOSE.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Alert list | GET /api/trade/alerts (no `?status`) | FetchAlertsAsync ApiClient.cs:382-390 | alerts/route.ts:14-30 — default returns ACTIVE only, newest first | on open (AlertsWindow.axaml.cs:41), after each add/cancel (MarketDataService.cs:1501, 1508), on AlertTriggered event (MarketDataService.cs:278); list rebuilt through AlertsChanged (AlertsWindow.axaml.cs:38-39, 44-49) |
| Symbol list | cached GridCandidates (watchlist, then all /symbols) | – | – | at open (AlertsWindow.axaml.cs:31) |
| Hint (live bid) | last WS tick | – | – | at open only (AlertsWindow.axaml.cs:37) |

Row mapping (Models.cs:276-286): symbol comes back as a plain string (PriceAlert.symbol is `String`, schema.prisma:894), so `Digits` falls back to 5 for every alert (Models.cs:283) and PRICE is formatted with 5 decimals (AlertsWindow.axaml.cs:127). Status is always ACTIVE in practice because only ACTIVE rows are fetched; TRIGGERED / CANCELLED / EXPIRED rows never appear.
Trigger path: engine persists TRIGGERED (engine/server/src/main.rs:642) → NATS `alert.triggered` (main.rs:654-667) → gateway `alert.>` subscription (services/api-gateway/src/ws.ts:429) → terminal event `AlertTriggered` → LOG line `Alert triggered, {SYM} reached {price}` (MarketDataService.cs:303) + list refresh. No sound, no popup, no chart marker (no `Sound.*` call for alerts; SoundService has none wired for this event).
Sort: server `createdAt desc`. Pagination: none; list ScrollViewer max 230 px (AlertsWindow.axaml:70). Server cap: 50 ACTIVE alerts per account (lib/price-alerts.ts:11, 68-73).
Empty/loading/error: `no alerts on this account` (AlertsWindow.axaml.cs:48); `sending…`, `OK · alert {SYM} {COND} {px}` / `OK · alert cancelled`, `FAILED · {server error}` (95-102; MarketDataService.cs:1495-1510); `FAILED · enter a price` (74). A failed GET keeps the previous list silently (MarketDataService.cs:1491).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SYMBOL picker | add row (AlertsWindow.axaml:42-57) | always | always | flyout of GridCandidates (no ScrollViewer in the flyout, 46-54); pick → AlertsWindow.axaml.cs:52-59 sets symbol and prefills PRICE with the bid | none | – | No | No | trader session (F8 requires sign-in, MainWindow.axaml.cs:438) | symbol + price updated | PARTIAL (hint line keeps the previous symbol and bid, AlertsWindow.axaml.cs:37 vs 52-59) |
| Condition `ABOVE` / `BELOW` | add row (58) | always | always | toggle (AlertsWindow.axaml.cs:60) | none | – | No | No | – | condition flips | WORKS |
| PRICE box | add row (60) | always | always | none | none | client: number > 0, rounded to the symbol tick (AlertsWindow.axaml.cs:74-77) | No | No | – | – | WORKS |
| ADD | add row (61) | always | always | CreateAlertAsync → POST /api/trade/alerts {symbol, condition, price} (MarketDataService.cs:1495-1503; ApiClient.cs:397-398) | alerts/route.ts:32-89: PriceAlert row (status ACTIVE, expiresAt null) + NATS `cfg.alerts.{brokerId}` hot-reload (lib/nats.ts:139-184); no AuditLog, no notification | server: symbol/condition/price required, price > 0, condition ∈ ABOVE/BELOW/CROSSES (lib/price-alerts.ts:28-59); symbol enabled for the broker (route :48-53); ≤ 50 active (:55-59) | Yes per Settings.ConfirmAlerts (default ON, TerminalSettings.cs:16): `Alert when {SYM} {COND} {px}.` / `ADD ALERT` | No | – | LOG `Alert {SYM} {COND} {px} created`; list refreshed; result line | WORKS |
| ✕ CANCEL (per row) | list row (81) | IsActive | always | DeleteAlertAsync → DELETE /api/trade/alerts/{id} (MarketDataService.cs:1504-1510; ApiClient.cs:393-394) | alerts/[id]/route.ts:11-30: PriceAlert.status = CANCELLED (row kept) + NATS cancel; 404 not own, 409 not ACTIVE | server ownership + status | Yes per ConfirmAlerts: `Cancel the alert {SYM} {COND} {px}.` / `CANCEL ALERT` | No | – | LOG `Alert cancelled`; row disappears (list is ACTIVE-only) | WORKS |
| Confirm CANCEL | bottom confirm (27) | confirm pending | always | none | none | – | – | No | – | pending dropped | WORKS |
| Confirm action button (`ADD ALERT` / `CANCEL ALERT`) | bottom confirm (28) | confirm pending | always | runs the pending call (AlertsWindow.axaml.cs:95-102) | as above | – | – | No | – | result line | WORKS |
| CLOSE | bottom (35) | always | always | none | none | – | No | No | – | dialog closes | WORKS |

## D. Dialogs
Price Alerts (this window). Fields:
| Field | Type | Default | Stored in | Read by |
|---|---|---|---|---|
| SYMBOL | flyout pick | active chart symbol (AlertsWindow.axaml.cs:32) | PriceAlert.symbol | engine AlertCache.check_tick (engine/market-data/src/alerts.rs:161; ingest.rs:126) |
| Condition | toggle ABOVE/BELOW | ABOVE (AlertsWindow.axaml.cs:110) | PriceAlert.condition | engine evaluate_alert (alerts.rs:74) — CROSSES exists server-side but is not offered |
| PRICE | text | current bid of the symbol (AlertsWindow.axaml.cs:36) | PriceAlert.price (Decimal 18,5) | engine, compared with the bid |
| (expiry) | – not exposed | – | PriceAlert.expiresAt stays null | – |
Hint line: `{SYM} bid {px} · ABOVE: bid ≥ price · BELOW: bid ≤ price` (AlertsWindow.axaml.cs:37).

## E. Text
- Hint is computed once at open and not updated when another symbol is picked (AlertsWindow.axaml.cs:37).
- PRICE column shows 5 decimals for every symbol, e.g. gold `4456.35000` (Models.cs:283; AlertsWindow.axaml.cs:127).
- STATUS column exists (AlertsWindow.axaml:68, 79) but can only ever show ACTIVE (GET without `?status=all`).
- Class doc `PENDING` treated as active (Models.cs:285) — the server enum has no PENDING alert status (prisma/schema.prisma:869-874).
- Header caption `PRICE ALERTS · F8`.

## F. UI structure map
Window title `Price Alerts`, 560×520, centred on owner, fixed size.
Layout top → bottom: caption `PRICE ALERTS · F8` · add row [`SYMBOL` label, symbol button, condition button (amber), `PRICE` label, price box (right-aligned), `ADD` (primary, amber on accent border)] · hint line · 1 px rule · list header · list · empty text · (bottom-docked) confirm box, result line, `CLOSE`.
**Table (alert list)**: columns in order `SYMBOL` · `COND` · `PRICE` · `STATUS` · `CREATED` · (button column, no header). Not sortable; order = server createdAt desc. Selection: none; no checkbox column. Row click / double-click / Enter: nothing. Per-row button `✕ CANCEL` (red text) when active. Status text amber when active.
Right-click on row: NO. Right-click on empty area / header: NO.
Dropdown: SYMBOL flyout = plain list of symbol names (watchlist first, then every enabled symbol).
Toolbar: none. Filter chips / tabs: none.

## Issues
[ux] alerts · a triggered alert only produces a LOG line and disappears from the list; no sound, popup or chart marker · Services/MarketDataService.cs:278,303; Views/AlertsWindow.axaml.cs:44-49
[functional] alerts · the list fetches ACTIVE alerts only, so the STATUS column can never show TRIGGERED / CANCELLED and no alert history is visible · Vyx.Shared/Api/ApiClient.cs:384; app/api/trade/alerts/route.ts:20-25; Views/AlertsWindow.axaml:68
[text] alerts · PRICE column formats every alert with 5 decimals (digits default 5 because the server returns symbol as a string) · Vyx.Shared/Api/Models.cs:283; Views/AlertsWindow.axaml.cs:127; prisma/schema.prisma:894
[ux] alerts · hint line (symbol + bid) is not updated when a different symbol is picked · Views/AlertsWindow.axaml.cs:37,52-59
[ux] alerts · SYMBOL flyout lists every enabled symbol with no ScrollViewer · Views/AlertsWindow.axaml:46-54
[functional] alerts · CROSSES condition and expiry (expiresAt) are supported by the server but not offered · lib/price-alerts.ts:12,49-56; Views/AlertsWindow.axaml.cs:60
[functional] alerts · alerts created from the chart right-click do not refresh the cached alert list or write a LOG line · Services/MarketDataService.cs:1946-1952
[ux] alerts · a failed alert-list GET keeps the previous list with no error text · Services/MarketDataService.cs:1487-1494

## Status counts
`STATUS-COUNTS app=terminal screen=alerts WORKS=7 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
