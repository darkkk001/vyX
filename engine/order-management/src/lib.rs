//! Order Management (OMS) — see ../../docs/trading-engine.md.
//!
//! Owns order state exclusively (../../docs/database.md §3: sole writer of
//! the `orders` table). Does not calculate margin, does not decide fill
//! price, does not maintain position P&L — it orchestrates calls to
//! Risk/Margin, Execution, and Position and persists the result. Those
//! modules aren't wired in yet (Phase 2, ../../docs/architecture.md §7) —
//! this crate only encodes the state machine itself for now, so illegal
//! transitions are caught here before any module-integration work begins.

use protocol::OrderStatus;

/// Returns whether `to` is a legal next state from `from`, per the
/// diagram in ../../docs/architecture.md §5 / ../../docs/trading-engine.md
/// §2.1. This is the single source of truth for legality — callers should
/// never mutate an order's status without checking this first.
pub fn is_legal_transition(from: OrderStatus, to: OrderStatus) -> bool {
    use OrderStatus::*;
    matches!(
        (from, to),
        (New, Validating)
            | (Validating, Accepted)
            | (Validating, Rejected)
            | (Accepted, Routing)
            | (Accepted, Cancelled)
            | (Accepted, Expired)
            | (Routing, PartiallyFilled)
            | (Routing, Filled)
            | (Routing, Rejected)
            | (PartiallyFilled, Filled)
            | (PartiallyFilled, Cancelled)
    )
}

#[derive(Debug, thiserror::Error)]
pub enum TransitionError {
    #[error("illegal order state transition: {from:?} -> {to:?}")]
    Illegal { from: OrderStatus, to: OrderStatus },
}

/// Validates and (once wired to a Postgres pool) persists a state
/// transition in the same query as any resulting Position/Ledger mutation
/// — see ../../docs/trading-engine.md §2.1 on atomicity. The actual
/// Postgres write isn't implemented yet; this is the Phase 1 scaffold
/// checkpoint, Phase 2 wires it to `sqlx`.
pub fn transition(from: OrderStatus, to: OrderStatus) -> Result<OrderStatus, TransitionError> {
    if is_legal_transition(from, to) {
        Ok(to)
    } else {
        Err(TransitionError::Illegal { from, to })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use OrderStatus::*;

    #[test]
    fn happy_path_market_order() {
        assert!(is_legal_transition(New, Validating));
        assert!(is_legal_transition(Validating, Accepted));
        assert!(is_legal_transition(Accepted, Routing));
        assert!(is_legal_transition(Routing, Filled));
    }

    #[test]
    fn rejects_skip_ahead() {
        assert!(!is_legal_transition(New, Filled));
        assert!(!is_legal_transition(New, Accepted));
        assert!(!is_legal_transition(Filled, Cancelled));
    }

    #[test]
    fn terminal_states_have_no_outgoing_transitions() {
        for terminal in [Filled, Rejected, Cancelled, Expired] {
            for target in [New, Validating, Accepted, Routing, PartiallyFilled, Filled] {
                assert!(
                    !is_legal_transition(terminal, target),
                    "{terminal:?} should not transition to {target:?}"
                );
            }
        }
    }
}
