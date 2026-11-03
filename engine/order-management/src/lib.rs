//! Order Management (OMS) — see ../../docs/trading-engine.md.
//!
//! Owns order state exclusively (../../docs/database.md §3: sole writer of
//! the `orders`/`positions` tables). Does not calculate margin, does not
//! decide fill price — it orchestrates calls to Risk and Execution and
//! persists the result in one transaction, per the sequence diagram in
//! ../../docs/trading-engine.md §2.

pub mod authority;
pub mod book;
pub mod calc;
pub mod db;
pub mod events;
pub mod fx;
pub mod gates;
pub mod ingress;
pub mod monitor;
pub mod outbox;
pub mod pending_orders;
pub mod pricing;
pub mod session;
pub mod swap;
pub mod margin_watch;
pub mod live_lanes;
pub mod shadow;
pub mod reconcile;

use chrono::Duration as ChronoDuration;
use crate::calc::{close_price_for, floating_pnl};
use market_data::ask_markup;
use market_data::cache::TickCache;
use protocol::{Fill, OrderSide, OrderStatus, OrderType, RiskRejection, Tick, TradingEvent};
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

// Same 15s staleness window market_data::db::get_live_price's own SQL
// enforces -- kept as one function so the in-memory cache and the
// Postgres fallback can never silently drift apart.
fn tick_freshness() -> ChronoDuration {
    ChronoDuration::seconds(15)
}

/// Returns whether `to` is a legal next state from `from`, per the
/// diagram in ../../docs/architecture.md §5 / ../../docs/trading-engine.md
/// §2.1. This is the single source of truth for legality — callers should
/// never mutate an order's status without checking this first.
pub fn is_legal_transition(from: OrderStatus, to: OrderStatus) -> bool {
    use OrderStatus::*;
    matches!(
        (from, to),
        (New, Validating)
            | (Validating, Accepted)
            | (Validating, Rejected)
            | (Accepted, Routing)
            | (Accepted, Cancelled)
            | (Accepted, Expired)
            | (Routing, PartiallyFilled)
            | (Routing, Filled)
            | (Routing, Rejected)
            | (PartiallyFilled, Filled)
            | (PartiallyFilled, Cancelled)
    )
}

#[derive(Debug, thiserror::Error)]
pub enum TransitionError {
    #[error("illegal order state transition: {from:?} -> {to:?}")]
    Illegal { from: OrderStatus, to: OrderStatus },
}

/// Validates and (once wired to a Postgres pool) persists a state
/// transition in the same query as any resulting Position/Ledger mutation
/// — see ../../docs/trading-engine.md §2.1 on atomicity. The actual
/// Postgres write isn't implemented yet; this is the Phase 1 scaffold
/// checkpoint, Phase 2 wires it to `sqlx`.
pub fn transition(from: OrderStatus, to: OrderStatus) -> Result<OrderStatus, TransitionError> {
    if is_legal_transition(from, to) {
        Ok(to)
    } else {
        Err(TransitionError::Illegal { from, to })
    }
}

/// Everything OMS needs to place a MARKET order that it doesn't own the
/// storage for itself. `equity`/`used_margin` come from the account's
/// current state, `contract_size`/`leverage` from the symbol spec and
/// account respectively — both Prisma-owned per ADR-002
/// (../../docs/database.md §2), so OMS is handed the numbers rather than
/// reaching into tables it doesn't own. Wiring up who supplies these
/// (the API Gateway, reading Prisma) is Phase 2 integration work still
/// open — see ../../docs/api.md §4.
///
/// Deliberately does NOT include the current tick/price — that used to
/// be caller-supplied (the API Gateway's own Postgres read), which
/// worked but wasn't what ../../docs/execution.md §2.1 specifies
/// ("current best bid/ask from the Market Data Core... never the
/// client-supplied price," where "client" there means whoever calls this
/// function, not just the end user's browser). `place_market_order` now
/// fetches it itself via `market_data::db::get_live_price` — one fewer
/// hop between "the price OMS fills at" and "the price Market Data Core
/// actually has right now."
pub struct PlaceMarketOrderRequest {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub volume: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
    pub equity: Decimal,
    pub used_margin: Decimal,
    pub contract_size: Decimal,
    pub leverage: u32,
}

#[derive(Debug)]
pub enum PlaceMarketOrderOutcome {
    Filled {
        order_id: String,
        position_id: String,
        fill_price: Decimal,
    },
    Rejected {
        order_id: String,
        reason: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum PlaceOrderError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
    /// L2 Step 3: a scope is installed and this account is not a DEMO account. Separate from
    /// `NotInIngress` because the cause is different and so is the fix: the id is ON the list but the
    /// list is wrong. Found by the Step 3 proof, which filled a LIVE account that had been put on the
    /// list deliberately -- see `ingress::mode_allowed`.
    #[error("account {0} is not a DEMO account; the engine order path is scoped to DEMO accounts")]
    IngressDemoOnly(String),
    /// L2 Step 3: this account is not on the engine's ingress list (`ingress::allows`). Not a
    /// rejection -- a refusal to take the order at all, so the caller falls back to the web path and
    /// NO `"Order"` row is written. See `ingress`'s module doc for the three layers this is the last
    /// of, and why it is checked here even though the gateway checks it first.
    #[error("account {0} is not on the engine's order-path ingress list")]
    NotInIngress(String),
    /// L2 Step 2: no `"Account"` row for this request, or no `"Broker"` row. It used to surface as a
    /// foreign-key error from the order insert, because the row was written before anything was read;
    /// the one read comes first now and says so plainly. The HTTP route already checks the account
    /// belongs to the broker, so reaching this means it went away in between.
    #[error("unknown account {0}")]
    UnknownAccount(String),
    /// L2 Stage 3: no `"Symbol"` row with this name. On the legacy book this was survivable -- the
    /// admission checks were skipped and the order filled at the raw tick -- but Prisma's `"Order"`
    /// and `"Position"` both require a `symbolId` FK, so there is no row to create and therefore no
    /// order to reject. The caller gets a 400, not an order id.
    #[error("unknown symbol {0}")]
    UnknownSymbol(String),
}

/// The MARKET-order path conceptually passes through NEW -> VALIDATING ->
/// ACCEPTED|REJECTED -> ROUTING -> FILLED (see ../../docs/trading-engine.md
/// §2, §2.1's atomicity requirement), all in one Postgres transaction --
/// but only the terminal status (via `db::set_filled`/`db::set_rejected`)
/// is ever actually persisted. The intermediate writes were removed as a
/// round-trip optimization (docs/testing.md's Concurrency/latency
/// benchmark row): Postgres's default READ COMMITTED isolation means
/// nothing outside this transaction can ever observe an uncommitted
/// intermediate value, so writing NEW->VALIDATING->ACCEPTED->ROUTING as
/// separate UPDATEs before the final commit was pure network cost with no
/// observable effect -- the committed row is identical either way. Does
/// not publish NATS events itself — the caller does that after `commit()`
/// succeeds, since an event about a transaction that might still roll
/// back would be a lie. See ../../docs/api.md §2.1 for who consumes those
/// events downstream.
pub async fn place_market_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    // &Arc, not &TickCache (L2 Step 1d): the pre-trade margin gate reads the account's open positions
    // through `book::load_book_state`, which prices them from whatever `book::PriceSource` is in
    // scope -- and in live mode `require_tick_source` makes the absence of one an error rather than a
    // silent read of the database's stale "LivePrice". So this path has to be able to PUT the engine's
    // ticks in scope, and that takes the shared handle. `&state.tick_cache` passes unchanged.
    cache: &std::sync::Arc<TickCache>,
    // The account ask rules the book prices its positions with (market_data::pricing). REQUIRED in
    // live mode: `book::require_pricing_cache` makes a book read without one an error rather than a
    // silent per-fill reload of the whole pricing configuration -- which is five round trips, and
    // which L2 Step 1d's margin gate was paying until this was wired (measured, trips 10-14 of 17).
    // None is for tests and harnesses: each read then loads the configuration of exactly its own rows.
    pricing: Option<&std::sync::Arc<market_data::pricing::PricingCache>>,
    // The broker server's UTC offset (`market_data::broker_offset::BrokerOffsetTracker::current`),
    // which the daily-loss gate's broker-day boundary is computed from -- see
    // `db::GateInputs::broker_day_start`. 0 reduces it to UTC midnight.
    broker_offset_sec: i64,
    req: PlaceMarketOrderRequest,
) -> Result<PlaceMarketOrderOutcome, PlaceOrderError> {
    // L2 Stage 3: ONE book for the whole order. Read once here rather than per write, so a single
    // order can never leave half its rows in each book.
    let book = db::configured();

    // L2 Step 3 (INGRESS SCOPING): before ANY read or write, is this account even allowed here?
    //
    // Checked on the Prisma book only, and before the one read, so a non-designated account costs
    // nothing and leaves nothing behind -- no order row, no audit trail, no doubt. The gateway and the
    // web route both check the same thing first; this is the layer that holds when neither ran,
    // because the engine's own `/v1/orders/market` is reachable by anything holding the internal
    // secret. `ingress`'s module doc has the rest, including why "no list" means unrestricted here and
    // where the fail-closed decision actually lives (main.rs refuses to start the order path without
    // a list in live mode).
    if book == db::Book::Prisma && !ingress::allows(&req.account_id) {
        return Err(PlaceOrderError::NotInIngress(req.account_id.clone()));
    }

    // L2 Step 2 (DEPTH-CUT): ONE READ, and it is the only one this path makes on the Prisma book.
    //
    // It replaces eleven sequential round trips -- the symbol config, the routing category, the
    // exposure aggregates, the gate inputs, the ask levels, and then the BEGIN / SET TRANSACTION /
    // funds / positions / sessions / ROLLBACK of `calc::load_book_state`. About 55 ms of pure waiting
    // per fill on Neon's p50 link, for data that one statement answers in one. It is also a STRONGER
    // snapshot than what it replaced, not a weaker one -- see `db::get_open_snapshot`.
    //
    // THE LEGACY BOOK still reads the old way, one query at a time, because its behaviour is frozen
    // until Stage 8 drops it.
    let snapshot = match book {
        // Both book sources in scope, as every other book read runs: the TICKS because that is what
        // positions are priced from (never the database's "LivePrice", which live mode refuses
        // outright), and the PRICING CACHE because each position's ask rule is resolved from it --
        // zero statements once loaded, five if it is missing. Measured: without this the fill paid
        // five extra round trips re-reading the whole pricing configuration.
        db::Book::Prisma => match crate::book::with_book_sources(
            crate::book::PriceSource::Ticks(cache.clone()),
            pricing.cloned(),
            db::get_open_snapshot(pool, cache, &req.broker_id, &req.account_id, &req.symbol, req.side, broker_offset_sec),
        )
        .await?
        {
            db::OpenSnapshotResult::Found(s) => Some(s),
            // no `"Symbol"` row, so there is no symbolId for `"Order"` and `"Position"` to reference
            // and no row to reject: a 400, not a rejection.
            db::OpenSnapshotResult::UnknownSymbol => return Err(PlaceOrderError::UnknownSymbol(req.symbol.clone())),
            // Before this step the order row was written before anything was read, so a missing
            // account surfaced as a foreign-key error from that insert. The read comes first now and
            // can say so plainly -- and there is still no row to write a rejection on.
            db::OpenSnapshotResult::AccountNotFound => return Err(PlaceOrderError::UnknownAccount(req.account_id.clone())),
        },
        db::Book::Legacy => None,
    };

    // L2 Step 3: the DEMO-only half of the ingress scope, on the DATABASE's answer about the account
    // rather than on the environment variable. Checked the moment the one read comes back and before
    // anything at all is written, so a LIVE account on the list leaves no trace either.
    if let Some(snap) = &snapshot {
        if !ingress::mode_allowed(&snap.gates.account_mode) {
            return Err(PlaceOrderError::IngressDemoOnly(req.account_id.clone()));
        }
    }

    // A `None` symbol config is the rare, benign "no Symbol row" case: on the legacy book the order
    // still fills at the raw tick with the admission checks skipped, which is kept exactly as it was.
    let symbol_config = match &snapshot {
        Some(s) => Some(s.symbol.clone()),
        None => db::get_broker_symbol_config(pool, &req.broker_id, &req.symbol).await?,
    };
    let symbol_id = symbol_config.as_ref().map(|c| c.symbol_id.clone()).unwrap_or_default();

    // L2 Stage 4: where this position's risk goes. `lib/group-pricing.ts resolveBookType` off the
    // account's group category -- the same answer the web's order route computes before its own fill,
    // so an engine fill and a web fill of the same account route identically. B_BOOK when the account
    // has no group, which is the safe side. The category came from its own query until L2 Step 2; it
    // is the same `"Group".category` the gates already read.
    let book_type = match &snapshot {
        Some(s) => db::BookType::of_category(s.gates.group_category.as_deref()),
        None => db::BookType::BBook,
    };

    let new_order = db::NewOrder {
        broker_id: req.broker_id.clone(),
        account_id: req.account_id.clone(),
        symbol: req.symbol.clone(),
        symbol_id: symbol_id.clone(),
        side: req.side,
        order_type: OrderType::Market,
        volume: req.volume,
        requested_price: None,
        sl_price: req.sl_price,
        tp_price: req.tp_price,
    };

    // L2 Step 2 (DEPTH-CUT): ON THE PRISMA BOOK NOTHING IS OPEN HERE -- no transaction, and no
    // `"Order"` row yet.
    //
    // It used to open a transaction and insert the row PENDING before the first gate ran, purely so a
    // refusal had a row to land on. That cost two round trips and, worse, held a pooled connection
    // across every admission read while the gates waited on them. Both ends are now single statements
    // that write the identical rows: a refusal INSERTs the order already REJECTED
    // (`db::insert_rejected_order`), and a fill writes the whole chain in one call
    // (`db::open_position_one_call`). The id is generated here all the same, because the caller is
    // answered with it either way.
    //
    // THE LEGACY BOOK IS UNCHANGED: its row and its transaction are opened here exactly as before.
    // That path writes tables nothing reads and is deliberately frozen until Stage 8 drops it.
    let mut legacy_tx = match book {
        db::Book::Legacy => Some(pool.begin().await?),
        db::Book::Prisma => None,
    };
    let order_id = match &mut legacy_tx {
        Some(tx) => db::insert_order(tx, book, &new_order).await?,
        None => Uuid::new_v4().to_string(),
    };

    // Market Data Core's own current view, not a value the caller handed
    // in — see PlaceMarketOrderRequest's doc comment. Read the in-memory
    // TickCache first (no DB round trip on the common, hot path — the
    // spec's "Rust in-memory state... avoid unnecessary DB round trips"
    // rule); Postgres is only a fallback for a symbol that hasn't ticked
    // in-process yet (e.g. right after a server restart). Read against
    // `pool` directly (not `tx`) in the fallback case: it's a
    // point-in-time read of a table this crate doesn't own (ADR-002), not
    // something that needs snapshot consistency with the order-row insert
    // above.
    let current_tick = match cache.get_if_fresh(&req.symbol, tick_freshness()) {
        Some(tick) => Some(tick),
        None => market_data::db::get_live_price(pool, &req.symbol)
            .await?
            .map(|(bid, ask)| Tick { symbol: req.symbol.clone(), bid, ask, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }),
    };
    let current_tick = match current_tick {
        Some(tick) => tick,
        None => {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, format!("no live price for {}", req.symbol)).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    };

    // `symbol_config` was read above, before the order row: see there for why, and for what a
    // `None` means on each book.
    if let Some(cfg) = &symbol_config {
        if let Err(reject_reason) = risk::check_symbol_enabled(cfg.enabled) {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason.to_string()).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
        if let Err(reject_reason) = risk::check_lot_size(req.volume, cfg.min_lot, cfg.max_lot, cfg.lot_step) {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason.to_string()).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    }

    // THE LEGACY BOOK'S margin check, and only its (L2 Step 1d). `check_free_margin` compares free
    // margin with the requirement, on `equity`/`used_margin` THE CALLER HANDED IN, at the raw bid. The
    // Prisma book runs the web's own decision instead -- on the real book, at the real fill price,
    // against the group's own call level -- further down, once pricing has produced that price.
    if book == db::Book::Legacy {
        let required = risk::required_margin(req.volume, req.contract_size, current_tick.bid, req.leverage);
        if let Err(reject_reason) = risk::check_free_margin(req.equity, req.used_margin, required) {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason.to_string()).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    }

    // §2.1 step 5 — per-broker exposure limits. Last of the admission
    // checks, matching risk-engine.md's own ordering: cheaper/simpler
    // checks (enabled, lot size, margin) reject first. Both aggregates
    // fetched in one round trip -- see get_exposure_and_max_positions's
    // doc comment.
    let (exposure, max_open_positions) = match &snapshot {
        Some(s) => (s.exposure.clone(), s.max_open_positions),
        None => db::get_exposure_and_max_positions(pool, book, &req.broker_id, &req.account_id, &req.symbol, &symbol_id).await?,
    };
    let max_exposure = symbol_config.as_ref().and_then(|cfg| cfg.max_exposure);
    // L2 Step 1 Part B: the web's own admission gates, ported (gates.rs) and run in the web's order.
    //
    // ONLY on the Prisma book. On the legacy book this path writes tables nothing reads, and adding
    // gates there would change a mode whose behaviour is deliberately frozen.
    //
    // Why this exists: before it, this path applied FIVE gates where the web applies around twenty, so
    // the engine would have filled a suspended account's order, a halted broker's, one off its group's
    // lot grid, one past the broker's total exposure limit or the account's daily loss limit. Every
    // ported gate is pinned against the web's own function by docs/contracts/gate-vectors.json
    // (tests/gate_parity.rs), so "the engine refuses what the web refuses" is measured, not asserted.
    //
    // COMPLETE as of L2 Step 1d: all 23 of the web's open gates are ported and wired, the last of
    // them the pre-trade margin decision further down (it needs the fill price, so it cannot run in
    // this block). What remains deliberately unported is listed in gates.rs's NOT_PORTED note.
    let gate_inputs = if let Some(snap) = &snapshot {
        let gate_inputs = &snap.gates;
        // The tick's OWN time (ingest::resolve_tick_time, the same value "LivePrice".tickAt carries),
        // never Tick.t0 -- see gates::OpenOrder::tick_age_ms.
        let gate_now = chrono::Utc::now();
        let tick_age_ms = cache.latest(&req.symbol).map(|(_, at)| (gate_now - at).num_milliseconds().max(0));
        let order_for_gates = gates::OpenOrder {
            side: req.side,
            volume: req.volume,
            symbol_id: &symbol_id,
            symbol_name: &req.symbol,
            now: gate_now,
            symbol_min_lot: symbol_config.as_ref().map_or(Decimal::ZERO, |c| c.min_lot),
            symbol_lot_step: symbol_config.as_ref().map_or(Decimal::ZERO, |c| c.lot_step),
            symbol_max_exposure: max_exposure,
            account_symbol_volume: exposure.open_volume,
            open_position_count: exposure.open_position_count,
            max_open_positions,
            tick_age_ms,
        };
        if let Some(reject_reason) = gates::evaluate_open(gate_inputs, &order_for_gates) {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
        // kept: the pre-trade margin gate needs four more of these, and it cannot run until the fill
        // price exists
        Some(gate_inputs)
    } else {
        None
    };

    if let Err(reject_reason) = risk::check_symbol_exposure(exposure.open_volume, req.volume, max_exposure) {
        let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason.to_string()).await?;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }
    if let Err(reject_reason) = risk::check_max_open_positions(exposure.open_position_count, max_open_positions) {
        let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason.to_string()).await?;
        return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
    }


    // The ACCOUNT's own price on top of Market Data Core's raw tick — see pricing.rs.
    //
    // FLIP L2 (2026-11-02): this used to be `apply_spread_markup(.., cfg.spread_markup, ..)` off the
    // BrokerSymbol row fetched above, which is only the bottom level of the hierarchy and moved the
    // ask alone. A group or account override, and any target-spread rule, was dropped on the floor,
    // and a SELL filled at the raw bid while the trader was quoted the marked-down one. Resolving the
    // rule costs one extra round-trip per order (not per tick) and is read fresh, never cached, so a
    // markup edit can never be stale on a fill.
    // L2 Step 2: the levels came with the one read above, so this costs nothing. Still read FRESH
    // rather than from the pricing cache -- see `db::get_ask_levels` on why a markup edit must never
    // be stale on a fill.
    let ask_rule = match &snapshot {
        Some(s) => ask_markup::resolve(&s.ask_levels),
        None => db::get_ask_levels(pool, &req.broker_id, &req.account_id, &req.symbol).await?.and_then(|levels| ask_markup::resolve(&levels)),
    };
    let quoted_tick = pricing::quoted_tick(&current_tick, ask_rule.as_ref());

    let fill = execution::execute_market_order(
        &order_id,
        &req.account_id,
        req.side,
        req.volume,
        &quoted_tick,
        execution::ExecutionStrategy::Internal,
    );

    // THE LAST GATE (L2 Step 1d): the web's pre-trade margin decision, which replaces
    // `risk::check_free_margin` on this book. Four things that check could not do, every one of them
    // load-bearing:
    //
    // - it judged FREE MARGIN against the requirement, where the web judges the PROJECTED MARGIN LEVEL
    //   against the group's own `marginCallLevel` (`lte`, so an order that would land exactly on the
    //   call level is refused rather than opening straight into one).
    // - it was handed `equity` and `used_margin` BY THE CALLER. Those are the gateway's numbers; these
    //   come from the book itself (`calc::load_account_state`, one REPEATABLE READ snapshot), with MT5
    //   hedge netting and currency conversion, which the caller's two scalars cannot express.
    // - it knew nothing about conversion, so a JPY-quoted leg on a USD account was sized as if JPY
    //   were USD. Now an unconvertible leg -- the new one or any already open -- is refused outright,
    //   the web's NO_CONVERSION_RATE.
    // - it refused with one reason. The trader reads `"Order"."rejectionReason"`, and
    //   INSUFFICIENT_BALANCE ("you have not deposited enough") is a different message from
    //   INSUFFICIENT_MARGIN ("what you already have open leaves too little").
    //
    // HERE, not up with the other gates, because it needs the FILL price -- this account's own
    // marked-up/marked-down price, which only exists once pricing has run. The web places it at
    // exactly this point as well: `marginGate(fillPrice)` in app/api/trade/orders/route.ts, after
    // applySpreadMarkup and before the transaction that writes the position.
    if let (Some(inputs), Some(snap)) = (&gate_inputs, &snapshot) {
        // L2 Step 2: the funds and the priced positions came with the one read above -- the same
        // snapshot the gates were judged on, which is what `calc::load_book_state`'s own REPEATABLE
        // READ transaction was there to guarantee.
        let state = &snap.account;
        let leg = calc::NewLeg {
            symbol: &req.symbol,
            side: req.side,
            // what would actually open, not what was asked for
            volume: fill.volume,
            contract_size: req.contract_size,
            fill_price: fill.price,
            // ZERO DB: the leg's quote currency is converted from the engine's OWN in-memory ticks --
            // the same feed the web reads as "LivePrice" -- under the same 72 h age rule the book uses
            // for every other position. None here is NO_CONVERSION_RATE, never a guessed 1.
            fx_rate: crate::book::fx_rate_from_ticks(
                cache,
                &inputs.symbol_quote_currency,
                &inputs.account_currency,
                chrono::Utc::now(),
            ),
            hedged_margin_pct: inputs.symbol_hedged_margin_pct,
        };
        if let Some(reject_reason) = calc::pre_trade_margin_decision(state, &leg, inputs.margin_call_level) {
            let reason = refuse(pool, nats, book, &mut legacy_tx, &new_order, &order_id, &req.account_id, reject_reason).await?;
            return Ok(PlaceMarketOrderOutcome::Rejected { order_id, reason });
        }
    }

    // Flat per-lot commission, charged once at open (round-turn, not split between open/close) -- see
    // BrokerSymbolConfig's doc comment. On the Prisma book this DEBITS THE BALANCE, which the legacy
    // path never did.
    let commission_per_lot = symbol_config.as_ref().map_or(Decimal::ZERO, |cfg| cfg.commission_per_lot);

    // L2 Step 2 (DEPTH-CUT): THE WHOLE WRITE IN ONE ROUND TRIP, on the Prisma book.
    //
    // What used to be here: `set_filled`, `insert_position`, four statements of commission, three of
    // deal, the hedge intent, and the surrounding BEGIN / COMMIT -- fourteen sequential round trips,
    // about 70 ms of waiting at Neon's p50 and a quarter of a second at p99, for a fill the engine
    // decides in under a microsecond. `vyx_open_position` is those same twelve statements in the same
    // order, in one call. Nothing is recomputed in SQL; the amount, the note and the ids are all
    // decided here and passed in, so there is no second implementation to drift.
    let (position_id, order_id) = match book {
        db::Book::Prisma => {
            let call = db::OpenPositionCall {
                broker_id: &req.broker_id,
                account_id: &req.account_id,
                symbol_id: &symbol_id,
                side: req.side,
                order_type: OrderType::Market,
                volume: req.volume,
                requested_price: None,
                sl_price: req.sl_price,
                tp_price: req.tp_price,
                fill_price: fill.price,
                filled_volume: fill.volume,
                routing: Some(book_type.as_str()),
                book_type,
                commission_per_lot,
                // CLIENT: a client's own market fill, as app/api/trade/orders/route.ts writes it
                deal_reason: "CLIENT",
                order_id: &order_id,
                // this call owns the row: see the note where `legacy_tx` is opened
                create_order: true,
            };
            // The double-fill guard. NOT REACHABLE FROM HERE TODAY -- this path's order row is created
            // inside the same statement, so no other writer can see it and the compare-and-set cannot
            // lose -- and kept because it becomes reachable the moment the order is created elsewhere,
            // which is both what `pending_orders::trigger_order` already does and where the cutover
            // ends (design section 5b.2: the WEB creates the row, the engine fills it).
            //
            // AND WHAT IT BUYS, measured (L2 Stage 6 mutation testing): not correctness.
            // `"Position"`'s UNIQUE `"originOrderId"` is what makes a second position impossible. This
            // turns that into a clean answer instead -- a Rejected outcome rather than a constraint
            // violation from inside a money transaction, and no error logged for a normal race.
            let Some(opened) = db::open_position_one_call(pool, &call).await? else {
                return Ok(PlaceMarketOrderOutcome::Rejected {
                    order_id,
                    reason: "the order was already answered by another writer".to_string(),
                });
            };
            (opened.position_id, opened.order_id)
        }
        db::Book::Legacy => {
            let mut tx = legacy_tx.take().expect("the legacy book opened its transaction");
            if !db::set_filled(&mut tx, book, &order_id, fill.price, fill.volume, Some(book_type.as_str())).await? {
                tx.rollback().await?;
                return Ok(PlaceMarketOrderOutcome::Rejected {
                    order_id,
                    reason: "the order was already answered by another writer".to_string(),
                });
            }
            let (position_id, _opened_at) = db::insert_position(
                &mut tx,
                book,
                &db::NewPosition {
                    broker_id: req.broker_id.clone(),
                    account_id: req.account_id.clone(),
                    symbol: req.symbol.clone(),
                    symbol_id: symbol_id.clone(),
                    origin_order_id: order_id.clone(),
                    side: req.side,
                    volume: fill.volume,
                    open_price: fill.price,
                    sl_price: req.sl_price,
                    tp_price: req.tp_price,
                    book_type,
                },
            )
            .await?;
            db::record_commission(&mut tx, book, &req.broker_id, &req.account_id, &position_id, commission_per_lot, fill.volume).await?;
            tx.commit().await?;
            (position_id, order_id)
        }
    };

    publish_best_effort(
        nats,
        &TradingEvent::OrderFilled(Fill {
            order_id: order_id.clone(),
            account_id: req.account_id.clone(),
            price: fill.price,
            volume: fill.volume,
            remaining_volume: fill.remaining_volume,
        }),
    )
    .await;

    Ok(PlaceMarketOrderOutcome::Filled {
        order_id,
        position_id,
        fill_price: fill.price,
    })
}

/// Everything OMS needs to place a pending LIMIT/STOP order — see
/// ../../docs/execution.md §2.1 step 3. Unlike `PlaceMarketOrderRequest`,
/// there's no `equity`/`used_margin` here: a pending order doesn't
/// reserve margin while it waits — margin is checked when the order
/// actually triggers and opens a position, not while it's sitting
/// unfilled. See `pending_orders.rs` for that trigger-time check.
pub struct PlacePendingOrderRequest {
    pub broker_id: String,
    pub account_id: String,
    pub symbol: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub volume: Decimal,
    pub requested_price: Decimal,
    pub sl_price: Option<Decimal>,
    pub tp_price: Option<Decimal>,
}

#[derive(Debug)]
pub enum PlacePendingOrderOutcome {
    Accepted { order_id: String },
    Rejected { order_id: String, reason: String },
}

/// A pending order's requested price has to be on the side of the
/// current market that makes it a real pending order, not an order that
/// would just fill immediately if routed as-is:
/// - BUY LIMIT: below the current ask (buy cheaper than now)
/// - BUY STOP: above the current ask (buy a breakout)
/// - SELL LIMIT: above the current bid (sell higher than now)
/// - SELL STOP: below the current bid (sell a breakdown)
///
/// A `MARKET` order_type reaching this function is a caller bug (
/// `engine/server` should only route LIMIT/STOP here) — rejected the
/// same way rather than panicking, since it's still safe to handle as an
/// ordinary rejection.
fn validate_pending_price_side(
    side: OrderSide,
    order_type: OrderType,
    requested_price: Decimal,
    current: &Tick,
) -> Result<(), String> {
    match (side, order_type) {
        (OrderSide::Buy, OrderType::Limit) if requested_price >= current.ask => {
            Err(format!("BUY LIMIT price {requested_price} must be below the current ask {}", current.ask))
        }
        (OrderSide::Buy, OrderType::Stop) if requested_price <= current.ask => {
            Err(format!("BUY STOP price {requested_price} must be above the current ask {}", current.ask))
        }
        (OrderSide::Sell, OrderType::Limit) if requested_price <= current.bid => {
            Err(format!("SELL LIMIT price {requested_price} must be above the current bid {}", current.bid))
        }
        (OrderSide::Sell, OrderType::Stop) if requested_price >= current.bid => {
            Err(format!("SELL STOP price {requested_price} must be below the current bid {}", current.bid))
        }
        (_, OrderType::Market) => Err("pending orders must be LIMIT or STOP, not MARKET".to_string()),
        _ => Ok(()),
    }
}

/// Places a LIMIT/STOP order in ACCEPTED status — no fill, no position,
/// no margin check yet. `pending_orders::check_symbol_for_triggers`
/// (called from `engine/server`'s tick subscription) does the rest once
/// price actually crosses `requested_price`.
pub async fn place_pending_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    cache: &TickCache,
    req: PlacePendingOrderRequest,
) -> Result<PlacePendingOrderOutcome, PlaceOrderError> {
    // L2 Stage 3, as in place_market_order: one book for the whole order, and the symbol resolved
    // before the row exists because Prisma's "Order" requires its symbolId. Read here once -- the
    // admission checks below used to read it a second time.
    let book = db::configured();
    let symbol_config = db::get_broker_symbol_config(pool, &req.broker_id, &req.symbol).await?;
    if book == db::Book::Prisma && symbol_config.is_none() {
        return Err(PlaceOrderError::UnknownSymbol(req.symbol.clone()));
    }
    let symbol_id = symbol_config.as_ref().map(|c| c.symbol_id.clone()).unwrap_or_default();

    let mut tx = pool.begin().await?;

    let order_id = db::insert_order(
        &mut tx,
        book,
        &db::NewOrder {
            broker_id: req.broker_id.clone(),
            account_id: req.account_id.clone(),
            symbol: req.symbol.clone(),
            symbol_id,
            side: req.side,
            order_type: req.order_type,
            volume: req.volume,
            requested_price: Some(req.requested_price),
            sl_price: req.sl_price,
            tp_price: req.tp_price,
        },
    )
    .await?;

    // Same cache-first, DB-fallback rule as place_market_order — used
    // here only to validate the pending price is on the correct side of
    // today's market, not to fill anything yet.
    let current_tick = match cache.get_if_fresh(&req.symbol, tick_freshness()) {
        Some(tick) => Some(tick),
        None => market_data::db::get_live_price(pool, &req.symbol)
            .await?
            .map(|(bid, ask)| Tick { symbol: req.symbol.clone(), bid, ask, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }),
    };
    let current_tick = match current_tick {
        Some(tick) => tick,
        None => {
            let reason = reject_order(tx, nats, &order_id, &req.account_id, format!("no live price for {}", req.symbol)).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
    };

    if let Err(reason) = validate_pending_price_side(req.side, req.order_type, req.requested_price, &current_tick) {
        let reason = reject_order(tx, nats, &order_id, &req.account_id, reason).await?;
        return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
    }

    // Same admission checks as place_market_order (§2.1) — a disabled
    // symbol or an out-of-bounds lot shouldn't even be accepted as
    // pending, rather than sitting there until trigger time only to
    // reject then. Lot size doesn't need rechecking at trigger time
    // (pending_orders.rs) since volume never changes after placement.
    if let Some(cfg) = &symbol_config {
        if let Err(reject_reason) = risk::check_symbol_enabled(cfg.enabled) {
            let reason = reject_order(tx, nats, &order_id, &req.account_id, reject_reason.to_string()).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
        if let Err(reject_reason) = risk::check_lot_size(req.volume, cfg.min_lot, cfg.max_lot, cfg.lot_step) {
            let reason = reject_order(tx, nats, &order_id, &req.account_id, reject_reason.to_string()).await?;
            return Ok(PlacePendingOrderOutcome::Rejected { order_id, reason });
        }
    }

    // On the Prisma book this is already the status insert_order wrote (PENDING = resting): see
    // db::set_status, where making it anything else would hide the order from both pending scans.
    db::set_status(&mut tx, book, &order_id, OrderStatus::Accepted).await?;
    tx.commit().await?;

    publish_best_effort(nats, &TradingEvent::OrderAccepted { order_id: order_id.clone(), account_id: req.account_id.clone() }).await;

    Ok(PlacePendingOrderOutcome::Accepted { order_id })
}

/// The order is already committed to Postgres by the time this is called
/// — a NATS publish failure means a connected client's UI is stale until
/// its next poll/reconnect, not that trading state is wrong. Logged, not
/// propagated as an error, on that basis (see ../../docs/security.md's
/// framing of Postgres as sole authoritative state).
/// Shared tail of every admission-rejection path: mark the order
/// rejected, commit that (a rejection is itself a terminal state worth
/// persisting even though nothing else in the transaction happened), and
/// publish the event. Takes `tx` by value since a rejection always
/// commits and ends the transaction's life — there's nothing left for
/// the caller to do with it. Returns the reason so each call site can
/// still build its own `Outcome::Rejected` variant.
/// Answers a refused market order on either book -- L2 Step 2.
///
/// PRISMA: ONE statement. There is no order row yet (see `place_market_order`), so the row is INSERTed
/// already REJECTED, with the same column values insert-PENDING-then-UPDATE-REJECTED left behind --
/// `createdAt`, `updatedAt` and `executedAt` were all one transaction's `now()` there too, and
/// `executionMode` came out 'AUTO' either way.
///
/// LEGACY: unchanged. The row was inserted up front inside the transaction this takes; it moves to
/// REJECTED and commits.
///
/// The NATS event is published either way, after the row, exactly as before.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn refuse(
    pool: &PgPool,
    nats: &async_nats::Client,
    book: db::Book,
    legacy_tx: &mut Option<sqlx::Transaction<'static, sqlx::Postgres>>,
    order: &db::NewOrder,
    order_id: &str,
    account_id: &str,
    reason: String,
) -> Result<String, PlaceOrderError> {
    match legacy_tx.take() {
        Some(tx) => return reject_order(tx, nats, order_id, account_id, reason).await,
        None => {
            debug_assert_eq!(book, db::Book::Prisma, "only the Prisma book runs without a transaction");
            db::insert_rejected_order(pool, order, order_id, &reason).await?;
        }
    }
    publish_best_effort(
        nats,
        &TradingEvent::OrderRejected(RiskRejection {
            order_id: order_id.to_string(),
            account_id: account_id.to_string(),
            reason: reason.clone(),
        }),
    )
    .await;
    Ok(reason)
}

pub(crate) async fn reject_order(
    mut tx: sqlx::Transaction<'_, sqlx::Postgres>,
    nats: &async_nats::Client,
    order_id: &str,
    account_id: &str,
    reason: String,
) -> Result<String, PlaceOrderError> {
    // A false here means the order had already been answered, so there is nothing to reject and the
    // reason below is this caller's own view, not the order's. Committing either way keeps the
    // transaction's other work (there is none on this path) and the event consistent with the row.
    let rejected = db::set_rejected(&mut tx, db::configured(), order_id, &reason).await?;
    tx.commit().await?;
    if !rejected {
        tracing::warn!(order_id, "reject skipped: the order was no longer PENDING (already filled, rejected or cancelled)");
    }
    publish_best_effort(
        nats,
        &TradingEvent::OrderRejected(RiskRejection {
            order_id: order_id.to_string(),
            account_id: account_id.to_string(),
            reason: reason.clone(),
        }),
    )
    .await;
    Ok(reason)
}

pub(crate) async fn publish_best_effort(nats: &async_nats::Client, event: &TradingEvent) {
    if let Err(err) = events::publish(nats, event).await {
        tracing::warn!(?err, "failed to publish trading event to NATS");
    }
}

#[derive(Debug)]
pub enum CancelOrderOutcome {
    Cancelled { order_id: String },
    /// Covers both "no such order" and "exists but belongs to a
    /// different account" — same collapsing the legacy Next.js route
    /// does (app/api/trade/orders/[id]/route.ts's `!order ||
    /// order.accountId !== session.accountId`), so a wrong account_id
    /// never confirms an order's existence.
    NotFound,
    InvalidStatus { status: OrderStatus },
}

#[derive(Debug, thiserror::Error)]
pub enum CancelOrderError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Cancels a resting LIMIT/STOP order sitting in `ACCEPTED` — the only
/// status this is legal from (`is_legal_transition`'s `(Accepted,
/// Cancelled)`), mirroring the legacy Next.js path's "only PENDING can
/// be cancelled" rule. A MARKET order is filled synchronously within
/// `place_market_order` itself, so by the time a caller could reach this
/// function it's already terminal (FILLED/REJECTED) — cancel is only
/// ever meaningful for a still-waiting pending order.
pub async fn cancel_order(
    pool: &PgPool,
    nats: &async_nats::Client,
    order_id: &str,
    account_id: &str,
) -> Result<CancelOrderOutcome, CancelOrderError> {
    let Some(order) = db::get_order(pool, order_id).await? else {
        return Ok(CancelOrderOutcome::NotFound);
    };
    if order.account_id != account_id {
        return Ok(CancelOrderOutcome::NotFound);
    }
    if order.status != OrderStatus::Accepted {
        return Ok(CancelOrderOutcome::InvalidStatus { status: order.status });
    }

    let mut tx = pool.begin().await?;
    let claimed = db::cancel_order(&mut tx, order_id).await?;
    if !claimed {
        // Lost a race with the order triggering (or another cancel call)
        // between the read above and this claim -- re-report its actual
        // current status rather than falsely confirming cancellation.
        tx.rollback().await?;
        let current = db::get_order(pool, order_id).await?;
        return Ok(match current {
            Some(o) => CancelOrderOutcome::InvalidStatus { status: o.status },
            None => CancelOrderOutcome::NotFound,
        });
    }
    tx.commit().await?;

    publish_best_effort(nats, &TradingEvent::OrderCancelled { order_id: order_id.to_string(), account_id: account_id.to_string() }).await;

    Ok(CancelOrderOutcome::Cancelled { order_id: order_id.to_string() })
}

#[derive(Debug)]
pub enum ModifyPositionOutcome {
    Updated {
        sl_price: Option<Decimal>,
        tp_price: Option<Decimal>,
    },
    NotFound,
    InvalidStatus {
        status: db::PositionStatus,
    },
    ValidationFailed {
        reason: String,
    },
}

#[derive(Debug, thiserror::Error)]
pub enum ModifyPositionError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Edits an open position's SL/TP — same operation as the legacy
/// Next.js path's `PATCH /api/trade/positions/[id]`, not the
/// order-level `ModifyOrder` in docs/trading-engine.md's original
/// target spec (nothing in the live app has ever needed that; this
/// mirrors what traders actually do today). `current_price` is
/// caller-supplied (the Gateway's own Market Data Core read) rather
/// than fetched here, same reasoning as `PlaceMarketOrderRequest` not
/// including a tick -- kept out here deliberately so this function
/// doesn't gain its own Market Data Core dependency for one read the
/// caller already has to make anyway to show the trader a current price.
pub async fn modify_position_sl_tp(
    pool: &PgPool,
    nats: &async_nats::Client,
    account_id: &str,
    position_id: &str,
    current_price: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
) -> Result<ModifyPositionOutcome, ModifyPositionError> {
    let Some(position) = db::get_position(pool, position_id).await? else {
        return Ok(ModifyPositionOutcome::NotFound);
    };
    if position.account_id != account_id {
        return Ok(ModifyPositionOutcome::NotFound);
    }
    if position.status != db::PositionStatus::Open {
        return Ok(ModifyPositionOutcome::InvalidStatus { status: position.status });
    }

    if let Err(reason) = risk::validate_sl_tp(position.side, current_price, sl_price, tp_price) {
        return Ok(ModifyPositionOutcome::ValidationFailed { reason: reason.to_string() });
    }

    let mut tx = pool.begin().await?;
    db::update_position_sl_tp(&mut tx, position_id, sl_price, tp_price).await?;
    tx.commit().await?;

    publish_best_effort(
        nats,
        &TradingEvent::PositionModified { account_id: account_id.to_string(), position_id: position_id.to_string() },
    )
    .await;

    Ok(ModifyPositionOutcome::Updated { sl_price, tp_price })
}

#[derive(Debug)]
pub enum ClosePositionOutcome {
    Closed {
        close_price: Decimal,
        realized_pnl: Decimal,
    },
    NotFound,
    InvalidStatus {
        status: db::PositionStatus,
    },
    /// Lost a race with an automatic close (stop-out or SL/TP, see
    /// monitor.rs) that landed between this call reading the position
    /// and its own `close_position_with_ledger_entry` UPDATE — the
    /// position is genuinely closed, just not by this call, so nothing
    /// here to credit or publish again.
    AlreadyClosed,
}

#[derive(Debug, thiserror::Error)]
pub enum ClosePositionError {
    #[error(transparent)]
    Db(#[from] sqlx::Error),
}

/// Manually closes an open position at the current market price — the
/// trader-initiated counterpart to monitor.rs's automatic force-closes
/// (stop-out, SL/TP), reusing the same idempotent
/// `db::close_position_with_ledger_entry` so a manual close racing an
/// automatic one is a benign no-op rather than a double-close (see that
/// function's doc comment for why). `bid`/`ask` are caller-supplied (the
/// Gateway's own Market Data Core read), same convention as
/// `modify_position_sl_tp`'s `current_price` — this function doesn't gain
/// its own Market Data Core dependency for a read the caller already has
/// to make anyway to show the trader a current price.
pub async fn close_position(
    pool: &PgPool,
    nats: &async_nats::Client,
    account_id: &str,
    position_id: &str,
    bid: Decimal,
    ask: Decimal,
) -> Result<ClosePositionOutcome, ClosePositionError> {
    let Some(position) = db::get_position(pool, position_id).await? else {
        return Ok(ClosePositionOutcome::NotFound);
    };
    if position.account_id != account_id {
        return Ok(ClosePositionOutcome::NotFound);
    }
    if position.status != db::PositionStatus::Open {
        return Ok(ClosePositionOutcome::InvalidStatus { status: position.status });
    }

    let close_price = close_price_for(position.side, bid, ask);
    let realized_pnl = floating_pnl(position.side, position.open_price, close_price, position.contract_size, position.volume);

    let mut tx = pool.begin().await?;
    let closed = db::close_position_with_ledger_entry(&mut tx, position_id, account_id, close_price, realized_pnl).await?;
    tx.commit().await?;

    let Some(_entry_id) = closed else {
        return Ok(ClosePositionOutcome::AlreadyClosed);
    };

    publish_best_effort(
        nats,
        &TradingEvent::PositionClosed { account_id: account_id.to_string(), position_id: position_id.to_string() },
    )
    .await;

    Ok(ClosePositionOutcome::Closed { close_price, realized_pnl })
}

#[cfg(test)]
mod tests {
    use super::*;
    use OrderStatus::*;

    #[test]
    fn happy_path_market_order() {
        assert!(is_legal_transition(New, Validating));
        assert!(is_legal_transition(Validating, Accepted));
        assert!(is_legal_transition(Accepted, Routing));
        assert!(is_legal_transition(Routing, Filled));
    }

    #[test]
    fn rejects_skip_ahead() {
        assert!(!is_legal_transition(New, Filled));
        assert!(!is_legal_transition(New, Accepted));
        assert!(!is_legal_transition(Filled, Cancelled));
    }

    #[test]
    fn terminal_states_have_no_outgoing_transitions() {
        for terminal in [Filled, Rejected, Cancelled, Expired] {
            for target in [New, Validating, Accepted, Routing, PartiallyFilled, Filled, Rejected, Expired] {
                assert!(
                    !is_legal_transition(terminal, target),
                    "{terminal:?} should not transition to {target:?}"
                );
            }
        }
    }

    /// docs/testing.md §2's OMS gate: "every legal transition... has a
    /// unit test." is_legal_transition's match arms define exactly 11
    /// legal (from, to) pairs -- asserted here in one place rather than
    /// only implicitly via the happy-path tests above, which exercise a
    /// subset. Includes (Accepted, Cancelled) and (PartiallyFilled,
    /// Cancelled), the two pairs cancel_order depends on.
    #[test]
    fn every_documented_legal_transition_is_legal() {
        let legal_pairs = [
            (New, Validating),
            (Validating, Accepted),
            (Validating, Rejected),
            (Accepted, Routing),
            (Accepted, Cancelled),
            (Accepted, Expired),
            (Routing, PartiallyFilled),
            (Routing, Filled),
            (Routing, Rejected),
            (PartiallyFilled, Filled),
            (PartiallyFilled, Cancelled),
        ];
        for (from, to) in legal_pairs {
            assert!(is_legal_transition(from, to), "{from:?} -> {to:?} should be legal");
        }
    }

    mod pending_price_validation {
        use super::*;
        use rust_decimal_macros::dec;

        fn tick() -> Tick {
            Tick { symbol: "EURUSD".into(), bid: dec!(1.10000), ask: dec!(1.10020), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() }
        }

        #[test]
        fn buy_limit_must_be_below_current_ask() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.09000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.10020), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Limit, dec!(1.11000), &tick()).is_err());
        }

        #[test]
        fn buy_stop_must_be_above_current_ask() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.11000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.10020), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Stop, dec!(1.09000), &tick()).is_err());
        }

        #[test]
        fn sell_limit_must_be_above_current_bid() {
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.11000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.10000), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Limit, dec!(1.09000), &tick()).is_err());
        }

        #[test]
        fn sell_stop_must_be_below_current_bid() {
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.09000), &tick()).is_ok());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.10000), &tick()).is_err());
            assert!(validate_pending_price_side(OrderSide::Sell, OrderType::Stop, dec!(1.11000), &tick()).is_err());
        }

        #[test]
        fn market_order_type_always_rejected() {
            assert!(validate_pending_price_side(OrderSide::Buy, OrderType::Market, dec!(1.00000), &tick()).is_err());
        }
    }
}

#[cfg(test)]
mod pentest_tests;
