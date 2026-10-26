import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Owner 2026-10-26: the hedge account panel's "Close all hedges" / "Close hedges for symbol". Real database (skipped when
// none is reachable): two booked legs of one symbol and one of another; closing by symbol closes exactly those two, one
// audit row each, and releases the client positions they hedged.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
let brokerId = "";
const symbols: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable || !brokerId) return;
  const where = { brokerId };
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  for (const m of [prisma.deal, prisma.auditLog, prisma.notification, prisma.transaction] as unknown as { deleteMany: (a: object) => Promise<unknown> }[]) await m.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.broker.delete({ where: { id: brokerId } }).catch(() => {});
}, 30000);

async function post(body: object) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: null, role: "BROKER_ADMIN", brokerId } as never);
  const { POST } = await import("./route");
  const { NextRequest } = await import("next/server");
  const r = await POST(new NextRequest("https://t.local/api/manage/coverage/close-legs", { method: "POST", body: JSON.stringify(body) }));
  return { status: r.status, json: await r.json() };
}

describe("POST /api/manage/coverage/close-legs", () => {
  it("closes the legs of one symbol (one audit row each, clients released), then all the rest", async () => {
    if (!dbReachable) return;
    const s = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
    brokerId = (await prisma.broker.create({ data: { name: `CL ${s}`, subdomain: `cl-${s.toLowerCase()}`, dealingModeAt: null } })).id;
    const mkSym = async (name: string) => {
      symbols.push(name);
      const sym = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX" } });
      await prisma.brokerSymbol.create({ data: { brokerId, symbolId: sym.id, tradingMode: "BOTH" } });
      await prisma.livePrice.create({ data: { symbol: name, bid: D("1.10000"), ask: D("1.10020") } });
      return sym;
    };
    const a = await mkSym(`CA${s}`), b = await mkSym(`CB${s}`);
    const g = await prisma.group.create({ data: { brokerId, name: `C-${s}`, dealingMode: "AUTO", category: "DEALING", groupType: "DEALING" } });
    const cg = await prisma.group.create({ data: { brokerId, name: `Cov-${s}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
    const client = await prisma.account.create({ data: { brokerId, groupId: g.id, accountNumber: `71${s.slice(0, 6)}`, email: `cl-c-${s}@t.local`, passwordHash: "x", fullName: "CL client", accountMode: "LIVE", balance: D(10000) } });
    const cov = await prisma.account.create({ data: { brokerId, groupId: cg.id, accountNumber: `61${s.slice(0, 6)}`, email: `cl-h-${s}@t.local`, passwordHash: "x", fullName: "CL hedge", accountMode: "LIVE", balance: D(10000) } });
    await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: cov.id } });
    const open = async (accountId: string, symbolId: string, volume: string) => {
      const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(volume), status: "FILLED", filledPrice: D("1.10020"), filledAt: new Date(), idempotencyKey: `cl:${randomUUID()}` } });
      return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(volume), openPrice: D("1.10020") } });
    };
    const pairs = [];
    for (const [sym, lots] of [[a, "1.00"], [a, "0.50"], [b, "2.00"]] as const) {
      const c = await open(client.id, sym.id, lots);
      const leg = await open(cov.id, sym.id, lots);
      await prisma.position.update({ where: { id: c.id }, data: { covered: true, coveredAt: new Date(), coveragePositionId: leg.id } });
      pairs.push({ client: c, leg });
    }

    const one = await post({ symbol: a.name });
    expect(one.status).toBe(200);
    expect(one.json).toMatchObject({ coverageAccountNumber: cov.accountNumber, symbol: a.name, requested: 2, successful: 2, failed: 0 });
    expect(one.json.legs.map((l: { ticket: number; lots: string; closed: boolean; closePrice: string; realizedPnl: string; error: null }) => [l.ticket, l.lots, l.closed, l.closePrice, l.error]))
      .toEqual([[pairs[0].leg.ticket, "1.00", true, "1.1", null], [pairs[1].leg.ticket, "0.50", true, "1.1", null]]);
    expect(await prisma.auditLog.count({ where: { brokerId, action: "COVERAGE_LEG_CLOSED_BY_STAFF" } })).toBe(2);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pairs[0].client.id } })).covered).toBe(false); // client released
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pairs[2].leg.id } })).status).toBe("OPEN"); // other symbol untouched

    const rest = await post({});
    expect(rest.json).toMatchObject({ symbol: null, requested: 1, successful: 1, failed: 0 });
    expect((await post({})).json).toMatchObject({ requested: 0, legs: [] });
  });
});
