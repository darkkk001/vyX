// One-off repair for H4 Candle rows duplicated by the same naive-UTC bug
// fixed for D1 by scripts/fix-broker-day-candles.ts -- see
// engine/market-data/src/lib.rs's broker_period_start doc comment for the
// root cause. Identical bug, one level down: MT5's own H4 bars are
// anchored to the broker's day start (6 fixed buckets per broker day --
// 00:00/04:00/08:00/12:00/16:00/20:00 broker-LOCAL), exactly like D1, and
// mt5-ea's history backfill (HistoryBackfillPeriods includes PERIOD_H4)
// already converts those bars to the correct broker-boundary-aligned UTC
// bucketStart before sending. This crate's own live-tick aggregation kept
// bucketing H4 at naive UTC 4-hour marks until the engine fix alongside
// this script -- so for any broker whose offset isn't itself an exact
// multiple of 4 hours (the vast majority: +2, +3, +5, ...), every real
// 4-hour period ended up with TWO H4 rows.
//
// IMPORTANT difference from the D1 script this is modeled on: D1's own
// "is this row naive?" discriminator (exact UTC midnight) is safe for
// ANY nonzero real broker offset, because midnight only coincides with
// broker midnight when the offset is a multiple of 24h -- never true for
// a real broker. H4's naive grid (exact UTC 4-hour marks) DOES
// legitimately coincide with the broker-aligned grid whenever the
// offset itself is a multiple of 4h (UTC+4, UTC+8, UTC+12, ...) -- a
// perfectly real broker configuration. Naively porting D1's "delete/
// rename every exact-mark row" logic would corrupt those brokers' ALREADY
// -correct H4 history. This script guards against that: a candidate row
// is only ever touched when its own broker-aligned bucket (computed with
// the exact same shift-floor-shift-back formula the engine fix uses)
// actually differs from where it currently sits -- for a multiple-of-4h
// offset that's never true, so those brokers' rows are correctly left
// alone even though they still pass the cheap "exact UTC 4-hour mark"
// pre-filter.
//
// Per (symbol, H4) pair, for every row whose broker-aligned bucket
// differs from its own bucketStart:
//   - if a row ALREADY exists at the broker-aligned bucket (the real
//     duplicate case): deletes the naive row, keeps the broker-aligned
//     one (the real, broker-authoritative OHLC);
//   - if nothing exists there yet: renames the naive row's own
//     bucketStart to the broker-aligned instant instead of deleting it --
//     it's the only OHLC this platform has for that period.
//
// The offset is REQUIRED, never inferred -- same rule as every sibling
// script in this directory.
//
// Run:  npx tsx scripts/fix-broker-h4-candles.ts --offset-hours=3 [--execute]
// Default is a dry run. Exit 0 = nothing left to fix / fix applied.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");
const H4_MS = 14_400_000;

function parseOffsetHours(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--offset-hours="));
  if (!arg) return null;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function isExactUtc4HourMark(d: Date): boolean {
  return d.getUTCHours() % 4 === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

// Identical shift-floor-shift-back arithmetic as
// engine/market-data/src/lib.rs's broker_period_start, so this script's
// notion of "the correct bucket" can never drift from what the engine
// itself now computes.
function brokerAlignedH4Start(t: Date, offsetMs: number): Date {
  const floored = Math.floor((t.getTime() + offsetMs) / H4_MS) * H4_MS - offsetMs;
  return new Date(floored);
}

async function main() {
  const offsetHours = parseOffsetHours();
  if (offsetHours === null) {
    console.error(
      "Refusing to run without --offset-hours=<n>.\n" +
        "Get the real value from the terminal the bars came from:\n" +
        "  TimeTradeServer() - TimeGMT()   (mt5-ea's BrokerOffsetSec, sent as server_offset_sec/broker_offset_sec)\n" +
        "Same value already used for scripts/fix-broker-day-candles.ts --offset-hours -- H4 shares one broker clock with D1.\n" +
        "Example: npx tsx scripts/fix-broker-h4-candles.ts --offset-hours=3 --execute"
    );
    process.exitCode = 1;
    return;
  }
  const offsetMs = offsetHours * 3_600_000;

  if (offsetHours % 4 === 0) {
    console.log(
      `--offset-hours=${offsetHours} is itself a multiple of 4 -- this broker's H4 grid never disagreed with the naive ` +
        `UTC grid in the first place (see this script's own top-of-file comment). Nothing to repair; exiting without ` +
        `touching any row.`
    );
    return;
  }

  // One query for every H4 row across every symbol, same "hold it all in
  // memory, no N+1" reasoning as fix-broker-day-candles.ts -- H4 has 6x
  // the row count D1 does for the same real history, so this matters
  // even more here.
  const allRows = await prisma.candle.findMany({
    where: { timeframe: "H4" },
    select: { symbol: true, bucketStart: true },
  });
  const existingKeys = new Set(allRows.map((r) => `${r.symbol}|${r.bucketStart.getTime()}`));
  const candidates = allRows.filter((r) => isExactUtc4HourMark(r.bucketStart));

  const perSymbol = new Map<string, { merged: number; folded: number; skippedAlreadyCorrect: number }>();
  const toDeletePerSymbol = new Map<string, Date[]>();
  const toRename: { symbol: string; from: Date; to: Date }[] = [];

  for (const row of candidates) {
    const brokerAligned = brokerAlignedH4Start(row.bucketStart, offsetMs);
    const bucket = perSymbol.get(row.symbol) ?? { merged: 0, folded: 0, skippedAlreadyCorrect: 0 };

    if (brokerAligned.getTime() === row.bucketStart.getTime()) {
      // Passed the cheap "exact UTC 4-hour mark" pre-filter but is
      // ALREADY sitting at its own correct broker-aligned bucket -- only
      // possible for an offset that happens to also be a multiple of 4h
      // for THIS row's own instant (DST transition mid-history, e.g.).
      // Real, correct data -- must not be touched.
      bucket.skippedAlreadyCorrect += 1;
    } else if (existingKeys.has(`${row.symbol}|${brokerAligned.getTime()}`)) {
      const pending = toDeletePerSymbol.get(row.symbol) ?? [];
      pending.push(row.bucketStart);
      toDeletePerSymbol.set(row.symbol, pending);
      bucket.merged += 1;
    } else {
      toRename.push({ symbol: row.symbol, from: row.bucketStart, to: brokerAligned });
      bucket.folded += 1;
    }
    perSymbol.set(row.symbol, bucket);
  }

  const totalToFix = [...perSymbol.values()].reduce((sum, c) => sum + c.merged + c.folded, 0);
  if (totalToFix === 0) {
    console.log(`No overlapping H4 rows found for --offset-hours=${offsetHours} -- nothing to repair.`);
    return;
  }

  console.log(`--offset-hours=${offsetHours}`);
  console.log(`Total H4 rows: ${allRows.length}, exact-UTC-4h-mark candidates: ${candidates.length}\n`);

  let skippedCollision = 0; // defensive only -- should never actually trigger
  if (EXECUTE) {
    for (const [symbol, bucketStarts] of toDeletePerSymbol) {
      await prisma.candle.deleteMany({ where: { symbol, timeframe: "H4", bucketStart: { in: bucketStarts } } });
    }
    for (const { symbol, from, to } of toRename) {
      try {
        await prisma.candle.update({
          where: { symbol_timeframe_bucketStart: { symbol, timeframe: "H4", bucketStart: from } },
          data: { bucketStart: to },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          skippedCollision += 1;
          continue;
        }
        throw err;
      }
    }
  }

  const merged = [...perSymbol.values()].reduce((sum, c) => sum + c.merged, 0);
  const folded = [...perSymbol.values()].reduce((sum, c) => sum + c.folded, 0);
  const skippedAlreadyCorrect = [...perSymbol.values()].reduce((sum, c) => sum + c.skippedAlreadyCorrect, 0);

  console.log("Per symbol:");
  for (const [symbol, counts] of [...perSymbol.entries()].sort()) {
    console.log(
      `  ${symbol}: merged (deleted, broker bar kept) ${counts.merged}, folded (renamed to broker bucket) ${counts.folded}` +
        (counts.skippedAlreadyCorrect > 0 ? `, already-correct (left alone) ${counts.skippedAlreadyCorrect}` : "")
    );
  }
  console.log(`\nTotal merged  : ${merged}`);
  console.log(`Total folded  : ${folded}`);
  if (skippedAlreadyCorrect > 0) console.log(`Total already-correct (untouched): ${skippedAlreadyCorrect}`);
  if (skippedCollision > 0) console.log(`Skipped (collision) : ${skippedCollision}`);

  if (!EXECUTE) {
    console.log("\nDry run -- nothing written. Re-run with --execute to apply.");
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
