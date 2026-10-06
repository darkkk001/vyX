import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, RoutingCategory } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Position.groupCategoryAtOpen (owner 2026-10-06, Book P/L rule): every open path records the account's group category
// at the moment the position opened. A database trigger stamps it (migration 20261006090000), so each test here opens
// a position through the REAL path and reads the stamp back: client fill, smart-dealer auto-accept, pending trigger,
// dealer accept, requote accept, desk flush, auto-hedge leg, staff open, BOOK NOW hedge, coverage-account order,
// copy-rule (mirror) open, reverse (close + reopen). Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("position-group-stamp.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.mirrorLink.deleteMany({ where: { rule: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.mirrorRule.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(category: RoutingCategory, groupExtra?: Partial<Prisma.GroupUncheckedCreateInput>): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Stamp ${sfx}`, subdomain: `stamp-${sfx}` } });
  brokers.push(b.id);
  const a = await prisma.adminUser.create({ data: { brokerId: b.id, email: `st-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `ST${sfx.toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true, tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ST-${sfx}`, leverage: 100, category, dealingMode: "AUTO", isClientSelectable: true, ...groupExtra } });
  return { brokerId: b.id, adminId: a.id, groupId: g.id, symbolId: s.id, symbolName: name };
}
async function account(fx: Fx, groupId = fx.groupId) {
  const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "3")}`;
  return prisma.account.create({
    data: { groupId, brokerId: fx.brokerId, accountNumber: n, email: `st-${n}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", fullName: `ST ${n}`, accountMode: "LIVE", balance: D(1_000_000), leverage: 100 },
  });
}
const asAdmin = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
const asTrader = (fx: Fx, accountId: string) => vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId: fx.brokerId } as never);
async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function queued(fx: Fx, accountId: string, status: "PENDING" | "REQUOTED" = "PENDING") {
  return prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D("0.10"), requestedPrice: D("100.10"), requotedPrice: status === "REQUOTED" ? D("100.20") : null, idempotencyKey: `st:${randomUUID()}`, status },
  });
}
const stampOf = async (where: Prisma.PositionWhereInput) => (await prisma.position.findFirstOrThrow({ where, orderBy: { openedAt: "desc" } })).groupCategoryAtOpen;
const market = (fx: Fx) => ({ symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.10", price: "100.10", idempotencyKey: `st:${randomUUID()}` });

describe("the database stamps the group category on insert", () => {
  it("a plain insert gets the account's current group category; an explicit value is kept", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING");
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    const base = { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY" as const, volume: D(1), openPrice: D(100) };
    expect((await prisma.position.create({ data: base })).groupCategoryAtOpen).toBe("DEALING");
    const o2 = await queued(fx, acc.id);
    expect((await prisma.position.create({ data: { ...base, originOrderId: o2.id, groupCategoryAtOpen: "A_BOOK" } })).groupCategoryAtOpen).toBe("A_BOOK");
  });
  it("moving the account to another group later does not change the stamp", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    const p = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100) } });
    const rev = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `rev-${randomUUID().slice(0, 6)}`, category: "REVERSAL" } });
    await prisma.account.update({ where: { id: acc.id }, data: { groupId: rev.id } });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).groupCategoryAtOpen).toBe("B_BOOK");
  });
});

describe("every open path records groupCategoryAtOpen (DB, real paths)", () => {
  it("client market fill (trade/orders, auto group)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", market(fx));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await stampOf({ accountId: acc.id })).toBe("B_BOOK");
  });

  it("smart-dealer auto-accept (trade/orders, dealing group)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING", { dealingMode: "MANUAL" });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { smartDealerAcceptPct: D(100) } });
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", market(fx));
    expect([200, 201], JSON.stringify(r.json)).toContain(r.status);
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(1);
    expect(await stampOf({ accountId: acc.id })).toBe("DEALING");
  });

  it("pending order trigger (lib/pending-trigger.ts)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    const placed = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "LIMIT", volume: "0.10", price: "95.00", idempotencyKey: `st:${randomUUID()}` });
    expect(placed.status, JSON.stringify(placed.json)).toBe(201);
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("94.90"), ask: D("95.00"), tickAt: new Date() } });
    const order = await prisma.order.findFirstOrThrow({ where: { accountId: acc.id } });
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    const out = await triggerPendingOrder(order.id, "95.00", "server");
    expect(out.kind, JSON.stringify(out)).toBe("filled");
    expect(await stampOf({ accountId: acc.id })).toBe("B_BOOK");
  });

  it("dealer accept (dealing-queue/[id])", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING");
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const r = await call(PATCH, `/api/manage/dealing-queue/${o.id}`, "PATCH", { action: "ACCEPT", fillMode: "MARKET" }, { id: o.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await stampOf({ accountId: acc.id })).toBe("DEALING");
  });

  it("client accepts a requote (requote-response)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING");
    const acc = await account(fx);
    const o = await queued(fx, acc.id, "REQUOTED");
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/[id]/requote-response/route");
    const r = await call(POST, `/api/trade/orders/${o.id}/requote-response`, "POST", { accept: true }, { id: o.id });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect(await stampOf({ accountId: acc.id })).toBe("DEALING");
  });

  it("desk-off flush fills the queue, and its auto-hedge leg on the coverage account is stamped COVERAGE", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING", { dealingMode: "INHERIT", groupType: "DEALING" });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { autoHedgeAt: new Date(), dealingDeskAutoFillAt: null } });
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-desk-toggle/route");
    const r = await call(PATCH, "/api/manage/dealing-desk-toggle", "PATCH", { dealerOn: false });
    expect(r.status, JSON.stringify(r.json)).toBe(200);
    expect((r.json.flushed as { orderId: string; status: string }[]).find((x) => x.orderId === o.id)?.status).toBe("filled");
    expect(await stampOf({ accountId: acc.id })).toBe("DEALING");
    const { coverageAccountId } = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerId }, select: { coverageAccountId: true } });
    expect(await stampOf({ accountId: coverageAccountId! })).toBe("COVERAGE");
  });

  it("staff manual open (manage/positions POST)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const acc = await account(fx);
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    const r = await call(POST, "/api/manage/positions", "POST", { accountId: acc.id, symbolId: fx.symbolId, side: "BUY", volume: "0.10" });
    expect([200, 201], JSON.stringify(r.json)).toContain(r.status);
    expect(await stampOf({ accountId: acc.id })).toBe("B_BOOK");
  });

  it("BOOK NOW hedge leg (positions/[id]/book) and a coverage-account order (coverage/orders) are stamped COVERAGE", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    const p = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D("0.10"), openPrice: D(100), bookType: "B_BOOK" } });
    asAdmin(fx);
    const book = await import("@/app/api/manage/positions/[id]/book/route");
    const r1 = await call(book.POST, `/api/manage/positions/${p.id}/book`, "POST", {}, { id: p.id });
    expect([200, 201], JSON.stringify(r1.json)).toContain(r1.status);
    const { coverageAccountId } = await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerId }, select: { coverageAccountId: true } });
    expect(await prisma.position.count({ where: { accountId: coverageAccountId!, groupCategoryAtOpen: "COVERAGE" } })).toBe(1);
    const cov = await import("@/app/api/manage/coverage/orders/route");
    const r2 = await call(cov.POST, "/api/manage/coverage/orders", "POST", { symbol: fx.symbolName, side: "SELL", volume: "0.10" });
    expect([200, 201], JSON.stringify(r2.json)).toContain(r2.status);
    expect(await prisma.position.count({ where: { accountId: coverageAccountId!, groupCategoryAtOpen: "COVERAGE" } })).toBe(2);
  });

  it("copy-rule (mirror) open: the source keeps its B_BOOK stamp, the copy on a reverse-trading account is REVERSAL", async () => {
    if (!dbReachable) return;
    const fx = await fixture("B_BOOK");
    const src = await account(fx);
    const revGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `rev-${randomUUID().slice(0, 6)}`, category: "REVERSAL", dealingMode: "AUTO" } });
    const target = await account(fx, revGroup.id);
    await prisma.mirrorRule.create({ data: { brokerId: fx.brokerId, sourceType: "GROUP", sourceId: fx.groupId, targetAccountId: target.id, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: "SOURCE_PRICE", createdById: fx.adminId } });
    asTrader(fx, src.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", market(fx));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(await stampOf({ accountId: src.id })).toBe("B_BOOK");
    expect(await stampOf({ accountId: target.id })).toBe("REVERSAL");
  });

  it("reverse (close + reopen) stamps the reopened position with the group it opens in", async () => {
    if (!dbReachable) return;
    const fx = await fixture("DEALING");
    const acc = await account(fx);
    const o = await queued(fx, acc.id);
    const p = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: acc.id, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D("0.10"), openPrice: D(100), bookType: "B_BOOK" } });
    const bb = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `bb-${randomUUID().slice(0, 6)}`, category: "B_BOOK", dealingMode: "AUTO" } });
    await prisma.account.update({ where: { id: acc.id }, data: { groupId: bb.id } });
    const { executeReverseCloseReopen } = await import("@/lib/position-actions");
    await prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).groupCategoryAtOpen).toBe("DEALING");
    expect(await stampOf({ accountId: acc.id, status: "OPEN" })).toBe("B_BOOK");
  });
});
