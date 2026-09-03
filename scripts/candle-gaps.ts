// fix/realtime-sync §4's acceptance script: for a symbol+timeframe over
// the last N days, prints every market-hour bucket with no Candle row at
// all. Run via `npx tsx scripts/candle-gaps.ts [symbol] [timeframe]
// [days] [--broker-offset-hours=<n>]` (all positional args optional --
// defaults match the acceptance test's own example: XAUUSD H1 over 30
// days). Exit code 0 = no gaps, 1 = gaps found (or a usage/connection
// error).
//
// "Market-hour" mirrors engine/market-data/src/gap_fill.rs's own
// market_closed() exactly (Friday 21:00 UTC through Sunday 22:00 UTC is
// a real close, not a gap -- round-2 hotfix moved this from 22:00 to
// 21:00, the DST-safe bound) -- this script and the engine must agree on
// what counts as "missing" or every real weekend would print as false
// positives on an H1 run.
//
// --broker-offset-hours: D1 (and only D1 -- M1..H4 have no calendar-day
// concept, see engine/market-data/src/lib.rs's own bucket_start doc
// comment) now buckets at the broker's own day boundary, not naive UTC
// midnight, once fix/d1-broker-day-boundary's engine change is deployed
// -- e.g. 21:00 UTC for a UTC+3 broker, not 00:00. Without this flag, a
// D1 check grids naive UTC midnight and every real bucket (all sitting
// at 21:00) shows up as "missing," a false alarm across the whole range,
// not a real gap. Same "never inferred, always explicit" rule as
// scripts/fix-broker-day-candles.ts's own --offset-hours.
import { PrismaClient, CandleTimeframe } from "@prisma/client";

const FIXED_MS: Record<string, number> = {
  M1: 60_000,
  M5: 300_000,
  M30: 1_800_000,
  H1: 3_600_000,
  H4: 14_400_000,
  D1: 86_400_000,
};

function marketClosed(t: Date): boolean {
  const day = t.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const hour = t.getUTCHours();
  if (day === 6) return true; // Saturday, all day
  if (day === 5) return hour >= 21; // Friday from 21:00 UTC
  if (day === 0) return hour < 22; // Sunday before 22:00 UTC
  return false;
}

// Mirrors engine/market-data/src/lib.rs's broker_day_start exactly: the
// UTC instant of the broker's own most recent midnight <= `now`.
function brokerDayStart(now: number, offsetMs: number): number {
  const shifted = new Date(now + offsetMs);
  const brokerLocalMidnight = Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate());
  return brokerLocalMidnight - offsetMs;
}

function expectedBuckets(timeframe: string, stepMs: number, from: Date, to: Date, brokerOffsetMs: number): Date[] {
  const buckets: Date[] = [];
  if (timeframe === "D1" && brokerOffsetMs !== 0) {
    // Walk broker-day boundaries directly rather than floor-dividing by
    // stepMs -- the phase (where a boundary falls) shifts with the
    // offset, but consecutive boundaries are still exactly stepMs apart
    // (a day is always 24h in ms terms; only which INSTANT counts as
    // "midnight" moves), so stepping from the first one is exact.
    let t = brokerDayStart(from.getTime(), brokerOffsetMs);
    if (t < from.getTime()) t += stepMs;
    for (; t < to.getTime(); t += stepMs) {
      const bucket = new Date(t);
      if (!marketClosed(bucket)) buckets.push(bucket);
    }
    return buckets;
  }
  const start = Math.ceil(from.getTime() / stepMs) * stepMs;
  for (let t = start; t < to.getTime(); t += stepMs) {
    const bucket = new Date(t);
    if (!marketClosed(bucket)) buckets.push(bucket);
  }
  return buckets;
}

function parseBrokerOffsetHours(): number {
  const arg = process.argv.find((a) => a.startsWith("--broker-offset-hours="));
  if (!arg) return 0;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) ? value : 0;
}

async function main() {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const symbol = positional[0] ?? "XAUUSD";
  const timeframe = positional[1] ?? "H1";
  const days = Number(positional[2] ?? "30");
  const brokerOffsetHours = parseBrokerOffsetHours();
  const brokerOffsetMs = brokerOffsetHours * 3_600_000;

  const stepMs = FIXED_MS[timeframe];
  if (!stepMs || !(timeframe in CandleTimeframe)) {
    console.error(`Unrecognized timeframe "${timeframe}" -- expected one of ${Object.keys(FIXED_MS).join(", ")} (W1/MN1/Y1 are calendar-based and not checked by this script, same as engine/market-data/src/gap_fill.rs's own exclusion).`);
    process.exit(1);
  }
  const timeframeEnum = timeframe as CandleTimeframe;

  if (timeframe === "D1" && brokerOffsetMs === 0) {
    console.warn(
      "Warning: checking D1 with no --broker-offset-hours -- if this broker's D1 candles are bucketed at its own day boundary (not UTC midnight, see engine/market-data/src/lib.rs's bucket_start), every real bucket will show up as \"missing\" here. Pass e.g. --broker-offset-hours=3 for a UTC+3 broker."
    );
  }

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.candle.findMany({
      where: { symbol, timeframe: timeframeEnum, bucketStart: { gte: from, lt: to } },
      select: { bucketStart: true },
    });
    const present = new Set(rows.map((r) => r.bucketStart.getTime()));

    const expected = expectedBuckets(timeframe, stepMs, from, to, brokerOffsetMs);
    const missing = expected.filter((b) => !present.has(b.getTime()));

    console.log(`${symbol} ${timeframe}, last ${days}d: expected ${expected.length} market-hour buckets, found ${present.size} rows in range, missing ${missing.length}.`);
    if (missing.length > 0) {
      console.log("Missing buckets (UTC):");
      for (const b of missing) console.log(`  ${b.toISOString()}`);
      process.exitCode = 1;
    } else {
      console.log("No gaps.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("candle-gaps failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
