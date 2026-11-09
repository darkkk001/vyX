//! BINARY-LEVEL parity for the one-call close: the REAL `order_management::close_position`, run against a
//! real Postgres, once with `ENGINE_CLOSE_ONE_CALL` unset (the nine-to-thirteen statement path) and once
//! with it set to 1 (`vyx_close_position`). Not a transcription of the SQL -- the compiled Rust.
//!
//! It does not assert equality itself, because the two paths cannot run in one process without mutating
//! the flag mid-test. Instead each run PRINTS a normalised dump of every row the close wrote, and the two
//! runs are diffed outside:
//!
//!   ENGINE_TEST_DATABASE_URL=... VYX_REQUIRE_DB_TESTS=1 cargo test --test close_one_call_parity_db -- --nocapture
//!   (once without the flag, once with ENGINE_CLOSE_ONE_CALL=1, then diff the two outputs)
//!
//! NORMALISED, because some values differ by nature and differing is correct:
//!   * every uuid -- both paths mint their own with Uuid::new_v4()
//!   * "Deal".ticket -- a sequence
//!   * the dedupeKey, which embeds the trade transaction's uuid
//!   * every timestamp, and the payload keys built from one (closeEngineAt, trigger*, closeWrittenAt)
//! Everything that carries MONEY or a decision is compared verbatim: balance, credit, amounts,
//! balanceBefore/balanceAfter, the note strings, the audit payloads, the deal's side/entry/reason.

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
            eprintln!("close_one_call_parity_db: ENGINE_TEST_DATABASE_URL not set, skipping");
            return None;
        }
    };
    assert!(
        url.contains("@127.0.0.1:") || url.contains("@localhost:"),
        "refusing a non-local test database"
    );
    Some(PgPool::connect(&url).await.expect("connect to the scratch DB"))
}

fn id(p: &str) -> String {
    format!("{p}_{}", uuid::Uuid::new_v4().simple())
}

struct Fx {
    broker: String,
    account: String,
    symbol_id: String,
    symbol_name: String,
    position: String,
}

/// One self-contained world per scenario: its own broker (so negativeBalanceProtection is per-scenario),
/// group, account, symbol, broker-symbol, live price, filled order and the OPEN position to close.
async fn fixture(pool: &PgPool, nbp: bool, balance: Decimal, credit: Decimal, extra_open: bool) -> Fx {
    let broker = id("B");
    let group = id("G");
    let account = id("A");
    let symbol_id = id("S");
    let symbol_name = format!("Z{}", &uuid::Uuid::new_v4().simple().to_string()[..5]).to_uppercase();

    let q = |s: &'static str| sqlx::query(s);
    q(r#"INSERT INTO "Broker" (id,name,subdomain,"negativeBalanceProtection","updatedAt") VALUES ($1,$1,$1,$2,now())"#)
        .bind(&broker).bind(nbp).execute(pool).await.unwrap();
    q(r#"INSERT INTO "Group" (id,"brokerId",name,"marginCallLevel","stopOutLevel","updatedAt") VALUES ($1,$2,$1,100,50,now())"#)
        .bind(&group).bind(&broker).execute(pool).await.unwrap();
    q(r#"INSERT INTO "Account" (id,"brokerId","groupId","accountNumber",email,"passwordHash","fullName","accountMode",balance,credit,leverage,"updatedAt")
         VALUES ($1,$2,$3,$4,$4,'h','T','DEMO',$5,$6,100,now())"#)
        .bind(&account).bind(&broker).bind(&group).bind(&account).bind(balance).bind(credit)
        .execute(pool).await.unwrap();
    q(r#"INSERT INTO "Symbol" (id,name,"baseCurrency","quoteCurrency",digits,"contractSize",category,"updatedAt")
         VALUES ($1,$2,'ZA','USD',2,1,'CRYPTO',now())"#)
        .bind(&symbol_id).bind(&symbol_name).execute(pool).await.unwrap();
    q(r#"INSERT INTO "BrokerSymbol" (id,"brokerId","symbolId","spreadMarkup","updatedAt") VALUES ($1,$2,$3,0,now())"#)
        .bind(id("BS")).bind(&broker).bind(&symbol_id).execute(pool).await.unwrap();
    q(r#"INSERT INTO "LivePrice" (symbol,bid,ask,"updatedAt","tickAt") VALUES ($1,1000,1000,now(),now())"#)
        .bind(&symbol_name).execute(pool).await.unwrap();

    let position = open_one(pool, &broker, &account, &symbol_id).await;
    if extra_open {
        open_one(pool, &broker, &account, &symbol_id).await;
    }
    Fx { broker, account, symbol_id, symbol_name, position }
}

async fn open_one(pool: &PgPool, broker: &str, account: &str, symbol_id: &str) -> String {
    let order = id("OO");
    let position = id("POS");
    sqlx::query(r#"INSERT INTO "Order" (id,"brokerId","accountId","symbolId",side,type,volume,status,"idempotencyKey","updatedAt")
                   VALUES ($1,$2,$3,$4,'BUY','MARKET',1,'FILLED',$1,now())"#)
        .bind(&order).bind(broker).bind(account).bind(symbol_id).execute(pool).await.unwrap();
    sqlx::query(r#"INSERT INTO "Position" (id,"brokerId","accountId","symbolId","originOrderId",side,volume,"openPrice",status,swap,"openedAt")
                   VALUES ($1,$2,$3,$4,$5,'BUY',1,1000,'OPEN',0,now())"#)
        .bind(&position).bind(broker).bind(account).bind(symbol_id).bind(&order)
        .execute(pool).await.unwrap();
    position
}

fn tick(symbol: &str, bid: Decimal, ask: Decimal) -> protocol::Tick {
    protocol::Tick {
        // the d5b5737 line added this (tick volume); the fixture predates it
        tick_count: None,
        symbol: symbol.to_string(), bid, ask,
        t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None,
        bars: Vec::new(),
    }
}

/// Everything the close wrote, with the by-nature-varying parts replaced by stable placeholders.
async fn dump(pool: &PgPool, fx: &Fx) -> String {
    let mut out = String::new();

    let (bal, cred): (Decimal, Decimal) =
        sqlx::query_as(r#"SELECT balance, credit FROM "Account" WHERE id=$1"#)
            .bind(&fx.account).fetch_one(pool).await.unwrap();
    out.push_str(&format!("ACCOUNT balance={bal} credit={cred}\n"));

    let pos: (String, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<Decimal>) = sqlx::query_as(
        r#"SELECT status::text, "closePrice", "realizedPnl", "closedVolume", "closedSwap" FROM "Position" WHERE id=$1"#,
    ).bind(&fx.position).fetch_one(pool).await.unwrap();
    out.push_str(&format!(
        "POSITION status={} closePrice={:?} realizedPnl={:?} closedVolume={:?} closedSwap={:?}\n",
        pos.0, pos.1, pos.2, pos.3, pos.4
    ));

    let txns: Vec<(String, Decimal, Decimal, Decimal, Option<String>, Option<String>, Option<Decimal>, Option<Decimal>, Option<Decimal>, Option<String>)> =
        sqlx::query_as(
            r#"SELECT type::text, amount, "balanceBefore", "balanceAfter", note, "referenceType",
                      "closeVolume", "closePrice", "closeSwap", "idempotencyKey"
                 FROM "Transaction" WHERE "referenceId"=$1 ORDER BY type::text"#,
        ).bind(&fx.position).fetch_all(pool).await.unwrap();
    for t in &txns {
        out.push_str(&format!(
            "TXN type={} amount={} before={} after={} note={:?} refType={:?} closeVol={:?} closePx={:?} closeSwap={:?} idem={:?}\n",
            t.0, t.1, t.2, t.3, t.4, t.5, t.6, t.7, t.8, t.9
        ));
    }

    let deals: Vec<(String, String, String, Decimal, Decimal, Option<Decimal>, Option<Decimal>, bool)> = sqlx::query_as(
        r#"SELECT side::text, entry::text, reason::text, volume, price, profit, swap, ticket > 0
             FROM "Deal" WHERE "positionId"=$1 ORDER BY entry::text"#,
    ).bind(&fx.position).fetch_all(pool).await.unwrap();
    for d in &deals {
        out.push_str(&format!(
            "DEAL side={} entry={} reason={} volume={} price={} profit={:?} swap={:?} ticketPositive={}\n",
            d.0, d.1, d.2, d.3, d.4, d.5, d.6, d.7
        ));
    }

    let audits: Vec<(String, serde_json::Value)> = sqlx::query_as(
        r#"SELECT action, "newValue" FROM "AuditLog" WHERE "entityId"=$1 ORDER BY action"#,
    ).bind(&fx.account).fetch_all(pool).await.unwrap();
    for (action, v) in &audits {
        // positionId is a per-run uuid; the amounts are the point
        let mut v = v.clone();
        if let Some(o) = v.as_object_mut() {
            o.insert("positionId".into(), serde_json::Value::String("<pos>".into()));
        }
        out.push_str(&format!("AUDIT action={action} newValue={v}\n"));
    }

    let effects: Vec<(String, Option<String>, serde_json::Value)> = sqlx::query_as(
        r#"SELECT kind, reason, payload FROM "PostCloseEffect" WHERE "positionId"=$1"#,
    ).bind(&fx.position).fetch_all(pool).await.unwrap();
    for (kind, reason, payload) in &effects {
        let mut p = payload.clone();
        if let Some(o) = p.as_object_mut() {
            // minted per run, or built from a clock
            for k in ["dealId", "dealTicket", "closeWrittenAt", "closeEngineAt", "triggerTickAt", "triggerTickEngineAt", "engineDelayMs"] {
                if o.contains_key(k) {
                    o.insert(k.into(), serde_json::Value::String("<varies>".into()));
                }
            }
        }
        out.push_str(&format!("EFFECT kind={kind} reason={reason:?} payload={p}\n"));
    }
    out
}

async fn run_scenario(name: &str, nbp: bool, balance: Decimal, credit: Decimal, extra_open: bool, close_at: Decimal) {
    let Some(pool) = pool().await else { return };
    order_management::db::use_prisma_book();
    let fx = fixture(&pool, nbp, balance, credit, extra_open).await;

    let nats_url = std::env::var("ENGINE_TEST_NATS_URL").unwrap_or_else(|_| "nats://127.0.0.1:4222".to_string());
    let nats = async_nats::connect(&nats_url).await.expect("connect to NATS");

    let cache = std::sync::Arc::new(market_data::cache::TickCache::new());
    cache.set(&tick(&fx.symbol_name, close_at, close_at), chrono::Utc::now());
    let pricing = market_data::pricing::PricingCache::new();
    pricing.reload(&pool).await.unwrap();

    let outcome = order_management::close_position(
        &pool, &nats, &fx.account, &fx.position, close_at, close_at, Some("parity-key"),
        &cache, Some(&pricing),
    )
    .await
    .expect("the close itself must not error");

    let flag = std::env::var("ENGINE_CLOSE_ONE_CALL").unwrap_or_else(|_| "unset".into());
    println!("===== SCENARIO {name} (ENGINE_CLOSE_ONE_CALL={flag}) =====");
    println!("OUTCOME {outcome:?}");
    print!("{}", dump(&pool, &fx).await);
    println!("===== END {name} =====");
}

#[tokio::test]
async fn s1_profitable_close() {
    // 1 lot bought at 1000, closed at 1050 -> +50 on a 1000 balance, no credit, no NBP branch
    run_scenario("S1_PROFIT", false, dec!(1000), dec!(0), false, dec!(1050)).await;
}

#[tokio::test]
async fn s2_loss_consumes_credit_not_last() {
    // closed at 700 -> -300 on balance 100 with credit 50, and a second position stays OPEN
    run_scenario("S2_CREDIT_NOT_LAST", false, dec!(100), dec!(50), true, dec!(700)).await;
}

#[tokio::test]
async fn s3_subzero_nbp_on_last_position() {
    // -300 on balance 100, no credit, NBP on, this is the only position -> write-off, balance 0
    run_scenario("S3_NBP_LAST", true, dec!(100), dec!(0), false, dec!(700)).await;
}

#[tokio::test]
async fn s4_subzero_nbp_on_not_last() {
    // identical money to S3, but another position stays OPEN -> no write-off
    run_scenario("S4_NBP_NOT_LAST", true, dec!(100), dec!(0), true, dec!(700)).await;
}

#[tokio::test]
async fn s5_credit_and_write_off_together() {
    // -300 on balance 100 with credit 50, NBP on, last position -> credit 50 then write-off 150
    run_scenario("S5_CREDIT_AND_NBP", true, dec!(100), dec!(50), false, dec!(700)).await;
}
