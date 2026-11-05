//! candle-dedup: dry run (default, READ-ONLY) and APPLY (`--apply`) of the calendar-candle de-dup (owner 2026-11-05).
//!
//! Reads the "Candle" rows of D1 / W1 / MN1 (and H4, report only), maps every row to the ONE correct broker-period key
//! with the engine's own functions (probe = bucketStart + 2h; key = bucket_start(tf, probe,
//! ny_close_server_offset_sec(probe))), groups by (symbol, timeframe, correct key) and reports what a de-dup WOULD do.
//!
//! WITHOUT `--apply` it NEVER writes: the session is switched to read-only before anything else and the tool refuses to
//! run if the database does not enforce it.
//!
//! WITH `--apply` (D1 / W1 / MN1 only, H4 never): refuses unless env CANDLE_DEDUP_CONFIRM is exactly "I have a pg_dump".
//! Per symbol, ONE transaction:
//!   - a group of copies of one correct key keeps the row ON the key, else the newest; every other copy is deleted ONLY if
//!     its open/high/low/close EXACTLY equal the kept row's; otherwise the whole group is skipped and listed;
//!   - a lone row on a wrong key is moved to its key, only if that key is empty (a kept row that was not on the key is moved
//!     the same way once its copies are gone, so a second run finds nothing to do).
//! Prints the counts per symbol / timeframe. Idempotent: a second run changes nothing.
//!
//! Usage: MARKET_DATA_DATABASE_URL=... candle-dedup [--json]
//!        MARKET_DATA_DATABASE_URL=... CANDLE_DEDUP_CONFIRM="I have a pg_dump" candle-dedup --apply

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

/// What an apply does for one (symbol, timeframe): rows to delete (exact copies), rows to move (stored -> key), and the
/// groups skipped because their copies disagree on OHLC (listed, never touched).
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Plan {
    pub deletes: Vec<DateTime<Utc>>,
    pub moves: Vec<(DateTime<Utc>, DateTime<Utc>)>,
    pub skipped: Vec<Differing>,
}

/// The apply plan. Pure: the same grouping as `analyze`.
pub fn plan(tf: Timeframe, rows: &[Copy1]) -> Plan {
    let mut groups: BTreeMap<DateTime<Utc>, Vec<&Copy1>> = BTreeMap::new();
    for r in rows {
        groups.entry(correct_key(tf, r.stored)).or_default().push(r);
    }
    let mut p = Plan::default();
    for (key, copies) in groups {
        if copies.len() == 1 {
            if copies[0].stored != key {
                p.moves.push((copies[0].stored, key));
            }
            continue;
        }
        // keep the row on the correct key, else the newest
        let kept = copies.iter().find(|c| c.stored == key).copied().unwrap_or_else(|| copies.iter().max_by_key(|c| c.stored).copied().unwrap());
        if copies.iter().any(|c| c.ohlc != kept.ohlc) {
            p.skipped.push(Differing { key, copies: copies.iter().map(|c| (c.stored, c.ohlc)).collect() });
            continue;
        }
        p.deletes.extend(copies.iter().filter(|c| c.stored != kept.stored).map(|c| c.stored));
        if kept.stored != key {
            p.moves.push((kept.stored, key));
        }
    }
    p
}

const CONFIRM_TEXT: &str = "I have a pg_dump";

/// Counts one symbol/timeframe apply produced.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct Applied {
    pub deleted: u64,
    pub moved: u64,
    pub skipped_groups: u64,
    pub move_blocked: u64,
}

/// Apply one symbol (D1, W1, MN1) in ONE transaction. Returns per timeframe counts and the skipped groups.
pub async fn apply_symbol(pool: &sqlx::PgPool, symbol: &str) -> Result<Vec<(&'static str, Applied, Vec<Differing>)>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let mut out = Vec::new();
    for (name, tf) in [("D1", Timeframe::D1), ("W1", Timeframe::W1), ("MN1", Timeframe::Mn1)] {
        let fetched = sqlx::query(
            r#"SELECT "bucketStart" AS bs, open, high, low, close FROM "Candle"
               WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" ORDER BY "bucketStart" FOR UPDATE"#,
        )
        .bind(symbol)
        .bind(name)
        .fetch_all(&mut *tx)
        .await?;
        let rows: Vec<Copy1> = fetched.iter().map(|r| Copy1 { stored: r.get("bs"), ohlc: (r.get("open"), r.get("high"), r.get("low"), r.get("close")) }).collect();
        let p = plan(tf, &rows);
        let mut a = Applied { skipped_groups: p.skipped.len() as u64, ..Applied::default() };
        if !p.deletes.is_empty() {
            let res = sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" AND "bucketStart" = ANY($3)"#)
                .bind(symbol)
                .bind(name)
                .bind(&p.deletes)
                .execute(&mut *tx)
                .await?;
            a.deleted = res.rows_affected();
        }
        for (from, to) in &p.moves {
            // only into an empty key
            let res = sqlx::query(
                r#"UPDATE "Candle" SET "bucketStart" = $4
                   WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" AND "bucketStart" = $3
                     AND NOT EXISTS (SELECT 1 FROM "Candle" c WHERE c.symbol = $1 AND c.timeframe = $2::"CandleTimeframe" AND c."bucketStart" = $4)"#,
            )
            .bind(symbol)
            .bind(name)
            .bind(from)
            .bind(to)
            .execute(&mut *tx)
            .await?;
            if res.rows_affected() == 1 {
                a.moved += 1;
            } else {
                a.move_blocked += 1;
            }
        }
        out.push((name, a, p.skipped));
    }
    tx.commit().await?;
    Ok(out)
}

/// The confirm guard, separated so a test can drive it.
fn confirmed(value: Option<&str>) -> Result<(), String> {
    if value != Some(CONFIRM_TEXT) {
        return Err(format!("--apply refused: set CANDLE_DEDUP_CONFIRM to exactly \"{CONFIRM_TEXT}\" once a pg_dump of the database exists"));
    }
    Ok(())
}

async fn run_apply() -> Result<(), String> {
    confirmed(std::env::var("CANDLE_DEDUP_CONFIRM").ok().as_deref())?;
    let url = std::env::var("MARKET_DATA_DATABASE_URL").map_err(|_| "MARKET_DATA_DATABASE_URL is not set".to_string())?;
    let pool = PgPoolOptions::new().max_connections(1).connect(&url).await.map_err(|e| format!("could not connect: {e}"))?;
    let symbols: Vec<String> = sqlx::query_scalar(r#"SELECT DISTINCT symbol FROM "Candle" WHERE timeframe::text IN ('D1','W1','MN1') ORDER BY symbol"#)
        .fetch_all(&pool)
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    println!("candle-dedup APPLY (D1 / W1 / MN1 only; H4 untouched). {} symbols. Generated {}", symbols.len(), Utc::now().to_rfc3339());
    println!("{:<12} {:<4} {:>8} {:>8} {:>10} {:>10}", "symbol", "tf", "deleted", "moved", "skipGroups", "moveBlock");
    let (mut td, mut tm, mut ts, mut tb) = (0, 0, 0, 0);
    let mut skipped_all: Vec<(String, &'static str, Vec<Differing>)> = Vec::new();
    for sym in &symbols {
        let res = apply_symbol(&pool, sym).await.map_err(|e| format!("{sym}: the transaction failed and was rolled back: {e}"))?;
        for (tf, a, skipped) in res {
            println!("{:<12} {:<4} {:>8} {:>8} {:>10} {:>10}", sym, tf, a.deleted, a.moved, a.skipped_groups, a.move_blocked);
            td += a.deleted;
            tm += a.moved;
            ts += a.skipped_groups;
            tb += a.move_blocked;
            if !skipped.is_empty() {
                skipped_all.push((sym.clone(), tf, skipped));
            }
        }
    }
    println!("\nTOTAL deleted={td} moved={tm} skippedGroups={ts} moveBlocked={tb}");
    for (sym, tf, groups) in skipped_all {
        println!("\nSKIPPED {sym} {tf} (copies differ in OHLC; left untouched):");
        for d in groups {
            println!("  key {}", d.key.to_rfc3339());
            for (stored, o) in &d.copies {
                println!("      stored {}  {}", stored.to_rfc3339(), ohlc_text(o));
            }
        }
    }
    Ok(())
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
    let apply = std::env::args().skip(1).any(|a| a == "--apply");
    let result = if apply { run_apply().await } else { run(json_out).await };
    if let Err(msg) = result {
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

    #[test]
    fn plan_deletes_exact_copies_skips_differing_groups_and_moves_lone_rows() {
        let same = |stored: DateTime<Utc>| Copy1 { stored, ohlc: (d(1), d(9), d(0), d(5)) };
        let rows = vec![
            // winter day: 3 exact copies, the one ON the key (22:00) is kept
            same(u(2026, 11, 9, 21)),
            same(u(2026, 11, 9, 22)),
            same(u(2026, 11, 10, 0)),
            // two copies, none on the key (22:00): newest kept, then moved to the key
            same(u(2025, 1, 14, 21)),
            same(u(2025, 1, 15, 0)),
            // a differing group is skipped whole
            copy(u(2026, 7, 10, 21), 5),
            copy(u(2026, 7, 11, 0), 6),
            // a lone wrong-key row moves; a lone right one stays
            copy(u(2025, 2, 12, 21), 7),
            copy(u(2026, 7, 9, 21), 8),
        ];
        let p = plan(Timeframe::D1, &rows);
        assert_eq!(p.deletes, vec![u(2025, 1, 14, 21), u(2026, 11, 9, 21), u(2026, 11, 10, 0)]);
        assert_eq!(p.moves, vec![(u(2025, 1, 15, 0), u(2025, 1, 14, 22)), (u(2025, 2, 12, 21), u(2025, 2, 12, 22))]);
        assert_eq!(p.skipped.len(), 1);
        assert_eq!(p.skipped[0].key, u(2026, 7, 10, 21));
        // after the plan is applied in memory, a second plan is empty (idempotent)
        let mut after: Vec<Copy1> = rows.iter().filter(|r| !p.deletes.contains(&r.stored)).cloned().collect();
        for (from, to) in &p.moves {
            after.iter_mut().find(|r| r.stored == *from).unwrap().stored = *to;
        }
        let again = plan(Timeframe::D1, &after);
        assert!(again.deletes.is_empty() && again.moves.is_empty());
        assert_eq!(again.skipped.len(), 1, "the differing group stays listed until a human decides");
    }

    #[test]
    fn apply_refuses_without_the_exact_confirm_text() {
        assert!(confirmed(None).is_err());
        assert!(confirmed(Some("")).is_err());
        assert!(confirmed(Some("i have a pg_dump")).is_err());
        assert!(confirmed(Some("I have a pg_dump ")).is_err());
        assert!(confirmed(Some("I have a pg_dump")).is_ok());
    }

    // ---- scratch-database tests (skipped unless MARKET_DATA_TEST_LOCAL_URL points at a database with the "Candle" table)

    async fn scratch() -> Option<sqlx::PgPool> {
        let url = std::env::var("MARKET_DATA_TEST_LOCAL_URL").ok()?;
        PgPoolOptions::new().max_connections(2).connect(&url).await.ok()
    }

    async fn put(pool: &sqlx::PgPool, symbol: &str, tf: &str, at: DateTime<Utc>, close: i64) {
        sqlx::query(
            r#"INSERT INTO "Candle" (symbol, timeframe, "bucketStart", open, high, low, close, "updatedAt")
               VALUES ($1, $2::"CandleTimeframe", $3, 1, $4, 0, $5, now())"#,
        )
        .bind(symbol)
        .bind(tf)
        .bind(at)
        .bind(Decimal::from(close.max(2)))
        .bind(Decimal::from(close))
        .execute(pool)
        .await
        .unwrap();
    }

    async fn stored(pool: &sqlx::PgPool, symbol: &str, tf: &str) -> Vec<DateTime<Utc>> {
        sqlx::query_scalar(r#"SELECT "bucketStart" FROM "Candle" WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" ORDER BY "bucketStart""#)
            .bind(symbol)
            .bind(tf)
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn apply_on_scratch_deletes_exact_copies_skips_differing_moves_a_lone_row_leaves_h4_and_is_idempotent() {
        let Some(pool) = scratch().await else { return };
        let sym = format!("TESTDD{}", Utc::now().timestamp_millis() % 1_000_000);
        let cleanup = || sqlx::query(r#"DELETE FROM "Candle" WHERE symbol = $1"#).bind(&sym).execute(&pool);
        cleanup().await.unwrap();
        // D1: winter day, exact copies at 21:00 / 22:00 (key) / 00:00
        for h in [(9, 21), (9, 22), (10, 0)] {
            put(&pool, &sym, "D1", u(2026, 11, h.0, h.1), 5).await;
        }
        // D1: summer day, copies that DIFFER
        put(&pool, &sym, "D1", u(2026, 7, 10, 21), 5).await;
        put(&pool, &sym, "D1", u(2026, 7, 11, 0), 6).await;
        // D1: a lone winter-2025 row on the summer offset moves to 22:00
        put(&pool, &sym, "D1", u(2025, 1, 14, 21), 7).await;
        // H4: two rows an hour apart (the DST day) must stay untouched
        put(&pool, &sym, "H4", u(2026, 11, 1, 5), 3).await;
        put(&pool, &sym, "H4", u(2026, 11, 1, 6), 3).await;

        let first = apply_symbol(&pool, &sym).await.unwrap();
        let d1 = first.iter().find(|r| r.0 == "D1").unwrap();
        assert_eq!((d1.1.deleted, d1.1.moved, d1.1.skipped_groups, d1.1.move_blocked), (2, 1, 1, 0));
        assert_eq!(stored(&pool, &sym, "D1").await, vec![u(2025, 1, 14, 22), u(2026, 7, 10, 21), u(2026, 7, 11, 0), u(2026, 11, 9, 22)]);
        assert_eq!(stored(&pool, &sym, "H4").await, vec![u(2026, 11, 1, 5), u(2026, 11, 1, 6)], "H4 is never touched");

        let second = apply_symbol(&pool, &sym).await.unwrap();
        let d1 = second.iter().find(|r| r.0 == "D1").unwrap();
        assert_eq!((d1.1.deleted, d1.1.moved, d1.1.move_blocked), (0, 0, 0), "a second run changes nothing");
        assert_eq!(d1.1.skipped_groups, 1, "the differing group is still listed");
        cleanup().await.unwrap();
    }
}
