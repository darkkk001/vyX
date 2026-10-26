import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type RoutingCategory, type SlippageAction } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Slippage cap (owner 2026-10-26, approved): only a fill WORSE than the client's price counts; the broker's base is
// XAUUSD 30 points and every other symbol gets the same fraction of its price unless it has its own cap; over the cap
// = requote at the live price (default) or reject; on the direct fill, the Smart Dealer, a dealer accept at market and
// a close alike.
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
import { adverseSlippagePoints, effectiveCapPoints, slippageVerdict, symbolSlippageCapPoints } from "@/lib/slippage-cap";

const D = (v: string | number) => new Prisma.Decimal(v);

describe("the cap per symbol", () => {
  const broker = { slippageCapXauPoints: D(30), slippageCapRefPrice: D(4020) };
  it("XAUUSD is the base itself; the others take the same fraction of their own price (design table)", () => {
    const cap = (name: string, digits: number, price: string) => symbolSlippageCapPoints(broker, { name, digits }, D(price))?.toString();
    expect(cap("XAUUSD", 2, "4100")).toBe("30");
    expect(cap("EURUSD", 5, "1.08")).toBe("8");
    expect(cap("GBPUSD", 5, "1.30")).toBe("10");
    expect(cap("USDJPY", 3, "150")).toBe("11");
    expect(cap("XAGUSD", 3, "48")).toBe("4");
    expect(cap("US30", 2, "45000")).toBe("336");
    expect(cap("BTCUSD", 2, "100000")).toBe("746");
    expect(cap("CHEAP", 2, "1")).toBe("1"); // never below one point
  });
  it("a symbol's own cap wins; no base = no cap", () => {
    expect(symbolSlippageCapPoints(broker, { name: "EURUSD", digits: 5, maxSlippagePoints: D(25) }, D("1.08"))?.toString()).toBe("25");
    expect(symbolSlippageCapPoints({ slippageCapXauPoints: null, slippageCapRefPrice: D(4020) }, { name: "XAUUSD", digits: 2 }, D("4000"))).toBeNull();
  });
  it("only slippage against the client counts", () => {
    expect(adverseSlippagePoints("BUY", "4021.48", D("4022.01"), 2).toString()).toBe("53"); // #100004275
    expect(adverseSlippagePoints("BUY", "4021.48", D("4021.00"), 2).toString()).toBe("0"); // better: bought lower
    expect(adverseSlippagePoints("SELL", "4021.48", D("4021.00"), 2).toString()).toBe("48"); // sold lower: worse
    expect(adverseSlippagePoints("SELL", "4021.48", D("4022.00"), 2).toString()).toBe("0");
  });
  it("the trader's own SLIPPAGE MAX only tightens", () => {
    expect(effectiveCapPoints("10", D(30))?.toString()).toBe("10");
    expect(effectiveCapPoints("50", D(30))?.toString()).toBe("30");
    expect(effectiveCapPoints("unlimited", D(30))?.toString()).toBe("30");
    expect(effectiveCapPoints(null, null)).toBeNull();
    expect(slippageVerdict({ side: "BUY", requested: "4021.48", fill: D("4022.01"), digits: 2, capPoints: D(30) })).toMatchObject({ over: true });
    expect(slippageVerdict({ side: "BUY", requested: "4021.48", fill: D("4021.70"), digits: 2, capPoints: D(30) })).toEqual({ over: false });
  });
});

// ---- the four fill paths, live DB (scratch), every row removed afterwards ----
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("slippage-cap.test.ts: DB unreachable, skipping the DB cases");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.rejectedOrder.deleteMany({ where }).catch(() => {});
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

// a symbol at bid 100.00 / ask 100.10 (2 digits) with its own cap of 30 points (0.30), no markup
async function world(opts: { category?: RoutingCategory; action?: SlippageAction; smartAcceptPct?: string } = {}) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({
    data: {
      name: `Slip ${sfx}`, subdomain: `slip-${sfx}`, dealingModeAt: null, dealingDeskAutoFillAt: opts.category === "DEALING" ? null : new Date(),
      slippageAction: opts.action ?? "REQUOTE", ...(opts.smartAcceptPct ? { smartDealerAcceptPct: D(opts.smartAcceptPct) } : {}),
    },
  });
  brokers.push(b.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `sl-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `SC${sfx.toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true, tradingMode: "BOTH", maxSlippagePoints: D(30) } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `SC-${sfx}`, leverage: 100, category: opts.category ?? "B_BOOK", dealingMode: opts.category === "DEALING" ? "MANUAL" : "AUTO" } });
  const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "4")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `sc-${n}@test.local`, passwordHash: "x", fullName: "SC", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
  return { brokerId: b.id, accountId: acc.id, symbolName: name };
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function order(w: { symbolName: string }, side: "BUY" | "SELL", price: string) {
  const { POST } = await import("@/app/api/trade/orders/route");
  const res = await POST(req("/api/trade/orders", "POST", { symbol: w.symbolName, side, type: "MARKET", volume: "1", price, maxSlippagePips: "unlimited", idempotencyKey: randomUUID() }));
  return { status: res.status, json: await res.json() };
}

describe("direct fill", () => {
  it("inside the cap or better fills; over it is requoted at the live price, nothing opened", async () => {
    if (!dbReachable) return;
    const w = await world();
    expect((await order(w, "BUY", "99.90")).json.position).toBeDefined(); // 20 points against: inside
    expect((await order(w, "BUY", "100.50")).json.position).toBeDefined(); // the fill is 40 points BETTER: always fills
    const over = await order(w, "BUY", "99.70"); // 40 points against
    expect(over.status).toBe(201);
    expect(over.json.order).toMatchObject({ status: "REQUOTED" });
    expect(String(over.json.order.requotedPrice)).toBe("100.1");
    expect(await prisma.position.count({ where: { accountId: w.accountId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { brokerId: w.brokerId, action: "ORDER_SLIPPAGE_REQUOTED" } })).toBe(1);
    const sell = await order(w, "SELL", "100.40"); // sells at bid 100.00: 40 points against
    expect(sell.json.order).toMatchObject({ status: "REQUOTED" });
  });

  it("REJECT: over the cap is refused (Invalid price) and nothing is written", async () => {
    if (!dbReachable) return;
    const w = await world({ action: "REJECT" });
    const over = await order(w, "BUY", "99.70");
    expect(over.status).toBe(400);
    expect(over.json.clientReason).toBe("INVALID_PRICE");
    expect(await prisma.order.count({ where: { accountId: w.accountId } })).toBe(0);
  });
});

describe("Smart Dealer", () => {
  it("over the cap is never auto-accepted, even inside the accept %", async () => {
    if (!dbReachable) return;
    const w = await world({ category: "DEALING", smartAcceptPct: "5" }); // 5 % would accept 40 points easily
    const over = await order(w, "BUY", "99.70");
    expect(over.json.order).toMatchObject({ status: "REQUOTED" });
    expect(await prisma.position.count({ where: { accountId: w.accountId } })).toBe(0);
    const inside = await order(w, "BUY", "99.90");
    expect(inside.json.position).toBeDefined(); // inside the cap: auto-accepted as before
  });
});

describe("dealer accept", () => {
  async function queued() {
    const w = await world({ category: "DEALING" });
    const placed = await order(w, "BUY", "99.70");
    expect(placed.json.order ?? placed.json, JSON.stringify(placed.json)).toMatchObject({ status: "PENDING" });
    return { w, id: (placed.json.order ?? placed.json).id as string };
  }
  const act = async (id: string, body: unknown) => {
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const res = await PATCH(req(`/api/manage/dealing-queue/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
    return { status: res.status, json: await res.json() };
  };
  it("at market over the cap becomes a requote at the live price; at the client's price it fills", async () => {
    if (!dbReachable) return;
    const a = await queued();
    const market = await act(a.id, { action: "ACCEPT", fillMode: "MARKET" });
    expect(market.json).toMatchObject({ status: "REQUOTED", reason: "SLIPPAGE_CAP", requotedPrice: "100.1" });
    expect(await prisma.position.count({ where: { accountId: a.w.accountId } })).toBe(0);
    const b = await queued();
    const requested = await act(b.id, { action: "ACCEPT" });
    expect(requested.status, JSON.stringify(requested.json)).toBe(200);
    expect(await prisma.position.count({ where: { accountId: b.w.accountId } })).toBe(1);
  });
});

describe("close", () => {
  it("a close worse than the client's price by more than the cap is refused; better always closes", async () => {
    if (!dbReachable) return;
    const w = await world();
    const opened = await order(w, "BUY", "100.10");
    const id = opened.json.position.id as string;
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const close = async (closePrice: string) => (await POST(req(`/api/trade/positions/${id}/close`, "POST", { closePrice }), { params: Promise.resolve({ id }) })).status;
    expect(await close("100.40")).toBe(400); // sells at bid 100.00: 40 points against
    expect(await close("99.70")).toBe(200); // 30 points BETTER for the client
  });
});

describe("the backoffice reads the effective cap from the server (no app computes it)", () => {
  it("GET /api/manage/symbols: the symbol's own cap, or the one derived from the broker base at the live price", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { GET } = await import("@/app/api/manage/symbols/route");
    const row = async () => ((await (await GET()).json()) as { symbolName: string; effectiveMaxSlippagePoints: string | null; slippageCapSource: string }[]).find((r) => r.symbolName === w.symbolName)!;
    expect(await row()).toMatchObject({ effectiveMaxSlippagePoints: "30", slippageCapSource: "symbol" });
    await prisma.brokerSymbol.updateMany({ where: { brokerId: w.brokerId }, data: { maxSlippagePoints: null } });
    // base 30 at gold 4000 is 0.0075 % of the price: 0.0075 points at 100.10, so the floor of one point
    expect(await row()).toMatchObject({ effectiveMaxSlippagePoints: "1", slippageCapSource: "derived" });
    await prisma.broker.update({ where: { id: w.brokerId }, data: { slippageCapXauPoints: null } });
    expect(await row()).toMatchObject({ effectiveMaxSlippagePoints: null, slippageCapSource: "derived" });
  });
});
