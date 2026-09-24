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

/// Canonical used margin (Stage 2 F2, lib/margin.ts liveUsedMarginFor): at the LIVE close-side price
/// (BUY bid, SELL ask), converted to the account currency, over positions with a usable price only. A
/// position without one is in neither the used margin nor the equity.
///
/// MT5 hedged margin (2026-09-25, lib/margin.ts hedgedUsedMargin, operation for operation): per SYMBOL the
/// offsetting BUY/SELL volume pays the symbol's hedged margin % (BrokerSymbol.hedgedMarginPct) of one lot's
/// margin per lot pair; only the uncovered volume pays in full. 200 = the plain sum (the default).
pub fn used_margin(state: &AccountState) -> Decimal {
    // first-seen symbol order, like the web's Map (the sum is exact either way)
    let mut books: Vec<(&str, SymbolMarginBook)> = Vec::new();
    for p in &state.positions {
        let (Some(bid), Some(ask)) = (p.bid, p.ask) else { continue };
        let margin = risk::required_margin(p.volume, p.contract_size, close_price_for(p.side, bid, ask), state.leverage) * p.fx_rate;
        let idx = match books.iter().position(|(s, _)| *s == p.symbol) {
            Some(i) => i,
            None => {
                books.push((p.symbol.as_str(), SymbolMarginBook { pct: p.hedged_margin_pct, ..Default::default() }));
                books.len() - 1
            }
        };
        let b = &mut books[idx].1;
        match p.side {
            OrderSide::Buy => { b.buy_vol += p.volume; b.buy_margin += margin; }
            OrderSide::Sell => { b.sell_vol += p.volume; b.sell_margin += margin; }
        }
    }
    books.iter().map(|(_, b)| symbol_hedged_margin(b)).sum()
}

#[derive(Default, Debug, Clone, Copy)]
pub struct SymbolMarginBook {
    pub buy_vol: Decimal,
    pub buy_margin: Decimal,
    pub sell_vol: Decimal,
    pub sell_margin: Decimal,
    pub pct: Decimal,
}

/// L = the side with the larger volume (BUY on a tie), S = the other:
/// covered = Ml * s / l ; margin = (Ml - covered) + (Ms + covered) * pct / 200. s = 0 -> Ml + Ms.
pub fn symbol_hedged_margin(b: &SymbolMarginBook) -> Decimal {
    let (l, ml, s, ms) = if b.buy_vol >= b.sell_vol { (b.buy_vol, b.buy_margin, b.sell_vol, b.sell_margin) } else { (b.sell_vol, b.sell_margin, b.buy_vol, b.buy_margin) };
    if s.is_zero() {
        return ml + ms;
    }
    let covered = ml * s / l;
    (ml - covered) + (ms + covered) * b.pct / Decimal::from(200)
}

/// BrokerSymbol.hedgedMarginPct's default: both legs of a hedge in full (the behavior before hedged margin).
pub fn default_hedged_margin_pct() -> Decimal {
    Decimal::from(200)
}

/// One position's floating P&L in the ACCOUNT currency at its close-side price; None without a usable price.
pub fn floating_pnl_account(p: &db::OpenPositionWithMarket) -> Option<Decimal> {
    let (bid, ask) = (p.bid?, p.ask?);
    Some(floating_pnl(p.side, p.open_price, close_price_for(p.side, bid, ask), p.contract_size, p.volume) * p.fx_rate)
}

pub fn equity(state: &AccountState) -> Decimal {
    let floating: Decimal = state
        .positions
        .iter()
        .filter_map(floating_pnl_account)
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

/// The margin monitor's account state on the REAL book (Stage 1, see book.rs): positions from `"Position"`,
/// and the balance is `"Account".balance` itself, because book::close_position_in_tx writes realized P&L
/// straight into it (the web's model). There is no ledger sum on top: adding one while the close also
/// writes the balance would count every close twice. `load_account_state` above stays for the order path
/// (pending_orders.rs), which is out of the Phase 3 scope and still on the engine's own tables.
pub async fn load_book_state(pool: &PgPool, account_id: &str) -> Result<Option<AccountState>, sqlx::Error> {
    let Some(funds) = db::get_account_funds(pool, account_id).await? else {
        return Ok(None);
    };
    let positions = crate::book::open_positions_with_market(pool, account_id).await?;
    Ok(Some(AccountState {
        effective_balance: funds.balance,
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

    // Same numbers as lib/hedged-margin.test.ts (MT5 hedged margin, 2026-09-25): the web and the engine agree.
    fn book(buy_vol: Decimal, buy_margin: Decimal, sell_vol: Decimal, sell_margin: Decimal, pct: Decimal) -> Decimal {
        symbol_hedged_margin(&SymbolMarginBook { buy_vol, buy_margin, sell_vol, sell_margin, pct })
    }

    #[test]
    fn hedged_margin_200_is_the_plain_sum() {
        assert_eq!(book(dec!(1), dec!(100), dec!(1), dec!(101), dec!(200)), dec!(201));
        assert_eq!(book(dec!(3), dec!(300), dec!(1), dec!(101), dec!(200)), dec!(401));
    }

    #[test]
    fn hedged_pair_costs_pct_over_200_of_both_legs() {
        assert_eq!(book(dec!(1), dec!(100), dec!(1), dec!(101), dec!(100)), dec!(100.5));
        assert_eq!(book(dec!(1), dec!(100), dec!(1), dec!(101), dec!(50)), dec!(50.25));
        assert_eq!(book(dec!(1), dec!(100), dec!(1), dec!(101), dec!(0)), dec!(0));
    }

    #[test]
    fn only_the_hedged_volume_is_reduced() {
        assert_eq!(book(dec!(3), dec!(300), dec!(1), dec!(101), dec!(50)), dec!(250.25));
        assert_eq!(book(dec!(1), dec!(100), dec!(2), dec!(202), dec!(0)), dec!(101));
        assert_eq!(book(dec!(2), dec!(200), dec!(0), dec!(0), dec!(0)), dec!(200));
    }

    #[test]
    fn used_margin_groups_by_symbol_and_skips_unpriced() {
        let pos = |symbol: &str, side: OrderSide, bid: Option<Decimal>, pct: Decimal| db::OpenPositionWithMarket {
            id: String::new(),
            symbol: symbol.into(),
            side,
            volume: dec!(1),
            open_price: dec!(2000),
            contract_size: dec!(100),
            bid,
            ask: bid.map(|b| b + dec!(0.20)),
            sl_price: None,
            tp_price: None,
            fx_rate: Decimal::ONE,
            hedged_margin_pct: pct,
        };
        // XAU pair at 50%: BUY 2000 (bid), SELL 2000.20 (ask) at 1:100 -> (2000 + 2000.2) * 50 / 200 = 1000.05
        let state = AccountState {
            effective_balance: dec!(5000),
            credit: dec!(0),
            leverage: 100,
            positions: vec![
                pos("XAU", OrderSide::Buy, Some(dec!(2000)), dec!(50)),
                pos("XAU", OrderSide::Sell, Some(dec!(2000)), dec!(50)),
                pos("OTHER", OrderSide::Sell, None, dec!(0)), // unpriced: in neither margin nor equity
            ],
        };
        assert_eq!(used_margin(&state), dec!(1000.05));
    }
}
