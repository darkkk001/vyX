import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { checkAccountPreTradeMargin, computeAccountMarginSnapshots } from "@/lib/margin";

// Quote-currency conversion in the margin figures (2026-09-23, lib/fx.ts). requiredMarginFor's
// volume x contractSize x price is a QUOTE-currency notional: 1 lot of USDJPY at 150 is 15,000,000 JPY,
// /100 leverage = 150,000 JPY = 1,000 USD. Read as USD it was 150x too high, so a USD account could not
// open a lot it can easily afford, and a JPY position's floating P&L moved equity by yen-as-dollars.
//
// These read through the global client (committed rows, like the routes do), so the fixture is committed
// and removed afterwards. The db-guard only lets this run against a local / dev database.

const D = (v: string | number) => new Prisma.Decimal(v);
const suffix = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
const jpyName = `TJPY${suffix}`;
const xyzName = `TXYZ${suffix}`;
let dbReachable = false;
let createdUsdJpy = false;
const ids = { broker: "", group: "", account: "", jpy: "", xyz: "" };

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    return;
  }
  const broker = await prisma.broker.create({ data: { name: `Margin FX Test ${suffix}`, subdomain: `mfx-${suffix.toLowerCase()}` } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `MFX-${suffix}`, dealingMode: "AUTO" } });
  const account = await prisma.account.create({
    data: { brokerId: broker.id, groupId: group.id, accountNumber: `7${suffix.slice(0, 7)}`, email: `mfx-${suffix}@test.local`, passwordHash: "x", fullName: "Margin FX Test", accountMode: "LIVE", balance: D("10000"), leverage: 100, currency: "USD" },
  });
  const jpy = await prisma.symbol.create({ data: { name: jpyName, baseCurrency: "USD", quoteCurrency: "JPY", digits: 3, contractSize: D("100000"), category: "CRYPTO" } });
  const xyz = await prisma.symbol.create({ data: { name: xyzName, baseCurrency: "USD", quoteCurrency: "XYZ", digits: 3, contractSize: D("1000"), category: "CRYPTO" } });
  Object.assign(ids, { broker: broker.id, group: group.id, account: account.id, jpy: jpy.id, xyz: xyz.id });
  const now = new Date();
  if (!(await prisma.livePrice.findUnique({ where: { symbol: "USDJPY" } }))) {
    await prisma.livePrice.create({ data: { symbol: "USDJPY", bid: D("150.000"), ask: D("150.000"), updatedAt: now, tickAt: now } });
    createdUsdJpy = true;
  }
  await prisma.livePrice.create({ data: { symbol: jpyName, bid: D("150.100"), ask: D("150.100"), updatedAt: now, tickAt: now } });
});

afterAll(async () => {
  if (dbReachable && ids.broker) {
    await prisma.position.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.order.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.account.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.group.deleteMany({ where: { brokerId: ids.broker } });
    await prisma.broker.delete({ where: { id: ids.broker } });
    await prisma.livePrice.deleteMany({ where: { symbol: { in: [jpyName, ...(createdUsdJpy ? ["USDJPY"] : [])] } } });
    await prisma.symbol.deleteMany({ where: { id: { in: [ids.jpy, ids.xyz] } } });
  }
  await prisma.$disconnect();
});

describe("margin figures are in the account's currency", () => {
  it("1 lot of a JPY-quoted pair needs ~1,000 USD of margin, not 150,000: a 10,000 USD account may open it", async () => {
    if (!dbReachable) return;
    const r = await checkAccountPreTradeMargin(prisma, {
      accountId: ids.account,
      leverage: 100,
      marginCallLevel: D(100),
      newOrderContractSize: D("100000"),
      newOrderVolume: D("1"),
      newOrderFillPrice: D("150.000"),
      newOrderQuoteCurrency: "JPY",
      newOrderSide: "BUY",
      newOrderSymbolId: ids.jpy,
    });
    expect(r).toBeNull();
  });

  it("refuses with NO_CONVERSION_RATE when the order's quote currency has no rate", async () => {
    if (!dbReachable) return;
    const r = await checkAccountPreTradeMargin(prisma, {
      accountId: ids.account,
      leverage: 100,
      marginCallLevel: D(100),
      newOrderContractSize: D("1000"),
      newOrderVolume: D("1"),
      newOrderFillPrice: D("10"),
      newOrderQuoteCurrency: "XYZ",
      newOrderSide: "BUY",
      newOrderSymbolId: ids.xyz,
    });
    expect(r?.error).toBe("NO_CONVERSION_RATE");
  });

  it("an open JPY position moves equity and used margin in USD", async () => {
    if (!dbReachable) return;
    const order = await prisma.order.create({ data: { brokerId: ids.broker, accountId: ids.account, symbolId: ids.jpy, side: "BUY", type: "MARKET", volume: D("1"), status: "FILLED", filledPrice: D("150.000"), filledAt: new Date(), idempotencyKey: `mfx:${randomUUID()}` } });
    await prisma.position.create({ data: { brokerId: ids.broker, accountId: ids.account, symbolId: ids.jpy, originOrderId: order.id, side: "BUY", volume: D("1"), openPrice: D("150.000"), status: "OPEN" } });

    const [snap] = await computeAccountMarginSnapshots(prisma, ids.broker);
    // +0.100 x 100,000 = 10,000 JPY = 66.67 USD at USDJPY 150
    expect(snap.equity).toBeCloseTo(10066.67, 2);
    // 1 x 100,000 x 150.100 / 100 = 150,100 JPY = 1,000.67 USD
    expect(snap.usedMargin).toBeCloseTo(1000.67, 2);
  });
});
