# QoreBridge: current state of VyXTrader (read-only audit, 2026-10-15)

Scope: C:\vyx\web at main, plus C:\vyx\native for the backoffice screen. No code was run. Use the function names; line numbers drift.

**Verified against:** web `main` = `7639389` (2026-10-19) and native `master` = `316935b3` (2026-10-14), on 2026-10-20. All `file:line` references below were re-checked against those commits (first written 2026-10-15 against web `8d3d171`).

Headline: **there is no LP/hedge execution anywhere today.** The Liquidity tab is a contact list, `A_BOOK` orders are refused (`LP_NOT_CONNECTED`), and the only "hedge" is an internal coverage account (a bookkeeping mirror of a client leg) that a separate, off-repo copier may relay to MT5. The web app, not the Rust engine, decides every fill.

The owner decisions of 2026-10-16 (section "Decisions (owner, 2026-10-16)") are authoritative: **fill first, then hedge.** The sections "Integration points", "Close-side hooks" and "Hedge state and the deal model" are written for that model.

## 1. Liquidity tab, API and routing data

| Route | Verb: file:line | What it does |
|---|---|---|
| `/api/manage/liquidity` | GET `app/api/manage/liquidity/route.ts:11` | Open-position volume per symbol split A_BOOK/B_BOOK (`position.groupBy`). BROKER_ADMIN only. Read-only. |
| `/api/manage/liquidity-providers` | GET `route.ts:18`, POST `:46` | List / create LP rows (+ AuditLog). |
| `/api/manage/liquidity-providers/[id]` | PATCH `[id]/route.ts:7`, DELETE `:75` | Edit / delete; delete is refused (409) while routing rules point at it. |
| `/api/manage/lp-routing` | GET `route.ts:16`, POST `:45` | List / create `LpRoutingRule` (provider, optional symbol, priority). |
| `/api/manage/lp-routing/[id]` | DELETE `[id]/route.ts:5` | Delete a rule. |
| `/api/manage/reports/lp` | GET `reports/lp/route.ts:11` | Report over providers. |

### 1.1 Where the routing data lives (`prisma/schema.prisma`)

| What | Where | Notes |
|---|---|---|
| `model Group` | `:1087` | One group per account (`Account.groupId`). |
| `Group.category RoutingCategory @default(B_BOOK)` | `:1159` | **The routing switch.** Read by `orderRoute` (`lib/dealing-routing.ts:37`) and `resolveBookType` (`lib/group-pricing.ts:19`). |
| `enum RoutingCategory` | `:271` | `A_BOOK` (bridged to an LP; the comment says the bridge, MT4/MT5/cTrader/FIX, is configured per group in the Liquidity tab, but no such per-group fields exist), `B_BOOK` (default; auto-fill, broker holds the risk), `DEALING` (dealer accepts manually or automatically, per `Group.dealingMode`; dealer mode off behaves like B_BOOK), `REVERSAL` (optional reverse-copy source book for `lib/mirror.ts`; books B), `COVERAGE` (system: the broker's own coverage/hedge account; books A; never offered to clients). |
| `enum BookType` | `:210` | `A_BOOK`, `B_BOOK`. |
| `Position.bookType BookType @default(B_BOOK)` | `:1992` | **Copy stored at open.** Written by each fill site from `resolveBookType(group.category)`: A_BOOK and COVERAGE give `A_BOOK`, everything else `B_BOOK`. (The schema comment still says "stamped from BrokerSymbol.defaultBookType"; the code no longer does that, the comment is stale.) Label only; nothing executes on it. |
| `Position.groupCategoryAtOpen RoutingCategory?` | `:1997` | **Copy stored at open**, set by a DB trigger on INSERT (migration `20261006090000_book_pnl_group_min_volume`), so every open path, web or engine, stamps it. Book P/L (`lib/book-pnl.ts`) counts B_BOOK / DEALING only, so moving an account to another group never rewrites history. NULL only for pre-migration rows not yet backfilled. |
| `Position.covered` / `autoHedged` / `coveragePositionId` | `:2034`, `:2039`, `:2044` | Internal coverage link (client leg to its coverage-account leg). |
| `Broker.coverageAccountId` | `:576` | The broker's system COVERAGE account. |
| `enum LpStatus` | `:2489` | `PROSPECTIVE, NEGOTIATING, CONTRACTED, CONNECTED`. Hand-edited. |
| `model LiquidityProvider` | `:2496` | `id, brokerId, name, contactName, contactEmail, contactPhone, protocol (free text String?), status LpStatus, notes, createdAt, updatedAt, routingRules[]`. **No protocol enum**: `protocol` is free text ("FIX 4.4", "REST API"). |
| `model LpRoutingRule` | `:2519` | `liquidityProviderId, symbolId?, priority, notes`. Schema comment: "no execution path reads this yet". **No Group link**: rules are per broker / per symbol, not per group. |

- **Nothing is connection state.** No session, heartbeat, last-seen, credentials or status is written by code; `status` is hand-edited. The schema deliberately omits a credentials field.
- `lib/liquidity.ts:8` `isLpConnected()` is hard-coded `false`: "When the bridge is built, this is the one place that learns the group's connection state."
- **Backoffice screen**: `LiquidityScreen` in `src/Vyx.Backoffice.App/Screens/LiquidityScreens.cs` (class `:29`; nav code `LP`; `ROUTE` merged into it). Models and fetchers in `src/Vyx.Shared/Api/ApiClient.ManageG5.cs` (`:9-22`) and create at `ApiClient.ManageG6.cs:141-145`. `GroupsScreen.cs:155` also fetches the providers. Its doc says "no live FIX session state exists on the server".
- Web UI: `app/manage/(shell)/liquidity/LiquidityManager.tsx`, `liquidity-routing/LpRoutingManager.tsx`.

## 2. Order path (MARKET, A_BOOK group)

Terminals call `POST /api/trade/orders` (native `ApiClient.cs:356-372`, `Batch9A.cs:37`), i.e. the **Next.js route**, not the gateway/engine order route.

1. `app/api/trade/orders/route.ts` `POST` (`:83`): validate, idempotency lookup (`:172`, unique `accountId_idempotencyKey`), live price via `getLivePriceRow` (`:187`, `lib/live-price.ts:91`).
2. **Routing read**: `orderRoute(account.group, deskIsOn(broker))` at `route.ts:273`, defined `lib/dealing-routing.ts:37` (`switch group.category`): `DEALING -> QUEUE|FILL`, `A_BOOK -> isLpConnected() ? FILL : NO_LP`, `COVERAGE -> SYSTEM`, else `FILL`.
3. `NO_LP` returns 400 `LP_NOT_CONNECTED` (`route.ts:274`). Same gate in `lib/pending-trigger.ts:194-195` (resting orders), `lib/account-structure.ts:78` (an A_BOOK group takes no accounts) and `app/api/portal/groups/route.ts:41` (A_BOOK hidden from sign-up). **So today an A_BOOK order never fills.**
4. If it ever got past: pricing `resolveFillPricing` (`lib/pricing-engine.ts`, called `route.ts:302`), `applySpreadMarkup`, slippage and margin gates, then the **instant fill** in the `type === "MARKET"` block (`route.ts:356`): `bookType = resolveBookType(...)` at `:657`, then one `prisma.$transaction` (`:658-711`) creates `Order{status:FILLED, filledPrice}` and `Position{bookType}` (`:677`), charges commission, writes AuditLog `ORDER_FILLED`; after commit `publishTradingEvent("OrderFilled")` (`:719`). That value is only a label on the position; **nothing is sent to an LP**.
5. DEALING queue branch (`route.ts:417-470`): `Order{status:PENDING}` with no Position, filled later by a dealer via `app/api/manage/dealing-queue/[id]/route.ts:369`. Smart-dealer auto-accept fills inside the same branch (`route.ts:497`).
6. **Engine**: has its own `place_market_order` (`engine/order-management/src/lib.rs:146`, HTTP `/v1/orders/market`, `engine/server/src/main.rs:326`, called only by `services/api-gateway/src/routes/orders.ts:96`). It never reads `Group.category`; its routing knowledge is limited to `Broker.riskAuthority` / `RUST_OWNED_SQL` (`engine/order-management/src/authority.rs:80`). Production **risk** (SL/TP, stop-out, margin watch) is engine-owned after the Stage 6 cutover; **order placement/fill stays on the web path**, including resting orders of engine-owned accounts (the engine calls the web's `/api/internal/pending-trigger`, scope RUST; `docs/STAGE6-PLAN.md:106`).
7. Hedge/coverage today: the broker clicks BOOK NOW (`app/api/manage/positions/[id]/book`), which mirrors the same-side leg onto the broker's system COVERAGE account (`lib/coverage.ts`, `Broker.coverageAccountId`), at raw price, zero commission, `bookType=A_BOOK`. Dealer coverage orders: `app/api/manage/coverage/orders/route.ts:26`, resting ones `lib/coverage-pending.ts`. All internal. `docs/STATE-OF-PROJECT.md:86` (older): "there is no hedge execution anywhere in the codebase".

**Where a bridge would hook in**: see "Integration points" below (fill-first). The pre-fill / held-order hook first proposed here on 2026-10-15 is **superseded** by Decision 1.

## 3. Coverage copier (`vyx-mt5-copier`)

- **Source is not on C:.** It lives in GitHub `darkkk001/vyx-mt5-copier` (cloned only by `scripts/backup-platform.ps1:34` for backups). Nothing in `C:\vyx-secrets\tools` is related (only `daily-check.ps1`, `daily-check.sql`, `send-test-ops-alert.ts`). No runbook in docs/ describes it. What follows is inferred from this repo; verify against the copier repo.
- Evidence of its interface: it is "headless" and authenticates with `x-internal-secret`. (a) The gateway admin event stream `ws /v1/events/stream?brokerId=` accepts the internal secret for "vyx-mt5-copier and similar" (`services/api-gateway/src/ws.ts:610-620`; the stream carries `order.>`, `position.>`, `dealing.>`, `account.>`, `config.>`, `ws.ts:588`). (b) It formerly read `GET /api/manage/accounts/[id]/positions` with the secret; that branch was **removed** (Phase 2 batch 8, `app/api/manage/accounts/[id]/positions/route.ts:6-9`), so it now needs a staff login or a new broker-scoped route. Whether it still works in production is unknown.
- Likely shape (unverified): a process on the MT5 host that listens to coverage-account position events and places mirrored orders on a real MT5 account (Python `MetaTrader5` package or an EA; not determinable here). Latency would be WebSocket event latency plus MT5 round trip, with no ack back into VyXTrader (nothing in this repo records an external hedge ticket).
- Failure modes by design: events are at-most-once (core NATS; only `book.seq` gap markers, `engine/market-data/src/book_events.rs`), the MT5 terminal must be logged in, no fill/rejection feedback, breakage on secret rotation (rotated 2026-09-28).
- **Reusable as a hedge connector?** As a pattern yes (event-driven, coverage account as the source); as code, undetermined until its repo is read. It has no per-LP routing, no confirmation path, and a stale auth path, so QoreBridge should treat it as a prototype of an MT5 adapter rather than depend on it.

## 4. Engine interfaces

Binary: `engine/server/src/main.rs` (HTTP, default `127.0.0.1:8081`, behind Caddy). Auth: `x-internal-secret` (`require_internal_secret`, `:192`, with `INTERNAL_SERVICE_SECRET_PREVIOUS` overlap), `x-price-feed-secret` for ingest (`:623`), read-only `x-market-data-secret` for market-data reads (`require_market_data_read_secret`, `:219`).

HTTP (`main.rs:1989-2012`): `POST /v1/orders/market`, `/v1/orders/pending`, `/v1/orders/{id}/cancel`, `/v1/positions/{id}/modify`, `/v1/positions/{id}/close`, `GET /internal/feed-stats`, `/internal/alert-stats` (internal secret); `GET /internal/candles`, `/internal/prices`, `/internal/prices/{symbol}` (read secret); `GET /health`, `/internal/time`; `POST /internal/price-feed`, `/internal/history`, `/internal/synth-feed` (feed secrets).

NATS (core NATS, no JetStream; JSON payloads):

| Subject | Direction | Payload |
|---|---|---|
| `price.tick.{symbol}` | engine publishes (`engine/market-data/src/ingest.rs:651`); gateway `ws.ts:218` and engine `main.rs:1305` subscribe | `protocol::Tick` (`engine/protocol/src/lib.rs:50`) |
| `order.accepted/rejected/filled/partially_filled/cancelled/expired`, `margin.call`, `margin.stop_out`, `position.stop_loss_hit/take_profit_hit/closed/modified` | engine publishes (`engine/order-management/src/events.rs:48` `subject_for`) | `protocol::TradingEvent` (`lib.rs:175`), `Fill`, `RiskRejection` |
| web families (exact list in "NATS subjects for fill and close" below) | **web** publishes via gateway `POST /internal/events` (`services/api-gateway/src/index.ts:83`; subject map `lib/nats.ts:33` `SUBJECTS`) | JSON per `lib/nats.ts` |
| `book.seq` | gateway stamps (`services/api-gateway/src/book-seq.ts`) | `{book_epoch, book_seq, subject}` |
| `alert.triggered`, `cfg.alerts.*` | engine publishes / subscribes (`main.rs:694`, `:1364`) | price alerts |
| `account.updated`, `config.changed`, `order.>`, `position.>` | engine subscribes (`market-data/src/pricing.rs` `PRICING_CHANGE_SUBJECTS`; `book_events.rs:206` `BOOK_CHANGE_SUBJECTS`) | pricing reload, book sequencing |

There is **no inbound "place order" NATS subject**; orders enter by HTTP only, and the engine's order route is not what terminals use.

### 4.1 NATS subjects for fill and close (exact)

Web, quoted from `lib/nats.ts` `SUBJECTS` (`:33`), all sent through `publishTradingEvent` (best effort, 2 s budget, one retry, then dropped):

| Event | Subject | Published by (examples) |
|---|---|---|
| `OrderFilled` | `"order.filled"` | `orders/route.ts:719` (instant MARKET), `pending-trigger.ts` after a trigger fill, dealing-queue accept, requote accept |
| `PositionClosed` | `"position.closed"` | trader close `app/api/trade/positions/[id]/close/route.ts:302`, `lib/queued-close.ts:250`, staff `manage/positions/[id]/close:158`, `reverse:96`, `void:64`, `lib/mirror.ts:617`, `lib/coverage.ts:382`, web risk monitor `lib/risk-monitor.ts:277`/`:339`, and **for engine closes** `lib/post-close.ts:142` |
| `PositionsClosed` | `"position.closed_bulk"` | `lib/bulk-close.ts:206`, `lib/close-by.ts:160`, `manage/positions/close-by:111` |
| `MarginCall` | `"margin.call"` | margin-call edges (web and post-close outbox) |
| others | `order.accepted`, `order.rejected`, `order.cancelled`, `order.requoted`, `order.modified`, `dealing.queued`, `position.modified`, `dealing.activity`, `account.balance`, `account.updated`, `config.changed`, `dealing.funds_request`, `account.funds_resolved`, `dealing.kyc_submitted`, `dealing.live_account_requested` | |

The web has **no** `margin.stop_out` subject: a stop-out reaches clients as `position.closed` per position (from the post-close outbox).

Engine (`events.rs:48` `subject_for`, best effort via `monitor.rs:715` `publish_best_effort`): `position.stop_loss_hit` / `position.take_profit_hit` (`monitor.rs:319`/`:322`), `margin.stop_out` (`monitor.rs:624`, carries `closed_position_ids`), and `position.closed` / `order.filled` from its own (unused in production) order routes.

**NEW: `bridge.intent.{brokerId}`** (proposed, not implemented). A loss-tolerant nudge only: core NATS has no JetStream, so a message can be lost (bridge down, slow consumer, gateway hop). The **hedge-intent table is the source of truth**; the bridge must also poll it (e.g. every 1 s plus on every nudge) and claim rows with a lease, the same way `lib/post-close.ts` drains `PostCloseEffect`. None of the subjects above may be used as the hedge trigger on their own.

Engine DB writes (Postgres, sqlx): `LivePrice`, `Candle` (Neon and/or the local VPS store, `market-data/src/sink.rs`, `MARKET_DATA_WRITE`), `Order`, `Position`, `Account`, `Transaction`, `Notification`, `AuditLog`, `PostCloseEffect` outbox (`book.rs:1075` `enqueue_post_close`, delivery `order-management/src/outbox.rs`, web consumer `/api/internal/post-close`, `lib/post-close.ts`), `PriceAlert`, `RiskEngineHeartbeat`, `Broker`/`BrokerSymbol` (provisioning/test paths), and parity/shadow tables. It reads `Broker.riskAuthority`, `Group`, `BrokerSymbol`.

**Integration options for a separate bridge service on the same VPS** (as assessed 2026-10-15; the chosen shape is in "Integration points")

| Option | Pros | Cons |
|---|---|---|
| A. Subscribe to NATS (`order.>`, `position.>`) and publish results back | Matches the existing bus; no engine change for observing | Core NATS is at-most-once; web fills reach NATS only via gateway `/internal/events`; no inbound order subject exists |
| B. Internal HTTP API on the web (new, secret header, broker-scoped) | Bridge reports results on a synchronous, authenticated path; reuses the auth pattern; testable | New routes |
| C. DB outbox table (hedge intent) written in the fill transaction | Exactly-once with the fill, survives crashes, same idiom as `PostCloseEffect`; bridge polls, optionally nudged by NATS | Needs a migration (after the demo week); polling latency unless paired with a NATS nudge |

## 5. Feed path

| Hop | Where |
|---|---|
| MT5 EA captures bid/ask, POSTs batches (with `t0`, clock offset) | `mt5-ea/VyXTraderPriceFeed.mq5` (`ServerUrl` line 12; symbol suffix handling ~line 154; autostart `mt5-ea/deploy/vps-autostart.ps1`) |
| Web thin forwarder `app/api/internal/price-feed/*` and `lib/price-feed.ts:35` (also runs risk evaluation, `:61`) | forwards to the engine with `x-price-feed-secret` |
| Engine ingest `ingest_price_feed` `engine/server/src/main.rs:617` to `market_data::ingest::ingest_ticks` `ingest.rs:111` | `TickCache.set` (`cache.rs`), alert check, `publish_tick` `ingest.rs:651` (`price.tick.{symbol}`) |
| Persistence | `spawn_periodic_flush` (`ingest.rs:177`), `flush_live_prices` `:408`, `flush_candles` `:455`, targets via `write_to_targets` `:295` and `sink.rs` `MarketDataPools` (Neon and/or local VPS) |
| Risk trigger | `risk_hook.rs` `RiskHook`, `spawn_risk_trigger` `ingest.rs:272` |
| Gateway WS fan-out | `services/api-gateway/src/ws.ts:218` (`attachPriceStream`); per-account markup applied server side (`client-ask.ts`) |
| Web reads | `lib/live-price.ts` `getLivePriceRow` (`:91`) to `lib/market-data-client.ts` (`MARKET_DATA_URL`, `MARKET_DATA_READ_SECRET`, 2 s timeout, falls back to Prisma `LivePrice`) to engine `/internal/prices` |

Where an alternate per-broker LP feed could plug in:
- `Tick` has **no source/LP field** and `LivePrice`/`TickCache` are keyed by `symbol` only, so today there is one global feed shared by all tenants. A per-broker feed needs a source dimension (cache/table key, `price.tick.{broker}.{symbol}` or a `source` field) and a selection step.
- Ingest has no source trait; it is HTTP routes: `/internal/price-feed` (real) and `/internal/synth-feed` (synthetic, own secret that must differ from `PRICE_FEED_SECRET`, `main.rs:47`, `:1438`). A new LP-feed route with its own secret is the smallest hook; the synthetic route is the precedent.
- Symbol mapping: only canonical names (`lib/synthetic-symbols.ts:35` `canonicalSymbolName`) and the EA's suffix handling; no LP-symbol mapping table exists (new).
- Per-broker/per-group price: `engine/market-data/src/ask_markup.rs` (`resolve :62`, `account_ask :91`, `PricingSnapshot`, `PricingScope`) and `pricing.rs` (`PricingCache`, reloaded on `config.changed`/`account.updated`) apply markup to the one raw tick. A per-LP raw price would be chosen before this step.

## WIRE vs NEW

| Capability | Status | Files |
|---|---|---|
| LP/provider records, routing-rule records, backoffice screen | WIRE (exists) | `prisma/schema.prisma:2496`, `app/api/manage/liquidity-providers/*`, `app/api/manage/lp-routing/*`, native `LiquidityScreens.cs` |
| Category-based routing switch and refusal | WIRE (one function) | `lib/liquidity.ts`, `lib/dealing-routing.ts:37`, `app/api/trade/orders/route.ts:273` |
| Fill transactions at every fill site (where the hedge intent is written) | WIRE | see "Integration points", table 1 |
| Single web close function (where the hedge-reduce intent is written) | WIRE | `lib/position-close.ts:40` `closePositionInTx` |
| Engine close follow-up outbox | WIRE | `engine/order-management/src/book.rs:1075` `enqueue_post_close`, `lib/post-close.ts` steps |
| Event bus and fan-out to terminals | WIRE | `lib/nats.ts`, `services/api-gateway/src/index.ts:83`, `ws.ts` |
| Coverage account as hedge source | WIRE | `lib/coverage.ts`, `lib/coverage-pending.ts`, `book` route |
| Internal-secret auth pattern, rotation scripts | WIRE | `engine/server/src/main.rs:192`, `deploy/rotate-*` |
| Connection state per LP (session, heartbeat, last error) | NEW | new columns/table next to `LiquidityProvider` |
| Credentials storage (encrypted) | NEW | none exists by design |
| Protocol taxonomy and per-group bridge config | NEW | replace free-text `protocol`; per-group link to a provider |
| Bridge service (FIX/MT5/cTrader adapters), hedge order state machine | NEW | new service, e.g. `services/qorebridge/` |
| Hedge-intent and hedge-result tables, internal result endpoint | NEW | migration after the demo week, `app/api/internal/bridge/*` |
| Real `isLpConnected` (gates sign-up / account placement only) | NEW | `lib/liquidity.ts` |
| LP price feed ingest, source dimension, symbol map | NEW | `engine/market-data/src/{ingest,cache,sink}.rs`, `engine/server/src/main.rs`, new map table |
| Hedge result tracking (external ticket, LP fill price, slippage vs client) | NEW | hedge-result table (see "Hedge state and the deal model") |
| Book-level hedge netting and LP reconciliation | NEW | bridge service; `reconcile.rs` covers book vs DB only |

## Integration points (fill-first)

Decision 1 (2026-10-16): the client is filled immediately, exactly as today; the LP hedge follows asynchronously. So there is **no pre-fill hook and no held order** for A_BOOK.

**Pre-fill behaviour: `A_BOOK -> FILL`.** `orderRoute` (`lib/dealing-routing.ts:37`) returns `FILL` for A_BOOK like B_BOOK; no `BRIDGE` route, no `ACCEPTED/PENDING` order waiting for an LP, no LP requote or reject ever reaches the client. `isLpConnected` (`lib/liquidity.ts:8`) stops gating the order route and the pending trigger (`route.ts:273-274`, `pending-trigger.ts:194-195`); it remains only as the sign-up / account-placement guard (`lib/account-structure.ts:78`, `app/api/portal/groups/route.ts:41`), which the owner may keep or drop.

> **Superseded (2026-10-15 recommendation):** "replace `isLpConnected` with a per-group connection check and add a `BRIDGE` result to `orderRoute`; create the order `ACCEPTED/PENDING` with no Position and fill it from an async LP callback." Do not build this; it contradicts Decision 1.

**Primary hook: a hedge-intent row written INSIDE each fill transaction**, only when the account's group is `A_BOOK` (the same `account.group.category` the site already reads for `resolveBookType`). Same transaction as `Order`/`Position`, so a committed fill always has its intent and a rolled-back fill never does (the `PostCloseEffect` idiom). After commit: a `bridge.intent.{brokerId}` nudge (loss-tolerant).

Table 1: every client fill site on main `7639389`.

| # | Fill site | Function | Transaction | Position created |
|---|---|---|---|---|
| 1 | `app/api/trade/orders/route.ts` instant MARKET block | `POST` | `:658` (`withDeadlockRetry(prisma.$transaction)`) | `:677` `tx.position.create` |
| 1b | same file, smart-dealer auto-accept (DEALING branch; listed for completeness, A_BOOK never queues) | `POST` | `:497` | `openPositionFromOrder` |
| 2 | `lib/pending-trigger.ts` resting LIMIT/STOP trigger (web scope and engine-owned accounts via `/api/internal/pending-trigger`) | `triggerPendingOrderInner` (`:142`) | `:293` | `:299` |
| 3 | `app/api/manage/dealing-queue/[id]/route.ts` dealer accept (DEALING only today; included so a future DEALING-to-LP flow is covered) | `PATCH` (`:65`) | `:369` (bookType `:366`) | `openPositionFromOrder` (`lib/dealing.ts:18`, create `:38`) |
| 4 | `app/api/trade/orders/[id]/requote-response/route.ts` client accepts a requote | `POST` (`:44`) | `:236` | `openPositionFromOrder` |
| 5 | `app/api/manage/positions/route.ts` staff opens a position for a client | `POST` (`:239`) | `:404` | `:425` |
| 6 | `lib/mirror.ts` reverse-copy target leg | `onFillPosition` (`:286`) | `:453` (`withTx`) | `openPositionFromOrder` `:478` |
| 7 | `lib/position-actions.ts` reverse by close-and-reopen (reopen leg) | `executeReverseCloseReopen` (`:287`) | caller's `tx` | `:357` |

Writing the intent inside `openPositionFromOrder` (`lib/dealing.ts:18`) covers rows 1b, 3, 4 and 6 at once; rows 1, 2, 5 and 7 create the Position inline and need the call added beside `tx.position.create`. A shared helper (e.g. `enqueueHedgeIntent(tx, position, group)`) keeps the A_BOOK check in one place.

**Not hedge sources** (system COVERAGE legs, which book `A_BOOK` but are the broker's own internal cover, not client flow): `lib/pending-trigger.ts:366` `fillCoverageOrder`, `lib/coverage.ts:440` `onFillAutoHedge` (create `:509`), `app/api/manage/positions/[id]/book/route.ts:99`, `app/api/manage/coverage/orders/route.ts:126`. Whether QoreBridge should ever execute coverage legs at the LP (replacing the off-repo copier) is open question 10.

**Completion path:** the bridge reports each hedge result (LP fill, partial, reject, error) through a new internal HTTP endpoint (`/api/internal/bridge/result`, secret header, broker-scoped) that writes the hedge-result row. It never touches the client's `Order`/`Position` money fields.

Other integration points, unchanged in role:
- NATS `order.>` / `position.>` subscription: observation only (monitoring, dashboards), never the hedge trigger.
- Gateway admin event stream `/v1/events/stream` with the internal secret (what the copier uses): fine for a prototype, not for money state.
- Feed: a new authenticated route beside `/internal/price-feed`, plus a source key in `TickCache`/`LivePrice`.

Recommendation: intent row in every fill transaction + `bridge.intent.*` nudge + polling + result endpoint. The web stays the only place that decides fills; the Rust engine hot path is untouched.

## Close-side hooks

Decision 2: when a client position closes for any reason, QoreBridge reduces or closes the matching hedge volume. Each close must therefore leave a **hedge-reduce intent** (position, lots closed, reason) for A_BOOK positions (`Position.bookType = A_BOOK` and `groupCategoryAtOpen = A_BOOK`, so a later group change does not matter).

**Web: one function covers almost everything.** Every web close goes through `closePositionInTx` (`lib/position-close.ts:40`), which already returns `{closed, partial, realizedPnl, transaction}`. Writing the hedge-reduce intent there (closed volume = the `closeVolume` actually applied) covers:

| Close path | Calls `closePositionInTx` at |
|---|---|
| Trader close, full or partial (`app/api/trade/positions/[id]/close/route.ts`) | `:271` |
| Close-by (`lib/close-by.ts` `closePositionsByEachOther` `:106`) | `:115`, `:123` (both legs) |
| Queued close executed by the dealer (`lib/queued-close.ts` `executeQueuedCloseInTx` `:183`) | `:204` |
| Bulk close (`lib/bulk-close.ts` `closeBulkForAccount` `:129`) | `:154` |
| Staff close (`lib/position-actions.ts` `executeAdminCloseInTx` `:97`) | `:118` |
| Reverse by close-and-reopen, close leg (`executeReverseCloseReopen` `:287`) | `:329` (the reopen leg is fill site 7) |
| Web risk monitor SL/TP and stop-out (`lib/risk-monitor.ts`, web-owned accounts only after Stage 6) | `:247`, `:305` |
| Mirror target close (`lib/mirror.ts`) | `:584` |
| Coverage leg close (`lib/coverage.ts`), demo sweep (`lib/demo-sweep.ts`) | `:353`, `:75` (not A_BOOK client flow; the helper skips them) |

**Web paths that do NOT go through `closePositionInTx`** and need their own call:
- **Reverse in place** (`lib/position-actions.ts:172` `executeReverseInPlace`): flips `side` with `tx.position.update` (`:203`). For the hedge this is "reduce N, then open N opposite": one intent of kind `REVERSE` (or a reduce + an open pair).
- **Void an open position** (`executeVoid` `:429`, claim `:436`): the position disappears as if it never existed; the hedge must be closed (kind `VOID`).
- **Void a closed trade** (`executeVoidClosed`, `:508`): the client close is undone in money terms only; the hedge was already reduced at close time, so **no hedge action** (record it for reconciliation).

**Engine: SL/TP and stop-out** close in `engine/order-management/src/monitor.rs` via `book::close_position_as` (`book.rs:772`, called `monitor.rs:135`) and, in the same transaction, `book::enqueue_post_close` (`book.rs:1075`, called `monitor.rs:139`) writes a `PostCloseEffect` row (`kind POSITION_CLOSED`, `reason stop_loss | take_profit | stop_out`, payload `closedLots`, `closePrice`, ...).

**Recommendation: piggyback on `PostCloseEffect`; the engine does not write its own hedge-intent row.** Add a `hedge` step to `lib/post-close.ts` (beside `cancel_pending_close`, `mirror`, `coverage`, `activity`) that writes the hedge-reduce intent from the row's `positionId` and `closedLots`. Why: the engine already records every risk close in that outbox inside the close transaction, and `doneSteps` gives the new step exactly-once delivery, so this needs **zero engine change** (Decision 3 and the deal-model engine deploy stay undisturbed) and keeps a **single writer** of hedge intents (the web). The cost is outbox delivery latency (the row is woken right after commit), acceptable because the hedge is asynchronous by decision.

## Hedge state and the deal model

**Today there is no hedge state and no "pending external" state anywhere.** Every client fill is synchronous and internal (`Order.status` goes straight to `FILLED`); `OrderStatus` (`schema.prisma:201`: `PENDING, ACCEPTED, FILLED, REJECTED, CANCELLED, REQUOTED`) only models dealer/requote holds and resting orders. Nothing stores an LP order id, LP fill price or hedge status. Under Decision 1 the client never needs a pending-external state; the **hedge** does, and it must not live on `Order`/`Position` (those are the client's records).

This must be designed together with the position/deal-model work, [`docs/POSITION-DEAL-MODEL.md`](../POSITION-DEAL-MODEL.md) (approved 2026-10-12; steps 1-3 on `feat/deal-model-step1..3`, not merged to main as of `7639389`). That doc adds a `Deal` table (§3.2: one row per IN / OUT / OUT_BY execution, `positionId`, `volume`, `price`, `reason`, `transactionId`) and `Position.initialVolume`; it says nothing about hedging today. Points to settle jointly:

1. **Hedge intents key on deals, not positions.** Every client deal on an A_BOOK position (IN at open, OUT at each partial/full close, OUT_BY for close-by, the reverse pair) is exactly one unit of hedge work. Proposed: `HedgeIntent.dealId` (unique) once `Deal` exists, with `positionId` + volume as the pre-Deal fallback. The deal-model's "exactly-once by construction" (`Deal.transactionId`) then extends to hedging: one deal, one intent.
2. **External ticket storage.** A separate `HedgeExecution` (hedge-result) table: `intentId`, `liquidityProviderId`, LP order id / ticket / ClOrdID, `status` (SENT, FILLED, PARTIAL, REJECTED, ERROR), `requestedVolume`, `filledVolume`, timestamps, `lastError`. Several executions per intent (retries, partial fills, failover to the next `LpRoutingRule` priority). Not columns on `Position` or `Deal`: one client deal can need several LP orders, and a netted hedge can serve several client deals.
3. **LP fill price.** Stored per execution (`lpFillPrice`), never written back to `Position.openPrice` or `Deal.price` (the client's price stays the client's). Slippage = LP fill vs the client deal price, reported per execution and summed per symbol; this is the A-book P/L the broker sees.
4. **`bookType` and `groupCategoryAtOpen`.** Both are copies stored at open (section 1.1). The hedge decision must use the position's own copy (`groupCategoryAtOpen = A_BOOK`; `bookType = A_BOOK` alone also matches COVERAGE legs), never the account's current group, so moving an account between groups never re-hedges or un-hedges open positions. Book P/L (`lib/book-pnl.ts`) already excludes A_BOOK via `groupCategoryAtOpen`; hedge P/L becomes its own report.
5. **Per-symbol netting.** Decision 2 manages the hedge at book level. The intent table records per-deal client flow; the bridge nets open intents per broker + symbol (+ LP) and sends only the net. Needed: a per-broker per-symbol net hedge position (table or derived view), the netting window, and how a net execution is allocated back to intents (FIFO by `seq`). Netting means one LP fill can close several intents and one intent can be split across fills; hence the separate execution table and a link table or allocation rows.
6. **Failure handling** (from the Decisions follow-ups): the client stays filled; failed intents retry with backoff, then go DEAD with a dealer alert; "unhedged exposure" (sum of open intents without a filled execution) shows on Dealing / Live exposure.

Sequencing: the hedge tables reference `Deal`, so their migration should follow deal-model migration A to main, and QoreBridge's intent writes should hook the same helper calls the deal-model dual write adds at each fill and close site (the deal-model doc §3.4 lists the same web paths: `closePositionInTx`, close-by, queued close, position-actions, mirror, coverage, bulk close, risk monitor, and the fill paths).

## Decisions (owner, 2026-10-16)

1. **Execution model: fill first, then hedge.** The web fills the client immediately, exactly as today (no pending state waiting for the LP, no LP requote or reject reaching the client). QoreBridge then hedges the same volume to the LP asynchronously, from a durable intent written in the client's fill transaction (see "Integration points").
2. **Risk ownership: the engine.** The engine owns SL/TP and stop-out for the client-facing position, unchanged. The LP hedge is managed at book level by QoreBridge: client SL/TP are **not** mirrored to the LP; when the client position closes (by any reason), QoreBridge reduces or closes the matching hedge volume (see "Close-side hooks").
3. **Timing.** Design and documentation only during the demo week (to 2026-10-21): no build, no schema change, no deploy. Implementation is parked until after the demo week.

Follow-ups these decisions create (for the design doc, not this audit): the hedge intent and result tables (schema, after the demo week; see "Hedge state and the deal model"); hedge failure handling (the client stays filled; retry, alert the dealer, show unhedged exposure on Dealing / Live exposure); netting of hedge volume per symbol at book level; reconciliation of LP positions against the book.

## Open questions

1. ~~Execution model~~: decided, fill first then hedge (see Decisions).
2. ~~SL/TP/stop-out ownership~~: decided, the engine; the hedge is book-level (see Decisions).
3. Does `vyx-mt5-copier` still run in production, how does it connect to MT5, and what is its latency? Its repo (`darkkk001/vyx-mt5-copier`) must be read; it is not on C:.
4. Which protocols and LPs are in scope (FIX 4.4, MT5 manager/gateway, cTrader), and where are credentials stored (vault, env, encrypted DB)?
5. One LP per broker, per group, or per symbol with priority and failover (`LpRoutingRule` already models priority)?
6. Per-broker LP price feeds: separate quotes per tenant, or one shared feed with LP-specific markup? Impact on candles (global today).
7. Rust cutover: should the engine's `/v1/orders/market` ever serve A_BOOK, or stay unused for bridged groups?
8. Demo accounts on A_BOOK groups are blocked by design (`route.ts:227`); keep?
9. Reconciliation: how are LP-side positions compared to the book (existing `reconcile.rs` covers book vs DB only)?
10. Should QoreBridge also execute the broker's COVERAGE legs at the LP (replacing the copier), or only A_BOOK client flow?
11. Under fill-first, does the A_BOOK sign-up / account-placement guard (`isLpConnected`) stay until an LP is connected, or are A_BOOK accounts allowed with hedging off (exposure shown as unhedged)?
