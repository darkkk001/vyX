# bo-RDR · Risk radar (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:293-398 (RiskRadarScreen, RDR). Nav: RISK › "Risk radar" (ShellViewModel.cs:65); nav badge = flagged accounts + same-IP clusters (Views/MainWindow.axaml.cs:201).

## A. Purpose + panels
30-day behavioural flags per account (scalp, martingale, latency arbitrage, news) and same-IP clusters; read-only.
Layout: KPI strip (8 tiles); 1) RDR "RISK RADAR · 30-DAY BEHAVIOUR" (fills) and 2) ACCT "FLAGGED ACCOUNT" (right, 380 px) (:312-315).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Filters / sort | Limits | Empty / error |
|---|---|---|---|---|---|---|---|
| all | GET /api/manage/risk-radar → {rows, sameIpClusters} | FetchRiskRadarAsync ApiClient.ManageG5.cs:81-96 | app/api/manage/risk-radar/route.ts:16-38 → lib/risk-radar.ts computeRiskRadar :120-160 (CLOSED positions, closedAt ≥ now−30 d; accounts with ≥1 trade) + computeSameIpClusters :166-210 (LoginEvent by IP, ≥2 accounts and ≥2 distinct emails) | on open / nav (>10 s); no poll, no topic; server in-memory cache 5 min per broker (route.ts:12-36) | chips ALL / FLAGGED / SCALP / MARTINGALE / LATENCY ARB / NEWS (client :330); order flags desc, P/L per day desc (:348) | none | "no accounts with 30-day activity" / "no accounts match this flag" (:359); error → Status |
Role: MANAGER, BROKER_ADMIN (route.ts:18).
Flag sources: scalp = avg hold < 2 min (lib/risk-radar.ts:39, :113); martingale = size ≥ 1.5× after a loss, ≥ 3 hits (:46-47); latency arb = ≥10 trades held ≤3 s with win rate ≥25 pts above the rest (:72-80); newsTraderFlag hard-coded false (:116).
Cluster shape mismatch: server account key is accountId (lib/risk-radar.ts:163, :184-189); client reads "id" (ApiClient.ManageG5.cs:61-63) → SameIpAccount.Id is always "".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Chips ALL / FLAGGED / SCALP / MARTINGALE / LATENCY ARB | filter bar | always | always | none (client :327-331, :347) | — | — | no | — | — | rows filtered | WORKS |
| Chip NEWS | filter bar | always | always | none | — | — | no | — | — | always empty: server never sets the flag (lib/risk-radar.ts:116) | PLACEHOLDER |
| Row click | table | row | always | none (:308) | — | — | no | — | — | detail panel | WORKS |
| Row double-click | table | row | always | Shell.Open("CLI", accountId) (:309) | — | — | no | — | — | CLI | WORKS |
| Right-click → "Flags · stats (detail)" | row menu | always | always | detail render (:310) | — | — | no | — | — | detail | DUPLICATE (row click) |
| Right-click → "Open client 360" | row menu | always | always | Shell.Open("CLI", accountId) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| Right-click → "Live exposure" | row menu | always | row source present | Shell.Open("EXP", accountNumber) | — | — | no | — | — | EXP filtered to account | WORKS |
| OPEN CLIENT (primary/orange) | detail | account selected | always | Shell.Open("CLI", accountId) (:385) | — | — | no | — | — | CLI | DUPLICATE (row double-click) |
| EXPOSURE | detail | account selected | always | Shell.Open("EXP", accountId) (:385) | — | — | no | — | — | EXP filtered | DUPLICATE (row menu "Live exposure") |
| Cluster account links "<acc> · <name>" | detail, SAME-IP CLUSTERS | cluster exists | always | Shell.Open("CLI", a.Id) (:395) with a.Id = "" | — | — | no | — | — | CLI opens without selecting the account | PARTIAL (id key mismatch) |
| "FLAG · WHITELIST · NOTE — not available yet" | detail | account selected | — | none (:387) | — | — | — | — | — | — | PLACEHOLDER |

## D. Dialogs
None.

## E. Text
- Detail "same-IP clusters: none" for every account (:382-383): the membership test compares a.Id ("" after parsing) with AccountId.
- "News trader" row / NEWS chip / NEWS TRADER KPI (:300, :375) for a flag the server never computes.
- Score labels LOW / MED / HIGH (:326) for flag counts 1 / 2 / ≥3; column header says "FLAGS".
- "Martingale (size ×1.5 after loss, ≥ 3×)" (:373), "Scalper (avg hold < 2 m)" (:372) match lib thresholds.
- Summary (:293-297) "Flag / whitelist / notes have no endpoint" — accurate.

## F. UI structure map
KPI tiles in order: ACCOUNTS TRACKED · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS TRADER · SAME-IP CLUSTERS · TOP PROFIT / DAY (:300, :312).
Panel 1 header: "1) RDR" · "RISK RADAR · 30-DAY BEHAVIOUR"; header-right: stat "<shown> OF <total> · <n> SAME-IP", Status. Filter bar chips in order: ALL (default) · FLAGGED · SCALP · MARTINGALE · LATENCY ARB · NEWS.
Table (layout "risk-radar"): ACCOUNT · FLAGS · WHICH · TRADES · 30D · WIN RATE · AVERAGE HOLD · AVERAGE LOT · P/L PER DAY (:306-307). FLAGS chip — / LOW / MED / HIGH. Sortable headers; default = client order (flag count desc, P/L per day desc). Single select (first load auto-selects the top row, :335). Row click: detail; double-click: CLI; Enter: nothing. Right-click on row: YES —
  "<acc>" (disabled) / separator / "Flags · stats (detail)" / "Open client 360" / "Live exposure" (:310).
Right-click empty area: NO. Header: column picker.
Panel 2 header: "2) ACCT" · "FLAGGED ACCOUNT". Body: account; score; section FLAGS · 30 DAYS (Scalper / Martingale / Latency arbitrage / News trader: FLAGGED or clear); section STATS (trades, win rate, avg hold, avg lot, profit velocity / day, same-IP clusters); buttons OPEN CLIENT (primary/orange), EXPOSURE; "FLAG · WHITELIST · NOTE — not available yet"; section "SAME-IP CLUSTERS · <n>" with up to 20 clusters, each "<ip> <n> ACCOUNTS" and account links; "NONE" when empty; "SELECT AN ACCOUNT" when nothing selected.

## Issues
- [functional] RDR · same-IP cluster accounts parse with empty Id (server sends accountId, client reads id): per-account "same-IP clusters" is always "none" and cluster links open CLI without the account · lib/risk-radar.ts:163, :184-189; ApiClient.ManageG5.cs:61-63; LiquidityScreens.cs:382-383, :395
- [functional] RDR · news-trader flag is never computed (hard-coded false) but has a chip, KPI and detail row · lib/risk-radar.ts:116; LiquidityScreens.cs:300, :330, :375
- [ux] RDR · results cached 5 min server-side per broker with no "as of" time shown · app/api/manage/risk-radar/route.ts:12-36
- [text] RDR · FLAGS column shows LOW/MED/HIGH words, not the flag count its header names · LiquidityScreens.cs:306, :326

## Status counts
STATUS-COUNTS app=backoffice screen=RDR WORKS=4 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=2 DEAD=0 DUPLICATE=4
