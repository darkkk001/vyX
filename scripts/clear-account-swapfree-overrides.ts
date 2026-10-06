// Clears every account-level swap-free override (Account.swapFree true/false -> null). Owner decision 2026-10-06 (S1):
// swap-free is decided by the GROUP only, and the account-level control is gone from the backoffice and the staff route
// (PATCH /api/manage/accounts/[id] refuses "swapFree"), so a stored override could never be seen or changed again.
//
// Dry run by default (read-only transaction): lists every account that has an override with its current value.
// Writing needs BOTH --apply and --confirm-host=<the DATABASE_URL host>, local databases included. One AuditLog row per
// account (ACCOUNT_SWAP_FREE_CHANGED, old -> new) is written in the same transaction. A second run finds nothing and
// changes 0 accounts.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/clear-account-swapfree-overrides.ts                (dry run)
//   ... npx tsx scripts/clear-account-swapfree-overrides.ts --apply --confirm-host=<db host>
import { Prisma, PrismaClient } from "@prisma/client";

type Db = Prisma.TransactionClient | PrismaClient;

export class ClearRefused extends Error {}
export type ClearResult = { accounts: { id: string; accountNumber: string; brokerId: string; old: boolean }[]; cleared: number; lines: string[] };

export const AUDIT_ACTION = "ACCOUNT_SWAP_FREE_CHANGED";
export const AUDIT_SOURCE = "owner decision 2026-10-06: swap-free is set on the group only (scripts/clear-account-swapfree-overrides.ts)";

export async function clearSwapFreeOverrides(db: Db, opts: { apply: boolean; brokerId?: string }): Promise<ClearResult> {
  const found = await db.account.findMany({
    where: { swapFree: { not: null }, ...(opts.brokerId ? { brokerId: opts.brokerId } : {}) },
    select: { id: true, accountNumber: true, brokerId: true, swapFree: true },
    orderBy: [{ brokerId: "asc" }, { accountNumber: "asc" }],
  });
  const accounts = found.map((a) => ({ id: a.id, accountNumber: a.accountNumber, brokerId: a.brokerId, old: a.swapFree === true }));
  const lines = [`mode: ${opts.apply ? "APPLY" : "DRY RUN"}`, `accounts with an account-level swap-free override: ${accounts.length}`];
  for (const a of accounts) lines.push(`  ${a.accountNumber}  swapFree ${a.old ? "true (no swap)" : "false (swap charged)"} -> null (group decides)`);

  let cleared = 0;
  if (opts.apply) {
    for (const a of accounts) {
      // the guard in the WHERE keeps a concurrent edit from being overwritten or double-audited
      const r = await db.account.updateMany({ where: { id: a.id, swapFree: a.old }, data: { swapFree: null } });
      if (r.count === 0) continue;
      cleared += 1;
      await db.auditLog.create({
        data: {
          brokerId: a.brokerId,
          action: AUDIT_ACTION,
          entityType: "Account",
          entityId: a.id,
          oldValue: { swapFree: a.old },
          newValue: { swapFree: null, source: AUDIT_SOURCE },
        },
      });
    }
    lines.push(`cleared ${cleared} account(s); ${cleared} audit row(s) ${AUDIT_ACTION} written`);
  } else {
    lines.push("dry run: nothing written (add --apply to write)");
  }
  return { accounts, cleared, lines };
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new ClearRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new ClearRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new ClearRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  // always required to write, local databases included
  if (apply && confirm !== host) throw new ClearRefused(`--apply on ${host} needs --confirm-host=${host}`);

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return clearSwapFreeOverrides(tx, { apply });
      },
      { timeout: 120_000, maxWait: 20_000 },
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /clear-account-swapfree-overrides\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof ClearRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
