import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
import { getAdminSession } from "@/lib/auth";
import { loadRiskOwners } from "@/lib/risk-owner";

// Live cutover (owner 2026-11-11), DORMANT: the per-account allowlist entry route, and the database read path proven unchanged while the
// broker's flag is off (an entry set ON still changes nothing).
let ok = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT "engineLiveEnabled" FROM "Account" LIMIT 1`; ok = true; } catch { console.warn("engine-live route test: DB unreachable or migration missing, skipped"); } });
afterAll(async () => { await prisma.$disconnect(); }, 60000);

async function fx(opts: { flag?: boolean; authority?: "RUST" | "WEB"; demoOnly?: boolean } = {}) {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `EL ${s}`, subdomain: `el-${s}`, riskAuthority: opts.authority ?? "RUST", riskAuthorityDemoOnly: opts.demoOnly ?? true, engineLiveAllowlistOn: opts.flag ?? false } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `el-a-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const mgr = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `el-m-${s}@test.local`, passwordHash: "x", role: "MANAGER" } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `ELG-${s}`, leverage: 100, marginCallLevel: new Prisma.Decimal(100), stopOutLevel: new Prisma.Decimal(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  const mk = (mode: "LIVE" | "DEMO", n: string) => prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${s.slice(0, 6)}`, email: `el-${n}-${s}@test.local`, passwordHash: "x", fullName: "EL", accountMode: mode, leverage: 100, balance: new Prisma.Decimal(1000) } });
  return { broker, admin, mgr, live: await mk("LIVE", "7"), demo: await mk("DEMO", "8") };
}
async function call(method: "GET" | "PATCH", id: string, body?: unknown) {
  const r = await import("./route");
  const req = new NextRequest(`https://t.local/api/manage/accounts/${id}/engine-live`, { method, headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const res = await (method === "GET" ? r.GET : r.PATCH)(req, { params: Promise.resolve({ id }) });
  return { status: res.status, json: await res.json() };
}
const as = (adminId: string, brokerId: string, role: string) => vi.mocked(getAdminSession).mockResolvedValue({ adminId, brokerId, role } as never);

describe("engine live allowlist entry (dormant)", () => {
  it("a BROKER_ADMIN sets a LIVE account's entry with a reason, audited; DEMO refused; MANAGER forbidden; other broker not found", async () => {
    if (!ok) return;
    const f = await fx(); const other = await fx();
    as(f.mgr.id, f.broker.id, "MANAGER");
    expect((await call("PATCH", f.live.id, { enabled: true, reason: "pilot" })).status).toBe(403);
    as(f.admin.id, f.broker.id, "BROKER_ADMIN");
    expect((await call("PATCH", f.live.id, { enabled: true })).status).toBe(400);
    expect((await call("PATCH", f.demo.id, { enabled: true, reason: "pilot" })).status).toBe(409);
    expect((await call("PATCH", other.live.id, { enabled: true, reason: "pilot" })).status).toBe(404);
    const r = await call("PATCH", f.live.id, { enabled: true, reason: "pilot" });
    expect(r.status).toBe(200); expect(r.json).toMatchObject({ engineLiveEnabled: true, allowlistOn: false });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.live.id } })).engineLiveEnabled).toBe(true);
    expect(await prisma.auditLog.count({ where: { entityId: f.live.id, action: "ENGINE_LIVE_ALLOWLIST_SET" } })).toBe(1);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: f.broker.id } })).engineLiveAllowlistOn).toBe(false);   // the route never turns the flag on
  });

  it("flag OFF: the database read path gives today's owner even for an account whose entry is ON", async () => {
    if (!ok) return;
    const f = await fx({ flag: false, authority: "RUST", demoOnly: true });
    await prisma.account.update({ where: { id: f.live.id }, data: { engineLiveEnabled: true } });
    await prisma.riskEngineHeartbeat.upsert({ where: { name: "risk" }, create: { name: "risk", beatAt: new Date(), staleAfterSecs: 600 }, update: { beatAt: new Date(), staleAfterSecs: 600 } });
    const owners = await loadRiskOwners(prisma, [f.live.id, f.demo.id]);
    expect(owners.get(f.live.id)).toBe("WEB");    // demo-only broker, LIVE account: WEB, exactly as before
    expect(owners.get(f.demo.id)).toBe("RUST");   // DEMO: RUST, exactly as before
  });

  it("flag ON + entry ON: that LIVE account (only) is engine-owned", async () => {
    if (!ok) return;
    const f = await fx({ flag: true, authority: "RUST", demoOnly: true });
    const second = await prisma.account.create({ data: { groupId: (await prisma.group.findFirstOrThrow({ where: { brokerId: f.broker.id } })).id, brokerId: f.broker.id, accountNumber: `9${randomUUID().slice(0, 6)}`, email: `el-x-${randomUUID()}@test.local`, passwordHash: "x", fullName: "EL", accountMode: "LIVE", leverage: 100, balance: new Prisma.Decimal(1000) } });
    await prisma.account.update({ where: { id: f.live.id }, data: { engineLiveEnabled: true } });
    await prisma.riskEngineHeartbeat.upsert({ where: { name: "risk" }, create: { name: "risk", beatAt: new Date(), staleAfterSecs: 600 }, update: { beatAt: new Date(), staleAfterSecs: 600 } });
    const owners = await loadRiskOwners(prisma, [f.live.id, second.id]);
    expect(owners.get(f.live.id)).toBe("RUST");
    expect(owners.get(second.id)).toBe("WEB");
  });
});
