// One-off repair for Candle rows the engine's gap-fill (engine/market-data/
// src/gap_fill.rs) synthesized during a real weekend market close, before
// that module's market_closed()/is_continuously_traded() exclusion (added
// hotfix/terminal-live-bugs "round 2", 2026-08-31 -- see gap_fill.rs's own
// module comment) had actually reached the running Contabo binary. A real
// git pull alone never updates a running Rust binary; until the crate is
// rebuilt and the service restarted, every weekend keeps producing another
// batch of these -- this script only cleans up what's already been
// written, it does not fix the underlying cause (that's the Contabo
// rebuild + restart described alongside this script).
//
// A row is treated as an erroneous weekend flat-fill only when ALL of:
//   1. open == high == low == close (the exact synthetic marker
//      fill_gaps_and_record/sweep_stale_buckets always write -- see
//      gap_fill.rs's own CandleUpdate construction, "carry_close" on
//      all four fields)
//   2. bucketStart falls inside the same market_closed() window
//      gap_fill.rs itself checks (Sat all day; Fri >= 21:00 UTC;
//      Sun < 22:00 UTC -- mirrored exactly below, keep in sync if that
//      function's boundary ever changes)
//   3. the symbol is NOT one of gap_fill.rs's is_continuously_traded()
//      crypto pairs (BTCUSD/ETHUSD/SOLUSD/XRPUSD trade all weekend --
//      a flat bar for one of those during what this script calls
//      "closed" would be real, quiet weekend trading, not a bug)
//
// A genuinely flat REAL candle (four ticks that all landed on the exact
// same price during a quiet moment) is possible but exceedingly rare in
// live FX/metals data, and condition 2 already confines this to a window
// where the market was supposed to be shut entirely -- a real tick has no
// business existing there at all for a non-continuous symbol, flat or
// not, so this is a safe identifier in practice, not just in theory.
//
// Run:  npx tsx scripts/fix-weekend-flat-candles.ts [--execute]
// Default is a dry run -- prints what would be deleted, deletes nothing.

import { PrismaClient, CandleTimeframe } from "@prisma/client";

const prisma = new PrismaClient();
const EXECUTE = process.argv.includes("--execute");

// Mirrors gap_fill.rs's is_continuously_traded() exactly -- keep in sync.
const CONTINUOUSLY_TRADED = new Set(["BTCUSD", "ETHUSD", "SOLUSD", "XRPUSD"]);

// Mirrors gap_fill.rs's market_closed() exactly -- keep in sync.
function isMarketClosed(d: Date): boolean {
  const day = d.getUTCDay(); // 0 = Sunday, 6 = Saturday
  const hour = d.getUTCHours();
  if (day === 6) return true; // Saturday
  if (day === 5) return hour >= 21; // Friday >= 21:00 UTC
  if (day === 0) return hour < 22; // Sunday < 22:00 UTC
  return false;
}

async function main() {
  // Prisma's query builder has no column-to-column comparison, so this is
  // a raw SELECT for the flat (open=high=low=close) candidates -- fine at
  // this table's size (a few hundred thousand rows, per Candle's own
  // retention job). The weekend/continuously-traded filtering then
  // happens in JS below, identically to how gap_fill.rs itself decides.
  const candidates = await prisma.$queryRaw<
    { symbol: string; timeframe: CandleTimeframe; bucketStart: Date; close: string }[]
  >`SELECT symbol, timeframe, "bucketStart", close::text as close
    FROM "Candle"
    WHERE open = high AND high = low AND low = close`;

  const toDelete = candidates.filter(
    (row) => !CONTINUOUSLY_TRADED.has(row.symbol) && isMarketClosed(row.bucketStart)
  );

  console.log(`Flat (open=high=low=close) rows total : ${candidates.length}`);
  console.log(`Of those, in a real market-closed window (not a 24/7 symbol): ${toDelete.length}\n`);

  if (toDelete.length === 0) {
    console.log("Nothing to clean up.");
    return;
  }

  const perGroup = new Map<string, number>();
  for (const row of toDelete) {
    const key = `${row.symbol} ${row.timeframe}`;
    perGroup.set(key, (perGroup.get(key) ?? 0) + 1);
  }
  console.log("rows to delete per symbol x timeframe:");
  for (const [key, n] of [...perGroup.entries()].sort()) {
    console.log(`  ${key}: ${n}`);
  }
  const oldest = toDelete.reduce((a, b) => (a.bucketStart < b.bucketStart ? a : b));
  const newest = toDelete.reduce((a, b) => (a.bucketStart > b.bucketStart ? a : b));
  console.log(`\noldest: ${oldest.symbol} ${oldest.timeframe} ${oldest.bucketStart.toISOString()}`);
  console.log(`newest: ${newest.symbol} ${newest.timeframe} ${newest.bucketStart.toISOString()}`);

  if (!EXECUTE) {
    console.log("\nDry run -- nothing deleted. Re-run with --execute to apply.");
    return;
  }

  let deleted = 0;
  for (const row of toDelete) {
    await prisma.candle.delete({
      where: {
        symbol_timeframe_bucketStart: {
          symbol: row.symbol,
          timeframe: row.timeframe,
          bucketStart: row.bucketStart,
        },
      },
    }).catch(() => {
      // Already gone (a concurrent retention sweep, or run twice) -- not
      // an error worth stopping the batch over.
    });
    deleted += 1;
  }

  console.log(`\nDeleted: ${deleted}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
