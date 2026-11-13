import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Multi-engine control plane (owner 2026-11-13), against a real (scratch) Postgres: the registry and assignment APIs, the engine_broker_scope
// view an engine will read by its ENGINE_ID, the append-only history, and the web's owner rule (inert until an engine writes its own heartbeat).
vi.mock("@/lib/auth", async (orig) => ({ ...(await orig<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

let dbReachable = false;
const tag = randomUUID().replace(/-/g, "").slice(0, 8);
const E1 = `t1-${tag}`, E2 = `t2-${tag}`;
const created = { brokers: [] as string[], admins: [] as string[] };
let superId = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1 FROM "engine_broker_scope" LIMIT 1`; dbReachable = true; } catch { console.warn("engines.routes.test.ts: DB (with the engine registry migration) unreachable, skipping"); }
  if (!dbReachable) return;
  const sa = await prisma.adminUser.create({ data: { email: `sa-${tag}@test.local`, passwordHash: "x", role: "SUPER_ADMIN", twoFactorEnabled: true } });
  superId = sa.id; created.admins.push(sa.id);
});

async function as(role: "SUPER_ADMIN" | "MANAGER") {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: superId, role, brokerId: role === "SUPER_ADMIN" ? null : "x" } as never);
}
const req = (method: string, body?: unknown) => new NextRequest("https://admin.test/x", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function broker(rust: boolean) {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Eng ${s}`, subdomain: `eng-${s}`, ...(rust ? { riskAuthority: "RUST", riskAuthorityDemoOnly: false } : {}) } });
  created.brokers.push(b.id);
  return b;
}

afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: created.brokers } };
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where: { OR: [where, { entityId: { in: [E1, E2] } }] } }).catch(() => {});
  await prisma.engineAssignmentLog.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: created.brokers } } }).catch(() => {});
  await prisma.engine.deleteMany({ where: { id: { in: [E1, E2] } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { id: { in: created.admins } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("engine registry (live DB)", () => {
  it("only a Super Admin reads or writes it", async () => {
    if (!dbReachable) return;
    await as("MANAGER");
    const { GET, POST } = await import("./route");
    expect((await GET()).status).toBe(403);
    expect((await POST(req("POST", { id: E1, name: "x", region: "y", gatewayUrl: "https://gw.test" }))).status).toBe(403);
  });

  it("register, assign, move, unassign: the view serves exactly the ACTIVE / DRAINING engine's brokers; every change is in the history", async () => {
    if (!dbReachable) return;
    await as("SUPER_ADMIN");
    const { POST, GET } = await import("./route");
    expect((await POST(req("POST", { id: E1, name: "Test 1", region: "Test", gatewayUrl: "https://gw1.test", status: "ACTIVE" }))).status).toBe(201);
    expect((await POST(req("POST", { id: E2, name: "Test 2", region: "Test", gatewayUrl: "https://gw2.test" }))).status).toBe(201);   // PLANNED
    expect((await POST(req("POST", { id: E1, name: "dup", region: "x", gatewayUrl: "https://x.test" }))).status).toBe(409);
    const b = await broker(true);
    const { PUT, GET: HISTORY } = await import("../brokers/[id]/engine/route");
    expect((await PUT(req("PUT", { engineId: E1, reason: "" }), ctx(b.id))).status).toBe(400);   // a reason is required
    expect((await PUT(req("PUT", { engineId: E1, reason: "first engine" }), ctx(b.id))).status).toBe(200);
    const { servedBrokerIds } = await import("@/lib/engine-registry");
    expect(await servedBrokerIds(prisma, E1)).toContain(b.id);
    // move to a PLANNED engine: assigned there, but it serves nothing until ACTIVE
    expect((await PUT(req("PUT", { engineId: E2, reason: "move to the new engine" }), ctx(b.id))).status).toBe(200);
    expect(await servedBrokerIds(prisma, E1)).not.toContain(b.id);
    expect(await servedBrokerIds(prisma, E2)).not.toContain(b.id);
    const { PATCH, GET: DETAIL } = await import("./[id]/route");
    expect((await PATCH(req("PATCH", { status: "ACTIVE" }), ctx(E2))).status).toBe(200);
    expect(await servedBrokerIds(prisma, E2)).toContain(b.id);
    // RETIRED is refused while brokers remain; a retired engine takes none
    expect((await PATCH(req("PATCH", { status: "RETIRED" }), ctx(E2))).status).toBe(409);
    expect((await PUT(req("PUT", { engineId: null, reason: "unassign for the test" }), ctx(b.id))).status).toBe(200);
    expect((await PATCH(req("PATCH", { status: "RETIRED" }), ctx(E2))).status).toBe(200);
    expect((await PUT(req("PUT", { engineId: E2, reason: "onto a retired engine" }), ctx(b.id))).status).toBe(409);
    // history: append-only, newest first, three changes with their reasons
    const h = await (await HISTORY(req("GET"), ctx(b.id))).json();
    expect(h.history.map((x: { from: string | null; to: string | null }) => `${x.from ?? "-"}>${x.to ?? "-"}`)).toEqual([`${E2}>-`, `${E1}>${E2}`, `->${E1}`]);
    expect(await prisma.auditLog.count({ where: { brokerId: b.id, action: "BROKER_ENGINE_ASSIGNED" } })).toBe(3);
    // the list and the roster
    const list = await (await GET()).json();
    expect(list.engines.find((e: { id: string }) => e.id === E1)).toMatchObject({ status: "ACTIVE", health: "never", brokerCount: 0 });
    const d = await (await DETAIL(req("GET"), ctx(E1))).json();
    expect(d.moves.length).toBe(2);
  });

  it("the owner rule is today's until the engine writes its own heartbeat; then a stale or retired engine hands the account to the web", async () => {
    if (!dbReachable) return;
    await as("SUPER_ADMIN");
    const b = await broker(true);
    const group = await prisma.group.create({ data: { brokerId: b.id, name: `EG-${tag}`, dealingMode: "AUTO" } });
    const acct = await prisma.account.create({ data: { brokerId: b.id, groupId: group.id, accountNumber: `9${tag.slice(0, 7)}`, email: `eng-${tag}@test.local`, passwordHash: "x", fullName: "Engine Owner Test", accountMode: "LIVE" } });
    await prisma.riskEngineHeartbeat.upsert({ where: { name: "risk" }, create: { name: "risk", beatAt: new Date(), staleAfterSecs: 30 }, update: { beatAt: new Date(), staleAfterSecs: 30 } });
    const { loadRiskOwners } = await import("@/lib/risk-owner");
    const owner = async () => (await loadRiskOwners(prisma, [acct.id])).get(acct.id);
    const before = await owner();   // no engine assigned: the legacy rule
    expect(before).toBe("RUST");
    const { PATCH } = await import("./[id]/route");
    await prisma.engine.update({ where: { id: E1 }, data: { status: "ACTIVE" } });
    const { PUT } = await import("../brokers/[id]/engine/route");
    await PUT(req("PUT", { engineId: E1, reason: "owner rule test" }), ctx(b.id));
    expect(await owner()).toBe(before);   // assigned, but the engine has not written its own heartbeat: unchanged
    await prisma.engine.update({ where: { id: E1 }, data: { lastBeatAt: new Date() } });
    expect(await owner()).toBe("RUST");   // its own fresh heartbeat
    await prisma.engine.update({ where: { id: E1 }, data: { lastBeatAt: new Date(Date.now() - 120_000) } });
    expect(await owner()).toBe("WEB");    // stale: the web reclaims, whatever the legacy beat says
    await prisma.engine.update({ where: { id: E1 }, data: { lastBeatAt: new Date() } });
    await PATCH(req("PATCH", { status: "DRAINING" }), ctx(E1));
    expect(await owner()).toBe("RUST");
    await prisma.engine.update({ where: { id: E1 }, data: { status: "PLANNED" } });
    expect(await owner()).toBe("WEB");    // not serving
  });
});
