// Sets a new password for ONE backoffice staff member (AdminUser) of one broker, from the owner's shell.
//
//   npx tsx scripts/reset-staff-password.ts <subdomain> <email>                                          dry run
//   npx tsx scripts/reset-staff-password.ts <subdomain> <email> --apply --confirm-host ep-morning-glade   write
//
// - The new password comes ONLY from the environment variable NEW_STAFF_PASSWORD. It is never printed, logged or passed
//   as an argument (arguments land in shell history and process lists).
// - Hashed exactly like the app (bcryptjs, cost 10: app/api/admin/admins/route.ts, app/api/admin/change-password).
// - Writes only that AdminUser row: passwordHash, and passwordChangedAt = now (the owner chose this password, so it is
//   not a temporary one that the broker's change interval should force out at the next sign-in). No audit row, no
//   session change: existing sign-ins of this person stay valid until they expire (the Super Admin reset revokes them).
// - The staff member must belong to the broker with that subdomain; a super admin (no broker) is refused.
// - DRY RUN by default: shows the row it would touch, writes nothing. --apply needs --confirm-host <prefix of the database
//   host> (e.g. ep-morning-glade). DATABASE_URL and DIRECT_URL must be in the environment and name the same database;
//   ./.env is never read.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

class Refused extends Error {}

const hostOf = (url: string | undefined) => {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let apply = false;
  let confirm: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-host") confirm = argv[++i];
    else if (a.startsWith("--confirm-host=")) confirm = a.slice("--confirm-host=".length);
    else if (a.startsWith("--")) throw new Refused(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Refused("usage: reset-staff-password.ts <subdomain> <email> [--apply --confirm-host <db host prefix>]");
  return { subdomain: positional[0].trim().toLowerCase(), email: positional[1].trim().toLowerCase(), apply, confirm: confirm?.trim().toLowerCase() };
}

async function main() {
  const { subdomain, email, apply, confirm } = parseArgs(process.argv.slice(2));

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

  const password = process.env.NEW_STAFF_PASSWORD ?? "";
  if (password.length === 0) throw new Refused("set NEW_STAFF_PASSWORD in the environment");
  if (password.length < 8) throw new Refused("NEW_STAFF_PASSWORD is shorter than 8 characters (the app's minimum)");

  console.log(`database: ${host}${local ? " (local)" : ""}  mode: ${apply ? "APPLY" : "DRY RUN"}`);
  const prisma = new PrismaClient();
  try {
    const broker = await prisma.broker.findUnique({ where: { subdomain }, select: { id: true, name: true, subdomain: true } });
    if (!broker) throw new Refused(`no broker with subdomain ${subdomain}`);
    const admin = await prisma.adminUser.findUnique({
      where: { email },
      select: { id: true, email: true, role: true, status: true, brokerId: true, twoFactorEnabled: true, lastLoginAt: true, passwordChangedAt: true, passwordHash: true },
    });
    if (!admin) throw new Refused(`no staff member with e-mail ${email}`);
    if (admin.brokerId !== broker.id) throw new Refused(`${email} is not staff of ${subdomain}`);

    const when = (d: Date | null) => (d ? d.toISOString() : "never");
    console.log(`row: AdminUser ${admin.id}  ${admin.email}  broker ${broker.subdomain} (${broker.name})  role ${admin.role}  status ${admin.status}  2FA ${admin.twoFactorEnabled ? "on" : "off"}  last sign-in ${when(admin.lastLoginAt)}  password set ${when(admin.passwordChangedAt)}`);
    if (admin.status !== "ACTIVE") console.log(`note: status is ${admin.status}; this script changes only the password, not the status`);
    console.log("change: passwordHash -> new bcrypt hash (cost 10), passwordChangedAt -> now");

    if (!apply) {
      console.log("dry run: nothing written");
      return;
    }

    const passwordHash = await bcrypt.hash(password, 10);
    // only this row, and only if nobody changed its password since it was read above
    const updated = await prisma.adminUser.updateMany({
      where: { id: admin.id, passwordHash: admin.passwordHash },
      data: { passwordHash, passwordChangedAt: new Date() },
    });
    if (updated.count !== 1) throw new Refused(`expected to update 1 row, updated ${updated.count} (changed meanwhile?)`);
    const after = await prisma.adminUser.findUnique({ where: { id: admin.id }, select: { passwordHash: true } });
    if (!after || !(await bcrypt.compare(password, after.passwordHash))) throw new Refused("written, but the stored hash does not verify against NEW_STAFF_PASSWORD");
    console.log("applied: 1 row updated; the new password verifies against the stored hash");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Refused ? `refused: ${e.message}` : e);
  process.exit(1);
});
