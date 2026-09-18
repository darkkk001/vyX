//! Shared account equity/margin math — used by both the margin monitor
//! (monitor.rs) and the pending-order trigger (pending_orders.rs), which
//! both need "what is this account's current equity/used margin, given
//! its open positions" to make a close/fill decision. Factored out here
//! rather than duplicated so the formula only exists once.

use crate::db;
use crate::prices::PriceSource;
use protocol::{OrderSide, Tick};
use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;

pub fn floating_pnl(
    side: OrderSide,
    open_price: Decimal,
    close_price: Decimal,
    contract_size: Decimal,
    volume: Decimal,
) -> Decimal {
    let diff = match side {
        OrderSide::Buy => close_price - open_price,
        OrderSide::Sell => open_price - close_price,
    };
    diff * contract_size * volume
}

pub fn close_price_for(side: OrderSide, bid: Decimal, ask: Decimal) -> Decimal {
    match side {
        OrderSide::Buy => bid,
        OrderSide::Sell => ask,
    }
}

pub struct AccountState {
    pub effective_balance: Decimal,
    pub credit: Decimal,
    /// Always >= 1 -- `load_account_state` clamps `Account.leverage`, so
    /// `used_margin` cannot hit `risk::required_margin`'s zero-leverage
    /// rejection through this struct. The `Result` is still surfaced
    /// rather than unwrapped so a future constructor can't reintroduce
    /// the panic (pentest 2026-09-18 item 9).
    pub leverage: u32,
    pub positions: Vec<db::OpenPositionWithMarket>,
}

pub fn used_margin(state: &AccountState) -> Result<Decimal, risk::RiskRejectReason> {
    let mut total = Decimal::ZERO;
    for p in &state.positions {
        total += risk::required_margin(p.volume, p.contract_size, p.open_price, state.leverage)?;
    }
    Ok(total)
}

pub fn equity(state: &AccountState) -> Decimal {
    let floating: Decimal = state
        .positions
        .iter()
        .filter_map(|p| {
            let (bid, ask) = (p.bid?, p.ask?);
            Some(floating_pnl(p.side, p.open_price, close_price_for(p.side, bid, ask), p.contract_size, p.volume))
        })
        .sum();
    state.effective_balance + state.credit + floating
}

/// Fills each position's `bid`/`ask` from `ticks` (keyed by symbol, as
/// `PriceSource::current_ticks` returns them). A position whose symbol
/// has no fresh tick keeps `None` on both -- the "count for margin, skip
/// for P&L and SL/TP" contract every consumer of `OpenPositionWithMarket`
/// already honours. Pure so it can be unit-tested without a DB.
pub fn attach_prices(positions: &mut [db::OpenPositionWithMarket], ticks: &HashMap<String, Tick>) {
    for p in positions.iter_mut() {
        match ticks.get(&p.symbol) {
            Some(tick) => {
                p.bid = Some(tick.bid);
                p.ask = Some(tick.ask);
            }
            None => {
                p.bid = None;
                p.ask = None;
            }
        }
    }
}

/// `None` if the account doesn't exist (Prisma-owned `Account` row
/// missing) — callers treat that as "nothing to do," not an error, same
/// as before this was factored out of monitor.rs.
///
/// Two stores, deliberately: positions/funds/ledger come from the trade
/// pool, prices from `prices` (TickCache, then the market-data reader --
/// see prices.rs for why the old single-pool LivePrice join was dead).
/// One position query per account, then one price lookup per *distinct*
/// symbol the account holds.
pub async fn load_account_state(
    pool: &PgPool,
    prices: &PriceSource,
    account_id: &str,
) -> Result<Option<AccountState>, sqlx::Error> {
    let Some(funds) = db::get_account_funds(pool, account_id).await? else {
        return Ok(None);
    };
    let ledger_sum = db::get_ledger_sum(pool, account_id).await?;
    let mut positions = db::get_open_positions(pool, account_id).await?;
    let symbols: Vec<String> = positions.iter().map(|p| p.symbol.clone()).collect();
    let ticks = prices.current_ticks(&symbols).await?;
    attach_prices(&mut positions, &ticks);
    Ok(Some(AccountState {
        effective_balance: funds.balance + ledger_sum,
        credit: funds.credit,
        leverage: funds.leverage.max(1) as u32,
        positions,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    #[test]
    fn floating_pnl_matches_lib_trading_ts_formula() {
        // Mirrors lib/trading.ts's computeRealizedPnl exactly — same
        // BUY/SELL diff direction, same contractSize*volume multiplier.
        let buy_profit = floating_pnl(OrderSide::Buy, dec!(1.10000), dec!(1.10050), dec!(100000), dec!(1));
        assert_eq!(buy_profit, dec!(50.00000));

        let sell_profit = floating_pnl(OrderSide::Sell, dec!(1.10000), dec!(1.09950), dec!(100000), dec!(1));
        assert_eq!(sell_profit, dec!(50.00000));

        let buy_loss = floating_pnl(OrderSide::Buy, dec!(1.10000), dec!(1.09950), dec!(100000), dec!(1));
        assert_eq!(buy_loss, dec!(-50.00000));
    }

    #[test]
    fn close_price_is_bid_for_buy_ask_for_sell() {
        assert_eq!(close_price_for(OrderSide::Buy, dec!(1.10000), dec!(1.10020)), dec!(1.10000));
        assert_eq!(close_price_for(OrderSide::Sell, dec!(1.10000), dec!(1.10020)), dec!(1.10020));
    }

    fn open_position(id: &str, symbol: &str) -> db::OpenPositionWithMarket {
        db::OpenPositionWithMarket {
            id: id.into(),
            symbol: symbol.into(),
            side: OrderSide::Buy,
            volume: dec!(1),
            open_price: dec!(2400),
            contract_size: dec!(100),
            bid: None,
            ask: None,
            sl_price: None,
            tp_price: None,
        }
    }

    fn tick(symbol: &str, bid: Decimal, ask: Decimal) -> Tick {
        Tick { symbol: symbol.into(), bid, ask, t0: None, clock_offset_ms: None, rtt_ms: None, tick_ms: None, broker_offset_sec: None }
    }

    /// Wrong-field audit 2026-09-18 item 1.2: the price attached to a
    /// position is the market-data source's fresh tick for ITS symbol;
    /// a symbol with no fresh tick stays None (skip for P&L, count for
    /// margin) instead of silently inheriting a stale/other price.
    #[test]
    fn attach_prices_fills_bid_ask_per_symbol_and_leaves_unpriced_ones_none() {
        let mut positions = vec![open_position("p1", "XAUUSD"), open_position("p2", "EURUSD"), open_position("p3", "XAUUSD")];
        let mut ticks = HashMap::new();
        ticks.insert("XAUUSD".to_string(), tick("XAUUSD", dec!(2390.5), dec!(2390.8)));

        attach_prices(&mut positions, &ticks);

        assert_eq!((positions[0].bid, positions[0].ask), (Some(dec!(2390.5)), Some(dec!(2390.8))));
        assert_eq!((positions[1].bid, positions[1].ask), (None, None));
        assert_eq!((positions[2].bid, positions[2].ask), (Some(dec!(2390.5)), Some(dec!(2390.8))));

        // Equity now sees the floating loss: (2390.5 - 2400) * 100 * 1 per XAUUSD position.
        let state = AccountState { effective_balance: dec!(10000), credit: Decimal::ZERO, leverage: 100, positions };
        assert_eq!(equity(&state), dec!(10000) + dec!(-950) * dec!(2));
    }

    #[test]
    fn used_margin_sums_every_position_and_never_panics_on_leverage() {
        let positions = vec![open_position("p1", "XAUUSD"), open_position("p2", "XAUUSD")];
        let ok = AccountState { effective_balance: dec!(10000), credit: Decimal::ZERO, leverage: 100, positions: positions.clone() };
        assert_eq!(used_margin(&ok).unwrap(), dec!(2400) * dec!(100) / dec!(100) * dec!(2));

        let zero = AccountState { effective_balance: dec!(10000), credit: Decimal::ZERO, leverage: 0, positions };
        assert!(matches!(used_margin(&zero), Err(risk::RiskRejectReason::InvalidLeverage { leverage: 0 })));
    }
}
