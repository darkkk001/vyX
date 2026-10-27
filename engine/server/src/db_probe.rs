//! Book database probe (incident 2026-10-27 11:02-11:30 UTC: the neondb_owner password was reset, the database refused
//! every NEW connection for ~28 minutes, and every health check stayed green: /health never touched the database, and
//! the engine logged nothing because the connections it already held kept working).
//!
//! So the probe opens a NEW connection each time (DATABASE_URL, exactly what a restart or a pool refill would do) and
//! runs `SELECT 1`, within PROBE_TIMEOUT. A pooled connection would have answered fine all through the incident.
//!
//! - Every PROBE_EVERY, in a background task (not per request), so the failure is logged even when nobody calls /health.
//! - Only while the idle gate allows (something ticked within RELOAD_QUIET_SECS), or while the last probe failed (so the
//!   recovery is seen): a probe every 10 s all weekend would keep Neon from ever suspending.
//! - GET /health reads the last result: down = 503 with `{"status":"down","db":"down",...}`; otherwise 200 "ok" exactly
//!   as before, plus `x-vyx-db: ok | idle | starting`.
//! - Logging: ERROR on the first failure, again every LOG_REPEAT while it lasts, one WARN when it is back.

use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sqlx::Connection;

pub const PROBE_EVERY: Duration = Duration::from_secs(10);
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(2);
pub const LOG_REPEAT: Duration = Duration::from_secs(60);
/// No probe result for this long while the probe should be running = the probe itself is stuck: reported as down.
pub const STALE_AFTER: Duration = Duration::from_secs(30);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Failure {
    /// The database refused the credentials (the 10-27 incident).
    Auth,
    /// No connection: DNS, TCP, TLS.
    Unreachable,
    /// No answer within PROBE_TIMEOUT.
    Timeout,
    Other,
}

impl Failure {
    pub fn as_str(self) -> &'static str {
        match self {
            Failure::Auth => "auth",
            Failure::Unreachable => "unreachable",
            Failure::Timeout => "timeout",
            Failure::Other => "error",
        }
    }
}

pub fn classify(e: &sqlx::Error) -> Failure {
    match e {
        sqlx::Error::Database(d) => {
            let code = d.code();
            if matches!(code.as_deref(), Some("28P01") | Some("28000")) || d.message().contains("password authentication failed") {
                Failure::Auth
            } else {
                Failure::Other
            }
        }
        sqlx::Error::Io(_) | sqlx::Error::Tls(_) => Failure::Unreachable,
        sqlx::Error::PoolTimedOut => Failure::Timeout,
        other if other.to_string().contains("password authentication failed") => Failure::Auth,
        _ => Failure::Other,
    }
}

/// What /health reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Reading {
    /// No probe has finished yet (the first runs at start-up; the engine only starts when its pool connected).
    Starting,
    Ok,
    /// The idle gate is closed and the last probe was good: not probed now.
    Idle,
    Down { failure: Failure, secs: u64 },
    /// The probe should be running but has produced nothing for STALE_AFTER.
    Stale,
}

/// What the caller logs after a probe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Log {
    Raise(Failure),
    Repeat { failure: Failure, secs: u64 },
    Recovered { secs: u64 },
}

#[derive(Default)]
struct State {
    checked: Option<Instant>,
    idle: bool,
    down: Option<(Failure, Instant)>,
    last_log: Option<Instant>,
}

#[derive(Default)]
pub struct Probe {
    state: Mutex<State>,
}

impl Probe {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Whether a probe should run now: the gate is open, or the database is (or was last seen) down, or never checked.
    pub fn due(&self, gate_open: bool) -> bool {
        let s = self.lock();
        gate_open || s.down.is_some() || s.checked.is_none()
    }

    /// The gate is closed and no probe ran: the last good result stands, marked idle.
    pub fn skipped(&self, now: Instant) {
        let mut s = self.lock();
        if s.down.is_none() {
            s.idle = true;
            s.checked = Some(now);
        }
    }

    /// Records one probe's result; returns what to log (rate-limited).
    pub fn record(&self, result: Result<(), Failure>, now: Instant) -> Option<Log> {
        let mut s = self.lock();
        s.checked = Some(now);
        s.idle = false;
        match (result, s.down) {
            (Ok(()), None) => None,
            (Ok(()), Some((_, since))) => {
                s.down = None;
                s.last_log = Some(now);
                Some(Log::Recovered { secs: now.duration_since(since).as_secs() })
            }
            (Err(f), None) => {
                s.down = Some((f, now));
                s.last_log = Some(now);
                Some(Log::Raise(f))
            }
            (Err(f), Some((_, since))) => {
                s.down = Some((f, since));
                if s.last_log.map_or(true, |t| now.duration_since(t) >= LOG_REPEAT) {
                    s.last_log = Some(now);
                    Some(Log::Repeat { failure: f, secs: now.duration_since(since).as_secs() })
                } else {
                    None
                }
            }
        }
    }

    pub fn reading(&self, now: Instant) -> Reading {
        let s = self.lock();
        match (s.checked, s.down) {
            (None, _) => Reading::Starting,
            (Some(_), Some((failure, since))) => Reading::Down { failure, secs: now.duration_since(since).as_secs() },
            (Some(t), None) if now.duration_since(t) > STALE_AFTER => Reading::Stale,
            (Some(_), None) if s.idle => Reading::Idle,
            (Some(_), None) => Reading::Ok,
        }
    }
}

impl Reading {
    /// The `x-vyx-db` header value.
    pub fn header(self) -> String {
        match self {
            Reading::Starting => "starting".into(),
            Reading::Ok => "ok".into(),
            Reading::Idle => "idle".into(),
            Reading::Down { failure, secs } => format!("down reason={} secs={secs}", failure.as_str()),
            Reading::Stale => "down reason=probe-stale".into(),
        }
    }

    /// The 503 body when the database is down; None = healthy (/health answers 200 "ok" as before).
    pub fn down_body(self) -> Option<String> {
        match self {
            Reading::Down { failure, secs } => Some(format!(r#"{{"status":"down","db":"down","reason":"{}","down_secs":{secs}}}"#, failure.as_str())),
            Reading::Stale => Some(r#"{"status":"down","db":"down","reason":"probe-stale"}"#.to_string()),
            _ => None,
        }
    }
}

static PROBE: OnceLock<std::sync::Arc<Probe>> = OnceLock::new();

/// The running probe's reading; None when no probe was started (tests, or a process without a book database).
pub fn reading() -> Option<Reading> {
    PROBE.get().map(|p| p.reading(Instant::now()))
}

/// One attempt: a NEW connection and `SELECT 1`, closed again.
async fn attempt(database_url: &str) -> Result<(), Failure> {
    let run = async {
        let mut c = sqlx::PgConnection::connect(database_url).await?;
        sqlx::query("SELECT 1").execute(&mut c).await?;
        let _ = c.close().await;
        Ok::<(), sqlx::Error>(())
    };
    match tokio::time::timeout(PROBE_TIMEOUT, run).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(e)) => {
            let f = classify(&e);
            // the error text names the user and the host at most, never the password
            tracing::debug!(reason = f.as_str(), error = %e, "db probe attempt failed");
            Err(f)
        }
        Err(_) => Err(Failure::Timeout),
    }
}

fn log(entry: Log) {
    match entry {
        Log::Raise(f) => tracing::error!(
            reason = f.as_str(),
            "DB PROBE: the book database refuses NEW connections ({}): /health answers 503; the connections already held keep working until they are replaced, a restart would not come back",
            f.as_str()
        ),
        Log::Repeat { failure, secs } => tracing::error!(reason = failure.as_str(), down_secs = secs, "DB PROBE: still down ({}) for {secs} s", failure.as_str()),
        Log::Recovered { secs } => tracing::warn!(down_secs = secs, "DB PROBE: the book database accepts new connections again after {secs} s"),
    }
}

/// Starts the probe task and registers it for /health. `gate_open` is asked before every probe.
pub fn spawn(database_url: String, gate_open: impl Fn() -> bool + Send + Sync + 'static) -> std::sync::Arc<Probe> {
    let probe = std::sync::Arc::new(Probe::new());
    let _ = PROBE.set(probe.clone());
    let p = probe.clone();
    tokio::spawn(async move {
        loop {
            let now = Instant::now();
            if p.due(gate_open()) {
                let result = attempt(&database_url).await;
                if let Some(entry) = p.record(result, Instant::now()) {
                    log(entry);
                }
            } else {
                p.skipped(now);
            }
            tokio::time::sleep(PROBE_EVERY).await;
        }
    });
    probe
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_failure_raises_once_repeats_every_minute_and_recovers_once() {
        let p = Probe::new();
        let t0 = Instant::now();
        assert_eq!(p.reading(t0), Reading::Starting);
        assert_eq!(p.record(Ok(()), t0), None);
        assert_eq!(p.reading(t0), Reading::Ok);
        let t1 = t0 + Duration::from_secs(10);
        assert_eq!(p.record(Err(Failure::Auth), t1), Some(Log::Raise(Failure::Auth)));
        assert_eq!(p.reading(t1 + Duration::from_secs(5)), Reading::Down { failure: Failure::Auth, secs: 5 });
        // every 10 s, but logged again only after a minute
        for i in 1..6 {
            assert_eq!(p.record(Err(Failure::Auth), t1 + Duration::from_secs(10 * i)), None, "probe {i}");
        }
        assert_eq!(p.record(Err(Failure::Auth), t1 + Duration::from_secs(60)), Some(Log::Repeat { failure: Failure::Auth, secs: 60 }));
        assert_eq!(p.record(Ok(()), t1 + Duration::from_secs(70)), Some(Log::Recovered { secs: 70 }));
        assert_eq!(p.reading(t1 + Duration::from_secs(70)), Reading::Ok);
        assert_eq!(p.record(Ok(()), t1 + Duration::from_secs(80)), None);
    }

    #[test]
    fn a_closed_gate_skips_the_probe_only_while_the_database_was_good() {
        let p = Probe::new();
        let t0 = Instant::now();
        assert!(p.due(false), "the first probe always runs");
        p.record(Ok(()), t0);
        assert!(!p.due(false));
        assert!(p.due(true));
        p.skipped(t0 + Duration::from_secs(10));
        assert_eq!(p.reading(t0 + Duration::from_secs(10)), Reading::Idle);
        p.record(Err(Failure::Unreachable), t0 + Duration::from_secs(20));
        assert!(p.due(false), "down: keep probing with the gate closed, so the recovery is seen");
        p.skipped(t0 + Duration::from_secs(30));
        assert_eq!(p.reading(t0 + Duration::from_secs(30)), Reading::Down { failure: Failure::Unreachable, secs: 10 }, "a skip never hides a failure");
    }

    #[test]
    fn a_probe_that_stops_reporting_reads_as_down() {
        let p = Probe::new();
        let t0 = Instant::now();
        p.record(Ok(()), t0);
        assert_eq!(p.reading(t0 + STALE_AFTER), Reading::Ok);
        assert_eq!(p.reading(t0 + STALE_AFTER + Duration::from_secs(1)), Reading::Stale);
        assert!(Reading::Stale.down_body().is_some());
    }

    #[test]
    fn header_and_body() {
        assert_eq!(Reading::Ok.header(), "ok");
        assert_eq!(Reading::Idle.header(), "idle");
        assert_eq!(Reading::Down { failure: Failure::Auth, secs: 42 }.header(), "down reason=auth secs=42");
        assert_eq!(Reading::Ok.down_body(), None);
        assert_eq!(Reading::Idle.down_body(), None);
        assert_eq!(Reading::Starting.down_body(), None);
        let body = Reading::Down { failure: Failure::Auth, secs: 42 }.down_body().unwrap();
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["db"], "down");
        assert_eq!(v["reason"], "auth");
        assert_eq!(v["down_secs"], 42);
    }

    #[tokio::test]
    async fn a_refused_connection_fails_within_the_timeout() {
        let t = Instant::now();
        let r = attempt("postgres://nobody:secret-password@127.0.0.1:1/none").await;
        // Linux refuses at once (unreachable); Windows retries a refused connect for ~2 s (then the timeout answers)
        assert!(matches!(r, Err(Failure::Unreachable) | Err(Failure::Timeout)), "{r:?}");
        assert!(t.elapsed() <= PROBE_TIMEOUT + Duration::from_millis(500));
    }

    #[tokio::test]
    async fn a_server_that_accepts_and_never_answers_is_a_timeout_at_two_seconds() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((s, _)) = listener.accept().await {
                held.push(s);
            }
        });
        let t = Instant::now();
        let r = attempt(&format!("postgres://nobody:x@{addr}/none?sslmode=disable")).await;
        assert_eq!(r, Err(Failure::Timeout));
        assert!(t.elapsed() >= PROBE_TIMEOUT && t.elapsed() <= PROBE_TIMEOUT + Duration::from_millis(500));
    }

    /// A real refusal of the credentials (the 10-27 incident): VYX_TEST_PG_URL = a reachable Postgres (e.g. the local
    /// scratch server); the test swaps the password for a wrong one.
    #[tokio::test]
    async fn a_wrong_password_is_auth() {
        let Ok(url) = std::env::var("VYX_TEST_PG_URL") else {
            eprintln!("VYX_TEST_PG_URL not set: skipped");
            return;
        };
        let mut u = url.parse::<url_lite::Url>().expect("VYX_TEST_PG_URL");
        u.set_password("definitely-not-the-password");
        assert_eq!(attempt(&u.to_string()).await, Err(Failure::Auth));
        assert_eq!(attempt(&url).await, Ok(()));
    }

    /// Enough of a URL to swap the password (no url crate in this workspace).
    mod url_lite {
        pub struct Url {
            head: String,
            user: String,
            rest: String,
        }
        impl std::str::FromStr for Url {
            type Err = &'static str;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                let (head, tail) = s.split_once("://").ok_or("no scheme")?;
                let (auth, rest) = tail.split_once('@').ok_or("no user")?;
                let user = auth.split(':').next().unwrap_or_default().to_string();
                Ok(Url { head: head.to_string(), user, rest: rest.to_string() })
            }
        }
        impl Url {
            pub fn set_password(&mut self, pw: &str) {
                self.user = format!("{}:{pw}", self.user.split(':').next().unwrap_or_default());
            }
        }
        impl std::fmt::Display for Url {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}://{}@{}", self.head, self.user, self.rest)
            }
        }
    }
}
