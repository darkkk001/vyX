import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Live reference data (owner 2026-10-29, web-reference-events-brief.md): every reference write announces ConfigChanged after it commits, exactly once,
// never on a failed write; a Super Admin write announces it for the TARGET broker. (Trader filtering and burst coalescing: the gateway's own tests.)
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("native-release-reference-events.test.ts: DB unreachable, skipping"); }
});
beforeEach(async () => { const { publishTradingEvent } = await import("@/lib/nats"); vi.mocked(publishTradingEvent).mockClear(); });
const brokers: string[] = [];
const admins: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.liquidityProvider.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.adminUser.deleteMany({ where: { OR: [{ brokerId: { in: brokers } }, { id: { in: admins } }] } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function events() {
  const { publishTradingEvent } = await import("@/lib/nats");
  return vi.mocked(publishTradingEvent).mock.calls.filter((c) => c[0] === "ConfigChanged").map((c) => c[1] as { broker_id: string; scope: string });
}
async function as(adminId: string, brokerId: string | null, role: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, brokerId, role } as never);
}
const json = (body: unknown, method = "POST") => new NextRequest("https://test.local/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("LP writes announce lps", () => {
  it("a created provider announces once for the broker; a refused write announces nothing", async () => {
    if (!dbReachable) return;
    const s = randomUUID().slice(0, 8);
    const broker = await prisma.broker.create({ data: { name: `Ref ${s}`, subdomain: `ref-${s}` } });
    brokers.push(broker.id);
    const ba = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `ref-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    await as(ba.id, broker.id, "BROKER_ADMIN");
    const { POST } = await import("@/app/api/manage/liquidity-providers/route");
    expect((await POST(json({ name: "" }))).status).toBe(400);
    expect(await events()).toEqual([]);
    expect((await POST(json({ name: `LP ${s}`, protocol: "FIX" }))).status).toBeLessThan(300);
    expect(await events()).toEqual([{ broker_id: broker.id, scope: "lps" }]);
  });
});

describe("Super Admin writes announce for the target broker", () => {
  it("disabling a broker's staff member announces permissions for THAT broker", async () => {
    if (!dbReachable) return;
    const s = randomUUID().slice(0, 8);
    const broker = await prisma.broker.create({ data: { name: `Tgt ${s}`, subdomain: `tgt-${s}` } });
    brokers.push(broker.id);
    const staff = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `st-${s}@test.local`, passwordHash: "x", role: "MANAGER" } });
    const sa = await prisma.adminUser.create({ data: { email: `sa-${s}@test.local`, passwordHash: "x", role: "SUPER_ADMIN" } });
    admins.push(sa.id);
    await as(sa.id, null, "SUPER_ADMIN");
    const { PATCH } = await import("@/app/api/admin/admins/[id]/route");
    const r = await PATCH(json({ status: "DISABLED" }, "PATCH"), { params: Promise.resolve({ id: staff.id }) });
    expect(r.status).toBe(200);
    expect(await events()).toEqual([{ broker_id: broker.id, scope: "permissions" }]);
  });
});
