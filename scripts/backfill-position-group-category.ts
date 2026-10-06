// Fills Position.groupCategoryAtOpen for positions opened BEFORE the column existed (migration
// 20261006090000_book_pnl_group_min_volume; every position opened since is stamped by the database trigger).
//
// APPROXIMATE HISTORY: the true group at open time was never recorded, so each NULL row takes the category of the
// account's CURRENT group. An account that changed group since (for example Book -> Reverse trading) gets its old
// positions labelled with the new group. Rows that already have a value are never touched; positions whose account has
// no group stay NULL (lib/book-pnl.ts then falls back to the current group, which is also none: not counted).
//
// Dry run by default (read-only transaction, prints what it would write). Writing needs BOTH --apply and
// --confirm-host=<the DATABASE_URL host>, local databases included. One AuditLog summary row (POSITION_GROUP_CATEGORY_BACKFILL)
// records the counts. Safe to re-run: a second run finds nothing to fill.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/backfill-position-group-category.ts                (dry run)
//   ... npx tsx scripts/backfill-position-group-category.ts --apply --confirm-host=<db host>
import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

export class BackfillRefused extends Error {}
export type BackfillResult = { byCategory: Record<string, number>; noGroup: number; filled: number; lines: string[] };

export const AUDIT_ACTION = "POSITION_GROUP_CATEGORY_BACKFILL";

export async function backfillGroupCategory(db: Db, opts: { apply: boolean }): Promise<BackfillResult> {
  const rows = await db.$queryRaw<{ category: string | null; n: bigint }[]>`
    SELECT g.category::text AS category, COUNT(*)::bigint AS n
      FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
     WHERE p."groupCategoryAtOpen" IS NULL
     GROUP BY g.category ORDER BY g.category`;
  const byCategory: Record<string, number> = {};
  let noGroup = 0;
  for (const r of rows) {
    if (r.category == null) noGroup += Number(r.n);
    else byCategory[r.category] = Number(r.n);
  }
  const toFill = Object.values(byCategory).reduce((t, n) => t + n, 0);
  const lines = [`mode: ${opts.apply ? "APPLY" : "DRY RUN"}`, `positions with no category yet: ${toFill + noGroup}`];
  for (const [c, n] of Object.entries(byCategory)) lines.push(`  ${c.padEnd(10)} ${n}  (from the account's current group)`);
  lines.push(`  no group   ${noGroup}  (left empty)`);

  let filled = 0;
  if (opts.apply && toFill > 0) {
    filled = await db.$executeRaw`
      UPDATE "Position" p SET "groupCategoryAtOpen" = g.category
        FROM "Account" a JOIN "Group" g ON g.id = a."groupId"
       WHERE a.id = p."accountId" AND p."groupCategoryAtOpen" IS NULL`;
    await db.auditLog.create({
      data: {
        action: AUDIT_ACTION,
        entityType: "Position",
        entityId: "all-positions",
        newValue: {
          filled,
          byCategory,
          leftEmptyNoGroup: noGroup,
          note: "approximate history: filled from each account's CURRENT group (the group at open time was never recorded)",
        },
      },
    });
    lines.push(`filled ${filled} positions; audit row ${AUDIT_ACTION} written`);
  } else if (opts.apply) {
    lines.push("nothing to fill; no audit row written");
  } else {
    lines.push("dry run: nothing written (add --apply to write)");
  }
  return { byCategory, noGroup, filled, lines };
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new BackfillRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new BackfillRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new BackfillRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  // always required to write, local databases included
  if (apply && confirm !== host) throw new BackfillRefused(`--apply on ${host} needs --confirm-host=${host}`);

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return backfillGroupCategory(tx, { apply });
      },
      { timeout: 300_000, maxWait: 20_000 },
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /backfill-position-group-category\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof BackfillRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
