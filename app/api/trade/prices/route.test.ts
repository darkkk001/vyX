import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Stage 4 flag-consistency fix (2026-09-07) -- this route had no test file
// at all before this. Covers exactly the thing that changed: flag off
// must still quote the old group-only markup (byte-identical to before),
// flag on must quote the SAME number a real fill would use (an
// AccountType override, invisible to the old resolution, must show up
// here once the flag is on).
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("prices/route.test.ts: DB unreachable, skipping");
  }
});

const createdBrokerIds: string[] = [];

async function createFixture(pricingEngineEnabled: boolean) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({
    data: { name: `Prices Test ${suffix}`, subdomain: `pxtest-${suffix}`, pricingEngineEnabled },
  });
  createdBrokerIds.push(broker.id);
  const symbol = await prisma.symbol.create({
    data: { name: `PX${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX", digits: 2 },
  });
  await prisma.brokerSymbol.create({
    data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), spreadMarkup: D("3") },
  });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("99.90"), ask: D("100.10") } });
  const accountType = await prisma.accountType.create({ data: { brokerId: broker.id, name: "PX Type", spreadMarkup: D("0.05") } });
  const account = await prisma.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `6${suffix.slice(0, 7)}`,
      email: `px-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Prices Test",
      accountMode: "LIVE",
      accountTypeId: accountType.id,
    },
  });
  return { broker, symbol, accountType, account };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.account.deleteMany({ where });
    await prisma.accountType.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "PX" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "PX" } } }).catch(() => {});
  await prisma.$disconnect();
});

async function getPrices(accountId: string, brokerId: string) {
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId });
  const { GET } = await import("./route");
  const response = await GET();
  return response.json();
}

describe("GET /api/trade/prices -- flag consistency (live DB)", () => {
  it("flag OFF quotes the old broker-wide markup, ignoring an AccountType override entirely", async () => {
    if (!dbReachable) return;
    const { broker, symbol, account } = await createFixture(false);
    const json = await getPrices(account.id, broker.id);
    const row = json.find((p: { symbol: string }) => p.symbol === symbol.name);
    expect(row).toBeTruthy();
    // 3 pips markup, 2-digit symbol -> pip size 0.1 -> 3 * 0.1 = 0.3
    expect(row.askMarkup).toBe("0.3");
  });

  it("flag ON quotes the AccountType's own override, matching what a real fill would charge", async () => {
    if (!dbReachable) return;
    const { broker, symbol, account } = await createFixture(true);
    const json = await getPrices(account.id, broker.id);
    const row = json.find((p: { symbol: string }) => p.symbol === symbol.name);
    expect(row).toBeTruthy();
    // AccountType.spreadMarkup = 0.05 pips, pip size 0.1 -> 0.005
    expect(row.askMarkup).toBe("0.005");
  });
});
