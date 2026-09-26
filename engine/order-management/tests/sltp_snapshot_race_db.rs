//! Stage 5 soak incident 2026-09-26 06:10:29 UTC (#100002473 / #100002472, BTCUSD SELL with an SL): the risk hook saw
//! the SL touched and called the web, which closed the position within ~1 s; the shadow sees SL / TP only in its
//! periodic pass, so it never decided anything -> WEB_ONLY -> soak clock reset. The owner's rule for the fix: "no wait
//! on the live path, ever". So the risk hook hands the shadow a SNAPSHOT (position, account, the tick that crossed) and
//! calls the web at once; the shadow evaluates the account AS IT STOOD AT THE TOUCH (book::Pin), after the web has
//! already closed the position.
//!
//! Real RiskHook + real snapshot evaluation + real Reconciler on the real schema; a mock web route that closes the
//! position in the database THE MOMENT it is called (status, price, P&L, the balance, the TRADE_PNL row). The shadow is
//! deliberately evaluated only AFTER the web's close (the slowest possible shadow) and the web call is proven not to
//! wait for it (the snapshot is still unread in its channel when the web has already been called and has closed).
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test sltp_snapshot_race_db

use market_data::cache::TickCache;
use market_data::risk_hook::{RiskHook, SlTpTouch};
use order_management::monitor::{evaluate_snapshot, Mode};
use order_management::reconcile::Reconciler;
use order_management::shadow::Recorder;
use protocol::Tick;
use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use uuid::Uuid;

fn url() -> Option<String> {
    match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.is_empty() => {
            assert!(u.contains("@127.0.0.1:") || u.contains("@localhost:"), "refusing a non-local test database: {u}");
            Some(u)
        }
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("sltp_snapshot_race_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

#[derive(Clone)]
struct Pos {
    side: &'static str,
    open: Decimal,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
}

struct Scenario {
    name: &'static str,
    /// the touched position
    touched: Pos,
    /// another open position of the same account on the same symbol that this tick does NOT touch (partial case)
    other: Option<Pos>,
    bid: Decimal,
    ask: Decimal,
    /// what the web books for the touched position: its note and close price (BUY at the bid, SELL at the ask)
    note: &'static str,
    close: Decimal,
}

struct World {
    pool: PgPool,
    broker: String,
    account: String,
    symbol: String,
    symbol_name: String,
    touched: String,
    other: Option<String>,
}

const BALANCE: Decimal = dec!(100000);

async fn position(pool: &PgPool, tag: &str, n: &str, broker: &str, account: &str, symbol: &str, p: &Pos) -> String {
    let (order, position) = (format!("snap-o-{tag}-{n}"), format!("snap-p-{tag}-{n}"));
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', 1, 'FILLED', $1, now())"#,
    )
    .bind(&order).bind(broker).bind(account).bind(symbol).bind(p.side).execute(pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", "tpPrice", ticket, "openedAt")
           VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", 1, $7, $8, $9, $10, now() - interval '70 seconds')"#,
    )
    .bind(&position).bind(broker).bind(account).bind(symbol).bind(&order).bind(p.side).bind(p.open).bind(p.sl).bind(p.tp).bind(ticket)
    .execute(pool).await.unwrap();
    position
}

async fn world(pool: &PgPool, sc: &Scenario) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("snap-{tag}"), format!("snap-g-{tag}"), format!("snap-a-{tag}"), format!("snap-s-{tag}"));
    let symbol_name = format!("ZS{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Snapshot Test', 'LIVE', $6, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("5{}", &tag[..7])).bind(format!("snap-{tag}@test.local")).bind(BALANCE)
    .execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZS', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(format!("snap-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    let touched = position(pool, &tag, "t", &broker, &account, &symbol, &sc.touched).await;
    let other = match &sc.other {
        Some(p) => Some(position(pool, &tag, "o", &broker, &account, &symbol, p).await),
        None => None,
    };
    World { pool: pool.clone(), broker, account, symbol, symbol_name, touched, other }
}

impl World {
    async fn cleanup(&self) {
        for sql in [
            r#"DELETE FROM "Transaction" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Position" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Order" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Account" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "BrokerSymbol" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Group" WHERE "brokerId" = $1"#,
            r#"DELETE FROM "Broker" WHERE id = $1"#,
        ] {
            let _ = sqlx::query(sql).bind(&self.broker).execute(&self.pool).await;
        }
        let _ = sqlx::query(r#"DELETE FROM "Symbol" WHERE id = $1"#).bind(&self.symbol).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_decision WHERE account_id = $1").bind(&self.account).execute(&self.pool).await;
        let _ = sqlx::query("DELETE FROM shadow_pair WHERE account_id = $1").bind(&self.account).execute(&self.pool).await;
    }
}

/// The web, as the risk hook meets it: on the ?symbols= call, book the automatic close AT ONCE, exactly the rows the web
/// writes (lib/position-close.ts: position CLOSED with price and P&L, the balance moved under a lock, a TRADE_PNL row
/// with balanceBefore / After), then answer 200. Reports (request line) when the close has committed.
async fn web_that_closes(pool: PgPool, position: String, account: String, broker: String, note: &'static str, close: Decimal, pnl: Decimal) -> (String, tokio::sync::mpsc::UnboundedReceiver<String>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}/api/internal/margin-monitor", listener.local_addr().unwrap());
    let (tx, rx) = tokio::sync::mpsc::unbounded_channel();
    tokio::spawn(async move {
        let Ok((mut sock, _)) = listener.accept().await else { return };
        let mut buf = vec![0u8; 4096];
        let n = sock.read(&mut buf).await.unwrap_or(0);
        let line = String::from_utf8_lossy(&buf[..n]).lines().next().unwrap_or("").to_string();
        let mut t = pool.begin().await.unwrap();
        sqlx::query(r#"UPDATE "Position" SET status = 'CLOSED', "closePrice" = $2, "realizedPnl" = $3, "closedAt" = now() WHERE id = $1 AND status = 'OPEN'"#)
            .bind(&position).bind(close).bind(pnl).execute(&mut *t).await.unwrap();
        let (before,): (Decimal,) = sqlx::query_as(r#"SELECT balance FROM "Account" WHERE id = $1 FOR UPDATE"#).bind(&account).fetch_one(&mut *t).await.unwrap();
        sqlx::query(r#"UPDATE "Account" SET balance = $2 WHERE id = $1"#).bind(&account).bind(before + pnl).execute(&mut *t).await.unwrap();
        sqlx::query(
            r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, $5, $6, 'Position', $7, $8, now())"#,
        )
        .bind(format!("snap-t-{position}")).bind(&broker).bind(&account).bind(pnl).bind(before).bind(before + pnl).bind(&position).bind(note)
        .execute(&mut *t).await.unwrap();
        t.commit().await.unwrap();
        let body = "{}";
        let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        let _ = tx.send(line);
    });
    (url, rx)
}

type Outcome = (String, Option<(String, Option<Decimal>, Option<Decimal>, Option<Decimal>)>, Option<String>);

/// One scenario: (the touched position's pair class, its shadow decision (kind, close price, P&L), any decision on the
/// other position).
async fn run(pool: &PgPool, url: &str, sc: &Scenario, with_snapshot: bool) -> Outcome {
    let w = world(pool, sc).await;
    let pnl = if sc.touched.side == "BUY" { sc.close - sc.touched.open } else { sc.touched.open - sc.close };
    let (route, mut called) = web_that_closes(pool.clone(), w.touched.clone(), w.account.clone(), w.broker.clone(), sc.note, sc.close, pnl).await;

    let recorder = Arc::new(Recorder::connect(url).await.expect("local store"));
    let cache = Arc::new(TickCache::new());
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": sc.bid, "ask": sc.ask })).unwrap();
    cache.set(&tick, chrono::Utc::now());

    std::env::set_var("VYX_RISK_HOOK_URL", &route);
    std::env::set_var("VYX_RISK_HOOK_SECRET", "s3cret");
    let hook = RiskHook::from_env().expect("hook");
    hook.reload(pool).await; // the level is watched (the position has been open for 70 s)
    let (tx, mut snapshots) = tokio::sync::mpsc::unbounded_channel::<Vec<SlTpTouch>>();
    hook.set_shadow_snapshot(tx); // the server's wiring; the channel is read below, AFTER the web has closed

    hook.after_flush(std::slice::from_ref(&tick), &cache);
    let line = tokio::time::timeout(Duration::from_secs(5), called.recv()).await.expect("the web was called and closed").unwrap();
    assert!(line.contains(&format!("symbols={}", w.symbol_name)), "{line}");
    // NO WAIT: the web was called and has booked its close while the snapshot still sits unread in the shadow's inbox
    let touches = snapshots.try_recv().expect("the snapshot was handed over (and is still unprocessed)");
    assert_eq!(touches.len(), 1, "{}: exactly the touched position", sc.name);
    assert_eq!(touches[0].position_id, w.touched);

    if with_snapshot {
        // the slowest possible shadow: it evaluates only now, the position already CLOSED and the balance moved
        let (status,): (String,) = sqlx::query_as(r#"SELECT status::text FROM "Position" WHERE id = $1"#).bind(&w.touched).fetch_one(pool).await.unwrap();
        assert_eq!(status, "CLOSED");
        order_management::book::with_price_source(
            order_management::book::PriceSource::Ticks(cache.clone()),
            evaluate_snapshot(pool, &Mode::Shadow(recorder.clone()), touches),
        )
        .await;
    }

    tokio::time::sleep(Duration::from_millis(50)).await;
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    reconciler.run_once().await.unwrap();
    let class: Option<(String,)> = sqlx::query_as("SELECT class FROM shadow_pair WHERE position_id = $1").bind(&w.touched).fetch_optional(pool).await.unwrap();
    let decision: Option<(String, Option<Decimal>, Option<Decimal>, Option<Decimal>)> = sqlx::query_as("SELECT kind, close_price, pnl, balance_after FROM shadow_decision WHERE position_id = $1 ORDER BY first_seen LIMIT 1")
        .bind(&w.touched).fetch_optional(pool).await.unwrap();
    let other_decision: Option<String> = match &w.other {
        Some(o) => sqlx::query_as::<_, (String,)>("SELECT kind FROM shadow_decision WHERE position_id = $1").bind(o).fetch_optional(pool).await.unwrap().map(|r| r.0),
        None => None,
    };
    w.cleanup().await;
    (class.map(|c| c.0).unwrap_or_else(|| "NONE".into()), decision, other_decision)
}

#[tokio::test]
async fn an_sl_or_tp_the_web_closes_within_ms_is_decided_by_the_shadow_from_its_snapshot() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    let _ = Recorder::connect(&url).await.expect("local store"); // creates the shadow tables
    // the reconciler reads web closes from its cursor: start it now (scratch tables only)
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_close_cursor%' OR key LIKE 'web_mc_cursor%'").execute(&pool).await.ok();

    let sell = |sl, tp| Pos { side: "SELL", open: dec!(83886.62), sl, tp };
    let incident = Scenario {
        name: "SELL SL (the 06:10 incident values)",
        touched: sell(Some(dec!(83906.20)), None),
        other: None,
        bid: dec!(83910.00),
        ask: dec!(83925.43),
        note: "Stop loss hit (automatic)",
        close: dec!(83925.43),
    };
    let sell_tp = Scenario { name: "SELL TP", touched: sell(None, Some(dec!(83850.00))), other: None, bid: dec!(83830.00), ask: dec!(83845.00), note: "Take profit hit (automatic)", close: dec!(83845.00) };
    let buy_sl = Scenario {
        name: "BUY SL",
        touched: Pos { side: "BUY", open: dec!(4300.00), sl: Some(dec!(4295.00)), tp: None },
        other: None,
        bid: dec!(4294.50),
        ask: dec!(4294.80),
        note: "Stop loss hit (automatic)",
        close: dec!(4294.50),
    };
    // two positions on the account, only one touched: the other (SL far away) must not be decided
    let partial = Scenario {
        name: "partial: two positions, one touched",
        touched: sell(Some(dec!(83906.20)), None),
        other: Some(Pos { side: "SELL", open: dec!(83800.00), sl: Some(dec!(84500.00)), tp: None }),
        bid: dec!(83910.00),
        ask: dec!(83925.43),
        note: "Stop loss hit (automatic)",
        close: dec!(83925.43),
    };

    // CONTROL first: without the snapshot evaluation the race reproduces the incident exactly
    let (control, control_decision, _) = run(&pool, &url, &incident, false).await;
    eprintln!("CONTROL (no snapshot evaluation) {}: {control} decision={control_decision:?}", incident.name);
    assert_eq!(control, "WEB_ONLY", "without the snapshot the web wins and the pair is WEB_ONLY (the incident)");
    assert!(control_decision.is_none());

    for sc in [&incident, &sell_tp, &buy_sl, &partial] {
        let (class, decision, other) = run(&pool, &url, sc, true).await;
        eprintln!("WITH snapshot {}: {class} decision={decision:?} other={other:?}", sc.name);
        assert_eq!(class, "MATCH", "{}: {class}", sc.name);
        let (kind, price, pnl, balance_after) = decision.unwrap_or_else(|| panic!("{}: the shadow recorded no decision", sc.name));
        assert_eq!(kind, if sc.note.starts_with("Stop loss") { "stop_loss" } else { "take_profit" }, "{}", sc.name);
        assert_eq!(price, Some(sc.close), "{}: the shadow's close price is the web's", sc.name);
        let web_pnl = if sc.touched.side == "BUY" { sc.close - sc.touched.open } else { sc.touched.open - sc.close };
        assert_eq!(pnl, Some(web_pnl), "{}: the shadow's P&L is the web's", sc.name);
        // the funds are pinned to BEFORE the web's close (else the P&L would count twice): the web's balance after
        assert_eq!(balance_after, Some(BALANCE + web_pnl), "{}: the shadow's balance after the close is the web's", sc.name);
        assert_eq!(other, None, "{}: an untouched position is not decided", sc.name);
    }
}

/// Gap 1 (2026-09-26): a just-set SL is watched when the web announces the change, not on the next 5 s poll.
#[tokio::test]
async fn a_new_sl_is_watched_as_soon_as_the_change_is_announced() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    let sc = Scenario { name: "reload", touched: Pos { side: "BUY", open: dec!(100), sl: None, tp: None }, other: None, bid: dec!(1), ask: dec!(1), note: "", close: dec!(1) };
    let w = world(&pool, &sc).await;
    let cache = Arc::new(TickCache::new());
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": "100", "ask": "100.1" })).unwrap();
    cache.set(&tick, chrono::Utc::now());
    std::env::set_var("VYX_RISK_HOOK_URL", "http://127.0.0.1:1/x");
    std::env::set_var("VYX_RISK_HOOK_SECRET", "s3cret");
    let hook = RiskHook::from_env().expect("hook");
    // the safety poll is 60 s here: only the announcement can make the new SL watched within the test
    hook.spawn_reload_loop(pool.clone(), Duration::from_secs(60), cache.clone());
    tokio::time::sleep(Duration::from_millis(300)).await; // the first load (no SL yet)
    assert!(!hook.watches(&w.touched), "no SL yet: not watched");

    // the trader sets an SL (the web writes it and announces position.modified)
    sqlx::query(r#"UPDATE "Position" SET "slPrice" = 95 WHERE id = $1"#).bind(&w.touched).execute(&pool).await.unwrap();
    tokio::time::sleep(Duration::from_millis(400)).await;
    assert!(!hook.watches(&w.touched), "CONTROL: without an announcement the SL waits for the poll");

    let (tx, rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    let h = hook.clone();
    market_data::book_events::spawn_debounced(rx, market_data::book_events::DEBOUNCE, Arc::new(move || h.request_reload()));
    let announced = std::time::Instant::now();
    tx.send("position.modified".into()).unwrap();
    let mut watched = false;
    while announced.elapsed() < Duration::from_secs(2) {
        if hook.watches(&w.touched) {
            watched = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let took = announced.elapsed();
    w.cleanup().await;
    eprintln!("new SL watched {took:?} after the announcement");
    assert!(watched, "the announcement made the new SL watched");
    assert!(took < Duration::from_millis(1000), "within the debounce + one reload, not the 5 s poll: {took:?}");
}
