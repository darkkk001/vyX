# term-shell — Trader Terminal shell (title bar / account strip / tape / status bar / layout)

App: terminal 1.0.45 (E:\vyxtrader master 1c8b0d3). Web/API: D: main 74b3c02. Code-only audit, nothing launched.

## A. Purpose + panels
Main window of the trader terminal: own title bar (brand, symbol command line, account strip, theme, user menu, caption buttons), a scrolling price tape, a 3-column body, and a status bar with connection state, UTC clock, open sessions, update pill and F1–F12 cells.
Panels (MainWindow.axaml:20-60): row 0 TopBar (26 px fixture / 28 px live, MainViewModel.cs:79), row 1 Tape (22 px), row 2 body grid `330 | 1 | * | 1 | 268` (MainWindow.axaml:29), row 3 StatusBar (26 px).
Body: left column = 1) MW Market Watch over 5) ECO calendar (MainWindow.axaml:33-38); middle = 2) chart over positions dock (39-44); right = 3) order ticket over account panel (45-50). Market Watch, ECO and chart are in term-marketwatch.md / term-eco.md / term-chart.md.

## B. Data
| Element | Source | ApiClient | Route handler | Refresh |
|---|---|---|---|---|
| ACCOUNT number | sign-in account string | – | – | set once in GoLiveAsync (MarketDataService.cs:1050) |
| ACCOUNT mode (DEMO/LIVE) | `/me` `accountMode` | FetchAccountAsync ApiClient.cs:140 | app/api/trade/me/route.ts:16,42 | after every trading event (MarketDataService.cs:281), F7, order results; RefreshCommandBar MarketDataService.cs:1289-1300 |
| USER name + initials | `/me` `fullName` (fallback account number) | same | me/route.ts:22 | same (MarketDataService.cs:1294-1295; MainViewModel.cs:96-105) |
| EQUITY USD / MARGIN LVL | computed client-side: balance+credit from `/me` + live WS ticks, AccountMath.ComputeAccountSummary (MarketDataService.cs:1603-1604) | – | – | every tick of a symbol with an open position (MarketDataService.cs:2197-2198), every positions/history/account refresh |
| Brand (header + window title) | `/broker-branding` `brokerName` | FetchBrokerBrandingAsync ApiClient.cs:177 | broker-branding/route.ts:21 | once at sign-in (MarketDataService.cs:1056-1058) |
| Tape items | GridCandidates = watchlist then every other `/symbols` symbol (MarketDataService.cs:1100-1102, 1262-1274) | FetchWatchlistAsync ApiClient.cs:162; FetchAllSymbolsAsync ApiClient.cs:151 | watchlist/route.ts:6-16; symbols/route.ts:20-56 | rebuilt on each watchlist load |
| Tape price / CHG% | WS bid (OnTick MarketDataService.cs:2195); CHG% vs last D1 row open (1280-1285) | FetchCandlesAsync(sym,"D1") ApiClient.cs:197 | candles/route.ts:22-27 | live per tick; D1 cached 5 min (MarketDataService.cs:1389), fetched sequentially for every GridCandidate (1329-1339) |
| Connection text + dot | PriceStreamClient state, ping (MarketDataService.cs:224-237, 860-867) | FetchWsTicketAsync ApiClient.cs:227 | ws-ticket/route.ts | live |
| UTC clock / sessions | local clock, SessionClock (MarketDataService.cs:1237-1244) | – | – | 1 s timer |
| Update pill | Velopack static feed Brand.UpdateUrl (Services/UpdateService.cs:6; Vyx.Shared.Ui/UpdateService.cs:27-35) — not an app/api route | – | – | on IsLive + every 6 h (MainWindow.axaml.cs:255) |

Empty/loading/error: before sign-in the fixture literals show. If `/me` fails, RefreshCommandBar returns early (MarketDataService.cs:1291) and the live header keeps the fixture literals `A. KHAN`, `−8,096.37`, `DEMO` (MainViewModel.cs:34-38); if branding fails the header keeps `FUTURIX` (MainViewModel.cs:33). Connection cell shows `SIGNING IN…`, `CONNECTING…`, `RECONNECTING… (attempt n)`, `OFFLINE`, `SIGNED OUT` (MarketDataService.cs:861-866, 961, 1017).
No FX conversion anywhere in the terminal (grep `QuoteCurrency|conversionRate` in E:\vyxtrader\src = 0 hits); the server converts quote→account currency (lib/margin.ts:69-73) and `/symbols` does not send `quoteCurrency` (symbols/route.ts:33-56).

## C. Controls
Status convention: WORKS also covers controls that are local by design (Server effect says "local").

| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Command line `FXG> SYMBOL description` | TopBar col 1 (TopBar.axaml:22-28) | always | always | none: RouteFKey("F2") (MainWindow.axaml.cs:237, 305) | none | – | No | No | trader session | MW search box focused; action line `F2 · market watch search` | WORKS |
| THEME cell (`☀ LIGHT` / `☾ DARK`) | TopBar right (TopBar.axaml:100-105) | IsLive | always | none: ThemeService.Toggle(Settings) (MainWindow.axaml.cs:236) | local settings.json `Theme` | – | No | No | – | theme rebound, charts redrawn | WORKS |
| USER cell | TopBar right (TopBar.axaml:106-117) | always | always | opens menu (TopBar.axaml.cs:29-39) | none | – | No | No | – | menu | WORKS |
| Switch account… | USER menu | always | always | Market.SignOutAsync → POST /api/trade/logout (ApiClient.cs:130-133) | logout/route.ts:4-21: Redis session revoked, cookie deleted | – | Yes, always: `SWITCH ACCOUNT` / `Return to sign-in? Saved credential kept.` (MainWindow.axaml.cs:238) | No | – | process relaunched to sign-in (MainWindow.axaml.cs:692-694) | DUPLICATE (identical SignOutAsync(false) as "Sign out", MainWindow.axaml.cs:238 vs 243-244) |
| Sign out | USER menu | always | always | same as above | same | – | Yes: `SIGN OUT` / `Sign out? Saved credential kept.` | No | – | relaunch | WORKS |
| Sign out and forget this computer | USER menu | always | always | same + CredentialStore.Delete(host) and ("session:"+host), RememberMe=false (MainWindow.axaml.cs:691) | same + local credential removed | – | Yes: `SIGN OUT AND FORGET` / `Sign out and remove the saved credential from this PC?` | No | – | relaunch | WORKS |
| Minimise | caption (TopBar.axaml:120; CaptionButtons.axaml.cs:16) | IsLive | always | none | local | – | No | No | – | minimised | WORKS |
| Maximise / restore | caption (CaptionButtons.axaml.cs:17-23) | IsLive | always | none | local | – | No | No | – | toggled, glyph synced (WindowChrome.cs:32-34) | WORKS |
| Close ✕ | caption (CaptionButtons.axaml.cs:24) | IsLive | always | Window.Close → Market.Dispose (MainWindow.axaml.cs:288) | none; streams closed | – | No | No | – | app exits; client-side smart rules stop (the updater's own confirm says "armed smart rules will be off", MainWindow.axaml.cs:254) | PARTIAL (no confirm when smart rules are armed) |
| Title bar drag / double-click | TopBar background (WindowChrome.cs:24-31, attached MainWindow.axaml.cs:241-242) | always | not on UserCell/ThemeCell/CommandLine | none | local | – | No | No | – | move / maximise toggle | WORKS |
| Tape item click | Tape live strip (Tape.axaml:9; Tape.axaml.cs:37-40) | IsLive | always | SelectChartAsync → GET /api/trade/candles (ApiClient.cs:197-205) | read only | – | No | No | – | active chart switches symbol | WORKS |
| Tape hover | Tape viewport (Tape.axaml:27-28) | IsLive | always | none | local | – | No | No | – | marquee pauses | WORKS |
| 5 splitters (left, right, bottom mid, bottom left, bottom right) | body gap tracks (MainWindow.axaml:37,43,49,55,56) | always | always | none | local settings.json Layout* (MainWindow.axaml.cs:665-681); caps 300–560 / 268–420 / 120–520 (661-664) | min/max clamps | No | No | – | sizes persisted | WORKS |
| Update pill | status bar (StatusBar.axaml:22-25) | UpdateText non-empty (downloading / ready) | click acts only when ReadyToApply (MainWindow.axaml.cs:254) | Updater.ApplyAndRestart (Vyx.Shared.Ui/UpdateService.cs:67) | none (static feed) | – | Yes: `RESTART TO UPDATE` / `Restart into {ver}? Open positions are unaffected; armed smart rules will be off.` | No | – | restart | WORKS |
| F1 HELP | status bar cell + key (MainWindow.axaml.cs:258, 304) | IsLive (cells) | always | none | none | – | No | No | – | action line help text | PARTIAL (text says `F6 log`, F6 refreshes the calendar; omits F8/F9/F10/F12) |
| F2 WATCH | same (305) | IsLive | always | none | none | – | No | No | – | MW search focused | WORKS |
| F3 CHART | same (306) | IsLive | always | SetGridMode(false) | local | – | No | No | – | single chart | WORKS |
| F4 TICKET | same (307) | IsLive | always | none | none | – | No | No | – | ticket VolumeBox focused | WORKS |
| F5 POSITIONS | same (308) | IsLive | always | none | none | – | No | No | – | dock tab POS | WORKS |
| F6 NEWS | same (309) | IsLive | always | RefreshCalendarAsync → GET /api/trade/news (ApiClient.cs:167) | read only | – | No | No | – | ECO panel rebuilt | WORKS |
| F7 ACCOUNT | same (310) | IsLive | always | RefreshAccountAsync → GET /api/trade/me (ApiClient.cs:140) | read only | – | No | No | – | header + account panel recomputed | WORKS |
| F8 ALERTS | same (311) | IsLive | signed in (MainWindow.axaml.cs:438) | opens AlertsWindow (term-alerts.md) | – | – | No | No | – | modal | WORKS |
| F9 NEW ORDER | same (312) | IsLive | signed in (387) | opens NewOrderWindow | – | – | No | No | – | modal | WORKS |
| F10 REPORTS | same (313) | IsLive | always | none | none | – | No | No | – | action line `F10 · reports (coming soon)` | PLACEHOLDER |
| F11 LAYOUT | same (314) | IsLive | always | SetGridMode(!IsGridMode) | local | – | No | No | – | single ↔ 2×2 | WORKS |
| F12 SETTINGS | same (315) | IsLive | always | opens SettingsWindow | – | – | No | No | – | modal | WORKS |

## D. Dialogs
- Confirm overlay (shared ChartHost.Confirm, ChartHost.cs:262-278; ChartPanel.axaml:223-239): title, detail, optional note, optional checkbox `Don't ask again until the terminal is restarted` (ChartPanelViewModel.cs:276, shown only when a session key is passed — none of the shell actions pass one), CANCEL, action button. Nothing stored.
- USER menu: disabled header `{UserName} · {AccountNumber} {AccountMode}` (MainViewModel.cs:106), then items (see F). No fields.
- Settings (F12), New order (F9), Alerts (F8) dialogs are covered elsewhere (term-alerts.md; F9/F12 by the ticket/settings audits).

## E. Text
- `FXG> ` command prefix is a literal for every broker (TopBar.axaml:23).
- `EQUITY USD` label is a literal; the value is in the account currency (TopBar.axaml:89; account currency from `/me`, MarketDataService.cs:1584).
- F1 help: `F1 HELP · F2 watch search · F3 chart single · F4 ticket · F5 positions · F6 log · F7 account refresh · F11 layout single/grid` (MainWindow.axaml.cs:304) — F6 is labelled `NEWS` in the status bar (MainViewModel.cs:48) and refreshes the calendar (309).
- `F10 · reports (coming soon)` (MainWindow.axaml.cs:313).
- Window XAML title literal `Futurix Terminal PRO` (MainWindow.axaml:9), replaced at runtime by Brand.Current.ProductTitle / broker name (MainWindow.axaml.cs:247-249).
- Fixture literals that can remain visible live: `A. KHAN`, `−8,096.37`, `DEMO`, `FUTURIX`, `CONNECTED · FUTURIX-DEMO · 257MS` (MainViewModel.cs:33-38, 55).
- Switch-account confirm `Return to sign-in? Saved credential kept.` vs Sign-out `Sign out? Saved credential kept.` — same action (MainWindow.axaml.cs:238, 243).

## F. UI structure map
**Layout** (1920×1015 design, min 1000×560; MainWindow.axaml:10): TopBar / Tape / body / StatusBar. Body 3 columns with a 1 px line between, each column split top/bottom with its own splitter; default bottom docks 232 px.

**TopBar** (TopBar.axaml), left → right:
1. Logo square + brand text (`FUTURIX` until `/broker-branding` answers; upper-cased broker name).
2. Command line: `FXG> ` + chart symbol + description (live). Fixture: `FXG> XAUUSD CURNCY GO`. Tooltip `Symbol search (F2)`. Click = F2.
3. Fixture only (hidden live): `PRO | BASIC` toggle; tags `DES desc`, `MW watch`, `OT ticket`, `POS positions`, `NEWS feed` (TopBar.axaml:30-72).
4. Spacer.
5. Stat cells (header-right): `ACCOUNT` `{number} {mode}` · `EQUITY USD` `{equity}` (green ≥0 / red <0) · `MARGIN LVL` `{n}%` or `—` · `THEME` `☀ LIGHT`/`☾ DARK` (live) · `USER` avatar initials + name + `▾` · caption buttons min / max / close (live).
KPI strip: the ACCOUNT / EQUITY / MARGIN LVL cells above; no other KPI strip in the shell.

**USER menu** (left-click on USER cell; TopBar.axaml.cs:32-38), placement bottom-right, min width 260:
```
{NAME} · {ACCOUNT} {MODE}        (disabled header)
────────────
Switch account…
────────────
Sign out
Sign out and forget this computer
```
No shortcuts, no submenus. Right-click on the title bar: NO menu (WindowChrome only handles left drag / double-click).

**Tape**: fixed label `TAPE`, then (live) a right-to-left marquee at 38 px/s (Tape.axaml.cs:17) of cells `SYMBOL price ±x.xx%` (green/red), copies repeated to fill the width (2–12 copies, Tape.axaml.cs:194). Hover pauses; click opens the symbol on the active chart. Right-click: NO. Fixture: static list (XAU, US30, BTCUSD, …, DXY; MainViewModel.cs:114-127).

**Body**: no table in the shell itself.

**StatusBar** (StatusBar.axaml), left → right: dot (green = price stream connected) + connection text (`{Broker} · Live|Demo · {ping}MS`); `HH:mm:ss UTC` (live); open sessions text (amber, or `NO SESSION`) + update pill (only while downloading / ready; accent fill when ready); spacer; F-key cells `F1 HELP · F2 WATCH · F3 CHART · F4 TICKET · F5 POSITIONS · F6 NEWS · F7 ACCOUNT · F8 ALERTS · F9 NEW ORDER · F10 REPORTS · F11 LAYOUT · F12 SETTINGS` (live, clickable; MainViewModel.cs:45-50). Fixture cells are the same except `F9 BOTS` and not clickable (MainViewModel.cs:129-134). Right-click anywhere in the status bar: NO.

**Keyboard**: F1–F12 routed globally (MainWindow.axaml.cs:258); Esc / Delete go to the chart host (259); STM buy/sell hotkeys when STM enabled (262-266, ticket audit).

## Issues
[money] shell · EQUITY / MARGIN LVL are computed client-side with no quote→account FX conversion (P&L = price diff × contract × lots in quote currency) while the server converts every leg (lib/margin.ts:69-73); `/symbols` sends no quoteCurrency · MarketDataService.cs:1603-1604; Vyx.Shared/Trading/AccountMath.cs:72-78; app/api/trade/symbols/route.ts:33-56
[text] shell · `EQUITY USD` label is a literal regardless of the account currency · Views/TopBar.axaml:89
[text] shell · command-line prefix `FXG> ` is a literal shown for every broker · Views/TopBar.axaml:23
[ux] shell · when `/me` or `/broker-branding` fails the live header keeps design-fixture values (`A. KHAN`, `−8,096.37`, `DEMO`, `FUTURIX`) · ViewModels/MainViewModel.cs:33-38; Services/MarketDataService.cs:1291
[text] shell · F1 help text says `F6 log` (F6 refreshes the calendar) and omits F8/F9/F10/F12 · MainWindow.axaml.cs:304,309
[functional] shell · F10 REPORTS is a placeholder (`reports (coming soon)`) · MainWindow.axaml.cs:313
[functional] shell · window close ✕ has no confirm although client-side smart rules stop with the process · Vyx.Shared.Ui/CaptionButtons.axaml.cs:24; MainWindow.axaml.cs:254,288
[ux] shell · "Switch account…" performs exactly the same action as "Sign out" · MainWindow.axaml.cs:238,243-244
[ux] shell · tape lists every enabled symbol (not only the watchlist) and a D1 candle GET is issued sequentially for every one of them on each watchlist load · Services/MarketDataService.cs:1101-1102,1267,1329-1331
[text] shell · XAML window title literal `Futurix Terminal PRO` (runtime-replaced) · MainWindow.axaml:9; MainWindow.axaml.cs:247

## Status counts
`STATUS-COUNTS app=terminal screen=shell WORKS=22 PARTIAL=2 UI-ONLY=0 PLACEHOLDER=1 DEAD=0 DUPLICATE=1`
