// One-time backfill for the showGrid default flip (true -> false; owner 2026-11-12, terminal 1.0.111): the grid is OFF for every account after this
// update, including accounts that already saved chart settings. lib/chart-settings.ts's new default only reaches accounts with no stored blob (or a
// blob without the key); the WebTrader's ChartSettingsDialog and the terminal both PUT the FULL settings object, so an account that ever saved
// anything carries `showGrid: true` baked in from the old default. This script reaches those.
//
// It touches ONE key in ONE column: Account."chartSettings" -> 'showGrid' is set to false (jsonb_set) where it is stored as true. Every other field of
// each account's blob (colours, theme, sessions, ...) is left exactly as saved. NULL blobs, blobs without the key and blobs already false are not
// touched (the new default already gives them no grid). A trader can turn the grid back on afterwards from the chart's "Show grid" (that saves true).
// As with migrate-chart-defaults.ts: a stored true cannot be told apart from "chose it" -- it has been the default every account was given.
//
// Safety: DATABASE_URL and DIRECT_URL must both be set in the environment and name the same database (./.env is never read). DRY RUN by default
// (counts only, a READ ONLY transaction); --execute --confirm-host=<db host> to write. Prints the counts before and after.
//
// Run:  npx tsx scripts/migrate-chart-grid-off.ts                                    dry run
//       npx tsx scripts/migrate-chart-grid-off.ts --execute --confirm-host=<db host>
import { Prisma, PrismaClient } from "@prisma/client";

export type GridCounts = { accounts: number; withBlob: number; gridTrue: number; gridFalse: number; gridAbsent: number };

export async function gridCounts(db: Prisma.TransactionClient | PrismaClient): Promise<GridCounts> {
  const [r] = await db.$queryRaw<{ accounts: bigint; withblob: bigint; gridtrue: bigint; gridfalse: bigint; gridabsent: bigint }[]>`
    SELECT count(*) AS accounts,
           count(*) FILTER (WHERE "chartSettings" IS NOT NULL) AS withblob,
           count(*) FILTER (WHERE ("chartSettings"->>'showGrid') = 'true') AS gridtrue,
           count(*) FILTER (WHERE ("chartSettings"->>'showGrid') = 'false') AS gridfalse,
           count(*) FILTER (WHERE "chartSettings" IS NOT NULL AND NOT ("chartSettings"::jsonb ? 'showGrid')) AS gridabsent
    FROM "Account"`;
  return { accounts: Number(r.accounts), withBlob: Number(r.withblob), gridTrue: Number(r.gridtrue), gridFalse: Number(r.gridfalse), gridAbsent: Number(r.gridabsent) };
}

/** Sets the stored showGrid to false where it is true; returns the rows changed. */
export async function gridOff(db: Prisma.TransactionClient | PrismaClient): Promise<number> {
  return db.$executeRaw`
    UPDATE "Account"
    SET "chartSettings" = jsonb_set("chartSettings"::jsonb, '{showGrid}', 'false'::jsonb)
    WHERE "chartSettings" IS NOT NULL AND ("chartSettings"->>'showGrid') = 'true'`;
}

const fmt = (c: GridCounts) => `accounts ${c.accounts} | with saved chart settings ${c.withBlob} | showGrid true ${c.gridTrue} | false ${c.gridFalse} | key absent ${c.gridAbsent}`;

async function main() {
  const url = process.env.DATABASE_URL, direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new Error("DATABASE_URL and DIRECT_URL must both be set in the environment (./.env is not read)");
  const host = (u: string) => { try { const x = new URL(u); return `${x.hostname}${x.pathname}`; } catch { return ""; } };
  if (host(url) !== host(direct)) throw new Error("DATABASE_URL and DIRECT_URL name different databases");
  const execute = process.argv.includes("--execute");
  if (execute) {
    const c = process.argv.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length) ?? "";
    if (c !== new URL(url).hostname) throw new Error("--execute needs --confirm-host=<the database host>");
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (!execute) {
      const before = await prisma.$transaction(async (tx) => { await tx.$executeRaw`SET TRANSACTION READ ONLY`; return gridCounts(tx); });
      console.log(`BEFORE  ${fmt(before)}`);
      console.log(`would set showGrid false on ${before.gridTrue} account(s)`);
      console.log("DRY RUN: nothing written. Add --execute --confirm-host=<db host> to apply.");
      return;
    }
    const { before, changed, after } = await prisma.$transaction(async (tx) => {
      const b = await gridCounts(tx); const n = await gridOff(tx); const a = await gridCounts(tx);
      if (a.gridTrue !== 0 || n !== b.gridTrue || a.gridFalse !== b.gridFalse + n) throw new Error(`counts do not add up (changed ${n}, before ${fmt(b)}, after ${fmt(a)}): rolled back`);
      return { before: b, changed: n, after: a };
    });
    console.log(`BEFORE  ${fmt(before)}`);
    console.log(`changed ${changed} account(s): showGrid true -> false`);
    console.log(`AFTER   ${fmt(after)}`);
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && /migrate-chart-grid-off\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
