// Deal model step 4, reader "book_pnl": realised Book P/L the ledger way (positions CLOSED in the range, realizedPnl)
// next to the deal way (every close executed in the range, deal profit), per broker and account currency, for the last
// 24 h, 7 days, 30 days and all time. READ ONLY (every query in a READ ONLY transaction). Live accounts only, as the
// Dashboard / Reports default.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/compare-book-pnl.ts [--out report.json]
import fs from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";

const OUT = (() => { const i = process.argv.indexOf("--out"); return i >= 0 ? process.argv[i + 1] : undefined; })();

// the same WHERE as lib/book-pnl.ts heldSql (kept textual here so the script runs outside Next's server-only import)
const held = (brokerId: string, coverage: string | null) => Prisma.sql`p."brokerId" = ${brokerId} AND p."deletedAt" IS NULL
    AND NOT EXISTS (SELECT 1 FROM "Broker" sb WHERE sb.id = p."brokerId" AND sb."isDemoSandbox")
    AND a."accountMode" = 'LIVE' AND a."isInternal" = false
    AND (${coverage}::text IS NULL OR a.id <> ${coverage})
    AND (g.category IS NULL OR g.category <> 'COVERAGE')
    AND COALESCE(p."groupCategoryAtOpen"::text, g.category::text) IN ('B_BOOK', 'DEALING')
    AND p."bookType" = 'B_BOOK'`;

type Row = { currency: string; total: Prisma.Decimal | null; n: bigint };

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  console.log(`database host: ${new URL(url).host}`);
  console.log("MODE: READ ONLY comparison (Book P/L, live accounts)");
  const now = new Date();
  const ranges: [string, Date][] = [
    ["24h", new Date(now.getTime() - 24 * 3600_000)],
    ["7d", new Date(now.getTime() - 7 * 24 * 3600_000)],
    ["30d", new Date(now.getTime() - 30 * 24 * 3600_000)],
    ["all", new Date(0)],
  ];
  const report: unknown[] = [];
  await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    const brokers = await tx.broker.findMany({ where: { isDemoSandbox: false }, select: { id: true, name: true, coverageAccountId: true }, orderBy: { name: "asc" } });
    for (const b of brokers) {
      for (const [label, from] of ranges) {
        const oldRows = await tx.$queryRaw<Row[]>`
          SELECT a.currency, -SUM(p."realizedPnl") AS total, COUNT(*)::bigint AS n
            FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
           WHERE ${held(b.id, b.coverageAccountId)} AND p.status = 'CLOSED' AND p."realizedPnl" IS NOT NULL AND p."closedAt" >= ${from}
           GROUP BY a.currency`;
        const newRows = await tx.$queryRaw<Row[]>`
          SELECT a.currency, -SUM(d.profit) AS total, COUNT(DISTINCT d."positionId")::bigint AS n
            FROM "Deal" d JOIN "Position" p ON p.id = d."positionId" JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
           WHERE ${held(b.id, b.coverageAccountId)} AND p.status IN ('OPEN', 'CLOSED')
             AND d.entry IN ('OUT', 'OUT_BY') AND d."transactionId" IS NOT NULL AND d."voidedAt" IS NULL AND d."executedAt" >= ${from}
           GROUP BY a.currency`;
        // where the difference comes from: closes of positions still OPEN (partials), and positions closed in parts
        const partsRows = await tx.$queryRaw<{ currency: string; open_partials: Prisma.Decimal | null; multi_extra: Prisma.Decimal | null }[]>`
          SELECT a.currency,
                 -SUM(d.profit) FILTER (WHERE p.status = 'OPEN') AS open_partials,
                 -SUM(d.profit) FILTER (WHERE p.status = 'CLOSED') - COALESCE(-SUM(DISTINCT p."realizedPnl") FILTER (WHERE p.status = 'CLOSED'), 0) AS multi_extra
            FROM "Deal" d JOIN "Position" p ON p.id = d."positionId" JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
           WHERE ${held(b.id, b.coverageAccountId)} AND d.entry IN ('OUT', 'OUT_BY') AND d."transactionId" IS NOT NULL AND d."voidedAt" IS NULL
             AND d."executedAt" >= ${from} AND p.status = 'OPEN'
           GROUP BY a.currency`;
        const ccys = new Set([...oldRows, ...newRows].map((r) => r.currency));
        for (const c of [...ccys].sort()) {
          const o = oldRows.find((r) => r.currency === c), n = newRows.find((r) => r.currency === c);
          const ov = new Prisma.Decimal(o?.total ?? 0), nv = new Prisma.Decimal(n?.total ?? 0);
          const openPartials = new Prisma.Decimal(partsRows.find((r) => r.currency === c)?.open_partials ?? 0);
          const line = { broker: b.name, range: label, currency: c, old: ov.toFixed(2), new: nv.toFixed(2), diff: nv.sub(ov).toFixed(2), oldPositions: Number(o?.n ?? 0), newPositions: Number(n?.n ?? 0), openPartials: openPartials.toFixed(2) };
          report.push(line);
          if (!ov.eq(nv) || label === "all") {
            console.log(`${b.name.padEnd(30)} ${label.padEnd(4)} ${c}  old ${line.old.padStart(12)}  new ${line.new.padStart(12)}  diff ${line.diff.padStart(10)}  (positions ${line.oldPositions} -> ${line.newPositions}; partials of open positions ${line.openPartials})`);
          }
        }
      }
    }
  }, { timeout: 120_000, maxWait: 30_000 });
  await prisma.$disconnect();
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
