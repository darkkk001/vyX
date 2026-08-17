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

pub async fn upsert_live_price(
    tx: &mut sqlx::PgTransaction<'_>,
    symbol: &str,
    bid: Decimal,
    ask: Decimal,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO "LivePrice" (symbol, bid, ask, "updatedAt")
        VALUES ($1, $2, $3, now())
        ON CONFLICT (symbol) DO UPDATE SET
            bid = EXCLUDED.bid,
            ask = EXCLUDED.ask,
            "updatedAt" = now()
        "#,
    )
    .bind(symbol)
    .bind(bid)
    .bind(ask)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

/// Ported 1:1 from lib/price-feed.ts's `candleUpserts` SQL — `open` is
/// only set on insert (never touched by the `DO UPDATE`), `high`/`low`
/// widen via GREATEST/LEAST, `close` always takes the latest tick.
pub async fn upsert_candle(
    tx: &mut sqlx::PgTransaction<'_>,
    update: &CandleUpdate,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        r#"
        INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt")
        VALUES ($1, $2::"CandleTimeframe", $3, $4, $4, $4, $4, now())
        ON CONFLICT (symbol, timeframe, "bucketStart") DO UPDATE SET
            high = GREATEST("Candle".high, EXCLUDED.high),
            low = LEAST("Candle".low, EXCLUDED.low),
            close = EXCLUDED.close,
            "updatedAt" = now()
        "#,
    )
    .bind(&update.symbol)
    .bind(timeframe_to_str(update.timeframe))
    .bind(update.bucket_start)
    .bind(update.open)
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
}
