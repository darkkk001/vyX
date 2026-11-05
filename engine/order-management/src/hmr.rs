//! HMR plugin (high margin requirement windows) and the per-position margin leverage, owner spec 2026-11-06.
//!
//! The same rules as the web's `lib/hmr.ts`, pinned by `docs/contracts/leverage-hmr-vectors.json` (tests/gate_parity.rs):
//!
//! - While `Broker.hmrEnabled` is on and an enabled `HmrWindow` for currency X is active (`startsAt <= now < endsAt`), a NEW
//!   position on a symbol in X's correlation list opens with effective leverage
//!   `min(account leverage, group maximum, HMR leverage of every active window touching the symbol)`.
//! - That figure is the leverage of the open's margin check and, when it is below the account's, is stored on the position
//!   (`Position.openLeverage`). The position keeps its margin at that leverage until it closes, also after the window ends
//!   (owner decision Q1). Existing positions are never touched.
//! - Margin everywhere is per position: `position.openLeverage ?? account.leverage` (`calc::used_margin`).
//!
//! The engine must run before AND after the web migration that adds the columns and tables, so every read here is guarded the
//! way `book::amount_columns` is: an absent column / table means "HMR off, no open leverage", never an error.

use chrono::{DateTime, Utc};
use sqlx::PgPool;
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HmrWindow {
    pub currency: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: DateTime<Utc>,
    pub leverage: u32,
    /// HmrWindow.enabled; a disabled window never applies (the loader reads enabled rows only, active_windows checks it too)
    pub enabled: bool,
}

/// One broker's plugin state: the switch, the enabled windows that have not ended yet (active and upcoming), and the
/// per-currency symbol lists.
#[derive(Debug, Clone, Default)]
pub struct HmrState {
    pub enabled: bool,
    pub windows: Vec<HmrWindow>,
    pub symbols_by_currency: HashMap<String, HashSet<String>>,
}

/// The window that set a figure (the lowest leverage among the active windows touching the symbol).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HmrBinding {
    pub currency: String,
    pub ends_at: DateTime<Utc>,
    pub leverage: u32,
    pub symbol: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OpenLeverage {
    /// the leverage the open's margin check uses
    pub leverage: u32,
    /// what to store on the position: the effective leverage when it is below the account's, else None (= the account's)
    pub open_leverage: Option<u32>,
    /// the window behind `leverage`, None when HMR did not lower it
    pub hmr: Option<HmrBinding>,
}

/// Windows in effect for `symbol` at `now`, lowest leverage first (ties: the one ending last).
pub fn active_windows<'a>(state: &'a HmrState, symbol: &str, now: DateTime<Utc>) -> Vec<&'a HmrWindow> {
    if !state.enabled {
        return Vec::new();
    }
    let mut out: Vec<&HmrWindow> = state
        .windows
        .iter()
        .filter(|w| w.enabled && w.starts_at <= now && now < w.ends_at && state.symbols_by_currency.get(&w.currency).is_some_and(|s| s.contains(symbol)))
        .collect();
    out.sort_by(|a, b| a.leverage.cmp(&b.leverage).then(b.ends_at.cmp(&a.ends_at)));
    out
}

/// The effective leverage for a NEW position. `group_max` None = no group ceiling.
pub fn effective_open_leverage(account_leverage: u32, group_max: Option<u32>, state: &HmrState, symbol: &str, now: DateTime<Utc>) -> OpenLeverage {
    let base = group_max.map_or(account_leverage, |g| account_leverage.min(g));
    let windows = active_windows(state, symbol, now);
    let lowest = windows.first();
    let leverage = lowest.map_or(base, |w| base.min(w.leverage));
    let hmr = lowest.filter(|w| w.leverage < base).map(|w| HmrBinding { currency: w.currency.clone(), ends_at: w.ends_at, leverage: w.leverage, symbol: symbol.to_string() });
    OpenLeverage { leverage, open_leverage: if leverage < account_leverage { Some(leverage) } else { None }, hmr }
}

/// "HMR in effect for USD until 14:30 UTC: leverage 1:20 on new XAUUSD positions" (the web's hmrRefusalText).
pub fn refusal_text(h: &HmrBinding) -> String {
    format!("HMR in effect for {} until {} UTC: leverage 1:{} on new {} positions", h.currency, h.ends_at.format("%H:%M"), h.leverage, h.symbol)
}

/// The sentence a margin refusal carries when a window set the order's leverage (the plain wording the web's
/// plain-error gives the code, then the window). A reason that names the window is a sentence, not a bare code.
pub fn margin_refusal_with_hmr(code: &str, h: &HmrBinding) -> String {
    let base = if code == "INSUFFICIENT_BALANCE" { "Not enough balance for this order." } else { "Not enough free margin for this order." };
    format!("{base} {}.", refusal_text(h))
}

// ---- reads -----------------------------------------------------------------------------------------------------------

/// How long one broker's state is served from memory. Window EDGES are judged against the clock at each call (the cache holds
/// the windows, not "is one active"), so only an EDIT lags, by at most this; the open path pays no round trip in between.
const CACHE_TTL: Duration = Duration::from_secs(2);

static CACHE: Mutex<Option<HashMap<String, (Instant, Arc<HmrState>)>>> = Mutex::new(None);
/// (Some(true), _) = the columns and tables exist (cached for good); (Some(false), at) = absent, re-checked every 30 s.
static SCHEMA: Mutex<(Option<bool>, Option<Instant>)> = Mutex::new((None, None));

/// Drops every cached state (tests; an admin edit in this process).
pub fn reset_cache() {
    *CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    *SCHEMA.lock().unwrap_or_else(|e| e.into_inner()) = (None, None);
}

async fn schema_present(pool: &PgPool) -> bool {
    let cached = *SCHEMA.lock().unwrap_or_else(|e| e.into_inner());
    match cached {
        (Some(true), _) => return true,
        (Some(false), Some(at)) if at.elapsed() < Duration::from_secs(30) => return false,
        _ => {}
    }
    let found: Result<(i64,), _> = sqlx::query_as(
        r#"SELECT (SELECT count(*) FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'Broker' AND column_name = 'hmrEnabled')
                + (SELECT count(*) FROM information_schema.tables WHERE table_schema = current_schema() AND table_name IN ('HmrWindow', 'HmrCorrelation'))"#,
    )
    .fetch_one(pool)
    .await;
    match found {
        Ok((3,)) => {
            *SCHEMA.lock().unwrap_or_else(|e| e.into_inner()) = (Some(true), None);
            tracing::info!("HMR plugin tables present: HMR windows are honoured");
            true
        }
        Ok(_) => {
            *SCHEMA.lock().unwrap_or_else(|e| e.into_inner()) = (Some(false), Some(Instant::now()));
            false
        }
        Err(err) => {
            tracing::warn!(?err, "HMR schema check failed: reading without HMR this time");
            false
        }
    }
}

async fn read_state(pool: &PgPool, broker_id: &str, now: DateTime<Utc>) -> Result<HmrState, sqlx::Error> {
    let enabled: Option<bool> = sqlx::query_scalar(r#"SELECT "hmrEnabled" FROM "Broker" WHERE id = $1"#).bind(broker_id).fetch_optional(pool).await?;
    if enabled != Some(true) {
        return Ok(HmrState::default());
    }
    let windows: Vec<(String, DateTime<Utc>, DateTime<Utc>, i32)> = sqlx::query_as(
        r#"SELECT currency, "startsAt", "endsAt", leverage FROM "HmrWindow" WHERE "brokerId" = $1 AND enabled AND "endsAt" > $2"#,
    )
    .bind(broker_id)
    .bind(now)
    .fetch_all(pool)
    .await?;
    let correlations: Vec<(String, Vec<String>)> = sqlx::query_as(r#"SELECT currency, symbols FROM "HmrCorrelation" WHERE "brokerId" = $1"#).bind(broker_id).fetch_all(pool).await?;
    Ok(HmrState {
        enabled: true,
        windows: windows
            .into_iter()
            .map(|(currency, starts_at, ends_at, leverage)| HmrWindow { currency, starts_at, ends_at, leverage: leverage.max(1) as u32, enabled: true })
            .collect(),
        symbols_by_currency: correlations.into_iter().map(|(c, s)| (c, s.into_iter().collect())).collect(),
    })
}

/// The broker's HMR state, from memory when read within the last 2 s. A database without the plugin's tables is "off". A failed
/// read serves the last state this process saw (never silently drops a window it knew about), else "off", and logs.
pub async fn load_state(pool: &PgPool, broker_id: &str, now: DateTime<Utc>) -> Arc<HmrState> {
    {
        let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((at, state)) = guard.as_ref().and_then(|m| m.get(broker_id)) {
            if at.elapsed() < CACHE_TTL {
                return state.clone();
            }
        }
    }
    if !schema_present(pool).await {
        return Arc::new(HmrState::default());
    }
    match read_state(pool, broker_id, now).await {
        Ok(state) => {
            let state = Arc::new(state);
            CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(HashMap::new).insert(broker_id.to_string(), (Instant::now(), state.clone()));
            state
        }
        Err(err) => {
            tracing::error!(?err, broker_id, "HMR state read failed: serving the last known state");
            let guard = CACHE.lock().unwrap_or_else(|e| e.into_inner());
            guard.as_ref().and_then(|m| m.get(broker_id)).map(|(_, s)| s.clone()).unwrap_or_default()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(h: u32, m: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 6, h, m, 0).unwrap()
    }
    fn state(windows: Vec<HmrWindow>, usd: &[&str]) -> HmrState {
        HmrState { enabled: true, windows, symbols_by_currency: HashMap::from([("USD".to_string(), usd.iter().map(|s| s.to_string()).collect())]) }
    }
    fn w(currency: &str, from: DateTime<Utc>, to: DateTime<Utc>, leverage: u32) -> HmrWindow {
        HmrWindow { currency: currency.to_string(), starts_at: from, ends_at: to, leverage, enabled: true }
    }

    #[test]
    fn no_window_means_the_account_leverage() {
        let r = effective_open_leverage(500, Some(500), &HmrState::default(), "XAUUSD", at(13, 0));
        assert_eq!(r, OpenLeverage { leverage: 500, open_leverage: None, hmr: None });
    }

    #[test]
    fn an_active_window_lowers_and_stores_the_leverage() {
        let s = state(vec![w("USD", at(13, 0), at(14, 30), 20)], &["XAUUSD"]);
        let r = effective_open_leverage(500, Some(500), &s, "XAUUSD", at(13, 30));
        assert_eq!(r.leverage, 20);
        assert_eq!(r.open_leverage, Some(20));
        assert_eq!(refusal_text(r.hmr.as_ref().unwrap()), "HMR in effect for USD until 14:30 UTC: leverage 1:20 on new XAUUSD positions");
    }

    #[test]
    fn window_edges_start_inclusive_end_exclusive() {
        let s = state(vec![w("USD", at(13, 0), at(14, 0), 20)], &["XAUUSD"]);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(12, 59)).leverage, 500);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(13, 0)).leverage, 20);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(13, 59)).leverage, 20);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(14, 0)).leverage, 500);
    }

    #[test]
    fn overlapping_windows_the_lowest_wins() {
        let mut s = state(vec![w("USD", at(13, 0), at(15, 0), 50), w("USD", at(13, 30), at(14, 0), 10)], &["XAUUSD"]);
        s.symbols_by_currency.insert("EUR".into(), HashSet::from(["XAUUSD".to_string()]));
        s.windows.push(w("EUR", at(13, 0), at(16, 0), 30));
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(13, 15)).leverage, 30);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(13, 45)).leverage, 10);
        assert_eq!(effective_open_leverage(500, None, &s, "XAUUSD", at(14, 30)).leverage, 30);
    }

    #[test]
    fn a_symbol_outside_the_map_and_a_disabled_plugin_are_unaffected() {
        let s = state(vec![w("USD", at(13, 0), at(14, 0), 20)], &["XAUUSD"]);
        assert_eq!(effective_open_leverage(500, None, &s, "EURGBP", at(13, 30)).leverage, 500);
        let mut off = s.clone();
        off.enabled = false;
        assert_eq!(effective_open_leverage(500, None, &off, "XAUUSD", at(13, 30)).leverage, 500);
    }

    #[test]
    fn a_window_above_the_account_leverage_changes_nothing_and_the_group_maximum_caps() {
        let s = state(vec![w("USD", at(13, 0), at(14, 0), 200)], &["XAUUSD"]);
        let r = effective_open_leverage(100, Some(100), &s, "XAUUSD", at(13, 30));
        assert_eq!(r, OpenLeverage { leverage: 100, open_leverage: None, hmr: None });
        // an account above its group (legacy data) is held to the group's maximum
        let r2 = effective_open_leverage(1000, Some(500), &HmrState::default(), "XAUUSD", at(13, 30));
        assert_eq!(r2, OpenLeverage { leverage: 500, open_leverage: Some(500), hmr: None });
    }
}
