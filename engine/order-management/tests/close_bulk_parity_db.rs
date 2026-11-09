//! BINARY-LEVEL parity for the bulk close: the REAL `order_management::close_positions_bulk`, run against
//! a real Postgres, once with `ENGINE_CLOSE_ONE_CALL` unset (loops `close_position`, today's behaviour)
//! and once with it set to 1 (one `vyx_close_positions` set call).
//!
//!   ENGINE_TEST_DATABASE_URL=... VYX_REQUIRE_DB_TESTS=1 cargo test --test close_bulk_parity_db -- --nocapture
//!   (once without the flag, once with ENGINE_CLOSE_ONE_CALL=1, then diff the two outputs)
//!
//! THE BASKET IS BUILT TO WALK EVERY BRANCH IN ONE GO: balance 100, credit 50, negative-balance
//! protection ON, twenty positions each losing 10.
//!   closes  1-10  plain, balance 100 -> 0
//!   closes 11-15  raw below zero with credit left -> CREDIT consumed, 10 at a time, 50 in total
//!   closes 16-19  below zero, credit gone, other positions still OPEN -> NO write-off
//!   close  20     below zero, credit gone, the LAST open position -> write-off, balance 0
//! So the ordering semantics (the money chain, and "is this the last open position") are under test, not
//! just the arithmetic of a single close.
//!
//! Normalised away, because differing is correct: every uuid (both paths mint their own), "Deal".ticket
//! (a sequence), the dedupeKey (embeds the trade txn uuid) and every timestamp-derived payload key.

use rust_decimal::Decimal;
use rust_decimal_macros::dec;
use sqlx::PgPool;

async fn pool() -> Option<PgPool> {
    let url = match std::env::var("ENGINE_TEST_DATABASE_URL") {
        Ok(u) if !u.trim().is_empty() => u,
        _ => {
            if std::env::var("VYX_REQUIRE_DB_TESTS").as_deref() == Ok("1") {
                panic!("ENGINE_TEST_DATABASE_URL is required (VYX_REQUIRE_DB_TESTS=1)");
            }
            eprintln!("close_bulk_parity_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(url.contains("@127.0.0.1:") || url.contains("@localhost:"), "refusing a non-local test database");
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id(p: &str) -> String {
    format!("{p}_{}", uuid::Uuid::new_v4().simple())
}

struct Fx {
    account: String,
    symbol_name: String,
    positions: Vec<String>,
}

const N: usize = 20;

async fn fixture(pool: &PgPool) -> Fx {
    let broker = id("BB");
    let group = id("GB");
    let account = id("AB");
    let symbol_id = id("SB");
    let symbol_name = format!("Y{}", &uuid::Uuid::new_v4().simple().to_string()[..5]).to_uppercase();

    sqlx::query(r#"INSERT INTO "Broker" (id,name,subdomain,"negativeBalanceProtection","updatedAt") VALUES ($1,$1,$1,true,now())"#)
        .bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Group" (id,"brokerId",name,"marginCallLevel","stopOutLevel","updatedAt") VALUES ($1,$2,$1,100,50,now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Account" (id,"brokerId","groupId","accountNumber",email,"passwordHash","fullName","accountMode",balance,credit,leverage,"updatedAt")
                   VALUES ($1,$2,$3,$4,$4,'h','T','DEMO',100,50,100,now())"#)
        .bind(&account).bind(&broker).bind(&group).bind(&account).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Symbol" (id,name,"baseCurrency","quoteCurrency",digits,"contractSize",category,"updatedAt")
                   VALUES ($1,$2,'ZA','USD',2,1,'CRYPTO',now())"#)
        .bind(&symbol_id).bind(&symbol_name).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "BrokerSymbol" (id,"brokerId","symbolId","spreadMarkup","updatedAt") VALUES ($1,$2,$3,0,now())"#)
        .bind(id("BSB")).bind(&broker).bind(&symbol_id).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "LivePrice" (symbol,bid,ask,"updatedAt","tickAt") VALUES ($1,990,990,now(),now())"#)
        .bind(&symbol_name).execute(pool).await.unwrap();

    let mut positions = Vec::with_capacity(N);
    for _ in 0..N {
        let order = id("OOBK");
        let position = id("POSBK");
        sqlx::query(r#"INSERT INTO "Order" (id,"brokerId","accountId","symbolId",side,type,volume,status,"idempotencyKey","updatedAt")
                       VALUES ($1,$2,$3,$4,'BUY','MARKET',1,'FILLED',$1,now())"#)
            .bind(&order).bind(&broker).bind(&account).bind(&symbol_id).execute(pool).await.unwrap();
        sqlx::query(r#"INSERT INTO "Position" (id,"brokerId","accountId","symbolId","originOrderId",side,volume,"openPrice",status,swap,"openedAt")
                       VALUES ($1,$2,$3,$4,$5,'BUY',1,1000,'OPEN',0,now())"#)
            .bind(&position).bind(&broker).bind(&account).bind(&symbol_id).bind(&order)
            .execute(pool).await.unwrap();
        positions.push(position);
    }
    // returned rather than stashed in the environment: set_var is unsafe in the 2024 edition
    Fx { account, symbol_name, positions }
}

fn tick(symbol: &str) -> protocol::Tick {
    protocol::Tick {
        symbol: symbol.to_string(), bid: dec!(990), ask: dec!(990),
        t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None,
        bars: Vec::new(),
    }
}

/// Every row the basket wrote, with the by-nature-varying parts replaced. Position ids are per-run uuids,
/// so rows are keyed by the position's ORDINAL in the basket instead.
async fn dump(pool: &PgPool, fx: &Fx) -> String {
    let mut out = String::new();
    let ord: std::collections::HashMap<&str, usize> =
        fx.positions.iter().enumerate().map(|(i, p)| (p.as_str(), i + 1)).collect();

    let (bal, cred): (Decimal, Decimal) =
        sqlx::query_as(r#"SELECT balance, credit FROM "Account" WHERE id=$1"#)
            .bind(&fx.account).fetch_one(pool).await.unwrap();
    out.push_str(&format!("ACCOUNT balance={bal} credit={cred}\n"));

    for (i, pid) in fx.positions.iter().enumerate() {
        let p: (String, Option<Decimal>, Option<Decimal>, Option<Decimal>) = sqlx::query_as(
            r#"SELECT status::text, "closePrice", "realizedPnl", "closedVolume" FROM "Position" WHERE id=$1"#,
        ).bind(pid).fetch_one(pool).await.unwrap();
        out.push_str(&format!("POSITION[{:02}] status={} closePrice={:?} realizedPnl={:?} closedVolume={:?}\n",
            i + 1, p.0, p.1, p.2, p.3));
    }

    let txns: Vec<(String, String, Decimal, Decimal, Decimal, Option<String>, Option<String>)> = sqlx::query_as(
        r#"SELECT "referenceId", type::text, amount, "balanceBefore", "balanceAfter", note, "idempotencyKey"
             FROM "Transaction" WHERE "accountId"=$1 ORDER BY "balanceBefore" DESC, type::text"#,
    ).bind(&fx.account).fetch_all(pool).await.unwrap();
    // sorted HERE, not by SQL: balanceBefore ties across many rows in this basket, so a SQL ORDER BY
    // leaves the order unspecified and the two runs legitimately emit the same rows in a different
    // sequence. Sorting the rendered lines makes the comparison about content, which is the point.
    let mut tl: Vec<String> = txns.iter().map(|t| {
        let o = ord.get(t.0.as_str()).copied().unwrap_or(0);
        format!("TXN[{:02}] type={} amount={} before={} after={} note={:?} idem={}",
            o, t.1, t.2, t.3, t.4, t.5,
            t.6.as_deref().map(|k| if k.contains(':') { "<prefix>:<pos>" } else { k }).unwrap_or("-"))
    }).collect();
    tl.sort();
    for l in tl { out.push_str(&l); out.push('\n'); }

    let deals: Vec<(String, String, String, String, Decimal, Decimal, Option<Decimal>, bool)> = sqlx::query_as(
        r#"SELECT "positionId", side::text, entry::text, reason::text, volume, price, profit, ticket > 0
             FROM "Deal" WHERE "accountId"=$1"#,
    ).bind(&fx.account).fetch_all(pool).await.unwrap();
    let mut dl: Vec<String> = deals.iter().map(|d| {
        let o = ord.get(d.0.as_str()).copied().unwrap_or(0);
        format!("DEAL[{:02}] side={} entry={} reason={} volume={} price={} profit={:?} ticketPositive={}",
            o, d.1, d.2, d.3, d.4, d.5, d.6, d.7)
    }).collect();
    dl.sort();
    for l in dl { out.push_str(&l); out.push('\n'); }

    let audits: Vec<(String, serde_json::Value)> = sqlx::query_as(
        r#"SELECT action, "newValue" FROM "AuditLog" WHERE "entityId"=$1"#,
    ).bind(&fx.account).fetch_all(pool).await.unwrap();
    let mut al: Vec<String> = audits.iter().map(|(action, v)| {
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            let pid = o.get("positionId").and_then(|x| x.as_str()).unwrap_or("").to_string();
            let n = ord.get(pid.as_str()).copied().unwrap_or(0);
            o.insert("positionId".into(), serde_json::Value::String(format!("<pos {n:02}>")));
        }
        format!("AUDIT action={action} newValue={v}")
    }).collect();
    al.sort();
    for l in al { out.push_str(&l); out.push('\n'); }

    let effects: Vec<(String, String, Option<String>, serde_json::Value)> = sqlx::query_as(
        r#"SELECT "positionId", kind, reason, payload FROM "PostCloseEffect" WHERE "accountId"=$1"#,
    ).bind(&fx.account).fetch_all(pool).await.unwrap();
    let mut el: Vec<String> = effects.iter().map(|(pid, kind, reason, payload)| {
        let o = ord.get(pid.as_str()).copied().unwrap_or(0);
        let mut p = payload.clone();
        if let Some(obj) = p.as_object_mut() {
            for k in ["dealId", "dealTicket", "closeWrittenAt", "closeEngineAt",
                      "triggerTickAt", "triggerTickEngineAt", "engineDelayMs"] {
                if obj.contains_key(k) { obj.insert(k.into(), serde_json::Value::String("<varies>".into())); }
            }
        }
        format!("EFFECT[{o:02}] kind={kind} reason={reason:?} payload={p}")
    }).collect();
    el.sort();
    for l in el { out.push_str(&l); out.push('\n'); }

    out
}

#[tokio::test]
async fn bulk_close_twenty_positions() {
    let Some(pool) = pool().await else { return };
    order_management::db::use_prisma_book();
    let fx = fixture(&pool).await;
    let symbol = fx.symbol_name.clone();

    let nats_url = std::env::var("ENGINE_TEST_NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let nats = async_nats::connect(&nats_url).await.expect("connect to NATS");

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&symbol), chrono::Utc::now());
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(&pool).await.unwrap();

    // (position_id, bid, ask) in basket order -- the order IS the settle order
    let items: Vec<(String, Decimal, Decimal)> =
        fx.positions.iter().map(|p| (p.clone(), dec!(990), dec!(990))).collect();

    let t0 = std::time::Instant::now();
    let results = order_management::close_positions_bulk(
        &pool, &nats, &fx.account, &items, Some("bulkprefix"), &cache, Some(&pricing),
    )
    .await
    .expect("the bulk close itself must not error");
    let elapsed = t0.elapsed();

    let flag = std::env::var("ENGINE_CLOSE_ONE_CALL").unwrap_or_else(|_| "unset".into());
    println!("===== SCENARIO BULK20 (ENGINE_CLOSE_ONE_CALL={flag}) =====");
    println!("RESULTS n={} closed={}", results.len(),
        results.iter().filter(|r| matches!(r.outcome, order_management::ClosePositionOutcome::Closed { .. })).count());
    print!("{}", dump(&pool, &fx).await);
    println!("===== END BULK20 =====");
    // outside the compared block on purpose: timing differs by design
    eprintln!("TIMING bulk20 ENGINE_CLOSE_ONE_CALL={flag} elapsed_ms={}", elapsed.as_millis());
}
