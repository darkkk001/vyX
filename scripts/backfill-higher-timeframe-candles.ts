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
// bucket at each timeframe, only fully-closed past ones).
//
// Broker-boundary-aligned, not naive UTC (2026-09-08 revision) -- weeks/
// months/years are bucketed with the exact same shift-floor-shift-back
// formula as engine/market-data/src/lib.rs's bucket_start (W1/Mn1/Y1
// branches): shift by the broker offset, find the naive boundary in that
// shifted frame, shift back. The first version of this script used plain
// naive-UTC calendar periods, which for any broker with a real nonzero
// offset (Pepperstone: +3) computes a DIFFERENT grid than the live
// engine does -- the exact same "two competing grids" bug already fixed
// for D1 (fix-broker-day-candles.ts) and H4 (fix-broker-h4-candles.ts).
// Landing on the live grid instead means these rows are immediately
// correct, not a second parallel history to dedupe again later.
//
// Also dedupes the existing legacy W1/MN1/Y1 rows the live tick path
// already wrote at the OLD naive-UTC grid, before this fix -- same
// merge/fold logic as the D1/H4 dedup scripts: a legacy row whose own
// bucketStart doesn't match its broker-aligned bucket is either merged
// (deleted, if a broker-aligned row already covers that period -- from
// this run's own rollup or a prior one) or folded (renamed to the
// broker-aligned instant, if nothing else covers that period yet). Runs
// AFTER the rollup upsert, so the rollup's fuller D1-derived OHLC is
// already in place as the thing legacy rows get folded into or merged
// against -- never the other way around.
//
// The offset is REQUIRED, never inferred -- same rule as every sibling
// script in this directory (fix-broker-day-candles.ts, fix-broker-h4-
// candles.ts, fix-broker-time-candles.ts).
//
// Run:  npx tsx scripts/backfill-higher-timeframe-candles.ts --offset-hours=3 [--execute]
// Default is a dry run -- prints what would be written, writes nothing.

import { PrismaClient, CandleTimeframe, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

type Row = { symbol: string; bucketStart: Date; open: string; high: string; low: string; close: string };
type Rollup = { symbol: string; timeframe: CandleTimeframe; bucketStart: Date; open: string; high: string; low: string; close: string };

function parseOffsetHours(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--offset-hours="));
  if (!arg) return null;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

// Mirrors lib.rs's bucket_start W1/Mn1/Y1 branches exactly: shift by the
// broker offset, find the naive boundary in that shifted (broker-local)
// frame, shift back to real UTC.
function weekStartBrokerAligned(d: Date, offsetMs: number): Date {
  const shifted = new Date(d.getTime() + offsetMs);
  const daysSinceMonday = (shifted.getUTCDay() + 6) % 7; // getUTCDay: 0=Sun..6=Sat
  const mondayLocalMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate() - daysSinceMonday);
  return new Date(mondayLocalMs - offsetMs);
}
function monthStartBrokerAligned(d: Date, offsetMs: number): Date {
  const shifted = new Date(d.getTime() + offsetMs);
  const firstOfMonthLocalMs = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1);
  return new Date(firstOfMonthLocalMs - offsetMs);
}
function yearStartBrokerAligned(d: Date, offsetMs: number): Date {
  const shifted = new Date(d.getTime() + offsetMs);
  const firstOfYearLocalMs = Date.UTC(shifted.getUTCFullYear(), 0, 1);
  return new Date(firstOfYearLocalMs - offsetMs);
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
  const offsetHours = parseOffsetHours();
  if (offsetHours === null) {
    console.error(
      "Refusing to run without --offset-hours=<n>.\n" +
        "Get the real value from the terminal the bars came from:\n" +
        "  TimeTradeServer() - TimeGMT()   (mt5-ea's BrokerOffsetSec, sent as server_offset_sec/broker_offset_sec)\n" +
        "For Pepperstone this is 3 (or 2 during their DST window -- check live, don't assume).\n" +
        "Example: npx tsx scripts/backfill-higher-timeframe-candles.ts --offset-hours=3 --execute"
    );
    process.exitCode = 1;
    return;
  }
  const offsetMs = offsetHours * 3_600_000;
  console.log(`--offset-hours=${offsetHours}\n`);

  const alignedStart: Record<"W1" | "MN1" | "Y1", (d: Date) => Date> = {
    W1: (d) => weekStartBrokerAligned(d, offsetMs),
    MN1: (d) => monthStartBrokerAligned(d, offsetMs),
    Y1: (d) => yearStartBrokerAligned(d, offsetMs),
  };

  // ---------- Phase 1: roll up D1 into broker-aligned W1/MN1/Y1 ----------

  const d1Rows = await prisma.candle.findMany({
    where: { timeframe: "D1" },
    select: { symbol: true, bucketStart: true, open: true, high: true, low: true, close: true },
    orderBy: [{ symbol: "asc" }, { bucketStart: "asc" }],
  });
  console.log(`D1 rows to roll up: ${d1Rows.length}`);
  if (d1Rows.length === 0) {
    console.log("No D1 history to roll up from -- skipping rollup, still checking legacy dedup below.");
  }

  const rows: Row[] = d1Rows.map((r) => ({ symbol: r.symbol, bucketStart: r.bucketStart, open: r.open.toString(), high: r.high.toString(), low: r.low.toString(), close: r.close.toString() }));

  const w1 = rollup(rows, "W1", alignedStart.W1);
  const mn1 = rollup(rows, "MN1", alignedStart.MN1);
  const y1 = rollup(rows, "Y1", alignedStart.Y1);
  const rollupRows = [...w1, ...mn1, ...y1];

  console.log(`Computed (broker-aligned): W1 ${w1.length}, MN1 ${mn1.length}, Y1 ${y1.length} (${rollupRows.length} total rows)`);

  const existingBefore = await prisma.candle.findMany({
    where: { timeframe: { in: ["W1", "MN1", "Y1"] } },
    select: { symbol: true, timeframe: true, bucketStart: true },
  });
  const existingKeys = new Set(existingBefore.map((r) => `${r.symbol}:${r.timeframe}:${r.bucketStart.getTime()}`));
  const newOnly = rollupRows.filter((r) => !existingKeys.has(`${r.symbol}:${r.timeframe}:${r.bucketStart.getTime()}`));
  const rollupOverwrites = rollupRows.length - newOnly.length;
  console.log(
    `Of those: ${newOnly.length} are genuinely new buckets, ${rollupOverwrites} land on a bucket a row already exists at (upsert -- this rollup's fuller D1-derived OHLC replaces it, same "broker bars beat aggregates" precedence upsert_candles_authoritative_batch already uses elsewhere).`
  );

  // ---------- Phase 2: dedupe legacy naive-grid W1/MN1/Y1 rows ----------
  //
  // Every row that existed BEFORE this run (existingBefore) that sits at
  // a bucketStart different from its own broker-aligned bucket is a
  // leftover from the old naive-UTC live-tick path. Classified exactly
  // like fix-broker-day-candles.ts/fix-broker-h4-candles.ts: merged
  // (deleted) if the broker-aligned bucket is already covered -- by this
  // run's own rollup, or a prior real one -- folded (renamed) otherwise,
  // so a period with no D1 coverage still keeps its only OHLC rather than
  // losing it outright.
  const rollupKeys = new Set(rollupRows.map((r) => `${r.symbol}:${r.timeframe}:${r.bucketStart.getTime()}`));
  // Union of "will exist after phase 1" -- every pre-existing row (phase 1
  // only ever upserts, never deletes, so all of them survive) plus every
  // rollup row phase 1 is about to write.
  const postRollupKeys = new Set([...existingKeys, ...rollupKeys]);

  type LegacyRow = { symbol: string; timeframe: "W1" | "MN1" | "Y1"; bucketStart: Date };
  const legacyMisaligned: LegacyRow[] = [];
  for (const row of existingBefore) {
    const tf = row.timeframe as "W1" | "MN1" | "Y1";
    const aligned = alignedStart[tf](row.bucketStart);
    if (aligned.getTime() !== row.bucketStart.getTime()) {
      legacyMisaligned.push({ symbol: row.symbol, timeframe: tf, bucketStart: row.bucketStart });
    }
  }

  const toMerge: LegacyRow[] = []; // broker-aligned bucket already covered -- delete this one
  const toFold: { row: LegacyRow; to: Date }[] = []; // nothing covers it -- rename to broker-aligned
  for (const row of legacyMisaligned) {
    const aligned = alignedStart[row.timeframe](row.bucketStart);
    const alignedKey = `${row.symbol}:${row.timeframe}:${aligned.getTime()}`;
    if (postRollupKeys.has(alignedKey)) {
      toMerge.push(row);
    } else {
      toFold.push({ row, to: aligned });
      postRollupKeys.add(alignedKey); // claim it so a second orphan can't also fold onto the same spot
    }
  }

  console.log(`\nLegacy pre-existing W1/MN1/Y1 rows: ${existingBefore.length}`);
  console.log(`Legacy rows sitting on the OLD naive grid (misaligned): ${legacyMisaligned.length}`);
  const mergedBySymbolTf = new Map<string, number>();
  for (const r of toMerge) mergedBySymbolTf.set(r.timeframe, (mergedBySymbolTf.get(r.timeframe) ?? 0) + 1);
  const foldedBySymbolTf = new Map<string, number>();
  for (const { row } of toFold) foldedBySymbolTf.set(row.timeframe, (foldedBySymbolTf.get(row.timeframe) ?? 0) + 1);
  console.log(`  merged (deleted, broker-aligned row already covers it): ${toMerge.length} -- ${[...mergedBySymbolTf.entries()].map(([tf, n]) => `${tf}:${n}`).join(", ") || "none"}`);
  console.log(`  folded (renamed to the broker-aligned bucket, nothing else covers it): ${toFold.length} -- ${[...foldedBySymbolTf.entries()].map(([tf, n]) => `${tf}:${n}`).join(", ") || "none"}`);

  console.log(`\n=== TOTAL WRITES IF EXECUTED ===`);
  console.log(`Rollup upserts     : ${rollupRows.length} (${newOnly.length} new, ${rollupOverwrites} overwritten)`);
  console.log(`Legacy merges (deletes): ${toMerge.length}`);
  console.log(`Legacy folds (renames) : ${toFold.length}`);

  if (!EXECUTE) {
    console.log("\nDry run -- nothing written. Re-run with --execute to apply.");
    console.log("Sample rollup rows (first 5):", JSON.stringify(rollupRows.slice(0, 5), null, 2));
    console.log("Sample legacy merges (first 5):", JSON.stringify(toMerge.slice(0, 5), null, 2));
    console.log("Sample legacy folds (first 5):", JSON.stringify(toFold.slice(0, 5), null, 2));
    return;
  }

  let written = 0;
  const BATCH = 500;
  for (let i = 0; i < rollupRows.length; i += BATCH) {
    const batch = rollupRows.slice(i, i + BATCH);
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
    console.log(`  ...rollup ${written}/${rollupRows.length}`);
  }

  const mergedBySymbol = new Map<string, Date[]>();
  for (const r of toMerge) {
    const key = `${r.symbol}:${r.timeframe}`;
    const pending = mergedBySymbol.get(key) ?? [];
    pending.push(r.bucketStart);
    mergedBySymbol.set(key, pending);
  }
  let deleted = 0;
  for (const [key, bucketStarts] of mergedBySymbol) {
    const [symbol, timeframe] = key.split(":");
    await prisma.candle.deleteMany({ where: { symbol, timeframe: timeframe as CandleTimeframe, bucketStart: { in: bucketStarts } } });
    deleted += bucketStarts.length;
  }
  console.log(`Deleted (merged legacy rows): ${deleted}`);

  let renamed = 0;
  let skippedCollision = 0;
  for (const { row, to } of toFold) {
    try {
      await prisma.candle.update({
        where: { symbol_timeframe_bucketStart: { symbol: row.symbol, timeframe: row.timeframe, bucketStart: row.bucketStart } },
        data: { bucketStart: to },
      });
      renamed += 1;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        // Two different legacy rows converged on the same broker-aligned
        // bucket -- vanishingly unlikely, reported rather than silently dropped.
        skippedCollision += 1;
        continue;
      }
      throw err;
    }
  }
  console.log(`Renamed (folded legacy rows): ${renamed}`);
  if (skippedCollision > 0) console.log(`Skipped (collision): ${skippedCollision}`);

  console.log(`\nDone.`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
