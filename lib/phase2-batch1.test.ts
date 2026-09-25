import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type MirrorRule } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 1 (MASTER-PLAN.md): backoffice FX, dealer cancel of a resting order, group save side effects, account
// type enable/disable. Real fixtures on the local scratch DB with made-up currency codes (no real LivePrice touched).
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch1.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
const livePrices: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.accountType.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: livePrices } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function world(accountCurrency: string) {
  const b = await prisma.broker.create({ data: { name: `P2B1 ${randomUUID().slice(0, 8)}`, subdomain: `p2b1-${randomUUID().slice(0, 8)}` } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `P2-${randomUUID().slice(0, 6)}`, leverage: 100, isDefault: true } });
  const acc = await prisma.account.create({
    data: { groupId: g.id, brokerId: b.id, accountNumber: `2${Date.now().toString().slice(-7)}${Math.floor(Math.random() * 9)}`.slice(0, 8), email: `p2-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "P2", accountMode: "DEMO", balance: D(10000), currency: accountCurrency },
  });
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `p2a-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
  return { brokerId: b.id, groupId: g.id, accountId: acc.id };
}
async function symbolIn(brokerId: string, quote: string, bid: string, ask: string) {
  const name = `PX${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: quote, category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(name);
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D(bid), ask: D(ask), tickAt: new Date() } });
  livePrices.push(name);
  return s;
}
async function quote(symbol: string, bid: string, ask: string) {
  livePrices.push(symbol);
  await prisma.livePrice.upsert({ where: { symbol }, create: { symbol, bid: D(bid), ask: D(ask), tickAt: new Date() }, update: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}
async function openPosition(w: { brokerId: string; accountId: string }, symbolId: string, side: "BUY" | "SELL", volume: string, openPrice: string) {
  const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId, side, type: "MARKET", volume: D(volume), requestedPrice: D(openPrice), idempotencyKey: `p2:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId, originOrderId: o.id, side, volume: D(volume), openPrice: D(openPrice) } });
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const code = () => `Q${String.fromCharCode(65 + Math.floor(Math.random() * 26))}${String.fromCharCode(65 + Math.floor(Math.random() * 26))}`;

describe("1. backoffice FX: server P/L in the account's currency", () => {
  it("/api/manage/positions converts floatingPnl, sends fxRate + quotes, and marks an unpriced row", async () => {
    if (!dbReachable) return;
    const [ACC, QB, QZ] = [code(), code(), code()];
    const w = await world(ACC);
    const priced = await symbolIn(w.brokerId, QB, "100.00", "100.10"); // quote currency QB
    const unpriced = await symbolIn(w.brokerId, QZ, "50.00", "50.10"); // no QZ quote at all
    await quote(ACC + QB, "99.9", "100.1"); // mid 100 -> QB -> ACC = 0.01
    await openPosition(w, priced.id, "BUY", "1", "90.00"); // +10 x 100 = +1000 QB -> +10 ACC
    await openPosition(w, unpriced.id, "BUY", "1", "40.00");
    const { GET } = await import("@/app/api/manage/positions/route");
    const body = await (await (GET as unknown as () => Promise<Response>)()).json();
    const p = body.rows.find((r: { symbolName: string }) => r.symbolName === priced.name);
    expect(p).toMatchObject({ quoteCurrency: QB, accountCurrency: ACC, floatingPnl: "10.00" });
    expect(Number(p.fxRate)).toBeCloseTo(0.01, 12);
    const u = body.rows.find((r: { symbolName: string }) => r.symbolName === unpriced.name);
    expect(u).toMatchObject({ fxRate: null, floatingPnl: null });
    expect(body.fx.quotes.map((q: { symbol: string }) => q.symbol)).toContain(ACC + QB);
  });

  it("mirror kill switch: maxDailyLoss compares the target's floating P/L in ITS currency (was raw quote currency)", async () => {
    if (!dbReachable) return;
    const [ACC, QB] = [code(), code()];
    const w = await world(ACC);
    const s = await symbolIn(w.brokerId, QB, "90.00", "90.10");
    await quote(ACC + QB, "99.9", "100.1"); // QB -> ACC = 0.01
    await openPosition(w, s.id, "BUY", "1", "100.00"); // -10 x 100 = -1000 QB = -10 ACC
    const { checkKillSwitch } = await import("@/lib/mirror");
    const rule = { id: randomUUID(), targetAccountId: w.accountId, maxOpenLots: null, maxDailyLoss: D(50) } as unknown as MirrorRule;
    // converted: -10 ACC is within a 50 ACC limit (the old unconverted -1000 would have tripped it)
    expect((await checkKillSwitch(prisma, rule)).killed).toBe(false);
    const tight = { ...rule, maxDailyLoss: D(5) } as MirrorRule;
    expect((await checkKillSwitch(prisma, tight)).killed).toBe(true);
  });
});

describe("3. a dealer cancels a client's resting order", () => {
  it("POST /api/manage/orders/{id}/cancel: reason required, status-guarded, audited, trader notified", async () => {
    if (!dbReachable) return;
    const w = await world("USD");
    const s = await symbolIn(w.brokerId, "USD", "100.00", "100.10");
    const resting = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: s.id, side: "BUY", type: "LIMIT", volume: D(1), requestedPrice: D(95), idempotencyKey: `p2:${randomUUID()}`, status: "PENDING" } });
    const { POST } = await import("@/app/api/manage/orders/[id]/cancel/route");
    const call = (body: unknown) => POST(req(`/api/manage/orders/${resting.id}/cancel`, "POST", body), { params: Promise.resolve({ id: resting.id }) });
    expect((await call({ reason: "" })).status).toBe(400);
    const ok = await call({ reason: "client asked by phone" });
    expect(ok.status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: resting.id } })).status).toBe("CANCELLED");
    const audit = await prisma.auditLog.findFirst({ where: { entityId: resting.id, action: "DEALER_CANCELLED_PENDING_ORDER" } });
    expect(audit?.newValue).toMatchObject({ cancelledBy: "DEALER", reason: "client asked by phone" });
    expect(publishTradingEvent).toHaveBeenCalledWith("OrderCancelled", expect.objectContaining({ order_id: resting.id, account_id: w.accountId }));
    expect((await call({ reason: "again" })).status).toBe(409); // no longer pending
  });
});

describe("5. group save side effects", () => {
  const groupBody = (extra: Record<string, unknown>) => ({ name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", ...extra });
  it("a save without `tier` keeps the stored tier; the only default can't be unticked; client-selectable is settable", async () => {
    if (!dbReachable) return;
    const w = await world("USD");
    await prisma.group.update({ where: { id: w.groupId }, data: { tier: "PRO" } });
    const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
    const patch = (body: unknown) => PATCH(req(`/api/manage/groups/${w.groupId}`, "PATCH", body), { params: Promise.resolve({ id: w.groupId }) });
    // the only default: unticking it is refused
    const refused = await patch(groupBody({ isDefault: false }));
    expect(refused.status).toBe(409);
    const ok = await patch(groupBody({ isDefault: true, isClientSelectable: true }));
    expect(ok.status).toBe(200);
    const g = await prisma.group.findUniqueOrThrow({ where: { id: w.groupId } });
    expect(g.tier).toBe("PRO"); // was reset to STANDARD on every save
    expect(g.isClientSelectable).toBe(true);
    const { POST } = await import("@/app/api/manage/groups/route");
    const created = await (await POST(req("/api/manage/groups", "POST", groupBody({ isClientSelectable: true })))).json();
    expect((await prisma.group.findUniqueOrThrow({ where: { id: created.id ?? created.group?.id } })).isClientSelectable).toBe(true);
  });
});

describe("7. account type enable / disable", () => {
  it("PATCH { enabled } alone toggles it (used to fail: name is required)", async () => {
    if (!dbReachable) return;
    const w = await world("USD");
    const t = await prisma.accountType.create({ data: { brokerId: w.brokerId, name: `T-${randomUUID().slice(0, 6)}`, enabled: true, isDefault: true } });
    const { PATCH } = await import("@/app/api/manage/account-types/[id]/route");
    const res = await PATCH(req(`/api/manage/account-types/${t.id}`, "PATCH", { enabled: false }), { params: Promise.resolve({ id: t.id }) });
    expect(res.status).toBe(200);
    const after = await prisma.accountType.findUniqueOrThrow({ where: { id: t.id } });
    expect(after).toMatchObject({ enabled: false, name: t.name, isDefault: true });
  });
});
