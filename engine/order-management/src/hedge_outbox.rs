//! Writing the hedge intent, and the result that comes back.
//!
//! THE DURABILITY RULE (owner 2026-11-14). The intent must be durable in the SAME transaction as the fill,
//! and must stay durable until the bridge says `accepted`. The reason is the failure that is not recoverable
//! any other way: a fill that commits without its intent is an open A-book position with no record that it
//! should have been hedged. Nothing later can notice it -- there is no row to notice. So the intent is not
//! queued in memory and written afterwards; it lands or the fill does not.
//!
//! WHY THERE IS A SECOND OPEN-POSITION ENTRY POINT. `vyx_open_position` commits in ONE SQL call, which is
//! exactly why it is fast (db.rs: fourteen round trips became one). Adding a parameter to it is not an
//! option -- Postgres would create a second function of the same name and the live engine's existing calls
//! would start resolving ambiguously. So the A-book path wraps the same unchanged call in an explicit
//! transaction and puts the intent insert beside it:
//!
//!     BEGIN; SELECT ... FROM vyx_open_position(...); INSERT INTO "HedgeIntent" ...; COMMIT;
//!
//! That costs one extra round trip for the BEGIN/COMMIT, and it is paid ONLY by A-book fills. Everything
//! else keeps the single-call path byte for byte, so the latency win the one-call work bought is not handed
//! back for positions that are never hedged at an LP.
//!
//! The other fill paths need none of this: `pending_orders.rs` (a resting order filling) and
//! `book.rs enqueue_post_close` (SL/TP, stop-out, and a client close while ENGINE_CLOSE_ONE_CALL is off) are
//! already inside a transaction, so [`insert_intent`] takes any executor and goes straight in beside them.
//!
//! TRANSITION. `"HedgeIntent"."dealId"` is UNIQUE (`HedgeIntent_dealId_key`). While both the web worker and
//! the engine are writing intents, the insert below is `ON CONFLICT ("dealId") DO NOTHING`, so exactly one
//! row lands per deal whichever side gets there first. That is the same `skipDuplicates: true` the web's
//! `lib/hedge.ts` uses, and it is what makes the cutover safe to do in either order.

use crate::hedge_bridge::{IntentMsg, ResultMsg, ResultStatus};
use crate::hedge_route::{hedge_route_of, mint_intent_id, HedgeRoute};
use chrono::{DateTime, Utc};
use rust_decimal::Decimal;
use sqlx::{PgPool, Postgres};

/// One intent to be written. The columns mirror the web's `lib/hedge.ts` intent exactly, field for field, so
/// a row written here is indistinguishable from one the worker wrote.
#[derive(Debug, Clone)]
pub struct NewIntent {
    /// FIX-safe, minted by [`mint_intent_id`]. This is the `"HedgeIntent"."id"` and the wire idempotency key.
    pub intent_id: String,
    pub broker_id: String,
    pub account_id: String,
    pub position_id: String,
    /// `None` only for a VOID intent (lib/hedge.ts `hedgeVoidInTx`). The UNIQUE index ignores NULLs, which is
    /// what lets a position have more than one void.
    pub deal_id: Option<String>,
    pub group_id: String,
    /// The symbol NAME (`position.symbol.name`), not its id -- the bridge speaks names.
    pub symbol: String,
    /// `deal.side`, the SAME side as the deal and not its opposite. (The VOID intent is the one case that
    /// flips it, and the caller does that flip, exactly as `hedgeVoidInTx` does.)
    pub side: String,
    pub volume: Decimal,
    pub client_price: Option<Decimal>,
    /// OPEN for `deal.entry == "IN"`, CLOSE for OUT, VOID for a void.
    pub kind: IntentKind,
    /// `deal.reason`, a `"DealReason"`.
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentKind {
    Open,
    Close,
    Void,
}

impl IntentKind {
    pub fn as_str(self) -> &'static str {
        match self {
            IntentKind::Open => "OPEN",
            IntentKind::Close => "CLOSE",
            IntentKind::Void => "VOID",
        }
    }

    /// `deal.entry === "IN" ? "OPEN" : "CLOSE"` from lib/hedge.ts.
    pub fn from_deal_entry(entry: &str) -> Self {
        if entry == "IN" {
            IntentKind::Open
        } else {
            IntentKind::Close
        }
    }
}

impl NewIntent {
    /// The wire form of this intent. `volume` becomes a decimal STRING in lots -- never a float, because a
    /// hedge leg off by a representation error is a real position that does not match the client's.
    pub fn to_wire(&self, created_at: DateTime<Utc>) -> IntentMsg {
        IntentMsg {
            intent_id: self.intent_id.clone(),
            deal_id: self.deal_id.clone(),
            position_id: self.position_id.clone(),
            group_id: self.group_id.clone(),
            symbol: self.symbol.clone(),
            side: self.side.clone(),
            volume: self.volume.normalize().to_string(),
            reduce: matches!(self.kind, IntentKind::Close | IntentKind::Void),
            client_price: self.client_price.map(|p| p.normalize().to_string()),
            created_at: created_at.to_rfc3339(),
        }
    }
}

/// Insert one intent on whatever executor the caller already has -- a transaction for the fill paths that
/// have one, the pool for a caller that does not.
///
/// Returns true when a row landed, false when `dealId` was already taken (the web worker got there first, or
/// this is a retry). False is a normal answer, not a failure: the invariant is "exactly one intent per deal",
/// and it is satisfied either way.
pub async fn insert_intent<'e, E>(executor: E, intent: &NewIntent) -> Result<bool, sqlx::Error>
where
    E: sqlx::Executor<'e, Database = Postgres>,
{
    let result = sqlx::query(
        r#"INSERT INTO "HedgeIntent"
             (id, "brokerId", "accountId", "positionId", "dealId", "groupId", symbol, side, volume,
              "clientPrice", kind, reason, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::"OrderSide", $9, $10,
                   $11::"HedgeIntentKind", $12::"DealReason", 'PENDING'::"HedgeIntentStatus")
           ON CONFLICT ("dealId") DO NOTHING"#,
    )
    .bind(&intent.intent_id)
    .bind(&intent.broker_id)
    .bind(&intent.account_id)
    .bind(&intent.position_id)
    .bind(&intent.deal_id)
    .bind(&intent.group_id)
    .bind(&intent.symbol)
    .bind(&intent.side)
    .bind(intent.volume)
    .bind(intent.client_price)
    .bind(intent.kind.as_str())
    .bind(&intent.reason)
    .execute(executor)
    .await?;
    Ok(result.rows_affected() == 1)
}

/// What the hedge path needs that `OpenPositionCall` does not already carry.
///
/// Kept as a SEPARATE argument rather than three more fields on `OpenPositionCall`: that struct is built at
/// several call sites and in the depth tests, and widening it would churn all of them for the benefit of one
/// path. Nothing here is looked up inside the transaction, because every extra round trip between BEGIN and
/// COMMIT is a round trip the order path waits for.
#[derive(Debug, Clone, Copy)]
pub struct HedgeContext<'a> {
    /// `"Account"."groupId"` -- `"HedgeIntent"."groupId"`, which the bridge routes on.
    pub group_id: &'a str,
    /// The symbol NAME, not its id: the bridge speaks names (lib/hedge.ts uses `position.symbol.name`).
    pub symbol_name: &'a str,
    /// Is this the broker's own coverage account (`Broker.coverageAccountId`)? The caller answers, because
    /// the order path already knows and `hedgeRouteOf` gives this precedence over both stamps.
    pub on_hedge_account: bool,
}

/// The A-book open path: `vyx_open_position` and its intent in ONE transaction.
///
/// The category half of the route comes back FROM the call (the trigger stamps `groupCategoryAtOpen`), so the
/// route is decided after the fill is written and before the commit. That is the only place it can be decided
/// from the same data the trigger just stamped -- deciding it earlier would be deciding it from a different
/// read of the group.
///
/// Returns the opened position, and the intent id when one was written.
pub async fn open_position_one_call_hedged(
    pool: &PgPool,
    call: &crate::db::OpenPositionCall<'_>,
    ctx: &HedgeContext<'_>,
) -> Result<Option<(crate::db::OpenedPosition, Option<String>)>, sqlx::Error> {
    let mut tx = pool.begin().await?;

    let opened = match crate::db::open_position_one_call_on(&mut *tx, call).await {
        Ok(Some(o)) => o,
        Ok(None) => {
            // the compare-and-set lost: nothing was written, and nothing should be
            tx.rollback().await?;
            return Ok(None);
        }
        Err(e) => {
            tx.rollback().await?;
            return Err(e);
        }
    };

    let route = hedge_route_of(
        opened.deal.group_category_at_open.as_deref(),
        call.book_type.as_str(),
        ctx.on_hedge_account,
    );
    if !route.goes_to_bridge() {
        tx.commit().await?;
        return Ok(Some((opened, None)));
    }

    let intent = NewIntent {
        intent_id: mint_intent_id(),
        broker_id: opened.deal.broker_id.clone(),
        account_id: opened.deal.account_id.clone(),
        position_id: opened.position_id.clone(),
        deal_id: Some(opened.deal.deal_id.clone()),
        group_id: ctx.group_id.to_string(),
        symbol: ctx.symbol_name.to_string(),
        // `deal.side`, the SAME side as the deal (lib/hedge.ts). The spelling comes from db.rs so the intent
        // and the deal row can never disagree about what BUY is called.
        side: crate::db::side_to_str(call.side).to_string(),
        volume: call.filled_volume,
        client_price: Some(call.fill_price),
        kind: IntentKind::Open,
        reason: Some(call.deal_reason.to_string()),
    };
    let landed = insert_intent(&mut *tx, &intent).await?;
    tx.commit().await?;

    Ok(Some((opened, landed.then_some(intent.intent_id))))
}

// ---------------------------------------------------------------------------------------------------------
// results
// ---------------------------------------------------------------------------------------------------------

/// Map a wire status onto `"HedgeResultStatus"`.
///
/// THE ONE PLACE THE CONTRACT AND THE SCHEMA DISAGREE. The wire carries FILLED / PARTIAL / ESCALATED; the
/// enum in the database today is ROUTED / FILLED / ESCALATED, with no PARTIAL. An additive migration adds it
/// (migrations/..._hedge_result_partial.sql on this branch) and this function is the only thing that has to
/// know. It is written as a total match rather than a string pass-through so that adding a wire status in
/// future fails to compile here instead of failing at the INSERT.
pub fn result_status_sql(status: ResultStatus) -> &'static str {
    match status {
        ResultStatus::Filled => "FILLED",
        ResultStatus::Partial => "PARTIAL",
        ResultStatus::Escalated => "ESCALATED",
    }
}

/// Persist one leg's outcome. Keyed by `legId`, so the bridge resending a result it has not seen an ack for
/// updates the row instead of duplicating it.
///
/// A set-aside result has no leg id. It still needs a row -- the whole point is that a human has to see it --
/// so it gets a synthetic leg id derived from the intent id, which keeps the primary key honest and makes the
/// row obviously not an LP leg.
pub async fn persist_result(pool: &PgPool, result: &ResultMsg, requested_volume: Decimal) -> Result<(), sqlx::Error> {
    let leg_id = result.leg_id.clone().unwrap_or_else(|| format!("{}_setaside", result.intent_id));
    let filled: Decimal = result.filled_qty.parse().unwrap_or(Decimal::ZERO);
    let avg: Decimal = result.avg_px.as_deref().and_then(|p| p.parse().ok()).unwrap_or(Decimal::ZERO);
    let lp_order_ids = result.lp_order_ids.join(",");

    sqlx::query(
        r#"INSERT INTO "HedgeResult"
             ("legId", "intentId", "liquidityProviderId", status, "requestedVolume", "filledVolume",
              "avgPrice", attempts, "lpOrderIds", reason, "updatedAt")
           VALUES ($1, $2, $3, $4::"HedgeResultStatus", $5, $6, $7, 1, $8, $9, now())
           ON CONFLICT ("legId") DO UPDATE SET
             status = EXCLUDED.status,
             "filledVolume" = EXCLUDED."filledVolume",
             "avgPrice" = EXCLUDED."avgPrice",
             attempts = "HedgeResult".attempts + 1,
             "lpOrderIds" = EXCLUDED."lpOrderIds",
             reason = EXCLUDED.reason,
             "updatedAt" = now()"#,
    )
    .bind(&leg_id)
    .bind(&result.intent_id)
    .bind(result.lp_id.clone().unwrap_or_default())
    .bind(result_status_sql(result.status))
    .bind(requested_volume)
    .bind(filled)
    .bind(avg)
    .bind(&lp_order_ids)
    .bind(&result.reason)
    .execute(pool)
    .await?;
    Ok(())
}

/// Mark an intent accepted by the bridge. It stays in the table -- the result still has to land against it --
/// but it is no longer offered on reconnect.
pub async fn mark_accepted(pool: &PgPool, intent_id: &str) -> Result<(), sqlx::Error> {
    sqlx::query(r#"UPDATE "HedgeIntent" SET status = 'CLAIMED'::"HedgeIntentStatus" WHERE id = $1 AND status = 'PENDING'::"HedgeIntentStatus""#)
        .bind(intent_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// Every intent this broker still owes the bridge: what a reconnect resends.
///
/// PENDING only. A CLAIMED one has been accepted, and one with a result is DONE; neither is re-offered.
pub async fn unaccepted_intents(pool: &PgPool, broker_ids: &[String]) -> Result<Vec<IntentMsg>, sqlx::Error> {
    if broker_ids.is_empty() {
        return Ok(Vec::new());
    }
    let rows: Vec<(String, Option<String>, String, String, String, String, Decimal, Option<Decimal>, String, DateTime<Utc>)> =
        sqlx::query_as(
            r#"SELECT id, "dealId", "positionId", "groupId", symbol, side::text, volume, "clientPrice",
                      kind::text, "createdAt"
                 FROM "HedgeIntent"
                WHERE status = 'PENDING'::"HedgeIntentStatus" AND "brokerId" = ANY($1)
                ORDER BY seq"#,
        )
        .bind(broker_ids)
        .fetch_all(pool)
        .await?;

    Ok(rows
        .into_iter()
        .map(|(id, deal_id, position_id, group_id, symbol, side, volume, client_price, kind, created_at)| IntentMsg {
            intent_id: id,
            deal_id,
            position_id,
            group_id,
            symbol,
            side,
            volume: volume.normalize().to_string(),
            reduce: kind != "OPEN",
            client_price: client_price.map(|p| p.normalize().to_string()),
            created_at: created_at.to_rfc3339(),
        })
        .collect())
}

/// Which route a position takes, for callers that already have the two stamps.
pub fn route_for(group_category_at_open: Option<&str>, book_type: &str, on_hedge_account: bool) -> HedgeRoute {
    hedge_route_of(group_category_at_open, book_type, on_hedge_account)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal::prelude::FromPrimitive;

    fn new_intent() -> NewIntent {
        NewIntent {
            intent_id: mint_intent_id(),
            broker_id: "brk".into(),
            account_id: "acc".into(),
            position_id: "pos".into(),
            deal_id: Some("deal".into()),
            group_id: "grp".into(),
            symbol: "EURUSD".into(),
            side: "BUY".into(),
            volume: Decimal::from_f64(0.01).unwrap(),
            client_price: Decimal::from_f64(1.10342),
            kind: IntentKind::Open,
            reason: Some("CLIENT".into()),
        }
    }

    #[test]
    fn the_kind_matches_the_web_rule() {
        assert_eq!(IntentKind::from_deal_entry("IN"), IntentKind::Open);
        assert_eq!(IntentKind::from_deal_entry("OUT"), IntentKind::Close);
        assert_eq!(IntentKind::Open.as_str(), "OPEN");
        assert_eq!(IntentKind::Close.as_str(), "CLOSE");
        assert_eq!(IntentKind::Void.as_str(), "VOID");
    }

    #[test]
    fn the_wire_form_carries_volume_as_a_decimal_string() {
        let wire = new_intent().to_wire(Utc::now());
        assert_eq!(wire.volume, "0.01");
        assert_eq!(wire.client_price.as_deref(), Some("1.10342"));
    }

    /// An OPEN adds exposure; a CLOSE and a VOID take it off, which is what `reduce` tells the bridge.
    #[test]
    fn reduce_is_set_for_the_intents_that_take_exposure_off() {
        let mut i = new_intent();
        assert!(!i.to_wire(Utc::now()).reduce, "an open is not a reduce");
        i.kind = IntentKind::Close;
        assert!(i.to_wire(Utc::now()).reduce);
        i.kind = IntentKind::Void;
        assert!(i.to_wire(Utc::now()).reduce);
    }

    /// The wire id goes out exactly as it was minted -- nothing in the conversion may reshape it, or the
    /// bridge would set it aside.
    #[test]
    fn the_wire_id_is_the_minted_id_unchanged() {
        let i = new_intent();
        let wire = i.to_wire(Utc::now());
        assert_eq!(wire.intent_id, i.intent_id);
        assert!(crate::hedge_route::is_bridge_safe_id(&wire.intent_id));
    }

    #[test]
    fn the_status_mapping_is_total_and_names_the_schema_values() {
        assert_eq!(result_status_sql(ResultStatus::Filled), "FILLED");
        assert_eq!(result_status_sql(ResultStatus::Partial), "PARTIAL");
        assert_eq!(result_status_sql(ResultStatus::Escalated), "ESCALATED");
    }

    #[test]
    fn only_the_liquidity_provider_route_produces_an_intent() {
        assert!(route_for(Some("A_BOOK"), "A_BOOK", false).goes_to_bridge());
        assert!(!route_for(Some("A_BOOK"), "A_BOOK", true).goes_to_bridge(), "the hedge account's own leg");
        assert!(!route_for(Some("DEALING"), "B_BOOK", false).goes_to_bridge());
    }
}
