# term-eco — 5) ECO calendar / news panel

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Code-only audit.

## A. Purpose + panels
Bottom-left panel under Market Watch (MainWindow.axaml:36): the economic calendar — time, country · event with forecast / previous / actual, impact badge. Title `5) ECO CALENDAR · NEWS`, header-right summary (EcoPanel.axaml:11-15). There is no news-headline feed; only calendar events are shown.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| Event rows | GET /api/trade/news | FetchCalendarAsync ApiClient.cs:167-174 | news/route.ts:47-62 → lib/economic-calendar-source.ts getEconomicCalendar (ForexFactory weekly feed, DB-cached 1 h, holidays dropped :44, sorted by time :61); Finnhub fallback only when a key exists and FF fails (news/route.ts:20-45); 503 `news feed unavailable` when both fail | on sign-in (MarketDataService.cs:1076), every 15 min (1079-1081), F6 (MainWindow.axaml.cs:309) |

Client shaping (MarketDataService.cs:1201-1233): events older than now − 2 h dropped (1219); impact `high` → HIGH, `medium`/`med` → MED, anything else → LOW (1220); title = `COUNTRY · event  F est · P prev · A act` (1222-1226); time `HH:mm` for today, `dd HH:mm` for other days, UTC (1227-1228); cap 40 rows (1229). Header-right `{n} EVENTS · {h} HIGH · UTC` (1231).
Filters / sort: none in the UI (no currency, impact or date filter); order = server time ascending. Pagination: none; vertical scroll (EcoPanel.axaml:20).
Empty/loading/error: before the first answer the live header shows the fixture literal `USD · XAU` (MainViewModel.cs:29) and no rows; zero rows → `no calendar events in the next days` (1232); failure → header `CALENDAR OFFLINE` + `calendar unavailable ({error})`, previous rows are kept (1206-1211).

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| F6 NEWS (refresh) — the panel's only control; same key/cell as in term-shell.md | status bar cell / F6 key (MainWindow.axaml.cs:309) | IsLive | always | RefreshCalendarAsync → GET /api/trade/news | read only | – | No | No | trader session | rows rebuilt; action line `F6 · calendar refreshed` | WORKS |

Rows have no click, double-click, hover or right-click handler (EcoPanel.axaml:25-32).

## D. Dialogs
None.

## E. Text
- Title `CALENDAR · NEWS` (EcoPanel.axaml:11) and F-key label `F6 NEWS` (MainViewModel.cs:48): no news feed exists; the XAML comment says the panel states this "in the last row instead of fixture headlines" (EcoPanel.axaml:17-18) but no such row or text is produced (MarketDataService.cs:1231-1232).
- Live header shows the fixture literal `USD · XAU` until the first response (MainViewModel.cs:29) although no currency filter exists.
- `no calendar events in the next days` (MarketDataService.cs:1232) while the source is a single weekly feed.
- F1 help calls F6 `log` (MainWindow.axaml.cs:304).

## F. UI structure map
Header: `5)` `ECO` `CALENDAR · NEWS`; header-right `{n} EVENTS · {h} HIGH · UTC` / `CALENDAR OFFLINE` / (before load) `USD · XAU`.
**Table (event list)**, no column header row: columns in order = time (44 px, muted) · event text (wrapping) · impact badge (40 px, right-aligned, `HIGH` / `MED` / `LOW`, coloured by ImpactToBrushConverter). Not sortable; order = time ascending. Selection: none; no checkbox column. Row click / double-click / Enter: none. Per-row buttons: none.
Right-click on row / empty area: NO.
Status text under the list (dim, wrapping) when empty or failed.
Time cell width: 44 px (EcoPanel.axaml:26) for values up to 8 characters (`dd HH:mm`, MarketDataService.cs:1227-1228); rendered overlap/clipping UNVERIFIED (app not launched).
Fixture (before sign-in): 8 static rows incl. 3 `NEWS` headlines (MainViewModel.cs:212-222).

## Issues
[text] eco · panel title `CALENDAR · NEWS` and F-key `F6 NEWS`, but no news feed exists and nothing in the panel says so (the XAML comment claims it does) · Views/EcoPanel.axaml:11,17-18; ViewModels/MainViewModel.cs:48; Services/MarketDataService.cs:1231-1232
[text] eco · live header shows the design literal `USD · XAU` until the first calendar response, implying a currency filter that does not exist · ViewModels/MainViewModel.cs:29
[functional] eco · no filter by currency / impact / symbol; all countries are listed, capped at 40, and events older than 2 h are dropped only at refresh time (15 min) · Services/MarketDataService.cs:1216-1230,1079
[ux] eco · time column is 44 px wide while non-today rows use `dd HH:mm` (8 chars); visual effect unverified · Views/EcoPanel.axaml:26; Services/MarketDataService.cs:1227-1228
[ux] eco · on a failed refresh the previous rows stay under `CALENDAR OFFLINE` with no age indication · Services/MarketDataService.cs:1206-1211
[ux] eco · rows are not interactive (no detail, no link to the affected symbols) · Views/EcoPanel.axaml:25-32
[text] eco · F1 help text names F6 `log` · MainWindow.axaml.cs:304

## Status counts
`STATUS-COUNTS app=terminal screen=eco WORKS=1 PARTIAL=0 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=0`
