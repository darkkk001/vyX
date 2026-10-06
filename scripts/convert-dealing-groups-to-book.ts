// Converts the owner's chosen DEALING groups to Book (B_BOOK). Owner decision 2026-10-06 (D0): the "Dealing desk" box is
// unchecked for these groups. No fill behaviour changes: every listed broker has the dealing desk on auto-fill, no
// broker-wide manual review, no auto-hedge, no explicit group dealingMode override is touched (QA Dealing Test keeps its
// MANUAL override), and the dry run shows 0 waiting orders before anything is written.
//
// Only Group.category (DEALING -> B_BOOK), the legacy shadow column Group.groupType and forceDealingMode (already false,
// stored false) are written. Pricing (GroupSymbolConfig), allowed symbols, leverage, levels, volumes and swap-free are
// not touched; the dry run prints a fingerprint of every other column and of the group's symbol rows, and the apply run
// re-checks both after the write and rolls back if either moved.
//
// zzshadowbot "SB Dealing Desk" is never touched (soak bot), even if named.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/convert-dealing-groups-to-book.ts                (dry run)
//   ... npx tsx scripts/convert-dealing-groups-to-book.ts --apply --confirm-host=<db host>
import { createHash } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { legacyGroupTypeFor } from "@/lib/group-routing";
import { checkAccountStructure } from "@/lib/account-structure";

type Db = Prisma.TransactionClient | PrismaClient;

export class ConvertRefused extends Error {}

export const TARGETS: { broker: string; group: string }[] = [
  { broker: "futurixglobal", group: "Dealing" },
  { broker: "acmefx", group: "Standard" },
  { broker: "acmefx", group: "ECN-Swap Free" },
  { broker: "acmefx", group: "Swap Free" },
  { broker: "zzzqa", group: "Standard-USD" },
  { broker: "zzzqa", group: "QA Dealing Test" },
];
const NEVER = { broker: "zzshadowbot", group: "SB Dealing Desk" };
export const AUDIT_ACTION = "GROUP_CONFIG_UPDATED";
export const AUDIT_SOURCE = "owner decision 2026-10-06: Dealing desk unchecked, group is Book (scripts/convert-dealing-groups-to-book.ts)";
const OPEN_ORDER = ["PENDING", "ACCEPTED", "REQUOTED"] as const;

/** Every Group column except the ones this script writes, plus the group's symbol rows, hashed. */
async function fingerprint(db: Db, groupId: string): Promise<string> {
  const rows = await db.$queryRawUnsafe<{ g: unknown; s: unknown }[]>(
    `SELECT (to_jsonb(g) - 'category' - 'groupType' - 'forceDealingMode' - 'updatedAt') AS g,
            (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]'::jsonb) FROM "GroupSymbolConfig" c WHERE c."groupId" = g.id) AS s
       FROM "Group" g WHERE g.id = $1`,
    groupId,
  );
  return createHash("sha256").update(JSON.stringify(rows[0] ?? null)).digest("hex").slice(0, 16);
}

export async function convertDealingGroups(db: Db, opts: { apply: boolean; targets?: typeof TARGETS }) {
  const lines: string[] = [`mode: ${opts.apply ? "APPLY" : "DRY RUN"}`];
  let converted = 0;
  for (const t of opts.targets ?? TARGETS) {
    if (t.broker === NEVER.broker && t.group === NEVER.group) throw new ConvertRefused(`${t.broker} / ${t.group} is the soak bot's group and is never converted`);
    const g = await db.group.findFirst({
      where: { name: t.group, broker: { subdomain: t.broker } },
      select: { id: true, brokerId: true, name: true, category: true, modeRestriction: true, forceDealingMode: true, dealingMode: true, groupType: true },
    });
    if (!g) { lines.push(`  ${t.broker} / ${t.group}: NOT FOUND, skipped`); continue; }
    if (g.category !== "DEALING") { lines.push(`  ${t.broker} / ${t.group}: already ${g.category}, nothing to do`); continue; }
    const broker = await db.broker.findUniqueOrThrow({ where: { id: g.brokerId }, select: { dealingModeAt: true, dealingDeskAutoFillAt: true, autoHedgeAt: true } });
    const waiting = await db.order.count({ where: { status: { in: [...OPEN_ORDER] }, account: { groupId: g.id } } });
    const accounts = await db.account.groupBy({ by: ["accountMode"], where: { groupId: g.id }, _count: { _all: true } });
    const routing = { category: "B_BOOK" as const, modeRestriction: g.modeRestriction };
    for (const m of accounts) {
      const v = checkAccountStructure({ accountMode: m.accountMode, group: routing, allowCoverage: false });
      if (v) throw new ConvertRefused(`${t.broker} / ${t.group}: ${v.message}`);
    }
    // the "no behaviour change" preconditions: otherwise a fill would route differently tomorrow
    const why: string[] = [];
    if (broker.dealingModeAt) why.push("broker-wide manual review is on");
    if (!broker.dealingDeskAutoFillAt && g.dealingMode === "INHERIT") why.push("dealing desk is in review (orders queue today)");
    if (broker.autoHedgeAt) why.push("auto-hedge is on (DEALING fills are hedged today)");
    if (g.forceDealingMode) why.push("group is forced to the dealer");
    if (waiting > 0) why.push(`${waiting} order(s) waiting`);
    if (why.length) throw new ConvertRefused(`${t.broker} / ${t.group} would change behaviour: ${why.join("; ")}`);

    const before = await fingerprint(db, g.id);
    const n = accounts.reduce((s, m) => s + m._count._all, 0);
    lines.push(`  ${t.broker} / ${t.group}: DEALING -> B_BOOK (dealingMode ${g.dealingMode} kept, ${n} account(s), 0 waiting orders, other columns + symbol rows ${before})`);
    if (!opts.apply) continue;

    const groupType = legacyGroupTypeFor(routing);
    const r = await db.group.updateMany({ where: { id: g.id, category: "DEALING" }, data: { category: "B_BOOK", groupType, forceDealingMode: false } });
    if (r.count !== 1) throw new ConvertRefused(`${t.broker} / ${t.group}: changed by someone else during the run`);
    const after = await fingerprint(db, g.id);
    if (after !== before) throw new ConvertRefused(`${t.broker} / ${t.group}: other columns or symbol rows moved (${before} -> ${after}); rolled back`);
    await db.auditLog.create({
      data: {
        brokerId: g.brokerId,
        action: AUDIT_ACTION,
        entityType: "Group",
        entityId: g.id,
        oldValue: { category: g.category, groupType: g.groupType, forceDealingMode: g.forceDealingMode },
        newValue: { category: "B_BOOK", groupType, forceDealingMode: false, source: AUDIT_SOURCE },
      },
    });
    converted += 1;
  }
  lines.push(opts.apply ? `converted ${converted} group(s); ${converted} audit row(s) ${AUDIT_ACTION} written` : "dry run: nothing written (add --apply to write)");
  return { converted, lines };
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new ConvertRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new ConvertRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new ConvertRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  if (apply && confirm !== host) throw new ConvertRefused(`--apply on ${host} needs --confirm-host=${host}`);

  console.log(`database: ${host}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return convertDealingGroups(tx, { apply });
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /convert-dealing-groups-to-book\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof ConvertRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
