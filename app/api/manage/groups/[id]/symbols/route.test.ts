import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Backoffice 1.0.72 round 2: the "Allowed symbols..." dialog saves through PUT /api/manage/groups/{id}/symbols.
// "All symbols" is restrictSymbols=false; otherwise the list replaces the group's allow-list, and only symbols
// THIS broker has enabled can be on it (another broker's symbols are silently dropped, another broker's group is a 404).
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("group symbols route.test.ts: DB unreachable, skipping");
  }
});

const brokerIds: string[] = [];
const symbolIds: string[] = [];

async function sym(name: string) {
  const row = await prisma.symbol.create({ data: { name, baseCurrency: "USD", quoteCurrency: "USD", digits: 2, contractSize: 1, category: "INDICES" } });
  symbolIds.push(row.id);
  return row.id;
}

async function broker(tag: string) {
  const s = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const b = await prisma.broker.create({ data: { name: `GS ${tag} ${s}`, subdomain: `gs-${tag}-${s.toLowerCase()}` } });
  brokerIds.push(b.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `gs-${tag}-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  return { brokerId: b.id, adminId: admin.id, s };
}

async function fixture() {
  const mine = await broker("a");
  const other = await broker("b");
  const [a, b, c, off] = [await sym(`GSA${mine.s}`), await sym(`GSB${mine.s}`), await sym(`GSC${mine.s}`), await sym(`GSD${mine.s}`)];
  const foreign = await sym(`GSF${other.s}`);
  for (const [symbolId, enabled] of [[a, true], [b, true], [c, true], [off, false]] as const) {
    await prisma.brokerSymbol.create({ data: { brokerId: mine.brokerId, symbolId, enabled } });
  }
  await prisma.brokerSymbol.create({ data: { brokerId: other.brokerId, symbolId: foreign, enabled: true } });
  const group = await prisma.group.create({ data: { brokerId: mine.brokerId, name: `G-${mine.s}`, category: "B_BOOK" } });
  const foreignGroup = await prisma.group.create({ data: { brokerId: other.brokerId, name: `F-${other.s}`, category: "B_BOOK" } });
  return { mine, other, ids: { a, b, c, off, foreign }, groupId: group.id, foreignGroupId: foreignGroup.id };
}

async function call(method: "GET" | "PUT", session: { adminId: string; brokerId: string } | null, groupId: string, body?: unknown) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(session ? { ...session, role: "BROKER_ADMIN" } : null);
  const mod = await import("./route");
  const url = `https://test.local/api/manage/groups/${groupId}/symbols`;
  const params = { params: Promise.resolve({ id: groupId }) };
  const res =
    method === "GET"
      ? await mod.GET(new NextRequest(url), params)
      : await mod.PUT(new NextRequest(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), params);
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.groupSymbol.deleteMany({ where: { group: { brokerId: { in: brokerIds } } } });
  await prisma.brokerSymbol.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.symbol.deleteMany({ where: { id: { in: symbolIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } });
  await prisma.$disconnect();
});

describe("PUT /api/manage/groups/{id}/symbols (Allowed symbols dialog)", () => {
  it("restrict on saves exactly the chosen list; GET lists only this broker's enabled symbols", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const s = { adminId: fx.mine.adminId, brokerId: fx.mine.brokerId };
    const put = await call("PUT", s, fx.groupId, { restrictSymbols: true, symbolIds: [fx.ids.a, fx.ids.b] });
    expect(put.status).toBe(200);
    expect(put.json).toMatchObject({ restrictSymbols: true });
    const got = await call("GET", s, fx.groupId);
    expect(got.json.restrictSymbols).toBe(true);
    expect([...got.json.allowedSymbolIds].sort()).toEqual([fx.ids.a, fx.ids.b].sort());
    const available = (got.json.availableSymbols as Array<{ id: string }>).map((x) => x.id).sort();
    expect(available).toEqual([fx.ids.a, fx.ids.b, fx.ids.c].sort()); // not the disabled one, not another broker's
  });

  it("a second save REPLACES the list; restrict off (All symbols) turns the switch off", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const s = { adminId: fx.mine.adminId, brokerId: fx.mine.brokerId };
    await call("PUT", s, fx.groupId, { restrictSymbols: true, symbolIds: [fx.ids.a, fx.ids.b] });
    const second = await call("PUT", s, fx.groupId, { restrictSymbols: true, symbolIds: [fx.ids.c] });
    expect(second.json.allowedSymbolIds).toEqual([fx.ids.c]);
    expect((await prisma.groupSymbol.findMany({ where: { groupId: fx.groupId } })).map((r) => r.symbolId)).toEqual([fx.ids.c]);
    const all = await call("PUT", s, fx.groupId, { restrictSymbols: false, symbolIds: [fx.ids.a, fx.ids.b, fx.ids.c] });
    expect(all.status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } })).restrictSymbols).toBe(false);
    expect((await call("GET", s, fx.groupId)).json.restrictSymbols).toBe(false);
  });

  it("another broker's symbols and a disabled symbol are dropped, not saved", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const s = { adminId: fx.mine.adminId, brokerId: fx.mine.brokerId };
    const put = await call("PUT", s, fx.groupId, { restrictSymbols: true, symbolIds: [fx.ids.a, fx.ids.foreign, fx.ids.off, "no-such-id"] });
    expect(put.status).toBe(200);
    expect(put.json.allowedSymbolIds).toEqual([fx.ids.a]);
    expect(await prisma.groupSymbol.count({ where: { groupId: fx.groupId, symbolId: fx.ids.foreign } })).toBe(0);
  });

  it("another broker's group is a 404 and is left untouched; a non-staff session is 403; a bad body is 400", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const s = { adminId: fx.mine.adminId, brokerId: fx.mine.brokerId };
    expect((await call("PUT", s, fx.foreignGroupId, { restrictSymbols: true, symbolIds: [fx.ids.a] })).status).toBe(404);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: fx.foreignGroupId } })).restrictSymbols).toBe(false);
    expect((await call("PUT", null, fx.groupId, { restrictSymbols: true, symbolIds: [] })).status).toBe(403);
    expect((await call("PUT", s, fx.groupId, { restrictSymbols: true })).status).toBe(400);
  });
});
