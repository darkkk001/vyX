import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { allocateAccountNumber, provisionAccount } from "@/lib/account-provisioning";

// Account numbers are never issued twice (owner 2026-11-10: 50005728 went to three accounts in four days, each time after
// the previous holder was deleted, because the next number was MAX(existing) + 1).
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("account-number-counter.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Num ${s}`, subdomain: `num-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100, isDefault: true } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function open() {
  const n = ++seq;
  return provisionAccount({ brokerId, fullName: "Num Test", email: `num-${n}-${s}@t.local`, passwordHash: "x", accountMode: "DEMO", accountTypeId: null, currency: "USD", leverage: 100, groupId, initialBalance: new Prisma.Decimal(0) } as never);
}
const numberOf = (r: { accountNumber: string }) => r.accountNumber;

describe("account numbers", () => {
  it("delete the highest account, open a new one: the number does not repeat", async () => {
    if (!dbReachable) return;
    const first = numberOf(await open());
    const highest = await prisma.account.findFirstOrThrow({ where: { accountNumber: first } });
    await prisma.transaction.deleteMany({ where: { accountId: highest.id } });
    await prisma.auditLog.deleteMany({ where: { entityId: highest.id } });
    await prisma.account.delete({ where: { id: highest.id } });
    const next = numberOf(await open());
    expect(next).not.toBe(first);
    expect(BigInt(next)).toBeGreaterThan(BigInt(first));
  });
  it("twenty allocations at once: twenty different numbers", async () => {
    if (!dbReachable) return;
    const got = await Promise.all(Array.from({ length: 20 }, () => allocateAccountNumber()));
    expect(new Set(got).size).toBe(20);
  });
  it("an account numbered elsewhere above the counter moves the counter past it", async () => {
    if (!dbReachable) return;
    const above = String(BigInt(await allocateAccountNumber()) + BigInt(500));
    await prisma.account.create({ data: { brokerId, accountNumber: above, email: `num-x-${s}@t.local`, passwordHash: "x", fullName: "Num", accountMode: "DEMO", groupId } });
    expect(BigInt(await allocateAccountNumber())).toBe(BigInt(above) + BigInt(1));
  });
});
