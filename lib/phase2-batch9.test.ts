import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 9 (web side), ADVERSARIAL: a pending order placed closer to the market than the symbol's stop level
// used to be accepted at placement (only a later modify was checked); and /api/trade/me now reports the broker's
// trading day / week start for the terminal's DAY / WEEK P/L. Scratch DB, own cleanup.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch9.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function world(stopLevel: number) {
  const b = await prisma.broker.create({ data: { name: `P2B9 ${randomUUID().slice(0, 8)}`, subdomain: `p2b9-${randomUUID().slice(0, 8)}`, dealingDeskAutoFillAt: new Date() } });
  brokers.push(b.id);
  const name = `B9${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbols.push(name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true, stopLevel } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isClientSelectable: true } });
  const n = `9${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "9")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `b9-${n}@test.local`, passwordHash: "x", fullName: "B9", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  return { symbol: name, accountId: acc.id };
}
async function place(symbol: string, type: "LIMIT" | "STOP", side: "BUY" | "SELL", price: string) {
  const { POST } = await import("@/app/api/trade/orders/route");
  const res = await POST(new NextRequest("https://t.local/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol, side, type, volume: "0.1", price, idempotencyKey: randomUUID() }) }));
  return { status: res.status, json: await res.json() };
}

describe("270: a pending entry must respect the stop level at placement", () => {
  it("refuses a BUY LIMIT 5 points under the ask when the stop level is 50 points; accepts one 60 points under", async () => {
    if (!dbReachable) return;
    const w = await world(50); // 50 points x 0.01 = 0.50 away from the market
    const tooClose = await place(w.symbol, "LIMIT", "BUY", "100.05");
    expect(tooClose.status).toBe(400);
    expect(tooClose.json.error).toMatch(/at least 0\.5/);
    expect(await prisma.order.count({ where: { accountId: w.accountId } })).toBe(0);
    const ok = await place(w.symbol, "LIMIT", "BUY", "99.50");
    expect(ok.status).toBe(201);
  });

  it("the SELL side is measured from the bid; stop level 0 means no minimum", async () => {
    if (!dbReachable) return;
    const w = await world(50);
    expect((await place(w.symbol, "STOP", "SELL", "99.80")).status).toBe(400); // 0.20 under the bid
    const free = await world(0);
    expect((await place(free.symbol, "LIMIT", "BUY", "100.09")).status).toBe(201);
  });
});

describe("363: /api/trade/me reports the broker's trading day and week start", () => {
  it("both are ISO instants, the week start is at or before the day start and at most 6 days earlier", async () => {
    if (!dbReachable) return;
    await world(0);
    const { GET } = await import("@/app/api/trade/me/route");
    const res = await (GET as unknown as (r: NextRequest) => Promise<Response>)(new NextRequest("https://t.local/api/trade/me"));
    const j = await res.json();
    expect(res.status).toBe(200);
    const day = new Date(j.tradingDayStart).getTime();
    const week = new Date(j.tradingWeekStart).getTime();
    expect(Number.isNaN(day) || Number.isNaN(week)).toBe(false);
    expect(week).toBeLessThanOrEqual(day);
    expect(day - week).toBeLessThanOrEqual(6 * 86_400_000);
    expect(["d1-candle", "fallback-22utc"]).toContain(j.tradingDaySource);
  });
});
