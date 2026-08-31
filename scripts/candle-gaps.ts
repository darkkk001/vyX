// fix/realtime-sync §4's acceptance script: for a symbol+timeframe over
// the last N days, prints every market-hour bucket with no Candle row at
// all. Run via `npx tsx scripts/candle-gaps.ts [symbol] [timeframe]
// [days]` (all optional -- defaults match the acceptance test's own
// example: XAUUSD H1 over 30 days). Exit code 0 = no gaps, 1 = gaps
// found (or a usage/connection error).
//
// "Market-hour" mirrors engine/market-data/src/gap_fill.rs's own
// market_closed() exactly (Friday 21:00 UTC through Sunday 22:00 UTC is
// a real close, not a gap -- round-2 hotfix moved this from 22:00 to
// 21:00, the DST-safe bound) -- this script and the engine must agree on
// what counts as "missing" or every real weekend would print as false
// positives on an H1 run.
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

function expectedBuckets(stepMs: number, from: Date, to: Date): Date[] {
  const buckets: Date[] = [];
  const start = Math.ceil(from.getTime() / stepMs) * stepMs;
  for (let t = start; t < to.getTime(); t += stepMs) {
    const bucket = new Date(t);
    if (!marketClosed(bucket)) buckets.push(bucket);
  }
  return buckets;
}

async function main() {
  const symbol = process.argv[2] ?? "XAUUSD";
  const timeframe = process.argv[3] ?? "H1";
  const days = Number(process.argv[4] ?? "30");

  const stepMs = FIXED_MS[timeframe];
  if (!stepMs || !(timeframe in CandleTimeframe)) {
    console.error(`Unrecognized timeframe "${timeframe}" -- expected one of ${Object.keys(FIXED_MS).join(", ")} (W1/MN1/Y1 are calendar-based and not checked by this script, same as engine/market-data/src/gap_fill.rs's own exclusion).`);
    process.exit(1);
  }
  const timeframeEnum = timeframe as CandleTimeframe;

  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);

  const prisma = new PrismaClient();
  try {
    const rows = await prisma.candle.findMany({
      where: { symbol, timeframe: timeframeEnum, bucketStart: { gte: from, lt: to } },
      select: { bucketStart: true },
    });
    const present = new Set(rows.map((r) => r.bucketStart.getTime()));

    const expected = expectedBuckets(stepMs, from, to);
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
