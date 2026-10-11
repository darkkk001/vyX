# VYX-AUDIT-ALL part 9/9


<!-- ===== ui-map.md ===== -->

# UI map: section F of every screen (backoffice, then terminal)

---

# bo-SHELL

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

---

# bo-DASH

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

---

# bo-RPT

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

---

# bo-NTF

Layout: PageGrid columns * / 380. Left "1) NTF  NOTIFICATIONS"; header right in order: stat "{n} UNREAD · {n} TOTAL" (accent when unread), MARK ALL READ (plain), status text. Filter bar: chips ALL (default lit) · UNREAD; search "title · body · type" right.
Table columns: READ | WHEN | TYPE | TITLE | BODY | ENTITY. Sortable all; default order createdAt desc (server). Single selection (default newest); no checkbox. Click = detail; double-click = open record (+mark read); Enter: nothing. Per-row: READ shows "UNREAD" chip (accent) or blank; WHEN relative age ("now", "5m", "3h", "yesterday", "4d ago").
Right-click on row: YES — header = notification title (disabled), separator, "Open the record" (disabled when no target), "Mark read" (disabled when read), "Reset trader password…" (only for PASSWORD_RESET_REQUESTED with an entity). No shortcuts.
Right-click on multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Right "2) DETAIL  NOTIFICATION": title (bold, wraps), body, rows state · type · entity · created, then button row: OPEN {CODE} or REVIEW KYC (primary/orange, when a target exists), MARK READ (when unread), RESET PASSWORD (danger red text, PASSWORD_RESET_REQUESTED only); "NO LINKED SCREEN" block when no target.
Empty: "no notifications yet" / "nothing matches the current filters" / "SELECT A NOTIFICATION". Loading: page veil. Error: header status.

---

# bo-EXP

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

---

# bo-DEAL

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

---

# bo-DLS

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

---

# bo-SYM

Layout: page grid rows 220 px / * (SymbolsScreen.cs:60). Header title per shell: "Symbols" code SYM.
- Panel 1 header: "1) LIM" · "EXPOSURE LIMITS · NET LOTS PER SYMBOL"; header-right: none. No KPI strip.
- Panel 2 header: "2) SYM" · "SYMBOLS · SPREADS · SESSIONS"; header-right: stat "<n> ENABLED · <n> TOTAL" (:107), Status text. Below: filter bar (chips), then save bar (hidden until a row is staged: text "<n> SYMBOL(S) CHANGED · NOT SAVED", buttons DISCARD, SAVE CHANGES primary/orange) (:51-54, :106), then grid.

Table 1 (LIM, layout "sym-hedge"): columns SYMBOL · NET LIMIT · NOW · STATUS (:55-56). Values: "<n> LOTS" or "—"; NOW signed "+x"/"−x"; STATUS OK / NEAR LIMIT / OVER LIMIT / NO LIMIT. All headers sortable (click), no default sort (server order = name asc). Selection single, no checkbox. Row click: select only; double-click: nothing; Enter: nothing. Right-click on row: NO (no handler). Right-click empty area: NO. Right-click column header: YES, column picker ("COLUMNS" disabled header, separator, one checkbox item per column, separator, "Reset columns") (DataTable.cs:89, :303-318). Empty: "no symbols".

Table 2 (SYM, layout "symbols", persisted per user :46-47): columns SYMBOL · CATEGORY · DIGITS · MARKUP · COMMISSION / LOT · SWAP LONG · SWAP SHORT · MINIMUM LOT · MAXIMUM LOT · STEP · MAXIMUM EXPOSURE · HEDGED MARGIN % · TRADING MODE · SESSIONS · ENABLED · (blank header: state "CHANGED") (:41-43). All sortable, no default sort (server order name asc). Selection single, no checkbox. Row click: select. Double-click: per cell (see C); DIGITS/SYMBOL/CATEGORY/state: nothing. Enter: only inside the inline editor. Per-row badges: TRADING MODE chip, ENABLED ON/OFF chip, "CHANGED" chip, SESSIONS "EDIT…" orange text. Right-click on row: YES —
  header "<SYMBOL>" (disabled) / separator / "Trading sessions…" (enabled when BrokerSymbolId set) / "Disable (stage)" or "Enable (stage)" / "Revert this row" (visible only when staged) (:181-189). No shortcuts, no submenus.
Right-click multi-selection: n/a (single select). Right-click empty area: NO (no TableActions). Right-click column header: YES, column picker as above. Empty: "no symbols". Loading: shell LOADING veil (Screen.cs:66-76).
Filter chips (in order): ALL (default) · each distinct CATEGORY upper-case, alphabetical · ENABLED · DISABLED (:88).
Toolbar buttons: none besides the save bar.

---

# bo-GRP

Layout: two columns * / * (GroupsScreen.cs:49). No KPI strip.
Panel 1 header: "1) GRP" · "GROUPS"; header-right: stat "<n> GROUPS · <n> HALTED", stat "DESK <state>", Status text, button "+ GROUP" (primary/orange) (:47, :79-84).
Table GRP (layout "groups"): NAME · ROUTING · PRICING · DEALER · TRADING · DEFAULT · STATUS (:39-41). Values: ROUTING A-BOOK · LP / B-BOOK / DEALING DESK / REVERSAL / COVERAGE · SYS; PRICING "Source" or "Custom (n symbols)"; DEALER AUTO-FILL / MANUAL / BROKER DEFAULT (+ " · FORCED", " · MIRROR"); TRADING chip BOTH SIDES / BUY ONLY / SELL ONLY; DEFAULT "DEFAULT" chip; STATUS chip TRADING / HALTED. All headers sortable, no default sort (server name asc). Single select, no checkbox. Row click: select + load PRC. Double-click: nothing extra. Enter: nothing. Right-click on row: YES —
  "<Group name>" (disabled) / separator / "Edit group…" / "Allowed symbols…" / "Delete group…" (enabled when not default) / separator / "Halt trading…" or "Resume trading…" (:137-158).
Right-click empty area: YES — "GROUPS" (disabled) / separator / "Add new group…" (:42, Screen.cs:121-134). Right-click column header: YES, column picker (DataTable.cs:303-318). Empty: "no groups".
Panel 2 header: "2) PRC" · "PRICING OVERRIDES"; header-right: selected group name (accent). Under header: precedence text line (PricingPanel.cs:53-57).
Table PRC (layout "group-pricing-v2"): SYMBOL · RAW · PTS · MODE · VALUE · PTS · CLIENT SPREAD · PTS · SOURCE · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ACTIONS (PricingPanel.cs:46-50). MODE chip TARGET / MARKUP / INHERIT; VALUE "= x" (target) or "+ x"; SOURCE THIS GROUP / BROKER SYMBOL; comm/swaps own value or "inherits"; ACTIONS "EDIT" (orange text, not a separate button: double-click anywhere on the row opens the dialog). Sortable headers, no default sort. Single select. Row click: select; double-click: pricing dialog; Enter: nothing. Right-click on row: YES —
  "<Group> · <SYMBOL>" (disabled) / separator / "Edit pricing…" / "Reset override (inherit)…" (enabled when the row has an override) (PricingPanel.cs:149-163).
Right-click empty area: NO. Right-click header: YES, column picker. Empty: "select a group" / "loading…" / "no enabled symbols".
Dialog buttons: CREATE / SAVE (form), SAVE (pricing), "SAVE" (allowed symbols). Filter chips: none.

---

# bo-ATY

Layout: two columns * / * (:41). No KPI strip.
Panel 1 header: "1) ATY" · "ACCOUNT TYPES"; header-right: stat "<n> TYPES · <n> ENABLED", Status, button "+ TYPE" (primary/orange).
Table ATY (layout "account-types"): NAME · DESCRIPTION · PRICING · MARKUP · PTS · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ORDER · DEFAULT · STATUS (:32-33). DEFAULT chip "DEFAULT"; STATUS chip ENABLED / DISABLED. Sortable headers, no default sort (server sortOrder asc). Single select, no checkbox. Row click: select + load PRC. Double-click / Enter: nothing. Right-click on row: YES —
  "<Type name>" (disabled) / separator / "Edit…" / "Disable…" or "Enable…" (:68-77).
Right-click empty area: YES — "ACCOUNT TYPES" (disabled) / separator / "Add new type…". Right-click header: YES, column picker. Empty: "no account types yet".
Panel 2 header: "2) PRC" · "PRICING OVERRIDES"; header-right: selected type name. Precedence text line: "WHO DECIDES A CLIENT'S SPREAD: account › THIS ACCOUNT TYPE · symbol › this type's default › the client's group › broker symbol. …" (PricingPanel.cs:62).
Table PRC (layout "account-type-pricing-v2"): SYMBOL · RAW · PTS · MODE · VALUE · PTS · CLIENT SPREAD · PTS · SOURCE · COMMISSION / LOT · SWAP LONG · SWAP SHORT · ACTIONS. SOURCE THIS TYPE · SYMBOL / TYPE DEFAULT / CLIENT'S GROUP; CLIENT SPREAD "per group" when the group decides; comm/swaps own value, "<x> (type)", or "inherits". Sortable, single select. Double-click: dialog. Right-click row: YES — "<Type> · <SYMBOL>" (disabled) / separator / "Edit pricing…" / "Reset override (inherit)…" (enabled when HasOverride). Right-click empty area: NO. Header: column picker. Empty: "select an account type".
Because every type created here has flat markup 0 (non-null), SOURCE for rows without a per-symbol override shows "TYPE DEFAULT +0", never "CLIENT'S GROUP" (PricingPanel.cs:113-117).

---

# bo-MIR

Layout: single panel. Header: "1) MIR" · "MIRROR · REVERSE TRADING RULES"; header-right: stat "<n> ACTIVE OF <n>" (green when any active), Status, button "+ RULE" (primary/orange). No KPI strip, no filter chips.
Table (layout "mirror-rules"): SOURCE · DIRECTION · TARGET ACCOUNT · MULTIPLIER · FILL PRICE · SYMBOLS · LIMITS · STATUS · SINCE · ACTIONS (:116-118). SOURCE "<ACCOUNT|GROUP> · <label>"; DIRECTION amber for REVERSE; MULTIPLIER "× n"; SYMBOLS list or "ALL"; LIMITS "max n lots · loss n/day" or "—"; STATUS chip ACTIVE / DISABLED / KILLED; ACTIONS "DISABLE"/"ENABLE" (empty for KILLED). Sortable headers, no default sort (server order). Single select, no checkbox. Row click: select. Double-click: only on the ACTIONS cell (toggle); elsewhere nothing. Enter: nothing. Right-click on row: YES —
  "<source> → <target>" (disabled) / separator / "Disable…" or "Enable…" (disabled when KILLED) / "Edit multiplier / fill / symbols…" (:146-153).
Right-click empty area: YES — "MIRROR RULES" (disabled) / separator / "Add new mirror rule…" (:122). Right-click header: YES, column picker. Empty: "no mirror rules".

---

# bo-RISK

Layout: KPI row (4 equal tiles) / body: left 380 px settings, right margin watch (:46-51).
KPI tiles in order: OPEN EXPOSURE · FLOATING P/L · CLIENTS · OPEN POSITIONS · ACCOUNTS AT RISK.
Panel 1 header: "1) RISK" · "BROKER RISK SETTINGS"; header-right: Status. Body sections: DEALING MODE (Manual dealing + TURN ON/OFF button; Smart dealer accept %; Smart dealer reject % + EDIT), EXPOSURE & POSITION LIMITS (Total exposure limit; Max open positions / account + EDIT), TRADING STATE (Trading + EMERGENCY; Close-only).
Panel 2 header: "2) MRG" · "MARGIN WATCH · LOWEST FIRST"; header-right: stat "<n> WITH POSITIONS · <n> AT RISK", button "FULL MARGIN SCREEN" (not primary).
Table (layout "risk-margin", RiskScreen.cs:157-159): ACCOUNT · CLIENT · EQUITY · USED MARGIN · FREE MARGIN · POSITIONS · EXPOSURE · FLOATING PROFIT / LOSS · MARGIN LEVEL · STATUS. STATUS chip NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK (:162). Sortable headers, no default sort (server level asc). Single select. Row click: select; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360" / "Live exposure · this account" / separator / "Close all <n> positions…" (enabled when n > 0) (:143-156).
Right-click empty area: NO. Header: column picker. Empty: "no accounts with positions". Buttons: TURN ON/OFF, EDIT ×2, EMERGENCY, FULL MARGIN SCREEN; none primary.

---

# bo-RDR

KPI tiles in order: ACCOUNTS TRACKED · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS TRADER · SAME-IP CLUSTERS · TOP PROFIT / DAY (:300, :312).
Panel 1 header: "1) RDR" · "RISK RADAR · 30-DAY BEHAVIOUR"; header-right: stat "<shown> OF <total> · <n> SAME-IP", Status. Filter bar chips in order: ALL (default) · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS.
Table (layout "risk-radar"): ACCOUNT · FLAGS · WHICH · TRADES · 30D · WIN RATE · AVERAGE HOLD · AVERAGE LOT · P/L PER DAY (:306-307). FLAGS chip — / LOW / MED / HIGH. Sortable headers; default = client order (flag count desc, P/L per day desc). Single select (first load auto-selects the top row, :335). Row click: detail; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc>" (disabled) / separator / "Flags · stats (detail)" / "Open client 360" / "Live exposure" (:310).
Right-click empty area: NO. Header: column picker.
Panel 2 header: "2) ACCT" · "FLAGGED ACCOUNT". Body: account; score; section FLAGS · 30 DAYS (Scalper / Martingale / Latency arbitrage / News trader: FLAGGED or clear); section STATS (trades, win rate, avg hold, avg lot, profit velocity / day, same-IP clusters); buttons OPEN CLIENT (primary/orange), EXPOSURE; "FLAG · WHITELIST · NOTE — not available yet"; section "SAME-IP CLUSTERS · <n>" with up to 20 clusters, each "<ip> <n> ACCOUNTS" and account links; "NONE" when empty; "SELECT AN ACCOUNT" when nothing selected.

---

# bo-EMG

Layout: PageGrid columns * / *, rows 190 / *.
Top-left "1) HALT  HALT ALL NEW TRADING" (header right: status text): note sentence; row "status" (TRADING NORMALLY green / HALTED · NO NEW TRADING red / —); button HALT ALL NEW TRADING (danger) or RESUME ALL TRADING (primary/orange) + hint "type the tenant name to confirm"; block "KICK ALL CLIENT SESSIONS · INCIDENT TIMELINE" / "not available yet".
Top-right "2) CLOSE-ONLY  CLOSE-ONLY MODE": note; row "status" (OPENS ALLOWED / CLOSE-ONLY · OPENS BLOCKED); button ENABLE CLOSE-ONLY (danger) or RESUME NORMAL TRADING (primary) + hint; row "manual dealing" ("ON · orders wait for a dealer" amber / "OFF · auto-fill") + link "RISK ›".
Bottom-left "3) GROUPS  HALT ONE GROUP" (header right "{n} OF {m} HALTED"). Table columns: GROUP | TYPE | LEVERAGE | STATUS | ACTIONS. Sortable; default name asc. Single selection; no checkbox. Click: select; double-click on ACTIONS cell: halt/resume; double-click elsewhere: nothing; Enter: nothing. Per-row: GROUP suffix " · default"; STATUS chip TRADING (green) / HALTED (red); ACTIONS "HALT" (red) / "RESUME" (green).
Right-click on group row: YES — no header line; single item "Halt group…" or "Resume group…".
Bottom-right "4) SYMBOLS  DISABLE ONE SYMBOL" (header right "{n} OF {m} DISABLED"); filter bar with search "symbol" only. Table columns: SYMBOL | CATEGORY | TRADING MODE | STATUS | ACTIONS. Sortable; default disabled-first then name. Per-row: TRADING MODE chip (BOTH grey, BUY ONLY / SELL ONLY amber); STATUS ENABLED (green) / DISABLED (red); ACTIONS "HALT" (red) / "RE-ENABLE" (green). Double-click on ACTIONS cell toggles.
Right-click on symbol row: YES — no header line; single item "Halt symbol…" or "Re-enable symbol…".
Right-click on multi-selection: NO. Empty area: NO. Column header: YES (both) — "COLUMNS", checkbox per column, "Reset columns".
Empty: "no groups", "no symbols", "no symbols match". Loading: page veil. Error: header status (risk) / toasts (groups, symbols).

---

# bo-MRG

Layout: one full panel. Header: "1) MRG" · "MARGIN · LOWEST LEVEL FIRST"; header-right: stat "<n> ACCOUNTS · <n> AT OR BELOW MARGIN CALL" (red when > 0), Status. No KPI strip, no chips, no toolbar buttons.
Table (layout "margin"): ACCOUNT · CLIENT · EQUITY · USED MARGIN · FREE MARGIN · POSITIONS · EXPOSURE · FLOATING PROFIT / LOSS · MARGIN LEVEL · STATUS (RiskScreen.cs:157-159). MARGIN LEVEL "<n>%" or "—"; STATUS chip NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK. Headers sortable (click); default order = client sort (level asc). Single select, no checkbox. Row click: select; double-click: CLI; Enter: nothing. Live cells flash on change (DataTable.cs:193-201). Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360" / "Live exposure · this account" / separator / "Close all <n> positions…" (enabled when n > 0) (:143-156).
Right-click empty area: NO. Right-click header: YES, column picker. Empty: "no accounts with positions".

---

# bo-LP

Layout: columns * / 460 (:69). No KPI strip, no chips.
Panel 1 header: "1) LP" · "LIQUIDITY PROVIDERS"; header-right: stat "<n> LPS · <n> ACTIVE", Status, button "ROUTING", button "+ LP" (primary/orange).
Table LP (layout "lps"): PROVIDER · PROTOCOL · STATUS · ROUTING RULES · CONTACT · SINCE (:60). STATUS chip (always neutral "b"). Sortable headers, no default sort (server createdAt desc). Single select. Row click: select; double-click: ROUTE; Enter: nothing. Right-click on row: YES —
  "<LP name>" (disabled) / separator / "Status: PROSPECTIVE" / "Status: NEGOTIATING" / "Status: CONTRACTED" / "Status: CONNECTED" (the current one disabled) / separator / "Notes…" (:92-100).
Right-click empty area: YES — "LIQUIDITY PROVIDERS" (disabled) / separator / "Add new LP…" (:67). Header: column picker. Empty: "no liquidity providers configured" or "providers: <error>".
Panel 2 header: "2) BOOK" · "BOOK EXPOSURE · OPEN LOTS"; header-right: stats "A <money>" (accent) and "B <money>" (blue) — lot totals formatted with Ui.Money (:115).
Table BOOK (layout "book-exposure"): SYMBOL · A-BOOK LOTS · B-BOOK LOTS · TOTAL · A-BOOK % (:61). Sortable, single select. Row click: select; double-click: EXP; Right-click on row: YES — "<SYMBOL>" (disabled) / separator / "Live exposure · this symbol" / "Symbol settings" (:65). Right-click empty area: NO. Header: column picker. Empty: "no open positions · nothing on either book".

---

# bo-ROUTE

Layout: columns * / 380 (:157). No KPI strip.
Panel 1 header: "1) ROUTE" · "ROUTING RULES"; header-right: stat "<n> RULES · <n> LPS" (amber when > 0), button "+ RULE" (primary/orange). No Status element in this header. Filter bar: label "planned · not executed yet" (no chips).
Table (layout "route-rules"): PRIORITY · RULE · SYMBOL · LIQUIDITY PROVIDER · ENABLED (:27). RULE "<LP> · <SYMBOL>" or "<LP> · default"; SYMBOL name or "ANY"; LIQUIDITY PROVIDER "<LP> · <status>"; ENABLED chip ON/OFF. Sortable headers, no default sort (client priority order). Single select. Row click: detail; double-click: nothing; Enter: nothing. Right-click on row: YES —
  "<LP> · <SYMBOL|ANY>" (disabled) / separator / "Delete rule…" (:140-147).
Right-click empty area: YES — "ROUTING RULES" (disabled) / separator / "Add new routing rule…" (:155). Header: column picker. Empty: "no routing rules · none saved on the server yet".
Panel 2 header: "2) RULE" · "SELECTED RULE". Body: rows priority / liquidity provider / LP record status / symbol / route "A-BOOK (LP)" / created; section NOTES; "CONDITIONS · EDIT / DELETE — not available yet"; button "OPEN LP". Empty: "SELECT A RULE".

---

# bo-FEED

KPI tiles in order: TRADING CORE · GATEWAY · PRICE ALERTS · SYMBOLS TICKING · STALE · > 60 S · EA → ENGINE p50 / p95 · ROUND TRIP · ORDER ACK p50 / p95 (:198, :205).
Panel 1 header: "1) CORE" · "TRADING CORE · FEED STATS"; header-right: Status. Body rows: EA → engine last / p50 / p95; p99 / max; samples; ticks in; queue length; dropped invalid / missing t0; NATS out / publish failures; candle write failures; DB ok / fail (lag); round-trip time; mono → UTC offset — or "NO SNAPSHOT · trading core not reachable".
Panel 2 header: "2) GW" · "API GATEWAY". Rows: WS connections / disconnections; ticks forwarded; NATS messages received; order-ack p50 / p95; order-ack samples — or "NO SNAPSHOT · gateway not reachable".
Panel 3 header: "3) ALERTS" · "PRICE-ALERT ENGINE". Rows: active alerts; triggered (total); persist failures; hot-reload add / cancel / malformed — or "NO SNAPSHOT · alert-stats not answering" / "… core not reachable".
Panel 4 header: "4) SYM" · "PER-SYMBOL FEED"; header-right: stat "<n> LIVE · <n> STALE" or "CORE NOT REACHABLE".
Table (layout "feed-symbols"): SYMBOL · TICKS · 60 S · LAST TICK · BID · ASK · SOURCE · FEED (:202). LAST TICK tone green/amber (>5 s)/red (>60 s); FEED chip LIVE / STALE. Sortable headers, default = client order (live first). Single select. Row click: select; double-click: SYM; Enter: nothing. Right-click on row: YES — "<SYMBOL>" (disabled) / separator / "Symbol settings" / "Live exposure · this symbol" (:204). Right-click empty area: NO. Header: column picker. No toolbar buttons, no chips.

---

# bo-CLI

(PART 1 and PART 2 share this section; see PART 2 for the detail view.)

---
# PART 2 — CLIENT 360 (detail view)

## B. Data (Client 360)
Opening a client calls six requests in parallel (ClientsScreen.cs:166-168), re-run on every live event of topics order/position/account while a client is open (ClientsScreen.cs:109-117) and on every EQ range change (:215).
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters/sort | Limits | Empty/error/loading |
|---|---|---|---|---|---|---|---|
| 1) CLI card | row from the list (no own fetch) + GET accounts/{id}/risk + GET accounts/{id}/security | FetchAccountRiskAsync ApiClient.ManageG1.cs:185-189; FetchAccountSecurityAsync :167-171 | accounts/[id]/risk/route.ts:1-65; accounts/[id]/security/route.ts:10-36 | with list events | — | security: last 50 LoginEvents (security/route.ts:23-28) | Risk score "—" and Last IP "—" (muted) until/unless the call succeeds (ClientsScreen.cs:187, 288-289); a failed call is silently shown as "—" (:172-173) |
| 2) EQ BALANCE CURVE | GET accounts/{id}/equity-curve?days=N | FetchAccountEquityCurveAsync ApiClient.ManageG1.cs:175-183 | accounts/[id]/equity-curve/route.ts:16-48 | on open, range chip, live event | window 7/30/90/365 d (ClientsScreen.cs:202); server caps 365 (route.ts:13, 33) | every Transaction in window + current balance point (route.ts:36-43) | error → "BALANCE CURVE · <W>" + friendly error; <2 points → "not enough history in this window" (ClientsScreen.cs:227-228) |
| 3) TRD TRADES | GET /api/manage/positions (broker-wide) + GET /api/manage/deals (broker-wide, no filter) | FetchManagePositionsAsync ApiClient.ManageG1.cs:224-232; FetchDealsAsync() :203 | positions/route.ts:47-164; deals/route.ts (take 500, :71) | on open / events; NOW + P/L repriced from ticks ≤1/s (ClientsScreen.cs:240-246) | client-side filter by AccountId / AccountNumber (ClientsScreen.cs:170-171); open first, then closed | closed rows: first 50 of this account's deals within the broker-wide latest 500 (deals/route.ts:71; ClientsScreen.cs:258) | "no trades" (:75) |
| 4) LED LEDGER | GET accounts/{id}/activity | FetchAccountActivityAsync ApiClient.ManageG1.cs:156-165 | accounts/[id]/activity/route.ts:22-93 | on open / events | only timeline rows with kind "Ledger" (ClientsScreen.cs:335) | server: last 50 transactions (activity/route.ts:40); client shows ≤80 (:335) | error → friendly error or "ledger unavailable"; empty "no ledger entries" (:332) |
| 5) NOTE NOTES · CRM | none | — | — | — | — | — | "CRM NOTES · NOT AVAILABLE YET" (ClientsScreen.cs:95; Ui.cs:176) |
| 6) SES SESSIONS · DEVICES · IP | GET accounts/{id}/security | as above | security/route.ts | on open / events | newest first (route.ts:25) | 50 | "NO LOGIN HISTORY" / "no logins recorded" (ClientsScreen.cs:198). Login events only — no live-session list, no revoke (security/route.ts:5-9) |

Equity in Client 360: there is no Equity row on the card (rows: Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP — ClientsScreen.cs:282-289). Panel 2 is labelled EQ but plots BALANCE only: the server returns Transaction.balanceAfter points plus the current balance and says so ("a live-floating equity curve would need periodic floating-P&L snapshots, which this codebase does not store", equity-curve/route.ts:5-10, 42-43). "—" in TRD: PRICE and PROFIT / LOSS of an open row show "—" when the server had no fresh price (LivePrice tickAt older than 15 s → currentPrice/floatingPnl null, positions/route.ts:101-110, 150-151; lib/live-price.ts:122-137) and no tick has arrived since (ClientsScreen.cs:255-256).

## C. Controls (Client 360)
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| "CLIENTS" breadcrumb | card header right (ClientsScreen.cs:85-87) | detail | always | none | — | — | no | no | none | back to list | WORKS |
| CREDIT / DEBIT | card action grid r1c1 (:297) | detail | always | AdjustBalanceAsync POST /api/manage/accounts/{id}/adjust-balance {amount signed "0.00", note} (ApiClient.ManageG6.cs:68-73) | BROKER_ADMIN: Account.balance, Transaction type ADJUSTMENT COMPLETED with balanceBefore/After + note, AuditLog BALANCE_ADJUSTMENT (lib/balance-adjustment.ts:46-86); then NATS BalanceChanged (adjust-balance/route.ts:80). MANAGER: BalanceAdjustmentRequest PENDING + AuditLog BALANCE_ADJUSTMENT_REQUESTED, 202 (adjust-balance/route.ts:63-68; lib/balance-adjustment.ts:89-116). Touches Account.balance only — never Account.credit. No NBP, no notification | client: amount >0, note required (ClientsScreen.cs:477, 485); server: amount ≠0, note required, trimmed to 500 (route.ts:53-61). No floor: a debit may take balance below 0 or below used margin (balance-adjustment.ts:51-53) | no confirm (form only) | YES for MANAGER (balance-adjustment.ts:40-42) | server BROKER_ADMIN or ACCOUNT_FINANCE (route.ts:35); client none | toast; badges refresh (:483) | PARTIAL (success toast reads `balanceAfter` (ApiClient.ManageG6.cs:72) but server returns `balance` (route.ts:87) → "applied · balance " with an empty value) |
| CHANGE GROUP | action grid r1c2 (:298) | detail | always | PatchAccountAsync PATCH /api/manage/accounts/{id} {groupId} (ApiClient.ManageG6.cs:114-115) | Account.groupId AND Account.leverage := group.leverage (accounts/[id]/route.ts:161-175); AuditLog ACCOUNT_GROUP_CHANGED; NATS AccountUpdated reason "account" (route.ts:242; lib/account-events.ts:21-25) | client: required; server: group exists, isClientSelectable unless COVERAGE, checkAccountStructure (COVERAGE refused, mode vs group) (route.ts:74-116) | no (form) | no | server MANAGER or BROKER_ADMIN (no finance permission) (route.ts:28-61) | toast + refetch | PARTIAL (picker lists every group — not SelectableGroups — so non-selectable/COVERAGE groups are offered and refused by the server (ClientsScreen.cs:490 vs :375); leverage is silently overwritten and not stated in the dialog) |
| LEVERAGE | action grid r2c1 (:299) | detail | always | PatchAccountAsync {leverage} | Account.leverage; AuditLog LEVERAGE_CHANGE; AccountUpdated (route.ts:186-193, 242) | client LeverageInput rule (:543); server parseLeverage (route.ts:119-124) | no (form) | no | server BROKER_ADMIN or ACCOUNT_FINANCE (route.ts:56-61) | toast + refetch | WORKS |
| RISK LIMITS | action grid r2c2 (:300) | detail | always | PatchAccountAsync {swapFree: true/false/null, maxDailyLoss: string/null} (ClientsScreen.cs:505-508) | Account.swapFree (tri-state) + AuditLog ACCOUNT_SWAP_FREE_CHANGED; Account.maxDailyLoss + AuditLog ACCOUNT_MAX_DAILY_LOSS_CHANGED; AccountUpdated (route.ts:202-220, 242) | client: number field; server: maxDailyLoss >0 or null (route.ts:134-148) | no (form) | no | body always contains maxDailyLoss → counted as a finance change → BROKER_ADMIN or ACCOUNT_FINANCE even to toggle swap-free only (route.ts:47, 56) | toast + refetch | PARTIAL (form never shows current values: swap-free default comes from a null-coerced bool so "GROUP DEFAULT" reads as NO (ApiClient.ManageG1.cs:40; ClientsScreen.cs:501); max-daily-loss default is always "" so any save CLEARS an existing limit (ClientsScreen.cs:502, 507; route.ts:136-137)) |
| STATEMENT CSV | action grid r3c1 (:301) | detail | always | FetchManagePositionsAsync + FetchDealsAsync() + FetchAccountActivityAsync (ClientsScreen.cs:516-517) → local save dialog | none (read only) | — | no | no | server MANAGER/BROKER_ADMIN | file saved, toast | PARTIAL (closed deals come from the broker-wide latest 500 (deals/route.ts:71) filtered locally — older deals of the client are missing, though the API accepts accountId (deals/route.ts:14); "LEDGER" section writes every timeline row incl. admin actions, orders and positions (ClientsScreen.cs:528-529); fetch failures produce empty sections with no message) |
| RESET PASSWORD | action grid r3c2 (:302) | detail | always | ResetTraderPasswordAsync POST accounts/{id}/reset-password (ApiClient.ManageG1.cs:199-200) | Account.passwordHash; AuditLog ACCOUNT_PASSWORD_RESET; revokeAllAccountSessions; broker email with temp password when email + mail configured, else password returned (reset-password/route.ts:41-93) | none | yes "RESET TRADER PASSWORD" (danger) (:448-470) | no | server MANAGER/BROKER_ADMIN | toast "emailed to …" or second dialog showing password once (:453-467) | WORKS |
| SUSPEND / ACTIVATE | action grid r4c1 (:303-304) | detail; label SUSPEND when status ACTIVE, else ACTIVATE | always | SetAccountStatusAsync PATCH accounts/{id} {status} (ApiClient.ManageG1.cs:154-155) | Account.status; AuditLog ACCOUNT_STATUS_CHANGED; AccountUpdated (route.ts:194-201, 242) | server status ∈ ACTIVE/SUSPENDED/CLOSED (route.ts:126-132) | yes (danger when suspending) | no | server BROKER_ADMIN or ACCOUNT_FINANCE | toast + refetch | WORKS (CLOSED accounts show "ACTIVATE"; CLOSED cannot be set from here) |
| EQ range chips 7D / 30D / 90D / 1Y | EQ header (:202-219) | detail | always | re-runs all six detail calls incl. equity-curve?days=N (:215) | none | server clamps 1..365 (equity-curve/route.ts:32-33) | no | no | MANAGER/BROKER_ADMIN | curve redrawn | WORKS |
| TRD row right-click (open row) "Open in Live exposure (modify / close / reverse)" | TRD table (:76-78) | open-position row | always | Shell.Open("EXP", positionId) | — | — | no | no | none | EXP with that position selected (LiveExposureScreen.cs:109-114) | WORKS |
| TRD row right-click (closed row) "Open in Deals (replay / void / delete)" | TRD table (:79) | closed-deal row | always | Shell.Open("DLS", dealId) | — | — | no | no | none | DLS focus (DealsScreen.cs:62) | WORKS |
| LED row click | ledger table (:93) | any row | always | Shell.Open("DEP", accountNumber) | — | — | no | no | none | DEP filtered to account | PARTIAL (every ledger type opens DEP, which lists only DEPOSIT/WITHDRAWAL rows (funds-requests/route.ts:19); ADJUSTMENT/TRADE_PNL/TRANSFER rows land on an unrelated list) |
| 5) NOTE panel | right column bottom (:95) | detail | — | none | — | — | — | — | — | — | PLACEHOLDER |
| Column pickers (trades "client-trades", ledger "client-ledger") | table headers | detail | always | none; not persisted (no LayoutChanged handler for these two) | — | — | no | no | none | columns toggle for this session | WORKS |

## D. Dialogs
### NEW ACCOUNT (form, ClientsScreen.cs:391-441), button CREATE
| Field | Type | Default | Stored in | READ BY | Conditional |
|---|---|---|---|---|---|
| Full name * | text | "" | Account.fullName | backoffice lists, statements, emails | — |
| E-mail * | text | "" | Account.email (lower-cased, accounts/route.ts:137) | reset-password email (reset-password/route.ts:59); TRX same-client check is client-side only (TransfersScreen.cs:70) | — |
| Mode | choice LIVE/DEMO | LIVE | Account.accountMode | checkAccountStructure (lib/account-structure.ts:67-80); TRX mode check (transfers/route.ts:87) | — |
| Group | choice (client-selectable groups; "(default)" suffix) | broker default group else first selectable (:388) | Account.groupId | routing/book (Group.category), pricing, swap (lib/swap-rollover.ts:182) | — |
| Leverage | number, hint "blank = the group's own leverage" | "" | Account.leverage (only if BROKER_ADMIN/ACCOUNT_FINANCE, else group/broker default; accounts/route.ts:269-276) | engine margin (engine/order-management/src/margin_watch.rs, calc.rs — grep hit, exact line UNVERIFIED) | — |
| Opening balance | number | "" | Account.balance + ADJUSTMENT Transaction (account-provisioning.ts:115-130) | ledger, margin | visible only when Mode = DEMO (:401); a hidden field submits "" (FormOverlay.cs:224-226) |
| Country | search (ISO picker; commits code) | "" | Account.country (ISO-2 validated, accounts/route.ts:194-198) | KYC queue display (kyc-requests/route.ts:31) | — |
| Phone | text | "" | Account.phone | KYC queue display (kyc-requests/route.ts:32) | — |
| Password | text (plain, not masked) | random 14 chars (:369, 404) | Account.passwordHash (bcrypt) | account login | — |
| KYC document (optional) | choice none/PASSPORT/NATIONAL ID/DRIVER'S LICENCE | none | KycRecord.documentType | KYC screen | — |
| Document front | file (jpg/png/pdf) | none | blob kyc/{accountId}/front → KycRecord.documentFrontUrl | KYC DOC panel (Bitmap decode — a PDF never renders, KycScreen.cs:198) | three separate fields, one per KYC type (:407-409) |
Not in the form (server accepts): accountTypeId, currency, dateOfBirth (accounts/route.ts:159-213).

### CREDIT / DEBIT (ClientsScreen.cs:475-485), button APPLY; detail line "<acc> · <name> · balance <x>"
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Direction | choice CREDIT (+) / DEBIT (−) | CREDIT | sign of Transaction.amount | ledger TYPE Credit/Debit by sign (ClientsScreen.cs:352) |
| Amount * (hint "USD") | number | "" | Transaction.amount; Account.balance (or BalanceAdjustmentRequest.amount) | margin/equity everywhere |
| Note * (hint "reason — goes to the ledger and the audit log") | note | "" | Transaction.note; AuditLog.newValue.note | LED REASON column (:343) |

### CHANGE GROUP (:490-494), button MOVE — Group (choice, all groups, default current groupId) → Account.groupId (+ leverage overwrite).
### CHANGE LEVERAGE (:538-543), button SAVE — Leverage (number, default current, hint "1:200 → 200") → Account.leverage.
### RISK LIMITS (:499-510), button SAVE
| Field | Type | Default | Stored in | READ BY |
|---|---|---|---|---|
| Swap-free | choice NO / YES / GROUP DEFAULT | "true" if parsed SwapFree else "false" (null inherit → "false") | Account.swapFree (null/true/false) | lib/swap-rollover.ts:242 (resolved swap-free) |
| Max daily loss (hint "USD · empty = no limit · positions close once the day's loss reaches it") | number | "" always | Account.maxDailyLoss | lib/risk.ts:479-496 checkMaxDailyLoss, called from app/api/trade/orders/route.ts:204, orders/[id]/fill/route.ts:117, requote-response/route.ts:175, manage/dealing-queue/[id]/route.ts:291, dealing-desk-toggle/route.ts:221, manage/positions/route.ts (manual open). No reference in engine/ (Rust) — enforcement on engine-routed orders UNVERIFIED. It blocks NEW orders only; open positions are untouched (lib/risk.ts:474-477) |

### Confirm dialogs
RESET TRADER PASSWORD "Reset the password of <acc> · <name>?" RESET (danger) → PASSWORD RESET dialog "…New password:  <pw>\n\nShown once — copy it now." (+ "Email is not configured for this broker — hand it to the client directly.") DONE (:448-466).
SUSPEND ACCOUNT / ACTIVATE ACCOUNT "Suspend <acc> (<name>)?" SUSPEND / ACTIVATE (:303-304).
ACCOUNT CREATED "<name> · <no>\n\nPassword:  <pw>\n\nCopy it now." DONE (:433).

## E. Text
- Panel "2) EQ" titled "BALANCE CURVE" (ClientsScreen.cs:88): code EQ suggests equity; content is balance.
- Card action "CREDIT / DEBIT" (:297) and ledger label "Credit" for positive ADJUSTMENT (:352) while the card also has a separate "Credit" row showing Account.credit (:287): "credit" names two different things; this action never touches Account.credit.
- RISK LIMITS hint "positions close once the day's loss reaches it" (:502) contradicts server behaviour "Existing open positions are untouched -- this only blocks new trading" (lib/risk.ts:474-477).
- Chip "IB" (:133) and card tag "IB" (:277) mean "client of an IB" (hasIbLink = ibLinkAsClient, accounts/route.ts:85).
- Chip "SUSPENDED" includes CLOSED accounts (:141).
- Card section "ACCOUNTS" (:290) always lists the one open account only (:291).
- Column header "ACCOUNT MODE" at 56 px (:51) vs values LIVE/DEMO; "ACTIONS" column shows only the text "OPEN" (:146), not a button.
- Class comment says the rest "is an honest 'not available yet' panel" (:22-23); only NOTE is one.
- Toast "<acc> · +X applied · balance " with blank balance (:484; ApiClient.ManageG6.cs:72 vs adjust-balance/route.ts:87).
- Form hint "demo accounts are seeded with this; live accounts are funded by a deposit" (:401) — backoffice has no "create deposit" action; deposits originate from the trader (app/api/trade/funds-requests/route.ts).

## F. UI structure map
**LIST view**
- Layout: one full-height panel. Header left "1) CLI" + "CLIENTS & ACCOUNTS"; header right: "<n> TOTAL" stat, status text (last refresh "HH:mm:ss UTC" / error), button "+ ACCOUNT" (primary/orange) (ClientsScreen.cs:71, 121). No KPI strip.
- Filter bar: chips ALL · LIVE · DEMO · KYC WAIT · SUSPENDED · IB (default ALL) (:133); search box right "account · name · e-mail" (:29).
  - ALL = all; LIVE/DEMO = accountMode; KYC WAIT = in-app KycRecord status PENDING; SUSPENDED = status ≠ ACTIVE; IB = hasIbLink (:140-141).
- Table "clients": columns in order ACCOUNT · CLIENT · E-MAIL · ACCOUNT MODE · ACCOUNT TYPE · COUNTRY · KYC · GROUP · LEVERAGE · BALANCE · CREDIT · STATUS · ACTIONS (:51-53). Sortable: all; default sort: none (server accountNumber asc). Selection single, no checkbox. KYC shows VERIFIED for APPROVED, NONE for none (DashboardScreen.cs:278). ACTIONS cell text "OPEN" (not clickable separately).
  - Row click → Client 360; double-click → Client 360; Enter → NO.
  - RIGHT-CLICK ON ROW: YES. Menu: header "<accountNumber> · <fullName>" (disabled) / separator / Open client 360 / Live exposure / Deposits · withdrawals / Wallet / separator / Credit / debit… / Change group… / Leverage… / Risk limits… / Statement CSV… / separator / Reset trader password… / Suspend account… (status ACTIVE) or Activate account… (otherwise). All items always enabled; no submenus, no shortcuts (:59-65; Screen.cs:124-134).
  - Right-click on multi-selection: N/A (no multi-select). Right-click empty area: YES — header "CLIENTS & ACCOUNTS" / separator / "Add new account…" (:68). Right-click column header: YES — "COLUMNS" (disabled) / separator / one checkbox per column / separator / "Reset columns".
  - Empty "no accounts match"; loading = status "loading…" + full LOADING… veil on nav; error = header status text.

**DETAIL view (Client 360)**, grid columns 290 | * | 350, rows * | 220 (:98)
- Left column: panel "1) CLI" "CLIENT", header right = breadcrumb "CLIENTS" (accent, clickable) + client name crumb (_crumb is never assigned text — renders empty, :84). Card: name (large), line "CLIENT <no> · <mode> · <country>", tags KYC <status> / <status> / IB / SWAP-FREE / CUSTOM PRICING, rows Email, Group, Account type, Leverage, Balance, Credit, Risk score, Last IP, section "ACCOUNTS" + one row "<no> · <mode>  <balance>", then a 2-column action grid: CREDIT / DEBIT · CHANGE GROUP / LEVERAGE · RISK LIMITS / STATEMENT CSV · RESET PASSWORD / SUSPEND|ACTIVATE (:271-314). SUSPEND in red; RESET PASSWORD/ACTIVATE in accent; others dim. No primary/orange button.
- Middle column top: "2) EQ" "BALANCE CURVE", header right: range chips 7D · 30D · 90D · 1Y (default 90D) + stat "<first> → <last>" (green/red). Body: line chart, no axes, no hover (:229-236).
- Middle column bottom: "3) TRD" "TRADES", header stat "<n> OPEN · FLOATING ±x · WIN y% OF z CLOSED" (:263).
  - Table "client-trades": TICKET · SYM · SIDE · LOTS · OPEN · CLOSE · OPENED · CLOSED · PROFIT / LOSS · NOTE (:74-75). Sortable all; default: open rows then closed newest-first (server order). Open rows: CLOSE = live price, CLOSED = "OPEN" chip, NOTE = "A-BOOK"/"B-BOOK". Closed rows: OPENED always blank (ManageDeal has no openedAt, :259), NOTE = "VOIDED" when voided.
  - Row click: select only; double-click: nothing; Enter: NO.
  - RIGHT-CLICK ON ROW: YES. Open row → header "<ticket> <sym> <side> <lots> · open" / separator / "Open in Live exposure (modify / close / reverse)". Closed row → header "<ticket> <sym> <side> <lots> · closed" / separator / "Open in Deals (replay / void / delete)" (:76-80). Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no trades".
- Right column top: "4) LED" "LEDGER" (no header items). Table "client-ledger": TIME · TYPE · AMOUNT · REASON · STATUS (:91-92). TYPE humanised (Credit/Debit/Deposit/Withdrawal/Neg-bal protect/Commission/Swap/Trade P/L/Transfer in/Transfer out, :350-363). Row click → DEP for this account; double-click nothing; right-click row NO; empty area NO; header YES. Empty "no ledger entries" / error text / "ledger unavailable".
- Right column bottom: "5) NOTE" "NOTES · CRM" — "CRM NOTES · NOT AVAILABLE YET".
- Bottom full width (220 px): "6) SES" "SESSIONS · DEVICES · IP" — log rows "<dd MMM HH:mm:ss> LOGIN <ip> · <user agent>"; empty "NO LOGIN HISTORY / no logins recorded".

---

# bo-CRM

Layout: one panel. Header: "1) CRM" · "LEADS · SALES"; header-right: stat "<shown> SHOWN OF <total> · <n> CONVERTED", Status, button "+ LEAD" (primary/orange). Filter bar: chips OPEN · <n> (default) · NEW · CONTACTED · QUALIFIED · CONVERTED · LOST · ALL, then search box. No KPI.
Table (layout "leads"): NAME · E-MAIL · PHONE · COUNTRY · SOURCE · STATUS · CONVERTED TO · NOTES · CREATED (:89-91). STATUS chip (CONVERTED green, LOST red, NEW amber, others info); CREATED as age. Sortable headers, no default sort (server createdAt desc). Single select. Row click: select; double-click: CLI when converted; Enter: nothing. Right-click on row: YES —
  "<name> · <status>" (disabled) / separator / "Mark NEW" / "Mark CONTACTED" / "Mark QUALIFIED" / "Mark LOST" (each disabled when current or lead CONVERTED) / "Mark CONVERTED → account…" (disabled when CONVERTED) / separator (trailing, nothing after) (:113-121).
Right-click empty area: YES — "LEADS · SALES" (disabled) / separator / "Add new lead…" (:96). Header: column picker. Empty: "no leads".

---

# bo-IB

Layout: PageGrid columns * / 380. Left panel "1) IB  PARTNERS · INTRODUCING BROKERS"; header right in order: stat "{n} PARTNERS · {n} CLIENTS · PAYABLE {x}", status text, PAYOUT RUN (plain), + PARTNER (primary/orange). Filter bar: chips ALL (default lit) · PAYOUT DUE · PER LOT · PERCENTAGE; no search.
Partners table columns: INTRODUCING BROKER ACCOUNT | NAME | COMMISSION PLAN | CLIENTS | ACTIVE | LOTS · MONTH TO DATE | NET DEP · MTD | COMMISSION · MONTH TO DATE | PENDING COMMISSION | ACTIONS. Sortable all; default order payable desc (client). Single selection, no checkbox. Click = select + detail; double-click: nothing; Enter: nothing. ACTIONS shows "VIEW PAY" / "VIEW" (orange text, not a hit target).
Right-click on partner row: YES — header "IB {no} · {name}" (disabled), separator, "Referred clients (detail)", "Pay {x} pending…" (disabled when nothing due), "Edit commission plan…", separator, "Open IB account 360".
Right-click on empty partners area: YES — header "PARTNERS", separator, "Add new partner…".
Right detail panel "2) IB" title "{no} · {NAME}" or "SELECT A PARTNER". Content (scroll): Owner · Plan · Referred clients · Payable now · Last payout ("never" if none) · Sub-IB levels · link · schedule = NOT AVAILABLE; section FUNNEL · MTD -> "NOT AVAILABLE YET"; section REFERRED CLIENTS -> table; action grid of two equal buttons: "PAY {amount}" (left) | "EDIT PLAN" (right).
Referred clients table columns: CLIENT | NAME | PENDING COMMISSION | ACTIONS ("PAY" when >0). Sortable; default pending desc. Click: select only; double-click: pay. Right-click on row: YES — no header line; items "Pay {x} pending…" (disabled when 0) and "Open client {number}". Empty area: NO.
Column header right-click (both tables): YES — "COLUMNS", checkbox per column, "Reset columns". Multi-selection: NO.
Empty: "no IB relationships", "no referred clients", "NO PARTNER SELECTED". Loading: page veil. Error: header status.

---

# bo-KYC

- Layout: two columns — queue (left, *) | DOC (right, 380 px). No KPI strip.
- **1) KYC "VERIFICATION QUEUE"**; header right: stat "NOTHING WAITING" (dim) or "<n> WAITING · OLDEST <age>" (amber), status text. No buttons.
  - Filter bar: tabs IN-APP · <pending> | CLIENT PORTAL · <pending> (default IN-APP); "·"; chips WAITING · APPROVED · REJECTED · ALL (default WAITING).
  - Table "kyc": ID · CLIENT · COUNTRY · LEVEL · DOCUMENTS · STATUS · AGE · ACTIONS (:42). Sortable all; default order pending first, then oldest created first (:100, 104). Single select. ACTIONS cell text "REVIEW" (label only).
  - Row click → select + DOC; double-click → same; Enter NO.
  - RIGHT-CLICK ON ROW: YES — header "<client name>" (disabled) / separator / Review (documents + decision) / Approve… (enabled when PENDING) / Reject… (enabled when PENDING) / separator / Open client 360 (enabled for IN-APP rows only) (:45-52).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "queue is empty".
- **2) DOC** header: "2) DOC" + right title "<ACC> · <NAME>" or "<NAME> · CLIENT PORTAL" or "SELECT A RECORD". Body: IN-APP → section DOCUMENTS (2 tiles FRONT, BACK) / CHECKS rows / DECISION (Level to grant + APPROVE | REJECT buttons or "ALREADY <STATUS>"). PORTAL → SUITABILITY rows / IDENTITY tiles (FRONT, BACK, + ADDRESS PROOF when present) + rows / DECISION. Empty "NO RECORD SELECTED". APPROVE green, REJECT red; no primary/orange.
- Loading: "loading…" status + veil on nav; tiles "LOADING…".

---

# bo-LAR

- Layout: single full-height panel. Header left "1) LAR" "LIVE ACCOUNT REQUESTS"; header right: stat "NONE PENDING" (dim) / "<n> PENDING" (amber), status text. No buttons, no KPI strip.
- Filter bar: chips PENDING · APPROVED · REJECTED · ALL (default PENDING). No search.
- Table "lar": CLIENT · E-MAIL · COUNTRY · PHONE · ACCOUNT TYPE · STATUS · CREATED ACCOUNT · REJECTION REASON · REQUESTED · ACTIONS (:29-30). Sortable all; default pending first then newest. Single select. CREATED ACCOUNT green when set else "—".
  - Row click: select only; double-click: APPROVE confirm (PENDING rows only); Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<name> · <email>" (disabled) / separator / "Approve · create the live account" (enabled when PENDING) / "Reject…" (enabled when PENDING) / "Open account <no>" (only when an account was created). No trailing separator, no submenus (:66-76).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no live account requests".

---

# bo-DEP

- Layout: row 1 (54 px) KPI strip, 8 tiles in order: PENDING DEPOSITS · PENDING WITHDRAWALS · AWAITING 2ND ADMIN · DEPOSITS · 30D · WITHDRAWALS · 30D · AVG TICKET · 30D · REJECTED · PSP COST · MTD (:70-77). Row 2: panel "1) DEP" "DEPOSITS & WITHDRAWALS"; header right: stat "NONE PENDING" / "<n> PENDING · <sum> USD" (amber), status text. No buttons (no primary/orange).
- Filter bar: chips PENDING · DEPOSITS · WITHDRAWALS · MARKED · COMPLETED · REJECTED · ALL (default PENDING) — PENDING = status PENDING; DEPOSITS/WITHDRAWALS = type (any status); MARKED = PENDING and marked; COMPLETED/REJECTED = status; ALL. Search "account · client" right.
- Table "funds": CLIENT · ACCOUNT · TYPE · AMOUNT · BALANCE · STATUS · STEP · MARKED BY · NOTE · CREATED · ACTIONS (:38-39). Sortable all; default pending first then newest. Single select. TYPE chip green (deposit)/accent (withdrawal); ACTIONS text "<PRIMARY> · REJECT" on pending rows (label only).
  - Row click: select; double-click: the primary step's confirm; Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<TYPE> <amount> · <acc> · <step>" (disabled) / separator / [PENDING only: primary item — one of "Approve · complete the deposit" | "Mark for approval (1st admin)" | "Confirm · complete the withdrawal (2nd admin)" | "Cancel my mark"; then "Reject…"] / "Open client <acc>" (always). No separator before "Open client", no submenus (:135-149).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no requests".

---

# bo-APR

Layout: rows * / * (:40). No KPI strip.
Panel 1 header: "1) BAL" · "BALANCE ADJUSTMENTS · AWAITING A SECOND ADMIN"; header-right: stat "<n> PENDING · <±sum>", Status. Filter bar: chips PENDING (default) · ALL — filter both panels.
Table BAL (layout "apr-balance"): REQUESTED · ACCOUNT · CLIENT · AMOUNT · BALANCE NOW · NOTE · REQUESTED BY · STATUS · REVIEW · ACTIONS (:28-29). REQUESTED BY suffixed " (you)" for own; STATUS chip PENDING/APPROVED/REJECTED; ACTIONS "APPROVE · REJECT" (orange) or "AWAITING OTHER ADMIN". Sortable headers, no default sort (server createdAt desc). Single select, no checkbox. Row click: select; double-click on ACTIONS cell: APPROVE dialog (never REJECT); double-click elsewhere: nothing; Enter: nothing. Right-click on row: YES —
  "<±amount> · <acc>" (disabled) / separator / "Approve…" (enabled PENDING) / "Reject…" (enabled PENDING) / separator / "Open client <acc>" (:73-82).
Right-click empty area: NO. Header: column picker. Empty: "no balance adjustments waiting".
Panel 2 header: "2) POS" · "POSITION ACTIONS · DELETE / VOID / REVERSE"; header-right: stat "<n> PENDING".
Table POS (layout "apr-positions"): REQUESTED · ACTION · TICKET · POSITION · ACCOUNT · REASON · REQUESTED BY · STATUS · REVIEW · ACTIONS (:30-32). ACTION chip (DELETE red, others amber); TICKET always "—" (see B). Same interactions. Right-click row: YES — "<ACTION> · <SYM> <SIDE> <vol> · <acc>" (disabled) / separator / "Approve…" / "Reject…" / separator / "Open client <acc>" (:83-92). Empty: "no position actions waiting".

---

# bo-PSP

Layout: one panel. Header: "1) PSP" · "PAYMENT METHODS"; header-right: stat "<n> OF 5 ENABLED · <n> UNSAVED" (amber when unsaved), Status. No KPI, no chips, no toolbar buttons.
Table (layout "payment-methods"): METHOD · ENABLED · MINIMUM · MAXIMUM · FEE % · FEE FIXED · WALLET ADDRESS · INSTRUCTIONS · (blank: state) · ACTIONS (:32-34). METHOD labels USDT · TRC20 / USDT · BEP20 / BTC / ETH / BANK TRANSFER; ENABLED chip ON/OFF; state chip CHANGED / DEFAULTS; ACTIONS "SAVE" (orange) when staged. Sortable headers, no default sort (server fixed order). Single select. Row click: select; double-click: per cell (see C); Enter: only in editor. Right-click on row: YES —
  "<METHOD>" (disabled) / separator / "Save this row…" (enabled when staged) / "Revert this row" (enabled when staged) / "Disable (stage)" or "Enable (stage)" (:97-105).
Right-click empty area: NO. Header: column picker. Empty: "no methods".

---

# bo-TRX

- Layout: row 1 (150 px) panel "1) TRX" "INTERNAL TRANSFER"; header right: status text only. Body: wrap row of labelled inputs FROM · TO · AMOUNT · NOTE, then buttons PREVIEW (plain) and TRANSFER (primary/orange); below, preview area (rows "FROM <no> · <name>  <bal> → <bal after> USD", "TO …", red "· <problem>" lines, green "ready · TRANSFER to confirm").
- Row 2: panel "2) HIST" "TRANSFER HISTORY · LAST 200"; header right stat "<n> LEGS". No filters, no search, no chips.
- Table "transfers": WHEN · ACCOUNT · TYPE · AMOUNT · NOTE (:30). Sortable all; default newest first (server). Single select. TYPE chip OUT red / IN green.
  - Row click: select; double-click → Client 360 of that leg's account; Enter: NO.
  - RIGHT-CLICK ON ROW: YES — header "<account number>" (disabled) / separator / Open client 360 / Use as FROM account / Use as TO account (all enabled) (:32).
  - Right-click empty area: NO. Header: YES (COLUMNS picker). Empty "no transfers yet".
- No KPI strip. Loading "loading…" + veil on nav.

---

# bo-WAL

Layout: one panel. Header: "1) WAL" · "WALLETS · ACCOUNT BALANCES"; header-right: stat "<n> ACCOUNTS · LIVE BALANCE <x> · CREDIT <x> · EQUITY <x>", Status. Filter bar: chips ALL (default) · LIVE · DEMO · WITH CREDIT · NEGATIVE (balance < 0), then search box. No KPI, no toolbar buttons.
Table (layout "wallets"): ACCOUNT · CLIENT · ACCOUNT MODE · CURRENCY · BALANCE · CREDIT · EQUITY · FREE MARGIN · FLOATING PROFIT / LOSS · STATUS (:28-30). ACCOUNT MODE chip LIVE/DEMO; STATUS chip. Sortable headers, no default sort (server order). Single select. Row click: select; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360 (credit / debit · leverage · risk limits)" / "Live exposure" / "Deposits · withdrawals" / "Internal transfer" (:32).
Right-click empty area: NO. Header: column picker. Empty: "no accounts".

---

# bo-USR

Layout: PageGrid columns * / 380. Left panel "1) USR  STAFF · ROLES"; header right in order: stat "{n} USERS · 3 ROLES", + INVITE (primary/orange), status text. No filter bar, no search.
Left body (stack): staff table, then "2) PERM  ROLE MATRIX" header (right: hint "SELECT A MANAGER TO DELEGATE" / "CLICK A CELL IN {NAME} TO STAGE" / "{ROLE} · NOTHING TO DELEGATE", plus SAVE (primary) and REVERT when staged), note line, matrix grid.
Staff table columns: USER | ROLE | LAST ACTIVE | STATUS | ACTIONS. Sortable all; default createdAt desc (server). Single selection; no checkbox. Click = select; double-click = member editor; Enter: nothing. Per-row: USER suffix " (you)"; ROLE orange for ADMIN; STATUS chip ACTIVE (green) / DISABLED (red); ACTIONS "LOCKED" (self, grey) or "EDIT   DISABLE" / "EDIT   ACTIVATE" (orange text, no separate hit targets).
Right-click on row: YES — header = e-mail (disabled), separator, "Edit…", "Disable access…" or "Re-activate…" (disabled on your own row).
Right-click on empty table area: YES — header "STAFF · ROLES", separator, "Invite a team member…". Multi-selection: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Matrix: columns PERMISSION | ADMIN | MANAGER | SUPPORT [| {selected manager, first 9 chars of e-mail local part}]. Rows: KYC review · Risk settings · Emergency controls · Internal transfers · Funds approval · IB payouts · Account finance · Reverse mirror rules. Cells: ADMIN "●"; MANAGER "n/m"; SUPPORT "·"; manager column "●"/"·" clickable.
Right column modes: (a) "3) CFG  BROKER SETTINGS" (default, see bo-CFG.md). (b) "3) EDIT  STAFF MEMBER" header right BACK TO CFG; rows e-mail · role · status · last sign-in · created · 2FA · devices · IPs "not available yet"; section DELEGATED PERMISSIONS (8 toggles + SAVE PERMISSIONS/REVERT or hint "click to stage · SAVE"; for non-managers "ADMIN · FULL ACCESS" or "SUPPORT · NONE DELEGABLE" / "extra permissions apply to MANAGER only"); section ACCESS (DISABLE ACCESS danger / RE-ACTIVATE primary / "your own row"); block "PASSWORD RESET · ROLE CHANGE" "not available yet". (c) "3) INVITE  ADD STAFF" header right BACK TO CFG; section NEW STAFF MEMBER; e-mail box; ROLE chips ADMIN · MANAGER · SUPPORT (SUPPORT lit); note; CREATE (primary) · CANCEL.
Empty: "no staff yet". Loading: page veil. Error: header status.

---

# bo-AUD

Layout: PageGrid columns * / 380. Left "1) AUD  AUDIT LOG"; header right in order: stat "{n} ENTRIES[ · "q"]", status text, SAVE CSV (plain, not primary). Filter bar: no chips; search box ("search") right.
Table columns: WHEN | ACTOR | ACTION | ENTITY | ORDER | ACCOUNT | FIELDS CHANGED. Sortable all; default createdAt desc (server). Single selection (default newest); no checkbox. Click = diff; double-click = open record; Enter in table: nothing (Enter in the search box runs the search). Per-row: ACTION orange text; ORDER "—" when none; FIELDS CHANGED amber count.
Right-click on row: YES — header = action label (disabled), separator, "Before → after (detail)", "Open the record" (disabled when no target), "Open client" (disabled when no order account).
Right-click on multi-selection: NO. Empty area: NO. Column header: YES — "COLUMNS", checkbox per column, "Reset columns".
Right "2) DIFF  BEFORE → AFTER": rows actor · action · entity · record · order (only for order rows) · when; section CHANGES: one block per diff line (key dim, before red, "→", after green; "(removed)" red); OPEN {CODE} button (primary/orange) when a target exists.
Empty: "no audit entries yet" / "no audit entries match that search" / "SELECT AN ENTRY" / "NO FIELD CHANGES RECORDED". Loading: page veil. Error: header status.

---

# bo-SEC

Layout: PageGrid columns * / * (two equal halves). No filter bars, no tables.
Left "1) ME  THIS SIGN-IN" (header right: status text). Rows: signed in as · role (orange) · tenant · broker · since ("yyyy-MM-dd HH:mm UTC") · 2FA challenged this sign-in ("YES · AUTHENTICATOR CODE" green / "NO" amber) · finance rights (YES/NO) · session ("COOKIE · ENDS ON SIGN OUT OR SERVER EXPIRY"); explanatory sentence; buttons in order: REQUEST PASSWORD RESET (danger red text, tooltip) · SIGN OUT (plain).
Right "2) SEC  ACCOUNT SECURITY": sections in order TWO-FACTOR (Enrolment; Enrol · reset · backup codes) · PASSKEYS · HARDWARE KEYS (Registered keys) · ACTIVE SESSIONS (Other devices; Sign out everywhere) · API KEYS (Personal tokens) · IP ALLOWLIST (Allowed addresses) · ORG POLICY (Staff 2FA mandatory; Session timeout; Password rotation); every value "not available yet" except Enrolment; footer "Not available yet.".
Right-click anywhere: NO context menus on this screen. No primary (orange) button.
Loading: page veil on nav (no data fetched). Error: none.

---

# bo-CFG

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

---

# term-shell

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

---

# term-marketwatch

**Header**: `1)` `MW` `MARKET WATCH` (live) / `MARKET MONITOR` (fixture) (MainViewModel.cs:81). Header-right: live `HH:mm:ss UTC`; fixture `FEED LIVE` + `03:17:42 UTC`.
**Column header row** (not clickable, not sortable): `SYMBOL` · `BID` · `ASK` · `SPRD` (if Spread on) · `HIGH` · `LOW` (if High/Low on) · `CHG%` (if Change on) · (8 px up/down square, no header).
**Search row**: `search symbols…` box, `+ ADD` button (amber text).
**Table (grouped rows)**: group header bar = category name (e.g. `METALS`, `FOREX`, `OTHER`). Row columns in order: SYMBOL, BID, ASK, SPRD, HIGH, LOW, CHG% (green/red), square (green/red). NO FEED row: dim symbol + `NO FEED` in the CHG% slot. Not sortable; default order = watchlist position within first-seen category groups. Selection: single highlight = active chart symbol (not multi, no checkbox column).
Row click = open chart; double-click = New Order dialog; Enter: none.
**Right-click on row: YES** (MarketWatchView.axaml.cs:36-57), no header line:
```
Open chart, {SYM}
New order, {SYM}
Specification, {SYM}…
────────────
Add symbol…
Remove {SYM} from watchlist
────────────
Columns ▸
    [✓] Change %
    [✓] Spread
    [ ] Daily High / Low
```
All items always visible and enabled; no shortcuts. Right-click on multi-selection: N/A (no multi-select). Right-click on empty area / group header / column header: NO (handler only on the row Border).
**ADD SYMBOL flyout**: title `ADD SYMBOL`, `search…` box, scroll list (max 320 px) of `SYMBOL  description`, empty text `all enabled symbols are on the watchlist` / `no match`.
**Symbol Specification dialog**: title row, key/value list (order as in D), note line, `CLOSE` button bottom-right. No other buttons.

---

# term-chart

**Title bar**: `2)` `GP` + subtitle `{SYMBOL} · {description}` (live; ChartPanelViewModel.cs:40-41; MainViewModel.cs:89). Header-right in order: LAYOUT button (two pane glyphs + `LAYOUT · SINGLE` / `LAYOUT · 2×2`, live only) · `LAST` · `CHG` (green/red) · `O` · `H` · `L` · `VOL`.
**Layout flyout** (right-click on LAYOUT): `CHART LAYOUT` / `Single` / `Grid 2×2` / ─── / `[✓] Crosshair sync (grid)` / hint `Double-click a cell: maximize / restore`. Left-click toggles directly.
**Toolbar (single view)**, left: `1M 5M 15M 30M 1H 4H D W` (active = accent). Right: `INDICATORS (n)` (flyout) · `EMA 20/50` (amber when on) · `VWAP` (fixture only) · `SESSIONS` (amber when on) · `DRAW` (amber while a tool is armed; flyout) · `FIB`, `OB`, `FVG` (fixture only). No primary/orange button.
**INDICATORS flyout**: `INDICATORS` / 10 rows `[ ] {label e.g. MA(9)}  overlay|pane  ⚙` / ─── / `CHART` / `[✓] One-click panel` (live) / `[ ] Sessions  ASIA · LONDON · NY`.
**DRAW flyout**: `DRAWING TOOLS` / `Trend line` / `Horizontal line` / `Ray` / `Rectangle` / `Fibonacci retracement` / ─── / `Clear all drawings (n)` (red) / `Chart settings…`.
**Canvas overlays**: one-click widget top-left (`SELL {bid}` · `−` `{lots}` `+` · `BUY {ask+markup}` / `{SYMBOL}` · `1-CLICK · OFF|ON` · `‹`); collapsed = `›` handle; drawing mini-toolbar (9 colour dots · ⚙ · ✕); confirm overlay top-centre (amber title, detail, optional note, optional `Don't ask again until the terminal is restarted`, `CANCEL`, orange action button e.g. `PLACE ORDER` / `MODIFY` / `ADD ALERT`); action line bottom-left (`sending…`, `OK · …`, `FAILED · …`).
**Canvas content**: candles, grid, last-price line + plate + candle countdown, PDH/PDL (if on), session bands (if on, M1–H4), studies (overlays + 96 px sub-panes), drawings, per-position entry lines + left tags, SL/TP lines + handles + right tags, crosshair with price / time plates and OHLC readout.
**Tables**: none on the chart.
**Right-click on single chart: YES** (CandleChartControl.cs:495-539), exactly:
```
{price} · below market | {price} · above market      (disabled header)
────────────
Buy Limit @ {price}            (below)   |  Sell Limit @ {price}   (at/above)
Sell Stop @ {price}            (below)   |  Buy Stop @ {price}     (at/above)
────────────
Set SL {price}[ · BUY|SELL {lots}]        ┐ per open position on the symbol,
Set TP {price}[ · BUY|SELL {lots}]        ┘ first 4 only; suffix only when >1
────────────                              (only when ≥1 position)
Alert below {price} | Alert above {price}
────────────
Collapse one-click panel | Expand one-click panel
────────────
{Kind} settings…                          (only when a drawing is within 10 px)
Remove drawing                            ┐
Clear all drawings ({n})                  ├ only when the symbol has drawings
────────────                              ┘
Reset view
```
No shortcuts, no submenus; all items enabled. Right-click with no candles: nothing. Right-click on price axis / time axis: same menu (no separate handler).
**Right-click on a grid cell: YES** (CandleChartControl.cs:486-493): `Reset view` / `Maximize`.
**Grid cell header**: `{SYMBOL}  ▾` (picker flyout, watchlist then all enabled symbols) · live price (green) · `H x  L y` · status (amber) · `1m 5m 15m 30m 1H 4H D`. Focused cell = accent border 1.5 px.

---

# term-ticket

Layout: right column top (BodyGrid col 4, 268-420 px, MainWindow.axaml:45-46; MainWindow.axaml.cs:654, 662). Header = PanelTitleBar Number `3)` Code `OT` Sub `ORDER TICKET`; header-right = active chart symbol text (OrderTicketPanel.axaml:73-77). No KPI strip.
Upper scroll area (live, :197-359), top to bottom:
1. Type tab row: `MARKET` | `LIMIT` | `STOP` (default MARKET; active = filled bg). Click = select.
2. Rows label | value: `SYMBOL` (`XAUUSD ▾`, click = flyout list of symbols, click item = switch chart) · `PRICE` (only LIMIT/STOP) · `VOLUME LOTS` · `STOP LOSS` (watermark SL) · `TAKE PROFIT` (watermark TP) · `RISK %` · `LEVERAGE` (1:N) · `EXPIRY` (GTC) · `MARGIN REQ` + currency · `PIP VALUE` + currency.
3. Split buttons: left caption `SELL` / `SELL LIMIT` / `SELL STOP` + bid (red); right `BUY` / `BUY LIMIT` / `BUY STOP` + ask+markup (green). No primary/orange button; no disabled state.
4. Hint box (only when SL/TP set): "SL/TP: BUY only" / "SL/TP: SELL only" (grey) or "SL/TP on the wrong side for BUY and SELL" (red border).
5. Error box (red), Status box (green/red border).
6. Strip `RISK` | `REWARD` | `R:R`.
Splitter (drag, persisted), then lower scroll area: Smart Trade Manager block (see term-stm.md) and `SESSIONS · 03:17 UTC` + one row per session (name | OPEN green / countdown dim).
Tables: none. Right-click: none anywhere on the panel (no ContextMenu in OrderTicketPanel.axaml / .cs). Keyboard: F4 focuses VOLUME LOTS (MainWindow.axaml.cs:307). Dropdowns: SYMBOL flyout = GridCandidates order (watchlist first).
Fixture (not live) variant: same frame with static rows, `SELL · C2` / `BUY · C1`, static RISK −13.83 / REWARD +26.35 / R:R 1:1.9 and a SMART EXECUTION list (OrderTicketPanel.axaml:80-192).

---

# term-neworder

Modal window, title `New Order`, 420×720 fixed, centred on owner (NewOrderWindow.axaml:7-8). No KPI strip.
Top-down: caption `NEW ORDER · F9` → rows (label col 120 px | editor): `SYMBOL` (`XAUUSD ▾` flyout, list of symbols) · `TYPE` (`MARKET` | `LIMIT` | `STOP`, default MARKET or the passed type) · `PRICE` (LIMIT/STOP only) · `VOLUME LOTS` · `STOP LOSS` (wm SL) · `TAKE PROFIT` (wm TP) · `RISK %` · `SLIPPAGE MAX` (wm `M = unlimited`) · `EXPIRY` (GTC) · rule · `LEVERAGE` · `MARGIN REQ` · `PIP VALUE` · `RISK / REWARD / R:R` (three values) · hint line (always empty).
Bottom stack: confirm strip (amber title, detail, `CANCEL` | `PLACE ORDER` = accent-filled primary) → red error box → result box → two buttons side by side: SELL (red border) | BUY (green border) → `CLOSE` right-aligned.
Tables: none. Right-click: none. Keyboard: no Enter/Esc bindings in the window (NewOrderWindow.axaml.cs has no KeyDown handler).

---

# term-positions

Layout: middle column bottom (MidCol row 2, 232 px default, 120-520, MainWindow.axaml:39-43). Tab strip row: tabs `4) TRADE` (prefix "4) " only on the active tab) · `PENDING` · `ORDERS` · `HISTORY` · `BALANCE` · `LOG` (DockViewModels.cs:16-19, 90); right side: stream warning (amber, only when down) · `CLOSE PROFIT` (green outline) · `CLOSE LOSS` (red) · `CLOSE ALL` (red) — shown only on TRADE. No orange/primary button.
TRADE table columns in order (TableLayout.cs:139-143; visible by default unless noted): `TICKET` · `OPENED` · `SYMBOL` · `SIDE` · `LOTS` · `OPEN` · `CURRENT` · `DURATION` (hidden) · `S/L ✎` · `T/P ✎` · `SWAP` · `COMM` (hidden) · `PTS` · `P/L USD` · `COMMENT ✎` (hidden) · fixed `ACTIONS` (224 px).
Sortable: NO (no sort handler). Default order: server order. Selection: none, no checkbox column.
Row click: nothing. Double-click: Modify / Close window. Enter: only inside the S/L / T/P / COMMENT editors (commit); Esc in S/L / T/P reverts.
Per-row: action chips `BE` `PART` `MOD` `SHARE` `REV` `✕` (red); while a close awaits the dealer: amber status text + `CANCEL`; transient red row notice replaces chips for 2.5-4 s. Hover tooltip (2 s): origin (hotkey / 1-click / reverse / source) + note.
RIGHT-CLICK ON ROW: YES (PositionsPanel.axaml.cs:73-87). No header line. Items in order:
1. `Modify / close #TICKET SYMBOL…`
2. `Smart rules #TICKET SYMBOL…`
3. `Close SYMBOL LOTS`
4. `Close by` → submenu, one item per opposite same-symbol position `#TICKET SIDE LOTS @ OPEN` (enabled when ≥1 candidate and the row is not close-pending); when none: disabled `Close by… (no opposite SYMBOL position)`
5. separator
6. `Share #TICKET SYMBOL…`
No shortcuts shown. All items visible on every row.
PART chip menu: `Close 25% now` · `Close 50% now` · `Close 75% now`.
Right-click multi-selection: N/A (no selection). Right-click empty area of the table: NO. Right-click column header: YES → `COLUMNS` (disabled header) · separator · one checkbox item per column (TICKET … COMMENT, "✎" stripped) staying open on click · separator · `Fit columns to width` (checkbox, default on) · `Reset columns` (PositionsPanel.axaml.cs:221-241).
Footer: left "N POSITIONS · L LOTS · EXPOSURE X CUR"; right swap (muted) and total P/L (green/red bold).
Empty: "No open positions".
Modify / Close window: title `Modify / Close Position`; header line; OPEN | CURRENT | P/L; section `STOP LOSS / TAKE PROFIT` (SL + CLEAR, TP + CLEAR, hint, `MODIFY SL / TP` amber); section `CLOSE` (`LOTS TO CLOSE`, `25%` `50%` `100%`, hint, red `CLOSE POSITION` / `CLOSE x OF y (PARTIAL)`); bottom: confirm strip, error, result, `CLOSE WINDOW`. No right-click.
Share Trade window: caption `SHARE CARD · 1200×630 PNG`, preview, summary; buttons `COPY TEXT` · `SAVE PNG` (accent-filled) · `CLOSE`. No right-click.

---

# term-tabs

Shared frame: dock tab row `4) TRADE` · `PENDING` · `ORDERS` · `HISTORY` · `BALANCE` · `LOG` (active = P2 bg + "4) " prefix); bulk close buttons only on TRADE; footer (positions totals) visible on every tab (PositionsPanel.axaml:506-514). No selection, no checkbox column, no sorting, no row click / double-click / Enter handlers on any of these five tables.
PENDING: right-aligned total "N pending orders" · columns `TICKET` · `CREATED` · `SYMBOL` · `TYPE` (LIMIT / STOP / MARKET / "CLOSE #T") · `SIDE` · `LOTS` · `PRICE` · `S/L` · `T/P` · fixed `ACTIONS` (176 px). Per row: `✕` (red) or, on a REQUOTED row, `✓ <offered>` (green) + `✕ REJECT` (red). Tooltip: requote text or origin. RIGHT-CLICK ON ROW: NO. Empty area: NO. Header: YES → column picker (COLUMNS / checkbox per column / Fit columns to width / Reset columns).
ORDERS: right-aligned "N orders total" · `TICKET` · `CREATED` · `SYMBOL` · `TYPE` · `SIDE` · `LOTS` · `PRICE` · `FILLED` · `STATUS`. No per-row buttons. RIGHT-CLICK ON ROW: NO. Header: YES (picker).
HISTORY: toolbar `RANGE` chips `1D` `1W` `1M` (default) `3M` `6M` `ALL` `CUSTOM` (+ `FROM` / `TO` calendar pickers when CUSTOM) · `SYMBOL` combo (`ALL` + symbols seen) · summary text · `STATEMENT ⤓` (amber, primary). Columns `TICKET` · `OPENED` · `SYMBOL` · `SIDE` · `LOTS` · `OPEN PRICE` · `CLOSE PRICE` (coloured by reason) · `S/L` (red when SL/stop-out hit) · `T/P` (green when TP hit) · `SWAP` · `COMM` · `CLOSED` · `REASON` (hidden by default) · `DURATION` · `PROFIT / LOSS`. Default sort closed time desc.
 RIGHT-CLICK ON ROW: YES → single item `Share #TICKET SYMBOL…` (no header, no separator).
 RIGHT-CLICK ON EMPTY LIST AREA: YES → `STATEMENT PERIOD` (disabled header) · `✓  Last day` / `Last week` / `Last month` / `Last 3 months` / `Last 6 months` / `All time` / `Custom range…` (tick on the active one) · separator · `Columns…`. (The row handler marks the event handled, so this menu does not open from a row.)
 Header: YES (picker).
BALANCE: `DATE` · `TYPE` (coloured by sign) · `AMOUNT` (signed) · `REASON` · `STATUS`. RIGHT-CLICK ON ROW: NO. Header: YES (picker).
LOG: `TIME` (HH:mm:ss today, "dd MMM HH:mm:ss" older) · `SRC` (local / event / order / server / rule / rule!) · `MESSAGE` (ellipsis). RIGHT-CLICK ON ROW: NO. Header: YES (picker).

---

# term-stm

Docked block (right column, below the ticket splitter, OrderTicketPanel.axaml:369-449):
- Header `SMART TRADE MANAGER` + pill `ENABLED` (green) / `DISABLED` (grey), tooltip "Smart Trade Manager".
- Rows (dimmed + not clickable while disabled): `SYMBOL · TYPE` (symbol, type in amber) · `LOT SIZE` · `SL` [..] `TP` [..] · `BUY HOTKEY` (wm "set hotkey", tooltip "Press a key") · `SELL HOTKEY` · hint line.
- Section header `POSITION ACTIONS` with combos: scope (`All symbols` default, `This symbol`), direction (`All` default, `Buy`, `Sell`).
- `Break-even` … `Apply` (amber chip); `Partial close` [50] `%` (+ red error text) … `Close` (chip).
- Chip row: `Close profitable` (green) | `Close losing` (red) | `Close all` (red).
- No primary/orange button, no tables, no right-click anywhere in the block.
Smart Trade Manager window (per position):
- Header "SYMBOL  SIDE LOTS @ OPEN  ·  #TICKET", live line "bid x · +n pips · SL … · TP … · lots", amber banner, status line, fired count.
- `AUTOMATED RULES`: three boxes, each checkbox + state text + two numeric fields: `BREAK-EVEN` (trigger (pips in profit), lock (pips, 0 = open)); `PARTIAL CLOSE AT TP1` (TP1 price, close (%)); `TRAILING STOP` (distance (pips), step (pips)).
- Buttons: `DISARM ALL` · `ARM SELECTED RULES` (amber, primary).
- `MANUAL ACTIONS`: `BREAK-EVEN NOW` (amber) · `CLOSE 25%` · `CLOSE 50%` · `CLOSE 75%` · `CLOSE` (red); last action text.
- Bottom: confirm strip, result box, `CLOSE WINDOW`.
- No tables, no right-click, no keyboard shortcuts.
Entry point: only TRADE row right-click › `Smart rules #TICKET SYMBOL…` (PositionsPanel.axaml.cs:79).

---

# term-account

- Location: right column, bottom row (below order ticket / STM), height from splitter (T\MainWindow.axaml:46-48; LayoutRightBottomHeight).
- Header: PanelTitleBar Number "6)", Code "ACC", Sub "ACCOUNT"; header-right text bound to HeaderRight (always "" when live) (AccountPanel.axaml:11-15).
- Body (live): 7 rows, label left (muted 11.5) / value right (semibold, up/down/default colour), 1 px separators, order: BALANCE, EQUITY, OPEN P/L, MARGIN USED, FREE MARGIN, DAY P/L, WEEK P/L (AccountViewModel.cs:15-18). Under them: gauge caption left "MARGIN n%" (red when warn, else dim), right "LEVEL n% · CALL n%"; 5 px bar, fill = used/equity, amber (red when warn) (AccountPanel.axaml:33-43; AccountPanel.axaml.cs:21-27).
- No table, no selection, no row click / double-click, right-click on panel: NO, no buttons, no dropdowns, no tabs.
- Top bar right cells (left→right): ACCOUNT, EQUITY USD, MARGIN LVL, THEME, USER ▾, caption buttons (TopBar.axaml:77-120).

---

# term-eco

Header: `5)` `ECO` `CALENDAR · NEWS`; header-right `{n} EVENTS · {h} HIGH · UTC` / `CALENDAR OFFLINE` / (before load) `USD · XAU`.
**Table (event list)**, no column header row: columns in order = time (44 px, muted) · event text (wrapping) · impact badge (40 px, right-aligned, `HIGH` / `MED` / `LOW`, coloured by ImpactToBrushConverter). Not sortable; order = time ascending. Selection: none; no checkbox column. Row click / double-click / Enter: none. Per-row buttons: none.
Right-click on row / empty area: NO.
Status text under the list (dim, wrapping) when empty or failed.
Time cell width: 44 px (EcoPanel.axaml:26) for values up to 8 characters (`dd HH:mm`, MarketDataService.cs:1227-1228); rendered overlap/clipping UNVERIFIED (app not launched).
Fixture (before sign-in): 8 static rows incl. 3 `NEWS` headlines (MainViewModel.cs:212-222).

---

# term-alerts

Window title `Price Alerts`, 560×520, centred on owner, fixed size.
Layout top → bottom: caption `PRICE ALERTS · F8` · add row [`SYMBOL` label, symbol button, condition button (amber), `PRICE` label, price box (right-aligned), `ADD` (primary, amber on accent border)] · hint line · 1 px rule · list header · list · empty text · (bottom-docked) confirm box, result line, `CLOSE`.
**Table (alert list)**: columns in order `SYMBOL` · `COND` · `PRICE` · `STATUS` · `CREATED` · (button column, no header). Not sortable; order = server createdAt desc. Selection: none; no checkbox column. Row click / double-click / Enter: nothing. Per-row button `✕ CANCEL` (red text) when active. Status text amber when active.
Right-click on row: NO. Right-click on empty area / header: NO.
Dropdown: SYMBOL flyout = plain list of symbol names (watchlist first, then every enabled symbol).
Toolbar: none. Filter chips / tabs: none.

---

# term-settings

- Window: title "Settings", 520x580, CanResize=False, centred on owner, modal (SettingsWindow.axaml:7-8; MainWindow.axaml.cs:433). No header code, no KPI strip.
- Layout top→bottom, left-aligned, 16 px margin:
  1. "CONFIRMATIONS" (section label) → 4 checkboxes in order: "Confirm ticket / New Order / dock closes before sending", "Confirm chart right-click orders", "Confirm SL/TP drags and inline edits", "Confirm price alerts"; row "Slippage max (points · M = unlimited)" + right-aligned 90 px box (watermark "M"); when a number > 0: amber "⚠ With market volatility or price movement, your entries/orders may be rejected." + checkbox "I understand — apply this slippage limit".
  2. "ACCOUNT" → checkbox "1-click trading ON by default (skips only the human confirm)".
  3. "CHART" → checkbox "Crosshair sync across the 2×2 grid"; bordered button "CHART APPEARANCE…" (amber text).
  4. "WORKSPACE" → bordered button "RESET GRID SYMBOLS" (muted text).
  5. dim note "Sounds and keyboard remapping: coming soon."
  6. bottom dock: status text (wrap); right-aligned buttons in order CANCEL (outlined), SAVE (orange fill = primary).
- Tables: none. Right-click anywhere: NO context menu. Dropdowns / chips / tabs: none.
- Keyboard: no Enter/Esc bindings on the window (buttons are Borders with PointerPressed, SettingsWindow.axaml:23-24).
- Chart appearance dialog (opened from here): sections CANDLES (6 colours: Up body, Down body, Up border, Down border, Up wick, Down wick), DISPLAY (Grid lines, Last-price line, Previous day high/low (PDH/PDL), Session map (Asia/London/NY), OHLC info bar), Timezone "UTC" (fixed), CANCEL / SAVE (SU\Charting\ChartSettingsViewModel.cs:38-48; ChartSettingsWindow.axaml:13-51).

---

# term-hotkeys-sounds

- Status bar (bottom, 26 px): left→right: connection dot + text (StatusBar.axaml:9-14); UTC clock (live); sessions text + update pill (live) (:16-27); spacer; F-key strip right-aligned: F1 HELP · F2 WATCH · F3 CHART · F4 TICKET · F5 POSITIONS · F6 NEWS · F7 ACCOUNT · F8 ALERTS · F9 NEW ORDER · F10 REPORTS · F11 LAYOUT · F12 SETTINGS (key amber bold + label muted; MainViewModel.cs:45-50). Live strip cells are clickable (hand cursor); pre-live fixture strip is not (StatusBar.axaml:45-62). Right-click on status bar: NO.
- STM hotkey rows (order ticket, right column, below SL/TP rows): "BUY HOTKEY" [84 px box, watermark "set hotkey", tooltip "Press a key"], "SELL HOTKEY" [same], hint line (9 pt dim) (OrderTicketPanel.axaml:402-416). Greyed and not clickable while STM DISABLED (:378).
- LOG tab (bottom dock, 6th tab after POS, PENDING, ORDERS, HISTORY, BALANCE): table columns in order TIME (120) · SRC (60) · MESSAGE (600) (T\ViewModels\TableLayout.cs:170-171). Not sortable; order = newest first. Selection: none. Row click / double-click / Enter: nothing. Per-row buttons: none. Right-click on row: NO. Right-click on column header: YES → menu "COLUMNS" (disabled header), separator, checkable items TIME, SRC, MESSAGE (stay open on click) (PositionsPanel.axaml.cs:221-230). Column widths drag-resizable (grip, PositionsPanel.axaml:443). Empty text: none. TIME shows HH:mm:ss today, "dd MMM HH:mm:ss" otherwise (DockViewModels.cs:305-306).
- Action line: bottom-left over the chart, bordered green (ok) / red (fail), auto-clears after 3 s (ChartPanel.axaml:240-242; ChartHost.cs:74-80).
- No toast / popup / OS notification anywhere in the terminal (no WindowNotificationManager or tray code in T\ or SU\).

---

# term-session

- Refusal window: 520x240, not resizable, dark fixed colours (not themed): product title (orange caps), message, progress line, "Build <id>", CLOSE button right (SU\StartupGate.cs:40-55).
- Sign-in window: title "<ProductTitle> — Sign in" (LoginWindow.axaml.cs:60); fitted to 1120x720 in the work area (:34). Backdrop (not clickable): top strip (logo square, PRODUCT TITLE, host text when OTHER), ticker tape, dimmed candle chart, footer "<ProductTitle> · sign in to start · dd MMM yyyy UTC" (LoginWindow.axaml:31-43; .cs:63). Centred 400 px card:
  - header: logo (or square) + PRODUCT TITLE (orange); right: theme toggle ☾/☀.
  - sign-in form: SERVER (picker ▾), [SERVER ADDRESS when Other], ACCOUNT NUMBER, PASSWORD, [AUTHENTICATOR CODE after challenge], row: checkbox "Remember me on this computer" | link "Forgot password?"; red error box; muted status line; buttons: CANCEL (outlined, only while busy) + SIGN IN / SIGNING IN… / VERIFY / VERIFYING… (orange, full width = primary).
  - forgot form: "RESET YOUR PASSWORD", "Your broker will contact you with a new password.", ACCOUNT NUMBER, NOTE FOR SUPPORT (OPTIONAL) (watermark "how to reach you, preferred time…"), error box, green "Reset request sent. Your broker will contact you.", row "← Back to sign in" | SEND REQUEST (orange).
  - update banner (orange outline) when an update is ready; version "vX" bottom-right.
  - Keyboard: Enter in PASSWORD / CODE = sign in / verify; no Esc handling. Right-click: NO menus anywhere. Tables: none.
- Server picker flyout, in order: "<Brand> — Live Server" (green dot), "<Brand> — Demo Server" (orange dot), "Other server…", then recent hosts (indented) (LoginWindow.axaml:78-92).
- Terminal top bar right side (live): ACCOUNT · EQUITY USD · MARGIN LVL · THEME · USER (initials disc, name, ▾) · caption buttons. USER ▾ is a left-click menu (right-click: NO), placement bottom-right, min width 260: header line "<NAME> · <account> <MODE>" (disabled) · separator · "Switch account…" · separator · "Sign out" · "Sign out and forget this computer" (TopBar.axaml.cs:32-37). Every item opens the chart confirm overlay (always shown) with title / sentence / button (MainWindow.axaml.cs:238, 243-244).
- Status bar update pill: text = Updater.Status while downloading ("downloading vX… n%") or ready ("UPDATE vX READY · click to restart"); orange fill only when ready (StatusBar.axaml:22-25; MainWindow.axaml.cs:253).
