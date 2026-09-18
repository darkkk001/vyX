// Read-only integrity report for one symbol's stored candles -- the
// before/after evidence for fix/deep-backfill-full-history
// (deploy/deep-backfill-runbook.md). Prints, per timeframe and per UTC
// day, the signatures of the damage b0d3967 described and the full-history
// EA pass repairs:
//
//   bars        rows stored that day
//   flat        open = high = low = close (a gap fill, or a bucket that
//               received exactly one 1 Hz sample)
//   o=h|l       open equals the high or the low. On its own a weak signal
//               (a trending real bar has this too); it moves DOWN after the
//               repair because a broker bar's extreme is rarely its first
//               tick, while a ~1 Hz point sample's often is.
//   o=prevC     share of bars whose open equals the previous bar's close --
//               a broker M1 series does this rarely (open = first tick of
//               the new minute, close = last tick of the old one, different
//               ticks); the pre-fix path wrote close = the last flush
//               window's OPEN, which is neither.
//   avg_range   mean (high - low). THE number to compare before/after: the
//               pre-fix rows were a ~1 Hz point sample of flush-window
//               opens, so their range is systematically narrower than the
//               broker's tick-true bar. Expect it to go UP on every
//               tick-built day once the pass has run.
//   unaligned   rows whose bucketStart is off the timeframe's grid (the
//               pre-v1.39 EA phantom hh:mm:01 rows; see
//               engine/market-data/src/retention.rs sweep_offgrid_candles).
//               Must be 0 after the sweep.
//   vsM1 wider  higher-timeframe bars (M5..D1) whose high/low is WIDER
//               than the aggregate of the M1 rows spanning them. Both come
//               from the same ticks when both are tick-built, so this is
//               only non-zero where the higher timeframe already holds a
//               broker bar (the EA's shallow/quick pass reaches ~5 days on
//               M5, ~15 on M15, 30+ on M30..D1) while M1 still holds the
//               point sample -- i.e. direct evidence of M1 understatement.
//               Expect 0 after the pass.
//   vsM1 narrower  the opposite (M1 wider than the bar that spans it): a
//               higher-timeframe bar that is itself still a point sample,
//               or a half-open bucket. Expect 0 after the pass.
//   m1cov       higher-timeframe bars that had at least one M1 row under
//               them (the denominator for the two columns above).
//
// Usage (plain node -- no build step, so it runs on the VPS as-is):
//
//   MARKET_DATA_DATABASE_URL=postgres://engine:...@127.0.0.1:5432/market_data \
//     node scripts/candle-integrity-report.mjs XAUUSD [--days=45] [--tf=M1,M5] [--json]
//
// Read-only: every statement is a SELECT. The market-data store is the
// engine's own Postgres (deploy/market_data.sql), NOT Prisma / Neon, hence
// `pg` directly and a dedicated env var; a Neon host is refused unless
// --allow-neon is passed, so this can never be pointed at the trade DB by
// a stale .env. `pg` is resolved from the repo root's node_modules if
// present, else from services/api-gateway's (the one package on the VPS
// that already depends on it), so nothing needs installing there.
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

function loadPg() {
  for (const from of [join(repoRoot, "package.json"), join(repoRoot, "services", "api-gateway", "package.json")]) {
    try {
      return createRequire(from)("pg");
    } catch (err) {
      if (err && err.code !== "MODULE_NOT_FOUND") throw err;
    }
  }
  throw new Error("cannot find the 'pg' package: run `npm ci` in services/api-gateway (or the repo root) first");
}

const TF_SPAN_MS = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };
// = market_data::bucket_is_aligned: M1..H1 on their own grid, everything
// else (broker-offset H4/D1, calendar W1/MN1/Y1) on the whole minute.
const TF_GRID_MS = { M1: 60_000, M5: 300_000, M15: 900_000, M30: 1_800_000, H1: 3_600_000, H4: 60_000, D1: 60_000, W1: 60_000, MN1: 60_000, Y1: 60_000 };
const ALL_TFS = Object.keys(TF_GRID_MS);

function parseArgs(argv) {
  const out = { symbol: null, days: 45, tfs: ALL_TFS, json: false, allowNeon: false };
  for (const a of argv) {
    if (a.startsWith("--days=")) out.days = Math.max(1, parseInt(a.slice(7), 10) || 45);
    else if (a.startsWith("--tf=")) out.tfs = a.slice(5).split(",").map((s) => s.trim().toUpperCase()).filter((s) => ALL_TFS.includes(s));
    else if (a === "--json") out.json = true;
    else if (a === "--allow-neon") out.allowNeon = true;
    else if (!a.startsWith("--") && !out.symbol) out.symbol = a;
  }
  return out;
}

async function perDay(client, symbol, tf, since) {
  // One window pass per timeframe: LAG gives the previous bar's close for
  // the o=prevC column; the alignment predicate is the SQL twin of
  // market_data::bucket_is_aligned (see deploy/market-data-offgrid-cleanup.sql).
  const { rows } = await client.query(
    `
    WITH bars AS (
      SELECT "bucketStart", open, high, low, close,
             LAG(close) OVER (ORDER BY "bucketStart") AS prev_close
      FROM "Candle"
      WHERE symbol = $1 AND timeframe = $2::"CandleTimeframe" AND "bucketStart" >= $3
    )
    SELECT ("bucketStart" AT TIME ZONE 'UTC')::date::text                                  AS day,
           count(*)::int                                                                    AS bars,
           count(*) FILTER (WHERE open = high AND high = low AND low = close)::int          AS flat,
           count(*) FILTER (WHERE open = high OR open = low)::int                           AS open_extreme,
           count(*) FILTER (WHERE prev_close IS NOT NULL AND open = prev_close)::int        AS open_eq_prev_close,
           count(*) FILTER (WHERE prev_close IS NOT NULL)::int                              AS with_prev,
           avg(high - low)::float8                                                          AS avg_range,
           count(*) FILTER (WHERE (EXTRACT(EPOCH FROM "bucketStart") * 1000)::bigint % $4 <> 0)::int AS unaligned
    FROM bars
    GROUP BY 1
    ORDER BY 1
    `,
    [symbol, tf, since, TF_GRID_MS[tf]],
  );
  return rows;
}

async function vsM1(client, symbol, tf, since) {
  // Each higher-timeframe bar against the M1 rows that span it. Fixed
  // spans only (M5..D1): H4/D1 buckets are broker-offset shifted but still
  // exactly 4h/24h long, so [bucketStart, bucketStart + span) is right for
  // them too; W1/MN1 are calendar buckets and are left out.
  const { rows } = await client.query(
    `
    SELECT (h."bucketStart" AT TIME ZONE 'UTC')::date::text AS day,
           count(*) FILTER (WHERE agg.n > 0)::int                                             AS m1cov,
           count(*) FILTER (WHERE agg.n > 0 AND (h.high > agg.hi OR h.low < agg.lo))::int       AS wider,
           count(*) FILTER (WHERE agg.n > 0 AND (h.high < agg.hi OR h.low > agg.lo))::int       AS narrower
    FROM "Candle" h
    CROSS JOIN LATERAL (
      SELECT max(m.high) AS hi, min(m.low) AS lo, count(*) AS n
      FROM "Candle" m
      WHERE m.symbol = h.symbol AND m.timeframe = 'M1'
        AND m."bucketStart" >= h."bucketStart"
        AND m."bucketStart" <  h."bucketStart" + ($4::bigint * interval '1 millisecond')
    ) agg
    WHERE h.symbol = $1 AND h.timeframe = $2::"CandleTimeframe" AND h."bucketStart" >= $3
    GROUP BY 1
    ORDER BY 1
    `,
    [symbol, tf, since, TF_SPAN_MS[tf]],
  );
  return rows;
}

function pct(n, d) {
  return d > 0 ? ((100 * n) / d).toFixed(0).padStart(3) + "%" : "   -";
}

function printTable(tf, days) {
  const cmp = tf !== "M1" && TF_SPAN_MS[tf] !== undefined;
  const head = ["day       ", " bars", " flat", "o=h|l", "o=prevC", "  avg_range", "unalgn"];
  if (cmp) head.push("vsM1:wider", "narrower", " m1cov");
  console.log(`\n== ${tf} ==`);
  console.log(head.join("  "));
  for (const d of days) {
    const line = [
      d.day,
      String(d.bars).padStart(5),
      String(d.flat).padStart(5),
      pct(d.open_extreme, d.bars).padStart(5),
      pct(d.open_eq_prev_close, d.with_prev).padStart(7),
      (d.avg_range == null ? "-" : d.avg_range.toFixed(5)).padStart(11),
      String(d.unaligned).padStart(6),
    ];
    if (cmp) line.push(String(d.wider ?? 0).padStart(10), String(d.narrower ?? 0).padStart(8), String(d.m1cov ?? 0).padStart(6));
    console.log(line.join("  "));
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.symbol) {
    console.error("usage: node scripts/candle-integrity-report.mjs <SYMBOL> [--days=45] [--tf=M1,M5,...] [--json] [--allow-neon]");
    process.exit(2);
  }
  const url = process.env.MARKET_DATA_DATABASE_URL;
  if (!url) {
    console.error("MARKET_DATA_DATABASE_URL is not set (the engine's market-data store, e.g. postgres://engine:...@127.0.0.1:5432/market_data)");
    process.exit(2);
  }
  if (/neon\.tech/i.test(url) && !args.allowNeon) {
    console.error("MARKET_DATA_DATABASE_URL points at a Neon host -- the market-data store is the VPS Postgres; pass --allow-neon if you really mean it");
    process.exit(2);
  }

  const { Client } = loadPg();
  const client = new Client({ connectionString: url, statement_timeout: 300_000 });
  await client.connect();
  try {
    await client.query("SET TIME ZONE 'UTC'");
    const since = new Date(Date.now() - args.days * 86_400_000);
    const report = { symbol: args.symbol, since: since.toISOString(), generatedAt: new Date().toISOString(), timeframes: {} };
    const totals = [];
    for (const tf of args.tfs) {
      const days = await perDay(client, args.symbol, tf, since);
      if (days.length === 0) continue;
      if (TF_SPAN_MS[tf] !== undefined && tf !== "M1") {
        const cmp = await vsM1(client, args.symbol, tf, since);
        const byDay = new Map(cmp.map((r) => [r.day, r]));
        for (const d of days) {
          const c = byDay.get(d.day);
          d.wider = c ? c.wider : 0;
          d.narrower = c ? c.narrower : 0;
          d.m1cov = c ? c.m1cov : 0;
        }
      }
      report.timeframes[tf] = days;
      const sum = (k) => days.reduce((a, d) => a + (d[k] || 0), 0);
      totals.push({ tf, bars: sum("bars"), flat: sum("flat"), unaligned: sum("unaligned"), wider: sum("wider"), narrower: sum("narrower"), m1cov: sum("m1cov") });
      if (!args.json) printTable(tf, days);
    }
    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(`\n== totals for ${args.symbol} since ${since.toISOString().slice(0, 10)} ==`);
      console.log("tf    bars     flat  unaligned  vsM1:wider  narrower  m1cov");
      for (const t of totals) {
        console.log(`${t.tf.padEnd(4)} ${String(t.bars).padStart(6)} ${String(t.flat).padStart(8)} ${String(t.unaligned).padStart(10)} ${String(t.wider).padStart(11)} ${String(t.narrower).padStart(9)} ${String(t.m1cov).padStart(6)}`);
      }
      if (totals.length === 0) console.log(`no rows for ${args.symbol} in the last ${args.days} days`);
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
