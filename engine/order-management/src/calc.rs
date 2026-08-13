//! Shared account equity/margin math — used by both the margin monitor
//! (monitor.rs) and the pending-order trigger (pending_orders.rs), which
//! both need "what is this account's current equity/used margin, given
//! its open positions" to make a close/fill decision. Factored out here
//! rather than duplicated so the formula only exists once.

use crate::db;
use protocol::OrderSide;
use rust_decimal::Decimal;
use sqlx::PgPool;

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
    pub leverage: u32,
    pub positions: Vec<db::OpenPositionWithMarket>,
}

pub fn used_margin(state: &AccountState) -> Decimal {
    state
        .positions
        .iter()
        .map(|p| risk::required_margin(p.volume, p.contract_size, p.open_price, state.leverage))
        .sum()
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

/// `None` if the account doesn't exist (Prisma-owned `Account` row
/// missing) — callers treat that as "nothing to do," not an error, same
/// as before this was factored out of monitor.rs.
pub async fn load_account_state(pool: &PgPool, account_id: &str) -> Result<Option<AccountState>, sqlx::Error> {
    let Some(funds) = db::get_account_funds(pool, account_id).await? else {
        return Ok(None);
    };
    let ledger_sum = db::get_ledger_sum(pool, account_id).await?;
    let positions = db::get_open_positions_with_market(pool, account_id).await?;
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
}
