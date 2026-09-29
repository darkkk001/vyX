// The shadow bot's READ-ONLY staff observer on zzshadowbot (S5, owner go 2026-09-29): lets the bot see the broker's
// coverage account 49990099 (the auto-hedge leg appearing / closing) without a trade login on that system account.
//
//   observer@zzshadowbot.local   role SUPPORT, extraPermissions [] (the read-only role: it may read the GET routes
//                                marked supportRead in lib/manage-permission-manifest.ts, EVERY write refuses it --
//                                app/api/manage/permission-matrix.test.ts proves each route), ACTIVE, 2FA ENABLED,
//                                no backup codes.
//
// Credentials are generated here on --apply (a random password + a fresh TOTP secret) and written ONLY to the local
// credentials file (default %USERPROFILE%\.vyx\shadowbot-observer.json, outside every repo); they are never printed
// (the file's path and a sha256 prefix are). The bot signs in with them: POST /api/manage/login, then
// /login/verify-2fa with the TOTP code it computes from the secret (RFC 6238, the web's lib/totp.ts parameters).
// A re-run with the user already in shape changes nothing; --rotate issues new credentials (and a new file).
// The tenant seed's --reset-trading never touches this user; its audit row (SHADOWBOT_OBSERVER) is kept by it.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/seed-zzshadowbot-observer.ts                    (dry run)
//   ... npx tsx scripts/seed-zzshadowbot-observer.ts --apply --confirm-host=<db host> [--rotate] [--creds-file=<path>]
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { Prisma, PrismaClient } from "@prisma/client";
import { SUBDOMAIN, hostOf } from "./seed-zzshadowbot";

type Db = Prisma.TransactionClient | PrismaClient;

export const OBSERVER_ROLE = "SUPPORT" as const;
export const observerEmail = (tenant: string) => `observer@${tenant}.local`;
export const DEFAULT_CREDS_FILE = path.join(os.homedir(), ".vyx", "shadowbot-observer.json");

export class ObserverSeedRefused extends Error {}

export type ObserverCreds = { email: string; password: string; totpSecret: string; tenant: string; createdAt: string };
export type ObserverOptions = { apply: boolean; rotate: boolean; tenant?: string };
export type ObserverResult = { lines: string[]; changes: number; creds: ObserverCreds | null };

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
/** A TOTP secret exactly like lib/totp.ts generateTotpSecret: 20 random bytes, base32 without padding. */
export function newTotpSecret(): string {
  const buf = randomBytes(20);
  let bits = 0, value = 0, out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** The observer's shape: anything else is corrected (never widened). */
const WANT = { role: OBSERVER_ROLE, status: "ACTIVE" as const, extraPermissions: [] as string[], twoFactorEnabled: true };

export async function seedObserver(db: Db, opts: ObserverOptions): Promise<ObserverResult> {
  const tenant = opts.tenant ?? SUBDOMAIN;
  const lines: string[] = [];
  let changes = 0;
  const broker = await db.broker.findUnique({ where: { subdomain: tenant }, select: { id: true } });
  if (!broker) throw new ObserverSeedRefused(`tenant ${tenant} does not exist (run scripts/seed-zzshadowbot.ts first)`);
  const email = observerEmail(tenant);
  const existing = await db.adminUser.findUnique({ where: { email } });
  if (existing && existing.brokerId !== broker.id) throw new ObserverSeedRefused(`${email} exists on another broker (${existing.brokerId}): refusing to move it`);
  lines.push(`database tenant ${tenant} (${broker.id})  mode: ${opts.apply ? "APPLY" : "DRY RUN"}${opts.rotate ? " + ROTATE" : ""}`);

  const fresh = (): ObserverCreds => ({ email, password: randomBytes(24).toString("hex"), totpSecret: newTotpSecret(), tenant, createdAt: new Date().toISOString() });
  let creds: ObserverCreds | null = null;

  if (!existing) {
    creds = fresh();
    lines.push(`CREATE staff ${email}: role ${WANT.role}, extraPermissions [], ACTIVE, 2FA enabled (new secret), password (new), no backup codes`);
    changes++;
    if (opts.apply) {
      const passwordHash = await bcrypt.hash(creds.password, 10);
      await db.adminUser.create({ data: { brokerId: broker.id, email, passwordHash, ...WANT, twoFactorSecret: creds.totpSecret } });
    }
  } else {
    const fix: string[] = [];
    if (existing.role !== WANT.role) fix.push(`role ${existing.role} -> ${WANT.role}`);
    if (existing.status !== WANT.status) fix.push(`status ${existing.status} -> ${WANT.status}`);
    if (existing.extraPermissions.length) fix.push(`extraPermissions [${existing.extraPermissions.join(", ")}] -> []`);
    if (!existing.twoFactorEnabled || !existing.twoFactorSecret) {
      if (!opts.rotate) throw new ObserverSeedRefused(`${email} has no working 2FA: re-run with --rotate to issue new credentials`);
    }
    const backup = await db.adminBackupCode.count({ where: { adminId: existing.id } });
    if (backup) fix.push(`${backup} backup code(s) -> none`);
    if (opts.rotate) {
      creds = fresh();
      fix.push("credentials rotated (new password, new 2FA secret)");
    }
    if (fix.length) {
      lines.push(`UPDATE staff ${email}: ${fix.join("; ")}`);
      changes++;
      if (opts.apply) {
        await db.adminBackupCode.deleteMany({ where: { adminId: existing.id } });
        await db.adminUser.update({
          where: { id: existing.id },
          data: { ...WANT, ...(creds ? { passwordHash: await bcrypt.hash(creds.password, 10), twoFactorSecret: creds.totpSecret } : {}) },
        });
      }
    } else {
      lines.push(`ok     staff ${email} (role ${WANT.role}, no extra permissions, ACTIVE, 2FA on; credentials unchanged)`);
    }
  }
  if (changes && opts.apply) {
    await db.auditLog.create({
      data: { brokerId: broker.id, actorAdminId: null, action: "SHADOWBOT_OBSERVER", entityType: "AdminUser", entityId: email, newValue: { lines, role: WANT.role, rotated: Boolean(creds) } },
    });
  }
  lines.push(`${changes} change(s) ${opts.apply ? "applied" : "planned (dry run: nothing written)"}`);
  return { lines, changes, creds };
}

/** Write the credentials file atomically (a sibling temp, then a rename); returns the file's sha256 prefix. */
export function writeCredsFile(file: string, creds: ObserverCreds): string {
  mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(creds, null, 2) + "\n";
  const tmp = `${file}.pending`;
  writeFileSync(tmp, body, { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  return createHash("sha256").update(body).digest("hex").slice(0, 12);
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const rotate = args.includes("--rotate");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const credsFile = args.find((a) => a.startsWith("--creds-file="))?.slice("--creds-file=".length) || DEFAULT_CREDS_FILE;
  const unknown = args.filter((a) => a !== "--apply" && a !== "--rotate" && !a.startsWith("--confirm-host=") && !a.startsWith("--creds-file="));
  if (unknown.length) throw new ObserverSeedRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new ObserverSeedRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new ObserverSeedRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new ObserverSeedRefused(`--apply on ${host} needs --confirm-host=${host}`);
  // the file must be writable BEFORE anything is written to the database
  if (apply) mkdirSync(path.dirname(credsFile), { recursive: true });

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  let pending: ObserverCreds | null = null;
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        const r = await seedObserver(tx, { apply, rotate });
        // written inside the transaction window: a failed write rolls the user back (no user without its credentials)
        if (apply && r.creds) {
          writeCredsFile(`${credsFile}.new`, r.creds);
          pending = r.creds;
        }
        return r;
      },
      { timeout: 60_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
    if (pending) {
      renameSync(`${credsFile}.new`, credsFile);
      const digest = createHash("sha256").update(JSON.stringify(pending, null, 2) + "\n").digest("hex").slice(0, 12);
      console.log(`credentials written to ${credsFile} (sha256 ${digest}; never printed, never commit it)`);
    } else if (apply && !existsSync(credsFile)) {
      console.log(`NOTE   no credentials file at ${credsFile}: the user exists, re-run with --rotate to issue new ones`);
    }
  } catch (e) {
    rmSync(`${credsFile}.new`, { force: true });
    throw e;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /seed-zzshadowbot-observer\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof ObserverSeedRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
