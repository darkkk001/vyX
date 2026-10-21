import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type HedgeIntent, type RoutingCategory } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// QoreBridge M5 (docs/qorebridge/00-current-state.md, Integration points + Close-side hooks): every deal on an A-book
// position leaves exactly one HedgeIntent in the deal's own transaction, and nothing else ever does. Each path of the
// doc's fill-site and close tables has a case here, plus the B-book regression: the same flows on B_BOOK / DEALING /
// REVERSAL groups write no intent at all. Against the scratch database; each fixture owns a private CRYPTO symbol.
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
  return {
    ...real,
    publishTradingEvent: vi.fn().mockResolvedValue(undefined),
    publishAlertConfig: vi.fn().mockResolvedValue(undefined),
    publishBridgeNudge: vi.fn().mockResolvedValue(undefined),
  };
});
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "seq" FROM "HedgeIntent" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/hedge.test.ts: DB unreachable or hedge_intent_result migration missing, skipping");
  }
});
const brokers: string[] = [];
afterAll(async () => {
  if (dbReachable && brokers.length > 0) {
    // over everything these tests wrote: never an intent for a position that was not A-book at open, never two per deal
    const intents = await prisma.hedgeIntent.findMany({ where: { brokerId: { in: brokers } }, select: { positionId: true, dealId: true } });
    const positions = await prisma.position.findMany({ where: { id: { in: intents.map((i) => i.positionId) } }, select: { id: true, groupCategoryAtOpen: true } });
    expect(positions.filter((p) => p.groupCategoryAtOpen !== "A_BOOK")).toEqual([]);
    const dealIds = intents.map((i) => i.dealId).filter((d): d is string => d !== null);
    expect(new Set(dealIds).size).toBe(dealIds.length);
  }
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; accountId: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(category: RoutingCategory): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Hedge ${suffix}`, subdomain: `hedge-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: new Date() } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `hedge-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `HG${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `HGG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category, dealingMode: "AUTO", isClientSelectable: true },
  });
  // placed directly: the sign-up / placement guard keeps clients out of A_BOOK groups (open question 11)
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `4${suffix.slice(0, 7)}`, email: `hedge-client-${suffix}@test.local`, passwordHash: "x", fullName: "Hedge Client", accountMode: "LIVE", leverage: 100, balance: D(100000) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const asTrader = (fx: Fx) => vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
const asAdmin = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);

async function marketOrder(fx: Fx, side: "BUY" | "SELL", volume: string) {
  asTrader(fx);
  const { POST } = await import("@/app/api/trade/orders/route");
  const r = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side, type: "MARKET", volume, price: side === "BUY" ? "100.10" : "100.00", idempotencyKey: `hg:${randomUUID()}` });
  expect(r.status, JSON.stringify(r.json)).toBe(201);
  return prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId }, orderBy: { openedAt: "desc" } });
}
async function clientClose(fx: Fx, positionId: string, volume?: string) {
  asTrader(fx);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const r = await call(POST, `/api/trade/positions/${positionId}/close`, "POST", { closePrice: "100.00", maxSlippagePips: "50", ...(volume ? { volume } : {}) }, { id: positionId });
  expect(r.status, JSON.stringify(r.json)).toBe(200);
}
const intents = (fx: Fx) => prisma.hedgeIntent.findMany({ where: { brokerId: fx.brokerId }, orderBy: { seq: "asc" } });
const brief = (i: HedgeIntent) => [i.kind, i.side, i.volume.toString(), i.status, i.reason];

describe("A-book: one intent per deal, in the deal's transaction", () => {
  it("client market order: an OPEN intent on the IN deal (same side, volume, client price, group, symbol), claimable", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "0.50");
    expect(p.groupCategoryAtOpen).toBe("A_BOOK");
    const [i] = await intents(fx);
    const deal = await prisma.deal.findFirstOrThrow({ where: { positionId: p.id, entry: "IN" } });
    expect(brief(i)).toEqual(["OPEN", "BUY", "0.5", "PENDING", "CLIENT"]);
    expect([i.dealId, i.positionId, i.accountId, i.groupId, i.symbol, i.clientPrice?.toString()]).toEqual([deal.id, p.id, fx.accountId, fx.groupId, fx.symbolName, deal.price.toString()]);
    // FIX-safe ClOrdID root, short enough for leg suffixes
    expect(i.id).toMatch(/^[A-Za-z0-9_-]{1,37}$/);
  });

  it("partial then full client close: CLOSE intents on the opposite side for exactly the lots each close applied", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "1.00");
    await clientClose(fx, p.id, "0.30");
    await clientClose(fx, p.id);
    expect((await intents(fx)).map(brief)).toEqual([
      ["OPEN", "BUY", "1", "PENDING", "CLIENT"],
      ["CLOSE", "SELL", "0.3", "PENDING", "CLIENT"],
      ["CLOSE", "SELL", "0.7", "PENDING", "CLIENT"],
    ]);
  });

  it("staff open and staff close: OPEN / CLOSE with reason ADMIN", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    expect((await call(POST, "/api/manage/positions", "POST", { accountId: fx.accountId, symbolId: fx.symbolId, side: "SELL", volume: "0.20" })).status).toBe(200);
    const p = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId }, include: { symbol: true, account: true } });
    const { executeAdminCloseInTx } = await import("@/lib/position-actions");
    await prisma.$transaction((tx) => executeAdminCloseInTx(tx, { brokerId: fx.brokerId, adminId: fx.adminId, position: p, closePrice: D("100.10"), closeVolume: p.volume }));
    expect((await intents(fx)).map(brief)).toEqual([
      ["OPEN", "SELL", "0.2", "PENDING", "ADMIN"],
      ["CLOSE", "BUY", "0.2", "PENDING", "ADMIN"],
    ]);
  });

  it("pending LIMIT order triggered: the OPEN intent comes with the fill, not with the order", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "LIMIT", volume: "0.40", price: "95.00", idempotencyKey: `hg:${randomUUID()}` })).status).toBe(201);
    expect(await intents(fx)).toEqual([]);
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: fx.accountId } });
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("94.90"), ask: D("95.00"), tickAt: new Date() } });
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    expect((await triggerPendingOrder(o.id, "95.00", "server")).kind).toBe("filled");
    expect((await intents(fx)).map(brief)).toEqual([["OPEN", "BUY", "0.4", "PENDING", "CLIENT"]]);
  });

  it("close-by: one CLOSE per leg (OUT_BY), each on its own closing side", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const buy = await marketOrder(fx, "BUY", "1.00");
    const sell = await marketOrder(fx, "SELL", "0.40");
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/positions/close-by/route");
    expect((await call(POST, "/api/trade/positions/close-by", "POST", { positionId: buy.id, againstPositionId: sell.id })).status).toBe(200);
    const closes = (await intents(fx)).filter((i) => i.kind === "CLOSE");
    expect(closes.map((i) => [i.positionId, i.side, i.volume.toString(), i.reason]).sort()).toEqual(
      [
        [buy.id, "SELL", "0.4", "CLOSE_BY"],
        [sell.id, "BUY", "0.4", "CLOSE_BY"],
      ].sort()
    );
  });

  it("reverse in place: two intents, both on the new side (reduce N, open N), reason REVERSE", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "0.60");
    const { executeReverseInPlace } = await import("@/lib/position-actions");
    await prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    expect((await intents(fx)).slice(1).map((i) => [i.kind, i.side, i.volume.toString(), i.reason])).toEqual([
      ["CLOSE", "SELL", "0.6", "REVERSE"],
      ["OPEN", "SELL", "0.6", "REVERSE"],
    ]);
  });

  it("void: an open position's hedge comes off (VOID, opposite side, no deal); voiding a closed trade adds nothing", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const { executeVoid } = await import("@/lib/position-actions");
    const open = await marketOrder(fx, "SELL", "0.25");
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: open.id, adminId: fx.adminId }));
    const v = (await intents(fx)).find((i) => i.kind === "VOID")!;
    expect([v.side, v.volume.toString(), v.dealId, v.positionId]).toEqual(["BUY", "0.25", null, open.id]);

    const closed = await marketOrder(fx, "BUY", "0.10");
    await clientClose(fx, closed.id);
    const before = (await intents(fx)).length;
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: closed.id, adminId: fx.adminId }));
    expect((await intents(fx)).length).toBe(before);
  });

  it("engine SL close (PostCloseEffect): the hedge step keys the intent to the engine's OUT deal, once", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "0.50");
    // what the engine's close transaction leaves: the position closed, its OUT deal, the outbox row naming the deal
    const deal = await prisma.deal.create({
      data: { id: randomUUID(), brokerId: fx.brokerId, accountId: fx.accountId, positionId: p.id, symbolId: fx.symbolId, side: "SELL", entry: "OUT", reason: "SL", volume: D("0.50"), price: D("99.00"), executedAt: new Date() },
    });
    await prisma.position.update({ where: { id: p.id }, data: { status: "CLOSED", closedAt: new Date(), closedVolume: D("0.50"), volume: D("0.50") } });
    const row = await prisma.postCloseEffect.create({
      data: {
        kind: "POSITION_CLOSED", dedupeKey: `close:${p.id}:${randomUUID()}`, brokerId: fx.brokerId, accountId: fx.accountId, positionId: p.id, reason: "stop_loss",
        payload: { closedLots: "0.5", sourceVolumeBeforeClose: "0.5", closePrice: "99", realizedPnl: "-0.55", dealId: deal.id, dealTicket: deal.ticket.toString(), remainingVolume: "0" },
      },
    });
    const { runPostClose } = await import("@/lib/post-close");
    await runPostClose(row.id);
    await runPostClose(row.id); // a re-run does nothing more
    const closes = (await intents(fx)).filter((i) => i.kind === "CLOSE");
    expect(closes.map((i) => [i.dealId, i.side, i.volume.toString(), i.reason])).toEqual([[deal.id, "SELL", "0.5", "SL"]]);
    expect((await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } })).doneSteps).toContain("hedge");
  });

  it("the account's CURRENT group does not matter: an A-book position moved to a B-book group still hedges its close", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "0.30");
    const bGroup = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `B-${randomUUID().slice(0, 6)}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO" } });
    await prisma.account.update({ where: { id: fx.accountId }, data: { groupId: bGroup.id } });
    await clientClose(fx, p.id);
    expect((await intents(fx)).map((i) => i.kind)).toEqual(["OPEN", "CLOSE"]);
  });

  it("a fill whose transaction rolls back leaves no intent; a second call for the same deal writes nothing more", async () => {
    if (!dbReachable) return;
    const fx = await fixture("A_BOOK");
    const p = await marketOrder(fx, "BUY", "0.10");
    const deal = await prisma.deal.findFirstOrThrow({ where: { positionId: p.id } });
    const { hedgeDealInTx } = await import("@/lib/hedge");
    expect(await prisma.$transaction((tx) => hedgeDealInTx(tx, deal))).toBe(false);
    expect((await intents(fx)).length).toBe(1);

    const p2 = await marketOrder(fx, "SELL", "0.10");
    const { writeOpenDealInTx } = await import("@/lib/deals");
    const before = (await intents(fx)).length;
    await expect(
      prisma.$transaction(async (tx) => {
        // a second IN deal on p2 (as if a fill wrote it) followed by a failure in the same transaction
        await tx.deal.deleteMany({ where: { positionId: p2.id } });
        await tx.hedgeIntent.deleteMany({ where: { positionId: p2.id } });
        await writeOpenDealInTx(tx, { positionId: p2.id, reason: "CLIENT" });
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect((await intents(fx)).length).toBe(before);
  });
});

describe("B-book regression: no other book ever writes an intent", () => {
  it.each(["B_BOOK", "DEALING", "REVERSAL"] as const)("%s: market order, partial and full close, staff open, reverse, void: zero intents, deals as before", async (category) => {
    if (!dbReachable) return;
    const fx = await fixture(category);
    const p = await marketOrder(fx, "BUY", "1.00");
    await clientClose(fx, p.id, "0.40");
    await clientClose(fx, p.id);
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    expect((await call(POST, "/api/manage/positions", "POST", { accountId: fx.accountId, symbolId: fx.symbolId, side: "SELL", volume: "0.20" })).status).toBe(200);
    const staff = await prisma.position.findFirstOrThrow({ where: { accountId: fx.accountId, status: "OPEN" } });
    const { executeReverseInPlace, executeVoid } = await import("@/lib/position-actions");
    await prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId: fx.brokerId, positionId: staff.id, adminId: fx.adminId }));
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: staff.id, adminId: fx.adminId }));
    expect(await intents(fx)).toEqual([]);
    // the deal model is untouched by the hook: IN, OUT, OUT for the client position
    const deals = await prisma.deal.findMany({ where: { positionId: p.id }, orderBy: { ticket: "asc" } });
    expect(deals.map((d) => [d.entry, d.volume.toString()])).toEqual([
      ["IN", "1"],
      ["OUT", "0.4"],
      ["OUT", "0.6"],
    ]);
  });

  it("a COVERAGE leg (bookType A_BOOK, the broker's own cover) writes no intent", async () => {
    if (!dbReachable) return;
    const fx = await fixture("COVERAGE");
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    await call(POST, "/api/manage/positions", "POST", { accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", volume: "0.10" });
    const { writeOpenDealInTx } = await import("@/lib/deals");
    const order = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D("0.1"), requestedPrice: D("100"), idempotencyKey: `hg:${randomUUID()}`, status: "FILLED", filledPrice: D("100"), filledAt: new Date() } });
    const leg = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D("0.1"), openPrice: D("100"), bookType: "A_BOOK" } });
    await prisma.$transaction((tx) => writeOpenDealInTx(tx, { positionId: leg.id, reason: "COVERAGE" }));
    expect(await intents(fx)).toEqual([]);
  });
});
