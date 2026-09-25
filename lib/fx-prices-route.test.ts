import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// FX batch (docs/contracts/fx-and-market-week.md §2) on the local scratch DB: GET /api/trade/prices?fx=1 answers
// { prices, fx } with the conversion quotes (72 h limit applied) and the server's rate per quote currency, and the
// plain route stays the bare array installed clients parse. Made-up currency codes, so no real LivePrice row is touched.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("fx-prices-route.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const livePrices: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: livePrices } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("GET /api/trade/prices?fx=1", () => {
  it("sends the conversion quotes and the server's rates; the plain route stays a bare array", async () => {
    if (!dbReachable) return;
    const sfx = randomUUID().replace(/\D/g, "").slice(0, 1) || "7";
    const [ACC, QB, QC, QD] = [`Q${sfx}A`, `Q${sfx}B`, `Q${sfx}C`, `Q${sfx}D`]; // made-up currencies
    const b = await prisma.broker.create({ data: { name: `FXP ${randomUUID().slice(0, 8)}`, subdomain: `fxp-${randomUUID().slice(0, 8)}` } });
    brokers.push(b.id);
    const g = await prisma.group.create({ data: { brokerId: b.id, name: `FXP-${randomUUID().slice(0, 6)}`, leverage: 100 } });
    const acc = await prisma.account.create({
      data: { groupId: g.id, brokerId: b.id, accountNumber: `3${Date.now().toString().slice(-7)}`, email: `fxp-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "FXP", accountMode: "DEMO", balance: D(1000), currency: ACC },
    });
    const mk = async (quote: string) => {
      const name = `FX${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: quote, category: "FOREX", digits: 5, contractSize: D(100000) } });
      symbols.push(name);
      await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
    };
    await mk(QB); // QB -> ACC through the inverse pair ACC+QB
    await mk(QC); // QC -> ACC crosses through USD: QC+USD and USD+ACC
    await mk(QD); // QD -> ACC: its only quote is 80 h old -> no rate
    await mk(ACC); // same currency: rate 1, no quote
    const lp = async (symbol: string, bid: string, ask: string, ageMs = 1000) => {
      livePrices.push(symbol);
      await prisma.livePrice.upsert({ where: { symbol }, create: { symbol, bid: D(bid), ask: D(ask), tickAt: new Date(Date.now() - ageMs) }, update: { bid: D(bid), ask: D(ask), tickAt: new Date(Date.now() - ageMs) } });
    };
    await lp(ACC + QB, "1.99", "2.01"); // mid 2 -> rate 0.5
    await lp(QC + "USD", "3.99", "4.01"); // mid 4
    await lp("USD" + ACC, "0.249", "0.251"); // mid 0.25 -> QC rate 4 x 0.25 = 1
    await lp(QD + ACC, "5", "5", 80 * 3_600_000); // too old

    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
    const { GET } = await import("@/app/api/trade/prices/route");
    const plain = await (await GET(new Request("https://t.local/api/trade/prices"))).json();
    expect(Array.isArray(plain)).toBe(true);

    const body = await (await GET(new Request("https://t.local/api/trade/prices?fx=1"))).json();
    expect(Array.isArray(body.prices)).toBe(true);
    expect(body.fx.accountCurrency).toBe(ACC);
    const quoted = body.fx.quotes.map((q: { symbol: string }) => q.symbol).sort();
    expect(quoted).toEqual([ACC + QB, QC + "USD", "USD" + ACC].sort()); // the 80 h old quote is not sent
    expect(Number(body.fx.rates[QB])).toBeCloseTo(0.5, 12);
    expect(Number(body.fx.rates[QC])).toBeCloseTo(1, 12);
    expect(body.fx.rates[QD]).toBeUndefined(); // no rate: the client shows "–"
    expect(body.fx.rates[ACC]).toBe("1");
  });
});
