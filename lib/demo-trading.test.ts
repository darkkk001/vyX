import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanDemoRedis, createOtherBroker, D, seedDemoTenant } from "@/lib/demo-test-fixtures";
import { createGuestAccount, markDemoWork, readDemoState, writeDemoState } from "@/lib/demo";
import { demoSessionHook } from "@/lib/demo-hook";
import { sweepAllGuests } from "@/lib/demo-sweep";
import { DEMO_GRID_MS, demoQuoteAt } from "@/lib/demo-prices";
import { publishAlertConfig, publishTradingEvent } from "@/lib/nats";

// The demo's trading path end to end against a real Postgres: an order and a close filled at the SERVER's deterministic price,
// a stale screen refused, nothing reaching the gateway / engine / dealers, and the lazy replay (SL, TP, stop-out, pending) written
// through the real close writer at the time and price the path crossed the level.
const session = vi.hoisted(() => {
  process.env.GATEWAY_URL = "http://gateway.test";
  process.env.INTERNAL_SERVICE_SECRET = "test-secret";
  process.env.CRON_SECRET = "cron-test-secret";
  return { current: { accountId: "", brokerId: "" } };
});
vi.mock("@/lib/account-auth", async (orig) => ({ ...(await orig<typeof import("@/lib/account-auth")>()), getAccountSession: async () => session.current }));
const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
vi.stubGlobal("fetch", fetchSpy);

const G = DEMO_GRID_MS;
let demo: Awaited<ReturnType<typeof seedDemoTenant>>;
let other: Awaited<ReturnType<typeof createOtherBroker>>;

beforeAll(async () => {
  demo = await seedDemoTenant();
  other = await createOtherBroker();
}, 120_000);
afterAll(async () => {
  await cleanDemoRedis();
  delete process.env.DEMO_BROKER_SUBDOMAIN;
});
beforeEach(() => fetchSpy.mockClear());

const gatewayCalls = () => fetchSpy.mock.calls.filter((c) => String(c[0]).includes("gateway.test"));

async function newGuest(balance?: number) {
  const g = (await createGuestAccount())!;
  if (balance != null) await prisma.account.update({ where: { id: g.id }, data: { balance: D(balance) } });
  return g;
}
const ticksBetween = (a: number, b: number) => Array.from({ length: Math.floor((b - a) / G) + 1 }, (_, i) => Math.ceil(a / G) * G + i * G).filter((t) => t >= a && t <= b);

async function openPositionAt(guest: { id: string }, p: { symbol: string; side: "BUY" | "SELL"; volume: string; openedMs: number; sl?: string; tp?: string }) {
  const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: p.symbol } });
  const q = demoQuoteAt(p.symbol, p.openedMs)!;
  const open = p.side === "BUY" ? q.ask : q.bid;
  const order = await prisma.order.create({
    data: { brokerId: demo.broker.id, accountId: guest.id, symbolId: sym.id, side: p.side, type: "MARKET", volume: D(p.volume), requestedPrice: D(open), idempotencyKey: `t:${randomUUID()}`, status: "FILLED", filledPrice: D(open), filledAt: new Date(p.openedMs), createdAt: new Date(p.openedMs) },
  });
  const position = await prisma.position.create({
    data: { brokerId: demo.broker.id, accountId: guest.id, symbolId: sym.id, originOrderId: order.id, side: p.side, volume: D(p.volume), openPrice: D(open), slPrice: p.sl ? D(p.sl) : null, tpPrice: p.tp ? D(p.tp) : null, openedAt: new Date(p.openedMs), bookType: "B_BOOK" },
  });
  await writeDemoState(guest.id, { t: 0, w: 1 });
  return { position, open: D(open) };
}

async function placeOrder(accountId: string, brokerId: string, body: Record<string, unknown>) {
  session.current = { accountId, brokerId };
  const { POST } = await import("@/app/api/trade/orders/route");
  const res = await POST(new NextRequest("https://demo.test/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: res.status, json: await res.json() };
}
async function closeVia(accountId: string, brokerId: string, positionId: string, body: Record<string, unknown>) {
  session.current = { accountId, brokerId };
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const res = await POST(new NextRequest(`https://demo.test/api/trade/positions/${positionId}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: positionId }) });
  return { status: res.status, json: await res.json() };
}
const marketBody = (over: Record<string, unknown> = {}) => ({ symbol: "qXAUUSD", side: "BUY", type: "MARKET", volume: 0.1, price: demoQuoteAt("qXAUUSD", Date.now())!.ask, idempotencyKey: randomUUID(), priceAt: Date.now(), maxSlippagePips: "unlimited", ...over });

describe("an order and a close are filled at the server's price", () => {
  it("a market BUY fills at the deterministic ask of the server's own clock, on the B-book, and publishes nothing", async () => {
    const g = await newGuest();
    const t0 = Date.now();
    const res = await placeOrder(g.id, demo.broker.id, marketBody());
    const t1 = Date.now();
    expect(res.status).toBe(201);
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: g.id } });
    expect(pos.bookType).toBe("B_BOOK");
    expect(pos.groupCategoryAtOpen).toBe("B_BOOK");
    // the fill is the ask at SOME millisecond of the request: recomputed from the shared function, not the client's number
    const asks = new Set<string>();
    for (let t = t0 - 5; t <= t1 + 5; t++) asks.add(demoQuoteAt("qXAUUSD", t)!.ask);
    expect(asks.has(pos.openPrice.toFixed(2))).toBe(true);
    expect(res.json.order.status).toBe("FILLED");
    // isolation: no gateway call, no outbox row, no notification, no dealer queue, no mirror link
    expect(gatewayCalls()).toHaveLength(0);
    expect(await prisma.postCloseEffect.count({ where: { brokerId: demo.broker.id } })).toBe(0);
    expect(await prisma.notification.count({ where: { brokerId: demo.broker.id } })).toBe(0);
    expect(await prisma.mirrorLink.count()).toBe(0);
    // the next request replays this account
    expect((await readDemoState(g.id))?.w).toBe(1);
  });

  it("the client's own price is only a reference: a wrong one cannot change the fill", async () => {
    const g = await newGuest();
    const res = await placeOrder(g.id, demo.broker.id, marketBody({ price: demoQuoteAt("qXAUUSD", Date.now())!.ask }));
    expect(res.status).toBe(201);
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: g.id } });
    const live = Number(demoQuoteAt("qXAUUSD", Date.now())!.ask);
    expect(Math.abs(Number(pos.openPrice) - live)).toBeLessThan(5); // the server's price (moves ~$0.1 per tick)
  });

  it("a screen older than 3 seconds, from the future, or without a time is refused: 'Price changed, try again'", async () => {
    const g = await newGuest();
    for (const priceAt of [Date.now() - 5000, Date.now() + 10_000, undefined, "garbage"]) {
      const res = await placeOrder(g.id, demo.broker.id, marketBody({ priceAt }));
      expect(res.status).toBe(400);
      expect(res.json.error).toBe("PRICE_CHANGED");
      expect(res.json.reason).toBe("Price changed, try again");
    }
    expect(await prisma.order.count({ where: { accountId: g.id } })).toBe(0);
    // just inside the window is fine
    expect((await placeOrder(g.id, demo.broker.id, marketBody({ priceAt: Date.now() - 2500 }))).status).toBe(201);
  });

  it("a close fills at the server's bid, writes the structured close fields, and publishes nothing", async () => {
    const g = await newGuest();
    const opened = await placeOrder(g.id, demo.broker.id, marketBody({ volume: 0.2 }));
    expect(opened.status).toBe(201);
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: g.id } });
    fetchSpy.mockClear();
    const t0 = Date.now();
    const res = await closeVia(g.id, demo.broker.id, pos.id, { closePrice: demoQuoteAt("qXAUUSD", Date.now())!.bid, priceAt: Date.now(), maxSlippagePips: "unlimited" });
    const t1 = Date.now();
    expect(res.status).toBe(200);
    const closed = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(closed.status).toBe("CLOSED");
    const bids = new Set<string>();
    for (let t = t0 - 5; t <= t1 + 5; t++) bids.add(demoQuoteAt("qXAUUSD", t)!.bid);
    expect(bids.has(closed.closePrice!.toFixed(2))).toBe(true);
    const txn = await prisma.transaction.findFirstOrThrow({ where: { accountId: g.id, type: "TRADE_PNL" } });
    expect(txn.closeVolume?.equals(D("0.2"))).toBe(true);
    expect(txn.closePrice?.equals(closed.closePrice!)).toBe(true);
    expect(txn.closeSwap?.equals(D(0))).toBe(true);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await prisma.postCloseEffect.count({ where: { brokerId: demo.broker.id } })).toBe(0);
  });

  it("a close from a stale screen is refused and the position stays open", async () => {
    const g = await newGuest();
    await placeOrder(g.id, demo.broker.id, marketBody());
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: g.id } });
    const res = await closeVia(g.id, demo.broker.id, pos.id, { closePrice: "4440", priceAt: Date.now() - 9000, maxSlippagePips: "unlimited" });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("PRICE_CHANGED");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
  });

  it("a pending order rests as PENDING and never reaches a dealer", async () => {
    const g = await newGuest();
    const ask = Number(demoQuoteAt("qXAUUSD", Date.now())!.ask);
    const res = await placeOrder(g.id, demo.broker.id, marketBody({ type: "LIMIT", price: (ask - 20).toFixed(2) }));
    expect(res.status).toBe(201);
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: g.id } });
    expect(o.status).toBe("PENDING");
    expect(o.type).toBe("LIMIT");
    expect(gatewayCalls()).toHaveLength(0);
  });

  it("the demo broker books B-book only: a demo group that routes elsewhere refuses the order", async () => {
    const g = await newGuest();
    await prisma.group.update({ where: { id: demo.group.id }, data: { category: "A_BOOK" } });
    const res = await placeOrder(g.id, demo.broker.id, marketBody());
    await prisma.group.update({ where: { id: demo.group.id }, data: { category: "B_BOOK" } });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe("DEMO_B_BOOK_ONLY");
    expect(await prisma.order.count({ where: { accountId: g.id } })).toBe(0);
  });

  it("control: an ordinary broker's order DOES publish to the gateway (so the checks above would catch a leak)", async () => {
    session.current = { accountId: other.account.id, brokerId: other.broker.id };
    const { POST } = await import("@/app/api/trade/orders/route");
    const res = await POST(
      new NextRequest("https://x.test/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: other.symbol.name, side: "BUY", type: "MARKET", volume: 0.1, price: "100.10", idempotencyKey: randomUUID() }) })
    );
    expect(res.status).toBe(201);
    expect(gatewayCalls().length).toBeGreaterThan(0);
  });

  it("no event of the demo broker ever leaves, whatever sends it", async () => {
    fetchSpy.mockClear();
    await publishTradingEvent("OrderFilled", { broker_id: demo.broker.id, account_id: "x", order_id: "y" });
    await publishAlertConfig({ action: "cancel", id: "a", broker_id: demo.broker.id });
    expect(gatewayCalls()).toHaveLength(0);
    await publishTradingEvent("OrderFilled", { broker_id: other.broker.id, account_id: "x", order_id: "y" });
    expect(gatewayCalls()).toHaveLength(1);
  });
});

describe("the lazy replay, through the real database", () => {
  const hook = (g: { id: string }) => demoSessionHook({ accountId: g.id, brokerId: demo.broker.id });

  it("a stop loss touched while nobody looked is closed at the tick that crossed it, at that tick's bid, booked at that time", async () => {
    const g = await newGuest();
    const now = Date.now();
    const openedMs = now - 6 * 3600_000;
    const q = demoQuoteAt("qXAUUSD", openedMs)!;
    const ticks = ticksBetween(openedMs + G, now - 5000);
    const minBid = Math.min(...ticks.map((t) => Number(demoQuoteAt("qXAUUSD", t)!.bid)));
    const open = Number(q.ask);
    expect(minBid).toBeLessThan(open); // the path dips below the entry in this window
    const sl = (open - (open - minBid) * 0.5).toFixed(2);
    const crossing = ticks.find((t) => Number(demoQuoteAt("qXAUUSD", t)!.bid) <= Number(sl))!;
    const { position } = await openPositionAt(g, { symbol: "qXAUUSD", side: "BUY", volume: "0.10", openedMs, sl });

    expect(await hook(g)).toBe(true);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt!.getTime()).toBe(crossing);
    expect(after.closePrice!.toFixed(2)).toBe(demoQuoteAt("qXAUUSD", crossing)!.bid);
    const txn = await prisma.transaction.findFirstOrThrow({ where: { accountId: g.id, type: "TRADE_PNL" } });
    expect(txn.createdAt.getTime()).toBe(crossing);
    expect(txn.note).toBe("Stop loss hit (demo)");
    expect(txn.note).not.toMatch(/^(Stop loss hit|Take profit hit|Stop-out) \(automatic\)/); // the engine's reconciler must never see a demo close
    expect(txn.closeVolume?.equals(D("0.10"))).toBe(true);
    expect(txn.closePrice?.equals(after.closePrice!)).toBe(true);
    expect(txn.closeSwap?.equals(D(0))).toBe(true);
    const pnl = after.closePrice!.sub(position.openPrice).mul(100).mul(D("0.10"));
    expect(txn.amount.equals(pnl)).toBe(true);
    const acct = await prisma.account.findUniqueOrThrow({ where: { id: g.id } });
    expect(acct.balance.equals(D(10000).add(pnl))).toBe(true);
    expect((await readDemoState(g.id))?.w).toBe(0); // nothing left to replay
    expect(gatewayCalls()).toHaveLength(0);

    // run again: nothing new is written
    const txnCount = await prisma.transaction.count({ where: { accountId: g.id } });
    await hook(g);
    await sweepAllGuests();
    expect(await prisma.transaction.count({ where: { accountId: g.id } })).toBe(txnCount);
  }, 60_000);

  it("a take profit on a SELL closes at the ask of the crossing tick", async () => {
    const g = await newGuest();
    const now = Date.now();
    // a start from which the ask later falls below the entry bid (the path has to move the right way)
    let openedMs = now - 5 * 3600_000;
    for (let h = 5; h < 60; h++) {
      const start = now - h * 3600_000;
      const o = Number(demoQuoteAt("qEURUSD", start)!.bid);
      const lows = ticksBetween(start + G, Math.min(start + 5 * 3600_000, now - 5000)).map((t) => Number(demoQuoteAt("qEURUSD", t)!.ask));
      if (Math.min(...lows) < o - 0.0004) { openedMs = start; break; }
    }
    const open = Number(demoQuoteAt("qEURUSD", openedMs)!.bid);
    const ticks = ticksBetween(openedMs + G, Math.min(openedMs + 5 * 3600_000, now - 5000));
    const minAsk = Math.min(...ticks.map((t) => Number(demoQuoteAt("qEURUSD", t)!.ask)));
    expect(minAsk).toBeLessThan(open);
    const tp = (open - (open - minAsk) * 0.5).toFixed(5);
    const crossing = ticks.find((t) => Number(demoQuoteAt("qEURUSD", t)!.ask) <= Number(tp))!;
    const { position } = await openPositionAt(g, { symbol: "qEURUSD", side: "SELL", volume: "0.50", openedMs, tp });
    await hook(g);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt!.getTime()).toBe(crossing);
    expect(after.closePrice!.toFixed(5)).toBe(demoQuoteAt("qEURUSD", crossing)!.ask);
    expect((await prisma.transaction.findFirstOrThrow({ where: { accountId: g.id, type: "TRADE_PNL" } })).note).toBe("Take profit hit (demo)");
  }, 60_000);

  it("a stop-out closes the position when the margin level reaches the group's stop-out level", async () => {
    const now = Date.now();
    // find a start where a 1-lot gold BUY on 3,000 loses enough within 6 hours to cross 50% (equity 2,220 on 4,4xx margin)
    let openedMs = 0;
    let crossing = 0;
    for (let h = 7; h < 70 && !crossing; h += 1) {
      const start = now - h * 3600_000;
      const open = Number(demoQuoteAt("qXAUUSD", start)!.ask);
      for (const t of ticksBetween(start + G, Math.min(start + 6 * 3600_000, now - 5000))) {
        const bid = Number(demoQuoteAt("qXAUUSD", t)!.bid);
        const equity = 3000 + (bid - open) * 100;
        if ((equity / bid) * 100 <= 50) {
          openedMs = start;
          crossing = t;
          break;
        }
      }
    }
    expect(crossing).toBeGreaterThan(0);
    const g = await newGuest(3000);
    const { position } = await openPositionAt(g, { symbol: "qXAUUSD", side: "BUY", volume: "1.00", openedMs });
    await hook(g);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect(after.status).toBe("CLOSED");
    expect(after.closedAt!.getTime()).toBe(crossing);
    const txn = await prisma.transaction.findFirstOrThrow({ where: { accountId: g.id, type: "TRADE_PNL" } });
    expect(txn.note).toMatch(/^Stop-out \(demo\): margin level \d+\.\d\d% at or below 50%$/);
    expect(txn.createdAt.getTime()).toBe(crossing);
  }, 120_000);

  it("a resting order reached in the past fills at that tick's price and time, then works like any position", async () => {
    const g = await newGuest();
    const now = Date.now();
    const createdMs = now - 4 * 3600_000;
    const ask0 = Number(demoQuoteAt("qXAUUSD", createdMs)!.ask);
    const ticks = ticksBetween(createdMs + G, now - 5000);
    const minAsk = Math.min(...ticks.map((t) => Number(demoQuoteAt("qXAUUSD", t)!.ask)));
    expect(minAsk).toBeLessThan(ask0);
    const entry = (ask0 - (ask0 - minAsk) * 0.5).toFixed(2);
    const fillTick = ticks.find((t) => Number(demoQuoteAt("qXAUUSD", t)!.ask) <= Number(entry))!;
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const order = await prisma.order.create({
      data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, side: "BUY", type: "LIMIT", volume: D("0.10"), requestedPrice: D(entry), idempotencyKey: `t:${randomUUID()}`, status: "PENDING", createdAt: new Date(createdMs) },
    });
    await writeDemoState(g.id, { t: 0, w: 1 });
    await hook(g);
    const filled = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(filled.status).toBe("FILLED");
    expect(filled.filledAt!.getTime()).toBe(fillTick);
    expect(filled.filledPrice!.toFixed(2)).toBe(demoQuoteAt("qXAUUSD", fillTick)!.ask);
    const pos = await prisma.position.findFirstOrThrow({ where: { originOrderId: order.id } });
    expect(pos.openedAt.getTime()).toBe(fillTick);
    expect(pos.bookType).toBe("B_BOOK");
    expect(await prisma.postCloseEffect.count({ where: { accountId: g.id } })).toBe(0);
  }, 60_000);

  it("two positions closed in the same replay are booked in the order the path touched them", async () => {
    const g = await newGuest(100_000);
    const now = Date.now();
    const openedMs = now - 6 * 3600_000;
    const mk = (symbol: string, side: "BUY" | "SELL") => {
      const q0 = demoQuoteAt(symbol, openedMs)!;
      const open = Number(side === "BUY" ? q0.ask : q0.bid);
      const ticks = ticksBetween(openedMs + G, now - 5000);
      const extreme = side === "BUY" ? Math.min(...ticks.map((t) => Number(demoQuoteAt(symbol, t)!.bid))) : Math.max(...ticks.map((t) => Number(demoQuoteAt(symbol, t)!.ask)));
      const digits = symbol === "qBTCUSD" ? 1 : 2;
      const level = Number((open + (extreme - open) * 0.6).toFixed(digits)); // the level as it is stored
      const hit = ticks.find((t) => (side === "BUY" ? Number(demoQuoteAt(symbol, t)!.bid) <= level : Number(demoQuoteAt(symbol, t)!.ask) >= level))!;
      return { symbol, side, sl: level.toFixed(digits), hit };
    };
    const a = mk("qXAUUSD", "BUY");
    const b = mk("qBTCUSD", "SELL");
    const pa = await openPositionAt(g, { symbol: a.symbol, side: a.side, volume: "0.05", openedMs, sl: a.sl });
    const pb = await openPositionAt(g, { symbol: b.symbol, side: b.side, volume: "0.05", openedMs, sl: b.sl });
    await hook(g);
    const txns = await prisma.transaction.findMany({ where: { accountId: g.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    expect(txns).toHaveLength(2);
    expect(txns.map((t) => t.referenceId)).toEqual(a.hit <= b.hit ? [pa.position.id, pb.position.id] : [pb.position.id, pa.position.id]);
    // each one booked at its own moment
    expect(new Set(txns.map((t) => t.createdAt.getTime()))).toEqual(new Set([a.hit, b.hit]));
  }, 60_000);

  it("a guest that no longer exists has no session", async () => {
    const g = await newGuest();
    await prisma.transaction.deleteMany({ where: { accountId: g.id } });
    await prisma.auditLog.deleteMany({ where: { entityId: g.id } });
    await prisma.loginEvent.deleteMany({ where: { accountId: g.id } });
    await prisma.account.delete({ where: { id: g.id } });
    await getRedisDel(g.id);
    expect(await hook(g)).toBe(false);
  });

  it("an ordinary tenant is not touched by the hook at all", async () => {
    expect(await demoSessionHook({ accountId: other.account.id, brokerId: other.broker.id })).toBe(true);
    expect(await readDemoState(other.account.id)).toBeNull();
  });

  it("markDemoWork flags an account for the next replay", async () => {
    const g = await newGuest();
    await markDemoWork(g.id);
    expect((await readDemoState(g.id))?.w).toBe(1);
  });
});

async function getRedisDel(accountId: string) {
  const { clearDemoState } = await import("@/lib/demo");
  await clearDemoState(accountId);
}
