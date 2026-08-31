// One-off repair for Candle rows whose bucketStart was stored in BROKER
// SERVER time instead of UTC (hotfix/history-broker-time).
//
// The EA's history backfill sent MqlRates.time straight through, and that
// field is the trade server's local time. On Pepperstone (UTC+3) that put
// every backfilled bar three hours ahead: on Contabo the newest stored
// bucketStart read 2026-08-31 13:53Z while UTC was 11:04Z, with 3,915
// rows sitting in the future. The live tick path always bucketed in real
// UTC, so the two sources disagreed by the offset -- which is what froze
// the chart's last candle (klinecharts' updateData got a timestamp hours
// behind the newest history bar and dropped it).
//
// EA >= v1.36 converts before sending, so this script only has to repair
// what the older builds already wrote.
//
// Run:  npx tsx scripts/fix-broker-time-candles.ts [--execute]
// Default is a dry run. Exit 0 = nothing left to fix / fix applied.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

// A bar this far past now() cannot be legitimate: the live path only ever
// writes the bucket a tick actually fell into, and backfill only sends
// closed bars. One hour of slack absorbs a bar that opened moments ago on
// a large timeframe without catching anything real.
const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

// The offset is REQUIRED, never inferred. Inferring it from the data
// looks reasonable and is wrong: the newest stored bar is the newest
// CLOSED bar, so `newest - now` under-reads the true offset by up to one
// bar period. On the first run here that produced 2.60h against a real
// +3h offset, which rounds to 2.5h -- applying that would have shifted
// every row half an hour off and turned a clean, reversible error into a
// bespoke one. The real value comes from the terminal
// (TimeTradeServer() - TimeGMT(), what EA >= v1.36 now sends as
// server_offset_sec) or from the broker's published server time.
function parseOffsetHours(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--offset-hours="));
  if (!arg) return null;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

async function main() {
  const now = new Date();
  const cutoff = new Date(now.getTime() + FUTURE_TOLERANCE_MS);

  const future = await prisma.candle.findMany({
    where: { bucketStart: { gt: cutoff } },
    select: { symbol: true, timeframe: true, bucketStart: true },
    orderBy: { bucketStart: "desc" },
  });

  if (future.length === 0) {
    console.log("No future-dated Candle rows -- nothing to repair.");
    return;
  }

  const newest = future[0].bucketStart.getTime();
  const rawOffsetMs = newest - now.getTime();
  const offsetHours = parseOffsetHours();

  console.log(`UTC now              : ${now.toISOString()}`);
  console.log(`newest bucketStart   : ${future[0].bucketStart.toISOString()}`);
  console.log(`observed shift       : ${(rawOffsetMs / 3_600_000).toFixed(2)}h  (a LOWER BOUND -- the newest`);
  console.log(`                       stored bar is the newest CLOSED bar, so this under-reads the`);
  console.log(`                       true offset by up to one bar period. Do not round it and use it.)`);
  console.log(`future-dated rows    : ${future.length}\n`);

  if (offsetHours === null) {
    console.error(
      "Refusing to run without --offset-hours=<n>.\n" +
        "Get the real value from the terminal the bars came from:\n" +
        "  TimeTradeServer() - TimeGMT()   (EA >= v1.36 sends this as server_offset_sec)\n" +
        "or compare a live tick's time against real UTC. For Pepperstone this is 3.\n" +
        "Example: npx tsx scripts/fix-broker-time-candles.ts --offset-hours=3 --execute"
    );
    process.exitCode = 1;
    return;
  }

  const offsetMs = offsetHours * 3_600_000;
  console.log(`offset to apply      : -${offsetHours}h (given explicitly)\n`);

  const perGroup = new Map<string, number>();
  for (const row of future) {
    const key = `${row.symbol} ${row.timeframe}`;
    perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
  }
  console.log("future-dated rows per symbol x timeframe:");
  for (const [key, n] of [...perGroup.entries()].sort()) {
    console.log(`  ${key}: ${n}`);
  }

  // Every bar this EA wrote is shifted, not just the ones that happen to
  // land in the future -- the future-dated ones are simply the detectable
  // tail. Rows older than that tail are indistinguishable from live
  // tick-aggregated bars by timestamp alone, so shifting the whole table
  // would corrupt the UTC ones. Only the provably-broker-time rows are
  // touched here; the rest are left alone and the nightly gap-fill plus
  // the next (now-correct) backfill converge them.
  const total = await prisma.candle.count();
  console.log(`\nTotal Candle rows      : ${total}`);
  console.log(`Rows this will shift   : ${future.length}`);

  if (!EXECUTE) {
    console.log("\nDry run -- nothing written. Re-run with --execute to apply.");
    return;
  }

  // Shift by UPDATE, but a shifted row can collide with a real UTC bar
  // that already occupies the target bucket (the overlap window where
  // both sources wrote). bucketStart is part of the primary key, so that
  // would throw -- delete the loser first. The broker-sourced bar is the
  // authoritative one (real OHLC from the terminal, not tick-aggregated),
  // which matches upsert_candle_authoritative's own precedence, so the
  // colliding tick-aggregated row is the one that goes.
  let shifted = 0;
  let deduped = 0;

  for (const row of future) {
    const target = new Date(row.bucketStart.getTime() - offsetMs);

    const collision = await prisma.candle.findUnique({
      where: {
        symbol_timeframe_bucketStart: {
          symbol: row.symbol,
          timeframe: row.timeframe,
          bucketStart: target,
        },
      },
      select: { symbol: true },
    });

    if (collision) {
      await prisma.candle.delete({
        where: {
          symbol_timeframe_bucketStart: {
            symbol: row.symbol,
            timeframe: row.timeframe,
            bucketStart: target,
          },
        },
      });
      deduped += 1;
    }

    await prisma.candle.update({
      where: {
        symbol_timeframe_bucketStart: {
          symbol: row.symbol,
          timeframe: row.timeframe,
          bucketStart: row.bucketStart,
        },
      },
      data: { bucketStart: target },
    });
    shifted += 1;
  }

  const after = await prisma.candle.count();
  const stillFuture = await prisma.candle.count({
    where: { bucketStart: { gt: new Date(Date.now() + FUTURE_TOLERANCE_MS) } },
  });

  console.log(`\nShifted                : ${shifted}`);
  console.log(`Deduped (collisions)   : ${deduped}`);
  console.log(`Total Candle rows after: ${after} (delta: ${after - total})`);
  console.log(`Still future-dated     : ${stillFuture}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
