// One-off repair for near-empty W1/MN1/Y1 Candle history.
//
// Root cause (confirmed both by code and by real data -- dev DB currently
// shows M1: 303,192 rows, D1: 9,240 rows, but W1: 78, MN1: 90, Y1: 60):
// the MT5 EA's own history backfill (mt5-ea/VyXTraderPriceFeed.mq5's
// HistoryBackfillPeriods) never included W1/MN1 until the 2026-09-08 EA
// build, and Y1 has no native MT5 period at all -- CopyRates can't fetch
// a yearly bar, ever, from any EA build. Before that fix, all three
// timeframes only ever got a row from the live tick-aggregation path,
// one bucket at a time, exactly as real weeks/months/years happened to
// elapse while the engine was running -- which is why a broker only
// running for a few months has almost nothing at those timeframes.
//
// This script rolls up the (deep, 9,240-row) existing D1 history into
// real W1/MN1/Y1 bars server-side, instead of waiting years for the live
// path to accumulate them naturally, and independently of whether/when
// every broker's EA gets upgraded and force-deep-backfilled (see that
// EA's own updated comment on HistoryBackfillPeriods for that separate
// step, which still matters -- this script's rollup is retroactive
// history, not a live feed, and won't get the CURRENT/still-forming
// bucket at each timeframe, only fully-closed past ones). Weeks/months/
// years are computed as naive UTC calendar periods (Monday-start weeks,
// calendar months, calendar years) -- a small precision gap against the
// live engine's own broker-day-boundary-aware bucketing for a handful of
// symbols near a boundary, acceptable for retroactive historical bars
// the same way the live path's own W1/MN1/Y1 bucketing already treats
// these three as "pre-existing, already-imprecise-by-design naive
// handling" (see engine/market-data/src/lib.rs's bucket_start comment).
//
// Run:  npx tsx scripts/backfill-higher-timeframe-candles.ts [--execute]
// Default is a dry run -- prints what would be written, writes nothing.

import { PrismaClient, CandleTimeframe } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

type Row = { symbol: string; bucketStart: Date; open: string; high: string; low: string; close: string };
type Rollup = { symbol: string; timeframe: CandleTimeframe; bucketStart: Date; open: string; high: string; low: string; close: string };

function weekStartUtc(d: Date): Date {
  const day = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const daysSinceMonday = (day + 6) % 7;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - daysSinceMonday));
}
function monthStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}
function yearStartUtc(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}

function rollup(rows: Row[], timeframe: CandleTimeframe, periodStart: (d: Date) => Date): Rollup[] {
  // Rows come in already ordered by (symbol, bucketStart) -- one pass,
  // carrying the running OHLC for whichever period is currently open.
  const out: Rollup[] = [];
  let current: { key: string; symbol: string; start: Date; open: string; high: number; low: number; close: string } | null = null;

  for (const row of rows) {
    const start = periodStart(row.bucketStart);
    const key = `${row.symbol}:${start.getTime()}`;
    const high = parseFloat(row.high);
    const low = parseFloat(row.low);

    if (!current || current.key !== key) {
      if (current) {
        out.push({ symbol: current.symbol, timeframe, bucketStart: current.start, open: current.open, high: String(current.high), low: String(current.low), close: current.close });
      }
      current = { key, symbol: row.symbol, start, open: row.open, high, low, close: row.close };
    } else {
      current.high = Math.max(current.high, high);
      current.low = Math.min(current.low, low);
      current.close = row.close; // rows are ordered ascending -- last one wins
    }
  }
  if (current) {
    out.push({ symbol: current.symbol, timeframe, bucketStart: current.start, open: current.open, high: String(current.high), low: String(current.low), close: current.close });
  }
  return out;
}

async function main() {
  const d1Rows = await prisma.candle.findMany({
    where: { timeframe: "D1" },
    select: { symbol: true, bucketStart: true, open: true, high: true, low: true, close: true },
    orderBy: [{ symbol: "asc" }, { bucketStart: "asc" }],
  });
  console.log(`D1 rows to roll up: ${d1Rows.length}`);
  if (d1Rows.length === 0) {
    console.log("No D1 history to roll up from -- nothing to do.");
    return;
  }

  const rows: Row[] = d1Rows.map((r) => ({ symbol: r.symbol, bucketStart: r.bucketStart, open: r.open.toString(), high: r.high.toString(), low: r.low.toString(), close: r.close.toString() }));

  const w1 = rollup(rows, "W1", weekStartUtc);
  const mn1 = rollup(rows, "MN1", monthStartUtc);
  const y1 = rollup(rows, "Y1", yearStartUtc);
  const all = [...w1, ...mn1, ...y1];

  console.log(`Computed: W1 ${w1.length}, MN1 ${mn1.length}, Y1 ${y1.length} (${all.length} total rows)`);

  const existing = await prisma.candle.findMany({
    where: { timeframe: { in: ["W1", "MN1", "Y1"] } },
    select: { symbol: true, timeframe: true, bucketStart: true },
  });
  const existingKeys = new Set(existing.map((r) => `${r.symbol}:${r.timeframe}:${r.bucketStart.getTime()}`));
  const newOnly = all.filter((r) => !existingKeys.has(`${r.symbol}:${r.timeframe}:${r.bucketStart.getTime()}`));
  const overwrites = all.length - newOnly.length;
  console.log(`Of those: ${newOnly.length} are genuinely new buckets, ${overwrites} would overwrite a bucket the live path already wrote (upsert -- this rollup's fuller D1-derived OHLC replaces it, same "broker bars beat aggregates" precedence upsert_candles_authoritative_batch already uses elsewhere).`);

  if (!EXECUTE) {
    console.log("\nDry run -- nothing written. Re-run with --execute to apply.");
    console.log("Sample (first 5):", JSON.stringify(all.slice(0, 5), null, 2));
    return;
  }

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < all.length; i += BATCH) {
    const batch = all.slice(i, i + BATCH);
    await prisma.$transaction(
      batch.map((r) =>
        prisma.candle.upsert({
          where: { symbol_timeframe_bucketStart: { symbol: r.symbol, timeframe: r.timeframe, bucketStart: r.bucketStart } },
          create: { symbol: r.symbol, timeframe: r.timeframe, bucketStart: r.bucketStart, open: r.open, high: r.high, low: r.low, close: r.close },
          update: { open: r.open, high: r.high, low: r.low, close: r.close },
        })
      )
    );
    written += batch.length;
    console.log(`  ...${written}/${all.length}`);
  }
  console.log(`\nWritten: ${written}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
