//! The risk path's book on the REAL Prisma schema (Rust cutover Stage 1, docs/RUST-CUTOVER-PLAN.md).
//!
//! Until this module the margin monitor read and wrote the engine's own lowercase tables (`positions`,
//! `ledger_entries`), which production never fills: every broker's book lives in Prisma's `"Position"` /
//! `"Account"` / `"Transaction"`. This module reads the book from there and closes a position exactly the
//! way the web's `lib/position-close.ts` `closePositionInTx` does, so the two paths write identical rows:
//!
//! 1. guarded UPDATE of `"Position"` (status = OPEN AND volume = what the caller read: a concurrent close,
//!    or a partial that already reduced it, makes this a benign `None`);
//! 2. `"Account"` row locked (`FOR UPDATE`) before its balance is read, so two closes on one account can
//!    never lose each other's P&L;
//! 3. negative-balance protection per `"Broker"."negativeBalanceProtection"`: the balance floors at 0 and
//!    the excess is an explicit NEGATIVE_BALANCE_PROTECTION write-off + AuditLog row;
//! 4. `"Account".balance` written, and a TRADE_PNL `"Transaction"` whose balanceAfter is the RAW
//!    (uncapped) result, as the web records it.
//!
//! What this module does NOT decide yet (Stage 2): the formulas (credit, live-price margin, tickAt
//! freshness, quote-currency conversion). `realized_pnl` is the caller's, in the account's currency.

use crate::db::OpenPositionWithMarket;
use rust_decimal::Decimal;
use sqlx::PgPool;
use uuid::Uuid;

/// A decimal as the web prints it with `Prisma.Decimal.toFixed(2)`: rounded half away from zero, 2 places.
/// NOT `format!("{:.2}")`, which TRUNCATES a rust_decimal (90.909 -> "90.90" where the web says "90.91"); found by
/// the Stage 3 gate, 2026-09-24. Every note / notice / audit text the web also writes goes through this.
pub fn fixed2(d: Decimal) -> String {
    format!("{:.2}", d.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero))
}

fn side_from_prisma(s: &str) -> protocol::OrderSide {
    match s {
        "SELL" => protocol::OrderSide::Sell,
        _ => protocol::OrderSide::Buy,
    }
}

/// Every account holding at least one OPEN position (same set lib/risk-monitor.ts's callers walk), in accountId byte
/// order (Stage 4: a deterministic pass order; the load harness's web reference walks the same order).
pub async fn account_ids_with_open_positions(pool: &PgPool) -> Result<Vec<String>, sqlx::Error> {
    let rows: Vec<(String,)> =
        sqlx::query_as(r#"SELECT "accountId" FROM "Position" WHERE status = 'OPEN' GROUP BY "accountId" ORDER BY "accountId" COLLATE "C""#).fetch_all(pool).await?;
    Ok(rows.into_iter().map(|(id,)| id).collect())
}

/// One account's OPEN positions with their USABLE price (Stage 2 F4, the web's rule in lib/live-price.ts
/// getFreshPrices + lib/risk-monitor.ts's session gate):
/// - the quote's `tickAt` (the real last-tick time, UTC) is under 15 s old. NOT `updatedAt`: the EA's
///   heartbeat re-sends an unchanged price every few seconds, which keeps `updatedAt` fresh on a dead feed;
/// - AND the symbol's trading session is open now for this account's broker (session.rs). As on the web,
///   only a symbol that has a BrokerSymbol row for the broker can be session-closed.
/// A position without a usable price comes back with `bid`/`ask` = None: counted nowhere, closeable by nothing.
// ---- Where the book's prices come from (2026-09-25) ----
// Since the market-data move (S5, 2026-09-15) the feed writes LivePrice to the VPS-local database; Neon's
// "LivePrice" stopped moving (10 days stale on 2026-09-25). This loader joined Neon's LivePrice, so in production the
// shadow -- and Stage 6's real close path -- would have seen every position UNPRICED. The live engine now prices the
// book from its OWN in-memory ticks: the very entry GET /internal/prices serves the web (lib/live-price.ts vps
// path), so the web and the engine read one source, the same Decimal bid / ask (the web gets them via
// decimal_json = normalize().to_string(), exact) under the same freshness rule (tickAt = the tick's origin time,
// else its receive time; fresh = newer than 15 s). Only the SOURCE changes: close, P&L, NBP untouched.

/// The book's price source.
#[derive(Clone, Default)]
pub enum PriceSource {
    /// The "LivePrice" table of the book's own database (tests, parity, the scratch harnesses).
    #[default]
    Db,
    /// The engine's in-memory ticks (the live feed): production.
    Ticks(std::sync::Arc<market_data::cache::TickCache>),
}

tokio::task_local! {
    static PRICE_SOURCE: PriceSource;
}

/// Set by the server (shadow / live order management): a book read with no tick source in scope is then an ERROR,
/// never a silent read of the database's LivePrice (a task spawned outside the scope would otherwise fall back).
static REQUIRE_TICK_SOURCE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn require_tick_source() {
    REQUIRE_TICK_SOURCE.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Runs `f` with `source` as the book's price source (a monitor pass runs as one task: every read inside sees it).
pub async fn with_price_source<F: std::future::Future>(source: PriceSource, f: F) -> F::Output {
    PRICE_SOURCE.scope(source, f).await
}

/// Stage 5 SL / TP snapshot (2026-09-26, market_data::risk_hook::SlTpTouch): an evaluation pinned to the moment the
/// risk hook saw a tick cross an SL / TP. While a Pin is in scope the book reads the account AS IT STOOD AT `at`:
/// - positions open at `at` -- including one the web has closed since (status CLOSED, closedAt >= at): its side, volume,
///   open price and levels do not change on a close -- and none opened after `at`;
/// - the balance and credit before every position-referenced ledger row written since `at` (the close's TRADE_PNL, its
///   CREDIT use and negative-balance write-off, a later position's commission: calc::load_book_state);
/// - the hook's own tick for the touched symbols (fresh = its tick time within 15 s of `at`, the web's rule), the
///   engine's ticks for the rest; sessions judged at `at`.
/// The decision logic is untouched: only the state it reads is pinned. The live path never waits for any of this.
///
/// `measured` (margin trigger fan-in fix, 2026-09-29): the ids of the positions the per-tick margin trigger MEASURED OPEN
/// at `at` (margin_watch::MarginFire). They count as open at the pin BY IDENTITY, and their close rows (TRADE_PNL, CREDIT
/// use, NEGATIVE_BALANCE_PROTECTION) as written after it, whatever the timestamps say: `at` is the engine's clock while
/// closedAt / createdAt are the database's, and a web close landing within milliseconds of the fire could otherwise be
/// stamped before `at` and hide the position (seen in the fan-in regression test). A 5 s bound keeps a stale book from
/// reviving a position closed well before the fire. Empty (the SL / TP snapshot) = exactly the time-based reads above.
#[derive(Clone, Debug)]
pub struct Pin {
    pub at: chrono::DateTime<chrono::Utc>,
    /// symbol -> (bid, ask, tick time) as the risk hook saw it
    pub ticks: std::collections::HashMap<String, (Decimal, Decimal, chrono::DateTime<chrono::Utc>)>,
    pub measured: Vec<String>,
}

tokio::task_local! {
    static PIN: Pin;
}

/// Runs `f` with the book pinned to `pin` (see Pin).
pub async fn with_pin<F: std::future::Future>(pin: Pin, f: F) -> F::Output {
    PIN.scope(pin, f).await
}

/// The Pin in scope, if any.
pub fn current_pin() -> Option<Pin> {
    PIN.try_with(|p| p.clone()).ok()
}

/// May this evaluation record a margin-call edge (shadow)? Unpinned: yes. Pinned by the MARGIN TRIGGER (a fire names
/// the positions it measured, Pin::measured): yes, the fire is "now", the moment the account crossed. Pinned by an
/// SL / TP snapshot (measured empty): no, that pin looks at a past touch and an edge from it would reorder the
/// account's edge history behind the pass that already saw later states. (2026-09-29, S3 re-run: since the fires were
/// pinned, the trigger's margin-call fire recorded no edge and only the 4 s pass could, seconds late.)
pub fn edges_recordable() -> bool {
    PIN.try_with(|p| !p.measured.is_empty()).unwrap_or(true)
}

fn current_price_source() -> Result<PriceSource, sqlx::Error> {
    match PRICE_SOURCE.try_with(|s| s.clone()) {
        Ok(s) => Ok(s),
        Err(_) if REQUIRE_TICK_SOURCE.load(std::sync::atomic::Ordering::SeqCst) => {
            Err(sqlx::Error::Protocol("book read without the engine's tick source in scope (would read the database's stale LivePrice)".into()))
        }
        Err(_) => Ok(PriceSource::Db),
    }
}

/// An FX conversion quote older than this is not used: equal to lib/fx.ts FX_RATE_MAX_AGE_MS (72 h, a weekend fits).
pub fn fx_rate_max_age() -> chrono::Duration {
    chrono::Duration::hours(72)
}

/// A conversion quote from the ticks, or None when there is none or it is older than fx_rate_max_age.
fn fx_quote_from_ticks(cache: &market_data::cache::TickCache, symbol: &str, now: chrono::DateTime<chrono::Utc>) -> Option<(Decimal, Decimal)> {
    cache.latest(symbol).filter(|(t, received)| now - tick_time(t, *received) < fx_rate_max_age()).map(|(t, _)| (t.bid, t.ask))
}

/// The tick time the web uses for freshness (engine price_row: tick_ms, else the receive time).
pub fn tick_time(tick: &protocol::Tick, received_at: chrono::DateTime<chrono::Utc>) -> chrono::DateTime<chrono::Utc> {
    tick.tick_ms.and_then(chrono::DateTime::from_timestamp_millis).unwrap_or(received_at)
}

/// Fresh bid / ask from the ticks, the web's rule: tick time newer than 15 s.
fn fresh_from_ticks(cache: &market_data::cache::TickCache, symbol: &str, now: chrono::DateTime<chrono::Utc>) -> (Option<Decimal>, Option<Decimal>) {
    match cache.latest(symbol) {
        Some((t, received)) if now - tick_time(&t, received) < chrono::Duration::seconds(15) => (Some(t.bid), Some(t.ask)),
        _ => (None, None),
    }
}

// ---- The account ask rules (2026-10-05, Neon load) ----
// The rules come from the in-memory pricing cache (market_data::pricing) the server keeps current, put in scope with
// `with_pricing` like the price source. A book query joins no pricing table any more. Without a cache in scope (tests,
// harnesses) a read loads the configuration of exactly its rows, in its own snapshot: the configuration as it is now,
// as the old per-row joins read it. Once the server has called `require_pricing_cache`, a read without a cache in
// scope is an ERROR (never a silent per-read load on the production database).

tokio::task_local! {
    static PRICING: std::sync::Arc<market_data::pricing::PricingCache>;
}

static REQUIRE_PRICING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn require_pricing_cache() {
    REQUIRE_PRICING.store(true, std::sync::atomic::Ordering::SeqCst);
}

/// Runs `f` with `cache` as the source of every account ask rule the book reads.
pub async fn with_pricing<F: std::future::Future>(cache: std::sync::Arc<market_data::pricing::PricingCache>, f: F) -> F::Output {
    PRICING.scope(cache, f).await
}

/// The price source and the pricing cache in one scope (what the server's order-management tasks run under).
pub async fn with_book_sources<F: std::future::Future>(
    prices: PriceSource,
    pricing: Option<std::sync::Arc<market_data::pricing::PricingCache>>,
    f: F,
) -> F::Output {
    match pricing {
        Some(p) => PRICE_SOURCE.scope(prices, PRICING.scope(p, f)).await,
        None => PRICE_SOURCE.scope(prices, f).await,
    }
}

/// The cached snapshot in scope (loaded on `conn` if the cache has not loaded yet), None = read per call (no cache).
async fn pricing_snapshot(conn: &mut sqlx::PgConnection) -> Result<Option<std::sync::Arc<market_data::ask_markup::PricingSnapshot>>, sqlx::Error> {
    match PRICING.try_with(|c| c.clone()) {
        Ok(cache) => Ok(Some(cache.snapshot_or_load(conn).await?)),
        Err(_) if REQUIRE_PRICING.load(std::sync::atomic::Ordering::SeqCst) => {
            Err(sqlx::Error::Protocol("book read without the pricing cache in scope (would read the pricing tables per read)".into()))
        }
        Err(_) => Ok(None),
    }
}

/// One OPEN position as the book query returns it, before pricing: everything the evaluation needs except the price.
#[derive(Clone, Debug)]
pub struct RawPosition {
    pub id: String,
    pub account_id: String,
    pub symbol_id: String,
    pub symbol: String,
    side: String,
    volume: Decimal,
    open_price: Decimal,
    contract_size: Decimal,
    sl_price: Option<Decimal>,
    tp_price: Option<Decimal>,
    category: String,
    /// the POSITION's broker (sessions)
    broker_id: String,
    quote_ccy: String,
    account_ccy: String,
    hedged_margin_pct: Decimal,
    digits: i32,
    /// the ACCOUNT's broker and group (the ask rule)
    account_broker_id: String,
    account_group_id: Option<String>,
    ask_rule: Option<market_data::ask_markup::AskRule>,
}

/// The columns of a RawPosition (aliases p, s, a, bs), shared by the per-account read and the pass's read.
const RAW_COLUMNS: &str = r#"p.id, p."accountId" AS account_id, s.id AS symbol_id, s.name, p.side::text AS side, p.volume, p."openPrice" AS open_price,
    s."contractSize" AS contract_size, p."slPrice" AS sl_price, p."tpPrice" AS tp_price, s.category::text AS category, p."brokerId" AS broker_id,
    s."quoteCurrency" AS quote_ccy, a.currency AS account_ccy, COALESCE(bs."hedgedMarginPct", 200) AS hedged_margin_pct, s.digits,
    a."brokerId" AS account_broker_id, a."groupId" AS account_group_id"#;

/// FROM ... of a RawPosition read: the position, its symbol, its account, its BrokerSymbol (hedged margin %). No price,
/// no pricing table.
const RAW_FROM: &str = r#"FROM "Position" p
    JOIN "Symbol" s ON s.id = p."symbolId"
    JOIN "Account" a ON a.id = p."accountId"
    LEFT JOIN "BrokerSymbol" bs ON bs."brokerId" = p."brokerId" AND bs."symbolId" = p."symbolId""#;

fn raw_from_row(r: &sqlx::postgres::PgRow) -> Result<RawPosition, sqlx::Error> {
    use sqlx::Row;
    Ok(RawPosition {
        id: r.try_get("id")?,
        account_id: r.try_get("account_id")?,
        symbol_id: r.try_get("symbol_id")?,
        symbol: r.try_get("name")?,
        side: r.try_get("side")?,
        volume: r.try_get("volume")?,
        open_price: r.try_get("open_price")?,
        contract_size: r.try_get("contract_size")?,
        sl_price: r.try_get("sl_price")?,
        tp_price: r.try_get("tp_price")?,
        category: r.try_get("category")?,
        broker_id: r.try_get("broker_id")?,
        quote_ccy: r.try_get("quote_ccy")?,
        account_ccy: r.try_get("account_ccy")?,
        hedged_margin_pct: r.try_get("hedged_margin_pct")?,
        digits: r.try_get("digits")?,
        account_broker_id: r.try_get("account_broker_id")?,
        account_group_id: r.try_get("account_group_id")?,
        ask_rule: None,
    })
}

/// Fills each row's ask rule: from the cache in scope, else from the configuration of these rows read on `conn`.
async fn resolve_rules(conn: &mut sqlx::PgConnection, rows: &mut [RawPosition]) -> Result<(), sqlx::Error> {
    if rows.is_empty() {
        return Ok(());
    }
    let snap = pricing_snapshot(conn).await?;
    let rules = {
        let keys: Vec<market_data::ask_markup::RuleKey<'_>> = rows
            .iter()
            .map(|r| market_data::ask_markup::RuleKey {
                account_id: &r.account_id,
                broker_id: &r.account_broker_id,
                group_id: r.account_group_id.as_deref(),
                symbol_id: &r.symbol_id,
                digits: r.digits,
            })
            .collect();
        market_data::ask_markup::rules_for(conn, snap.as_deref(), &keys).await?
    };
    for (r, rule) in rows.iter_mut().zip(rules) {
        r.ask_rule = rule;
    }
    Ok(())
}

/// (broker, symbol name) -> its configured sessions (an entry with no window = a BrokerSymbol without sessions).
type Sessions = std::collections::HashMap<(String, String), Vec<crate::session::SessionWindow>>;

/// The configured sessions of these brokers' symbols, in one query.
async fn load_sessions(conn: &mut sqlx::PgConnection, broker_ids: &[String], names: &[String]) -> Result<Sessions, sqlx::Error> {
    let mut sessions = Sessions::new();
    if broker_ids.is_empty() || names.is_empty() {
        return Ok(sessions);
    }
    let rows: Vec<(String, String, Option<i32>, Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT bs."brokerId", s.name, ts."dayOfWeek", ts."openTime", ts."closeTime"
           FROM "BrokerSymbol" bs
           JOIN "Symbol" s ON s.id = bs."symbolId"
           LEFT JOIN "TradingSession" ts ON ts."brokerSymbolId" = bs.id
           WHERE bs."brokerId" = ANY($1) AND s.name = ANY($2)"#,
    )
    .bind(broker_ids)
    .bind(names)
    .fetch_all(&mut *conn)
    .await?;
    for (broker, name, day, open, close) in rows {
        let list = sessions.entry((broker, name)).or_default();
        if let (Some(day_of_week), Some(open_time), Some(close_time)) = (day, open, close) {
            list.push(crate::session::SessionWindow { day_of_week, open_time, close_time });
        }
    }
    Ok(sessions)
}

/// The FX conversion symbols these rows may need (quote -> account currency, fx.rs), deduplicated.
fn fx_symbols_of<'a>(rows: impl IntoIterator<Item = &'a RawPosition>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for r in rows {
        for s in crate::fx::conversion_symbols_for(&r.quote_ccy, &r.account_ccy) {
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

/// The database's prices (PriceSource::Db only: tests, parity, the scratch harnesses): fresh LivePrice (tickAt under
/// 15 s) of `symbols`, and the FX quotes (tickAt under 72 h, lib/fx.ts) of `fx`. Production never runs this.
#[derive(Default)]
struct DbPrices {
    fresh: std::collections::HashMap<String, (Decimal, Decimal)>,
    fx: std::collections::HashMap<String, (Decimal, Decimal)>,
}

async fn load_db_prices(conn: &mut sqlx::PgConnection, symbols: &[String], fx: &[String]) -> Result<DbPrices, sqlx::Error> {
    let mut out = DbPrices::default();
    if !symbols.is_empty() {
        let q: Vec<(String, Decimal, Decimal)> =
            sqlx::query_as(r#"SELECT symbol, bid, ask FROM "LivePrice" WHERE symbol = ANY($1) AND "tickAt" > now() - interval '15 seconds'"#)
                .bind(symbols)
                .fetch_all(&mut *conn)
                .await?;
        out.fresh = q.into_iter().map(|(s, b, a)| (s, (b, a))).collect();
    }
    if !fx.is_empty() {
        let q: Vec<(String, Decimal, Decimal)> =
            sqlx::query_as(r#"SELECT symbol, bid, ask FROM "LivePrice" WHERE symbol = ANY($1) AND "tickAt" > now() - interval '72 hours'"#)
                .bind(fx)
                .fetch_all(&mut *conn)
                .await?;
        out.fx = q.into_iter().map(|(s, b, a)| (s, (b, a))).collect();
    }
    Ok(out)
}

/// One account's rows priced at `now` (Stage 2 F4: usable = a fresh price under the web's 15 s rule, the session open
/// for the account's broker, a conversion rate). The account's broker for sessions = its first row's (one account = one
/// broker, as the web assumes).
fn price_rows(rows: &[RawPosition], sessions: &Sessions, source: &PriceSource, pin: Option<&Pin>, now: chrono::DateTime<chrono::Utc>, db: &DbPrices) -> Vec<OpenPositionWithMarket> {
    let Some(first) = rows.first() else { return Vec::new() };
    let broker_id = first.broker_id.clone();
    let fx_quotes: std::collections::HashMap<String, crate::fx::Quote> = match source {
        // same age limit as lib/fx.ts FX_RATE_MAX_AGE_MS: older = no rate = the position is unpriced
        PriceSource::Ticks(cache) => fx_symbols_of(rows).into_iter().filter_map(|s| fx_quote_from_ticks(cache, &s, now).map(|q| (s, q))).collect(),
        PriceSource::Db => db.fx.clone(),
    };
    rows.iter()
        .map(|r| {
            // the SOURCE of bid / ask: the database's LivePrice or the engine's ticks
            let (bid, ask) = match (source, pin.and_then(|p| p.ticks.get(&r.symbol))) {
                // pinned: the risk hook's own tick for a touched symbol, under the web's 15 s rule at the pin's moment
                (_, Some(&(b, a, tick_at))) if now - tick_at < chrono::Duration::seconds(15) => (Some(b), Some(a)),
                (_, Some(_)) => (None, None),
                (PriceSource::Db, None) => db.fresh.get(&r.symbol).map_or((None, None), |&(b, a)| (Some(b), Some(a))),
                (PriceSource::Ticks(cache), None) => fresh_from_ticks(cache, &r.symbol, now),
            };
            let closed = sessions
                .get(&(broker_id.clone(), r.symbol.clone()))
                .is_some_and(|windows| crate::session::is_market_closed(windows, now, &r.category));
            let rate = crate::fx::conversion_rate(&r.quote_ccy, &r.account_ccy, |s| fx_quotes.get(s).copied());
            if rate.is_none() {
                tracing::error!(position_id = %r.id, symbol = %r.symbol, quote_ccy = %r.quote_ccy, account_ccy = %r.account_ccy, "no conversion rate: position treated as unpriced");
            }
            let usable = !closed && rate.is_some();
            OpenPositionWithMarket {
                id: r.id.clone(),
                symbol: r.symbol.clone(),
                side: side_from_prisma(&r.side),
                volume: r.volume,
                open_price: r.open_price,
                contract_size: r.contract_size,
                bid: if usable { bid } else { None },
                ask: if usable { ask } else { None },
                sl_price: r.sl_price,
                tp_price: r.tp_price,
                fx_rate: rate.unwrap_or(Decimal::ONE),
                hedged_margin_pct: r.hedged_margin_pct,
                ask_rule: r.ask_rule,
            }
        })
        .collect()
}

pub async fn open_positions_with_market(
    pool: &PgPool,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    let mut conn = pool.acquire().await?;
    open_positions_with_market_on(&mut conn, account_id).await
}

/// `open_positions_with_market` on a given connection: calc::load_book_state runs it inside its one snapshot
/// transaction, together with the funds and ledger reads (2026-10-01, the torn read). Used per account by the pinned
/// evaluations (the margin trigger's fires, the SL / TP snapshots) and the live monitor; the shadow PASS reads the whole
/// book at once (load_pass_book).
pub async fn open_positions_with_market_on(
    conn: &mut sqlx::PgConnection,
    account_id: &str,
) -> Result<Vec<OpenPositionWithMarket>, sqlx::Error> {
    let pin = current_pin();
    let source = current_price_source()?;
    let sql = format!(
        "SELECT {RAW_COLUMNS} {RAW_FROM} WHERE p.\"accountId\" = $1 AND {open} ORDER BY p.\"openedAt\", p.id",
        // pinned (Stage 5 snapshot): what was open at the pin's moment, including a position closed since; plus the
        // positions the margin trigger measured open at it, by identity (Pin::measured; none for an SL / TP snapshot)
        open = if pin.is_some() {
            r#"((p."openedAt" <= $2 AND (p.status = 'OPEN' OR p."closedAt" >= $2))
                 OR (p.id = ANY($3) AND (p.status = 'OPEN' OR p."closedAt" >= $2 - interval '5 seconds')))"#
        } else {
            "p.status = 'OPEN'"
        },
    );
    let q = sqlx::query(&sql).bind(account_id);
    let q = match &pin {
        Some(p) => q.bind(p.at).bind(&p.measured),
        None => q,
    };
    let mut rows = q.fetch_all(&mut *conn).await?.iter().map(raw_from_row).collect::<Result<Vec<_>, _>>()?;
    if rows.is_empty() {
        return Ok(Vec::new());
    }
    resolve_rules(conn, &mut rows).await?;
    let names: Vec<String> = rows.iter().map(|r| r.symbol.clone()).collect();
    let sessions = load_sessions(conn, std::slice::from_ref(&rows[0].broker_id), &names).await?;
    let db = match source {
        PriceSource::Db => load_db_prices(conn, &names, &fx_symbols_of(&rows)).await?,
        PriceSource::Ticks(_) => DbPrices::default(),
    };
    // pinned: sessions, freshness and conversion quotes judged at the pin's moment
    let now = pin.as_ref().map_or_else(chrono::Utc::now, |p| p.at);
    Ok(price_rows(&rows, &sessions, &source, pin.as_ref(), now, &db))
}

// ---- The shadow pass's book in one read (2026-10-05, Neon load) ----
// The pass used to read every account on its own: its funds, its positions (joined with the pricing tables and
// LivePrice), its sessions, its thresholds -- ~7 statements per account per pass, every VYX_SHADOW_PASS_SECS. It now
// reads the whole book in ONE REPEATABLE READ, READ ONLY snapshot (the torn-read rule of 51de153, for the whole pass):
// every open position with its account's funds, thresholds and negative-balance flag (one query), the sessions of every
// held symbol (one query), and -- only for accounts the shadow still has in margin call that hold nothing any more --
// their funds (one query). Every account is then evaluated in memory; the "re-read after a close" of an evaluation
// re-prices the snapshot's rows from the ticks at that moment (the shadow writes nothing, so the database would show
// the same rows). Pinned evaluations (fires, SL / TP snapshots) still read their one account.

/// One account of the pass's book.
#[derive(Clone, Debug)]
pub struct PassAccount {
    pub balance: Decimal,
    pub credit: Decimal,
    pub leverage: i32,
    pub thresholds: margin::MarginThresholds,
    /// the broker's negativeBalanceProtection
    pub nbp: bool,
    rows: Vec<RawPosition>,
}

/// The whole book of one shadow pass (load_pass_book).
pub struct PassBook {
    /// accountId -> account, in byte order (= COLLATE "C", the pass order)
    accounts: std::collections::BTreeMap<String, PassAccount>,
    sessions: Sessions,
    db: DbPrices,
}

impl PassBook {
    /// Every account holding an open position, in pass order (accountId byte order).
    pub fn account_ids_with_open_positions(&self) -> Vec<String> {
        self.accounts.iter().filter(|(_, a)| !a.rows.is_empty()).map(|(id, _)| id.clone()).collect()
    }

    pub fn account(&self, account_id: &str) -> Option<&PassAccount> {
        self.accounts.get(account_id)
    }

    /// The account's state priced from `source` at `now` (calc::load_book_state's result for this snapshot).
    pub fn state(&self, account_id: &str, source: &PriceSource, now: chrono::DateTime<chrono::Utc>) -> Option<crate::calc::AccountState> {
        let a = self.accounts.get(account_id)?;
        Some(crate::calc::AccountState {
            effective_balance: a.balance,
            credit: a.credit,
            leverage: a.leverage.max(1) as u32,
            positions: price_rows(&a.rows, &self.sessions, source, None, now, &self.db),
        })
    }

    /// Positions in the book (diagnostics, tests).
    pub fn position_count(&self) -> usize {
        self.accounts.values().map(|a| a.rows.len()).sum()
    }
}

/// The pass's whole book in one read-only snapshot (see above). `extra_accounts`: accounts to include even when they
/// hold nothing (the shadow's accounts still in margin call). Must run inside the price source's scope.
pub async fn load_pass_book(pool: &PgPool, extra_accounts: &[String]) -> Result<PassBook, sqlx::Error> {
    let source = current_price_source()?;
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY").execute(&mut *tx).await?;
    let book = load_pass_book_on(&mut tx, extra_accounts, &source).await;
    // read only: nothing to commit
    let _ = tx.rollback().await;
    book
}

async fn load_pass_book_on(conn: &mut sqlx::PgConnection, extra_accounts: &[String], source: &PriceSource) -> Result<PassBook, sqlx::Error> {
    use sqlx::Row;
    let d = margin::MarginThresholds::default();
    let sql = format!(
        r#"SELECT {RAW_COLUMNS}, a.balance, a.credit, a.leverage, g."marginCallLevel" AS call, g."stopOutLevel" AS stop_out,
                  COALESCE(b."negativeBalanceProtection", false) AS nbp
           {RAW_FROM}
           LEFT JOIN "Group" g ON g.id = a."groupId"
           LEFT JOIN "Broker" b ON b.id = a."brokerId"
           WHERE p.status = 'OPEN'
           ORDER BY a.id COLLATE "C", p."openedAt", p.id"#
    );
    let raw = sqlx::query(&sql).fetch_all(&mut *conn).await?;
    let mut accounts: std::collections::BTreeMap<String, PassAccount> = std::collections::BTreeMap::new();
    let mut rows: Vec<RawPosition> = Vec::with_capacity(raw.len());
    for r in &raw {
        let row = raw_from_row(r)?;
        if !accounts.contains_key(&row.account_id) {
            let (call, stop_out): (Option<Decimal>, Option<Decimal>) = (r.try_get("call")?, r.try_get("stop_out")?);
            accounts.insert(
                row.account_id.clone(),
                PassAccount {
                    balance: r.try_get("balance")?,
                    credit: r.try_get("credit")?,
                    leverage: r.try_get("leverage")?,
                    thresholds: margin::MarginThresholds { call_level: call.unwrap_or(d.call_level), stop_out_level: stop_out.unwrap_or(d.stop_out_level) },
                    nbp: r.try_get("nbp")?,
                    rows: Vec::new(),
                },
            );
        }
        rows.push(row);
    }
    resolve_rules(conn, &mut rows).await?;
    // sessions of every (broker, symbol) the book holds, and (database prices only) LivePrice, each in one query
    let mut broker_ids: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    for r in &rows {
        if !broker_ids.contains(&r.broker_id) {
            broker_ids.push(r.broker_id.clone());
        }
        if !names.contains(&r.symbol) {
            names.push(r.symbol.clone());
        }
    }
    let sessions = load_sessions(conn, &broker_ids, &names).await?;
    let db = match source {
        PriceSource::Db => load_db_prices(conn, &names, &fx_symbols_of(&rows)).await?,
        PriceSource::Ticks(_) => DbPrices::default(),
    };
    for row in rows {
        if let Some(a) = accounts.get_mut(&row.account_id) {
            a.rows.push(row);
        }
    }
    let flat: Vec<String> = extra_accounts.iter().filter(|id| !accounts.contains_key(*id)).cloned().collect();
    if !flat.is_empty() {
        let funds: Vec<(String, Decimal, Decimal, i32, Option<Decimal>, Option<Decimal>, bool)> = sqlx::query_as(
            r#"SELECT a.id, a.balance, a.credit, a.leverage, g."marginCallLevel", g."stopOutLevel", COALESCE(b."negativeBalanceProtection", false)
               FROM "Account" a LEFT JOIN "Group" g ON g.id = a."groupId" LEFT JOIN "Broker" b ON b.id = a."brokerId"
               WHERE a.id = ANY($1)"#,
        )
        .bind(&flat)
        .fetch_all(&mut *conn)
        .await?;
        for (id, balance, credit, leverage, call, stop_out, nbp) in funds {
            accounts.insert(
                id,
                PassAccount {
                    balance,
                    credit,
                    leverage,
                    thresholds: margin::MarginThresholds { call_level: call.unwrap_or(d.call_level), stop_out_level: stop_out.unwrap_or(d.stop_out_level) },
                    nbp,
                    rows: Vec::new(),
                },
            );
        }
    }
    Ok(PassBook { accounts, sessions, db })
}

/// The price source in scope (the pass book prices its rows with it at each evaluation).
pub fn price_source_in_scope() -> Result<PriceSource, sqlx::Error> {
    current_price_source()
}

/// The account's stop-out / margin-call thresholds, read from its OWN Group in the same database, every
/// evaluation (Stage 2 F3: one source, no cached map). No group: the global defaults 100 / 50
/// (margin::MarginThresholds::default, = lib/risk-monitor.ts's `?? 100` / `?? 50`). None = no such account.
pub async fn account_thresholds(pool: &PgPool, account_id: &str) -> Result<Option<margin::MarginThresholds>, sqlx::Error> {
    let row: Option<(Option<Decimal>, Option<Decimal>)> = sqlx::query_as(
        r#"SELECT g."marginCallLevel", g."stopOutLevel"
           FROM "Account" a LEFT JOIN "Group" g ON g.id = a."groupId"
           WHERE a.id = $1"#,
    )
    .bind(account_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|(call, stop_out)| {
        let d = margin::MarginThresholds::default();
        margin::MarginThresholds { call_level: call.unwrap_or(d.call_level), stop_out_level: stop_out.unwrap_or(d.stop_out_level) }
    }))
}

/// The money side of one close, pure (Stage 5): what `close_position_in_tx` writes and what the shadow's
/// simulated close applies in memory. ONE function, so a would-close in shadow cannot drift from a real close.
/// Stage 2 F1 (credit Model A, = lib/position-close.ts): a loss that takes the BALANCE below zero is paid from
/// CREDIT next, up to the shortfall; only what credit cannot cover reaches negative-balance protection
/// (`protect_nbp` = the broker's negativeBalanceProtection), which floors the balance at 0.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CloseMoney {
    /// balance + realized P&L, before credit and any floor (the TRADE_PNL row's balanceAfter)
    pub raw_balance_after: Decimal,
    /// after credit paid what it could
    pub after_credit: Decimal,
    pub final_balance: Decimal,
    pub final_credit: Decimal,
    pub credit_used: Option<Decimal>,
    pub write_off: Option<Decimal>,
}

pub fn close_money(balance_before: Decimal, credit_before: Decimal, realized_pnl: Decimal, protect_nbp: bool) -> CloseMoney {
    let raw_balance_after = balance_before + realized_pnl;
    let mut after_credit = raw_balance_after;
    let mut final_credit = credit_before;
    let mut credit_used = None;
    if raw_balance_after < Decimal::ZERO && credit_before > Decimal::ZERO {
        let used = credit_before.min(-raw_balance_after);
        after_credit = raw_balance_after + used;
        final_credit = credit_before - used;
        credit_used = Some(used);
    }
    let mut final_balance = after_credit;
    let mut write_off = None;
    if after_credit < Decimal::ZERO && protect_nbp {
        write_off = Some(-after_credit);
        final_balance = Decimal::ZERO;
    }
    CloseMoney { raw_balance_after, after_credit, final_balance, final_credit, credit_used, write_off }
}

#[derive(Debug, Clone, PartialEq)]
pub struct CloseOutcome {
    pub realized_pnl: Decimal,
    /// balance + realized P&L, before any floor (what the TRADE_PNL row records as balanceAfter)
    pub raw_balance_after: Decimal,
    /// what Account.balance now holds
    pub final_balance: Decimal,
    /// Some(amount) when negative-balance protection absorbed the part below zero
    pub write_off: Option<Decimal>,
    /// Some(amount) when credit paid part of a loss beyond the balance (Stage 2 F1)
    pub credit_used: Option<Decimal>,
    /// what Account.credit now holds
    pub final_credit: Decimal,
    pub account_id: String,
    pub broker_id: String,
    /// the TRADE_PNL "Transaction" row this close wrote (one per close: the outbox dedupe key uses it)
    pub trade_txn_id: String,
}

/// Closes one position in full at `close_price`, crediting `realized_pnl` (account currency), inside the
/// caller's transaction. `expected_volume` is the volume the caller read the position with; if the row is
/// no longer OPEN with exactly that volume, nothing is written and `None` comes back (a benign race).
pub async fn close_position_in_tx(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    expected_volume: Decimal,
    close_price: Decimal,
    realized_pnl: Decimal,
    note: &str,
) -> Result<Option<CloseOutcome>, sqlx::Error> {
    let claimed: Option<(String, String)> = sqlx::query_as(
        r#"UPDATE "Position"
           SET status = 'CLOSED', "closePrice" = $1, "realizedPnl" = $2, "closedAt" = now()
           WHERE id = $3 AND status = 'OPEN' AND volume = $4
           RETURNING "accountId", "brokerId""#,
    )
    .bind(close_price)
    .bind(realized_pnl)
    .bind(position_id)
    .bind(expected_volume)
    .fetch_optional(&mut **tx)
    .await?;
    let Some((account_id, broker_id)) = claimed else {
        return Ok(None);
    };

    let (balance_before, credit_before): (Decimal, Decimal) = sqlx::query_as(r#"SELECT balance, credit FROM "Account" WHERE id = $1 FOR UPDATE"#)
        .bind(&account_id)
        .fetch_one(&mut **tx)
        .await?;
    // the money rules live in close_money (shared with the Stage 5 shadow's simulated close); the broker's
    // negative-balance protection flag is read only when the result would go below zero, as before
    let unprotected = close_money(balance_before, credit_before, realized_pnl, false);
    let protect = if unprotected.after_credit < Decimal::ZERO {
        let (protect,): (bool,) = sqlx::query_as(r#"SELECT "negativeBalanceProtection" FROM "Broker" WHERE id = $1"#)
            .bind(&broker_id)
            .fetch_one(&mut **tx)
            .await?;
        protect
    } else {
        false
    };
    let CloseMoney { raw_balance_after, after_credit, final_balance, final_credit, credit_used, write_off } =
        close_money(balance_before, credit_before, realized_pnl, protect);

    sqlx::query(r#"UPDATE "Account" SET balance = $1, credit = $2, "updatedAt" = now() WHERE id = $3"#)
        .bind(final_balance)
        .bind(final_credit)
        .bind(&account_id)
        .execute(&mut **tx)
        .await?;

    let trade_txn_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"INSERT INTO "Transaction"
             (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
           VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
    )
    .bind(&trade_txn_id)
    .bind(&broker_id)
    .bind(&account_id)
    .bind(realized_pnl)
    .bind(balance_before)
    .bind(raw_balance_after)
    .bind(position_id)
    .bind(note)
    .execute(&mut **tx)
    .await?;

    if let Some(used) = credit_used {
        sqlx::query(
            r#"INSERT INTO "Transaction"
                 (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'CREDIT', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(used)
        .bind(raw_balance_after)
        .bind(after_credit)
        .bind(position_id)
        .bind(format!("Credit applied to a loss: {} (credit {} -> {})", fixed2(used), fixed2(credit_before), fixed2(final_credit)))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "creditUsed": fixed2(used),
            "creditBefore": fixed2(credit_before),
            "creditAfter": fixed2(final_credit),
        });
        sqlx::query(
            r#"INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "newValue")
               VALUES ($1, $2, 'CREDIT_CONSUMED_BY_LOSS', 'Account', $3, $4::jsonb)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(detail.to_string())
        .execute(&mut **tx)
        .await?;
    }

    if let Some(amount) = write_off {
        sqlx::query(
            r#"INSERT INTO "Transaction"
                 (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'NEGATIVE_BALANCE_PROTECTION', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(amount)
        .bind(after_credit)
        .bind(final_balance)
        .bind(position_id)
        .bind(format!("Negative-balance protection: broker absorbed ${} beyond zero", fixed2(amount)))
        .execute(&mut **tx)
        .await?;
        let detail = serde_json::json!({
            "positionId": position_id,
            "writeOffAmount": fixed2(amount),
            "rawBalanceAfter": fixed2(raw_balance_after),
        });
        sqlx::query(
            r#"INSERT INTO "AuditLog" (id, "brokerId", action, "entityType", "entityId", "newValue")
               VALUES ($1, $2, 'NEGATIVE_BALANCE_PROTECTION_APPLIED', 'Account', $3, $4::jsonb)"#,
        )
        .bind(Uuid::new_v4().to_string())
        .bind(&broker_id)
        .bind(&account_id)
        .bind(detail.to_string())
        .execute(&mut **tx)
        .await?;
    }

    Ok(Some(CloseOutcome {
        realized_pnl,
        raw_balance_after,
        final_balance,
        write_off,
        credit_used,
        final_credit,
        account_id,
        broker_id,
        trade_txn_id,
    }))
}

/// How long a pending follow-up may hold back the evaluation of the account it will touch (see
/// `pending_follow_up_owns`). Past this the account is evaluated anyway: a stuck outbox (dispatcher down, web
/// unreachable) must never keep an account from its own stop-out.
pub const FOLLOW_UP_DEFER_SECS: i32 = 30;

/// Stage 4.5 (ordering = the web's): true when a PENDING post-close follow-up, queued under
/// FOLLOW_UP_DEFER_SECS ago, is still going to touch one of this account's OPEN positions:
/// - close a mirror target (its `mirror` step not yet done);
/// - close an auto-hedged coverage leg (its `coverage` step not yet done; a dealer-booked leg is left open for the
///   desk on the web too, so it is not waited for);
/// - release a client position its coverage leg was hedging, when that LEG was the one closed (its `coverage`
///   step not yet done): the web releases it, and tells the desk, while the client position is still open.
/// The web runs all of these inside its pass, right after the close that triggers them, so by the time it
/// evaluates this account they have happened; the monitor waits for them the same way.
/// Where an account stands against pending follow-ups (see `pending_follow_up_state`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FollowUpOwed {
    /// nothing pending touches it: evaluate
    No,
    /// a follow-up queued under FOLLOW_UP_DEFER_SECS ago still will: wait for it
    Yes,
    /// only follow-ups OLDER than the window still touch it (a stuck outbox): evaluate anyway -- the safety release
    Expired,
}

/// Deferral queries run and safety releases taken since start (Stage 4 cost / starvation metrics; also worth
/// alerting on in production: a safety release means the outbox was stuck for FOLLOW_UP_DEFER_SECS).
pub static DEFER_QUERIES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static SAFETY_RELEASES: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// POSITION_CLOSED follow-ups this process queued (enqueue_post_close). A pass that saw none pending at its start
/// only needs the per-account deferral query once this moves (see monitor::run_pass).
pub static FOLLOW_UPS_QUEUED: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub static DEFER_PRECHECKS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Stage 4 §4.8, the per-PASS precheck: is ANY post-close follow-up pending at all? (No window, so a stuck row still
/// routes the accounts it touches through the per-account query and its safety-release accounting.) One index probe
/// on ("status", ...) instead of the 3-way query for every account, in the normal case where nothing is pending.
pub async fn any_pending_follow_up(pool: &PgPool) -> Result<bool, sqlx::Error> {
    DEFER_PRECHECKS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (any,): (bool,) = sqlx::query_as(
        r#"SELECT EXISTS (SELECT 1 FROM "PostCloseEffect" WHERE status = 'PENDING' AND kind = 'POSITION_CLOSED')"#,
    )
    .fetch_one(pool)
    .await?;
    Ok(any)
}

pub async fn pending_follow_up_owns(pool: &PgPool, account_id: &str) -> Result<bool, sqlx::Error> {
    Ok(pending_follow_up_state(pool, account_id).await? == FollowUpOwed::Yes)
}

/// The three cases above as one query, without the window, reporting whether any of them is still fresh.
pub async fn pending_follow_up_state(pool: &PgPool, account_id: &str) -> Result<FollowUpOwed, sqlx::Error> {
    DEFER_QUERIES.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let (any, fresh): (bool, bool) = sqlx::query_as(
        r#"WITH owed AS (
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "MirrorLink" ml ON ml."sourcePositionId" = e."positionId"
             JOIN "Position" t ON t.id = ml."targetPositionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('mirror' = ANY(e."doneSteps"))
               AND t."accountId" = $1 AND t.status = 'OPEN'
             UNION ALL
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "Position" s ON s.id = e."positionId"
             JOIN "Position" leg ON leg.id = s."coveragePositionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
               AND leg."accountId" = $1 AND leg.status = 'OPEN' AND leg."autoHedged"
             UNION ALL
             SELECT e."createdAt" FROM "PostCloseEffect" e
             JOIN "Position" client ON client."coveragePositionId" = e."positionId"
             WHERE e.status = 'PENDING' AND e.kind = 'POSITION_CLOSED' AND NOT ('coverage' = ANY(e."doneSteps"))
               AND client."accountId" = $1 AND client.status = 'OPEN'
           )
           SELECT count(*) > 0, coalesce(bool_or("createdAt" > now() - ($2::int * interval '1 second')), false) FROM owed"#,
    )
    .bind(account_id)
    .bind(FOLLOW_UP_DEFER_SECS)
    .fetch_one(pool)
    .await?;
    Ok(if fresh { FollowUpOwed::Yes } else if any { FollowUpOwed::Expired } else { FollowUpOwed::No })
}

/// Why the monitor closed a position, as the post-close outbox row records it ("reason").
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    StopLoss,
    TakeProfit,
    /// the margin level that triggered it and the account's stop-out level (the dealer's notice quotes both)
    StopOut { margin_level: Decimal, stop_out_level: Decimal },
}

impl CloseReason {
    pub fn as_str(&self) -> &'static str {
        match self {
            CloseReason::StopLoss => "stop_loss",
            CloseReason::TakeProfit => "take_profit",
            CloseReason::StopOut { .. } => "stop_out",
        }
    }
}

/// Rust cutover Stage 3: queues what the web must do after this close (queued-close cancel, mirror, stop-out
/// notice, coverage, events: lib/post-close.ts) as a "PostCloseEffect" row, inside the SAME transaction as the
/// close, so a committed close always has its follow-up recorded and a rolled-back one never does. One row per
/// close (dedupe key = the close's TRADE_PNL row). `volume_before` is the position's volume when it was closed:
/// the web can no longer read it from the row once the close has committed.
pub async fn enqueue_post_close(
    tx: &mut sqlx::PgTransaction<'_>,
    position_id: &str,
    outcome: &CloseOutcome,
    reason: CloseReason,
    volume_before: Decimal,
    close_price: Decimal,
) -> Result<(), sqlx::Error> {
    let mut payload = serde_json::json!({
        "closedLots": volume_before.normalize().to_string(),
        "sourceVolumeBeforeClose": volume_before.normalize().to_string(),
        "closePrice": close_price.normalize().to_string(),
        "realizedPnl": outcome.realized_pnl.normalize().to_string(),
    });
    if let CloseReason::StopOut { margin_level, stop_out_level } = reason {
        // the same text lib/risk-monitor.ts passes: level to 2 dp, the threshold as configured
        payload["marginLevel"] = serde_json::Value::String(fixed2(margin_level));
        payload["stopOutLevel"] = serde_json::Value::String(stop_out_level.normalize().to_string());
    }
    sqlx::query(
        r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", "positionId", reason, payload)
           VALUES ($1, 'POSITION_CLOSED', $2, $3, $4, $5, $6, $7::jsonb)
           ON CONFLICT ("dedupeKey") DO NOTHING"#,
    )
    .bind(Uuid::new_v4().to_string())
    .bind(format!("close:{}:{}", position_id, outcome.trade_txn_id))
    .bind(&outcome.broker_id)
    .bind(&outcome.account_id)
    .bind(position_id)
    .bind(reason.as_str())
    .bind(payload.to_string())
    .execute(&mut **tx)
    .await?;
    // counted once the caller commits or not -- a rolled-back row only makes the next pass check once more
    FOLLOW_UPS_QUEUED.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    Ok(())
}

/// Where an account stands against its margin-call level after a pass (lib/risk-monitor.ts pass 3).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum MarginCallEdge {
    /// at or below the margin-call level
    In { margin_level: Decimal, call_level: Decimal },
    /// above it again, or nothing left open
    Out,
}

/// Whether the account's margin-call edge is currently set ("Account"."marginCallNotifiedAt").
pub async fn margin_call_notified(pool: &PgPool, account_id: &str) -> Result<bool, sqlx::Error> {
    let row: Option<(bool,)> = sqlx::query_as(r#"SELECT "marginCallNotifiedAt" IS NOT NULL FROM "Account" WHERE id = $1"#)
        .bind(account_id)
        .fetch_optional(pool)
        .await?;
    Ok(row.map(|(b,)| b).unwrap_or(false))
}

/// The margin-call notice, edge-triggered on "Account"."marginCallNotifiedAt" exactly as the web does it: entering
/// margin call with the column empty sets it and queues ONE "MARGIN_CALL" outbox row (the web's route writes the
/// trader's and the staff's notification), in one transaction; staying in does nothing; leaving clears the column
/// so the next episode notifies again. Returns true when this call queued a notice.
pub async fn apply_margin_call_edge(pool: &PgPool, account_id: &str, edge: MarginCallEdge) -> Result<bool, sqlx::Error> {
    match edge {
        MarginCallEdge::Out => {
            sqlx::query(r#"UPDATE "Account" SET "marginCallNotifiedAt" = NULL WHERE id = $1 AND "marginCallNotifiedAt" IS NOT NULL"#)
                .bind(account_id)
                .execute(pool)
                .await?;
            Ok(false)
        }
        MarginCallEdge::In { margin_level, call_level } => {
            let mut tx = pool.begin().await?;
            let entered: Option<(String, i64)> = sqlx::query_as(
                r#"UPDATE "Account" SET "marginCallNotifiedAt" = now()
                   WHERE id = $1 AND "marginCallNotifiedAt" IS NULL
                   RETURNING "brokerId", (extract(epoch from "marginCallNotifiedAt") * 1000)::bigint"#,
            )
            .bind(account_id)
            .fetch_optional(&mut *tx)
            .await?;
            let Some((broker_id, edge_ms)) = entered else {
                tx.rollback().await?;
                return Ok(false); // already notified for this episode
            };
            let payload = serde_json::json!({
                "marginLevel": fixed2(margin_level),
                "marginCallLevel": call_level.normalize().to_string(),
            });
            sqlx::query(
                r#"INSERT INTO "PostCloseEffect" (id, kind, "dedupeKey", "brokerId", "accountId", payload)
                   VALUES ($1, 'MARGIN_CALL', $2, $3, $4, $5::jsonb)
                   ON CONFLICT ("dedupeKey") DO NOTHING"#,
            )
            .bind(Uuid::new_v4().to_string())
            .bind(format!("mc:{}:{}", account_id, edge_ms))
            .bind(&broker_id)
            .bind(account_id)
            .bind(payload.to_string())
            .execute(&mut *tx)
            .await?;
            tx.commit().await?;
            Ok(true)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fixed2;
    use rust_decimal_macros::dec;

    /// = Prisma.Decimal.toFixed(2) (decimal.js ROUND_HALF_UP: half away from zero)
    #[test]
    fn fixed2_rounds_like_the_web() {
        assert_eq!(fixed2(dec!(90.9090909)), "90.91");
        assert_eq!(fixed2(dec!(-900)), "-900.00");
        assert_eq!(fixed2(dec!(0.125)), "0.13");
        assert_eq!(fixed2(dec!(-0.125)), "-0.13");
        assert_eq!(fixed2(dec!(12.344)), "12.34");
        assert_eq!(fixed2(dec!(49.995)), "50.00");
    }
}


#[cfg(test)]
mod price_source_tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn tick(bid: Decimal, ask: Decimal, tick_ms: Option<i64>) -> protocol::Tick {
        let mut j = serde_json::json!({ "symbol": "XAUUSD", "bid": bid, "ask": ask });
        if let Some(ms) = tick_ms {
            j["tick_ms"] = serde_json::json!(ms);
        }
        serde_json::from_value(j).unwrap()
    }

    /// The web receives bid / ask as decimal_json (normalize().to_string()) and parses them back as Decimal: for every
    /// shape of price it gets exactly the Decimal the engine's book uses. No float anywhere, no rounding difference.
    #[test]
    fn the_webs_copy_of_a_tick_is_the_same_decimal() {
        for d in [dec!(4270.50), dec!(4270.5), dec!(1.08345), dec!(0.00001), dec!(150.000), dec!(77061.0), dec!(2000.20)] {
            let over_the_wire = d.normalize().to_string();
            assert_eq!(over_the_wire.parse::<Decimal>().unwrap(), d, "{d} -> {over_the_wire}");
        }
    }

    #[test]
    fn ticks_give_the_exact_bid_ask_under_the_webs_freshness_rule() {
        let cache = market_data::cache::TickCache::new();
        let now = chrono::Utc::now();
        // the tick's own origin time decides (engine price_row tickAt = tick_ms), not when it was received
        cache.set(&tick(dec!(4270.55), dec!(4270.85), Some((now - chrono::Duration::milliseconds(14_999)).timestamp_millis())), now);
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (Some(dec!(4270.55)), Some(dec!(4270.85))));
        cache.set(&tick(dec!(4270.55), dec!(4270.85), Some((now - chrono::Duration::seconds(15)).timestamp_millis())), now);
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (None, None), "15 s old = stale (web: tickAt > now - 15 s)");
        // no tick_ms: the receive time, as price_row
        cache.set(&tick(dec!(4271), dec!(4271.3), None), now - chrono::Duration::seconds(3));
        assert_eq!(fresh_from_ticks(&cache, "XAUUSD", now), (Some(dec!(4271)), Some(dec!(4271.3))));
        assert_eq!(fresh_from_ticks(&cache, "EURUSD", now), (None, None), "unknown symbol = unpriced");
    }

    /// FX age limit, the same as lib/fx.ts (fx-age.test.ts): 49 h (a weekend) converts, over 72 h is no rate.
    #[test]
    fn fx_quotes_older_than_72h_are_not_used() {
        let cache = market_data::cache::TickCache::new();
        let now = chrono::Utc::now();
        let set = |hours: i64| {
            let t: protocol::Tick = serde_json::from_value(serde_json::json!({ "symbol": "EURUSD", "bid": dec!(1.08), "ask": dec!(1.0802), "tick_ms": (now - chrono::Duration::hours(hours)).timestamp_millis() })).unwrap();
            cache.set(&t, now);
        };
        set(49);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), Some((dec!(1.08), dec!(1.0802))), "a weekend-old rate converts");
        set(73);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), None, "older than 72 h: no rate");
        set(24 * 10);
        assert_eq!(fx_quote_from_ticks(&cache, "EURUSD", now), None, "10 days (the stale Neon copy): no rate");
    }
}
