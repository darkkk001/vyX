import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Group edit (2026-09-25): leverage 1:1,000,000 saves (plain or with grouping commas) with a clear rule when it is
// wrong, and changing "Account mode" / routing is refused while accounts inside the group would break the new rule.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("groups/[id] route.test.ts: DB unreachable, skipping"); }
});

const createdBrokerIds: string[] = [];
async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Grp Edit ${s}`, subdomain: `grp-${s}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `grp-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `G-${s}`, leverage: 100, category: "B_BOOK", modeRestriction: "ANY" } });
  return { s, brokerId: broker.id, adminId: admin.id, groupId: group.id };
}

async function patchGroup(fx: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, brokerId: fx.brokerId, role: "BROKER_ADMIN" } as never);
  const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
  const full = { name: `G-${fx.s}`, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", modeRestriction: "ANY", ...body };
  const res = await PATCH(new NextRequest(`https://test.local/api/manage/groups/${fx.groupId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(full) }), { params: Promise.resolve({ id: fx.groupId }) });
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: createdBrokerIds } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("PATCH /api/manage/groups/[id]", () => {
  it("saves leverage 1:1,000,000, plain or grouped", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    expect((await patchGroup(fx, { leverage: 1000000 })).status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } })).leverage).toBe(1000000);
    expect((await patchGroup(fx, { leverage: "10,00,000" })).status).toBe(200);
    expect((await patchGroup(fx, { leverage: "2,000,000" })).status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } })).leverage).toBe(2000000);
  });

  it("refuses a bad leverage with the rule, not a 500", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    for (const bad of [0, 1.5, "abc", 5_000_000_000]) {
      const r = await patchGroup(fx, { leverage: bad });
      expect(r.status, String(bad)).toBe(400);
      expect(r.json.error).toContain("whole number from 1 to 1000000000");
    }
  });

  it("refuses a mode change that would strand the demo accounts already inside, and says how many", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await prisma.account.create({ data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: `9${fx.s.slice(0, 7)}`, email: `d-${fx.s}@test.local`, passwordHash: "x", fullName: "Demo", accountMode: "DEMO" } });
    const r = await patchGroup(fx, { leverage: 100, modeRestriction: "LIVE_ONLY" });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("1 demo account is in this group");
    expect((await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } })).modeRestriction).toBe("ANY");
    // routing to A-BOOK (live money only) is the same situation
    expect((await patchGroup(fx, { leverage: 100, category: "A_BOOK" })).status).toBe(409);
    // DEMO_ONLY is fine for a demo account
    expect((await patchGroup(fx, { leverage: 100, modeRestriction: "DEMO_ONLY" })).status).toBe(200);
  });
});
