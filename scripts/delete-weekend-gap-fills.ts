// hotfix/terminal-live-bugs round 2, bug #3 -- engine/market-data/src/
// gap_fill.rs's weekend exclusion (market_closed()) either never actually
// reached the Contabo binary or predates this fix, so production ended up
// with real synthetic flat bars written across genuine market closes
// (reported: XAUUSD H1, visible 08-29 -> 08-30). Deletes exactly the rows
// that fix now prevents going forward, and only those rows -- see the two
// conditions below.
//
// A row only qualifies for deletion if BOTH hold:
//   1. Its bucketStart falls inside the market-closed window
//      (marketClosed() below, mirroring gap_fill.rs's own corrected
//      boundary -- Sat all day, Fri >=21:00 UTC, Sun <22:00 UTC), for a
//      symbol whose real Symbol.category isn't CRYPTO. This script has
//      full Prisma access to the real Symbol table, so -- unlike
//      gap_fill.rs's own hot-path hardcoded BTCUSD/ETHUSD allowlist (no DB
//      lookup available there) -- this checks the actual category column,
//      which is how a real gap in that hardcoded list (SOLUSD, discovered
//      while first running this script) gets caught here instead of
//      silently deleting a legitimate continuously-traded symbol's row.
//   2. open === high === low === close exactly. gap_fill.rs's own
//      CandleUpdate construction (fill_gaps_and_record) ALWAYS produces
//      an exactly-flat bar -- open/high/low/close all set to the prior
//      real close, verbatim, never independently rounded or perturbed.
//      A genuine real trade landing in that window (a stray tick, a
//      clock-skewed EA report) would need to be a coincidental exact
//      4-way tie to be misidentified, which real market data does not
//      produce -- this is a safe, conservative filter, not a heuristic.
//
// Usage:
//   npx tsx scripts/delete-weekend-gap-fills.ts            -- dry run, counts only, deletes nothing
//   npx tsx scripts/delete-weekend-gap-fills.ts --execute   -- actually deletes, prints before/after counts
//
// Only fixed-duration timeframes are considered (M1/M5/M30/H1/H4/D1) --
// W1/MN1/Y1 are never gap-filled in the first place (gap_fill.rs's own
// early return), nothing to clean up there.
import { PrismaClient, CandleTimeframe } from "@prisma/client";

const FIXED_TIMEFRAMES: CandleTimeframe[] = ["M1", "M5", "M30", "H1", "H4", "D1"] as CandleTimeframe[];

// Keep in sync with engine/market-data/src/gap_fill.rs's market_closed
// (round-2 boundary: Friday from 21:00 UTC, not 22:00).
function marketClosed(t: Date): boolean {
  const day = t.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const hour = t.getUTCHours();
  if (day === 6) return true;
  if (day === 5) return hour >= 21;
  if (day === 0) return hour < 22;
  return false;
}

async function main() {
  const execute = process.argv.includes("--execute");
  const prisma = new PrismaClient();

  try {
    const totalBefore = await prisma.candle.count();
    console.log(`Total Candle rows before: ${totalBefore}`);

    const candleSymbols = await prisma.candle.findMany({ select: { symbol: true }, distinct: ["symbol"] });
    const symbolRecords = await prisma.symbol.findMany({ select: { name: true, category: true } });
    const categoryByName = new Map(symbolRecords.map((s) => [s.name, s.category]));

    const symbolNames: string[] = [];
    for (const { symbol } of candleSymbols) {
      const category = categoryByName.get(symbol);
      if (category === undefined) {
        console.log(`No Symbol record for "${symbol}" -- treating as weekend-closed (not exempting as crypto).`);
      }
      if (category !== "CRYPTO") symbolNames.push(symbol);
    }

    let totalToDelete = 0;
    const perSymbol: { symbol: string; timeframe: string; count: number }[] = [];

    for (const symbol of symbolNames) {
      for (const timeframe of FIXED_TIMEFRAMES) {
        // Fetch id + bucketStart + OHLC rather than filtering in SQL --
        // marketClosed() is UTC-day/hour logic, awkward to express
        // portably in a single Prisma where-clause across timeframes with
        // different bucket granularity; row counts here are small enough
        // (bounded by real weekend hours across this app's history) that
        // an in-memory filter is simpler and easier to verify by reading.
        const rows = await prisma.candle.findMany({
          where: { symbol, timeframe },
          select: { bucketStart: true, open: true, high: true, low: true, close: true },
        });
        const toDelete = rows.filter(
          (r) =>
            marketClosed(r.bucketStart) &&
            r.open.equals(r.high) &&
            r.open.equals(r.low) &&
            r.open.equals(r.close)
        );
        if (toDelete.length > 0) {
          perSymbol.push({ symbol, timeframe, count: toDelete.length });
          totalToDelete += toDelete.length;
          if (execute) {
            // Composite primary key (symbol, timeframe, bucketStart), no
            // surrogate id -- deleteMany's `in` filter needs the actual
            // key columns, not a synthetic one.
            await prisma.candle.deleteMany({
              where: { symbol, timeframe, bucketStart: { in: toDelete.map((r) => r.bucketStart) } },
            });
          }
        }
      }
    }

    console.log(`\n${execute ? "Deleted" : "Would delete"} ${totalToDelete} weekend flat-fill rows:`);
    for (const row of perSymbol) console.log(`  ${row.symbol} ${row.timeframe}: ${row.count}`);
    if (perSymbol.length === 0) console.log("  (none found)");

    if (execute) {
      const totalAfter = await prisma.candle.count();
      console.log(`\nTotal Candle rows after: ${totalAfter} (delta: ${totalAfter - totalBefore})`);
      if (totalAfter !== totalBefore - totalToDelete) {
        console.error("WARNING: after-count does not match before-count minus deleted -- investigate before trusting this run.");
        process.exitCode = 1;
      }
    } else {
      console.log("\nDry run -- nothing deleted. Re-run with --execute to actually delete these rows.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error("delete-weekend-gap-fills failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
