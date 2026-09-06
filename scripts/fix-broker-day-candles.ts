// One-off repair for D1 Candle rows duplicated by the naive-UTC-midnight
// bucketing bug (see engine/market-data/src/lib.rs's broker_day_start doc
// comment, and this same directory's older fix-broker-time-candles.ts for
// the sibling bug this one is easy to confuse with -- that one was about
// backfilled bars landing at the WRONG absolute time; this one is about
// the LIVE tick-aggregation path never agreeing with backfill on where a
// D1 bucket even starts).
//
// mt5-ea's history backfill (HistoryBackfillPeriods stops at D1 -- it
// never sends W1/MN1/Y1 bars) already converts CopyRates bar times to a
// correct, broker-day-boundary-aligned UTC bucketStart before sending
// (fix-broker-time-candles.ts's own hotfix). But engine/market-data's own
// live-tick aggregation kept bucketing D1 at naive UTC midnight until the
// fix alongside this script -- so for a UTC+3 broker (Pepperstone), every
// real trading day ended up with TWO D1 rows: the correct one from
// backfill (bucketStart at e.g. 21:00 UTC) and a second, spurious one the
// live path built on its own (bucketStart at exact UTC midnight). Both
// rows are real Postgres rows, not a rendering artifact -- this is why
// the chart's hover tooltip (reads one specific row) and its visible
// candle shape (klinecharts draws every row in range) disagreed.
//
// This script, per (symbol, D1) pair:
//   - for every row sitting at EXACT UTC midnight (00:00:00.000) -- the
//     naive tick-aggregated shape is the ONLY way such a row could exist
//     once a broker's real offset is nonzero, so this is a precise
//     discriminator, not a heuristic -- computes where the broker-aligned
//     bucket for that same real day would be (bucketStart - offsetHours);
//   - if a row ALREADY exists there (the real duplicate case): deletes
//     the naive UTC-midnight row and keeps the broker-aligned one as-is
//     (it's the real, broker-authoritative OHLC -- not merged/averaged
//     with the tick-aggregated one, which is what the live path was
//     approximating anyway);
//   - if nothing exists there (a day backfill never reached, or a symbol
//     with no broker-authoritative bar at all yet): renames the naive
//     row's own bucketStart to the broker-aligned instant instead of
//     deleting it -- it's the only OHLC this platform has for that day,
//     better relabeled correctly than lost.
//
// The offset is REQUIRED, never inferred -- same reasoning as
// fix-broker-time-candles.ts's own parseOffsetHours: guessing it from the
// data is exactly the mistake that script's own comment warns about.
//
// Run:  npx tsx scripts/fix-broker-day-candles.ts --offset-hours=3 [--execute]
// Default is a dry run. Exit 0 = nothing left to fix / fix applied.

import { PrismaClient, Prisma } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

function parseOffsetHours(): number | null {
  const arg = process.argv.find((a) => a.startsWith("--offset-hours="));
  if (!arg) return null;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) && value !== 0 ? value : null;
}

function isExactUtcMidnight(d: Date): boolean {
  return d.getUTCHours() === 0 && d.getUTCMinutes() === 0 && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0;
}

async function main() {
  const offsetHours = parseOffsetHours();
  if (offsetHours === null) {
    console.error(
      "Refusing to run without --offset-hours=<n>.\n" +
        "Get the real value from the terminal the bars came from:\n" +
        "  TimeTradeServer() - TimeGMT()   (mt5-ea's BrokerOffsetSec, sent as server_offset_sec/broker_offset_sec)\n" +
        "For Pepperstone this is 3 (or 2 during their DST window -- check live, don't assume).\n" +
        "Example: npx tsx scripts/fix-broker-day-candles.ts --offset-hours=3 --execute"
    );
    process.exitCode = 1;
    return;
  }
  const offsetMs = offsetHours * 3_600_000;

  // One query for every D1 row across every symbol -- 15k+ rows on the
  // live DB at the time this was written, comfortably small to hold in
  // memory -- instead of one findUnique per naive row. The first version
  // of this script did exactly that (a real N+1: one round trip per
  // naive-midnight row) and was still running 15+ minutes later against
  // ~9,200 of them; this is the same logic against an in-memory Set,
  // which is what actually needs to scale to a full history backfill.
  const allRows = await prisma.candle.findMany({
    where: { timeframe: "D1" },
    select: { symbol: true, bucketStart: true },
  });
  const existingKeys = new Set(allRows.map((r) => `${r.symbol}|${r.bucketStart.getTime()}`));
  const naiveMidnightRows = allRows.filter((r) => isExactUtcMidnight(r.bucketStart));

  if (naiveMidnightRows.length === 0) {
    console.log("No exact-UTC-midnight D1 rows found -- nothing to repair.");
    return;
  }

  console.log(`--offset-hours=${offsetHours}`);
  console.log(`Total D1 rows: ${allRows.length}, exact-UTC-midnight: ${naiveMidnightRows.length}\n`);

  const perSymbol = new Map<string, { merged: number; folded: number }>();
  // Grouped per symbol so EXECUTE can batch every this-symbol's merge
  // deletes into one deleteMany instead of one round trip per row --
  // still one query per (symbol, kind) rather than per row, the same
  // scaling fix as existingKeys above.
  const toDeletePerSymbol = new Map<string, Date[]>();
  const toRename: { symbol: string; from: Date; to: Date }[] = [];

  for (const row of naiveMidnightRows) {
    const brokerAligned = new Date(row.bucketStart.getTime() - offsetMs);
    const bucket = perSymbol.get(row.symbol) ?? { merged: 0, folded: 0 };

    if (existingKeys.has(`${row.symbol}|${brokerAligned.getTime()}`)) {
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

  let skippedCollision = 0; // defensive only -- should never actually trigger
  if (EXECUTE) {
    for (const [symbol, bucketStarts] of toDeletePerSymbol) {
      await prisma.candle.deleteMany({ where: { symbol, timeframe: "D1", bucketStart: { in: bucketStarts } } });
    }
    for (const { symbol, from, to } of toRename) {
      try {
        await prisma.candle.update({
          where: { symbol_timeframe_bucketStart: { symbol, timeframe: "D1", bucketStart: from } },
          data: { bucketStart: to },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          // Another naive row's own rename (earlier in this same loop)
          // landed here first -- vanishingly unlikely (two different
          // naive UTC-midnight rows converging on the same broker bucket
          // would mean two different real days collided), but report
          // rather than silently drop either row.
          skippedCollision += 1;
          continue;
        }
        throw err;
      }
    }
  }

  const merged = [...perSymbol.values()].reduce((sum, c) => sum + c.merged, 0);
  const folded = [...perSymbol.values()].reduce((sum, c) => sum + c.folded, 0);

  console.log("Per symbol:");
  for (const [symbol, counts] of [...perSymbol.entries()].sort()) {
    console.log(`  ${symbol}: merged (deleted, broker bar kept) ${counts.merged}, folded (renamed to broker bucket) ${counts.folded}`);
  }
  console.log(`\nTotal merged : ${merged}`);
  console.log(`Total folded : ${folded}`);
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
