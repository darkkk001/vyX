import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type Deal } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Deal model step 1 (docs/POSITION-DEAL-MODEL.md section 3.3 step 2, tests of section 4, web row): every web open writes
// an IN deal and every web close an OUT deal (OUT_BY for a close-by), in the same transaction as its ledger row. One
// test (or more) per path, against the scratch database. Each fixture owns a private CRYPTO symbol (continuous session,
// contract size 1, quote USD) so prices are set per test and nothing depends on the weekday or on other tests.
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "ticket" FROM "Deal" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/deals.test.ts: DB unreachable or deal_model_a migration missing, skipping");
  }
});
const brokers: string[] = [];
afterAll(async () => {
  if (dbReachable && brokers.length > 0) {
    // the invariant of section 4, gate 1, over everything these tests wrote: one deal per TRADE_PNL row, same amount
    const rows = await prisma.transaction.findMany({ where: { brokerId: { in: brokers }, type: "TRADE_PNL" }, select: { id: true, amount: true } });
    const deals = await prisma.deal.findMany({ where: { transactionId: { in: rows.map((r) => r.id) } }, select: { transactionId: true, profit: true } });
    const byTx = new Map(deals.map((d) => [d.transactionId, d.profit.toString()]));
    expect(rows.filter((r) => byTx.get(r.id) !== r.amount.toString())).toEqual([]);
  }
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; accountId: string; accountNumber: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(opts?: { dealing?: boolean; balance?: number; commission?: string; group?: Partial<Prisma.GroupUncheckedCreateInput>; broker?: Partial<Prisma.BrokerUncheckedCreateInput> }): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Deals ${suffix}`, subdomain: `deals-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: null, ...opts?.broker } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `deals-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `DL${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({
    data: {
      brokerId: broker.id, name: `DLG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: opts?.dealing ? "DEALING" : "B_BOOK",
      dealingMode: "AUTO", isClientSelectable: true, ...opts?.group,
    },
  });
  if (opts?.commission) await prisma.groupSymbolConfig.create({ data: { groupId: group.id, symbolId: symbol.id, commissionPerLot: D(opts.commission) } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `3${suffix.slice(0, 7)}`, email: `deals-client-${suffix}@test.local`, passwordHash: "x", fullName: "Deals Client", accountMode: "LIVE", leverage: 100, balance: D(opts?.balance ?? 100000) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, accountNumber: account.accountNumber, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function setPrice(fx: Fx, bid: string, ask: string) {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

// a position as it exists before this change (no IN deal): the close-path tests only look at the OUT side
async function seed(fx: Fx, o: { side: "BUY" | "SELL"; volume: string; openPrice: string; swap?: string; sl?: string; tp?: string; accountId?: string }) {
  const accountId = o.accountId ?? fx.accountId;
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: o.side, type: "MARKET", volume: D(o.volume), requestedPrice: D(o.openPrice), idempotencyKey: `dl:${randomUUID()}`, status: "FILLED", filledPrice: D(o.openPrice), filledAt: new Date() },
  });
  return prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side: o.side, volume: D(o.volume), openPrice: D(o.openPrice),
      ...(o.swap ? { swap: D(o.swap) } : {}), slPrice: o.sl ? D(o.sl) : null, tpPrice: o.tp ? D(o.tp) : null,
    },
  });
}

const deals = (positionId: string) => prisma.deal.findMany({ where: { positionId }, orderBy: [{ executedAt: "asc" }, { ticket: "asc" }] });
const outs = async (positionId: string) => (await deals(positionId)).filter((d) => d.entry !== "IN");
const pos = (id: string) => prisma.position.findUniqueOrThrow({ where: { id } });
const pnlRows = (positionId: string) => prisma.transaction.findMany({ where: { type: "TRADE_PNL", referenceType: "Position", referenceId: positionId }, orderBy: { createdAt: "asc" } });
const brief = (d: Deal) => [d.entry, d.reason, d.side, d.volume.toString(), d.price.toString(), d.profit.toString(), d.swap.toString()];

const asAdmin = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
const asTrader = (fx: Fx, accountId = fx.accountId) => vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId: fx.brokerId } as never);
async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>, headers?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function clientClose(fx: Fx, positionId: string, body: Record<string, unknown>, headers?: Record<string, string>) {
  asTrader(fx);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  return call(POST, `/api/trade/positions/${positionId}/close`, "POST", body, { id: positionId }, headers);
}

// the TRADE_PNL row and its deal agree on everything they both record
async function expectDealMatchesLedger(d: Deal) {
  const row = await prisma.transaction.findUniqueOrThrow({ where: { id: d.transactionId! } });
  expect(row.type).toBe("TRADE_PNL");
  expect(row.referenceId).toBe(d.positionId);
  expect([d.profit.toString(), d.volume.toString(), d.price.toString(), d.swap.toString(), d.byPositionId, d.executedAt.toISOString()]).toEqual([
    row.amount.toString(), row.closeVolume?.toString(), row.closePrice?.toString(), row.closeSwap?.toString(), row.closeByPositionId, row.createdAt.toISOString(),
  ]);
}

// --- opens: IN deals ---------------------------------------------------------------------------------------------------

describe("open paths write one IN deal", () => {
  it("client market order: IN with the fill, the commission and its ledger row, the channel; initialVolume set", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ commission: "7" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.50", price: "100.10", idempotencyKey: `dl:${randomUUID()}` }, undefined, { "x-client-platform": "DESKTOP_NATIVE" });
    expect(r.status).toBe(201);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    const [d] = await deals(p.id);
    const commissionRow = await prisma.transaction.findFirstOrThrow({ where: { type: "COMMISSION", referenceId: p.id } });
    expect([d.entry, d.reason, d.side, d.source, d.volume.toString(), d.price.toString(), d.commission.toString(), d.profit.toString()]).toEqual(["IN", "CLIENT", "BUY", "DESKTOP_NATIVE", "0.5", p.openPrice.toString(), "-3.5", "0"]);
    expect([d.transactionId, d.orderId, d.accountId, d.symbolId, d.executedAt.toISOString()]).toEqual([commissionRow.id, p.originOrderId, fx.accountId, fx.symbolId, p.openedAt.toISOString()]);
    expect(d.ticket).toBeGreaterThan(BigInt(10000000));
    expect((await pos(p.id)).initialVolume?.toString()).toBe("0.5");
  });

  it("no commission: IN with commission 0 and no ledger link", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "SELL", type: "MARKET", volume: "0.20", price: "100.00", idempotencyKey: `dl:${randomUUID()}` })).status).toBe(201);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    const [d] = await deals(p.id);
    expect([d.entry, d.side, d.source, d.commission.toString(), d.transactionId]).toEqual(["IN", "SELL", "WEB", "0", null]);
  });

  it("pending order triggered: IN on the pending order", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ commission: "2" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "LIMIT", volume: "1.00", price: "95.00", idempotencyKey: `dl:${randomUUID()}` })).status).toBe(201);
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: fx.accountId } });
    await setPrice(fx, "94.90", "95.00");
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    expect((await triggerPendingOrder(o.id, "95.00", "server")).kind).toBe("filled");
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    const [d] = await deals(p.id);
    expect([d.entry, d.reason, d.orderId, d.volume.toString(), d.commission.toString()]).toEqual(["IN", "CLIENT", o.id, "1", "-2"]);
    expect(d.transactionId).not.toBeNull();
  });

  it("dealer accept, requote accept and desk-off flush: IN with reason DEALER (the accepting staff member on the accept)", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ dealing: true, group: { groupType: "DEALING", dealingMode: "INHERIT" } });
    const queued = (status: "PENDING" | "REQUOTED") =>
      prisma.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D("0.30"), requestedPrice: D("100.10"), requotedPrice: status === "REQUOTED" ? D("100.20") : null, idempotencyKey: `dl:${randomUUID()}`, status, source: "MOBILE" } });

    const accepted = await queued("PENDING");
    asAdmin(fx);
    const { PATCH: accept } = await import("@/app/api/manage/dealing-queue/[id]/route");
    expect((await call(accept, `/api/manage/dealing-queue/${accepted.id}`, "PATCH", { action: "ACCEPT", fillMode: "MARKET" }, { id: accepted.id })).status).toBe(200);

    const requoted = await queued("REQUOTED");
    asTrader(fx);
    const { POST: requote } = await import("@/app/api/trade/orders/[id]/requote-response/route");
    expect((await call(requote, `/api/trade/orders/${requoted.id}/requote-response`, "POST", { accept: true }, { id: requoted.id })).status).toBe(200);

    const flushed = await queued("PENDING");
    asAdmin(fx);
    const { PATCH: desk } = await import("@/app/api/manage/dealing-desk-toggle/route");
    expect((await call(desk, "/api/manage/dealing-desk-toggle", "PATCH", { dealerOn: false })).status).toBe(200);

    for (const [order, adminId] of [[accepted, fx.adminId], [requoted, null], [flushed, null]] as const) {
      const p = await prisma.position.findUniqueOrThrow({ where: { originOrderId: order.id } });
      const [d] = await deals(p.id);
      expect([d.entry, d.reason, d.orderId, d.source, d.adminId]).toEqual(["IN", "DEALER", order.id, "MOBILE", adminId]);
      expect((await pos(p.id)).initialVolume?.toString()).toBe("0.3");
    }
  });

  it("staff manual open: IN with reason ADMIN, the staff member, source ADMIN", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ commission: "4" });
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    const r = await call(POST, "/api/manage/positions", "POST", { accountId: fx.accountId, symbolId: fx.symbolId, side: "SELL", volume: "0.25" });
    expect(r.status).toBe(200);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    const [d] = await deals(p.id);
    expect([d.entry, d.reason, d.adminId, d.source, d.volume.toString(), d.commission.toString()]).toEqual(["IN", "ADMIN", fx.adminId, "ADMIN", "0.25", "-1"]);
  });

  it("auto-hedge leg on the coverage account: IN with reason COVERAGE", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ dealing: true, group: { groupType: "DEALING" }, broker: { dealingDeskAutoFillAt: new Date(), autoHedgeAt: new Date() } });
    const covGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `Cov-${randomUUID().slice(0, 8)}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
    const cov = await prisma.account.create({ data: { groupId: covGroup.id, brokerId: fx.brokerId, accountNumber: `4${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `cov-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Dealer Coverage", accountMode: "LIVE", balance: D(0) } });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    const client = await seed(fx, { side: "BUY", volume: "0.60", openPrice: "100.10" });
    const { onFillAutoHedge } = await import("@/lib/coverage");
    await onFillAutoHedge(prisma, { positionId: client.id, brokerId: fx.brokerId });
    const leg = await prisma.position.findFirstOrThrow({ where: { accountId: cov.id } });
    const [d] = await deals(leg.id);
    expect([d.entry, d.reason, d.side, d.volume.toString(), d.accountId]).toEqual(["IN", "COVERAGE", "BUY", "0.6", cov.id]);
  });

  it("mirror copy: IN with reason MIRROR on the target account", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const targetGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `T-${randomUUID().slice(0, 8)}`, dealingMode: "AUTO", leverage: 100 } });
    const target = await prisma.account.create({ data: { groupId: targetGroup.id, brokerId: fx.brokerId, accountNumber: `5${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `m-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Master", accountMode: "LIVE", leverage: 100, balance: D(100000) } });
    await prisma.mirrorRule.create({ data: { brokerId: fx.brokerId, sourceType: "GROUP", sourceId: fx.groupId, targetAccountId: target.id, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: "SOURCE_PRICE", createdById: fx.adminId } });
    const source = await seed(fx, { side: "BUY", volume: "0.40", openPrice: "100.10" });
    const { onFillPosition } = await import("@/lib/mirror");
    await onFillPosition(prisma, source, fx.symbolName);
    const copy = await prisma.position.findFirstOrThrow({ where: { accountId: target.id } });
    const [d] = await deals(copy.id);
    expect([d.entry, d.reason, d.side, d.volume.toString()]).toEqual(["IN", "MIRROR", "SELL", "0.4"]);
  });
});

describe("coverage-account opens by the dealer", () => {
  it("BOOK NOW, a market coverage order and a coverage pending order filled: IN with reason COVERAGE (staff member where a person acted)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    asAdmin(fx);
    const client = await seed(fx, { side: "BUY", volume: "0.70", openPrice: "100.10" });
    const { POST: book } = await import("@/app/api/manage/positions/[id]/book/route");
    expect((await call(book, `/api/manage/positions/${client.id}/book`, "POST", {}, { id: client.id })).status).toBe(200);
    const leg = await pos((await pos(client.id)).coveragePositionId!);
    const [d1] = await deals(leg.id);
    expect([d1.entry, d1.reason, d1.adminId, d1.volume.toString(), d1.side]).toEqual(["IN", "COVERAGE", fx.adminId, "0.7", "BUY"]);

    const { POST: order } = await import("@/app/api/manage/coverage/orders/route");
    const m = await call(order, "/api/manage/coverage/orders", "POST", { symbol: fx.symbolName, side: "SELL", volume: "0.20" });
    expect(m.status).toBe(200);
    const covAccountId = leg.accountId;
    const market = await prisma.position.findFirstOrThrow({ where: { accountId: covAccountId, side: "SELL" } });
    const [d2] = await deals(market.id);
    expect([d2.entry, d2.reason, d2.adminId, d2.volume.toString()]).toEqual(["IN", "COVERAGE", fx.adminId, "0.2"]);

    const pending = await call(order, "/api/manage/coverage/orders", "POST", { symbol: fx.symbolName, side: "BUY", volume: "0.30", type: "LIMIT", price: "95.00" });
    expect(pending.status).toBe(201);
    await setPrice(fx, "94.90", "95.00");
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    expect((await triggerPendingOrder(pending.json.orderId, "95.00", "server")).kind).toBe("filled");
    const filled = await prisma.position.findUniqueOrThrow({ where: { originOrderId: pending.json.orderId } });
    const [d3] = await deals(filled.id);
    expect([d3.entry, d3.reason, d3.orderId, d3.volume.toString()]).toEqual(["IN", "COVERAGE", pending.json.orderId, "0.3"]);
  });
});

// --- closes: OUT deals -------------------------------------------------------------------------------------------------

describe("client close", () => {
  it("full close: one OUT, opposite side, = the TRADE_PNL row, channel recorded", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "-2.50" });
    expect((await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" }, { "x-client-platform": "MOBILE" })).status).toBe(200);
    const [d] = await outs(p.id);
    expect(brief(d)).toEqual(["OUT", "CLIENT", "SELL", "1", "100", "10", "-2.5"]);
    expect([d.source, d.orderId, d.byPositionId]).toEqual(["MOBILE", null, null]);
    await expectDealMatchesLedger(d);
  });

  it("partial then full: two OUTs on the same position, lots add up to the opening volume", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "1.00", price: "100.10", idempotencyKey: `dl:${randomUUID()}` })).status).toBe(201);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    await setPrice(fx, "101.00", "101.10");
    expect((await clientClose(fx, p.id, { volume: "0.40", closePrice: "101.00", maxSlippagePips: "5" })).status).toBe(200);
    expect((await pos(p.id)).status).toBe("OPEN");
    await setPrice(fx, "102.00", "102.10");
    expect((await clientClose(fx, p.id, { closePrice: "102.00", maxSlippagePips: "5" })).status).toBe(200);
    const all = await deals(p.id);
    expect(all.map((d) => [d.entry, d.volume.toString()])).toEqual([["IN", "1"], ["OUT", "0.4"], ["OUT", "0.6"]]);
    const done = await pos(p.id);
    const outSum = all.filter((d) => d.entry === "OUT").reduce((s, d) => s.add(d.volume), D(0));
    expect(outSum.toString()).toBe(done.initialVolume?.toString());
    const profitSum = all.reduce((s, d) => s.add(d.profit), D(0));
    expect(profitSum.toString()).toBe(done.realizedPnl?.toString());
    for (const d of all.slice(1)) await expectDealMatchesLedger(d);
  });

  it("STM bulk close (one request per position): reason BULK", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await seed(fx, { side: "SELL", volume: "0.30", openPrice: "110.00" });
    expect((await clientClose(fx, p.id, { closePrice: "100.10", maxSlippagePips: "5", source: "stm_bulk" })).status).toBe(200);
    const [d] = await outs(p.id);
    expect([d.entry, d.reason, d.side]).toEqual(["OUT", "BULK", "BUY"]);
  });
});

describe("bulk close", () => {
  it("trader bulk close: one OUT per position, reason BULK, channel recorded", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await seed(fx, { side: "BUY", volume: "1.50", openPrice: "90.00", swap: "1.00" });
    const b = await seed(fx, { side: "SELL", volume: "0.50", openPrice: "110.00" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/close-bulk/route");
    const r = await call(POST, "/api/trade/positions/close-bulk", "POST", { scope: "ALL" }, undefined, { "x-client-platform": "DESKTOP_NATIVE" });
    expect(r.status).toBe(200);
    const [da] = await outs(a.id);
    const [db] = await outs(b.id);
    expect(brief(da)).toEqual(["OUT", "BULK", "SELL", "1.5", "100", "15", "1"]);
    expect(brief(db)).toEqual(["OUT", "BULK", "BUY", "0.5", "100.1", "4.95", "0"]);
    expect([da.source, db.source]).toEqual(["DESKTOP_NATIVE", "DESKTOP_NATIVE"]);
  });

  it("staff bulk close: reason BULK with the staff member", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await seed(fx, { side: "BUY", volume: "0.10", openPrice: "90.00" });
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/close-bulk/route");
    expect((await call(POST, "/api/manage/positions/close-bulk", "POST", { positionIds: [a.id] })).status).toBe(200);
    const [d] = await outs(a.id);
    expect([d.reason, d.adminId, d.source]).toEqual(["BULK", fx.adminId, "ADMIN"]);
  });
});

describe("dealer-queued close", () => {
  it("partial then full through the queue: OUT with reason DEALER, the queued Order, its channel, the accepting staff member", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ dealing: true });
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "2.00" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const q1 = await call(POST, `/api/trade/positions/${p.id}/close`, "POST", { volume: "0.25", closePrice: "100.00", maxSlippagePips: "5" }, { id: p.id }, { "x-client-platform": "MOBILE" });
    expect(q1.status).toBe(202);
    const o1 = await prisma.order.findFirstOrThrow({ where: { closesPositionId: p.id, status: "PENDING" } });
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    expect((await call(PATCH, `/api/manage/dealing-queue/${o1.id}`, "PATCH", { action: "ACCEPT", fillMode: "MARKET" }, { id: o1.id })).status).toBe(200);

    const { queueCloseInTx, executeQueuedCloseInTx } = await import("@/lib/queued-close");
    const cur = await pos(p.id);
    const o2 = await prisma.$transaction((tx) =>
      queueCloseInTx(tx, { brokerId: fx.brokerId, accountId: fx.accountId, position: { id: p.id, symbolId: fx.symbolId, side: "BUY", volume: cur.volume }, closeVolume: cur.volume, requestedPrice: "102", idempotencyKey: `q:${randomUUID()}`, source: "WEB", symbolName: fx.symbolName, accountNumber: fx.accountNumber, note: "x" })
    );
    const full = await prisma.order.findUniqueOrThrow({ where: { id: o2.id } });
    expect((await prisma.$transaction((tx) => executeQueuedCloseInTx(tx, { order: full, fromStatus: "PENDING", closePrice: D("102"), note: "Dealer close (at market)" }))).kind).toBe("closed");

    const [d1, d2] = await outs(p.id);
    expect([d1.entry, d1.reason, d1.orderId, d1.source, d1.adminId, d1.volume.toString()]).toEqual(["OUT", "DEALER", o1.id, "MOBILE", fx.adminId, "0.25"]);
    expect([d2.entry, d2.reason, d2.orderId, d2.source, d2.adminId, d2.volume.toString(), d2.price.toString()]).toEqual(["OUT", "DEALER", o2.id, "WEB", null, "0.75", "102"]);
    for (const d of [d1, d2]) await expectDealMatchesLedger(d);
  });
});

describe("staff close", () => {
  it("partial then full: OUT with reason ADMIN and the staff member", async () => {
    if (!dbReachable) return;
    const { executeAdminCloseInTx } = await import("@/lib/position-actions");
    const fx = await fixture();
    const p = await seed(fx, { side: "SELL", volume: "2.00", openPrice: "110.00", swap: "-4.00" });
    const run = async (lots: string, price: string) => {
      const cur = await pos(p.id);
      return prisma.$transaction((tx) =>
        executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: { id: p.id, accountId: fx.accountId, side: "SELL", openPrice: cur.openPrice, volume: cur.volume, symbol: { name: fx.symbolName, contractSize: D(1) }, account: { accountNumber: fx.accountNumber } }, closePrice: D(price), closeVolume: D(lots) })
      );
    };
    expect((await run("0.50", "100")).closed).toBe(true);
    expect((await run("1.50", "104")).closed).toBe(true);
    const ds = await outs(p.id);
    expect(ds.map(brief)).toEqual([
      ["OUT", "ADMIN", "BUY", "0.5", "100", "5", "-1"],
      ["OUT", "ADMIN", "BUY", "1.5", "104", "9", "-3"],
    ]);
    expect(ds.every((d) => d.adminId === fx.adminId && d.source === "ADMIN")).toBe(true);
  });
});

describe("risk monitor closes", () => {
  it("stop loss, take profit, stop-out: reasons SL, TP, STOP_OUT", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture();
    const sl = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", sl: "95.00", swap: "-1.00" });
    await setPrice(fx, "94.00", "94.10");
    expect((await evaluateAccountRisk(fx.accountId)).slTpClosed).toEqual([sl.id]);
    expect(brief((await outs(sl.id))[0])).toEqual(["OUT", "SL", "SELL", "1", "94", "-6", "-1"]);

    const fx2 = await fixture();
    const tp = await seed(fx2, { side: "BUY", volume: "0.70", openPrice: "100.00", tp: "105.00" });
    await setPrice(fx2, "106.00", "106.10");
    expect((await evaluateAccountRisk(fx2.accountId)).slTpClosed).toEqual([tp.id]);
    expect(brief((await outs(tp.id))[0])).toEqual(["OUT", "TP", "SELL", "0.7", "106", "4.2", "0"]);

    const fx3 = await fixture({ balance: 60, group: { leverage: 1 } });
    await prisma.account.update({ where: { id: fx3.accountId }, data: { leverage: 1 } });
    const so = await seed(fx3, { side: "BUY", volume: "1.00", openPrice: "100.00" });
    await setPrice(fx3, "70.00", "70.10");
    expect((await evaluateAccountRisk(fx3.accountId)).stopOutClosed).toEqual([so.id]);
    const [d] = await outs(so.id);
    expect(brief(d)).toEqual(["OUT", "STOP_OUT", "SELL", "1", "70", "-30", "0"]);
    await expectDealMatchesLedger(d);
  });

  it("SL after a partial: the OUT carries only the remaining lots", async () => {
    if (!dbReachable) return;
    const { evaluateAccountRisk } = await import("@/lib/risk-monitor");
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "100.00", sl: "95.00" });
    await clientClose(fx, p.id, { volume: "0.50", closePrice: "100.00", maxSlippagePips: "5" });
    await setPrice(fx, "94.00", "94.10");
    await evaluateAccountRisk(fx.accountId);
    expect((await outs(p.id)).map((d) => [d.reason, d.volume.toString()])).toEqual([["CLIENT", "0.5"], ["SL", "0.5"]]);
  });
});

// --- close-by: OUT_BY with the link both ways, on every path -------------------------------------------------------------

describe("close-by", () => {
  it("client instant, unequal legs: two OUT_BY with byPositionId both ways; the larger leg stays open", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const buy = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00", swap: "5.00" });
    const sell = await seed(fx, { side: "SELL", volume: "0.40", openPrice: "110.00", swap: "1.00" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/close-by/route");
    const r = await call(POST, "/api/trade/positions/close-by", "POST", { positionId: buy.id, againstPositionId: sell.id }, undefined, { "x-client-platform": "DESKTOP_NATIVE" });
    expect(r.status).toBe(200);
    const [da] = await outs(buy.id);
    const [db] = await outs(sell.id);
    expect([...brief(da), da.byPositionId, da.source]).toEqual(["OUT_BY", "CLOSE_BY", "SELL", "0.4", "100.05", "4.02", "2", sell.id, "DESKTOP_NATIVE"]);
    expect([...brief(db), db.byPositionId]).toEqual(["OUT_BY", "CLOSE_BY", "BUY", "0.4", "100.05", "3.98", "1", buy.id]);
    expect((await pos(buy.id)).status).toBe("OPEN");
    for (const d of [da, db]) await expectDealMatchesLedger(d);
  });

  it("client dealer-queued: the link rides on both queued Orders; execution writes two OUT_BY (reason DEALER)", async () => {
    if (!dbReachable) return;
    const { executeQueuedCloseInTx } = await import("@/lib/queued-close");
    const fx = await fixture({ dealing: true });
    const buy = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const sell = await seed(fx, { side: "SELL", volume: "0.40", openPrice: "110.00" });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/close-by/route");
    const res = await call(POST, "/api/trade/positions/close-by", "POST", { positionId: buy.id, againstPositionId: sell.id });
    expect(res.status).toBe(202);
    for (const id of [res.json.orderAId, res.json.orderBId]) {
      const order = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect((await prisma.$transaction((tx) => executeQueuedCloseInTx(tx, { order, fromStatus: "PENDING", closePrice: D("100.05"), note: "Dealer close (at requested price)" }))).kind).toBe("closed");
    }
    const [da] = await outs(buy.id);
    const [db] = await outs(sell.id);
    expect([da.entry, da.reason, da.byPositionId, da.orderId, da.volume.toString()]).toEqual(["OUT_BY", "DEALER", sell.id, res.json.orderAId, "0.4"]);
    expect([db.entry, db.reason, db.byPositionId, db.orderId, db.volume.toString()]).toEqual(["OUT_BY", "DEALER", buy.id, res.json.orderBId, "0.4"]);
  });

  it("staff close-by: two OUT_BY (reason ADMIN) linked both ways", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const buy = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const sell = await seed(fx, { side: "SELL", volume: "0.40", openPrice: "110.00" });
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/close-by/route");
    expect((await call(POST, "/api/manage/positions/close-by", "POST", { positionId: buy.id, againstPositionId: sell.id })).status).toBe(200);
    const [da] = await outs(buy.id);
    const [db] = await outs(sell.id);
    expect([da.entry, da.reason, da.byPositionId, da.adminId]).toEqual(["OUT_BY", "ADMIN", sell.id, fx.adminId]);
    expect([db.entry, db.reason, db.byPositionId, db.adminId]).toEqual(["OUT_BY", "ADMIN", buy.id, fx.adminId]);
  });
});

// --- mirror, coverage, reverse, void ------------------------------------------------------------------------------------

describe("mirror and coverage follow-up closes", () => {
  it("mirror: a proportional partial close of the copy is an OUT (reason MIRROR) with its lots and price", async () => {
    if (!dbReachable) return;
    const { onClose } = await import("@/lib/mirror");
    const fx = await fixture();
    const targetGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `T-${randomUUID().slice(0, 8)}`, dealingMode: "AUTO" } });
    const target = await prisma.account.create({ data: { groupId: targetGroup.id, brokerId: fx.brokerId, accountNumber: `5${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `m-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Master", accountMode: "LIVE", balance: D(100000) } });
    const rule = await prisma.mirrorRule.create({ data: { brokerId: fx.brokerId, sourceType: "GROUP", sourceId: fx.groupId, targetAccountId: target.id, direction: "REVERSE", multiplier: D(1), enabled: true, fillPriceMode: "SOURCE_PRICE", createdById: fx.adminId } });
    const copy = await seed(fx, { side: "SELL", volume: "1.00", openPrice: "100.00", accountId: target.id, swap: "2.00" });
    const sourceId = randomUUID();
    await prisma.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: sourceId, targetPositionId: copy.id } });
    await onClose(prisma, { positionId: sourceId, brokerId: fx.brokerId, closedLots: D("0.25"), sourceVolumeBeforeClose: D("1.00"), closePrice: D("98") }, { rethrow: true });
    expect(brief((await outs(copy.id))[0])).toEqual(["OUT", "MIRROR", "BUY", "0.25", "98", "0.5", "0.5"]);
  });

  it("coverage: the auto-hedged leg's follow-up closes are OUTs (reason COVERAGE), partial then full", async () => {
    if (!dbReachable) return;
    const { onClose } = await import("@/lib/coverage");
    const fx = await fixture();
    const covGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `Cov-${randomUUID().slice(0, 8)}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
    const cov = await prisma.account.create({ data: { groupId: covGroup.id, brokerId: fx.brokerId, accountNumber: `4${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `cov-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Dealer Coverage", accountMode: "LIVE", balance: D(0) } });
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    const client = await seed(fx, { side: "BUY", volume: "2.00", openPrice: "100.00" });
    const leg = await seed(fx, { side: "BUY", volume: "2.00", openPrice: "100.00", accountId: cov.id, swap: "1.00" });
    await prisma.position.update({ where: { id: leg.id }, data: { autoHedged: true, bookType: "A_BOOK" } });
    await prisma.position.update({ where: { id: client.id }, data: { covered: true, coveredAt: new Date(), coveragePositionId: leg.id, volume: D("1.50") } });
    await onClose(prisma, { positionId: client.id, brokerId: fx.brokerId, closedLots: D("0.50"), sourceVolumeBeforeClose: D("2.00"), reason: "manual" });
    await prisma.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("100"), closedAt: new Date() } });
    await onClose(prisma, { positionId: client.id, brokerId: fx.brokerId, closedLots: D("1.50"), sourceVolumeBeforeClose: D("1.50"), reason: "manual" });
    expect((await outs(leg.id)).map((d) => [d.entry, d.reason, d.volume.toString(), d.price.toString(), d.swap.toString()])).toEqual([
      ["OUT", "COVERAGE", "0.5", "100", "0.25"],
      ["OUT", "COVERAGE", "1.5", "100", "0.75"],
    ]);
  });
});

describe("reverse close-and-reopen", () => {
  it("the old position gets an OUT (reason REVERSE), the new one an IN and reversedFromPositionId", async () => {
    if (!dbReachable) return;
    const { executeReverseCloseReopen } = await import("@/lib/position-actions");
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "0.80", openPrice: "90.00" });
    const r = await prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    const [out] = await outs(p.id);
    expect([...brief(out), out.adminId]).toEqual(["OUT", "REVERSE", "SELL", "0.8", "100", "8", "0", fx.adminId]);
    const reopened = await pos(r.newPosition.id);
    expect(reopened.reversedFromPositionId).toBe(p.id);
    expect(reopened.initialVolume?.toString()).toBe("0.8");
    const [inDeal] = await deals(reopened.id);
    expect([inDeal.entry, inDeal.reason, inDeal.side, inDeal.volume.toString(), inDeal.adminId, inDeal.source]).toEqual(["IN", "REVERSE", "SELL", "0.8", fx.adminId, "ADMIN"]);
  });
});

describe("reverse in place", () => {
  it("writes an OUT for the old side and an IN for the new side on the same position (and on its hedge leg), at the entry price, no P/L", async () => {
    if (!dbReachable) return;
    const { executeReverseInPlace } = await import("@/lib/position-actions");
    const fx = await fixture();
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.60", price: "100.10", idempotencyKey: `dl:${randomUUID()}` })).status).toBe(201);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    const leg = await seed(fx, { side: "BUY", volume: "0.60", openPrice: "100.10" });
    await prisma.position.update({ where: { id: p.id }, data: { covered: true, coveredAt: new Date(), coveragePositionId: leg.id } });
    const balanceBefore = (await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance;

    const r = await prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    expect(r.newSide).toBe("SELL");
    const all = await deals(p.id);
    expect(all.map((d) => [d.entry, d.reason, d.side, d.volume.toString(), d.price.toString(), d.profit.toString(), d.transactionId])).toEqual([
      ["IN", "CLIENT", "BUY", "0.6", p.openPrice.toString(), "0", null],
      ["OUT", "REVERSE", "SELL", "0.6", p.openPrice.toString(), "0", null],
      ["IN", "REVERSE", "SELL", "0.6", p.openPrice.toString(), "0", null],
    ]);
    expect(all.slice(1).every((d) => d.adminId === fx.adminId && d.source === "ADMIN")).toBe(true);
    expect(all[1].ticket < all[2].ticket).toBe(true);
    const after = await pos(p.id);
    expect([after.side, after.initialVolume?.toString()]).toEqual(["SELL", "0.6"]);
    // a correction, not a trade: no ledger row, balance unchanged
    expect(await pnlRows(p.id)).toHaveLength(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: fx.accountId } })).balance.toString()).toBe(balanceBefore.toString());
    // the hedge leg flipped with it gets the same pair
    expect((await deals(leg.id)).map((d) => [d.entry, d.reason, d.side])).toEqual([["OUT", "REVERSE", "SELL"], ["IN", "REVERSE", "SELL"]]);

    // a later close is an OUT of the new side
    expect((await clientClose(fx, p.id, { closePrice: "100.10", maxSlippagePips: "5" })).status).toBe(200);
    const last = (await deals(p.id)).at(-1)!;
    expect([last.entry, last.reason, last.side]).toEqual(["OUT", "CLIENT", "BUY"]);
  });
});

describe("void", () => {
  it("voiding a closed trade marks its IN and OUT deals voided; the rows stay", async () => {
    if (!dbReachable) return;
    const { executeVoid } = await import("@/lib/position-actions");
    const fx = await fixture();
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.50", price: "100.10", idempotencyKey: `dl:${randomUUID()}` })).status).toBe(201);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    expect((await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" })).status).toBe(200);
    expect((await deals(p.id)).map((d) => d.voidedAt)).toEqual([null, null]);
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    const after = await deals(p.id);
    expect(after).toHaveLength(2);
    expect(after.every((d) => d.voidedAt instanceof Date)).toBe(true);
  });

  it("voiding an open position marks its IN deal voided", async () => {
    if (!dbReachable) return;
    const { executeVoid } = await import("@/lib/position-actions");
    const fx = await fixture();
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    expect((await call(POST, "/api/manage/positions", "POST", { accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", volume: "0.10" })).status).toBe(200);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId } });
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    const [d] = await deals(p.id);
    expect([d.entry, d.voidedAt instanceof Date]).toEqual(["IN", true]);
  });
});

// --- exactly once ------------------------------------------------------------------------------------------------------

describe("exactly once", () => {
  it("two concurrent full closes of one position: one TRADE_PNL, one deal", async () => {
    if (!dbReachable) return;
    const { closePositionInTx } = await import("@/lib/position-close");
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    const input = { id: p.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY" as const, openPrice: D("90"), volume: D("1"), symbol: { contractSize: D(1) } };
    const outcomes = await Promise.allSettled([0, 1, 2].map(() => prisma.$transaction((tx) => closePositionInTx(tx, { position: input, closePrice: D("100"), deal: { reason: "CLIENT" } }))));
    const closed = outcomes.filter((o) => o.status === "fulfilled" && o.value.closed);
    expect(closed).toHaveLength(1);
    expect(await pnlRows(p.id)).toHaveLength(1);
    expect(await outs(p.id)).toHaveLength(1);
  });

  it("a close whose transaction rolls back leaves no deal", async () => {
    if (!dbReachable) return;
    const { closePositionInTx } = await import("@/lib/position-close");
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    await expect(
      prisma.$transaction(async (tx) => {
        const r = await closePositionInTx(tx, { position: { id: p.id, accountId: fx.accountId, brokerId: fx.brokerId, side: "BUY", openPrice: D("90"), volume: D("1"), symbol: { contractSize: D(1) } }, closePrice: D("100"), deal: { reason: "CLIENT" } });
        expect(r.closed).toBe(true);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(await deals(p.id)).toHaveLength(0);
    expect((await pos(p.id)).status).toBe("OPEN");
  });

  it("a second deal for the same ledger row is refused by the unique transactionId", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await seed(fx, { side: "BUY", volume: "1.00", openPrice: "90.00" });
    expect((await clientClose(fx, p.id, { closePrice: "100.00", maxSlippagePips: "5" })).status).toBe(200);
    const [d] = await outs(p.id);
    const { id: _id, ticket: _ticket, createdAt: _c, ...copy } = d;
    void _id; void _ticket; void _c;
    await expect(prisma.deal.create({ data: copy })).rejects.toThrow();
  });
});
