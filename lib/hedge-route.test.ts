import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type BookType, type RoutingCategory } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner 2026-10-26: a position is hedged by ONE route. A-book = QoreBridge only (HedgeIntent), the broker's own book =
// the hedge account only (BOOK NOW / HEDGE ALL / auto-hedge). These tests fail if any path could hedge a position twice.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined), publishBridgeNudge: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";
import { autoHedgesOnFill, hedgeRouteOf, hedgeRouteOfCategory } from "@/lib/hedge-route";
import { isHedgedCategory } from "@/lib/hedge";

const CATEGORIES: (RoutingCategory | null)[] = ["A_BOOK", "B_BOOK", "DEALING", "REVERSAL", "COVERAGE", null];
const BOOK_TYPES: BookType[] = ["A_BOOK", "B_BOOK"];

describe("hedgeRouteOf: one route per position, whatever its stamps say", () => {
  for (const groupCategoryAtOpen of CATEGORIES) {
    for (const bookType of BOOK_TYPES) {
      it(`category ${groupCategoryAtOpen} / bookType ${bookType}: QoreBridge and the hedge account never both`, () => {
        const viaQoreBridge = isHedgedCategory(groupCategoryAtOpen); // what lib/hedge.ts writes intents for
        const viaHedgeAccount = hedgeRouteOf({ groupCategoryAtOpen, bookType }) === "HEDGE_ACCOUNT"; // what BOOK NOW / auto-hedge accept
        expect(viaQoreBridge && viaHedgeAccount).toBe(false);
        if (viaQoreBridge) expect(hedgeRouteOf({ groupCategoryAtOpen, bookType })).toBe("LIQUIDITY_PROVIDER");
      });
    }
  }
  it("the plain cases", () => {
    expect(hedgeRouteOf({ groupCategoryAtOpen: "A_BOOK", bookType: "A_BOOK" })).toBe("LIQUIDITY_PROVIDER");
    expect(hedgeRouteOf({ groupCategoryAtOpen: "A_BOOK", bookType: "B_BOOK" })).toBe("LIQUIDITY_PROVIDER"); // group changed mid-order
    expect(hedgeRouteOf({ groupCategoryAtOpen: "DEALING", bookType: "B_BOOK" })).toBe("HEDGE_ACCOUNT");
    expect(hedgeRouteOf({ groupCategoryAtOpen: "DEALING", bookType: "A_BOOK" })).toBe("NONE");
    expect(hedgeRouteOf({ groupCategoryAtOpen: "COVERAGE", bookType: "A_BOOK" })).toBe("NONE"); // never hedge the hedge
    expect(hedgeRouteOf({ groupCategoryAtOpen: null, bookType: "B_BOOK" })).toBe("HEDGE_ACCOUNT"); // before the stamp
  });
  it("per group (the Liquidity screen line): A-book QoreBridge, the rest the hedge account; auto-hedge DEALING only", () => {
    expect(hedgeRouteOfCategory("A_BOOK")).toBe("LIQUIDITY_PROVIDER");
    for (const c of ["B_BOOK", "DEALING", "REVERSAL"] as const) expect(hedgeRouteOfCategory(c)).toBe("HEDGE_ACCOUNT");
    expect(hedgeRouteOfCategory("COVERAGE")).toBe("NONE");
    expect(["A_BOOK", "B_BOOK", "DEALING", "REVERSAL", "COVERAGE"].filter((c) => autoHedgesOnFill(c as RoutingCategory))).toEqual(["DEALING"]);
  });
});

// ---- the real paths, live DB (scratch), every row removed afterwards ----
const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
const brokers: string[] = [];
const symbols: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("hedge-route.test.ts: DB unreachable, skipping the DB cases");
  }
});
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.hedgeIntent.deleteMany({ where }).catch(() => {});
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function world(category: RoutingCategory) {
  const b = await prisma.broker.create({
    data: { name: `HR ${randomUUID().slice(0, 8)}`, subdomain: `hr-${randomUUID().slice(0, 8)}`, dealingDeskAutoFillAt: new Date(), autoHedgeAt: new Date() },
  });
  brokers.push(b.id);
  const name = `HR${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbols.push(name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category } });
  const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `hr-${n}@test.local`, passwordHash: "x", fullName: "HR", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `hr-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
  return { brokerId: b.id, symbolId: s.id, accountId: acc.id };
}

// a filled client position; groupCategoryAtOpen is stamped by the DB trigger from the account's group right now
async function openPosition(w: { brokerId: string; symbolId: string; accountId: string }, bookType: BookType) {
  const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `hr:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), bookType } });
}

async function bookNow(positionId: string) {
  const { POST } = await import("@/app/api/manage/positions/[id]/book/route");
  const res = await POST(new NextRequest(`https://t.local/api/manage/positions/${positionId}/book`, { method: "POST", body: "{}" }), { params: Promise.resolve({ id: positionId }) });
  return res.status;
}

describe("no double hedge on the real paths (live DB)", () => {
  it("an A-book position whose bookType says B (group changed mid-order): BOOK NOW refuses it", async () => {
    if (!dbReachable) return;
    const w = await world("A_BOOK");
    const pos = await openPosition(w, "B_BOOK");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).groupCategoryAtOpen).toBe("A_BOOK");
    expect(await bookNow(pos.id)).toBe(409);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).covered).toBe(false);
  });

  it("the same position after its account moved to a DEALING group: auto-hedge leaves it to QoreBridge", async () => {
    if (!dbReachable) return;
    const w = await world("A_BOOK");
    const pos = await openPosition(w, "B_BOOK");
    const dealing = await prisma.group.create({ data: { brokerId: w.brokerId, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "DEALING" } });
    await prisma.account.update({ where: { id: w.accountId }, data: { groupId: dealing.id } });
    const coverage = await import("@/lib/coverage");
    await coverage.onFillAutoHedge(prisma, { positionId: pos.id, brokerId: w.brokerId });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).covered).toBe(false);
  });

  it("a plain A-book position is never booked on the hedge account", async () => {
    if (!dbReachable) return;
    const w = await world("A_BOOK");
    const pos = await openPosition(w, "A_BOOK");
    expect(await bookNow(pos.id)).toBe(400);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).covered).toBe(false);
  });

  it("a DEALING position booked by hand gets one hedge-account leg and no QoreBridge intent", async () => {
    if (!dbReachable) return;
    const w = await world("DEALING");
    const pos = await openPosition(w, "B_BOOK");
    expect(await bookNow(pos.id)).toBe(200);
    const booked = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(booked.covered).toBe(true);
    expect(await prisma.hedgeIntent.count({ where: { brokerId: w.brokerId } })).toBe(0);
    // booking again is refused: one leg per position
    expect(await bookNow(pos.id)).not.toBe(200);
  });
});
