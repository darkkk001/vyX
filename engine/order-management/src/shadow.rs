//! Rust cutover Stage 5: the shadow's decision record (docs/RUST-CUTOVER-PLAN.md §5.1).
//!
//! In `ENGINE_ORDER_MANAGEMENT=shadow` the monitor runs the SAME evaluation as at cutover (monitor.rs with
//! `Mode::Shadow`) but acts on nothing: a would-close is applied in memory with book::close_money (the same
//! function the real close uses), and every decision lands HERE instead of in the book. The web keeps acting;
//! the reconciler (reconcile.rs) pairs its real closes with these would-closes.
//!
//! Store: table `shadow_decision` in the engine host's LOCAL Postgres (the market-data database on the VPS),
//! never Neon. `Recorder::connect` refuses a non-local URL. Without a store the recorder keeps decisions in
//! memory only (tests, and a VPS without the local database) and logs them.
//!
//! Dedupe: a position under stop-out stays open until the web closes it, so the shadow sees the same decision
//! on every pass. One row per decision (`dedupe_key`); later sightings bump `last_seen` / `seen_count`, and the
//! first sighting's numbers (level, price, P&L) are kept: that is the moment the engine would have acted.

use rust_decimal::Decimal;
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Debug, Clone, PartialEq, Eq, Copy)]
pub enum Kind {
    StopLoss,
    TakeProfit,
    StopOut,
    MarginCallIn,
    MarginCallOut,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::StopLoss => "stop_loss",
            Kind::TakeProfit => "take_profit",
            Kind::StopOut => "stop_out",
            Kind::MarginCallIn => "margin_call_in",
            Kind::MarginCallOut => "margin_call_out",
        }
    }
    pub fn is_close(self) -> bool {
        matches!(self, Kind::StopLoss | Kind::TakeProfit | Kind::StopOut)
    }
}

/// One would-be action. Closes carry the position and the simulated money; edges carry the level.
#[derive(Debug, Clone, PartialEq)]
pub struct Decision {
    pub kind: Kind,
    pub account_id: String,
    pub position_id: Option<String>,
    /// the account's margin level when the evaluation started (None = no used margin)
    pub level_before: Option<Decimal>,
    /// the level that decided it (stop-out / margin call)
    pub level: Option<Decimal>,
    pub close_price: Option<Decimal>,
    pub pnl: Option<Decimal>,
    pub balance_after: Option<Decimal>,
    pub credit_after: Option<Decimal>,
    pub write_off: Option<Decimal>,
    /// symbol -> [bid, ask] the evaluation used (the SNAPSHOT replay input)
    pub prices: serde_json::Value,
}

impl Decision {
    /// A close happens once per position; a margin-call edge once per episode (the caller passes the episode).
    pub fn dedupe_key(&self, episode: Option<u64>) -> String {
        match (&self.position_id, self.kind.is_close()) {
            (Some(p), true) => format!("{}:{}", self.kind.as_str(), p),
            _ => format!("{}:{}:{}", self.kind.as_str(), self.account_id, episode.unwrap_or(0)),
        }
    }
}

pub struct Recorder {
    store: Option<PgPool>,
    /// dedupe key -> sightings, for the in-memory mode and for tests
    seen: Mutex<HashMap<String, (Decision, u32)>>,
    /// account -> (last recorded edge, episode counter)
    edges: Mutex<HashMap<String, (Kind, u64)>>,
}

pub const SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS shadow_decision (
  id            BIGSERIAL PRIMARY KEY,
  dedupe_key    TEXT NOT NULL UNIQUE,
  kind          TEXT NOT NULL,
  account_id    TEXT NOT NULL,
  position_id   TEXT,
  level_before  NUMERIC,
  level         NUMERIC,
  close_price   NUMERIC,
  pnl           NUMERIC,
  balance_after NUMERIC,
  credit_after  NUMERIC,
  write_off     NUMERIC,
  prices        JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_count    INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS shadow_decision_first_seen ON shadow_decision (first_seen);
CREATE INDEX IF NOT EXISTS shadow_decision_position ON shadow_decision (position_id);
"#;

/// Only a database on this machine may hold the shadow store (the plan: VPS-local, never Neon).
pub fn is_local_url(url: &str) -> bool {
    let after_at = url.rsplit('@').next().unwrap_or("");
    let host = after_at.split(['/', ':', '?']).next().unwrap_or("");
    matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]")
}

impl Recorder {
    pub fn in_memory() -> Self {
        Recorder { store: None, seen: Mutex::new(HashMap::new()), edges: Mutex::new(HashMap::new()) }
    }

    /// The local store: creates the table if needed. A non-local URL is refused (Err), never used.
    pub async fn connect(url: &str) -> Result<Self, String> {
        if !is_local_url(url) {
            return Err("shadow store must be a local database (127.0.0.1 / localhost), refusing".into());
        }
        let pool = PgPool::connect(url).await.map_err(|e| format!("shadow store connect: {e}"))?;
        sqlx::raw_sql(SCHEMA).execute(&pool).await.map_err(|e| format!("shadow store schema: {e}"))?;
        Ok(Recorder { store: Some(pool), seen: Mutex::new(HashMap::new()), edges: Mutex::new(HashMap::new()) })
    }

    pub fn store(&self) -> Option<&PgPool> {
        self.store.as_ref()
    }

    /// Record a would-close (idempotent per position).
    pub async fn record(&self, d: Decision) {
        self.write(d, None).await;
    }

    /// Record a margin-call edge only when it CHANGES from the last one recorded for the account (the shadow sees
    /// "in margin call" on every pass of an episode). The first sighting of an account records In but not Out:
    /// an account that was never in a call has no edge to leave.
    pub async fn record_edge(&self, d: Decision) {
        let episode = {
            let mut edges = self.edges.lock().unwrap();
            let prev = edges.get(&d.account_id).copied();
            let changed = match prev {
                None => d.kind == Kind::MarginCallIn,
                Some((k, _)) => k != d.kind,
            };
            if !changed {
                return;
            }
            let ep = prev.map(|(_, n)| n).unwrap_or(0) + u64::from(d.kind == Kind::MarginCallIn);
            edges.insert(d.account_id.clone(), (d.kind, ep));
            ep
        };
        self.write(d, Some(episode)).await;
    }

    async fn write(&self, d: Decision, episode: Option<u64>) {
        let key = d.dedupe_key(episode);
        let first = {
            let mut seen = self.seen.lock().unwrap();
            match seen.get_mut(&key) {
                Some((_, n)) => {
                    *n += 1;
                    false
                }
                None => {
                    // bounded: an idle-for-days engine must not grow without limit (the store keeps history)
                    if seen.len() > 200_000 {
                        seen.clear();
                    }
                    seen.insert(key.clone(), (d.clone(), 1));
                    true
                }
            }
        };
        if first {
            tracing::info!(kind = d.kind.as_str(), account_id = %d.account_id, position_id = ?d.position_id, level = ?d.level, pnl = ?d.pnl, "shadow: would act");
        }
        let Some(pool) = &self.store else { return };
        let res = sqlx::query(
            r#"INSERT INTO shadow_decision (dedupe_key, kind, account_id, position_id, level_before, level, close_price, pnl, balance_after, credit_after, write_off, prices)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
               ON CONFLICT (dedupe_key) DO UPDATE SET last_seen = now(), seen_count = shadow_decision.seen_count + 1"#,
        )
        .bind(&key)
        .bind(d.kind.as_str())
        .bind(&d.account_id)
        .bind(&d.position_id)
        .bind(d.level_before)
        .bind(d.level)
        .bind(d.close_price)
        .bind(d.pnl)
        .bind(d.balance_after)
        .bind(d.credit_after)
        .bind(d.write_off)
        .bind(&d.prices)
        .execute(pool)
        .await;
        if let Err(err) = res {
            tracing::warn!(error = %err, key, "shadow: could not store a decision (kept in memory)");
        }
    }

    /// Every decision recorded in this process, with its sighting count (tests, the harness gate).
    pub fn decisions(&self) -> Vec<(Decision, u32)> {
        let mut v: Vec<_> = self.seen.lock().unwrap().values().cloned().collect();
        v.sort_by(|a, b| (a.0.account_id.clone(), a.0.position_id.clone(), a.0.kind.as_str()).cmp(&(b.0.account_id.clone(), b.0.position_id.clone(), b.0.kind.as_str())));
        v
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rust_decimal_macros::dec;

    fn close(kind: Kind, pos: &str) -> Decision {
        Decision {
            kind,
            account_id: "a".into(),
            position_id: Some(pos.into()),
            level_before: Some(dec!(95)),
            level: Some(dec!(95)),
            close_price: Some(dec!(4280)),
            pnl: Some(dec!(-10)),
            balance_after: Some(dec!(90)),
            credit_after: Some(dec!(0)),
            write_off: None,
            prices: serde_json::json!({}),
        }
    }
    fn edge(kind: Kind) -> Decision {
        Decision { position_id: None, ..close(kind, "") }
    }

    #[test]
    fn only_a_local_database_may_hold_the_store() {
        assert!(is_local_url("postgresql://engine:x@127.0.0.1:5432/market_data"));
        assert!(is_local_url("postgresql://postgres@localhost/shadow"));
        assert!(!is_local_url("postgresql://neondb_owner:x@ep-morning-glade-b23tui1g.c-6.eu-central-1.aws.neon.tech/neondb?sslmode=require"));
        assert!(!is_local_url("postgresql://u:p@10.0.0.5:5432/db"));
    }

    #[tokio::test]
    async fn a_decision_seen_on_every_pass_is_one_record_with_a_count() {
        let r = Recorder::in_memory();
        for _ in 0..5 {
            r.record(close(Kind::StopOut, "p1")).await;
        }
        r.record(close(Kind::StopLoss, "p2")).await;
        let d = r.decisions();
        assert_eq!(d.len(), 2);
        assert_eq!(d.iter().find(|(x, _)| x.position_id.as_deref() == Some("p1")).unwrap().1, 5);
    }

    #[tokio::test]
    async fn margin_call_edges_are_recorded_on_change_only_and_numbered_per_episode() {
        let r = Recorder::in_memory();
        r.record_edge(edge(Kind::MarginCallOut)).await; // never in: nothing to leave
        r.record_edge(edge(Kind::MarginCallIn)).await; // episode 1 in
        r.record_edge(edge(Kind::MarginCallIn)).await; // same episode, every pass
        r.record_edge(edge(Kind::MarginCallOut)).await; // episode 1 out
        r.record_edge(edge(Kind::MarginCallIn)).await; // episode 2 in
        let keys: Vec<String> = r.decisions().iter().map(|(d, _)| d.kind.as_str().to_string()).collect();
        assert_eq!(keys.iter().filter(|k| *k == "margin_call_in").count(), 2);
        assert_eq!(keys.iter().filter(|k| *k == "margin_call_out").count(), 1);
    }
}
