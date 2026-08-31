//! Postgres persistence for `LivePrice`/`Candle` — Market Data Core is the
//! sole writer of these tables (../../docs/market-data.md §3, unchanged
//! from today). Ports ../../lib/price-feed.ts's upsert SQL unchanged; see
//! that file for the original GREATEST/LEAST reasoning (a bucket's
//! high/low must stay correct across every tick that lands in it).
//!
//! Deliberately uses runtime-checked `sqlx::query` rather than the
//! `sqlx::query!` compile-time macro, same reasoning as
//! ../../order-management/src/db.rs: no guaranteed live DB connection at
//! build time in every environment this crate builds in.

use crate::alerts::{condition_from_str, AlertCondition, PriceAlert};
use crate::{CandleUpdate, Timeframe};
use rust_decimal::Decimal;
use sqlx::PgPool;

/// Matches the Postgres `CandleTimeframe` enum's exact values (Prisma
/// generated them from `docs/database.md`'s schema) — note `Mn1` maps to
/// the string `"MN1"`, not `"Mn1"`.
fn timeframe_to_str(tf: Timeframe) -> &'static str {
    match tf {
        Timeframe::M1 => "M1",
        Timeframe::M5 => "M5",
        Timeframe::M30 => "M30",
        Timeframe::H1 => "H1",
        Timeframe::H4 => "H4",
        Timeframe::D1 => "D1",
        Timeframe::W1 => "W1",
        Timeframe::Mn1 => "MN1",
        Timeframe::Y1 => "Y1",
    }
}

/// One round trip for the whole batch via `INSERT ... SELECT FROM
/// UNNEST(...)`, not one query per symbol -- see this module's own doc
/// comment and upsert_candles_batch's, below, for why (Contabo measured
/// 1500 sequential single-row upserts taking 17-25s under market-open
/// load, well past ingest_history's 30s WebRequest timeout). Parallel
/// slices, not `&[Tick]` (this crate doesn't otherwise depend on
/// `protocol::Tick`, and keeping that decoupling means a future caller
/// with its own symbol/bid/ask source doesn't need to manufacture a Tick
/// just to call this). No-ops on an empty batch rather than issuing a
/// pointless round trip.
pub async fn upsert_live_prices_batch(
    tx: &mut sqlx::PgTransaction<'_>,
    symbols: &[String],
    bids: &[Decimal],
    asks: &[Decimal],
) -> Result<(), sqlx::Error> {
    if symbols.is_empty() {
        return Ok(());
    }
    sqlx::query(
        r#"
        INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt")
        SELECT symbol, bid, ask, now()
        FROM UNNEST($1::text[], $2::numeric[], $3::numeric[]) AS t(symbol, bid, ask)
        ON CONFLICT (symbol) DO UPDATE SET
            bid = EXCLUDED.bid,
            ask = EXCLUDED.ask,
            "updatedAt" = now()
        "#,
    )
    .bind(symbols)
    .bind(bids)
    .bind(asks)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Batched port of the tick-aggregation upsert (ported 1:1 from
/// lib/price-feed.ts's `candleUpserts` SQL, now via `UNNEST` instead of
/// one row at a time -- same reasoning as upsert_live_prices_batch above).
/// `open` is only set on insert (never touched by the `DO UPDATE`),
/// `high`/`low` widen via GREATEST/LEAST, `close` always takes the latest
/// tick. Every current producer of `CandleUpdate` destined for this
/// function (candle_updates_for_tick, gap_fill::fill_gaps_and_record) sets
/// open == high == low == close already -- a single point-in-time
/// observation, not a bar -- so this binds `open` for all three of
/// high/low/close, matching the single-row version's own binding exactly
/// rather than trusting fields nothing currently varies.
pub async fn upsert_candles_batch(
    tx: &mut sqlx::PgTransaction<'_>,
    updates: &[CandleUpdate],
) -> Result<(), sqlx::Error> {
    if updates.is_empty() {
        return Ok(());
    }
    let symbols: Vec<&str> = updates.iter().map(|u| u.symbol.as_str()).collect();
    let timeframes: Vec<&str> = updates.iter().map(|u| timeframe_to_str(u.timeframe)).collect();
    let bucket_starts: Vec<chrono::DateTime<chrono::Utc>> = updates.iter().map(|u| u.bucket_start).collect();
    let prices: Vec<Decimal> = updates.iter().map(|u| u.open).collect();

    sqlx::query(
        r#"
        INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt")
        SELECT symbol, timeframe::"CandleTimeframe", bucket_start, price, price, price, price, now()
        FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::numeric[])
            AS t(symbol, timeframe, bucket_start, price)
        ON CONFLICT (symbol, timeframe, "bucketStart") DO UPDATE SET
            high = GREATEST("Candle".high, EXCLUDED.high),
            low = LEAST("Candle".low, EXCLUDED.low),
            close = EXCLUDED.close,
            "updatedAt" = now()
        "#,
    )
    .bind(&symbols)
    .bind(&timeframes)
    .bind(&bucket_starts)
    .bind(&prices)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// fix/realtime-sync §4 -- the EA's periodic CopyRates backfill
/// (mt5-ea/VyXTraderPriceFeed.mq5) hands over a broker's own true OHLC
/// for a bucket, not a single incremental tick -- unlike
/// upsert_candles_batch above (correct for tick-by-tick aggregation:
/// GREATEST/LEAST widen high/low as more ticks land in a still-open
/// bucket, and `open` is fixed at the bucket's first tick), a backfilled
/// bar must REPLACE whatever's there wholesale. Using the merge semantics
/// here would be wrong in both directions: GREATEST/LEAST could leave a
/// stale, too-wide high/low from a previous bad aggregate instead of the
/// broker's real one, and `open` would never correct itself at all.
///
/// Batched the same way and for the same reason as the two functions
/// above -- this is the specific query the Contabo measurement (1500
/// sequential rows, 17-25s) was taken against: `ingest_history` used to
/// call the single-row version of this once per bar inside one
/// transaction, meaning the transaction was one but the round trips
/// weren't. One call here now covers an entire request's bars.
///
/// In practice this rarely overwrites live-aggregated data at all: the
/// tick path only ever writes to the CURRENTLY open bucket for a given
/// timeframe (candle_updates_for_tick always buckets against "now"), so
/// once a bucket closes the tick path never touches it again -- the
/// backfill's authority mostly just means "whichever source got there
/// last for a given historical bucket wins," which for real historical
/// buckets is always the backfill (broker bars beat our aggregates, per
/// this fix's own name for the rule).
pub async fn upsert_candles_authoritative_batch(
    tx: &mut sqlx::PgTransaction<'_>,
    updates: &[CandleUpdate],
) -> Result<(), sqlx::Error> {
    if updates.is_empty() {
        return Ok(());
    }
    let symbols: Vec<&str> = updates.iter().map(|u| u.symbol.as_str()).collect();
    let timeframes: Vec<&str> = updates.iter().map(|u| timeframe_to_str(u.timeframe)).collect();
    let bucket_starts: Vec<chrono::DateTime<chrono::Utc>> = updates.iter().map(|u| u.bucket_start).collect();
    let opens: Vec<Decimal> = updates.iter().map(|u| u.open).collect();
    let highs: Vec<Decimal> = updates.iter().map(|u| u.high).collect();
    let lows: Vec<Decimal> = updates.iter().map(|u| u.low).collect();
    let closes: Vec<Decimal> = updates.iter().map(|u| u.close).collect();

    sqlx::query(
        r#"
        INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt")
        SELECT symbol, timeframe::"CandleTimeframe", bucket_start, open, high, low, close, now()
        FROM UNNEST($1::text[], $2::text[], $3::timestamptz[], $4::numeric[], $5::numeric[], $6::numeric[], $7::numeric[])
            AS t(symbol, timeframe, bucket_start, open, high, low, close)
        ON CONFLICT (symbol, timeframe, "bucketStart") DO UPDATE SET
            open = EXCLUDED.open,
            high = EXCLUDED.high,
            low = EXCLUDED.low,
            close = EXCLUDED.close,
            "updatedAt" = now()
        "#,
    )
    .bind(&symbols)
    .bind(&timeframes)
    .bind(&bucket_starts)
    .bind(&opens)
    .bind(&highs)
    .bind(&lows)
    .bind(&closes)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Synchronous current bid/ask read — the path `docs/market-data.md` §2's
/// diagram calls out for the Execution module. Not wired into Execution
/// yet (separate slice); added now since the query is a one-liner against
/// a table this crate already owns.
/// A frozen feed is more dangerous than no feed at all: with no staleness
/// check, a dead MT5 EA leaves `LivePrice` sitting at whatever bid/ask it
/// last saw, and every caller here (order fills, margin/SL-TP/stop-out
/// evaluation via order-management's own live-price join) would keep
/// trading against that stale number indefinitely with no signal
/// anything was wrong. 15s matches the staleness threshold already
/// established for the chart (`components/webtrader/WebTrader.tsx`'s
/// `now - updatedAt > 15000`) — one convention, not two independently
/// invented numbers. Filtering in SQL against Postgres's own `now()`
/// (the same clock `upsert_live_price` writes `updatedAt` from) avoids
/// any client-clock-skew concern a Rust-side comparison would have.
pub async fn get_live_price(
    pool: &PgPool,
    symbol: &str,
) -> Result<Option<(Decimal, Decimal)>, sqlx::Error> {
    let row: Option<(Decimal, Decimal)> = sqlx::query_as(
        r#"SELECT bid, ask FROM "LivePrice" WHERE symbol = $1 AND "updatedAt" > now() - interval '15 seconds'"#,
    )
    .bind(symbol)
    .fetch_optional(pool)
    .await?;
    Ok(row)
}

/// Boot-time (and post-hot-reload-gap resync) load for
/// alerts::AlertCache::load -- every currently ACTIVE alert, across
/// every broker (the cache itself doesn't filter by broker; nothing
/// downstream of a trigger needs to before it does, since the trigger
/// record already carries broker_id/account_id for whoever consumes it
/// next). `condition::text` casts the Postgres enum to a plain string
/// this crate's own AlertCondition (not the DB's type) decodes from --
/// unrecognized values are dropped rather than erroring the whole load,
/// though none should ever exist (the enum only has these three values).
pub async fn load_active_price_alerts(pool: &PgPool) -> Result<Vec<PriceAlert>, sqlx::Error> {
    let rows: Vec<(String, String, String, String, String, Decimal)> = sqlx::query_as(
        r#"SELECT id, "accountId", "brokerId", symbol, condition::text, price FROM "PriceAlert" WHERE status = 'ACTIVE'"#,
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .filter_map(|(id, account_id, broker_id, symbol, condition_str, price)| {
            condition_from_str(&condition_str).map(|condition| PriceAlert { id, account_id, broker_id, symbol, condition, price })
        })
        .collect())
}

/// Persists an alerts::AlertCache trigger decision -- marks the
/// PriceAlert row TRIGGERED (terminal, matches the in-memory cache
/// already having removed it, see AlertCache::check_tick's own comment)
/// and writes the first-ever trader-facing Notification row (see that
/// model's own schema comment) in the same transaction, so a crash
/// between the two can never leave one without the other. `id` uses a
/// plain UUID v4, not Prisma's own cuid() -- see this crate's Cargo.toml
/// comment on why that's a valid id for a Prisma-managed table anyway.
pub async fn mark_price_alert_triggered(
    tx: &mut sqlx::PgTransaction<'_>,
    alert: &PriceAlert,
    triggered_price: Decimal,
) -> Result<(), sqlx::Error> {
    sqlx::query(r#"UPDATE "PriceAlert" SET status = 'TRIGGERED', "triggeredAt" = now(), "triggeredPrice" = $2 WHERE id = $1"#)
        .bind(&alert.id)
        .bind(triggered_price)
        .execute(&mut **tx)
        .await?;

    let condition_word = match alert.condition {
        AlertCondition::Above => "reached",
        AlertCondition::Below => "dropped to",
        AlertCondition::Crosses => "crossed",
    };
    let title = format!("Price alert triggered -- {}", alert.symbol);
    let body = format!("{} {} {}", alert.symbol, condition_word, triggered_price);

    sqlx::query(
        r#"
        INSERT INTO "Notification" (id, "brokerId", "accountId", type, title, body, "entityType", "entityId")
        VALUES ($1, $2, $3, 'PRICE_ALERT_TRIGGERED', $4, $5, 'PriceAlert', $6)
        "#,
    )
    .bind(uuid::Uuid::new_v4().to_string())
    .bind(&alert.broker_id)
    .bind(&alert.account_id)
    .bind(&title)
    .bind(&body)
    .bind(&alert.id)
    .execute(&mut **tx)
    .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeframe_strings_match_the_postgres_enum() {
        assert_eq!(timeframe_to_str(Timeframe::M1), "M1");
        assert_eq!(timeframe_to_str(Timeframe::M5), "M5");
        assert_eq!(timeframe_to_str(Timeframe::M30), "M30");
        assert_eq!(timeframe_to_str(Timeframe::H1), "H1");
        assert_eq!(timeframe_to_str(Timeframe::H4), "H4");
        assert_eq!(timeframe_to_str(Timeframe::D1), "D1");
        assert_eq!(timeframe_to_str(Timeframe::W1), "W1");
        // The Rust variant is `Mn1`; the Postgres enum value is `MN1`.
        assert_eq!(timeframe_to_str(Timeframe::Mn1), "MN1");
        assert_eq!(timeframe_to_str(Timeframe::Y1), "Y1");
    }

    // Counts real Postgres round trips, not lines of Rust source -- sqlx
    // emits a `target: "sqlx::query"` tracing event for every query it
    // actually sends (sqlx-core's logger.rs), so installing a minimal
    // Subscriber that counts those events around one call is a genuine
    // assertion that the batched functions above issue one round trip
    // regardless of row count, not a per-row loop wearing a UNNEST
    // disguise. Needs a real DATABASE_URL -- this workspace otherwise has
    // no live-DB test infrastructure (see this module's own doc comment
    // on why every query here is runtime-checked, not the query! macro),
    // so this test skips itself (prints and returns, doesn't fail) rather
    // than requiring one in every environment `cargo test` runs in.
    struct QueryCounter(std::sync::Arc<std::sync::atomic::AtomicUsize>);

    impl tracing::Subscriber for QueryCounter {
        fn enabled(&self, _metadata: &tracing::Metadata<'_>) -> bool {
            true
        }
        fn new_span(&self, _span: &tracing::span::Attributes<'_>) -> tracing::span::Id {
            tracing::span::Id::from_u64(1)
        }
        fn record(&self, _span: &tracing::span::Id, _values: &tracing::span::Record<'_>) {}
        fn record_follows_from(&self, _span: &tracing::span::Id, _follows: &tracing::span::Id) {}
        fn event(&self, event: &tracing::Event<'_>) {
            if event.metadata().target() == "sqlx::query" {
                self.0.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            }
        }
        fn enter(&self, _span: &tracing::span::Id) {}
        fn exit(&self, _span: &tracing::span::Id) {}
    }

    // Runs the given future with QueryCounter installed as the default
    // subscriber for its duration, returning how many "sqlx::query"
    // events fired. `current_thread` on the test itself (below) matters
    // here: `tracing::subscriber::set_default` is thread-local, so this
    // only sees every query the future issues if nothing hops to a
    // different OS thread mid-`await`.
    async fn count_sqlx_queries<F: std::future::Future>(fut: F) -> (usize, F::Output) {
        let counter = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let guard = tracing::subscriber::set_default(QueryCounter(counter.clone()));
        let output = fut.await;
        drop(guard);
        (counter.load(std::sync::atomic::Ordering::SeqCst), output)
    }

    #[tokio::test(flavor = "current_thread")]
    async fn batched_upserts_are_exactly_one_query_each_regardless_of_row_count() {
        let Ok(database_url) = std::env::var("DATABASE_URL") else {
            eprintln!("skipping: DATABASE_URL not set -- this test needs a real Postgres to count real round trips against");
            return;
        };
        let Ok(pool) = PgPool::connect(&database_url).await else {
            eprintln!("skipping: could not connect to DATABASE_URL");
            return;
        };
        let Ok(mut tx) = pool.begin().await else {
            eprintln!("skipping: could not open a transaction");
            return;
        };

        // 50 rows each -- large enough that a regression back to a
        // per-row loop would be unmistakable (50 queries, not 1). Never
        // actually persisted: the whole transaction is rolled back below
        // regardless of outcome, and the symbol names are obviously fake
        // even if that somehow didn't happen.
        let base = chrono::Utc::now();
        let candle_updates: Vec<CandleUpdate> = (0..50i64)
            .map(|i| CandleUpdate {
                symbol: "TESTBATCH_QUERYCOUNT".to_string(),
                timeframe: Timeframe::M1,
                bucket_start: base + chrono::Duration::minutes(i),
                open: Decimal::ONE,
                high: Decimal::ONE,
                low: Decimal::ONE,
                close: Decimal::ONE,
            })
            .collect();

        let (n, result) = count_sqlx_queries(upsert_candles_batch(&mut tx, &candle_updates)).await;
        result.expect("upsert_candles_batch should succeed");
        assert_eq!(n, 1, "upsert_candles_batch must issue exactly one query for 50 rows, got {n}");

        let (n, result) = count_sqlx_queries(upsert_candles_authoritative_batch(&mut tx, &candle_updates)).await;
        result.expect("upsert_candles_authoritative_batch should succeed");
        assert_eq!(n, 1, "upsert_candles_authoritative_batch must issue exactly one query for 50 rows, got {n}");

        let symbols: Vec<String> = (0..50).map(|i| format!("TESTBATCH_QUERYCOUNT_{i}")).collect();
        let bids = vec![Decimal::ONE; 50];
        let asks = vec![Decimal::TWO; 50];
        let (n, result) = count_sqlx_queries(upsert_live_prices_batch(&mut tx, &symbols, &bids, &asks)).await;
        result.expect("upsert_live_prices_batch should succeed");
        assert_eq!(n, 1, "upsert_live_prices_batch must issue exactly one query for 50 rows, got {n}");

        let _ = tx.rollback().await; // never actually persist this test's rows
    }
}
