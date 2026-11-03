//! The web's open-order admission gates, ported (L2 Step 1 Part B).
//!
//! WHY THIS FILE EXISTS. For the engine to be the order entry point, **everything the web refuses the
//! engine must refuse too**. Before this, `place_market_order` applied five gates
//! (`check_symbol_enabled`, `check_lot_size`, `check_free_margin`, `check_symbol_exposure`,
//! `check_max_open_positions`); the web applies around twenty. An engine entry point without the rest
//! would fill a suspended account's order, a halted broker's, one outside its group's lot grid, one
//! over the daily loss limit.
//!
//! EVERY FUNCTION HERE IS A ONE-TO-ONE PORT of a named function in `lib/risk.ts` (or
//! `lib/hedging.ts`), noted per gate. They return `Option<String>`: `None` = pass, `Some(reason)` =
//! refuse — the same shape as the TypeScript, so the two read the same way side by side.
//!
//! EVERY ONE IS PURE. That is deliberate and it is what makes the parity oracle possible. The web's
//! five "query-backed" gates (`checkMaxOpenPositions`, `checkSymbolExposure`, `checkBrokerExposure`,
//! `checkMaxDailyLoss`, `checkHedgingAllowed`) are each a trivial decision over ONE aggregate the
//! query returned; the port takes that aggregate as an argument and leaves the reading to the caller.
//! So `docs/contracts/gate-vectors.json` can be generated from the web's own functions with the
//! database stubbed, and asserted here, with no database on either side. See
//! `scripts/contracts/gen-gate-vectors.ts` and `tests/gate_parity.rs`.
//!
//! WHAT IS NOT HERE is as important: see the module's own `NOT_PORTED` note at the bottom, and
//! `C:\vyx\handoff\l2-gate-parity.md`. Four of the web's gates cannot be ported without data the
//! engine's request does not carry, and they are flagged rather than guessed at.

use protocol::OrderSide;
use rust_decimal::Decimal;

// ---- broker-wide -------------------------------------------------------------------------------

/// `lib/risk.ts checkTradingHalted`. Broker-wide emergency halt; open positions are untouched.
pub fn trading_halted(trading_halted_at: bool) -> Option<String> {
    trading_halted_at.then(|| "trading is halted for this broker".to_string())
}

/// `lib/risk.ts checkCloseOnly`. Checked AFTER `trading_halted`, as the web orders them.
pub fn close_only(close_only_at: bool) -> Option<String> {
    close_only_at.then(|| "close-only mode is active for this broker: only closing existing positions is allowed".to_string())
}

// ---- the account's group -----------------------------------------------------------------------

/// `lib/risk.ts checkGroupTradingHalted`.
pub fn group_trading_halted(trading_halted_at: bool) -> Option<String> {
    trading_halted_at.then(|| "trading is halted for this account's group".to_string())
}

/// `lib/risk.ts checkGroupCloseOnly`.
pub fn group_close_only(close_only_at: bool) -> Option<String> {
    close_only_at.then(|| "close-only mode is active for this account's group: only closing existing positions is allowed".to_string())
}

// ---- the account -------------------------------------------------------------------------------

/// `lib/risk.ts checkAccountStatusForOpen`. A SUSPENDED / CLOSED account opens nothing.
pub fn account_status_for_open(status: &str) -> Option<String> {
    match status {
        "SUSPENDED" => Some("this account is suspended".to_string()),
        "CLOSED" => Some("this account is closed".to_string()),
        _ => None,
    }
}

pub const TRADING_RIGHTS_CLOSE_ONLY_MESSAGE: &str = "Your account is close-only: you can close positions but not open new ones";
pub const TRADING_RIGHTS_READ_ONLY_MESSAGE: &str = "Your account is read-only: trading is disabled";

/// `lib/risk.ts checkAccountTradingRights` with `intent = "open"` — the only intent an order path uses.
/// Note the order: the status check runs FIRST, so a suspended READ_ONLY account reports "suspended".
pub fn account_trading_rights_for_open(status: &str, trading_rights: &str) -> Option<String> {
    if let Some(reason) = account_status_for_open(status) {
        return Some(reason);
    }
    match trading_rights {
        "READ_ONLY" => Some(TRADING_RIGHTS_READ_ONLY_MESSAGE.to_string()),
        "CLOSE_ONLY" => Some(TRADING_RIGHTS_CLOSE_ONLY_MESSAGE.to_string()),
        _ => None,
    }
}

// ---- side restrictions -------------------------------------------------------------------------

/// `lib/risk.ts checkSymbolTradingMode`. `BrokerSymbol.tradingMode`.
pub fn symbol_trading_mode(trading_mode: &str, side: OrderSide) -> Option<String> {
    match trading_mode {
        "BUY_ONLY" if side != OrderSide::Buy => Some("this symbol is buy-only right now".to_string()),
        "SELL_ONLY" if side != OrderSide::Sell => Some("this symbol is sell-only right now".to_string()),
        _ => None,
    }
}

/// `lib/risk.ts checkGroupTradingRestriction`. The same rule one level up; both can block alone.
pub fn group_trading_restriction(restriction: &str, side: OrderSide) -> Option<String> {
    match restriction {
        "BUY_ONLY" if side != OrderSide::Buy => Some("this account's group is buy-only right now".to_string()),
        "SELL_ONLY" if side != OrderSide::Sell => Some("this account's group is sell-only right now".to_string()),
        _ => None,
    }
}

// ---- volume ------------------------------------------------------------------------------------

/// `lib/risk.ts effectiveMinLot`: the larger of the symbol's minimum and the group's.
pub fn effective_min_lot(symbol_min_lot: Decimal, group_min_lot: Option<Decimal>) -> Decimal {
    match group_min_lot {
        Some(g) if g > symbol_min_lot => g,
        _ => symbol_min_lot,
    }
}

/// `lib/risk.ts effectiveLotStep`: the larger of the symbol's step and the group's.
pub fn effective_lot_step(symbol_lot_step: Decimal, group_lot_step: Option<Decimal>) -> Decimal {
    match group_lot_step {
        Some(g) if g > symbol_lot_step => g,
        _ => symbol_lot_step,
    }
}

/// `lib/risk.ts effectiveMaxLot`: the LESSER of the symbol's max and the group's.
pub fn effective_max_lot(symbol_max_lot: Decimal, group_max_lot: Option<Decimal>) -> Decimal {
    match group_max_lot {
        Some(g) if g < symbol_max_lot => g,
        _ => symbol_max_lot,
    }
}

/// `lib/risk.ts checkGroupMaxLot`. A per-ORDER cap, not cumulative.
pub fn group_max_lot(volume: Decimal, group_max_lot: Option<Decimal>) -> Option<String> {
    let cap = group_max_lot?;
    (volume > cap).then(|| format!("volume exceeds this account's group max lot size of {}", normalized(cap)))
}

/// `lib/risk.ts checkGroupMinLot`. Its message is what the web's `riskCode` maps to GROUP_MIN_VOLUME.
pub fn group_min_lot(volume: Decimal, group_min_lot: Option<Decimal>, symbol_min_lot: Decimal) -> Option<String> {
    let min = effective_min_lot(symbol_min_lot, group_min_lot);
    (volume < min).then(|| format!("The smallest trade allowed for this account is {} lots.", fixed2(min)))
}

/// `lib/risk.ts checkGroupLotStep`. The grid is `effectiveMin + n x effectiveStep`, and the message
/// differs depending on whether the effective minimum itself sits on the step.
pub fn group_lot_step(
    volume: Decimal,
    group_lot_step: Option<Decimal>,
    group_min_lot: Option<Decimal>,
    symbol_min_lot: Decimal,
    symbol_lot_step: Decimal,
) -> Option<String> {
    let g = group_lot_step?;
    if g <= Decimal::ZERO {
        return None;
    }
    let step = effective_lot_step(symbol_lot_step, g.into());
    let min = effective_min_lot(symbol_min_lot, group_min_lot);
    if ((volume - min) % step).is_zero() {
        return None;
    }
    Some(if (min % step).is_zero() {
        format!("volume must be a multiple of {} lots for this account", fixed2(step))
    } else {
        format!("volume must be {} plus a multiple of {} lots for this account", fixed2(min), fixed2(step))
    })
}

/// `lib/risk.ts checkLotStep` — the SYMBOL's own grid.
///
/// The engine's `risk::check_lot_size` already covers min / max / step together, which is how the
/// engine has always done it; this is the web's split form, ported so the oracle can compare like for
/// like. Note one real difference the port preserves: the web skips the check when `lotStep <= 0`,
/// where `risk::check_lot_size` only skips when it is exactly zero — so a NEGATIVE step is checked by
/// the engine's version and ignored by the web's. Misconfiguration either way; recorded, not silently
/// harmonised.
pub fn lot_step(volume: Decimal, min_lot: Decimal, step: Decimal) -> Option<String> {
    if step <= Decimal::ZERO {
        return None;
    }
    (!((volume - min_lot) % step).is_zero())
        .then(|| format!("volume must be {} plus a multiple of {}", normalized(min_lot), normalized(step)))
}

/// `lib/risk.ts checkGroupAllowedSymbol`. Opt-in: `restrictSymbols` is false on every group by default.
pub fn group_allowed_symbol(restrict_symbols: bool, allowed_symbol_ids: &[String], symbol_id: &str) -> Option<String> {
    if !restrict_symbols {
        return None;
    }
    (!allowed_symbol_ids.iter().any(|id| id == symbol_id))
        .then(|| "this symbol is not enabled for this account's group".to_string())
}

// ---- the five the web reads an aggregate for ---------------------------------------------------
//
// Each takes the aggregate rather than a connection, which is what keeps it pure. The caller does the
// read; `db::get_gate_inputs` and `db::get_exposure_and_max_positions` are where that happens.

/// `lib/risk.ts checkMaxOpenPositions`. Note `>=`: the cap is the number of positions already open.
pub fn max_open_positions(open_count: i64, max_open_positions: Option<i32>) -> Option<String> {
    let max = max_open_positions?;
    (open_count >= max as i64).then(|| format!("account already has the maximum {max} open position(s)"))
}

/// `lib/risk.ts checkSymbolExposure`. `current` is the account's OPEN volume in this symbol.
pub fn symbol_exposure(current: Decimal, order_volume: Decimal, max_exposure: Option<Decimal>) -> Option<String> {
    let max = max_exposure?;
    (current + order_volume > max)
        .then(|| format!("order would exceed this symbol's max exposure of {} lots for this account", normalized(max)))
}

/// `lib/risk.ts checkBrokerExposure`. `current` is the broker's OPEN client volume — excluding the
/// coverage account, COVERAGE groups and internal accounts, which are the broker's own hedge legs and
/// not client exposure (the web's own audit note, 2026-09-24). That exclusion lives in the query.
pub fn broker_exposure(current: Decimal, order_volume: Decimal, total_exposure_limit: Option<Decimal>) -> Option<String> {
    let limit = total_exposure_limit?;
    (current + order_volume > limit)
        .then(|| format!("order would exceed this broker's total exposure limit of {} lots", normalized(limit)))
}

/// `lib/risk.ts checkMaxDailyLoss`. `realized_today` is the signed sum of TRADE_PNL since the start of
/// the day — a LOSS is negative, and the test is `realized <= -max`.
///
/// THE DAY BOUNDARY IS THE CALLER'S PROBLEM, and it is a real divergence risk: the web uses
/// `new Date(); setHours(0,0,0,0)`, i.e. midnight in the SERVER PROCESS's own timezone. On Vercel that
/// is UTC; on this VPS the process timezone is CET, so the same code would cut the day an hour or two
/// earlier. It is also not the platform's own broker-day boundary (21:00 UTC). `db::get_gate_inputs`
/// uses UTC midnight to match production's behaviour, and the divergence is flagged rather than
/// quietly "fixed" — picking a different boundary here would make the engine refuse orders the web
/// allows for an hour every day.
pub fn max_daily_loss(realized_today: Decimal, max_daily_loss: Option<Decimal>) -> Option<String> {
    let max = max_daily_loss?;
    (realized_today <= -max)
        .then(|| format!("daily loss limit of {} reached for this account, try again tomorrow", normalized(max)))
}

pub const HEDGING_REFUSED_TEXT: &str = "hedging is not allowed: close the opposite position on this symbol first";

/// `lib/hedging.ts checkHedgingAllowed`. Note the web's test is `hedgingAllowed !== false`, so a NULL
/// column passes — the port takes the already-resolved boolean and the caller must default a missing
/// column to `true`, not `false`.
pub fn hedging_allowed(hedging_allowed: bool, has_opposite_open_position: bool) -> Option<String> {
    if hedging_allowed {
        return None;
    }
    has_opposite_open_position.then(|| HEDGING_REFUSED_TEXT.to_string())
}

// ---- the market's own hours --------------------------------------------------------------------

/// `lib/risk.ts checkTradingSession`, via the engine's own port (`crate::session`), which is pinned to
/// the web's behaviour by `docs/contracts/trading-session-vectors.json` (228 cases). That oracle found
/// two real drifts in the port: the daily break was METALS-only and one hour (so SpotBrent's three
/// hours could not be expressed, and SpotCrude had none), and cross-midnight session windows were
/// treated as closed for their whole length on both days.
///
/// Returns the bare machine code the web returns, not a sentence: the terminal renders its own copy for
/// `MARKET_CLOSED` (WebTrader.tsx's handleOrderError), and every other caller is staff-facing.
pub fn trading_session(
    sessions: &[crate::session::SessionWindow],
    now: chrono::DateTime<chrono::Utc>,
    category: &str,
    symbol_name: &str,
) -> Option<String> {
    crate::session::is_market_closed(sessions, now, category, Some(symbol_name)).then(|| "MARKET_CLOSED".to_string())
}

// ---- the price ---------------------------------------------------------------------------------

/// `lib/risk.ts FILL_PRICE_MAX_AGE_MS`.
pub const FILL_PRICE_MAX_AGE_MS: i64 = 3_000;

/// `lib/risk.ts checkPriceFreshness`. The engine is better placed for this than the web: it holds the
/// tick in memory, so `age_ms` is measured against its own feed rather than a `"LivePrice"` row.
pub fn price_freshness(tick_age_ms: Option<i64>) -> Option<String> {
    match tick_age_ms {
        None => Some("PRICE_STALE".to_string()),
        Some(age) if age > FILL_PRICE_MAX_AGE_MS => Some("PRICE_STALE".to_string()),
        Some(_) => None,
    }
}

// ---- the chain, in the web's order -------------------------------------------------------------

/// What the chain needs beyond [`crate::db::GateInputs`]: the order itself, and the numbers the
/// symbol's own configuration and the account's exposure read supply.
pub struct OpenOrder<'a> {
    pub side: OrderSide,
    pub volume: Decimal,
    pub symbol_id: &'a str,
    /// The symbol's NAME -- the commodity daily break depends on it (SpotBrent breaks 3 h, not 1).
    pub symbol_name: &'a str,
    /// The instant to judge the market's hours and the tick's age against.
    pub now: chrono::DateTime<chrono::Utc>,
    pub symbol_min_lot: Decimal,
    pub symbol_lot_step: Decimal,
    pub symbol_max_exposure: Option<Decimal>,
    /// The account's OPEN volume in this symbol (`db::get_exposure_and_max_positions`).
    pub account_symbol_volume: Decimal,
    /// The account's OPEN position count, and the broker's cap.
    pub open_position_count: i64,
    pub max_open_positions: Option<i32>,
    /// Age of the tick this order will fill against, from the tick's own time. `None` = no tick.
    pub tick_age_ms: Option<i64>,
}

/// Every ported gate, in the order `app/api/trade/orders/route.ts` runs them, returning the FIRST
/// refusal.
///
/// Order matters only for WHICH reason a trader is told: the gates are conjunctive, so the accept /
/// refuse decision is the same whatever the order. It is mirrored anyway, because the reason is what
/// the trader reads and a support question about it should get the same answer from either path.
///
/// Two gates the web runs inside this chain are MISSING here and are refused elsewhere, not forgotten:
/// `checkTradingSession` and the `orderRoute`/SYSTEM refusal. See this module's `NOT_PORTED` note —
/// an engine entry point must not go live until they are resolved, and that is recorded in
/// `C:\vyx\handoff\l2-gate-parity.md` rather than papered over here.
pub fn evaluate_open(inputs: &crate::db::GateInputs, order: &OpenOrder<'_>) -> Option<String> {
    // --- the web's synchronous chain, same sequence ---
    trading_halted(inputs.broker_trading_halted)
        .or_else(|| close_only(inputs.broker_close_only))
        .or_else(|| symbol_trading_mode(&inputs.symbol_trading_mode, order.side))
        .or_else(|| trading_session(&inputs.sessions, order.now, &inputs.symbol_category, order.symbol_name))
        .or_else(|| lot_step(order.volume, order.symbol_min_lot, order.symbol_lot_step))
        .or_else(|| group_max_lot(order.volume, inputs.group_max_lot))
        .or_else(|| group_min_lot(order.volume, inputs.group_min_lot, order.symbol_min_lot))
        .or_else(|| {
            group_lot_step(
                order.volume,
                inputs.group_lot_step,
                inputs.group_min_lot,
                order.symbol_min_lot,
                order.symbol_lot_step,
            )
        })
        .or_else(|| group_trading_restriction(&inputs.group_trading_restriction, order.side))
        .or_else(|| account_trading_rights_for_open(&inputs.account_status, &inputs.account_trading_rights))
        .or_else(|| group_trading_halted(inputs.group_trading_halted))
        .or_else(|| account_status_for_open(&inputs.account_status))
        .or_else(|| group_close_only(inputs.group_close_only))
        .or_else(|| group_allowed_symbol(inputs.group_restrict_symbols, &inputs.group_allowed_symbol_ids, order.symbol_id))
        // orderRoute / SYSTEM sits here on the web -- NOT PORTED, see the module note
        // --- the web's second wave, in its array order ---
        .or_else(|| max_open_positions(order.open_position_count, order.max_open_positions))
        .or_else(|| hedging_allowed(inputs.hedging_allowed, inputs.has_opposite_open_position))
        .or_else(|| symbol_exposure(order.account_symbol_volume, order.volume, order.symbol_max_exposure))
        .or_else(|| broker_exposure(inputs.broker_open_volume, order.volume, inputs.total_exposure_limit))
        .or_else(|| max_daily_loss(inputs.realized_today, inputs.max_daily_loss))
        // L2 Step 1b item (E), owner decision: the web's 3 s, not the engine's own 15 s, and measured
        // from the tick's OWN time (TickCache::latest's second element = ingest::resolve_tick_time,
        // the same value "LivePrice".tickAt carries). NOT Tick.t0, whose own doc says it is never for
        // business logic. The engine's get_if_fresh(.., tick_freshness()) still gates this path at 15 s
        // first; this is the tighter gate the web applies, so the engine no longer fills against a
        // 14-second-old quote the web would refuse.
        .or_else(|| price_freshness(order.tick_age_ms))
}

// ---- number formatting, which the messages depend on -------------------------------------------

/// `Prisma.Decimal.toFixed(2)`: two places, half away from zero. Same rule as `book::fixed2`.
fn fixed2(d: Decimal) -> String {
    format!("{:.2}", d.round_dp_with_strategy(2, rust_decimal::RoundingStrategy::MidpointAwayFromZero))
}

/// `Prisma.Decimal`'s default `toString` (decimal.js): no trailing zeros. The web interpolates these
/// values bare (`${groupMaxLot}`), so "100" not "100.00".
fn normalized(d: Decimal) -> String {
    d.normalize().to_string()
}

// ---- WHAT IS DELIBERATELY NOT PORTED -----------------------------------------------------------
//
// Flagged, not guessed. Each needs something the engine's PlaceMarketOrderRequest does not carry, or a
// model the engine does not have:
//
//   demoQuoteTimeRefusal     the client's own `priceAt` timestamp. Not in the request.
//   evaluateLiveMarketPrice  the deviation half needs the CLIENT's submitted price; the request has no
//                            `price` field at all (the engine prices from its own tick). The freshness
//                            half is ported AND WIRED as `price_freshness` (L2 Step 1b item E).
//   the slippage cap         the client's `maxSlippagePips` / the broker's cap. Not in the request.
//   orderRoute / SYSTEM      the dealer-desk routing model (`orderRoute`, `deskIsOn`, the dealing
//                            queue). A web concern; the engine should refuse to decide it.
//   (checkTradingSession is now PORTED AND WIRED -- L2 Step 1b item A -- against 228 oracle cases.)
//   evaluatePreTradeMargin   the engine's `risk::check_free_margin` is the same idea but a narrower
//                            model: the web's also resolves conversion rates (NO_CONVERSION_RATE) and
//                            keys off the group's marginCallLevel.
//
// See C:\vyx\handoff\l2-gate-parity.md for the full inventory and what each would need.
