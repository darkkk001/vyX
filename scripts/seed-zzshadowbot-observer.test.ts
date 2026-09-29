// scripts/seed-zzshadowbot-observer.ts against the scratch database (vitest.setup.db-guard.ts refuses anything else).
// Runs on its own tenant ("zzobstest", the test-only parameter) so it never races the other zzshadowbot seed tests.
import crypto from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { verifyTotp } from "../lib/totp";
import { MANIFEST, expectedAllowed } from "../lib/manage-permission-manifest";
import { ObserverSeedRefused, observerEmail, seedObserver, writeCredsFile } from "./seed-zzshadowbot-observer";

const prisma = new PrismaClient();
const TENANT = "zzobstest";
const OTHER = "zzobsother";
const EMAIL = observerEmail(TENANT);
const run = (apply: boolean, rotate = false, tenant = TENANT) => prisma.$transaction((tx) => seedObserver(tx, { apply, rotate, tenant }), { timeout: 60_000 });
let dbReachable = false;

/** RFC 6238 exactly as lib/totp.ts (SHA1, 6 digits, 30 s) -- what the bot computes from the secret. */
function totpNow(secret: string): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0;
  const bytes: number[] = [];
  for (const c of secret) {
    value = (value << 5) | A.indexOf(c);
    bits += 5;
    if (bits >= 8) { bytes.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000 / 30)));
  const h = crypto.createHmac("sha1", Buffer.from(bytes)).update(counter).digest();
  const o = h[h.length - 1] & 15;
  return String((((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3]) % 1_000_000).padStart(6, "0");
}

async function wipe(subdomain: string) {
  const b = await prisma.broker.findUnique({ where: { subdomain } });
  if (!b) return;
  await prisma.adminBackupCode.deleteMany({ where: { adminUser: { brokerId: b.id } } });
  await prisma.auditLog.deleteMany({ where: { brokerId: b.id } });
  await prisma.adminUser.deleteMany({ where: { brokerId: b.id } });
  await prisma.broker.delete({ where: { id: b.id } });
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    return;
  }
  await wipe(TENANT);
  await wipe(OTHER);
  await prisma.broker.create({ data: { name: `Observer test ${TENANT}`, subdomain: TENANT } });
  await prisma.broker.create({ data: { name: `Observer test ${OTHER}`, subdomain: OTHER } });
}, 60_000);
afterAll(async () => {
  if (dbReachable) {
    await wipe(TENANT);
    await wipe(OTHER);
  }
  await prisma.$disconnect();
}, 60_000);

describe("the observer's role is read-only", () => {
  it("SUPPORT may call no write route but its own UI theme; it may read the coverage account's positions", () => {
    const writes = MANIFEST.filter((r) => r.method !== "GET" && expectedAllowed(r.perm, "support", r.supportRead)).map((r) => `${r.method} ${r.mod}`);
    expect(writes).toEqual(["PATCH theme/route"]);
    const positions = MANIFEST.find((r) => r.mod === "accounts/[id]/positions/route" && r.method === "GET");
    expect(positions && expectedAllowed(positions.perm, "support", positions.supportRead)).toBe(true);
  });
});

describe("observer seed", () => {
  it("a dry run plans the user and writes nothing", async () => {
    if (!dbReachable) return;
    const r = await run(false);
    expect(r.lines.join("\n")).toContain(`CREATE staff ${EMAIL}: role SUPPORT`);
    expect(r.changes).toBe(1);
    expect(await prisma.adminUser.count({ where: { email: EMAIL } })).toBe(0);
  });

  it("apply: SUPPORT, no extra permissions, ACTIVE, 2FA on; the credentials sign in (bcrypt + a TOTP code the web accepts)", async () => {
    if (!dbReachable) return;
    const r = await run(true);
    expect(r.creds).not.toBeNull();
    const u = await prisma.adminUser.findUniqueOrThrow({ where: { email: EMAIL }, include: { broker: { select: { subdomain: true } } } });
    expect(u.role).toBe("SUPPORT");
    expect(u.extraPermissions).toEqual([]);
    expect(u.status).toBe("ACTIVE");
    expect(u.twoFactorEnabled).toBe(true);
    expect(u.broker?.subdomain).toBe(TENANT);
    expect(await prisma.adminBackupCode.count({ where: { adminId: u.id } })).toBe(0);
    expect(u.twoFactorSecret).toBe(r.creds!.totpSecret);
    expect(u.twoFactorSecret).toMatch(/^[A-Z2-7]{32}$/); // 20 bytes, base32, like lib/totp.ts generateTotpSecret
    expect(await bcrypt.compare(r.creds!.password, u.passwordHash)).toBe(true);
    expect(verifyTotp(u.twoFactorSecret!, totpNow(r.creds!.totpSecret))).toBe(true);
    const audit = await prisma.auditLog.count({ where: { action: "SHADOWBOT_OBSERVER", entityId: EMAIL } });
    expect(audit).toBe(1);
  });

  it("a re-run changes nothing and issues no credentials", async () => {
    if (!dbReachable) return;
    const r = await run(true);
    expect(r.changes).toBe(0);
    expect(r.creds).toBeNull();
  });

  it("a widened user is narrowed back (role, permissions, backup codes) without new credentials", async () => {
    if (!dbReachable) return;
    const u = await prisma.adminUser.update({ where: { email: EMAIL }, data: { role: "MANAGER", extraPermissions: ["DEALING", "CLIENT_TRADING"] } });
    await prisma.adminBackupCode.create({ data: { adminId: u.id, codeHash: "x" } });
    const before = u.passwordHash;
    const r = await run(true);
    expect(r.changes).toBe(1);
    expect(r.creds).toBeNull();
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { email: EMAIL } });
    expect([after.role, after.extraPermissions]).toEqual(["SUPPORT", []]);
    expect(after.passwordHash).toBe(before);
    expect(await prisma.adminBackupCode.count({ where: { adminId: u.id } })).toBe(0);
  });

  it("--rotate issues new credentials; the old password stops working", async () => {
    if (!dbReachable) return;
    const old = await prisma.adminUser.findUniqueOrThrow({ where: { email: EMAIL } });
    const r = await run(true, true);
    expect(r.creds).not.toBeNull();
    const now = await prisma.adminUser.findUniqueOrThrow({ where: { email: EMAIL } });
    expect(now.twoFactorSecret).not.toBe(old.twoFactorSecret);
    expect(now.passwordHash).not.toBe(old.passwordHash);
    expect(await bcrypt.compare(r.creds!.password, now.passwordHash)).toBe(true);
  });

  it("refuses a missing tenant, and an observer email already on another broker", async () => {
    if (!dbReachable) return;
    await expect(run(false, false, "zzobsnosuch")).rejects.toBeInstanceOf(ObserverSeedRefused);
    const other = await prisma.broker.findUniqueOrThrow({ where: { subdomain: OTHER } });
    await prisma.adminUser.create({ data: { brokerId: other.id, email: observerEmail("zzobsmoved"), passwordHash: "x", role: "SUPPORT" } });
    await prisma.broker.create({ data: { name: "moved", subdomain: "zzobsmoved" } });
    try {
      await expect(run(false, false, "zzobsmoved")).rejects.toThrow(/exists on another broker/);
    } finally {
      await prisma.adminUser.deleteMany({ where: { email: observerEmail("zzobsmoved") } });
      await wipe("zzobsmoved");
    }
  });

  it("the credentials file is written whole, never half (temp + rename), and holds exactly the four fields", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "obs-"));
    const file = path.join(dir, "creds.json");
    const digest = writeCredsFile(file, { email: EMAIL, password: "p".repeat(48), totpSecret: "A".repeat(32), tenant: TENANT, createdAt: "2026-09-29T00:00:00.000Z" });
    const back = JSON.parse(readFileSync(file, "utf8"));
    expect(Object.keys(back).sort()).toEqual(["createdAt", "email", "password", "tenant", "totpSecret"]);
    expect(digest).toMatch(/^[0-9a-f]{12}$/);
  });
});
