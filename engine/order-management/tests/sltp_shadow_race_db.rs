//! Stage 5 soak incident 2026-09-26 06:10:29 UTC (#100002473 / #100002472, BTCUSD SELL with an SL): the risk hook saw
//! the SL touched and called the web, which closed the position within ~1 s; the shadow sees SL / TP only in its
//! periodic pass, so it never decided anything -> WEB_ONLY -> soak clock reset. This reproduces the race on the real
//! schema: a real RiskHook + the real shadow trigger + the real Reconciler, and a mock web route that closes the
//! position in the database THE MOMENT it is called (the way the web books an automatic SL / TP close). The shadow pass
//! does not run at all (as if it were 60 s away), so only the SL / TP handoff can give the shadow its decision.
//!
//!   ENGINE_TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test VYX_REQUIRE_DB_TESTS=1 \
//!   cargo test -p order-management --test sltp_shadow_race_db
//!
//! One test function, scenarios in sequence: they share the reconciler's cursor rows in shadow_state.

use market_data::cache::TickCache;
use market_data::risk_hook::RiskHook;
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
            eprintln!("sltp_shadow_race_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            None
        }
    }
}

struct Scenario {
    name: &'static str,
    side: &'static str,
    open: Decimal,
    sl: Option<Decimal>,
    tp: Option<Decimal>,
    bid: Decimal,
    ask: Decimal,
    /// what the web books: its note and the close price (a BUY at the bid, a SELL at the (raw here) ask)
    note: &'static str,
    close: Decimal,
}

struct World {
    pool: PgPool,
    broker: String,
    account: String,
    symbol: String,
    symbol_name: String,
    position: String,
}

async fn world(pool: &PgPool, sc: &Scenario) -> World {
    let tag = Uuid::new_v4().simple().to_string()[..10].to_string();
    let (broker, group, account, symbol) = (format!("race-{tag}"), format!("race-g-{tag}"), format!("race-a-{tag}"), format!("race-s-{tag}"));
    let symbol_name = format!("ZR{}", &tag[..6].to_uppercase());
    sqlx::query(r#"INSERT INTO "Broker" (id, name, subdomain, "updatedAt") VALUES ($1, $1, $1, now())"#).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id, "brokerId", name, "marginCallLevel", "stopOutLevel", "updatedAt") VALUES ($1, $2, $1, 100, 50, now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(
        r#"INSERT INTO "Account" (id, "brokerId", "groupId", "accountNumber", email, "passwordHash", "fullName", "accountMode", balance, leverage, "updatedAt")
           VALUES ($1, $2, $3, $4, $5, 'x', 'Race Test', 'LIVE', 100000, 100, now())"#,
    )
    .bind(&account).bind(&broker).bind(&group).bind(format!("6{}", &tag[..7])).bind(format!("race-{tag}@test.local"))
    .execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id, name, "baseCurrency", "quoteCurrency", digits, "contractSize", category, "updatedAt") VALUES ($1, $2, 'ZR', 'USD', 2, 1, 'CRYPTO', now())"#)
        .bind(&symbol).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id, "brokerId", "symbolId", "updatedAt") VALUES ($1, $2, $3, now())"#)
        .bind(format!("race-bs-{tag}")).bind(&broker).bind(&symbol).execute(pool).await.unwrap();
    let (order, position) = (format!("race-o-{tag}"), format!("race-p-{tag}"));
    sqlx::query(
        r#"INSERT INTO "Order" (id, "brokerId", "accountId", "symbolId", side, type, volume, status, "idempotencyKey", "updatedAt")
           VALUES ($1, $2, $3, $4, $5::"OrderSide", 'MARKET', 1, 'FILLED', $1, now())"#,
    )
    .bind(&order).bind(&broker).bind(&account).bind(&symbol).bind(sc.side).execute(pool).await.unwrap();
    let ticket: i32 = (u32::from_str_radix(&Uuid::new_v4().simple().to_string()[..7], 16).unwrap() % 2_000_000_000) as i32;
    sqlx::query(
        r#"INSERT INTO "Position" (id, "brokerId", "accountId", "symbolId", "originOrderId", side, volume, "openPrice", "slPrice", "tpPrice", ticket, "openedAt")
           VALUES ($1, $2, $3, $4, $5, $6::"OrderSide", 1, $7, $8, $9, $10, now() - interval '70 seconds')"#,
    )
    .bind(&position).bind(&broker).bind(&account).bind(&symbol).bind(&order).bind(sc.side).bind(sc.open).bind(sc.sl).bind(sc.tp).bind(ticket)
    .execute(pool).await.unwrap();
    World { pool: pool.clone(), broker, account, symbol, symbol_name, position }
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

/// The web, as the risk hook meets it: on the ?symbols= call, book the automatic close AT ONCE (status, price, P&L and
/// the TRADE_PNL row the reconciler reads), then answer 200. Reports the request line when done.
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
        sqlx::query(
            r#"INSERT INTO "Transaction" (id, "brokerId", "accountId", type, status, amount, "balanceBefore", "balanceAfter", "referenceType", "referenceId", note, "updatedAt")
               VALUES ($1, $2, $3, 'TRADE_PNL', 'COMPLETED', $4, 100000, 100000 + $4, 'Position', $5, $6, now())"#,
        )
        .bind(format!("race-t-{position}")).bind(&broker).bind(&account).bind(pnl).bind(&position).bind(note)
        .execute(&mut *t).await.unwrap();
        t.commit().await.unwrap();
        let body = "{}";
        let _ = sock.write_all(format!("HTTP/1.1 200 OK\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}", body.len()).as_bytes()).await;
        let _ = tx.send(line);
    });
    (url, rx)
}

/// One scenario: returns (the pair's class, the shadow's decision (kind, close price) if any).
async fn run(pool: &PgPool, url: &str, sc: &Scenario, with_handoff: bool) -> (String, Option<(String, Option<Decimal>)>) {
    let w = world(pool, sc).await;
    let pnl = if sc.side == "BUY" { sc.close - sc.open } else { sc.open - sc.close };
    let (route, mut called) = web_that_closes(pool.clone(), w.position.clone(), w.account.clone(), w.broker.clone(), sc.note, sc.close, pnl).await;

    let recorder = Arc::new(Recorder::connect(url).await.expect("local store"));
    let cache = Arc::new(TickCache::new());
    let tick: Tick = serde_json::from_value(serde_json::json!({ "symbol": w.symbol_name, "bid": sc.bid, "ask": sc.ask })).unwrap();
    cache.set(&tick, chrono::Utc::now());

    std::env::set_var("VYX_RISK_HOOK_URL", &route);
    std::env::set_var("VYX_RISK_HOOK_SECRET", "s3cret");
    let hook = RiskHook::from_env().expect("hook");
    hook.reload(pool).await; // the level is watched (the position has been open for 70 s)
    if with_handoff {
        // exactly the server's wiring (engine/server/src/main.rs)
        let (_inbox, handoff) = order_management::monitor::spawn_shadow_trigger_with_handoff(pool.clone(), recorder.clone(), order_management::book::PriceSource::Ticks(cache.clone()));
        hook.set_shadow_handoff(Arc::new(move |ids: Vec<String>| {
            let handoff = handoff.clone();
            Box::pin(async move {
                handoff.evaluate_now(ids, Duration::from_millis(300)).await;
            })
        }));
    }
    // no shadow pass at all: only the handoff can give the shadow its decision
    hook.after_flush(std::slice::from_ref(&tick), &cache);
    let line = tokio::time::timeout(Duration::from_secs(5), called.recv()).await.expect("the web was called").unwrap();
    assert!(line.contains(&format!("symbols={}", w.symbol_name)), "{line}");

    tokio::time::sleep(Duration::from_millis(50)).await;
    let reconciler = Reconciler::new(pool.clone(), recorder.clone()).await.expect("reconciler").with_timing(60, 0);
    reconciler.run_once().await.unwrap();
    let class: Option<(String,)> = sqlx::query_as("SELECT class FROM shadow_pair WHERE position_id = $1").bind(&w.position).fetch_optional(pool).await.unwrap();
    let decision: Option<(String, Option<Decimal>)> = sqlx::query_as("SELECT kind, close_price FROM shadow_decision WHERE position_id = $1 ORDER BY first_seen LIMIT 1")
        .bind(&w.position).fetch_optional(pool).await.unwrap();
    w.cleanup().await;
    (class.map(|c| c.0).unwrap_or_else(|| "NONE".into()), decision)
}

#[tokio::test]
async fn an_sl_or_tp_the_web_closes_within_ms_is_decided_by_the_shadow_first() {
    let Some(url) = url() else { return };
    let pool = PgPool::connect(&url).await.expect("scratch DB");
    // the reconciler reads web closes from its cursor: start it now (scratch tables only)
    sqlx::query("DELETE FROM shadow_state WHERE key LIKE 'web_close_cursor%' OR key LIKE 'web_mc_cursor%'").execute(&pool).await.ok();
    // make sure the tables exist (Recorder::connect creates them)
    let _ = Recorder::connect(&url).await.expect("local store");

    let incident = Scenario { name: "SELL SL (the 06:10 incident)", side: "SELL", open: dec!(83886.62), sl: Some(dec!(83906.20)), tp: None, bid: dec!(83910.00), ask: dec!(83925.43), note: "Stop loss hit (automatic)", close: dec!(83925.43) };
    let sell_tp = Scenario { name: "SELL TP", side: "SELL", open: dec!(83886.62), sl: None, tp: Some(dec!(83850.00)), bid: dec!(83830.00), ask: dec!(83845.00), note: "Take profit hit (automatic)", close: dec!(83845.00) };
    let buy_sl = Scenario { name: "BUY SL", side: "BUY", open: dec!(4300.00), sl: Some(dec!(4295.00)), tp: None, bid: dec!(4294.50), ask: dec!(4294.80), note: "Stop loss hit (automatic)", close: dec!(4294.50) };

    // CONTROL first: without the handoff the race reproduces the incident exactly
    let (control, control_decision) = run(&pool, &url, &incident, false).await;
    eprintln!("CONTROL (no handoff) {}: {control} decision={control_decision:?}", incident.name);
    assert_eq!(control, "WEB_ONLY", "without the handoff the web wins and the pair is WEB_ONLY (the incident)");
    assert!(control_decision.is_none());

    for sc in [&incident, &sell_tp, &buy_sl] {
        let (class, decision) = run(&pool, &url, sc, true).await;
        eprintln!("WITH handoff {}: {class} decision={decision:?}", sc.name);
        assert!(class == "MATCH" || class == "TIMING", "{}: {class}", sc.name);
        let (kind, price) = decision.unwrap_or_else(|| panic!("{}: the shadow recorded no decision", sc.name));
        assert_eq!(kind, if sc.note.starts_with("Stop loss") { "stop_loss" } else { "take_profit" }, "{}", sc.name);
        assert_eq!(price, Some(sc.close), "{}: the shadow's close price is the web's", sc.name);
    }
}
