// Phase 2 batch 5: LP notes edits and routing-rule create / delete are audited (they wrote no AuditLog row), each in the
// same transaction as the change. Real routes on the scratch DB.
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

const brokers: string[] = [];
async function fixture() {
  const s = randomUUID().slice(0, 8);
  const broker = await prisma.broker.create({ data: { name: `LP audit ${s}`, subdomain: `lpaud-${s}` } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `lp-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const lp = await prisma.liquidityProvider.create({ data: { brokerId: broker.id, name: `LP ${s}`, notes: "old notes" } });
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: broker.id } as never);
  return { brokerId: broker.id, adminId: admin.id, lpId: lp.id };
}
const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

afterAll(async () => {
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.lpRoutingRule.deleteMany({ where });
  await prisma.liquidityProvider.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

describe("LP / routing audit rows", () => {
  it("an LP notes edit writes LP_NOTES_CHANGED with old and new; an unchanged value writes nothing", async () => {
    const fx = await fixture();
    const { PATCH } = await import("@/app/api/manage/liquidity-providers/[id]/route");
    expect((await PATCH(req(`/api/manage/liquidity-providers/${fx.lpId}`, "PATCH", { notes: "new notes" }), { params: Promise.resolve({ id: fx.lpId }) })).status).toBe(200);
    const rows = await prisma.auditLog.findMany({ where: { brokerId: fx.brokerId, action: "LP_NOTES_CHANGED" } });
    expect(rows).toHaveLength(1);
    expect([rows[0].actorAdminId, rows[0].entityId, rows[0].oldValue, rows[0].newValue]).toEqual([fx.adminId, fx.lpId, { notes: "old notes" }, { notes: "new notes" }]);
    await PATCH(req(`/api/manage/liquidity-providers/${fx.lpId}`, "PATCH", { notes: "new notes" }), { params: Promise.resolve({ id: fx.lpId }) });
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "LP_NOTES_CHANGED" } })).toBe(1);
  });

  it("creating and deleting a routing rule each write one audit row", async () => {
    const fx = await fixture();
    const { POST } = await import("@/app/api/manage/lp-routing/route");
    const created = await POST(req("/api/manage/lp-routing", "POST", { liquidityProviderId: fx.lpId, priority: 2, notes: "backup" }));
    expect(created.status).toBe(201);
    const { id } = await created.json();
    const c = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "LP_ROUTING_RULE_CREATED" } });
    expect([c.entityId, (c.newValue as { priority: number }).priority]).toEqual([id, 2]);
    const { DELETE } = await import("@/app/api/manage/lp-routing/[id]/route");
    expect((await DELETE(req(`/api/manage/lp-routing/${id}`, "DELETE"), { params: Promise.resolve({ id }) })).status).toBe(200);
    const d = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "LP_ROUTING_RULE_DELETED" } });
    expect([d.entityId, (d.oldValue as { priority: number; notes: string }).notes]).toEqual([id, "backup"]);
    expect(await prisma.lpRoutingRule.count({ where: { id } })).toBe(0);
  });
});
