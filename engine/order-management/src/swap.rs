//! Daily swap (overnight holding fee) rollover — see
//! ../../docs/execution.md §4 and ../../docs/risk-engine.md's commission/
//! swap notes. Not order-triggered like margin/SL-TP — runs once per
//! calendar day against every OPEN position, applying
//! `BrokerSymbol.swapLong`/`swapShort` (account-currency per lot per day
//! — see that field's schema comment for the unit convention) as a
//! `SWAP` ledger entry.
//!
//! Calendar rule (wrong-field audit 2026-09-18 item 2.5 pinned it down):
//! - one charge per position per calendar day, claimed per position
//!   (`db::claim_position_for_swap`) so a re-run the same day is a no-op;
//! - the first charge is the first rollover AFTER the day the position
//!   was opened -- `db::insert_position` seeds `last_swap_at` and the due
//!   predicate falls back to `created_at`, so a position never pays on
//!   the poll after it opens;
//! - Wednesday charges 3x, the common industry convention for rolling a
//!   position through the weekend (Fri/Sat/Sun nights collapsed into one
//!   charge);
//! - Saturday and Sunday charge nothing at all (`is_rollover_day`) --
//!   without that skip the Wednesday triple PLUS two weekend charges made
//!   nine charges a week instead of seven.
//! A broker-level override for any of this isn't built, matching the
//! project's own "don't build config nobody asked for yet" bias; flagged
//! here as a deliberate simplification, not hidden.
//!
//! "What day is it" is read from Postgres's own `CURRENT_DATE`
//! (`db::get_current_weekday`), not the Rust process's local/UTC clock —
//! same one-clock reasoning as the staleness checks in
//! `market_data::db::get_live_price`.

use crate::db;
use rust_decimal::Decimal;
use sqlx::PgPool;

/// 3x on Wednesday, 1x every other day — see module doc comment. `1..=7`
/// ISO weekday (Monday=1) is what `db::get_current_weekday` returns; any
/// other value would be a schema-level surprise, not something to panic
/// over, so it falls back to the safe (non-tripled) multiplier.
pub fn swap_multiplier(iso_weekday: i32) -> Decimal {
    if iso_weekday == 3 {
        Decimal::from(3)
    } else {
        Decimal::from(1)
    }
}

/// Whether a rollover run on this ISO weekday (Monday=1..Sunday=7)
/// charges anything: Saturday (6) and Sunday (7) are skipped outright --
/// the weekend's holding cost is what Wednesday's 3x already covers. A
/// weekend run leaves every position unclaimed, so Monday's run picks
/// them all up as normal. Out-of-range values (a schema-level surprise)
/// count as a charging day, matching `swap_multiplier`'s safe fallback.
pub fn is_rollover_day(iso_weekday: i32) -> bool {
    !matches!(iso_weekday, 6 | 7)
}

/// `rate` is `BrokerSymbol.swapLong` or `swapShort` depending on the
/// position's side — account currency per lot per day. Sign comes
/// straight from `rate` (a broker can configure a credit, not just a
/// cost), `compute_swap` doesn't force one.
pub fn compute_swap(rate: Decimal, volume: Decimal, multiplier: Decimal) -> Decimal {
    rate * volume * multiplier
}

/// One full pass: every OPEN position not yet charged today gets
/// claimed, priced via its broker's current `BrokerSymbolConfig`
/// (swap rate can change over time — always read fresh, not cached), and
/// charged. Each position is its own transaction/claim, same "one bad
/// row doesn't take down the rest" rule as `monitor::run_once`.
pub async fn run_once(pool: &PgPool) {
    let iso_weekday = match db::get_current_weekday(pool).await {
        Ok(d) => d,
        Err(err) => {
            tracing::error!(?err, "swap rollover: failed to read current weekday");
            return;
        }
    };
    if !is_rollover_day(iso_weekday) {
        tracing::debug!(iso_weekday, "swap rollover: weekend, nothing charged");
        return;
    }
    let multiplier = swap_multiplier(iso_weekday);

    let due = match db::get_positions_due_for_swap(pool).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::error!(?err, "swap rollover: failed to list positions due for swap");
            return;
        }
    };

    for position in due {
        if let Err(err) = charge_one(pool, &position, multiplier).await {
            tracing::error!(?err, position_id = %position.id, "swap rollover: failed to charge position");
        }
    }
}

async fn charge_one(pool: &PgPool, position: &db::PositionForSwap, multiplier: Decimal) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;

    // Claim first: another concurrent pass (shouldn't happen with a
    // single spawned job, but matches the idempotent-claim pattern used
    // everywhere else a position gets mutated here) may have already
    // charged this position for today between the list read above and
    // this transaction starting.
    if !db::claim_position_for_swap(&mut tx, &position.id).await? {
        tx.rollback().await?;
        return Ok(());
    }

    // Broker's current swap rate for this symbol — a `None` (Symbol row
    // itself gone) means nothing to charge, same "missing config isn't
    // fatal" convention as pricing.rs/the admission checks in lib.rs.
    let Some(cfg) = db::get_broker_symbol_config(pool, &position.broker_id, &position.symbol).await? else {
        tx.commit().await?; // still commit the claim -- don't re-attempt today
        return Ok(());
    };

    let rate = match position.side {
        protocol::OrderSide::Buy => cfg.swap_long,
        protocol::OrderSide::Sell => cfg.swap_short,
    };
    let amount = compute_swap(rate, position.volume, multiplier);

    db::apply_swap(&mut tx, &position.id, &position.account_id, amount).await?;
    tx.commit().await?;
    Ok(())
}

/// Spawns the rollover as a background task, checking every `poll_interval`
/// whether there's anything due — `run_once`/the claim's date guard make
/// checking more often than once a day harmless (a position already
/// charged today is simply not in the candidate list), so a short poll
/// interval just means rollover starts promptly after the day boundary
/// rather than needing to be scheduled at an exact instant.
pub fn spawn(pool: PgPool, poll_interval: std::time::Duration) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(poll_interval);
        loop {
            ticker.tick().await;
            run_once(&pool).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn wednesday_triples_every_other_day_is_1x() {
        assert_eq!(swap_multiplier(3), dec!(3));
        for day in [1, 2, 4, 5, 6, 7] {
            assert_eq!(swap_multiplier(day), dec!(1));
        }
    }

    #[test]
    fn unexpected_weekday_value_falls_back_to_1x() {
        assert_eq!(swap_multiplier(0), dec!(1));
        assert_eq!(swap_multiplier(99), dec!(1));
    }

    /// Wrong-field audit 2026-09-18 item 2.5: Mon-Fri charge (Wed x3),
    /// Sat/Sun charge nothing -- seven charges a week, not nine.
    #[test]
    fn weekend_is_skipped_and_the_week_totals_seven_charges() {
        assert!(!is_rollover_day(6));
        assert!(!is_rollover_day(7));
        let charges_per_week: Decimal = (1..=7)
            .filter(|d| is_rollover_day(*d))
            .map(swap_multiplier)
            .sum();
        assert_eq!(charges_per_week, dec!(7));
    }

    #[test]
    fn unexpected_weekday_value_still_charges() {
        assert!(is_rollover_day(0));
        assert!(is_rollover_day(99));
    }

    #[test]
    fn compute_swap_scales_by_rate_volume_and_multiplier() {
        assert_eq!(compute_swap(dec!(-6.50), dec!(2), dec!(1)), dec!(-13.00));
        assert_eq!(compute_swap(dec!(-6.50), dec!(2), dec!(3)), dec!(-39.00));
    }

    #[test]
    fn compute_swap_can_be_a_credit() {
        assert_eq!(compute_swap(dec!(2.00), dec!(1), dec!(1)), dec!(2.00));
    }
}
