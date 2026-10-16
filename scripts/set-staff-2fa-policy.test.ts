import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { Refused, setStaff2faPolicy } from "./set-staff-2fa-policy";

// scripts/set-staff-2fa-policy.ts against the (cloned) scratch database: a dry run writes nothing, an apply sets Required for
// every broker except the --optional ones, audits each change once, and a second apply changes nothing.
const run = (apply: boolean, optional: string[]) =>
  prisma.$transaction(async (tx) => {
    if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return setStaff2faPolicy(tx, { apply, optional });
  });

let dbReachable = false;
const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => { await prisma.$disconnect(); });

describe("set-staff-2fa-policy", () => {
  it("dry run writes nothing; apply sets Required except --optional; re-apply is a no-op", async () => {
    if (!dbReachable) return;
    // the clone may already hold brokers; start from "all false", the live situation
    await prisma.broker.updateMany({ data: { requireAdmin2fa: false } });
    const fut = await prisma.broker.create({ data: { name: `Fut ${sfx}`, subdomain: `fut-${sfx}`, requireAdmin2fa: false } });
    const qore = await prisma.broker.create({ data: { name: `Qore ${sfx}`, subdomain: `qore-${sfx}`, requireAdmin2fa: false } });
    await prisma.adminUser.create({ data: { brokerId: fut.id, email: `a-${sfx}@t.local`, passwordHash: "x", role: "MANAGER", twoFactorEnabled: true } });
    await prisma.adminUser.create({ data: { brokerId: fut.id, email: `b-${sfx}@t.local`, passwordHash: "x", role: "MANAGER" } });
    const total = await prisma.broker.count();
    const auditBefore = await prisma.auditLog.count({ where: { action: "BROKER_STAFF_2FA_POLICY_CHANGED" } });

    const dry = await run(false, [`qore-${sfx}`]);
    expect(dry.changes).toBe(total - 1);
    expect(dry.lines.join("\n")).toContain(`fut-${sfx}: requireAdmin2fa false -> true (Required)  staff 2, with 2FA 1`);
    expect(await prisma.broker.count({ where: { requireAdmin2fa: true } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "BROKER_STAFF_2FA_POLICY_CHANGED" } })).toBe(auditBefore);

    const applied = await run(true, [`qore-${sfx}`]);
    expect(applied.changes).toBe(total - 1);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: fut.id } })).requireAdmin2fa).toBe(true);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: qore.id } })).requireAdmin2fa).toBe(false);
    expect(await prisma.broker.count({ where: { requireAdmin2fa: false } })).toBe(1);
    const logs = await prisma.auditLog.findMany({ where: { brokerId: fut.id, action: "BROKER_STAFF_2FA_POLICY_CHANGED" } });
    expect(logs).toHaveLength(1);
    expect(logs[0].actorAdminId).toBeNull();
    expect(logs[0].oldValue).toEqual({ requireAdmin2fa: false });
    expect(logs[0].newValue).toMatchObject({ requireAdmin2fa: true, source: "scripts/set-staff-2fa-policy.ts" });
    expect(await prisma.auditLog.count({ where: { brokerId: qore.id, action: "BROKER_STAFF_2FA_POLICY_CHANGED" } })).toBe(0);

    const again = await run(true, [`qore-${sfx}`]);
    expect(again.changes).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: "BROKER_STAFF_2FA_POLICY_CHANGED" } })).toBe(auditBefore + total - 1);
  });
  it("refuses an --optional name that is not a broker", async () => {
    if (!dbReachable) return;
    await expect(run(true, ["nosuchbroker"])).rejects.toBeInstanceOf(Refused);
  });
});
