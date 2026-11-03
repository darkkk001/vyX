import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// GET /api/manage/clients (owner 2026-11-03): the backoffice Registrations view lists the broker's portal sign-ups
// that have NO trading account; own broker only; SUPPORT may read; no session = 403.
vi.mock("@/lib/auth", () => ({ getAdminSession: vi.fn() }));

let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.account.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

async function as(role: string | null, brokerId?: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(role ? ({ adminId: "a", role, brokerId } as never) : null);
}

describe("GET /api/manage/clients", () => {
  it("lists only this broker's sign-ups without a trading account, newest first, with verified status", async () => {
    if (!dbReachable) return;
    const s = randomUUID().slice(0, 8);
    const broker = await prisma.broker.create({ data: { name: `RG ${s}`, subdomain: `rgl-${s}` } });
    const other = await prisma.broker.create({ data: { name: `RG2 ${s}`, subdomain: `rgl2-${s}` } });
    brokers.push(broker.id, other.id);
    const old = await prisma.client.create({ data: { brokerId: broker.id, email: `old-${s}@t.local`, passwordHash: "x", fullName: "Old", createdAt: new Date(Date.now() - 86_400_000) } });
    const fresh = await prisma.client.create({ data: { brokerId: broker.id, email: `new-${s}@t.local`, passwordHash: "x", fullName: "New", emailVerifiedAt: new Date() } });
    const withAccount = await prisma.client.create({ data: { brokerId: broker.id, email: `acc-${s}@t.local`, passwordHash: "x", fullName: "Acc" } });
    await prisma.client.create({ data: { brokerId: other.id, email: `oth-${s}@t.local`, passwordHash: "x", fullName: "Oth" } });
    const group = await prisma.group.create({ data: { brokerId: broker.id, name: `RG ${s}` } });
    await prisma.account.create({ data: { brokerId: broker.id, groupId: group.id, passwordHash: "x", fullName: "Acc", balance: 0, accountMode: "DEMO", accountNumber: `92${s.replace(/\D/g, "1").slice(0, 6)}`, email: withAccount.email, clientId: withAccount.id } });

    await as("SUPPORT", broker.id);
    const { GET } = await import("./route");
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.registrations.map((r: { id: string }) => r.id)).toEqual([fresh.id, old.id]);
    expect(body.registrations[0]).toMatchObject({ email: fresh.email, verified: true, status: "ACTIVE" });
    expect(body.registrations[1]).toMatchObject({ email: old.email, verified: false, verifiedAt: null });
  });

  it("refuses without a broker staff session", async () => {
    await as(null);
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(403);
    await as("SUPER_ADMIN");
    expect((await GET()).status).toBe(403);
  });
});
