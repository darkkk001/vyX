// Volume-only backfill CLI (owner 2026-11-09). See core.ts and C:\vyx\handoff\volume-backfill-plan-2026-11-09.md.
//
//   npx tsx scripts/volume-backfill/cli.ts gaps [--symbol XAUUSD]                 read-only: every tickVolume = 0 run per symbol x timeframe
//   npx tsx scripts/volume-backfill/cli.ts run --csv volume_export.csv [--symbol S] [--offset-hours N]          DRY RUN (default)
//   npx tsx scripts/volume-backfill/cli.ts run --csv volume_export.csv --apply    writes, only on the owner's go, after a pg_dump
//
// The database is ALWAYS named explicitly: MARKET_DATA_DATABASE_URL (never DATABASE_URL, so the web's own database is never written by
// mistake). --offset-hours fixes the MT5 server offset; without it the server is an NY-close one (GMT+3 in US daylight time, else GMT+2).
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { measureGaps, parseCsv, run, scales } from "./core";

const args = process.argv.slice(2);
const cmd = args[0];
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const url = process.env.MARKET_DATA_DATABASE_URL;
if (!url) { console.error("MARKET_DATA_DATABASE_URL is not set (the market-data database must be named explicitly)"); process.exit(2); }
const db = new PrismaClient({ datasourceUrl: url });
const iso = (d: Date) => d.toISOString().replace(".000Z", "Z");

async function main() {
  if (cmd === "gaps") {
    const { runs, totals } = await measureGaps(db, flag("--symbol")?.toUpperCase());
    console.log("symbol,timeframe,bars_zero,bars_nonzero");
    for (const t of totals) console.log(`${t.symbol},${t.timeframe},${t.zero},${t.nonZero}`);
    console.log("\nsymbol,timeframe,zero_from_utc,zero_to_utc,bars");
    for (const r of runs) console.log(`${r.symbol},${r.timeframe},${iso(r.from)},${iso(r.to)},${r.bars}`);
    return 0;
  }
  if (cmd === "run") {
    const csv = flag("--csv"); if (!csv) { console.error("--csv <file> is required"); return 2; }
    const off = flag("--offset-hours"); const sym = flag("--symbol")?.toUpperCase();
    const parsed = parseCsv(readFileSync(csv, "utf8"), off === undefined ? undefined : Number(off));
    const rows = sym ? parsed.rows.filter((r) => r.symbol === sym) : parsed.rows;
    const apply = args.includes("--apply");
    const sc = await scales(db, rows);
    console.log(`${apply ? "APPLY" : "DRY RUN (nothing written; add --apply to write)"}: ${rows.length} MT5 bars, ${parsed.bad} unreadable CSV lines`);
    console.log("\nsymbol,scale_median_stored_over_mt5,samples");
    for (const [s, v] of sc) console.log(`${s},${v.scale === null ? "NONE (too few overlapping bars: this symbol is not written)" : v.scale.toFixed(4)},${v.samples}`);
    const counts = await run(db, rows, { apply, scaleBySymbol: sc });
    console.log(`\nsymbol,timeframe,${apply ? "updated" : "would_update"},skipped_nonzero,dropped_no_bar,dropped_no_scale`);
    for (const c of counts) console.log(`${c.symbol},${c.timeframe},${apply ? c.updated : c.wouldUpdate},${c.skippedNonZero},${c.droppedNoBar},${c.droppedNoScale}`);
    const sum = (k: "wouldUpdate" | "updated" | "skippedNonZero" | "droppedNoBar" | "droppedNoScale") => counts.reduce((s, c) => s + c[k], 0);
    console.log(`\nTOTAL ${apply ? "updated" : "would_update"} ${sum(apply ? "updated" : "wouldUpdate")}, skipped ${sum("skippedNonZero")}, dropped (no bar) ${sum("droppedNoBar")}, dropped (no scale) ${sum("droppedNoScale")}`);
    return 0;
  }
  console.error("usage: cli.ts gaps [--symbol S] | run --csv FILE [--symbol S] [--offset-hours N] [--apply]");
  return 2;
}

main().then((code) => db.$disconnect().then(() => process.exit(code)), (e) => { console.error(e instanceof Error ? e.message : e); db.$disconnect().finally(() => process.exit(1)); });
