import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma, type RoutingCategory } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 3 (owner decisions 2026-09-26): effective max slippage = the smaller of trader and broker; auto-hedge
// for DEALING DESK groups only; admin close publishes BalanceChanged; history route limit; /me + /symbols side rules.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import { effectiveMaxSlippagePips } from "@/lib/risk";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch3.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => vi.mocked(publishTradingEvent).mockClear());
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
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

async function world(opts: { brokerCapPips?: string | null; category?: RoutingCategory; autoHedge?: boolean; tradingRestriction?: "BOTH" | "BUY_ONLY" | "SELL_ONLY"; tradingMode?: "BOTH" | "BUY_ONLY" | "SELL_ONLY" } = {}) {
  const b = await prisma.broker.create({
    data: {
      name: `P2B3 ${randomUUID().slice(0, 8)}`, subdomain: `p2b3-${randomUUID().slice(0, 8)}`,
      defaultMaxSlippagePips: opts.brokerCapPips != null ? D(opts.brokerCapPips) : null,
      dealingDeskAutoFillAt: new Date(), // desk off: every category fills (this file is not about routing)
      autoHedgeAt: opts.autoHedge ? new Date() : null,
    },
  });
  brokers.push(b.id);
  const name = `SL${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbols.push(name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: opts.tradingMode ?? "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: opts.category ?? "B_BOOK", tradingRestriction: opts.tradingRestriction ?? "BOTH" } });
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `sl-${n}@test.local`, passwordHash: "x", fullName: "SL", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  return { brokerId: b.id, groupId: g.id, symbolId: s.id, symbolName: name, accountId: acc.id };
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
async function buy(w: { symbolName: string }, clientPrice: string, maxSlippagePips?: string) {
  const { POST } = await import("@/app/api/trade/orders/route");
  const res = await POST(req("/api/trade/orders", "POST", { symbol: w.symbolName, side: "BUY", type: "MARKET", volume: "1", price: clientPrice, idempotencyKey: randomUUID(), ...(maxSlippagePips ? { maxSlippagePips } : {}) }));
  return { status: res.status, json: await res.json() };
}

describe("slippage: effective max = the smaller of the trader's value and the broker's cap", () => {
  it.each([
    ["5", "3", "3"], // trader tighter
    ["5", "10", "5"], // broker caps a wider trader value
    ["5", "unlimited", "5"], // "unlimited" = the broker's cap
    ["5", null, "5"], // nothing sent = the broker's cap
    [null, "10", "10"], // no broker cap: the trader's value
    [null, "unlimited", null], // neither: no limit
    [null, null, null],
  ] as const)("broker cap %s, trader %s -> %s", (cap, trader, expected) => {
    expect(effectiveMaxSlippagePips(trader, cap != null ? D(cap) : null)).toBe(expected);
  });

  it("market open: a trader's 'unlimited' no longer escapes the broker's cap", async () => {
    if (!dbReachable) return;
    const w = await world({ brokerCapPips: "5" }); // 5 pips = 0.50 on 2 digits
    // the client saw 99.00; the server fills at 100.10: 1.10 away
    expect((await buy(w, "99.00", "unlimited")).json.error).toBe("SLIPPAGE_EXCEEDED");
    expect((await buy(w, "99.80", "unlimited")).status).toBe(201); // 0.30 away: inside the cap
    expect((await buy(w, "99.80", "2")).json.error).toBe("SLIPPAGE_EXCEEDED"); // the trader's tighter 0.20 wins
  });

  it("client close: the same rule (the terminal now sends its value on closes too)", async () => {
    if (!dbReachable) return;
    const w = await world({ brokerCapPips: "5" });
    const opened = await buy(w, "100.10");
    const id = opened.json.position.id as string;
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const close = (closePrice: string, maxSlippagePips?: string) =>
      POST(req(`/api/trade/positions/${id}/close`, "POST", { closePrice, ...(maxSlippagePips ? { maxSlippagePips } : {}) }), { params: Promise.resolve({ id }) });
    const refused = await close("101.00", "unlimited"); // server closes at bid 100.00: 1.00 away > 0.50 cap
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("SLIPPAGE_EXCEEDED");
    expect((await close("100.20")).status).toBe(200); // 0.20 away
  });
});

describe("auto-hedge: DEALING DESK groups only", () => {
  it.each([
    ["DEALING", true],
    ["B_BOOK", false],
    ["REVERSAL", false],
  ] as const)("%s fill hedged automatically: %s", async (category, hedged) => {
    if (!dbReachable) return;
    const w = await world({ category, autoHedge: true });
    const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `ah:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    const pos = await prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), bookType: "B_BOOK" } });
    const coverage = await import("@/lib/coverage");
    await coverage.onFillAutoHedge(prisma, { positionId: pos.id, brokerId: w.brokerId });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).covered).toBe(hedged);
  });
});

describe("live events + history", () => {
  it("an admin close publishes BalanceChanged for the client (was PositionClosed only)", async () => {
    if (!dbReachable) return;
    const w = await world();
    const opened = await buy(w, "100.10");
    const admin = await prisma.adminUser.create({ data: { brokerId: w.brokerId, email: `p2b3-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: w.brokerId } as never);
    vi.mocked(publishTradingEvent).mockClear();
    const { POST } = await import("@/app/api/manage/positions/[id]/close/route");
    const id = opened.json.position.id as string;
    const res = await POST(req(`/api/manage/positions/${id}/close`, "POST", {}), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200);
    expect(publishTradingEvent).toHaveBeenCalledWith("BalanceChanged", expect.objectContaining({ account_id: w.accountId, broker_id: w.brokerId }));
  });

  it("history: newest first, 1000 by default, `limit` honoured", async () => {
    if (!dbReachable) return;
    const w = await world();
    for (let i = 0; i < 3; i++) {
      const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `h:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
      await prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "CLOSED", closePrice: D(101), closedAt: new Date(Date.now() - i * 60_000), realizedPnl: D(1) } });
    }
    const { GET } = await import("@/app/api/trade/history/route");
    const all = await (await GET(req("/api/trade/history", "GET"))).json();
    expect(all).toHaveLength(3);
    const two = await (await GET(req("/api/trade/history?limit=2", "GET"))).json();
    expect(two).toHaveLength(2);
    expect(new Date(two[0].closedAt).getTime()).toBeGreaterThan(new Date(two[1].closedAt).getTime());
  });

  it("/me sends the group's trading restriction and /symbols each symbol's trading mode", async () => {
    if (!dbReachable) return;
    const w = await world({ tradingRestriction: "SELL_ONLY", tradingMode: "BUY_ONLY" });
    const me = await import("@/app/api/trade/me/route");
    expect((await (await (me.GET as unknown as () => Promise<Response>)()).json()).tradingRestriction).toBe("SELL_ONLY");
    const sym = await import("@/app/api/trade/symbols/route");
    const list = (await (await (sym.GET as unknown as () => Promise<Response>)()).json()).symbols as { name: string; tradingMode: string }[];
    expect(list.find((s) => s.name === w.symbolName)?.tradingMode).toBe("BUY_ONLY");
  });
});
