# bo-FEED · Feed health (backoffice)

Source: E:\vyxtrader\src\Vyx.Backoffice.App\Screens\LiquidityScreens.cs:190-291 (FeedHealthScreen, FEED). Nav: LIQUIDITY › "Feed health" (ShellViewModel.cs:71).

## A. Purpose + panels
Reachability and counters of the trading core (Rust engine), API gateway and price-alert engine, plus per-symbol tick freshness.
Layout: KPI strip (8 tiles, 54 px); row 2 (250 px): 1) CORE "TRADING CORE · FEED STATS", 2) GW "API GATEWAY", 3) ALERTS "PRICE-ALERT ENGINE"; row 3: 4) SYM "PER-SYMBOL FEED" full width (:205-210).

## B. Data
| Panel | Endpoint | ApiClient | Route handler | Refresh | Sort | Empty / error |
|---|---|---|---|---|---|---|
| all | GET /api/manage/feed-health → {feedStats, gatewayStats, alertStats} | FetchFeedHealthAsync ApiClient.ManageG5.cs:74-78; FeedHealth.FromJson :33-44 (a missing/non-object section = null = "down") | app/api/manage/feed-health/route.ts:97-110 | poll 5 s while active (:197); ticks ≤1/s overwrite BID / ASK / LAST TICK per symbol from the live price stream (:227-243) | per-symbol: live first, then symbol asc (:284) | tiles "—" / "not loaded" before first load (:213); error → Status |
Route fan-out (feed-health/route.ts:103-107), each via fetchStats (:75-90: header x-internal-secret = INTERNAL_SERVICE_SECRET, 2 s abort, non-2xx or any exception → null):
- feedStats ← `${TRADING_CORE_URL}/internal/feed-stats` (default http://127.0.0.1:8081, :71)
- gatewayStats ← `${GATEWAY_URL}/internal/gateway-stats` (default http://127.0.0.1:8080, :72)
- alertStats ← `${TRADING_CORE_URL}/internal/alert-stats`
Role: MANAGER, BROKER_ADMIN (:99).

### Where "PRICE ALERTS" status comes from and why it can show NOT REACHABLE
- Tile value = FeedHealth.AlertsUp = (alertStats section is a JSON object) (ApiClient.ManageG5.cs:35); tile text "CONNECTED" / "NOT REACHABLE", note "snapshot ok" / "no snapshot" (LiquidityScreens.cs:247-248).
- There is no separate alert service: alert-stats is a route on the same engine process as feed-stats — engine/server/src/main.rs:1602 → alert_stats :1075-1077, behind the same require_internal_secret layer (:1595-1603, :177-190).
- NOT REACHABLE therefore means the web route got null for `${TRADING_CORE_URL}/internal/alert-stats`: (a) TRADING_CORE_URL unset in the Vercel env → 127.0.0.1:8081 (unreachable from Vercel); (b) INTERNAL_SERVICE_SECRET in the web env ≠ the engine's → 401 (main.rs:186-188); (c) the reverse proxy in front of the loopback-bound engine (Caddy, referenced in deploy/market-data-vps-runbook.md:136-138; its config is not in the repo) does not forward /internal/alert-stats; (d) a running engine binary older than the alert-stats route → 404; (e) > 2 s response. Which one applies is UNVERIFIED (env values, Caddy config and the VPS binary are not readable from the repo; no endpoint calls allowed).
- If CORE is CONNECTED but ALERTS is not, (a) and (b) are excluded (same URL, same secret); the panel then says "alert-stats not answering" (LiquidityScreens.cs:283). If CORE is also down, the panel says "core not reachable".

## C. Controls
| Control | Where | Visible when | Enabled when | Calls | Server effect | Validation | Confirm? | Maker-checker? | Role gate | After action | Status |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Per-symbol row double-click | SYM table | row | always | Shell.Open("SYM", symbol) (:203) | — | — | no | — | — | Symbols screen, row selected | WORKS |
| Right-click → "Symbol settings" | SYM row menu | always | always | as double-click (:204) | — | — | no | — | — | as above | DUPLICATE (row double-click) |
| Right-click → "Live exposure · this symbol" | SYM row menu | always | always | Shell.Open("EXP", symbol) (:204) | — | — | no | — | — | EXP opens unfiltered (LiveExposureScreen.cs:109-113 ignores symbol names) | PARTIAL (symbol focus ignored) |

## D. Dialogs
None.

## E. Text
- Table empty text "no per-symbol feed stats · trading core not reachable" (:202) is shown also when the core answers with an empty per_symbol list.
- SOURCE column is the constant "ENGINE" for every row (:285).
- Tiles "EA → ENGINE p50 / p95", "ROUND TRIP", "ORDER ACK p50 / p95" (:198); CORE rows use snake_case-derived labels ("dropped invalid / missing t0", "mono → UTC offset", :257, :262).
- t0_invalid (route type :22) is not displayed.
- Summary (:190-193) "a missing snapshot = \"not reachable\", which the Qt page notes usually means not deployed yet" — the causes above are broader.

## F. UI structure map
KPI tiles in order: TRADING CORE · GATEWAY · PRICE ALERTS · SYMBOLS TICKING · STALE · > 60 S · EA → ENGINE p50 / p95 · ROUND TRIP · ORDER ACK p50 / p95 (:198, :205).
Panel 1 header: "1) CORE" · "TRADING CORE · FEED STATS"; header-right: Status. Body rows: EA → engine last / p50 / p95; p99 / max; samples; ticks in; queue length; dropped invalid / missing t0; NATS out / publish failures; candle write failures; DB ok / fail (lag); round-trip time; mono → UTC offset — or "NO SNAPSHOT · trading core not reachable".
Panel 2 header: "2) GW" · "API GATEWAY". Rows: WS connections / disconnections; ticks forwarded; NATS messages received; order-ack p50 / p95; order-ack samples — or "NO SNAPSHOT · gateway not reachable".
Panel 3 header: "3) ALERTS" · "PRICE-ALERT ENGINE". Rows: active alerts; triggered (total); persist failures; hot-reload add / cancel / malformed — or "NO SNAPSHOT · alert-stats not answering" / "… core not reachable".
Panel 4 header: "4) SYM" · "PER-SYMBOL FEED"; header-right: stat "<n> LIVE · <n> STALE" or "CORE NOT REACHABLE".
Table (layout "feed-symbols"): SYMBOL · TICKS · 60 S · LAST TICK · BID · ASK · SOURCE · FEED (:202). LAST TICK tone green/amber (>5 s)/red (>60 s); FEED chip LIVE / STALE. Sortable headers, default = client order (live first). Single select. Row click: select; double-click: SYM; Enter: nothing. Right-click on row: YES — "<SYMBOL>" (disabled) / separator / "Symbol settings" / "Live exposure · this symbol" (:204). Right-click empty area: NO. Header: column picker. No toolbar buttons, no chips.

## Issues
- [functional] FEED · PRICE ALERTS "NOT REACHABLE" = web route got null from TRADING_CORE_URL/internal/alert-stats (same engine + secret as feed-stats); env / proxy / binary cause UNVERIFIED · app/api/manage/feed-health/route.ts:71-90, :106; engine/server/src/main.rs:1595-1603, :1075
- [functional] FEED · "Live exposure · this symbol" opens EXP without filtering to the symbol · LiquidityScreens.cs:204; LiveExposureScreen.cs:109-113
- [ux] FEED · every failure mode (timeout, 401, 404, network) collapses to the same "NOT REACHABLE"; the route discards the status code · feed-health/route.ts:85-89
- [text] FEED · empty-table text blames the core even when the core answered with no symbols · LiquidityScreens.cs:202

## Status counts
STATUS-COUNTS app=backoffice screen=FEED WORKS=1 PARTIAL=1 UI-ONLY=0 PLACEHOLDER=0 DEAD=0 DUPLICATE=1
