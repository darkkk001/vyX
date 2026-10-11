# Real-time propagation inventory (read-only, 2026-09-26)

Owner rule: a backoffice change reaches every open client (terminal, backoffice, web trader) within about 1 s, with no restart and no re-login.

Paths: WEB = `D:\VyXTrader-Tauri\vyX`, GW = `WEB\services\api-gateway\src`, ENG = `WEB\engine`, TERM = `E:\vyxtrader\src\Vyx.Trader.App`, SH = `E:\vyxtrader\src\Vyx.Shared`, BO = `E:\vyxtrader\src\Vyx.Backoffice.App`, WT = `WEB\components\webtrader\WebTrader.tsx`.

## 0. The pipes (what exists today)

- **Publish.** `publishTradingEvent(type, payload)` POSTs `{subject, payload:{type,...}}` to GW `/internal/events` (WEB lib/nats.ts:104-136, GW index.ts:74-93).
  - The subject set is closed (lib/nats.ts:32-68): `order.*`, `dealing.queued`, `dealing.activity`, `position.closed|modified|closed_bulk`, `account.balance` (BalanceChanged), `account.updated` (AccountUpdated).
  - `publishAlertConfig` → `cfg.alerts.{brokerId}`, which goes to the engine only (lib/nats.ts:166-186).
  - Each publish has a 2 s timeout. A failure is only `console.warn`ed (lib/nats.ts:118-135).
- **AccountUpdated helpers** (WEB lib/account-events.ts).
  - `publishAccountUpdated` sends to a single account (:21-25). The payload is `{account_id, broker_id, reason}` and carries no values.
  - `publishAccountsUpdatedAfterResponse` runs after the response (`next/server after`, :44-60). It sends one event per account in the group or account type, in batches of 20 (:30-42).
- **Gateway trader stream** `/v1/trading/stream`.
  - It subscribes `order.>`, `margin.>`, `position.>`, `alert.>`, `account.>` (GW ws.ts:429).
  - Sockets are keyed by the session's **account_id only** (ws.ts:464). Messages are routed by `payload.account_id`, and a message without one is dropped (ws.ts:477-492).
  - **No broker-wide path to traders exists.**
- **Gateway admin stream** `/v1/events/stream`.
  - It subscribes `order.>`, `position.>`, `dealing.>`, `account.>` (ws.ts:521). It does **not** subscribe `margin.>` or `alert.>`.
  - Routing is by `payload.broker_id` (ws.ts:595-611).
- **Gateway price stream.**
  - It relays raw `price.tick.*` from the engine (ws.ts:208, 297-320) and applies **no markup** (grep for markup/spread in GW src: none).
  - A per-broker enabled-symbol filter is cached with `SYMBOL_FILTER_TTL_MS = 600_000` (10 min, ws.ts:78, 102-104).
- **Terminal.**
  - `OnTradingEvent` (TERM Services/MarketDataService.cs:278-314) runs on every event: positions + orders + account (`/api/trade/me`) (:307-308, :312).
    - History on PositionClosed/PositionsClosed/OrderFilled (:309).
    - Alerts on AlertTriggered (:310).
    - The BALANCE tab (`/api/trade/transactions`) on BalanceChanged (:311).
    - `RefreshTermsAsync` on AccountUpdated (:311). This refetches `/api/trade/symbols`, the `/api/trade/prices` snapshot (askMarkup and marketClosed) and positions (:602-617).
  - A 4 s poll covers positions and orders only (:1104-1106).
  - The price snapshot (askMarkup) is fetched **only** at sign-in (:1080) and in RefreshTermsAsync (:615). There is no periodic refresh (comment at :1838-1839).
- **Backoffice.**
  - `AdminEvent.Family` (SH Api/AdminEventStreamClient.cs:19-31) maps the type prefix to a family: order | position | dealing | margin | account | *raw lowercased type*.
  - `MainWindow.OnLiveEvent` (BO Views/MainWindow.axaml.cs:156-174) refetches the active screen when its `LiveTopics` contains the family (400 ms debounce, :147). Other screens are only marked stale.
  - `PollTick` refetches the active screen every `LivePollSeconds` (:177-182).
  - Navigation refetches when the last refresh is more than 10 s old (BO Screens/Screen.cs:70-76).
  - Badges and shell-info refresh every 60 s, or at most once per 5 s after any event (MainWindow.axaml.cs:173, 187-191).
- **Web trader.**
  - The trading-stream `handleEvent` (WT:1875-1896) runs `refreshAlerts` for AlertTriggered. Any other type runs `refreshOrders` + `refreshPositions` + `refreshAccount` **only**.
  - The `/api/trade/prices` poll (askMarkup, marketClosed) runs every 30 s (WT:1650-1663, 1728).
  - Symbols and watchlist load on mount and after watchlist edits only (WT:1161-1163, 1446, 3076).

## 1. Inventory

Legend: TERM-E = terminal refreshes on the event; BO topic = LiveTopics family; "poll N" = active-screen poll; "nav" = refetch on navigation after 10 s.

| Data | Written by (route) | Event published? (name · payload · scope) | GW forwards to | Terminal listens → refreshes | Backoffice listens (topic) → screens | Web trader listens → refreshes | Stale today (until) |
|---|---|---|---|---|---|---|---|
| **BrokerSymbol pricing** (spreadMarkup, commission, swap) | PATCH app/api/manage/symbols/route.ts:122 (upsert :283) | **none** (0 publish refs in file) | none | no. askMarkup stays stale | no. SYM/GRP/ATY have no topics | no event. 30 s prices poll picks up the markup | TERM: **until re-login**, or an unrelated AccountUpdated. WT markup ≤30 s. Fill uses the new value at once (DB read per fill). |
| **GroupSymbolConfig pricing** (markup / targetTotalSpread / commission / swap) | PATCH groups/[id]/pricing/route.ts:92 | AccountUpdated `{account_id,broker_id,reason:"group_pricing"}` per account, after response (:145, :194) | trader (per account) + admin (broker) | yes → RefreshTermsAsync → symbols + prices snapshot → askMarkup updated (MarketDataService.cs:311, :615) | family `account` → CLI, DASH, FUNDS, WAL, APPR (not GRP) | event → orders/positions/account only. Markup waits for the 30 s poll | TERM: event latency + fan-out time (N/20 batches, each ≤2 s; UNVERIFIED wall time for large groups; `after()` is subject to the function's maxDuration, UNVERIFIED). WT ≤30 s. BO GRP screen on another tab: nav. |
| **AccountTypeSymbolConfig / AccountType pricing** | PATCH account-types/[id]/pricing (:131, :180); account-types/[id] (:106) | AccountUpdated per account on the type (`account_type_pricing` / `account_type`) | trader + admin | yes (RefreshTermsAsync) | `account` family (as above); ATY nav | 30 s poll | same as group |
| **AccountSymbolConfig pricing** | PATCH accounts/[id]/pricing (:133, :182) | AccountUpdated single account (`account_pricing`) | trader + admin | yes | `account` family | 30 s poll | TERM ~event latency; WT ≤30 s |
| **Symbol settings**: enabled, min/max lot, lot step, trading mode, stop level, hedged margin %, max exposure | PATCH manage/symbols/route.ts:122 | **none** | none | no. Symbols dict comes from sign-in (:1062-1064) | no (SYM has no topic) | no. Symbols load on mount only | TERM + WT: **until re-login / page reload**. Server enforces at order time immediately. Gateway tick filter for enable/disable ≤10 min (ws.ts:78). |
| **Group symbols** (allowed set) | PUT/PATCH groups/[id]/symbols (:100) | AccountUpdated fan-out `group_symbols` | trader + admin | yes → symbols + watchlist reload if the set changed (:607-609) | `account` family | no symbol refresh | WT until reload |
| **Trading hours / sessions** | PUT symbols/[id]/sessions/route.ts:42 (:78-79) | **none** | none | no. `IsMarketClosed` evaluates `Symbols[].Sessions` loaded at sign-in (:105-109) | no | marketClosed via the 30 s prices poll (server computes it, prices/route.ts:48-50) | TERM **until re-login**. WT ≤30 s. Server enforces at order time. |
| **Account leverage / status (suspend) / maxDailyLoss / swapFree / type** | PATCH accounts/[id]/route.ts:28 (publish :255) | AccountUpdated `account` | trader + admin | yes → /me (leverage, levels) + terms | `account` → CLI, DASH, FUNDS, WAL, APPR | yes → refreshAccount | ~event latency. Whether a suspended session is forced out: UNVERIFIED (status is checked at login, lib/account-auth.ts:315). |
| **Account group change** | PATCH accounts/[id] (groupId, :42) | AccountUpdated `account` | trader + admin | yes (terms + askMarkup + /me levels) | `account` | account only; markup ≤30 s; symbols never | WT symbols until reload |
| **Group settings** (leverage, MC/SO levels, category, mode) | PATCH groups/[id]/route.ts:21 (:164) | AccountUpdated fan-out `group` | trader + admin | yes | `account` (GRP not) | account yes | fan-out latency |
| **Balance: deposit/withdrawal approve** | PATCH funds-requests/[id] (:118) | BalanceChanged `{account_id,broker_id,transaction_id}` (`account.balance`) | trader + admin | yes → BALANCE tab (:311) + /me (:312) | family resolves to **`balancechanged`** (AdminEventStreamClient.cs:23-29) and matches **no** screen. FUNDS poll 20 s (FundsScreen.cs:25), WAL 15 s, DASH 30 s, CLI none | yes → account. Funds history not refreshed | BO CLI: nav (10 s) only. BO FUNDS ≤20 s. WT funds history until modal reopen. |
| **Balance: adjustment** | POST accounts/[id]/adjust-balance (:85); balance-adjustment-requests/[id]/approve (:46) | BalanceChanged | trader + admin | yes | none (as above) | account | as above |
| **Balance: transfer** | POST manage/transfers (:102-103, both legs) | BalanceChanged ×2 | trader + admin | yes | none | account | as above |
| **Balance: IB payout** | ib-relationships/[id] (:55) | BalanceChanged | trader + admin | yes | none | account | as above |
| **Credit** | no backoffice route writes `Account.credit` (grep app/api/manage: none); TransactionType CREDIT exists (prisma/schema.prisma:101) | n/a | n/a | /me carries credit | n/a | n/a | UNVERIFIED how credit is set today |
| **Trader funds / KYC request created** (trader side) | app/api/trade/funds-requests, app/api/trade/kyc | **none** | none | n/a | FUNDS poll 20 s; KYC poll 30 s (KycScreen.cs:27); badges ≤60 s | n/a | BO ≤20-60 s |
| **Margin level** | derived (price × positions) | none. `margin.>` has **no publisher** (grep), and the admin stream does not subscribe it (ws.ts:521) | trader subscribes `margin.>`, but nothing arrives | computed locally per tick (RecomputeAccountPanel :1612-1641, MC/SO levels from /me Models.cs:107-109) | RISK/MRG `margin` topic never fires; poll 10 s (RiskScreen.cs:24-25, 124-125) | local | BO ≤10 s. Clients live. |
| **Margin call** | none (no margin-call event anywhere; lib/margin.ts uses the level only for pre-trade reject) | **none** | none | local panel flag only | RISK/MRG poll 10 s | local | no alert to anyone |
| **Stop-out** | lib/risk-monitor.ts:221, :280 (via engine risk hook) | PositionClosed `{position_id,account_id,broker_id,reason:"stop_out"}` | trader + admin | yes (positions, history, account) | `position` → DEALS, DASH, EXP, DEAL, RISK, MRG, WAL, LIQ, AUDIT, APPR, MIR, CLI | yes | ~event latency |
| **Broker trading halt / close-only** | PATCH manage/risk/route.ts:44 (tradingHaltedAt/closeOnlyAt :85-94) | **none** | none | no. The trader learns at the order reject | EMG nav only; no topic | no | TERM/WT: until they trade. Other BO tabs: nav. |
| **Group halt / close-only** | groups/[id]/halt (:62) | AccountUpdated fan-out `group_halt` | trader + admin | yes (terms + /me). Whether the halt is displayed: UNVERIFIED | `account` family (EMG/GRP not) | account only | BO EMG/GRP on another tab: nav |
| **Dealing desk on/off, auto-hedge (broker)** | PATCH dealing-desk-toggle (broker.update :80-86) | only the OrderFilled events for queue orders flushed when turned off (:286). The toggle itself publishes **nothing** | admin (fills) | n/a (server-side mode) | DEAL (order/position/dealing, poll 10 s); toggle state on other tabs: DEAL poll ≤10 s, others nav | n/a | BO other tabs ≤10 s / nav |
| **Group dealing mode / category** | PATCH groups/[id] | AccountUpdated fan-out | trader + admin | terms refresh | `account` | account | fan-out latency |
| **Mirror rules** (create/edit/kill) | POST mirror-rules; PATCH mirror-rules/[id]:134 (:216); kill-switch lib/mirror.ts:162-202 | **none** | none | n/a | MIR topics order/position (ApprovalsMirrorScreens.cs:125), no poll | n/a | BO MIR: until the next fill/close or nav |
| **Payment methods** | PATCH manage/payment-methods:83 (:134) | **none** | none | n/a (no terminal funds UI found) | PSP nav | `refreshPaymentMethods` (WT:1289-1293), trigger UNVERIFIED (mount / funds modal) | WT until the funds modal is reopened / reload (UNVERIFIED) |
| **KYC status** | PATCH kyc-requests/[id]:7, client-kyc-requests/[id]:7, POST accounts/[id]/kyc | **none** | none | n/a | KYC poll 30 s, badges 60 s | `refreshKycStatus` (WT:1294), no event | WT until reload / reopen |
| **Staff / permissions** | POST admins, PATCH admins/[id]:6 | **none** | none | n/a | server enforces per request (lib/permissions.ts:19 reads adminUser); BO chrome shell-info refresh ≤60 s (MainWindow.axaml.cs:191); nav visibility re-derived: UNVERIFIED | n/a | BO UI ≤60 s (UNVERIFIED) |
| **Fills (trader, dealer, admin open, pending trigger, mirror, coverage)** | trade/orders:448,677; dealing-queue/[id]:385; manage/positions:425; pending-trigger.ts:293; mirror.ts:467; coverage.ts:543; positions/[id]/book:145; coverage/orders:133 | OrderFilled (account_id, broker_id) | trader + admin | yes (positions, orders, history, account) | `order` → DASH, CLI, EXP, DEAL, AUDIT, MIR | yes | ~event latency |
| **Closes (trader/admin/bulk/close-by/void/SL-TP/queued)** | trade/positions/[id]/close:284; manage/positions/[id]/close:143; bulk-close.ts:200; close-by.ts:158; manage close-by:114; void:64; post-close.ts:142; queued-close.ts:257 | PositionClosed / PositionsClosed | trader + admin | yes | `position` | yes | ~event latency |
| **SL/TP edited by admin** | PATCH manage/positions/[id]/route.ts:23 (update :94-97) | **none** | none | 4 s positions poll (:1104-1106) | no event; DEAL poll 10 s, RISK 10 s, others nav | 30 s poll (WT:1728) | TERM ≤4 s; WT ≤30 s; BO ≤10 s / nav. Engine risk hook reloads levels every 5 s (ENG server/src/main.rs:1498, risk_hook.rs:121) |
| **SL/TP edited by trader** | PATCH trade/positions/[id]:90 | PositionModified | trader + admin | yes | `position` | yes | ok |
| **Pending order edit/cancel** | trade/orders/[id]:175, :263 | OrderModified / OrderCancelled | trader + admin | yes | `order` | yes | ok |
| **Dealer queue** (new request, requote, reject) | trade/orders:523; pending-trigger.ts:186; queued-close.ts:147; dealing-queue/[id]:144,190 | DealingQueued (`dealing.queued`); OrderRequoted / OrderRejected (`order.*`) | DealingQueued: admin only (the trader stream has no `dealing.>`); order.*: both | requote/reject yes. DealingQueued from a pending trigger is not seen, so it waits for the 4 s poll | `dealing` → DEAL, DASH, EXP, NOTIF, AUDIT + beep (MainWindow.axaml.cs:159-164) | order.* yes | ok (TERM ≤4 s for the trigger-queued case) |
| **Dealer activity** | lib/dealer-activity.ts:96 | DealerActivity `dealing.activity` | admin only | n/a | `dealing` | n/a | ok |
| **Price alerts** (trader) | trade/alerts:78, alerts/[id]:27 → `cfg.alerts.{broker}` to the engine; trigger ENG server/src/main.rs:654-666 `alert.triggered` `{type:"AlertTriggered",account_id,broker_id,...}` | trader (alert.>) | yes → alerts (:310) | not subscribed (n/a) | yes → toast + refreshAlerts (WT:1887-1891) | ok |
| **Backoffice notifications** | notifications, notifications/[id] PATCH (mark read) | none | none | n/a | NOTIF `dealing` + poll 20 s (NotificationsAuditScreens.cs:26-27) | n/a | other tabs ≤20 s / nav |
| **Group / account-type / symbol lists on a 2nd admin tab** | any GRP/ATY/SYM write | AccountUpdated (GRP/ATY only) | admin | n/a | GRP/SYM/ATY have **no LiveTopics and no poll** | n/a | nav (10 s throttle) |

## 2. Quote path

1. **Raw tick.** The MT5 EA / feed goes into ENG market-data ingest, which publishes `price.tick.{symbol}` raw `{symbol,bid,ask}` (ENG market-data/src/ingest.rs:601-609).
2. **Display bid/ask.**
   - GW `attachPriceStream` relays raw ticks unchanged, filtered by the broker's enabled symbols with a 10 min TTL (GW ws.ts:208, 297-320, 78).
   - The terminal takes them from `wss://feed.{root}/v1/prices/stream` (SH Api/PriceStreamClient.cs:77).
   - **Neither the engine nor the gateway applies any markup to displayed ticks.**
3. **Display markup (client side).**
   - `GET /api/trade/prices` returns `askMarkup` per symbol (WEB app/api/trade/prices/route.ts:134-172).
     - Flag off: `GroupSymbolConfig.spreadMarkup ?? BrokerSymbol.spreadMarkup` (:162).
     - Flag on (`Broker.pricingEngineEnabled`): `resolvePricingV2` over Account > AccountType > Group > Broker, then `resolveEffectiveSpreadMarkup` against the **live spread at request time** (:138-156).
   - Terminal:
     - `_askMarkup` is filled only by `RefreshPricesSnapshotAsync` (MarketDataService.cs:1840-1851).
     - That runs at sign-in (:1080) and on AccountUpdated (:615).
     - The markup is applied to Market Watch, the ticket and one-click (`WatchTick` :101; `Ticket.SetPrices(..., AskMarkupFor)` :1478, :1594, :1806, :2225; `ClientQuote.Traded` SH Trading/ClientQuote.cs:14-20).
   - Web trader: `askMarkupBySymbol` comes from the 30 s prices poll (WT:1649-1663, 1728). It is applied via `effectiveAsk` (WT:4007, 4199, 4922).
4. **Fill markup (server).**
   - Every live fill site calls `resolveFillPricing` (WEB lib/pricing-engine.ts:299-339), then `applySpreadMarkup` (lib/group-pricing.ts:45-54). The markup is on the BUY ask only.
   - Call sites: trade/orders/route.ts:392/405, :566/580; dealing-queue/[id]:309/330; dealing-desk-toggle:231/245; manage/positions:333/346; requote-response:190/203; pending-trigger.ts:217/231; mirror.ts:367/383.
   - Config is read from the DB **per fill**, so a backoffice change applies to the next fill immediately.
   - Target-spread mode uses the live spread **at fill time**.
5. **The engine path uses BrokerSymbol only.**
   - ENG order-management `get_broker_symbol_config` reads `COALESCE(bs."spreadMarkup",0)` from BrokerSymbol only (ENG order-management/src/db.rs:447). It is applied at lib.rs:235-240 and pending_orders.rs:114-118.
   - Its route is GW `/v1/orders/*` → `TRADING_CORE_URL` (GW routes/orders.ts:96, 164, 204). **No client calls it**: there are no `v1/orders` references in WEB app/lib/components or in E: src. The path is dormant today.
   - If it is ever enabled, fills there ignore Group, AccountType and Account markup, so display ≠ fill.
6. **Does a GRP markup change reach an open terminal's displayed quote?**
   - **Yes**, when it is saved through `PATCH /api/manage/groups/{id}/pricing`. The route fans out AccountUpdated after the response (:145/:194). The event reaches the trader stream by account_id, and the terminal runs RefreshTermsAsync, which re-fetches `/api/trade/prices` and updates `_askMarkup`.
   - Latency is the Vercel `after()` fan-out (batches of 20, each publish ≤2 s) plus the gateway hop plus one REST round trip. For small groups that is plausibly around 1 s. Large groups: UNVERIFIED.
   - **No** for a BrokerSymbol markup change (SYM, `PATCH /api/manage/symbols`): nothing is published, so the terminal keeps the old askMarkup **until re-login** (or an unrelated AccountUpdated). The web trader picks it up at the next 30 s poll.
   - **Drift in target-spread mode (flag on).** The terminal freezes the askMarkup computed from the spread at fetch time; with no periodic refresh, displayed ask ≠ fill ask whenever the raw spread moves. The web trader drifts up to 30 s.
   - A web trader receiving AccountUpdated does **not** refetch prices, so a GRP change reaches it only at the 30 s poll.

## 3. Minimal changes to meet the rule

1. **Broker-scoped trader events.** Add a subject family (for example `broker.config.>` with `{broker_id, reason, symbol?}`) that GW `attachTradingEventStream` forwards to every trader socket of that broker. Register sockets by `session.brokerId` as well, at ws.ts:464, and subscribe the new family at ws.ts:429. The admin stream should subscribe it too, at ws.ts:521.
2. **Publish it** (reason `symbol` / `sessions` / `broker_halt` / `dealing_mode` / `payment_methods`) from:
   - `PATCH manage/symbols`
   - `PUT manage/symbols/[id]/sessions`
   - `PATCH manage/risk` (halt / close-only)
   - `PATCH dealing-desk-toggle`
   - `PATCH manage/payment-methods`

   A per-account fan-out through `fanOutAccountUpdated` with `{brokerId}` would also work but costs N HTTP publishes.
3. **Terminal.** Treat the new broker event like AccountUpdated (`RefreshTermsAsync`, MarketDataService.cs:311). Also add a periodic `RefreshPricesSnapshotAsync` (about 5-10 s), or recompute target-spread markup client-side, so askMarkup and marketClosed never freeze.
4. **Web trader.** In `handleEvent` (WT:1893-1896):
   - On `AccountUpdated` or the broker event: also call `refreshSymbolsAndWatchlist` and an immediate prices fetch (askMarkup).
   - On `BalanceChanged`: also call `refreshFundsHistory`.
   - On a payment-methods or KYC reason: call `refreshPaymentMethods` / `refreshKycStatus`.
5. **Backoffice family mapping.** Map `BalanceChanged` (and `balance*`) to `account` in `AdminEvent.Family` (SH Api/AdminEventStreamClient.cs:19-31), so CLI/FUNDS/WAL/DASH refresh on deposits, adjustments, transfers and IB payouts.
6. **Backoffice config topics.** Add a `config` family, fed by the broker event and by AccountUpdated reasons `group*` / `account_type*`, to the LiveTopics of GRP, SYM, ATY, EMG, PSP, TEAM, MIR and DEAL (the desk toggle), so a second admin tab refreshes.
7. **Admin SL/TP.** `PATCH manage/positions/[id]` must publish `PositionModified` (the route has none, :94-127).
8. **Margin.** Either publish `margin.call` / `margin.level` from the engine margin watch (ENG server/src/main.rs:1504-1510) with account_id and broker_id, and subscribe `margin.>` on the admin stream (ws.ts:521), or drop the dead `margin` topic from RISK/MRG and keep the 10 s poll.
9. **Mirror, KYC, trader funds requests.**
   - Mirror rule create/edit/kill (mirror-rules routes, lib/mirror.ts:162-202): publish a broker-scoped event.
   - KYC PATCH routes: same.
   - Trader-created funds/KYC requests: publish a broker-scoped event (`dealing` or a new `requests` family) so FUNDS/KYC/LAR stop relying on 20-30 s polls.
10. **Gateway tick filter.** Invalidate the gateway's enabled-symbol cache (ws.ts:78, `refreshSymbolFilter`) on the broker symbol event, instead of waiting for the 10 min TTL.
11. **Engine path (only if the gateway `/v1/orders` path is ever enabled).** `get_broker_symbol_config` (ENG order-management/src/db.rs:447) must resolve Group, AccountType and Account markup the way `resolveFillPricing` does.

## Closed (2026-09-26)
All findings above CLOSED by web a16042d + 531427a (+ build fix 8bf7c74) and native 4dad6aa (backoffice 1.0.28, terminal 1.0.47), feeds 3970deb:
trader stream now forwards broker-wide ConfigChanged; every config write route publishes (withConfigEvent); terminal re-reads on ConfigChanged + 30 s safety net; BalanceChanged -> account family; MarginCall event added; admin SL/TP edits publish PositionModified; quote = fill incl. target-spread mode. Gateway VPS deploy pending for the fan-out to reach production clients.
