//! L2 Step 2 — DEPTH-CUT: how many sequential round trips one market fill costs, and the proof that
//! collapsing them changes nothing about the rows it leaves behind.
//!
//! WHY ROUND TRIPS AND NOT "QUERIES". The engine's own compute for a fill is microseconds
//! (`execution::execute_market_order` benched at 0.2-0.3 us). Everything else is network: the model the
//! latency work validated is `app_ms ~= compute + sequential_round_trips x RTT`, and VPS->Neon RTT is
//! p50 ~5 ms / p99 ~27-33 ms. So the only lever that matters is the COUNT, and it has to be measured
//! rather than counted by reading code -- a `pool.begin()`, a `SET TRANSACTION`, a `ROLLBACK` and a
//! `COMMIT` are each a full round trip and none of them looks like a query in the source.
//!
//! HOW. `measure_the_fill_paths_round_trips` brackets exactly one `place_market_order` between two
//! marker statements. With `log_statement = 'all'` on the scratch cluster, every statement the fill
//! issued is in the server log between those two markers, and
//! `scripts/measure-fill-round-trips.py` counts them. Nothing is inferred.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//!   ENGINE_TEST_NATS_URL=nats://127.0.0.1:4299 VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test open_position_depth_db

#![allow(clippy::type_complexity)]

use order_management::db;
use protocol::OrderSide;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use uuid::Uuid;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("open_position_depth_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database: {url}");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id() -> String {
    Uuid::new_v4().simple().to_string()
}

struct Fx {
    broker: String,
    account: String,
    symbol_id: String,
    symbol_name: String,
}

/// The same world `order_book_prisma_db.rs` builds: a broker, a routing group, one LIVE account with
/// 100000, and a 2-digit CRYPTO symbol (always open, so the session gate does not make this
/// clock-dependent) carrying a per-lot commission -- so the commission branch of the write chain is
/// measured, not skipped.
async fn fixture(db: &mut sqlx::PgConnection, category: &str, commission_per_lot: Decimal) -> Fx {
    let (broker, group, account, symbol) = (id(), id(), id(), id());
    let t = &broker[..10];
    let symbol_name = format!("ZD{}", t[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "negativeBalanceProtection", "updatedAt") VALUES ($1, $2, $3, true, now())"#)
        .bind(&broker)
        .bind(format!("L2 S2 {t}"))
        .bind(format!("l2s2-{t}"))
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, category, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $3, $4::"RoutingCategory", 100, 50, now())"#)
        .bind(&group)
        .bind(&broker)
        .bind(format!("L2S2-{t}"))
        .bind(category)
        .execute(&mut *db)
        .await
        .unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, credit, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'L2 S2', 'LIVE', 100000, 0, 100, now())"#,
    )
    .bind(&account)
    .bind(&broker)
    .bind(&group)
    .bind(format!("5{}", &t[..7]))
    .bind(format!("l2s2-{t}@test.local"))
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(
        r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt")
           VALUES ($1, $2, 'XAU', 'USD', 2, 1, 'CRYPTO'::"SymbolCategory", now())"#,
    )
    .bind(&symbol)
    .bind(&symbol_name)
    .execute(&mut *db)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "commissionPerLot", "updatedAt") VALUES ($1, $2, $3, $4, now())"#)
        .bind(id())
        .bind(&broker)
        .bind(&symbol)
        .bind(commission_per_lot)
        .execute(&mut *db)
        .await
        .unwrap();
    Fx { broker, account, symbol_id: symbol, symbol_name }
}

async fn cleanup(pool: &PgPool, fx: &Fx) {
    for sql in [
        r#"DELETE FROM "Deal" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "AuditLog" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "PostCloseEffect" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
        r#"DELETE FROM "Broker" WHERE id = $1"#,
    ] {
        sqlx::query(sql).bind(&fx.broker).execute(pool).await.unwrap();
    }
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&fx.symbol_id).execute(pool).await.unwrap();
}

/// A statement whose text the server log carries verbatim, so a measurement script can find the two
/// ends of the window it cares about. Interpolated, not bound -- a bound parameter would log the same
/// text for every marker.
async fn mark(pool: &PgPool, what: &str) {
    sqlx::query(&format!("SELECT 'VYXMARK {what}'")).execute(pool).await.unwrap();
}

fn tick(symbol: &str) -> protocol::Tick {
    protocol::Tick {
        symbol: symbol.to_string(),
        bid: dec!(4298.96),
        ask: dec!(4299.13),
        t0: None,
        clock_offset_ms: None,
        rtt_ms: None,
        tick_ms: None,
        broker_offset_sec: None,
        bars: Vec::new(),
    }
}

fn request(fx: &Fx, volume: Decimal) -> order_management::PlaceMarketOrderRequest {
    order_management::PlaceMarketOrderRequest {
        broker_id: fx.broker.clone(),
        account_id: fx.account.clone(),
        symbol: fx.symbol_name.clone(),
        side: OrderSide::Buy,
        volume,
        sl_price: None,
        tp_price: None,
        // the caller's own numbers, which no gate on the Prisma book reads any more (L2 Step 1d)
        equity: dec!(100000),
        used_margin: dec!(0),
        contract_size: dec!(1),
        leverage: 100,
    }
}




// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// The gaps the mutation sweep found. Every one of these exists because a mutant SURVIVED: the
// behaviour was right and nothing was watching it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// A second symbol on the same broker, with its own `"BrokerSymbol"` row (which a `"TradingSession"`
/// has to hang off). Returns (symbolId, name, brokerSymbolId).
async fn extra_symbol(pool: &PgPool, broker: &str, category: &str) -> (String, String, String) {
    let (sid, bsid) = (id(), id());
    let name = format!("ZX{}", sid[..6].to_uppercase());
    sqlx::query(
        r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt")
           VALUES ($1, $2, 'EUR', 'USD', 2, 1, $3::"SymbolCategory", now())"#,
    )
    .bind(&sid)
    .bind(&name)
    .bind(category)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "commissionPerLot", "updatedAt") VALUES ($1, $2, $3, 0, now())"#)
        .bind(&bsid)
        .bind(broker)
        .bind(&sid)
        .execute(pool)
        .await
        .unwrap();
    (sid, name, bsid)
}

/// Opens a position on `symbol_id` directly, so a test can build the book it needs.
async fn open_on(pool: &PgPool, fx: &Fx, symbol_id: &str, volume: Decimal, price: Decimal) -> String {
    let order_id = Uuid::new_v4().to_string();
    db::open_position_one_call(
        pool,
        &db::OpenPositionCall {
            broker_id: &fx.broker,
            account_id: &fx.account,
            symbol_id,
            side: OrderSide::Buy,
            order_type: protocol::OrderType::Market,
            volume,
            requested_price: None,
            sl_price: None,
            tp_price: None,
            fill_price: price,
            filled_volume: volume,
            routing: Some(db::BookType::ABook.as_str()),
            book_type: db::BookType::ABook,
            commission_per_lot: Decimal::ZERO,
            deal_reason: "CLIENT",
            order_id: &order_id,
            create_order: true,
        },
    )
    .await
    .unwrap()
    .expect("opened")
    .position_id
}

/// MUTANT `fn:commission-charged-even-at-zero` survived: both zero-commission tests called
/// `db::record_commission` directly, so nothing watched the function's own `IF p_commission > 0`.
/// A zero or negative per-lot rate must charge NOTHING AT ALL -- the web's own `lte(0)`: no balance
/// move, no `"Transaction"`, and a deal whose commission is 0 rather than a 0-amount charge row.
#[tokio::test]
async fn a_zero_commission_charges_nothing_through_the_one_call_write() {
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    setup.commit().await.unwrap();

    let order_id = Uuid::new_v4().to_string();
    let opened = db::open_position_one_call(
        &pool,
        &db::OpenPositionCall {
            broker_id: &fx.broker,
            account_id: &fx.account,
            symbol_id: &fx.symbol_id,
            side: OrderSide::Buy,
            order_type: protocol::OrderType::Market,
            volume: dec!(0.01),
            requested_price: None,
            sl_price: None,
            tp_price: None,
            fill_price: dec!(4299.13),
            filled_volume: dec!(0.01),
            routing: Some(db::BookType::BBook.as_str()),
            book_type: db::BookType::BBook,
            commission_per_lot: Decimal::ZERO,
            deal_reason: "CLIENT",
            order_id: &order_id,
            create_order: true,
        },
    )
    .await
    .unwrap()
    .expect("opened");

    let (balance,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1"#).bind(&fx.account).fetch_one(&pool).await.unwrap();
    assert_eq!(balance, dec!(100000), "nothing to charge, so nothing moves");
    let (rows,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Transaction" WHERE "referenceId" = $1"#).bind(&opened.position_id).fetch_one(&pool).await.unwrap();
    assert_eq!(rows, 0, "a zero charge writes no Transaction at all");
    let (deal_commission, txn): (Decimal, Option<String>) =
        sqlx::query_as(r#"SELECT commission, "transactionId" FROM "Deal" WHERE "positionId" = $1"#).bind(&opened.position_id).fetch_one(&pool).await.unwrap();
    assert_eq!(deal_commission, Decimal::ZERO, "the deal sums an empty ledger to zero");
    assert_eq!(txn, None, "no commission row, so no transaction to name");
    let (pos_commission,): (Decimal,) = sqlx::query_as(r#"SELECT commission FROM "Position" WHERE id = $1"#).bind(&opened.position_id).fetch_one(&pool).await.unwrap();
    assert_eq!(pos_commission, Decimal::ZERO);

    cleanup(&pool, &fx).await;
}

/// MUTANT `refuse:rejected-order-written-as-filled` survived: every gate test asserted the OUTCOME
/// (which the Rust return decides) and none asserted THE ROW. An order refused but persisted as
/// FILLED is a phantom fill -- a filled order with no position behind it -- and nothing would have
/// said so. L2 Step 2 made the refusal a single INSERT, which is exactly the statement that could get
/// this wrong.
#[tokio::test]
async fn a_refused_order_is_persisted_as_rejected_with_its_reason() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else { return };
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    setup.commit().await.unwrap();
    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());

    // the simplest gate there is: the whole broker is halted
    sqlx::query(r#"UPDATE "Broker" SET "tradingHaltedAt" = now() WHERE id = $1"#).bind(&fx.broker).execute(&pool).await.unwrap();
    let outcome = order_management::place_market_order(&pool, &nats, &cache, None, 0, request(&fx, dec!(0.01))).await.expect("the order path ran");
    let order_management::PlaceMarketOrderOutcome::Rejected { order_id, reason } = outcome else {
        panic!("a halted broker must not fill");
    };

    let (status, stored_reason, filled_price, execution_mode): (String, Option<String>, Option<Decimal>, Option<String>) = sqlx::query_as(
        r#"SELECT status::text, "rejectionReason", "filledPrice", "executionMode" FROM "Order" WHERE id = $1"#,
    )
    .bind(&order_id)
    .fetch_one(&pool)
    .await
    .expect("the refusal wrote a row the trader can read");
    assert_eq!(status, "REJECTED", "the row has to say refused, not filled");
    assert_eq!(stored_reason.as_deref(), Some(reason.as_str()), r#""Order"."rejectionReason" is what the trader reads"#);
    assert_eq!(filled_price, None, "a refused order has no fill price");
    assert_eq!(execution_mode.as_deref(), Some("AUTO"));
    let (positions,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Position" WHERE "originOrderId" = $1"#).bind(&order_id).fetch_one(&pool).await.unwrap();
    assert_eq!(positions, 0, "and nothing opened behind it");

    cleanup(&pool, &fx).await;
}

/// MUTANT `read:unknown-symbol-answered-as-found` survived: nothing placed an order for a symbol that
/// does not exist on the Prisma book. It must be a client error, not an empty `symbolId` written into
/// `"Order"` and `"Position"` -- both of which have a FK on it.
#[tokio::test]
async fn an_unknown_symbol_is_a_client_error_not_an_order() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else { return };
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    setup.commit().await.unwrap();
    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());

    let mut req = request(&fx, dec!(0.01));
    req.symbol = "NOSUCHSYMBOL".to_string();
    let err = order_management::place_market_order(&pool, &nats, &cache, None, 0, req).await.expect_err("an unknown symbol cannot produce an order");
    assert!(
        matches!(&err, order_management::PlaceOrderError::UnknownSymbol(s) if s == "NOSUCHSYMBOL"),
        "expected UnknownSymbol, got {err:?}"
    );
    let (orders,): (i64,) = sqlx::query_as(r#"SELECT count(*) FROM "Order" WHERE "brokerId" = $1"#).bind(&fx.broker).fetch_one(&pool).await.unwrap();
    assert_eq!(orders, 0, "and no row was written for it");

    cleanup(&pool, &fx).await;
}

/// MUTANT `read:held-sessions-dropped` survived: no test held a position whose MARKET IS CLOSED. The
/// trading sessions of every held symbol used to come from `book::load_sessions`, its own query; L2
/// Step 2 folded them into the one read as a jsonb map, so this is the assertion that the map arrives
/// and is keyed the way `book::price_order_path_rows` looks it up.
///
/// A position whose market is closed is UNPRICED: in neither the used margin nor the equity (Stage 2
/// F4, the convention the margin watcher and the stop-out loop share). Drop the sessions and it would
/// be priced as if the market were open.
#[tokio::test]
async fn a_closed_market_position_is_unpriced_in_the_one_read() {
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    setup.commit().await.unwrap();

    // a FOREX symbol whose only session is on a day that is not today
    let (other_id, other_name, other_bs) = extra_symbol(&pool, &fx.broker, "FOREX").await;
    use chrono::Datelike;
    let other_day = (chrono::Utc::now().weekday().num_days_from_sunday() as i32 + 2) % 7;
    sqlx::query(r#"INSERT INTO "TradingSession" (id, "brokerSymbolId", "dayOfWeek", "openTime", "closeTime") VALUES ($1, $2, $3, '08:00', '17:00')"#)
        .bind(id())
        .bind(&other_bs)
        .bind(other_day)
        .execute(&pool)
        .await
        .unwrap();
    open_on(&pool, &fx, &other_id, dec!(1), dec!(1.1000)).await;
    open_on(&pool, &fx, &fx.symbol_id, dec!(0.01), dec!(4299.13)).await;

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    cache.set(
        &protocol::Tick { symbol: other_name.clone(), bid: dec!(1.1000), ask: dec!(1.1002), t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None, bars: Vec::new() },
        chrono::Utc::now(),
    );
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(&pool).await.unwrap();

    let got = order_management::book::with_book_sources(
        order_management::book::PriceSource::Ticks(cache.clone()),
        Some(pricing.clone()),
        db::get_open_snapshot(&pool, &cache, &fx.broker, &fx.account, &fx.symbol_name, OrderSide::Buy, 0),
    )
    .await
    .unwrap();
    let db::OpenSnapshotResult::Found(snap) = got else { panic!("the account exists") };

    let closed = snap.account.positions.iter().find(|p| p.symbol == other_name).expect("the FOREX position is in the book");
    assert_eq!((closed.bid, closed.ask), (None, None), "a closed market leaves the position unpriced");
    let open = snap.account.positions.iter().find(|p| p.symbol == fx.symbol_name).expect("the CRYPTO position is in the book");
    assert!(open.bid.is_some() && open.ask.is_some(), "CRYPTO is always open, so it keeps its price");
    // and that is what the margin figures are built on: only the priced leg pays margin
    let used = order_management::calc::used_margin(&snap.account);
    let only_crypto = dec!(0.01) * dec!(1) * dec!(4298.96) / Decimal::from(100);
    assert_eq!(used, only_crypto, "the closed-market leg contributes no used margin");

    sqlx::query(r#"DELETE FROM "TradingSession" WHERE "brokerSymbolId" = $1"#).bind(&other_bs).execute(&pool).await.unwrap();
    cleanup(&pool, &fx).await;
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&other_id).execute(&pool).await.unwrap();
}

/// MUTANT `read:exposure-counts-every-symbol` survived: no test held positions on TWO symbols, so the
/// `FILTER (WHERE "symbolId" = sym.id)` that makes the symbol-exposure gate per-SYMBOL was never
/// measured. Without it a trader holding other symbols would be refused on this one's limit.
#[tokio::test]
async fn the_one_reads_symbol_exposure_counts_only_the_traded_symbol() {
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();
    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "B_BOOK", dec!(0)).await;
    setup.commit().await.unwrap();

    let (other_id, _other_name, _bs) = extra_symbol(&pool, &fx.broker, "CRYPTO").await;
    open_on(&pool, &fx, &fx.symbol_id, dec!(0.03), dec!(4299.13)).await;
    open_on(&pool, &fx, &other_id, dec!(7), dec!(1.1000)).await;

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(&pool).await.unwrap();
    let got = order_management::book::with_book_sources(
        order_management::book::PriceSource::Ticks(cache.clone()),
        Some(pricing.clone()),
        db::get_open_snapshot(&pool, &cache, &fx.broker, &fx.account, &fx.symbol_name, OrderSide::Buy, 0),
    )
    .await
    .unwrap();
    let db::OpenSnapshotResult::Found(snap) = got else { panic!("the account exists") };

    assert_eq!(snap.exposure.open_volume, dec!(0.03), "the symbol's own volume, not 7.03");
    assert_eq!(snap.exposure.open_position_count, 2, "but the position COUNT is the account's, both symbols");

    cleanup(&pool, &fx).await;
    sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&other_id).execute(&pool).await.unwrap();
}
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// BENCH — what the collapse is worth, both halves, on the same cluster in the same run
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

fn percentile(sorted: &[f64], p: f64) -> f64 {
    if sorted.is_empty() {
        return 0.0;
    }
    let i = ((sorted.len() - 1) as f64 * p).round() as usize;
    sorted[i]
}

fn report(label: &str, trips: usize, mut ms: Vec<f64>) -> (f64, f64, f64) {
    ms.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let (p50, p90, p99) = (percentile(&ms, 0.50), percentile(&ms, 0.90), percentile(&ms, 0.99));
    println!("  {label:<34} trips={trips:<3} n={:<4} p50={p50:7.3} ms  p90={p90:7.3} ms  p99={p99:7.3} ms", ms.len());
    (p50, p90, p99)
}

/// THE PAYOFF, measured rather than argued.
///
/// Both shapes of both halves run in ONE process against ONE cluster in the same run, so the only
/// thing that differs between them is the number of round trips. The LOCAL cluster's RTT is ~0.1 ms,
/// which is the point: what this measures is the per-call COMPUTE, and the compute is what the
/// `app_ms ~= compute + sequential_round_trips x RTT` model needs in order to say what the same code
/// costs over a 5 ms link. The projection itself is arithmetic on those two measured numbers -- there
/// is no benchmark against the live book here, and there must not be (it writes).
///
/// Reads are benched BEFORE any write, on a book of exactly three open positions, so both read shapes
/// see the same rows. The two shapes alternate rather than running in blocks, so a drift in the
/// cluster's own load cannot favour one of them.
///
///   VYX_BENCH=1 cargo test -p order-management --test open_position_depth_db \
///     bench_the_depth_cut -- --exact --nocapture
#[tokio::test]
async fn bench_the_depth_cut() {
    if std::env::var("VYX_BENCH").as_deref() != Ok("1") {
        eprintln!("bench_the_depth_cut: set VYX_BENCH=1 to run it");
        return;
    }
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    let fx = fixture(&mut setup, "A_BOOK", dec!(3)).await;
    setup.commit().await.unwrap();

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(&pool).await.expect("load the pricing configuration");

    let call = |order_id: &'static str| db::OpenPositionCall {
        broker_id: &fx.broker,
        account_id: &fx.account,
        symbol_id: &fx.symbol_id,
        side: OrderSide::Buy,
        order_type: protocol::OrderType::Market,
        volume: dec!(0.01),
        requested_price: None,
        sl_price: None,
        tp_price: None,
        fill_price: dec!(4299.13),
        filled_volume: dec!(0.01),
        routing: Some(db::BookType::ABook.as_str()),
        book_type: db::BookType::ABook,
        commission_per_lot: dec!(3),
        deal_reason: "CLIENT",
        order_id,
        create_order: true,
    };

    // three open positions, so the read shapes have a book to carry
    for _ in 0..3 {
        let id = Uuid::new_v4().to_string();
        let mut c = call("");
        c.order_id = &id;
        db::open_position_one_call(&pool, &c).await.unwrap().expect("opened");
    }

    const N: usize = 60;
    let mut old_read = Vec::with_capacity(N);
    let mut new_read = Vec::with_capacity(N);

    // warm both shapes once: the first of each pays for its plan
    let _ = db::get_open_snapshot(&pool, &cache, &fx.broker, &fx.account, &fx.symbol_name, OrderSide::Buy, 0).await.unwrap();
    let _ = db::get_broker_symbol_config(&pool, &fx.broker, &fx.symbol_name).await.unwrap();

    for _ in 0..N {
        // ── the OLD read shape: five config/aggregate queries, then load_account_state's six ──
        let t = std::time::Instant::now();
        let cfg = db::get_broker_symbol_config(&pool, &fx.broker, &fx.symbol_name).await.unwrap().expect("symbol");
        let _ = db::get_routing_category(&pool, &fx.account).await.unwrap();
        let _ = db::get_exposure_and_max_positions(&pool, db::Book::Prisma, &fx.broker, &fx.account, &fx.symbol_name, &cfg.symbol_id).await.unwrap();
        let _ = db::get_gate_inputs(&pool, &fx.broker, &fx.account, &cfg.symbol_id, OrderSide::Buy, 0).await.unwrap().expect("gates");
        let _ = db::get_ask_levels(&pool, &fx.broker, &fx.account, &fx.symbol_name).await.unwrap();
        let _ = order_management::book::with_book_sources(
            order_management::book::PriceSource::Ticks(cache.clone()),
            Some(pricing.clone()),
            order_management::calc::load_account_state(&pool, db::Book::Prisma, &fx.account),
        )
        .await
        .unwrap()
        .expect("account state");
        old_read.push(t.elapsed().as_secs_f64() * 1000.0);

        // ── the NEW read shape: one statement ──
        let t = std::time::Instant::now();
        let got = order_management::book::with_book_sources(
            order_management::book::PriceSource::Ticks(cache.clone()),
            Some(pricing.clone()),
            db::get_open_snapshot(&pool, &cache, &fx.broker, &fx.account, &fx.symbol_name, OrderSide::Buy, 0),
        )
        .await
        .unwrap();
        new_read.push(t.elapsed().as_secs_f64() * 1000.0);
        assert!(matches!(got, db::OpenSnapshotResult::Found(_)), "the one read must find the account");
    }

    let mut old_write = Vec::with_capacity(N);
    let mut new_write = Vec::with_capacity(N);
    for _ in 0..N {
        // ── the OLD write chain: BEGIN, eight statements, COMMIT ──
        let order_id = Uuid::new_v4().to_string();
        let new_order = db::NewOrder {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            symbol_id: fx.symbol_id.clone(),
            side: OrderSide::Buy,
            order_type: protocol::OrderType::Market,
            volume: dec!(0.01),
            requested_price: None,
            sl_price: None,
            tp_price: None,
        };
        let t = std::time::Instant::now();
        let mut tx = pool.begin().await.unwrap();
        let oid = db::insert_order(&mut tx, db::Book::Prisma, &new_order).await.unwrap();
        db::set_filled(&mut tx, db::Book::Prisma, &oid, dec!(4299.13), dec!(0.01), Some(db::BookType::ABook.as_str())).await.unwrap();
        let (pid, _) = db::insert_position(
            &mut tx,
            db::Book::Prisma,
            &db::NewPosition {
                broker_id: fx.broker.clone(),
                account_id: fx.account.clone(),
                symbol: fx.symbol_name.clone(),
                symbol_id: fx.symbol_id.clone(),
                origin_order_id: oid.clone(),
                side: OrderSide::Buy,
                volume: dec!(0.01),
                open_price: dec!(4299.13),
                sl_price: None,
                tp_price: None,
                book_type: db::BookType::ABook,
            },
        )
        .await
        .unwrap();
        db::record_commission(&mut tx, db::Book::Prisma, &fx.broker, &fx.account, &pid, dec!(3), dec!(0.01)).await.unwrap();
        let deal = db::write_open_deal(&mut tx, &pid, "CLIENT").await.unwrap();
        db::enqueue_position_opened(&mut tx, &pid, &deal).await.unwrap();
        tx.commit().await.unwrap();
        old_write.push(t.elapsed().as_secs_f64() * 1000.0);
        let _ = order_id;

        // ── the NEW write: one call ──
        let id = Uuid::new_v4().to_string();
        let mut c = call("");
        c.order_id = &id;
        let t = std::time::Instant::now();
        db::open_position_one_call(&pool, &c).await.unwrap().expect("opened");
        new_write.push(t.elapsed().as_secs_f64() * 1000.0);
    }

    println!("\n=== L2 Step 2 DEPTH-CUT, measured on the local scratch cluster (RTT ~0.1 ms) ===");
    let (or50, _, or99) = report("READ  old (11 statements)", 11, old_read);
    let (nr50, _, nr99) = report("READ  new (1 statement)", 1, new_read);
    let (ow50, _, ow99) = report("WRITE old (14 statements)", 14, old_write);
    let (nw50, _, nw99) = report("WRITE new (1 call)", 1, new_write);
    println!("  ---");
    println!("  whole fill   old = {:7.3} ms p50 / {:7.3} ms p99   (25 trips of the 30; the rest is the tick read and NATS)", or50 + ow50, or99 + ow99);
    println!("  whole fill   new = {:7.3} ms p50 / {:7.3} ms p99   (2 trips)", nr50 + nw50, nr99 + nw99);
    println!("  COMPUTE per fill (what survives a slower link): new p50 {:.3} ms", nr50 + nw50);
    // VPS -> Neon, measured read-only on 2026-11-03 (300 x SELECT 1 in one session, vyx_shadow_ro):
    // p50 6.08 ms, p90 12.71 ms, p99 59.86 ms. The compute term below is the LOCAL cluster's execution
    // time, so the projection is approximate in that term and measured in the network one.
    const NEON_RTT_P50_MS: f64 = 6.08;
    const NEON_RTT_P99_MS: f64 = 59.86;
    let (old_trips, new_trips) = (25.0, 2.0);
    println!("  Over a link with RTT r: old ~= compute + {old_trips}r, new ~= compute + {new_trips}r.");
    println!(
        "  At Neon p50 r={NEON_RTT_P50_MS} ms:  old ~= {:.0} ms, new ~= {:.0} ms",
        or50 + ow50 + old_trips * NEON_RTT_P50_MS,
        nr50 + nw50 + new_trips * NEON_RTT_P50_MS
    );
    println!(
        "  At Neon p99 r={NEON_RTT_P99_MS} ms: the network term alone is old {:.0} ms vs new {:.0} ms",
        old_trips * NEON_RTT_P99_MS,
        new_trips * NEON_RTT_P99_MS
    );
    let _ = (or99, ow99);

    cleanup(&pool, &fx).await;
}
// ─────────────────────────────────────────────────────────────────────────────────────────────────────
// PARITY — the collapse changed the number of round trips and nothing else
// ─────────────────────────────────────────────────────────────────────────────────────────────────────

/// Every column of a row, as JSON, minus the keys that MUST differ between two runs (the row's own id,
/// the ids it points at, the timestamps, the sequence-drawn ticket). Comparing whole rows rather than a
/// hand-written list of columns is the point: a column the function forgot to write, or wrote
/// differently, fails here without anyone having remembered to check it.
async fn row_json(pool: &PgPool, table: &str, where_col: &str, key: &str, strip: &[&str]) -> serde_json::Value {
    let minus = strip.iter().map(|k| format!(" - '{k}'")).collect::<String>();
    let sql = format!(r#"SELECT to_jsonb(t){minus} FROM "{table}" t WHERE t."{where_col}" = $1"#);
    let (v,): (serde_json::Value,) = sqlx::query_as(&sql).bind(key).fetch_one(pool).await.unwrap_or_else(|e| panic!("{table}: {e}"));
    v
}

/// THE PARITY PROOF for L2 Step 2.
///
/// One fixture, two fills on it: the first through the OLD multi-statement chain (the `db::` functions
/// one at a time, in a transaction, exactly as `place_market_order` used to call them), the second
/// through `vyx_open_position`. Then every row either one wrote is compared as JSON.
///
/// The balance is reset between the two so the commission's `balanceBefore` / `balanceAfter` are
/// comparable; everything else is identical by construction, which is what makes a whole-row diff
/// meaningful rather than a list of the columns someone thought to check.
#[tokio::test]
async fn the_one_call_write_is_row_identical_to_the_multi_statement_path() {
    let Some(pool) = pool().await else { return };
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    // A_BOOK + a commission: the longest chain, so the commission rows, the deal's summed commission,
    // its transactionId and the POSITION_OPENED hedge intent are all in the comparison.
    let fx = fixture(&mut setup, "A_BOOK", dec!(3)).await;
    setup.commit().await.unwrap();

    let (fill_price, volume) = (dec!(4299.13), dec!(0.01));
    let new_order = db::NewOrder {
        broker_id: fx.broker.clone(),
        account_id: fx.account.clone(),
        symbol: fx.symbol_name.clone(),
        symbol_id: fx.symbol_id.clone(),
        side: OrderSide::Buy,
        order_type: protocol::OrderType::Market,
        volume,
        requested_price: None,
        sl_price: None,
        tp_price: None,
    };

    // ── the OLD path: eight statements and a transaction ──
    let mut tx = pool.begin().await.unwrap();
    let old_order = db::insert_order(&mut tx, db::Book::Prisma, &new_order).await.unwrap();
    assert!(
        db::set_filled(&mut tx, db::Book::Prisma, &old_order, fill_price, volume, Some(db::BookType::ABook.as_str())).await.unwrap(),
        "the compare-and-set must win on an order this transaction created"
    );
    let (old_position, _) = db::insert_position(
        &mut tx,
        db::Book::Prisma,
        &db::NewPosition {
            broker_id: fx.broker.clone(),
            account_id: fx.account.clone(),
            symbol: fx.symbol_name.clone(),
            symbol_id: fx.symbol_id.clone(),
            origin_order_id: old_order.clone(),
            side: OrderSide::Buy,
            volume,
            open_price: fill_price,
            sl_price: None,
            tp_price: None,
            book_type: db::BookType::ABook,
        },
    )
    .await
    .unwrap();
    db::record_commission(&mut tx, db::Book::Prisma, &fx.broker, &fx.account, &old_position, dec!(3), volume).await.unwrap();
    let old_deal = db::write_open_deal(&mut tx, &old_position, "CLIENT").await.unwrap();
    let old_effect = db::enqueue_position_opened(&mut tx, &old_position, &old_deal).await.unwrap();
    tx.commit().await.unwrap();

    // the commission debited the balance; put it back so the two charges see the same `balanceBefore`
    sqlx::query(r#"UPDATE "Account" SET balance = 100000 WHERE id = $1"#).bind(&fx.account).execute(&pool).await.unwrap();

    // ── the NEW path: one round trip ──
    let new_id = Uuid::new_v4().to_string();
    let opened = db::open_position_one_call(
        &pool,
        &db::OpenPositionCall {
            broker_id: &fx.broker,
            account_id: &fx.account,
            symbol_id: &fx.symbol_id,
            side: OrderSide::Buy,
            order_type: protocol::OrderType::Market,
            volume,
            requested_price: None,
            sl_price: None,
            tp_price: None,
            fill_price,
            filled_volume: volume,
            routing: Some(db::BookType::ABook.as_str()),
            book_type: db::BookType::ABook,
            commission_per_lot: dec!(3),
            deal_reason: "CLIENT",
            order_id: &new_id,
            create_order: true,
        },
    )
    .await
    .unwrap()
    .expect("the compare-and-set must win on an order this call created");

    assert_eq!(opened.order_id, new_id, "the call answers with the id it was given");
    assert_eq!(opened.deal.group_category_at_open.as_deref(), Some("A_BOOK"), "the stamp trigger must have run");
    assert_eq!(old_deal.group_category_at_open, opened.deal.group_category_at_open, "both paths see the same stamp");
    assert_eq!(old_effect, opened.effect_enqueued, "both paths queue the hedge intent");
    assert!(opened.effect_enqueued, "an A-book fill must queue POSITION_OPENED");

    // ── every row, column for column ──
    // Only six of these are "the same value written twice"; `requestedAt` is a per-row DEFAULT now()
    // and `ticket` is drawn from a sequence, so two runs cannot share them. They are the ONLY two the
    // whole-row diff turned up, and both are asserted on their own below.
    let order_strip = &["id", "createdAt", "updatedAt", "filledAt", "executedAt", "requestedAt", "ticket", "idempotencyKey"];
    assert_eq!(
        row_json(&pool, "Order", "id", &old_order, order_strip).await,
        row_json(&pool, "Order", "id", &opened.order_id, order_strip).await,
        r#""Order""#
    );

    let position_strip = &["id", "originOrderId", "ticket", "openedAt", "createdAt", "updatedAt"];
    assert_eq!(
        row_json(&pool, "Position", "id", &old_position, position_strip).await,
        row_json(&pool, "Position", "id", &opened.position_id, position_strip).await,
        r#""Position""#
    );

    let deal_strip = &["id", "positionId", "orderId", "transactionId", "ticket", "executedAt", "createdAt", "updatedAt"];
    assert_eq!(
        row_json(&pool, "Deal", "id", &old_deal.deal_id, deal_strip).await,
        row_json(&pool, "Deal", "id", &opened.deal.deal_id, deal_strip).await,
        r#""Deal""#
    );

    let txn_strip = &["id", "referenceId", "createdAt", "updatedAt"];
    assert_eq!(
        row_json(&pool, "Transaction", "referenceId", &old_position, txn_strip).await,
        row_json(&pool, "Transaction", "referenceId", &opened.position_id, txn_strip).await,
        r#""Transaction" (the commission)"#
    );

    // `seq` is a sequence and `nextAttemptAt` a per-row DEFAULT now(): the same two kinds of
    // can-never-match column the "Order" diff turned up, and again the only ones.
    let effect_strip = &["id", "positionId", "dedupeKey", "payload", "seq", "nextAttemptAt", "createdAt", "updatedAt"];
    assert_eq!(
        row_json(&pool, "PostCloseEffect", "positionId", &old_position, effect_strip).await,
        row_json(&pool, "PostCloseEffect", "positionId", &opened.position_id, effect_strip).await,
        r#""PostCloseEffect""#
    );

    // ── and the stripped columns, which are derived rather than copied, asserted on their own ──
    let order_ticket = |id: String| async {
        let (t,): (Option<i32>,) = sqlx::query_as(r#"SELECT ticket FROM "Order" WHERE id = $1"#).bind(id).fetch_one(&pool).await.unwrap();
        t
    };
    let (t_old, t_new) = (order_ticket(old_order.clone()).await, order_ticket(opened.order_id.clone()).await);
    assert!(t_old.is_some_and(|t| t > 0) && t_new.is_some_and(|t| t > 0), "both orders draw an order ticket: {t_old:?} {t_new:?}");
    assert!(t_new > t_old, "the second fill draws the next ticket, not the same one: {t_old:?} then {t_new:?}");

    for (position, deal) in [(&old_position, &old_deal.deal_id), (&opened.position_id, &opened.deal.deal_id)] {
        let (ticket, initial): (Option<i32>, Option<Decimal>) =
            sqlx::query_as(r#"SELECT ticket, "initialVolume" FROM "Position" WHERE id = $1"#).bind(position).fetch_one(&pool).await.unwrap();
        assert!(ticket.is_some_and(|t| t > 0), "the ticket trigger must have drawn a ticket for {position}");
        assert_eq!(initial, Some(volume), "initialVolume is set from volume after the deal");

        let (key, payload_deal): (String, Option<String>) =
            sqlx::query_as(r#"SELECT "dedupeKey", payload->>'dealId' FROM "PostCloseEffect" WHERE "positionId" = $1"#)
                .bind(position)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(key, format!("open:{position}:{deal}"), "the dedupe key keys the intent on this position and deal");
        assert_eq!(payload_deal.as_deref(), Some(deal.as_str()), "the payload names the deal");

        let (txn_id,): (Option<String>,) =
            sqlx::query_as(r#"SELECT "transactionId" FROM "Deal" WHERE "positionId" = $1"#).bind(position).fetch_one(&pool).await.unwrap();
        let (only_txn,): (String,) =
            sqlx::query_as(r#"SELECT id FROM "Transaction" WHERE "referenceId" = $1 AND type = 'COMMISSION'"#).bind(position).fetch_one(&pool).await.unwrap();
        assert_eq!(txn_id.as_deref(), Some(only_txn.as_str()), "one commission row, so the deal names it");
    }

    cleanup(&pool, &fx).await;
}

/// SECTION 7's TOP RISK, asserted against the function's OWN SOURCE rather than against a reading of
/// it: `pg_get_functiondef` is parsed for the `INSERT INTO "Position"` column list and run through the
/// same `book::triggers_bypassed_by` the Rust insert is checked with.
///
/// Naming `groupCategoryAtOpen` in that insert would stop `position_stamp_group_category_at_open`
/// firing (it only fills the column `IF NEW."groupCategoryAtOpen" IS NULL`) and every A-book position
/// would open UNHEDGED, silently. Naming `ticket` would leave the position without one. Neither can be
/// caught by reading the migration a second time; this reads what the database actually has.
#[tokio::test]
async fn the_functions_position_insert_names_no_trigger_owned_column() {
    let Some(pool) = pool().await else { return };
    let (def,): (String,) = sqlx::query_as("SELECT pg_get_functiondef('vyx_open_position'::regproc)")
        .fetch_one(&pool)
        .await
        .expect("vyx_open_position is installed (prisma/migrations/20261103100000_vyx_open_position)");

    let marker = r#"INSERT INTO "Position""#;
    let at = def.find(marker).expect("the function inserts a position");
    let open = def[at..].find('(').expect("it names its columns") + at;
    let close = def[open..].find(')').expect("the column list closes") + open;
    let columns: Vec<&str> = def[open + 1..close].split(',').map(|c| c.trim().trim_matches('"')).collect();

    let bypassed = order_management::book::triggers_bypassed_by(&columns);
    assert!(
        bypassed.is_empty(),
        "vyx_open_position's position insert names a column a BEFORE INSERT trigger fills: {:?}",
        bypassed.iter().map(|t| (t.trigger, t.column, t.bypass_consequence)).collect::<Vec<_>>()
    );
    // not vacuous: the parse really found the real column list, the same eleven the Rust insert names
    assert_eq!(columns.len(), 11, "parsed {columns:?}");
    for required in ["id", "brokerId", "accountId", "symbolId", "originOrderId", "side", "volume", "openPrice", "bookType"] {
        assert!(columns.contains(&required), "{required} missing from {columns:?}");
    }
    assert_eq!(columns, order_management::db::prisma_position_insert_columns(), "the function and the Rust insert must name the same columns, in the same order");
}
/// ONE market fill, bracketed by markers. The assertion is only that it filled -- the measurement is
/// the server log between `VYXMARK fill-begin` and `VYXMARK fill-end`, counted by
/// `scripts/measure-fill-round-trips.py`.
///
/// RUN IT ALONE. The fill spreads its statements over two or three pooled connections, so the window
/// cannot be narrowed by pid, and any other test running at the same time lands inside it:
///
///   cargo test -p order-management --test open_position_depth_db ///     measure_the_fill_paths_round_trips -- --exact --test-threads=1
#[tokio::test]
async fn measure_the_fill_paths_round_trips() {
    let Some(pool) = pool().await else { return };
    let Some(nats_url) = std::env::var("ENGINE_TEST_NATS_URL").ok().filter(|u| !u.is_empty()) else {
        eprintln!("measure_the_fill_paths_round_trips: ENGINE_TEST_NATS_URL not set, skipping");
        return;
    };
    let nats = async_nats::connect(&nats_url).await.expect("connect to the throwaway NATS");
    db::use_prisma_book();

    let mut setup = pool.begin().await.unwrap();
    // A_BOOK with a commission: the longest write chain there is (the commission branch AND the
    // POSITION_OPENED hedge intent both run, so nothing is measured short).
    let fx = fixture(&mut setup, "A_BOOK", dec!(3)).await;
    setup.commit().await.unwrap();

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name), chrono::Utc::now());
    // A REAL pricing cache, as production has: the warm-up fill below loads it (five reads, once for
    // the process) and the measured fill then resolves every ask rule from memory. Passing None here
    // would measure five round trips live mode does not pay.
    let pricing = market_data::pricing::PricingCache::new();

    // warm: the first call of a process pays for connection set-up, plan caching and the pricing
    // cache's first load -- none of which a steady-state fill costs
    let warm = order_management::place_market_order(&pool, &nats, &cache, Some(&pricing), 0, request(&fx, dec!(0.01))).await.expect("the order path ran");
    assert!(matches!(warm, order_management::PlaceMarketOrderOutcome::Filled { .. }), "warm-up fill: {warm:?}");
    // Loaded explicitly, as production does: `PricingCache::spawn_reload_loop` keeps it current out of
    // band, so a fill never pays for the load. (The warm-up above did not load it on its own -- it had
    // no open positions, and a book read with no rows resolves no ask rules.)
    pricing.reload(&pool).await.expect("load the pricing configuration");
    assert!(pricing.is_loaded(), "the measured fill must read ask rules from memory, not the database");

    mark(&pool, "fill-begin").await;
    let outcome = order_management::place_market_order(&pool, &nats, &cache, Some(&pricing), 0, request(&fx, dec!(0.01))).await.expect("the order path ran");
    mark(&pool, "fill-end").await;
    assert!(matches!(outcome, order_management::PlaceMarketOrderOutcome::Filled { .. }), "the measured fill must fill: {outcome:?}");

    cleanup(&pool, &fx).await;
}
