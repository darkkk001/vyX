# bo-SYM · Symbols (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\SymbolsScreen.cs (SYM). Nav: TRADING › "Symbols" (ViewModels/ShellViewModel.cs:59), F8 "SYMBOLS" (ShellViewModel.cs:97).

## A. Purpose + panels
Broker-wide per-symbol config (BrokerSymbol): markup, commission, swaps, lot limits, max exposure, hedged margin %, trading mode, enabled, weekly sessions.
Panels: 1) LIM "EXPOSURE LIMITS · NET LOTS PER SYMBOL" (top, 220 px) and 2) SYM "SYMBOLS · SPREADS · SESSIONS" (fills) (SymbolsScreen.cs:57-60).
The class summary (SymbolsScreen.cs:18-25) still describes a "BOOK routing rules" panel and "HDG" panel that do not exist, and contains a duplicated "Esc reverts." line.

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error / loading |
|---|---|---|---|---|---|---|---|
| 2) SYM grid | GET /api/manage/symbols | FetchBrokerSymbolsAsync ApiClient.ManageG2.cs:140 | app/api/manage/symbols/route.ts:42-77 (every Symbol row, merged with this broker's BrokerSymbol or DEFAULTS :19-32) | on open / nav (>10 s stale, Screen.cs:70-76); no poll, no live topic; after SAVE (AfterWriteAsync Screen.cs:144-148) | chips ALL / each category / ENABLED / DISABLED (client, SymbolsScreen.cs:85-94); column-click sort | none (all symbols) | "no symbols" (:43); error → header Status text (Screen.cs:103) |
| 1) LIM | same GET symbols + GET /api/manage/positions | FetchManagePositionsAsync ApiClient.ManageG1.cs:224 | app/api/manage/positions/route.ts:47 (OPEN positions, broker) | same as SYM | enabled symbols only (SymbolsScreen.cs:112) | none | "no symbols" (:56) |
| Sessions dialog | GET /api/manage/symbols/{brokerSymbolId}/sessions | FetchSymbolSessionsAsync ApiClient.ManageG2.cs:146 | app/api/manage/symbols/[id]/sessions/route.ts:19-37 | on dialog open | day, openTime asc | — | toast "sessions: <error>" (SymbolsScreen.cs:197) |

LIM math: NOW = Σ(BUY volume) − Σ(SELL volume) over ALL broker positions in that symbol (SymbolsScreen.cs:114); status OK / NEAR LIMIT (>90 %) / OVER LIMIT vs MAXIMUM EXPOSURE (:116). The server meaning of maxExposure is different: per ACCOUNT total open volume (gross, both sides) in the symbol — lib/risk.ts:307-327 (web order path), engine/risk/src/lib.rs:146-168 (engine). The LIM panel therefore compares a broker-wide net against a per-account gross cap.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Filter chips ALL / <CATEGORY…> / ENABLED / DISABLED | SYM filter bar | always | always | none (client filter) SymbolsScreen.cs:85-94 | — | — | no | no | — | re-render | WORKS |
| Double-click cell MARKUP / COMMISSION / LOT / SWAP LONG / SWAP SHORT / MINIMUM LOT / MAXIMUM LOT / STEP / MAXIMUM EXPOSURE / HEDGED MARGIN % | SYM grid | always | always | none; opens inline editor, Enter commits, Esc reverts, lost focus commits (SymbolsScreen.cs:48-49, 123-160) → stages row | none until SAVE | client: number required (maxexp may be empty) :140-141; hedged 0-200 :143 / server symbols/route.ts:138-208 | no (staged) | no | — | row tone amber + "CHANGED", save bar appears | WORKS |
| Hedged margin < 50 → confirm "HEDGED MARGIN x% ON SYM" / "SET x%" | editor commit | value < 50 | — | stages with ConfirmBelowFloor=true (SymbolsScreen.cs:145-152) | server requires confirmBelowFloor for <50 (symbols/route.ts:163-179), audit newValue.confirmedBelowHedgedFloor (:295) | client 0-200 / server 0-200 + floor | yes (danger) | no | — | toast "… staged, press SAVE" | WORKS |
| Double-click ENABLED cell | SYM grid | always | always | none, stages Enabled toggle (:126) | on SAVE: BrokerSymbol.enabled; enabling a non-USD-quoted symbol → 400 (symbols/route.ts:219-226) | server | no (staged) | no | — | staged | WORKS |
| Double-click TRADING MODE cell (BOTH → BUY_ONLY → SELL_ONLY) | SYM grid | always | always | none, stages (:127) | on SAVE: BrokerSymbol.tradingMode | server enum (symbols/route.ts:148) | no | no | — | staged | WORKS |
| Double-click SESSIONS cell ("EDIT…" / "24/7 · DEFAULTS") | SYM grid | always | BrokerSymbolId set, else toast "save the symbol first" (:195) | GET then PUT /api/manage/symbols/{brokerSymbolId}/sessions — SaveSymbolSessionsAsync ApiClient.ManageG2.cs:155 → sessions/route.ts:42-84 | TradingSession delete+createMany in one transaction (:77-80); NO audit log; no live event | client ParseSessions "DAY HH:MM-HH:MM ; …", close > open (:211-224) / server HH:MM, 0-6, close > open (:60-75) | the dialog is the confirm (ConfirmWithInput "SAVE SESSIONS") | no | MANAGER, BROKER_ADMIN (sessions/route.ts:5-11) | toast "SYM · n sessions saved"; no grid refetch | PARTIAL (dialog says "Empty = trades 24/7" but empty = default FX weekend close + daily break, lib/risk.ts:201-209; ignored for continuously traded categories, lib/risk.ts:206; no audit) |
| DISCARD | save bar | ≥1 staged row | always | none (:168) | — | — | no | no | — | toast "changes discarded" | WORKS |
| SAVE CHANGES (primary/orange) | save bar | ≥1 staged row | always | PATCH /api/manage/symbols once per staged row, sequential — SaveBrokerSymbolAsync ApiClient.ManageG2.cs:142-144 → symbols/route.ts:121-316 | BrokerSymbol upsert (:253-257); AuditLog SYMBOL_CONFIG_UPDATED old/new (:259-298); no notification / mirror / coverage / live event | client per-cell / server all fields (:181-208) | yes "SAVE SYMBOL CHANGES" (:172) | no | MANAGER, BROKER_ADMIN (:34-40) | saved rows leave dirty set; failures listed "SYM: error · …"; refetch | WORKS |
| Right-click row → "Trading sessions…" | row menu | always | BrokerSymbolId set | as SESSIONS cell | as above | as above | dialog | no | as above | as above | DUPLICATE (SESSIONS cell double-click) |
| Right-click row → "Disable (stage)" / "Enable (stage)" | row menu | always | always | stages (:186) | on SAVE | — | no | no | — | staged | DUPLICATE (ENABLED cell double-click) |
| Right-click row → "Revert this row" | row menu | row staged | always | none (:187) | — | — | no | no | — | row reset | WORKS |

## D. Dialogs
Inline editor fields (stored in BrokerSymbol.*; readers):
| Field (column) | Type / default | Stored in | READ BY |
|---|---|---|---|
| MARKUP | decimal, stored in PIPS (no unit shown) / "0" | BrokerSymbol.spreadMarkup | fill: lib/pricing-engine.ts:299-336 → lib/group-pricing.ts:63-97 (base level); engine/order-management/src/lib.rs:236-240 (engine path) |
| COMMISSION / LOT | decimal / "0" | BrokerSymbol.commissionPerLot | lib/pricing-engine.ts:152-159 / group-pricing.ts:95; charged via chargeCommission app/api/trade/orders/route.ts:627 |
| SWAP LONG / SWAP SHORT | decimal / "0" | BrokerSymbol.swapLong / swapShort | lib/swap-rollover.ts:77-78, :218 |
| MINIMUM LOT / MAXIMUM LOT / STEP | decimal / 0.01 / 100 / 0.01 | minLot / maxLot / lotStep | app/api/trade/orders/route.ts:148, :189 (lib/risk.ts:98-105); engine/risk/src/lib.rs (check_lot_size, engine/order-management/src/lib.rs:205); mirror clamp lib/mirror.ts:335 |
| MAXIMUM EXPOSURE | decimal or empty (= no limit) | BrokerSymbol.maxExposure | per-ACCOUNT gross cap: lib/risk.ts:312-327 via app/api/trade/orders/route.ts:202; engine/order-management/src/lib.rs:225-226 |
| HEDGED MARGIN % | 0-200 / "200" | BrokerSymbol.hedgedMarginPct | lib/margin.ts:76, :119-137; engine/order-management/src/calc.rs + margin_watch.rs (grep hedged_margin_pct) |
| TRADING MODE | BOTH/BUY_ONLY/SELL_ONLY / BOTH | BrokerSymbol.tradingMode | lib/risk.ts:52-55 via app/api/trade/orders/route.ts:187, lib/mirror.ts:328, manage positions/dealing-queue routes; NOT read by engine (no trading_mode in engine/**/*.rs) |
| ENABLED | bool / true | BrokerSymbol.enabled | engine check_symbol_enabled (engine/order-management/src/lib.rs:201); group pricing / allow-list lists (enabled:true filters) |
Sessions dialog (ConfirmWithInput, SymbolsScreen.cs:200): one text input "SESSIONS", prefilled with existing "MON 00:00-23:59 ; …" (:198-199); stored in TradingSession(dayOfWeek, openTime, closeTime); READ BY lib/risk.ts:201-222 checkTradingSession (web order/close/mirror/bulk-close paths) and engine/order-management/src/session.rs. closeTime is exclusive (lib/risk.ts:219), so "00:00-23:59" leaves 23:59-24:00 closed; a window cannot cross midnight (server :71).

## E. Text
- "Windows (UTC), e.g. \"MON 00:00-23:59 ; TUE 00:00-23:59\". Empty = trades 24/7." (SymbolsScreen.cs:200) — wrong: empty = default FX weekend schedule (lib/risk.ts:207-209).
- Cell label "24/7 · DEFAULTS" (SymbolsScreen.cs:103) — same wrong claim; also shown for a symbol that simply has no BrokerSymbol row.
- Sessions cell shows "EDIT…" for every configured row whether or not any session exists (SymbolsScreen.cs:103).
- Column "MARKUP" (SymbolsScreen.cs:41) is in pips without unit, while Groups/Account types PRICING panels show points ("VALUE · PTS", PricingPanel.cs:48).
- Panel "EXPOSURE LIMITS · NET LOTS PER SYMBOL" (SymbolsScreen.cs:57) misdescribes maxExposure (per-account gross, lib/risk.ts:307-310).
- Hedged-margin toast "hedged margin %: 0 to 200 (200 = both legs in full, 50 = MT5 FX default, 0 = hedge is free)" (:143) — verbose.
- Class summary (SymbolsScreen.cs:18-25) refers to removed BOOK/HDG panels; duplicated "Esc reverts." (:24-25).

## F. UI structure map
Layout: page grid rows 220 px / * (SymbolsScreen.cs:60). Header title per shell: "Symbols" code SYM.
- Panel 1 header: "1) LIM" · "EXPOSURE LIMITS · NET LOTS PER SYMBOL"; header-right: none. No KPI strip.
- Panel 2 header: "2) SYM" · "SYMBOLS · SPREADS · SESSIONS"; header-right: stat "<n> ENABLED · <n> TOTAL" (:107), Status text. Below: filter bar (chips), then save bar (hidden until a row is staged: text "<n> SYMBOL(S) CHANGED · NOT SAVED", buttons DISCARD, SAVE CHANGES primary/orange) (:51-54, :106), then grid.

Table 1 (LIM, layout "sym-hedge"): columns SYMBOL · NET LIMIT · NOW · STATUS (:55-56). Values: "<n> LOTS" or "—"; NOW signed "+x"/"−x"; STATUS OK / NEAR LIMIT / OVER LIMIT / NO LIMIT. All headers sortable (click), no default sort (server order = name asc). Selection single, no checkbox. Row click: select only; double-click: nothing; Enter: nothing. Right-click on row: NO (no handler). Right-click empty area: NO. Right-click column header: YES, column picker ("COLUMNS" disabled header, separator, one checkbox item per column, separator, "Reset columns") (DataTable.cs:89, :303-318). Empty: "no symbols".

Table 2 (SYM, layout "symbols", persisted per user :46-47): columns SYMBOL · CATEGORY · DIGITS · MARKUP · COMMISSION / LOT · SWAP LONG · SWAP SHORT · MINIMUM LOT · MAXIMUM LOT · STEP · MAXIMUM EXPOSURE · HEDGED MARGIN % · TRADING MODE · SESSIONS · ENABLED · (blank header: state "CHANGED") (:41-43). All sortable, no default sort (server order name asc). Selection single, no checkbox. Row click: select. Double-click: per cell (see C); DIGITS/SYMBOL/CATEGORY/state: nothing. Enter: only inside the inline editor. Per-row badges: TRADING MODE chip, ENABLED ON/OFF chip, "CHANGED" chip, SESSIONS "EDIT…" orange text. Right-click on row: YES —
  header "<SYMBOL>" (disabled) / separator / "Trading sessions…" (enabled when BrokerSymbolId set) / "Disable (stage)" or "Enable (stage)" / "Revert this row" (visible only when staged) (:181-189). No shortcuts, no submenus.
Right-click multi-selection: n/a (single select). Right-click empty area: NO (no TableActions). Right-click column header: YES, column picker as above. Empty: "no symbols". Loading: shell LOADING veil (Screen.cs:66-76).
Filter chips (in order): ALL (default) · each distinct CATEGORY upper-case, alphabetical · ENABLED · DISABLED (:88).
Toolbar buttons: none besides the save bar.

## Issues
- [money] SYM · LIM panel compares broker-wide NET lots (buy−sell) with maxExposure, which the server enforces as a per-ACCOUNT gross open-volume cap · SymbolsScreen.cs:114-116 vs lib/risk.ts:307-327, engine/risk/src/lib.rs:146-168
- [functional] SYM · sessions dialog and cell say empty = 24/7; server applies the default FX weekend close + daily break when no rows exist · SymbolsScreen.cs:103, :200 vs lib/risk.ts:207-209
- [functional] SYM · TradingSession PUT writes no AuditLog · app/api/manage/symbols/[id]/sessions/route.ts:77-83
- [functional] SYM · sessions edits have no effect on continuously traded categories (crypto), the dialog does not say so · lib/risk.ts:206
- [functional] SYM · tradingMode (BUY_ONLY/SELL_ONLY) is not read by the Rust engine order path; only the web routes enforce it (UNVERIFIED which path is live for fills) · engine (no trading_mode match), lib/risk.ts:52
- [ux] SYM · a session "HH:MM-23:59" leaves the last minute of the day closed (closeTime exclusive, no midnight crossing) · lib/risk.ts:219, sessions/route.ts:71
- [ux] SYM · symbol config save publishes no live event, open terminals keep old config until they refetch · app/api/manage/symbols/route.ts:253-315
- [text] SYM · MARKUP column is pips with no unit while PRICING panels are points · SymbolsScreen.cs:41, PricingPanel.cs:48
- [text] SYM · class summary describes removed BOOK/HDG panels, duplicated "Esc reverts." · SymbolsScreen.cs:18-25

## Status counts
STATUS-COUNTS app=backoffice screen=SYM WORKS=8 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=2
