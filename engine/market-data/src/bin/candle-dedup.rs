//! candle-dedup: READ-ONLY dry run of the calendar-candle de-dup (owner 2026-11-05).
//!
//! Reads the "Candle" rows of D1 / W1 / MN1 (and H4, report only), maps every row to the ONE correct broker-period key
//! with the engine's own functions (probe = bucketStart + 2h; key = bucket_start(tf, probe,
//! ny_close_server_offset_sec(probe))), groups by (symbol, timeframe, correct key) and reports what a de-dup WOULD do.
//!
//! It NEVER writes. There is no apply mode in this binary. The session is switched to read-only before anything else
//! and the tool refuses to run if the database does not enforce it.
//!
//! Usage: MARKET_DATA_DATABASE_URL=... candle-dedup [--json]

use chrono::{DateTime, Duration, Timelike, Utc};
use futures_util::TryStreamExt;
use market_data::{bucket_start, ny_close_server_offset_sec, Timeframe};
use rust_decimal::Decimal;
use sqlx::postgres::PgPoolOptions;
use sqlx::Row;
use std::collections::BTreeMap;

/// The correct key (UTC ms) for a stored row, from the engine's own bucket math. The +2h probe lands inside the right
/// broker period for keys stored at offset 0, +2h or +3h.
pub fn correct_key(tf: Timeframe, stored: DateTime<Utc>) -> DateTime<Utc> {
    let probe = stored + Duration::hours(2);
    bucket_start(tf, probe, ny_close_server_offset_sec(probe))
}

type Ohlc = (Decimal, Decimal, Decimal, Decimal);

#[derive(Debug, Clone)]
pub struct Copy1 {
    pub stored: DateTime<Utc>,
    pub ohlc: Ohlc,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Differing {
    pub key: DateTime<Utc>,
    pub copies: Vec<(DateTime<Utc>, Ohlc)>,
}

#[derive(Debug, Default, Clone)]
pub struct Stats {
    pub total_rows: u64,
    pub groups: u64,
    pub groups_with_copies: u64,
    pub would_delete: u64,
    pub would_move: u64,
    pub groups_differing_ohlc: u64,
    pub differing_samples: Vec<Differing>,
    pub by_hour: BTreeMap<u32, u64>,
}

const MAX_SAMPLES: usize = 20;

impl Stats {
    fn add(&mut self, o: &Stats) {
        self.total_rows += o.total_rows;
        self.groups += o.groups;
        self.groups_with_copies += o.groups_with_copies;
        self.would_delete += o.would_delete;
        self.would_move += o.would_move;
        self.groups_differing_ohlc += o.groups_differing_ohlc;
        for (h, n) in &o.by_hour {
            *self.by_hour.entry(*h).or_default() += n;
        }
    }
}

/// Analyze every stored copy of one (symbol, timeframe).
pub fn analyze(tf: Timeframe, rows: &[Copy1]) -> Stats {
    let mut groups: BTreeMap<DateTime<Utc>, Vec<&Copy1>> = BTreeMap::new();
    let mut st = Stats::default();
    for r in rows {
        st.total_rows += 1;
        *st.by_hour.entry(r.stored.hour()).or_default() += 1;
        groups.entry(correct_key(tf, r.stored)).or_default().push(r);
    }
    st.groups = groups.len() as u64;
    for (key, copies) in groups {
        if copies.len() > 1 {
            st.groups_with_copies += 1;
            st.would_delete += copies.len() as u64 - 1;
            if copies.iter().any(|c| c.ohlc != copies[0].ohlc) {
                st.groups_differing_ohlc += 1;
                if st.differing_samples.len() < MAX_SAMPLES {
                    st.differing_samples.push(Differing { key, copies: copies.iter().map(|c| (c.stored, c.ohlc)).collect() });
                }
            }
        } else if copies[0].stored != key {
            st.would_move += 1;
        }
    }
    st
}

fn tf_of(s: &str) -> Option<Timeframe> {
    match s {
        "H4" => Some(Timeframe::H4),
        "D1" => Some(Timeframe::D1),
        "W1" => Some(Timeframe::W1),
        "MN1" => Some(Timeframe::Mn1),
        _ => None,
    }
}

fn hours_text(m: &BTreeMap<u32, u64>) -> String {
    m.iter().map(|(h, n)| format!("{h:02}:00={n}")).collect::<Vec<_>>().join(" ")
}

fn ohlc_text(o: &Ohlc) -> String {
    format!("O{} H{} L{} C{}", o.0, o.1, o.2, o.3)
}

fn stats_json(st: &Stats) -> serde_json::Value {
    serde_json::json!({
        "total_rows": st.total_rows,
        "groups": st.groups,
        "groups_with_copies": st.groups_with_copies,
        "would_delete": st.would_delete,
        "would_move": st.would_move,
        "groups_differing_ohlc": st.groups_differing_ohlc,
        "by_stored_utc_hour": st.by_hour.iter().map(|(h, n)| (format!("{h:02}:00"), *n)).collect::<BTreeMap<_, _>>(),
        "differing_samples": st.differing_samples.iter().map(|d| serde_json::json!({
            "key": d.key.to_rfc3339(),
            "copies": d.copies.iter().map(|(t, o)| serde_json::json!({ "stored": t.to_rfc3339(), "open": o.0.to_string(), "high": o.1.to_string(), "low": o.2.to_string(), "close": o.3.to_string() })).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let json_out = std::env::args().skip(1).any(|a| a == "--json");
    if let Err(msg) = run(json_out).await {
        eprintln!("candle-dedup: {msg}");
        std::process::exit(1);
    }
}

async fn run(json_out: bool) -> Result<(), String> {
    let url = std::env::var("MARKET_DATA_DATABASE_URL").map_err(|_| "MARKET_DATA_DATABASE_URL is not set".to_string())?;
    // One connection, read-only from its first statement; the URL is never printed.
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .after_connect(|conn, _meta| {
            Box::pin(async move {
                sqlx::query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY").execute(&mut *conn).await?;
                Ok(())
            })
        })
        .connect(&url)
        .await
        .map_err(|e| format!("could not connect/set the session read-only: {e}"))?;

    // Prove it: the flag must read back 'on', and a write must be refused.
    let ro: String = sqlx::query_scalar("SHOW transaction_read_only").fetch_one(&pool).await.map_err(|e| format!("read-only check failed: {e}"))?;
    if ro != "on" {
        return Err(format!("the session is not read-only (transaction_read_only = {ro}); refusing to run"));
    }
    if sqlx::query("CREATE TEMP TABLE candle_dedup_ro_probe (x int)").execute(&pool).await.is_ok() {
        return Err("a write statement succeeded in what should be a read-only session; refusing to run".to_string());
    }

    let mut per: Vec<(String, String, Stats)> = Vec::new();
    let mut cur: Option<(String, String)> = None;
    let mut buf: Vec<Copy1> = Vec::new();
    let flush = |cur: &Option<(String, String)>, buf: &mut Vec<Copy1>, per: &mut Vec<(String, String, Stats)>| {
        if let Some((sym, tf)) = cur {
            if let Some(t) = tf_of(tf) {
                per.push((sym.clone(), tf.clone(), analyze(t, buf)));
            }
        }
        buf.clear();
    };

    let mut rows = sqlx::query(
        r#"SELECT symbol, timeframe::text AS tf, "bucketStart" AS bs, open, high, low, close
           FROM "Candle" WHERE timeframe::text IN ('H4','D1','W1','MN1')
           ORDER BY symbol, timeframe::text, "bucketStart""#,
    )
    .fetch(&pool);
    while let Some(r) = rows.try_next().await.map_err(|e| format!("read failed: {e}"))? {
        let symbol: String = r.get("symbol");
        let tf: String = r.get("tf");
        let key = Some((symbol, tf));
        if cur != key {
            flush(&cur, &mut buf, &mut per);
            cur = key;
        }
        let stored: DateTime<Utc> = r.get("bs");
        buf.push(Copy1 { stored, ohlc: (r.get("open"), r.get("high"), r.get("low"), r.get("close")) });
    }
    flush(&cur, &mut buf, &mut per);
    drop(rows);

    let mut totals: BTreeMap<String, Stats> = BTreeMap::new();
    for (_, tf, st) in &per {
        totals.entry(tf.clone()).or_default().add(st);
    }
    let order = ["D1", "W1", "MN1", "H4"];

    if json_out {
        let rows_json: Vec<_> = per.iter().map(|(s, t, st)| {
            let mut v = stats_json(st);
            v["symbol"] = s.clone().into();
            v["timeframe"] = t.clone().into();
            v["report_only"] = (t == "H4").into();
            v
        }).collect();
        let tot: serde_json::Map<String, serde_json::Value> = totals.iter().map(|(t, st)| (t.clone(), stats_json(st))).collect();
        let out = serde_json::json!({ "generated_at": Utc::now().to_rfc3339(), "read_only": true, "per_symbol_timeframe": rows_json, "totals": tot });
        println!("{}", serde_json::to_string_pretty(&out).unwrap());
        return Ok(());
    }

    println!("candle-dedup DRY RUN (read-only; nothing is written). Generated {}", Utc::now().to_rfc3339());
    println!("key = bucket_start(tf, stored+2h, ny_close_server_offset_sec(stored+2h)); H4 is report only.\n");
    println!("{:<12} {:<4} {:>8} {:>8} {:>8} {:>8} {:>8}  stored UTC hours", "symbol", "tf", "rows", "dupGrps", "delete", "move", "ohlcDiff");
    for tf in order {
        for (s, t, st) in per.iter().filter(|(_, t, _)| t == tf) {
            println!("{:<12} {:<4} {:>8} {:>8} {:>8} {:>8} {:>8}  {}", s, t, st.total_rows, st.groups_with_copies, st.would_delete, st.would_move, st.groups_differing_ohlc, hours_text(&st.by_hour));
        }
        println!();
    }
    println!("TOTALS");
    for tf in order {
        if let Some(st) = totals.get(tf) {
            let note = if tf == "H4" { " (report only)" } else { "" };
            println!("{:<4}{} rows={} dupGroups={} wouldDelete={} wouldMove={} ohlcDiffGroups={}  hours: {}", tf, note, st.total_rows, st.groups_with_copies, st.would_delete, st.would_move, st.groups_differing_ohlc, hours_text(&st.by_hour));
        }
    }
    let (mut gd, mut gm, mut gr) = (0, 0, 0);
    for tf in ["D1", "W1", "MN1"] {
        if let Some(st) = totals.get(tf) {
            gd += st.would_delete;
            gm += st.would_move;
            gr += st.total_rows;
        }
    }
    println!("D1+W1+MN1 grand total: rows={gr} wouldDelete={gd} wouldMove={gm}");

    for tf in order {
        let mut shown = 0;
        for (s, t, st) in per.iter().filter(|(_, t, _)| t == tf) {
            for d in &st.differing_samples {
                if shown == 0 {
                    println!("\nGroups whose copies have DIFFERENT OHLC, {tf} (up to {MAX_SAMPLES} per symbol):");
                }
                if shown >= MAX_SAMPLES {
                    break;
                }
                shown += 1;
                println!("  {s} {t} key {}", d.key.to_rfc3339());
                for (stored, o) in &d.copies {
                    println!("      stored {}  {}", stored.to_rfc3339(), ohlc_text(o));
                }
            }
        }
        if shown >= MAX_SAMPLES {
            println!("  (more exist; use --json for up to {MAX_SAMPLES} per symbol/timeframe)");
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn u(y: i32, m: u32, d: u32, h: u32) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(y, m, d, h, 0, 0).unwrap()
    }

    // The cases below are ported from the web's lib/candle-keys.test.ts.

    #[test]
    fn d1_summer_day_three_variants_map_to_2100_the_evening_before() {
        for k in [u(2026, 7, 9, 21), u(2026, 7, 9, 22), u(2026, 7, 10, 0)] {
            assert_eq!(correct_key(Timeframe::D1, k), u(2026, 7, 9, 21), "stored {k}");
        }
    }

    #[test]
    fn d1_winter_day_three_variants_map_to_2200_the_evening_before() {
        for k in [u(2026, 11, 9, 21), u(2026, 11, 9, 22), u(2026, 11, 10, 0)] {
            assert_eq!(correct_key(Timeframe::D1, k), u(2026, 11, 9, 22), "stored {k}");
        }
    }

    #[test]
    fn d1_winter_2025_stored_at_the_summer_offset_moves_to_2200() {
        assert_eq!(correct_key(Timeframe::D1, u(2025, 1, 14, 21)), u(2025, 1, 14, 22));
    }

    #[test]
    fn d1_consecutive_days_stay_apart() {
        assert_eq!(correct_key(Timeframe::D1, u(2026, 7, 10, 21)), u(2026, 7, 10, 21));
    }

    #[test]
    fn w1_week_starts_sunday_midnight_server_time() {
        // Sunday 2026-07-05 00:00 server (UTC+3) = Saturday 2026-07-04 21:00 UTC
        for k in [u(2026, 7, 4, 21), u(2026, 7, 4, 22), u(2026, 7, 5, 0)] {
            assert_eq!(correct_key(Timeframe::W1, k), u(2026, 7, 4, 21), "stored {k}");
        }
    }

    #[test]
    fn mn1_month_starts_on_the_first_midnight_server_time() {
        for k in [u(2026, 1, 31, 21), u(2026, 1, 31, 22), u(2026, 2, 1, 0)] {
            assert_eq!(correct_key(Timeframe::Mn1, k), u(2026, 1, 31, 22), "stored {k}");
        }
    }

    #[test]
    fn a_row_already_on_the_correct_key_maps_to_itself() {
        for (tf, k) in [(Timeframe::D1, u(2026, 7, 9, 21)), (Timeframe::D1, u(2026, 11, 9, 22)), (Timeframe::W1, u(2026, 7, 4, 21)), (Timeframe::Mn1, u(2026, 1, 31, 22))] {
            assert_eq!(correct_key(tf, k), k);
        }
    }

    fn d(n: i64) -> Decimal {
        Decimal::from(n)
    }

    fn copy(stored: DateTime<Utc>, c: i64) -> Copy1 {
        Copy1 { stored, ohlc: (d(1), d(c.max(2)), d(0), d(c)) }
    }

    #[test]
    fn analyze_counts_duplicates_moves_and_differing_ohlc() {
        let rows = vec![
            // winter day with three copies (two agree, one differs)
            copy(u(2026, 11, 9, 21), 5),
            copy(u(2026, 11, 9, 22), 6),
            copy(u(2026, 11, 10, 0), 6),
            // a lone wrong-key row (winter day on the summer offset)
            copy(u(2025, 1, 14, 21), 7),
            // a lone row already right
            copy(u(2026, 7, 9, 21), 8),
            // a two-copy group with identical OHLC
            copy(u(2026, 7, 10, 21), 9),
            copy(u(2026, 7, 11, 0), 9),
        ];
        let st = analyze(Timeframe::D1, &rows);
        assert_eq!(st.total_rows, 7);
        assert_eq!(st.groups, 4);
        assert_eq!(st.groups_with_copies, 2);
        assert_eq!(st.would_delete, 3);
        assert_eq!(st.would_move, 1);
        assert_eq!(st.groups_differing_ohlc, 1);
        assert_eq!(st.differing_samples.len(), 1);
        assert_eq!(st.differing_samples[0].key, u(2026, 11, 9, 22));
        assert_eq!(st.by_hour.get(&21), Some(&4));
        assert_eq!(st.by_hour.get(&22), Some(&1));
        assert_eq!(st.by_hour.get(&0), Some(&2));
    }
}
