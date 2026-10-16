// Sets every broker's staff two-step sign-in policy (Broker.requireAdmin2fa) from the owner's shell.
//
//   npx tsx scripts/set-staff-2fa-policy.ts --optional qoretrader                                          dry run
//   npx tsx scripts/set-staff-2fa-policy.ts --optional qoretrader --apply --confirm-host ep-morning-glade  write
//
// - requireAdmin2fa = true (Required) for EVERY broker, except the subdomains named by --optional (comma-separated),
//   which get false (Optional). Run this BEFORE deploying the code that honours the flag: the column defaults to false
//   and was ignored until now, so without it every broker would turn Optional.
// - Prints each broker: subdomain, current value, new value, staff count, staff with 2FA.
// - One AuditLog row per changed broker (BROKER_STAFF_2FA_POLICY_CHANGED, old/new value, no actor, source script).
// - Idempotent: a broker already at the target value is left alone and gets no audit row.
// - DRY RUN by default. --apply needs --confirm-host <prefix of the database host>. DATABASE_URL and DIRECT_URL must be
//   in the environment and name the same database; ./.env is never read.
import { PrismaClient, type Prisma } from "@prisma/client";

export class Refused extends Error {}

const SOURCE = "scripts/set-staff-2fa-policy.ts";

export type PolicyRow = { subdomain: string; current: boolean; next: boolean; staff: number; staffWith2fa: number; changed: boolean };

export async function setStaff2faPolicy(
  tx: Prisma.TransactionClient,
  opts: { apply: boolean; optional: string[] },
): Promise<{ lines: string[]; rows: PolicyRow[]; changes: number }> {
  const brokers = await tx.broker.findMany({ select: { id: true, subdomain: true, requireAdmin2fa: true }, orderBy: { subdomain: "asc" } });
  const known = new Set(brokers.map((b) => b.subdomain));
  for (const s of opts.optional) if (!known.has(s)) throw new Refused(`--optional names ${s}, which is not a broker subdomain`);
  const lines: string[] = [`mode: ${opts.apply ? "APPLY" : "DRY RUN"}`];
  const rows: PolicyRow[] = [];
  for (const b of brokers) {
    const next = !opts.optional.includes(b.subdomain);
    const [staff, staffWith2fa] = await Promise.all([
      tx.adminUser.count({ where: { brokerId: b.id } }),
      tx.adminUser.count({ where: { brokerId: b.id, twoFactorEnabled: true } }),
    ]);
    const changed = b.requireAdmin2fa !== next;
    rows.push({ subdomain: b.subdomain, current: b.requireAdmin2fa, next, staff, staffWith2fa, changed });
    lines.push(
      `${b.subdomain}: requireAdmin2fa ${b.requireAdmin2fa} -> ${next} (${next ? "Required" : "Optional"})${changed ? "" : " [unchanged]"}  staff ${staff}, with 2FA ${staffWith2fa}`,
    );
    if (changed && opts.apply) {
      await tx.broker.update({ where: { id: b.id }, data: { requireAdmin2fa: next } });
      await tx.auditLog.create({
        data: {
          brokerId: b.id,
          actorAdminId: null,
          action: "BROKER_STAFF_2FA_POLICY_CHANGED",
          entityType: "Broker",
          entityId: b.id,
          oldValue: { requireAdmin2fa: b.requireAdmin2fa },
          newValue: { requireAdmin2fa: next, source: SOURCE },
        },
      });
    }
  }
  const changes = rows.filter((r) => r.changed).length;
  lines.push(opts.apply ? `applied: ${changes} broker(s) changed` : `dry run: nothing written (${changes} broker(s) would change)`);
  return { lines, rows, changes };
}

const hostOf = (url: string | undefined) => {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
};

function parseArgs(argv: string[]) {
  let apply = false;
  let confirm: string | undefined;
  let optional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-host") confirm = argv[++i];
    else if (a.startsWith("--confirm-host=")) confirm = a.slice("--confirm-host=".length);
    else if (a === "--optional") optional = (argv[++i] ?? "").split(",");
    else if (a.startsWith("--optional=")) optional = a.slice("--optional=".length).split(",");
    else throw new Refused(`unknown argument: ${a}`);
  }
  optional = optional.map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { apply, optional, confirm: confirm?.trim().toLowerCase() };
}

async function main() {
  const { apply, optional, confirm } = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new Refused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new Refused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && (!confirm || !(endpoint(host) === confirm || endpoint(host).startsWith(`${confirm}-`) || endpoint(host).startsWith(`${confirm}.`)))) {
    throw new Refused(`--apply on ${host} needs --confirm-host with that host (or its first part, e.g. ${endpoint(host).split("-").slice(0, 3).join("-")})`);
  }
  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const r = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return setStaff2faPolicy(tx, { apply, optional });
      },
      { timeout: 60_000, maxWait: 20_000 },
    );
    for (const l of r.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /set-staff-2fa-policy\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Refused ? `refused: ${e.message}` : e);
    process.exit(1);
  });
}
