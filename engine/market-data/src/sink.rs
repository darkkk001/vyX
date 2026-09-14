//! Where market data (Candle / LivePrice) is persisted -- the Neon→VPS
//! candle migration's stage S1 (docs/market-data.md §"VPS market-data
//! store").
//!
//! Until now the engine had exactly one Postgres (`DATABASE_URL`, Neon)
//! and every tick flush landed there, which is what kept the Neon
//! endpoint awake 24/7 (~500 k Candle rows + a LivePrice upsert every
//! 250 ms per symbol). The migration moves that traffic to a Postgres on
//! the same box as the engine; trade data (accounts, orders, positions,
//! ledger, alerts, notifications) stays on Neon untouched.
//!
//! Two env vars drive it, both optional, so a box that sets neither
//! behaves exactly as before:
//!
//! * `MARKET_DATA_DATABASE_URL` -- the local Postgres. When unset there is
//!   no local pool and the mode is forced to `neon`.
//! * `MARKET_DATA_WRITE` -- `neon` (default; writes to Neon only),
//!   `both` (dual-write: every flush / gap-fill / history backfill /
//!   retention pass runs against Neon AND local -- the soak mode, either
//!   side can be verified against the other), or `local` (Neon no longer
//!   written; the endpoint can suspend -- stage S5).
//!
//! Reads (`GET /internal/candles`, the order path's DB fallback for a
//! price) come from the local pool whenever it is configured, regardless
//! of the write mode -- in `both` the local store is a full copy after
//! the one-time dump restore, so reading it early is how S3 verifies it
//! symbol by symbol while Neon still carries the writes.
//!
//! Failure semantics in `both`: a flush counts as successful only when
//! every target succeeded; otherwise the batch is re-marked dirty and
//! retried next cycle (every write is an idempotent upsert -- Candle
//! merges with GREATEST/LEAST, LivePrice replaces -- so re-applying a
//! batch that already landed on one side is harmless). Each side keeps
//! its own success / failure / lag counters in `/internal/feed-stats`
//! (`db_*` = Neon, `local_db_*` = local) so a failing local disk shows up
//! without hiding behind a healthy Neon.

use sqlx::postgres::PgPoolOptions;
use sqlx::PgPool;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum WriteMode {
    Neon,
    Both,
    Local,
}

impl WriteMode {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim().to_ascii_lowercase().as_str() {
            "neon" => Some(Self::Neon),
            "both" | "dual" => Some(Self::Both),
            "local" | "vps" => Some(Self::Local),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Neon => "neon",
            Self::Both => "both",
            Self::Local => "local",
        }
    }
}

/// Which persistence target a write went to -- the stats counters and
/// the rate-limited log lines name the side that failed.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SinkName {
    Neon,
    Local,
}

impl SinkName {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Neon => "neon",
            Self::Local => "local",
        }
    }
}

pub struct MarketDataPools {
    neon: PgPool,
    local: Option<PgPool>,
    mode: WriteMode,
}

impl MarketDataPools {
    /// A mode that needs the local pool but has none falls back to
    /// `neon` with a loud log line rather than starting an engine that
    /// silently drops every candle.
    pub fn new(neon: PgPool, local: Option<PgPool>, mode: WriteMode) -> Self {
        let mode = match (mode, local.is_some()) {
            (WriteMode::Neon, _) => WriteMode::Neon,
            (m, true) => m,
            (m, false) => {
                tracing::error!(
                    requested = m.as_str(),
                    "MARKET_DATA_WRITE needs MARKET_DATA_DATABASE_URL -- falling back to neon-only writes"
                );
                WriteMode::Neon
            }
        };
        Self { neon, local, mode }
    }

    /// Reads `MARKET_DATA_DATABASE_URL` / `MARKET_DATA_WRITE`; the local
    /// pool is connected here (lazily by sqlx -- a wrong URL surfaces as
    /// the first flush's failure counter, not a boot panic, so a typo in
    /// the env cannot take the price feed down).
    pub async fn from_env(neon: PgPool, max_connections: u32) -> Self {
        let local = match std::env::var("MARKET_DATA_DATABASE_URL") {
            Ok(url) if !url.trim().is_empty() => match PgPoolOptions::new()
                .max_connections(max_connections)
                .acquire_timeout(std::time::Duration::from_secs(5))
                .connect_lazy(url.trim())
            {
                Ok(pool) => Some(pool),
                Err(err) => {
                    tracing::error!(?err, "MARKET_DATA_DATABASE_URL is not a valid Postgres URL -- ignoring it");
                    None
                }
            },
            _ => None,
        };
        let mode = match std::env::var("MARKET_DATA_WRITE") {
            Ok(raw) if !raw.trim().is_empty() => match WriteMode::parse(&raw) {
                Some(m) => m,
                None => {
                    tracing::error!(value = %raw, "MARKET_DATA_WRITE must be neon | both | local -- using neon");
                    WriteMode::Neon
                }
            },
            _ => WriteMode::Neon,
        };
        let pools = Self::new(neon, local, mode);
        tracing::info!(
            write_mode = pools.mode.as_str(),
            local_pool = pools.local.is_some(),
            reader = pools.reader_name(),
            "market-data persistence configured"
        );
        pools
    }

    pub fn mode(&self) -> WriteMode {
        self.mode
    }

    pub fn has_local(&self) -> bool {
        self.local.is_some()
    }

    /// The pools every market-data write must reach for the flush to
    /// count as successful, in the order they are attempted.
    pub fn targets(&self) -> Vec<(SinkName, &PgPool)> {
        match (self.mode, &self.local) {
            (WriteMode::Neon, _) | (WriteMode::Both, None) | (WriteMode::Local, None) => vec![(SinkName::Neon, &self.neon)],
            (WriteMode::Both, Some(local)) => vec![(SinkName::Neon, &self.neon), (SinkName::Local, local)],
            (WriteMode::Local, Some(local)) => vec![(SinkName::Local, local)],
        }
    }

    /// Where `GET /internal/candles` (and any other market-data read)
    /// goes: the local store whenever one is configured.
    pub fn reader(&self) -> &PgPool {
        self.local.as_ref().unwrap_or(&self.neon)
    }

    pub fn reader_name(&self) -> &'static str {
        if self.local.is_some() {
            "local"
        } else {
            "neon"
        }
    }

    /// The Neon pool itself -- trade-data reads that must stay on Neon
    /// (nothing in this crate should need it besides the constructor).
    pub fn neon(&self) -> &PgPool {
        &self.neon
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_modes_case_insensitively_with_aliases() {
        assert_eq!(WriteMode::parse("neon"), Some(WriteMode::Neon));
        assert_eq!(WriteMode::parse(" BOTH "), Some(WriteMode::Both));
        assert_eq!(WriteMode::parse("dual"), Some(WriteMode::Both));
        assert_eq!(WriteMode::parse("Local"), Some(WriteMode::Local));
        assert_eq!(WriteMode::parse("vps"), Some(WriteMode::Local));
        assert_eq!(WriteMode::parse("all"), None);
        assert_eq!(WriteMode::parse(""), None);
    }

    fn lazy_pool() -> PgPool {
        // connect_lazy never touches the network (it only needs a Tokio
        // context), so a fake URL is enough to exercise target selection
        // without a running Postgres
        PgPoolOptions::new().connect_lazy("postgres://u:p@127.0.0.1:1/x").unwrap()
    }

    #[tokio::test]
    async fn neon_only_when_no_local_pool_whatever_the_mode() {
        for mode in [WriteMode::Neon, WriteMode::Both, WriteMode::Local] {
            let pools = MarketDataPools::new(lazy_pool(), None, mode);
            assert_eq!(pools.mode(), WriteMode::Neon);
            let names: Vec<_> = pools.targets().into_iter().map(|(n, _)| n).collect();
            assert_eq!(names, vec![SinkName::Neon]);
            assert_eq!(pools.reader_name(), "neon");
        }
    }

    #[tokio::test]
    async fn both_writes_neon_then_local_and_reads_local() {
        let pools = MarketDataPools::new(lazy_pool(), Some(lazy_pool()), WriteMode::Both);
        let names: Vec<_> = pools.targets().into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec![SinkName::Neon, SinkName::Local]);
        assert_eq!(pools.reader_name(), "local");
    }

    #[tokio::test]
    async fn local_mode_never_touches_neon() {
        let pools = MarketDataPools::new(lazy_pool(), Some(lazy_pool()), WriteMode::Local);
        let names: Vec<_> = pools.targets().into_iter().map(|(n, _)| n).collect();
        assert_eq!(names, vec![SinkName::Local]);
        assert_eq!(pools.reader_name(), "local");
    }
}
