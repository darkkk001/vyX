import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 7 (owner 2026-10-07): the dealer's LIMIT / STOP orders on the broker's hedge (coverage) account. A new order path: every
// gate of a client order applies at placement and again at the trigger; the fill is the raw price, no commission, A_BOOK, never mirrored.
// ADVERSARIAL on the local scratch DB: each refusal is proven by the order staying unplaced / unfilled and no position existing.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mirror", () => ({ onClose: vi.fn().mockResolvedValue(undefined), onFillPosition: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import * as mirror from "@/lib/mirror";
import { ensureCoverageAccount } from "@/lib/coverage";
import { triggerPendingOrder } from "@/lib/pending-trigger";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-coverage-pending.test.ts: DB unreachable, skipping"); } });
const brokers: string[] = []; const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.groupSymbol.deleteMany({ where: { group: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `CovP ${sfx}`, subdomain: `covp-${sfx}` } }); brokers.push(b.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `covp-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `CP${sfx.toUpperCase()}`; symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const bs = await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true, tradingMode: "BOTH", spreadMarkup: D(5), commissionPerLot: D(7) } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const cov = await ensureCoverageAccount(b.id, admin.id);
  return { brokerId: b.id, adminId: admin.id, symbolName: name, symbolId: s.id, bsId: bs.id, accountId: cov.accountId, groupId: cov.groupId };
}
type W = Awaited<ReturnType<typeof world>>;
const asAdmin = (w: W) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: w.adminId, role: "BROKER_ADMIN", brokerId: w.brokerId } as never);
async function place(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/manage/coverage/orders/route");
  const res = await POST(new NextRequest("https://t.local/api/manage/coverage/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const buyLimit = (w: W, over: Record<string, unknown> = {}) => ({ symbol: w.symbolName, side: "BUY", type: "LIMIT", volume: "1", price: "95.00", ...over });
const pendingCount = (w: W) => prisma.order.count({ where: { accountId: w.accountId, status: "PENDING" } });
const posCount = (w: W) => prisma.position.count({ where: { accountId: w.accountId } });
const setLive = (w: W, bid: string, ask: string) => prisma.livePrice.update({ where: { symbol: w.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });

describe("placement: a resting order on the hedge account", () => {
  it("BUY LIMIT below the ask rests as PENDING, audited; the entry must be on the right side of the market; SL / TP on the right side of the entry", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    const r = await place(buyLimit(w, { slPrice: "90", tpPrice: "110" }));
    expect(r.status).toBe(201); expect(r.json).toMatchObject({ pending: true, type: "LIMIT", entry: "95.00" });
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r.json.orderId } });
    expect([o.status, o.type, o.accountId, o.source, o.requestedPrice?.toString()]).toEqual(["PENDING", "LIMIT", w.accountId, "ADMIN", "95"]);
    expect(await prisma.auditLog.count({ where: { brokerId: w.brokerId, action: "COVERAGE_PENDING_ORDER_PLACED", entityId: o.id } })).toBe(1);
    expect(await posCount(w)).toBe(0);
    expect((await place(buyLimit(w, { price: "101" }))).status).toBe(400);                  // a BUY LIMIT above the market
    expect((await place(buyLimit(w, { type: "STOP", price: "99" }))).status).toBe(400);     // a BUY STOP below it
    expect((await place({ ...buyLimit(w, { side: "SELL", type: "STOP", price: "103" }) })).status).toBe(400);
    expect((await place(buyLimit(w, { slPrice: "96" }))).status).toBe(400);                 // SL above a BUY entry
    expect((await place(buyLimit(w, { tpPrice: "94" }))).status).toBe(400);                 // TP below a BUY entry
    expect((await place(buyLimit(w, { type: "OCO" }))).status).toBe(400);
    expect((await place(buyLimit(w, { price: "abc" }))).status).toBe(400);
    expect(await pendingCount(w)).toBe(1);
  });

  it("every gate refuses at placement and places nothing: halt, close-only, allowed sides, volume step, group max / min, trading rights, status, group halt / close-only, margin when funded", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    const refused = async (why: string, body = buyLimit(w)) => { const r = await place(body); expect(r.status, why).toBe(400); expect(await pendingCount(w), why).toBe(0); };
    await prisma.broker.update({ where: { id: w.brokerId }, data: { tradingHaltedAt: new Date() } }); await refused("broker halt");
    await prisma.broker.update({ where: { id: w.brokerId }, data: { tradingHaltedAt: null, closeOnlyAt: new Date() } }); await refused("broker close-only");
    await prisma.broker.update({ where: { id: w.brokerId }, data: { closeOnlyAt: null } });
    await prisma.brokerSymbol.update({ where: { id: w.bsId }, data: { tradingMode: "SELL_ONLY" } }); await refused("symbol allowed sides");
    await prisma.brokerSymbol.update({ where: { id: w.bsId }, data: { tradingMode: "BOTH" } });
    await refused("volume step", buyLimit(w, { volume: "1.005" }));
    await prisma.group.update({ where: { id: w.groupId }, data: { maxLotSize: D("0.5") } }); await refused("group max volume");
    await prisma.group.update({ where: { id: w.groupId }, data: { maxLotSize: null, minLotSize: D("2") } }); await refused("group min volume");
    await prisma.group.update({ where: { id: w.groupId }, data: { minLotSize: null, tradingHaltedAt: new Date() } }); await refused("group halt");
    await prisma.group.update({ where: { id: w.groupId }, data: { tradingHaltedAt: null, closeOnlyAt: new Date() } }); await refused("group close-only");
    await prisma.group.update({ where: { id: w.groupId }, data: { closeOnlyAt: null } });
    await prisma.account.update({ where: { id: w.accountId }, data: { tradingRights: "READ_ONLY" } }); await refused("trading rights");
    await prisma.account.update({ where: { id: w.accountId }, data: { tradingRights: "FULL", status: "SUSPENDED" } }); await refused("account status");
    await prisma.account.update({ where: { id: w.accountId }, data: { status: "ACTIVE", balance: D(10) } });                // funded: the margin gate applies
    await refused("margin on a funded hedge account", buyLimit(w, { volume: "100", price: "95" }));
    expect((await place(buyLimit(w))).status).toBe(201);                                                                      // every gate open again: it places
  });

  it("MARKET still fills at once and is unchanged", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    const r = await place({ symbol: w.symbolName, side: "BUY", volume: "1" });
    expect(r.status).toBe(200); expect(r.json.fillPrice).toBe("100.10");
    expect(await posCount(w)).toBe(1);
  });
});

describe("the trigger fills it as a hedge order", () => {
  it("reaching the entry fills at the RAW ask, zero commission, A_BOOK, no mirror copy, no hedge leg; audited; OrderFilled published", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    const r = await place(buyLimit(w, { price: "99.00" }));
    expect(r.status).toBe(201);
    await setLive(w, "98.80", "98.90");
    vi.mocked(mirror.onFillPosition).mockClear(); vi.mocked(publishTradingEvent).mockClear();
    const out = await triggerPendingOrder(r.json.orderId, "98.90", "server");
    expect(out.kind).toBe("filled");
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r.json.orderId } });
    expect([o.status, o.filledPrice?.toString()]).toEqual(["FILLED", "98.9"]);                  // the raw ask: no markup of 5 on top
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: w.accountId } });
    expect([p.bookType, p.openPrice.toString(), p.side, p.originOrderId]).toEqual(["A_BOOK", "98.9", "BUY", o.id]);
    expect(await prisma.transaction.count({ where: { accountId: w.accountId, type: "COMMISSION" } })).toBe(0);
    expect(mirror.onFillPosition).not.toHaveBeenCalled();
    expect(await posCount(w)).toBe(1);                                                            // no auto-hedge leg
    expect(await prisma.auditLog.count({ where: { brokerId: w.brokerId, action: "COVERAGE_PENDING_ORDER_FILLED", entityId: p.id } })).toBe(1);
    expect(vi.mocked(publishTradingEvent).mock.calls.some((c) => c[0] === "OrderFilled")).toBe(true);
    // a second trigger finds nothing to do
    expect((await triggerPendingOrder(r.json.orderId, "98.90", "server")).kind).toBe("skipped");
  });

  it("the gates run again at the trigger: a halt, a close-only or a suspension in between rejects the order and opens nothing", async () => {
    if (!dbReachable) return;
    for (const [why, patch] of [["halt", () => ({ broker: { tradingHaltedAt: new Date() } })], ["close-only", () => ({ broker: { closeOnlyAt: new Date() } })], ["suspended", () => ({ account: { status: "SUSPENDED" as const } })]] as const) {
      const w = await world(); asAdmin(w);
      const r = await place(buyLimit(w, { price: "99.00" })); expect(r.status, why).toBe(201);
      const p = patch();
      if ("broker" in p) await prisma.broker.update({ where: { id: w.brokerId }, data: p.broker });
      if ("account" in p) await prisma.account.update({ where: { id: w.accountId }, data: p.account });
      await setLive(w, "98.80", "98.90");
      const out = await triggerPendingOrder(r.json.orderId, "98.90", "server");
      expect(out.kind, why).toBe("rejected");
      expect((await prisma.order.findUniqueOrThrow({ where: { id: r.json.orderId } })).status, why).toBe("REJECTED");
      expect(await posCount(w), why).toBe(0);
    }
  });

  it("the client limits do not apply to the hedge account: max open positions and no-hedging", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    await prisma.broker.update({ where: { id: w.brokerId }, data: { maxOpenPositionsPerAccount: 1, hedgingAllowed: false } });
    expect((await place({ symbol: w.symbolName, side: "SELL", volume: "1" })).status).toBe(200);        // one SELL open already
    const r = await place(buyLimit(w, { price: "99.00" })); expect(r.status).toBe(201);              // a BUY resting against it: a hedge
    await setLive(w, "98.80", "98.90");
    expect((await triggerPendingOrder(r.json.orderId, "98.90", "server")).kind).toBe("filled");
    expect(await posCount(w)).toBe(2);
  });

  it("a CLIENT account still cannot be handed a hedge-account order: the system route stays closed to every other system account order", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync("lib/pending-trigger.ts", "utf8");
    expect(src).toContain('if (route === "SYSTEM" && !isCoverage) return fail(SYSTEM_ACCOUNT_ORDER.code');
    expect(src).toContain("const isCoverage = broker.coverageAccountId === order.accountId;");
  });
});

describe("the desk sees and cancels it", () => {
  it("the hedge account's resting order is in the desk's resting list and the dealer's cancel works on it", async () => {
    if (!dbReachable) return;
    const w = await world(); asAdmin(w);
    const r = await place(buyLimit(w)); expect(r.status).toBe(201);
    const { getDealingDeskRestingOrders } = await import("@/lib/dealer-activity");
    expect((await getDealingDeskRestingOrders(w.brokerId)).map((x) => x.orderId)).toContain(r.json.orderId);
    const { POST } = await import("@/app/api/manage/orders/[id]/cancel/route");
    const res = await POST(new NextRequest("https://t.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "changed my mind" }) }), { params: Promise.resolve({ id: r.json.orderId }) });
    expect(res.status).toBe(200);
    expect(await pendingCount(w)).toBe(0);
  });
});
