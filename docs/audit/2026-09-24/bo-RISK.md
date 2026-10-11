# bo-RISK · Risk (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\RiskScreen.cs:17-115 (RiskScreen, RISK). Nav: RISK › "Risk" (ShellViewModel.cs:64), F9 "RISK".

## A. Purpose + panels
Broker-wide risk settings (manual dealing switch, smart dealer %, total exposure / max positions limits, trading state) plus a margin watch.
Layout: KPI strip (4 tiles, 54 px) on top; below: 1) RISK "BROKER RISK SETTINGS" (left, 380 px) and 2) MRG "MARGIN WATCH · LOWEST FIRST" (fills) (RiskScreen.cs:46-51).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| 1) RISK | GET /api/manage/risk | FetchRiskSettingsAsync ApiClient.ManageG2.cs:162-166 | app/api/manage/risk/route.ts:12-42 (needs RISK_SETTINGS or EMERGENCY_CONTROLS :15) | live topics position, margin; poll 10 s (:24-25); after writes | — | — | "RISK SETTINGS UNAVAILABLE" (:76); Status "risk: …" |
| KPI + 2) MRG | GET /api/manage/margin + GET /api/manage/positions | FetchMarginAsync ApiClient.ManageG1.cs:223; FetchManagePositionsAsync :224 | app/api/manage/margin/route.ts:10-43 → lib/margin.ts computeAccountMarginSnapshots (accounts with OPEN positions, :34) | same + ticks ≤1/s re-price equity / free / P/L / level (LiveMath.Reprice, :32-38) | server sorted by margin level asc (margin/route.ts:40) | first 200 rows (:106) | "no accounts with positions"; Status "margin: …" |
KPI tiles (:69-74): OPEN EXPOSURE (Σ MarginRow.Exposure, note "USD NOTIONAL"); FLOATING P/L · CLIENTS (Σ floating, "USD"); OPEN POSITIONS ("<n> ACCOUNTS"); ACCOUNTS AT RISK (level ≤ margin call; note "<n> AT STOP-OUT"). MarginRow.Exposure is the sum of LOTS (lib/margin.ts:65), not USD notional.

## C. Controls
| Control | Where | Visible when | Enabled when | Calls (method + endpoint) | Server effect | Validation (client / server) | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Manual dealing "TURN ON" / "TURN OFF" | RISK › DEALING MODE | settings loaded | always | PATCH /api/manage/risk {dealingMode} — PatchRiskAsync ApiClient.ManageG2.cs:169 → risk/route.ts:44-236 | Broker.dealingModeAt (:97-103); AuditLog (:203-215) | server boolean | yes "DEALING MODE ON/OFF" (danger on ON) | no | BROKER_ADMIN or RISK_SETTINGS (:74) | toast "dealing mode on/off"; refetch | PARTIAL (confirm says "Every market order will wait in the dealer queue" but with the desk auto-fill on, B_BOOK/DEALING INHERIT groups still fill automatically, lib/dealing-routing.ts:10-13; AUTO groups never queue) |
| Smart dealer "EDIT" | RISK › reject % row | settings loaded | always | PATCH /api/manage/risk {smartDealerAcceptPct, smartDealerRejectPct} (both null = clear) | Broker.smartDealerAcceptPct / RejectPct (:148-164); AuditLog; READ BY app/api/trade/orders/route.ts:355-460 (dealing-queue auto accept/reject by slippage %) | client "a b", b ≥ a (:89) / server each > 0 or blank (:140-147) → "0 2" passes client, fails server | dialog (ConfirmWithInput "SAVE") | no | BROKER_ADMIN or RISK_SETTINGS | toast "smart dealer a / b %" | WORKS |
| Limits "EDIT" | RISK › max positions row | settings loaded | always | PATCH /api/manage/risk {totalExposureLimit, maxOpenPositionsPerAccount} | Broker.totalExposureLimit (LOTS, lib/risk.ts:330-347 via orders/route.ts:203), Broker.maxOpenPositionsPerAccount (lib/risk.ts checkMaxOpenPositions via orders/route.ts:201; engine db.rs); AuditLog | client: "exposure positions"; a missing/invalid part is sent as null = clears that limit (:98-100) / server positive (:105-135) | dialog | no | BROKER_ADMIN or RISK_SETTINGS | toast "limits saved" | PARTIAL (prompt and display call the exposure limit USD; server enforces it in LOTS; typing one number clears the other limit) |
| "EMERGENCY" | RISK › TRADING STATE | settings loaded | always | navigation Shell.Navigate("EMG") (:103) | — | — | no | — | — | EMG screen | WORKS |
| "FULL MARGIN SCREEN" | MRG panel header | always | always | navigation to MRG (:49) | — | — | no | — | — | MRG screen | WORKS |
| Margin row double-click | MRG table | row | always | Shell.Open("CLI", accountId) (:44) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Open client 360" | MRG row menu | always | always | Shell.Open("CLI", accountId) (RiskScreen.cs:148) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure · this account" | MRG row menu | always | always | Shell.Open("EXP", accountNumber) (:149) | — | — | no | — | — | EXP filtered to the account (LiveExposureScreen.cs:109-113) | WORKS |
| Right-click → "Close all <n> positions…" | MRG row menu | always | PositionCount > 0 | POST /api/manage/positions/close-bulk {scope:"ALL", accountId} — CloseBulkAsync ApiClient.ManageG6.cs:138-139 → positions/close-bulk/route.ts:20-71 → lib/bulk-close.ts closeBulkForAccount | Positions closed + P/L transactions; mirror.onClose + coverage.onClose per position (lib/bulk-close.ts:185-194); NATS PositionsClosed (:199); AuditLog MANUAL_POSITION_BULK_CLOSE (close-bulk/route.ts:48-63) | — | yes (danger) "CLOSE ALL POSITIONS" | no | MANAGER, BROKER_ADMIN (close-bulk/route.ts:10) | toast "<acc> · positions closed" even when some failed (response failed count ignored, :153) | PARTIAL (partial failures reported as success) |
Display-only rows (no control): Smart dealer accept %, Total exposure limit, Trading HALTED/OPEN, Close-only ON/OFF (:83, :93, :103-104).

## D. Dialogs
- DEALING MODE ON / OFF (Confirm): no fields.
- SMART DEALER (ConfirmWithInput :85-91): input "ACCEPT % · REJECT %" text "a b" or empty. Stored Broker.smartDealerAcceptPct / smartDealerRejectPct. READ BY app/api/trade/orders/route.ts:359-364, :457.
- LIMITS (ConfirmWithInput :95-101): input "EXPOSURE USD · MAX POSITIONS" text "e.g. \"5000000 50\"". Stored Broker.totalExposureLimit (Decimal(18,2), prisma/schema.prisma:402, unit LOTS per lib/risk.ts:330-346) and Broker.maxOpenPositionsPerAccount. READ BY app/api/trade/orders/route.ts:201-203, dealing-desk-toggle/route.ts, dealing-queue/[id]/route.ts, positions/route.ts, engine/order-management/src/db.rs (max positions).
- CLOSE ALL POSITIONS (Confirm): no fields; text "… at market? One transaction."

## E. Text
- "Total exposure limit … USD" (:93) and dialog "EXPOSURE USD", example "5000000" (:95) — server unit is lots (lib/risk.ts:346 message "… of X lots").
- KPI "OPEN EXPOSURE" note "USD NOTIONAL" formatted as money (:69) — value is Σ lots (lib/margin.ts:65).
- "Every market order will wait in the dealer queue." (:81) — not true while the desk auto-fill switch is on (lib/dealing-routing.ts:12).
- "Manual dealing" here vs "DESK … DEALER ON" on GRP / dealing desk: two different broker switches (Broker.dealingModeAt vs Broker.dealingDeskAutoFillAt) with overlapping names.
- "Slippage %: auto-accept below, auto-reject above. Type \"accept reject\", e.g. \"0.5 2\". Empty = clear." (:85) — free-text two-number input instead of two fields.
- Summary (:17-20) says "4 stat tiles … every write is a PATCH risk" — close-all is a positions write.

## F. UI structure map
Layout: KPI row (4 equal tiles) / body: left 380 px settings, right margin watch (:46-51).
KPI tiles in order: OPEN EXPOSURE · FLOATING P/L · CLIENTS · OPEN POSITIONS · ACCOUNTS AT RISK.
Panel 1 header: "1) RISK" · "BROKER RISK SETTINGS"; header-right: Status. Body sections: DEALING MODE (Manual dealing + TURN ON/OFF button; Smart dealer accept %; Smart dealer reject % + EDIT), EXPOSURE & POSITION LIMITS (Total exposure limit; Max open positions / account + EDIT), TRADING STATE (Trading + EMERGENCY; Close-only).
Panel 2 header: "2) MRG" · "MARGIN WATCH · LOWEST FIRST"; header-right: stat "<n> WITH POSITIONS · <n> AT RISK", button "FULL MARGIN SCREEN" (not primary).
Table (layout "risk-margin", RiskScreen.cs:157-159): ACCOUNT · CLIENT · EQUITY · USED MARGIN · FREE MARGIN · POSITIONS · EXPOSURE · FLOATING PROFIT / LOSS · MARGIN LEVEL · STATUS. STATUS chip NO POSITIONS / NO PRICE / STOP-OUT / MARGIN CALL / OK (:162). Sortable headers, no default sort (server level asc). Single select. Row click: select; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc> · <name>" (disabled) / separator / "Open client 360" / "Live exposure · this account" / separator / "Close all <n> positions…" (enabled when n > 0) (:143-156).
Right-click empty area: NO. Header: column picker. Empty: "no accounts with positions". Buttons: TURN ON/OFF, EDIT ×2, EMERGENCY, FULL MARGIN SCREEN; none primary.

## Issues
- [money] RISK · total exposure limit is shown and prompted as USD (example 5,000,000) but enforced in lots; a broker following the prompt sets an effectively unlimited cap · RiskScreen.cs:93, :95; lib/risk.ts:330-346
- [money] RISK · OPEN EXPOSURE KPI labels a sum of lots as "USD NOTIONAL" money · RiskScreen.cs:69; lib/margin.ts:65
- [functional] RISK · "Manual dealing ON" confirm promises every market order queues; with desk auto-fill on, INHERIT B_BOOK/DEALING groups still auto-fill · RiskScreen.cs:81; lib/dealing-routing.ts:10-13
- [functional] RISK · LIMITS dialog sends null for a missing second number, silently clearing the max-positions limit · RiskScreen.cs:98-100
- [functional] RISK · "Close all positions" reports success when some positions failed to close · RiskScreen.cs:153; close-bulk/route.ts:65-70
- [ux] RISK · smart dealer "0 x" passes client validation and is refused by the server (must be > 0) · RiskScreen.cs:89; risk/route.ts:140-151
- [text] RISK · two broker switches named "Manual dealing" (dealingModeAt) and "DESK / dealer on" (dealingDeskAutoFillAt) · RiskScreen.cs:80; GroupsScreen.cs:83

## Status counts
STATUS-COUNTS app=backoffice screen=RISK WORKS=5 PARTIAL=3 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
