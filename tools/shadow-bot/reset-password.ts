// Shadow bot: a new trader password for the bot accounts of the zzshadowbot test broker, and nothing else
// (owner 2026-10-26: the old SHADOWBOT_PASSWORD was lost).
//
//   npx tsx --env-file=<file with DATABASE_URL and DIRECT_URL> tools/shadow-bot/reset-password.ts            dry run
//   npx tsx --env-file=<...> tools/shadow-bot/reset-password.ts --apply --confirm-host=<db host> [--out=<file>]
//
// - The broker is the hard-coded subdomain below; the accounts are the bot's own 49990001-49990013 (src/guards.ts). The
//   broker hedge account 49990099 is never touched. Every account must exist and belong to that broker, or nothing is changed.
// - The dry run (default) only reads and lists what --apply would change.
// - --apply generates the password, writes it to --out (default C:\vyx-secrets\shadowbot-password.txt; an existing
//   file is never overwritten), then sets every account's hash and one ACCOUNT_PASSWORD_SET audit row each, in one
//   transaction. If the transaction fails, the file is removed again and the old password still works.
// - The password is never printed or logged.
// - Existing trader sessions of these accounts are not revoked (they live in Redis); the bot signs in fresh on every run.
import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { existsSync, renameSync, rmSync, writeFileSync } from "node:fs";

const SUBDOMAIN = "zzshadowbot";
const ACCOUNTS = Array.from({ length: 13 }, (_, i) => String(49990001 + i));
const DEFAULT_OUT = "C:\\vyx-secrets\\shadowbot-password.txt";

class Refused extends Error {}
const hostOf = (url: string) => new URL(url).hostname.toLowerCase();

/** 24 characters from 18 random bytes, always with a letter and a digit (the platform's password rule). */
function newPassword(): string {
  for (;;) {
    const pw = randomBytes(18).toString("base64url");
    if (/[A-Za-z]/.test(pw) && /[0-9]/.test(pw)) return pw;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const out = args.find((a) => a.startsWith("--out="))?.slice("--out=".length) || DEFAULT_OUT;
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host=") && !a.startsWith("--out="));
  if (unknown.length) throw new Refused(`unknown argument(s): ${unknown.join(" ")}`);

  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new Refused("set DATABASE_URL and DIRECT_URL (for example with tsx --env-file=<file>); ./.env is never used");
  const host = hostOf(url);
  if (host.replace("-pooler", "") !== hostOf(direct).replace("-pooler", "")) throw new Refused("DATABASE_URL and DIRECT_URL point at different databases");
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new Refused(`--apply on ${host} needs --confirm-host=${host}`);
  if (apply && existsSync(out)) throw new Refused(`${out} already exists: move it away first (it is never overwritten)`);

  console.log(`database: ${host}${local ? " (local)" : ""}; mode: ${apply ? "APPLY" : "dry run"}`);
  const prisma = new PrismaClient();
  try {
    const broker = await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN }, select: { id: true, subdomain: true } });
    if (!broker || broker.subdomain !== SUBDOMAIN) throw new Refused(`broker ${SUBDOMAIN} not found`);
    const rows = await prisma.account.findMany({ where: { accountNumber: { in: ACCOUNTS } }, select: { id: true, accountNumber: true, brokerId: true } });
    const missing = ACCOUNTS.filter((n) => !rows.some((r) => r.accountNumber === n));
    if (missing.length) throw new Refused(`accounts not found: ${missing.join(", ")}`);
    const foreign = rows.filter((r) => r.brokerId !== broker.id).map((r) => r.accountNumber);
    if (foreign.length) throw new Refused(`accounts not on ${SUBDOMAIN}: ${foreign.join(", ")}`);
    console.log(`${rows.length} bot accounts on ${SUBDOMAIN}: ${ACCOUNTS[0]}-${ACCOUNTS[ACCOUNTS.length - 1]} (49990099 untouched)`);
    if (!apply) {
      console.log(`dry run: --apply would set one new password on all ${rows.length} and write it to ${out}`);
      return;
    }

    const password = newPassword();
    const passwordHash = await bcrypt.hash(password, 10);
    const tmp = `${out}.tmp-${process.pid}`;
    writeFileSync(tmp, password, { encoding: "utf8", flag: "wx" });
    try {
      await prisma.$transaction(async (tx) => {
        for (const r of rows) {
          await tx.account.update({ where: { id: r.id }, data: { passwordHash } });
          await tx.auditLog.create({
            data: { brokerId: broker.id, action: "ACCOUNT_PASSWORD_SET", entityType: "Account", entityId: r.id, newValue: { accountNumber: r.accountNumber, by: "tools/shadow-bot/reset-password.ts" } },
          });
        }
      });
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
    renameSync(tmp, out);
    console.log(`APPLIED: new password set on ${rows.length} accounts; written to ${out} (not printed)`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Refused ? `REFUSED: ${e.message}` : e);
  process.exitCode = 1;
});
