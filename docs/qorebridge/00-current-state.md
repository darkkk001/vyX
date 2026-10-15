# QoreBridge: current state of VyXTrader (read-only audit, 2026-10-15)

Scope: C:\vyx\web at main, plus `feat/bo-1.0.72` of C:\vyx\native for the backoffice screen. No code was run. Line numbers are from this checkout and drift; use the function names.

Headline: **there is no LP/hedge execution anywhere today.** The Liquidity tab is a contact list, `A_BOOK` orders are refused (`LP_NOT_CONNECTED`), and the only "hedge" is an internal coverage account (a bookkeeping mirror of a client leg) that a separate, off-repo copier may relay to MT5. The web app, not the Rust engine, decides every fill.

## 1. Liquidity tab and API

| Route | Verb: file:line | What it does |
|---|---|---|
| `/api/manage/liquidity` | GET `app/api/manage/liquidity/route.ts:11` | Open-position volume per symbol split A_BOOK/B_BOOK (`position.groupBy`). BROKER_ADMIN only. Read-only. |
| `/api/manage/liquidity-providers` | GET `route.ts:18`, POST `:46` | List / create LP rows (+ AuditLog). |
| `/api/manage/liquidity-providers/[id]` | PATCH `[id]/route.ts:7`, DELETE `:75` | Edit / delete; delete is refused (409) while routing rules point at it. |
| `/api/manage/lp-routing` | GET `route.ts:16`, POST `:45` | List / create `LpRoutingRule` (provider, optional symbol, priority). |
| `/api/manage/lp-routing/[id]` | DELETE `[id]/route.ts:5` | Delete a rule. |
| `/api/manage/reports/lp` | GET `reports/lp/route.ts:11` | Report over providers. |

- **Model** `LiquidityProvider` (`prisma/schema.prisma:2493`): `id, brokerId, name, contactName, contactEmail, contactPhone, protocol (free text String?), status LpStatus, notes, createdAt, updatedAt, routingRules[]`.
- **Enum** `LpStatus` (`:2486`): `PROSPECTIVE, NEGOTIATING, CONTRACTED, CONNECTED`. There is **no protocol enum**: `protocol` is free text ("FIX 4.4", "REST API"). The comment on `RoutingCategory.A_BOOK` (`:271`) mentions MT4/MT5/cTrader/FIX, but no per-group bridge fields exist.
- `LpRoutingRule`: `liquidityProviderId, symbolId?, priority, notes`. Schema comment: "no execution path reads this yet".
- **Nothing is connection state.** No session, heartbeat, last-seen, credentials or status is written by code; `status` is hand-edited. The schema deliberately omits a credentials field.
- `lib/liquidity.ts` `isLpConnected()` is hard-coded `false`: "When the bridge is built, this is the one place that learns the group's connection state."
- **Backoffice screen**: `LiquidityScreen` in `src/Vyx.Backoffice.App/Screens/LiquidityScreens.cs` (nav code `LP`; `ROUTE` merged into it). Models and fetchers in `src/Vyx.Shared/Api/ApiClient.ManageG5.cs` (`:16-24`, `:81-83`) and create at `ApiClient.ManageG6.cs:142`. `GroupsScreen.cs:155` also fetches the providers. Its doc says "no live FIX session state exists on the server".
- Web UI: `app/manage/(shell)/liquidity/LiquidityManager.tsx`, `liquidity-routing/LpRoutingManager.tsx`.

## 2. Order path (MARKET, A_BOOK group)

Terminals call `POST /api/trade/orders` (native `ApiClient.cs:354-369`, `Batch9A.cs:37`), i.e. the **Next.js route**, not the gateway/engine order route.

1. `app/api/trade/orders/route.ts` `POST` (`:82`): validate, idempotency lookup (`:171`, unique `accountId_idempotencyKey`), live price via `getLivePriceRow` (`:161`, `lib/live-price.ts:91`).
2. **Routing read**: `orderRoute(account.group, deskIsOn(broker))` at `route.ts:271`, defined `lib/dealing-routing.ts:37` (`switch group.category`): `DEALING -> QUEUE|FILL`, `A_BOOK -> isLpConnected() ? FILL : NO_LP`, `COVERAGE -> SYSTEM`, else `FILL`.
3. `NO_LP` returns 400 `LP_NOT_CONNECTED` (`route.ts:272`). Same gate in `lib/pending-trigger.ts:192` (resting orders), `lib/account-structure.ts:78` (an A_BOOK group takes no accounts) and `app/api/portal/groups/route.ts:41` (A_BOOK hidden from sign-up). **So today an A_BOOK order never fills.**
4. If it ever got past: pricing `resolveFillPricing` (`lib/pricing-engine.ts`), `applySpreadMarkup`, slippage and margin gates, then the **fill decision** in the `type === "MARKET"` block (`route.ts:~626-700`): one `prisma.$transaction` creates `Order{status:FILLED, filledPrice}` and `Position{bookType}`, charges commission, writes AuditLog `ORDER_FILLED`, publishes events. `bookType = resolveBookType(group.category)` (`lib/group-pricing.ts:19`): A_BOOK and COVERAGE give `A_BOOK`, everything else `B_BOOK`. That value is only a label on the position; **nothing is sent to an LP**.
5. DEALING queue branch (`route.ts:~425-470`): `Order{status:PENDING}` with no Position, filled later by a dealer via `app/api/manage/dealing-queue/[id]/route.ts:364`. Other web fill sites: `lib/pending-trigger.ts:290`, `requote-response/route.ts:231`, `manage/positions/route.ts:434`, `lib/mirror.ts:451`, `lib/position-actions.ts:369`.
6. **Engine**: has its own `place_market_order` (`engine/order-management/src/lib.rs:146`, HTTP `/v1/orders/market`, `engine/server/src/main.rs:326`, called only by `services/api-gateway/src/routes/orders.ts:96`). It never reads `Group.category`; its routing knowledge is limited to `Broker.riskAuthority` / `RUST_OWNED_SQL` (`engine/order-management/src/authority.rs:80`). Production **risk** (SL/TP, stop-out, margin watch) is engine-owned after the Stage 6 cutover; **order placement/fill stays on the web path.**
7. Hedge/coverage today: the broker clicks BOOK NOW (`app/api/manage/positions/[id]/book`), which mirrors the same-side leg onto the broker's system COVERAGE account (`lib/coverage.ts`, `Broker.coverageAccountId`), at raw price, zero commission, `bookType=A_BOOK`. Dealer coverage orders: `app/api/manage/coverage/orders/route.ts:26`, resting ones `lib/coverage-pending.ts`. All internal. `docs/STATE-OF-PROJECT.md:86` (older): "there is no hedge execution anywhere in the codebase".

**Where a bridge would hook in** (all in the web path, because that is what fills):
- Pre-fill route: replace `isLpConnected` (`lib/liquidity.ts`) with a per-group connection check, and add a `BRIDGE` result to `orderRoute` (`lib/dealing-routing.ts:37`).
- Pending state: `OrderStatus` already has `PENDING`, `ACCEPTED`, `REJECTED`, `REQUOTED`. A bridged order can be created `ACCEPTED/PENDING` with no Position, then completed by an async fill callback that runs the same fill transaction used by the dealing queue (`dealing-queue/[id]/route.ts:364`), or rejected. The DEALING queue is the closest template (order held, someone else decides, fill tx later, events published).
- Post-fill (hedge) only: after the existing fill tx, enqueue an outbox row and let the bridge hedge. This is hedge-after-fill, not LP-priced execution.

## 3. Coverage copier (`vyx-mt5-copier`)

- **Source is not on C:.** It lives in GitHub `darkkk001/vyx-mt5-copier` (cloned only by `scripts/backup-platform.ps1:34` for backups). Nothing in `C:\vyx-secrets\tools` is related (only `daily-check.ps1`, `daily-check.sql`, `send-test-ops-alert.ts`). No runbook in docs/ describes it. What follows is inferred from this repo; verify against the copier repo.
- Evidence of its interface: it is "headless" and authenticates with `x-internal-secret`. (a) The gateway admin event stream `ws /v1/events/stream?brokerId=` accepts the internal secret for "vyx-mt5-copier and similar" (`services/api-gateway/src/ws.ts:610-630`; the stream carries `order.>`, `position.>`, `dealing.>`, `account.>`, `config.>`, `ws.ts:588`). (b) It formerly read `GET /api/manage/accounts/[id]/positions` with the secret; that branch was **removed** (Phase 2 batch 8, `app/api/manage/accounts/[id]/positions/route.ts:9-13`), so it now needs a staff login or a new broker-scoped route. Whether it still works in production is unknown.
- Likely shape (unverified): a process on the MT5 host that listens to coverage-account position events and places mirrored orders on a real MT5 account (Python `MetaTrader5` package or an EA; not determinable here). Latency would be WebSocket event latency plus MT5 round trip, with no ack back into VyXTrader (nothing in this repo records an external hedge ticket).
- Failure modes by design: events are at-most-once (core NATS; only `book.seq` gap markers, `engine/market-data/src/book_events.rs`), the MT5 terminal must be logged in, no fill/rejection feedback, breakage on secret rotation (rotated 2026-09-28).
- **Reusable as a hedge connector?** As a pattern yes (event-driven, coverage account as the source); as code, undetermined until its repo is read. It has no per-LP routing, no confirmation path, and a stale auth path, so QoreBridge should treat it as a prototype of an MT5 adapter rather than depend on it.

## 4. Engine interfaces

Binary: `engine/server/src/main.rs` (HTTP, default `127.0.0.1:8081`, behind Caddy). Auth: `x-internal-secret` (`require_internal_secret`, `:192`, with `INTERNAL_SERVICE_SECRET_PREVIOUS` overlap), `x-price-feed-secret` for ingest (`:623`), read-only `X-Market-Data-Secret` for market-data reads (`:219`).

HTTP (`main.rs:1983-2012`): `POST /v1/orders/market`, `/v1/orders/pending`, `/v1/orders/{id}/cancel`, `/v1/positions/{id}/modify`, `/v1/positions/{id}/close`, `GET /internal/feed-stats`, `/internal/alert-stats` (internal secret); `GET /internal/candles`, `/internal/prices`, `/internal/prices/{symbol}` (read secret); `GET /health`, `/internal/time`; `POST /internal/price-feed`, `/internal/history`, `/internal/synth-feed` (feed secrets).

NATS (core NATS, no JetStream; JSON payloads):

| Subject | Direction | Payload |
|---|---|---|
| `price.tick.{symbol}` | engine publishes (`engine/market-data/src/ingest.rs:651-660`); gateway `ws.ts:218` and engine `main.rs:1235` subscribe | `protocol::Tick` (`engine/protocol/src/lib.rs:50`) |
| `order.accepted/rejected/filled/partially_filled/cancelled/expired`, `margin.call`, `margin.stop_out`, `position.stop_loss_hit/take_profit_hit/closed/modified` | engine publishes (`engine/order-management/src/events.rs`, `subject_for`) | `protocol::TradingEvent` (`lib.rs:175`), `Fill`, `RiskRejection` |
| same families plus `order.requoted`, `dealing.*`, `account.*`, `config.changed`, balance events | **web** publishes via gateway `POST /internal/events` (`services/api-gateway/src/index.ts:83`; subject map `lib/nats.ts` `SUBJECTS`) | JSON per `lib/nats.ts` |
| `book.seq` | gateway stamps (`services/api-gateway/src/book-seq.ts`) | `{book_epoch, book_seq, subject}` |
| `alert.triggered`, `cfg.alerts.*` | engine publishes / subscribes (`main.rs:694`, `:1364`) | price alerts |
| `account.updated`, `config.changed`, `order.>`, `position.>` | engine subscribes (`market-data/src/pricing.rs` `PRICING_CHANGE_SUBJECTS`; `book_events.rs:206` `BOOK_CHANGE_SUBJECTS`) | pricing reload, book sequencing |

There is **no inbound "place order" NATS subject**; orders enter by HTTP only, and the engine's order route is not what terminals use.

Engine DB writes (Postgres, sqlx): `LivePrice`, `Candle` (Neon and/or the local VPS store, `market-data/src/sink.rs`, `MARKET_DATA_WRITE`), `Order`, `Position`, `Account`, `Transaction`, `Notification`, `AuditLog`, `PostCloseEffect` outbox (`order-management/src/outbox.rs`, web consumer `/api/internal/post-close`, `lib/post-close.ts`), `PriceAlert`, `RiskEngineHeartbeat`, `Broker`/`BrokerSymbol` (provisioning/test paths), and parity/shadow tables. It reads `Broker.riskAuthority`, `Group`, `BrokerSymbol`.

**Integration options for a separate bridge service on the same VPS**

| Option | Pros | Cons |
|---|---|---|
| A. Subscribe to NATS (`order.>`, `position.>`) and publish fills back | Matches the existing bus; no engine change for observing | Core NATS is at-most-once; web fills reach NATS only via gateway `/internal/events`; no inbound order subject exists; a fill callback still needs an HTTP/DB path into the web's fill transaction |
| B. Internal HTTP API on the web (new, secret header, broker-scoped) | Bridge calls fill/reject on the same fill tx the dealing queue uses; reuses the auth pattern; synchronous ack; testable | Web must also call the bridge (pre-fill) or the bridge must poll; new routes |
| C. DB outbox table (`BridgeIntent`) written in the order transaction | Exactly-once with the order, survives crashes, same idiom as `PostCloseEffect`; bridge polls, optionally nudged by NATS | Needs a migration; polling latency unless paired with a NATS nudge |

Recommended: **C + B**. The web writes a bridge-intent outbox row inside the order transaction (A_BOOK path, order held PENDING) and nudges the bridge over NATS (`bridge.intent.*`, loss-tolerant because the bridge also polls). The bridge reports results through a new internal HTTP endpoint (`/api/internal/bridge/fill`, secret header) that runs the existing fill transaction. One place decides fills (the web), the Stage-3 outbox idiom is reused, and the Rust engine hot path is untouched.

## 5. Feed path

| Hop | Where |
|---|---|
| MT5 EA captures bid/ask, POSTs batches (with `t0`, clock offset) | `mt5-ea/VyXTraderPriceFeed.mq5` (`ServerUrl` line 12; symbol suffix handling ~line 154; autostart `mt5-ea/deploy/vps-autostart.ps1`) |
| Web thin forwarder `app/api/internal/price-feed/*` and `lib/price-feed.ts:35` (also runs risk evaluation, `:62`) | forwards to the engine with `x-price-feed-secret` |
| Engine ingest `ingest_price_feed` `engine/server/src/main.rs:617` to `market_data::ingest::ingest_ticks` `ingest.rs:111` | `TickCache.set` (`cache.rs`), alert check, `publish_tick` `ingest.rs:651` (`price.tick.{symbol}`) |
| Persistence | `spawn_periodic_flush` (`ingest.rs:177`), `flush_live_prices` `:408`, `flush_candles` `:455`, targets via `write_to_targets` `:295` and `sink.rs` `MarketDataPools` (Neon and/or local VPS) |
| Risk trigger | `risk_hook.rs` `RiskHook`, `spawn_risk_trigger` `ingest.rs:272` |
| Gateway WS fan-out | `services/api-gateway/src/ws.ts:218` (`attachPriceStream`); per-account markup applied server side (`client-ask.ts`) |
| Web reads | `lib/live-price.ts` `getLivePriceRow` (`:91`) to `lib/market-data-client.ts` (`MARKET_DATA_URL`, `MARKET_DATA_READ_SECRET`, 2 s timeout, falls back to Prisma `LivePrice`) to engine `/internal/prices` |

Where an alternate per-broker LP feed could plug in:
- `Tick` has **no source/LP field** and `LivePrice`/`TickCache` are keyed by `symbol` only, so today there is one global feed shared by all tenants. A per-broker feed needs a source dimension (cache/table key, `price.tick.{broker}.{symbol}` or a `source` field) and a selection step.
- Ingest has no source trait; it is HTTP routes: `/internal/price-feed` (real) and `/internal/synth-feed` (synthetic, own secret that must differ from `PRICE_FEED_SECRET`, `main.rs:47`, `:1439`). A new LP-feed route with its own secret is the smallest hook; the synthetic route is the precedent.
- Symbol mapping: only canonical names (`lib/synthetic-symbols.ts:35` `canonicalSymbolName`) and the EA's suffix handling; no LP-symbol mapping table exists (new).
- Per-broker/per-group price: `engine/market-data/src/ask_markup.rs` (`resolve :62`, `account_ask :91`, `PricingSnapshot`, `PricingScope`) and `pricing.rs` (`PricingCache`, reloaded on `config.changed`/`account.updated`) apply markup to the one raw tick. A per-LP raw price would be chosen before this step.

## WIRE vs NEW

| Capability | Status | Files |
|---|---|---|
| LP/provider records, routing-rule records, backoffice screen | WIRE (exists) | `prisma/schema.prisma:2493`, `app/api/manage/liquidity-providers/*`, `app/api/manage/lp-routing/*`, native `LiquidityScreens.cs` |
| Category-based routing switch and refusal | WIRE (one function) | `lib/liquidity.ts`, `lib/dealing-routing.ts:37`, `app/api/trade/orders/route.ts:271` |
| Held order awaiting an external decision, later fill tx | WIRE (template) | `OrderStatus.PENDING`, `app/api/manage/dealing-queue/[id]/route.ts:364`, `lib/pending-trigger.ts` |
| Event bus and fan-out to terminals | WIRE | `lib/nats.ts`, `services/api-gateway/src/index.ts:83`, `ws.ts` |
| Outbox idiom (exactly-once effects) | WIRE (pattern) | `engine/order-management/src/outbox.rs`, `lib/post-close.ts`, `PostCloseEffect` |
| Coverage account as hedge source | WIRE | `lib/coverage.ts`, `lib/coverage-pending.ts`, `book` route |
| Internal-secret auth pattern, rotation scripts | WIRE | `engine/server/src/main.rs:192`, `deploy/rotate-*` |
| Connection state per LP (session, heartbeat, last error) | NEW | new columns/table next to `LiquidityProvider` |
| Credentials storage (encrypted) | NEW | none exists by design |
| Protocol taxonomy and per-group bridge config | NEW | replace free-text `protocol`; per-group link to a provider |
| Bridge service (FIX/MT5/cTrader adapters), order and fill state machine | NEW | new service, e.g. `services/qorebridge/` |
| Bridge-intent outbox plus internal fill/reject endpoint | NEW | new migration, `app/api/internal/bridge/*` |
| Real `isLpConnected`, `BRIDGE` route | NEW | `lib/liquidity.ts`, `lib/dealing-routing.ts` |
| LP price feed ingest, source dimension, symbol map | NEW | `engine/market-data/src/{ingest,cache,sink}.rs`, `engine/server/src/main.rs`, new map table |
| Hedge result tracking (external ticket, slippage vs LP) | NEW | `Position`/`Order` columns or a new table |
| Engine awareness of bridged positions (SL/TP/stop-out through the bridge) | NEW (decision) | `engine/order-management/src/book.rs`, `monitor.rs` |

## Integration points

1. **Web order route and `orderRoute`** (`app/api/trade/orders/route.ts:271`, `lib/dealing-routing.ts:37`, `lib/liquidity.ts`). Recommended pre-fill hook; all fills pass here. Also needed in `lib/pending-trigger.ts:192`.
2. **Internal HTTP fill/reject callback** (new `app/api/internal/bridge/*`) reusing the dealing-queue fill transaction. Recommended completion path.
3. **DB outbox** (new `BridgeIntent` row in the order tx). Recommended durable handoff, with a NATS nudge.
4. NATS `order.>` / `position.>` subscription for observation only (monitoring, hedge-after-fill).
5. Gateway admin event stream `/v1/events/stream` with the internal secret (what the copier uses): fine for a prototype, not for money state.
6. Feed: a new authenticated route beside `/internal/price-feed`, plus a source key in `TickCache`/`LivePrice`.

Recommendation: 1 + 3 + 2 (web decides, outbox hands off, bridge calls back), leaving the Rust engine untouched until bridged-position risk (SL/TP, stop-out) is specified.

## Open questions

1. Is the LP execution model A-book pass-through (client order waits for the LP fill and price) or hedge-after-fill (client fills internally, bridge hedges)? The first needs the pending state and rejection/requote semantics; the second only the outbox.
2. Who owns SL/TP/stop-out for a bridged position: the engine (must know the position is bridged and close through the bridge) or the bridge?
3. Does `vyx-mt5-copier` still run in production, how does it connect to MT5, and what is its latency? Its repo (`darkkk001/vyx-mt5-copier`) must be read; it is not on C:.
4. Which protocols and LPs are in scope (FIX 4.4, MT5 manager/gateway, cTrader), and where are credentials stored (vault, env, encrypted DB)?
5. One LP per broker, per group, or per symbol with priority and failover (`LpRoutingRule` already models priority)?
6. Per-broker LP price feeds: separate quotes per tenant, or one shared feed with LP-specific markup? Impact on candles (global today).
7. Rust cutover: should the engine's `/v1/orders/market` ever serve A_BOOK, or stay unused for bridged groups?
8. Demo accounts on A_BOOK groups are blocked by design (`route.ts:226`); keep?
9. Reconciliation: how are LP-side positions compared to the book (existing `reconcile.rs` covers book vs DB only)?
