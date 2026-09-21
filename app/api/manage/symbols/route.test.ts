import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Stage 4 piece 5 compatibility contract.
//
// The Symbols screen no longer shows or edits BrokerSymbol.defaultBookType:
// routing is the account's GROUP (Group.category), never the symbol. But the
// column survives until Stage 5 for rollback, and a backoffice 1.0.9 still in
// the field keeps sending the field. So this route has to accept BOTH shapes,
// and -- the part that is easy to get wrong -- a payload that omits the field
// must leave the stored value ALONE rather than resetting it to the default.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("symbols route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; adminId: string; symbolId: string };
const createdBrokerIds: string[] = [];
const createdSymbolIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Symbols Test ${suffix}`, subdomain: `symtest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `sym-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  const symbol = await prisma.symbol.create({
    data: { name: `SYMT${suffix.slice(0, 6).toUpperCase()}`, baseCurrency: "USD", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
  });
  createdSymbolIds.push(symbol.id);
  return { brokerId: broker.id, adminId: admin.id, symbolId: symbol.id };
}

/** The fields the screen always sends, minus the one under test. */
function baseBody(symbolId: string) {
  return {
    symbolId,
    spreadMarkup: "1.5",
    minLot: "0.01",
    maxLot: "100",
    lotStep: "0.01",
    swapLong: "0",
    swapShort: "0",
    commissionPerLot: "0",
    enabled: true,
    tradingMode: "BOTH",
  };
}

async function patch(fx: Fixture, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { PATCH } = await import("./route");
  const response = await PATCH(
    new NextRequest("https://test.local/api/manage/symbols", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })
  );
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.brokerSymbol.deleteMany({ where: { brokerId: { in: createdBrokerIds } } });
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: createdBrokerIds } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: createdBrokerIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  await prisma.symbol.deleteMany({ where: { id: { in: createdSymbolIds } } });
  await prisma.$disconnect();
});

describe("PATCH /api/manage/symbols -- defaultBookType compatibility", () => {
  it("accepts a payload with no defaultBookType (backoffice 1.0.10)", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const res = await patch(fx, baseBody(fx.symbolId));
    expect(res.status).toBe(200);
  });

  it("creates the row with the schema default when the field was never sent", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await patch(fx, baseBody(fx.symbolId));
    const row = await prisma.brokerSymbol.findUniqueOrThrow({
      where: { brokerId_symbolId: { brokerId: fx.brokerId, symbolId: fx.symbolId } },
    });
    expect(row.defaultBookType).toBe("B_BOOK");
    expect(row.spreadMarkup.toString()).toBe("1.5");
  });

  it("still honours the field when a 1.0.9 backoffice sends it", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const res = await patch(fx, { ...baseBody(fx.symbolId), defaultBookType: "A_BOOK" });
    expect(res.status).toBe(200);
    const row = await prisma.brokerSymbol.findUniqueOrThrow({
      where: { brokerId_symbolId: { brokerId: fx.brokerId, symbolId: fx.symbolId } },
    });
    expect(row.defaultBookType).toBe("A_BOOK");
  });

  // The one that matters. A broker sets A_BOOK from an old build, then someone
  // on 1.0.10 edits the spread. The book must not silently flip to B_BOOK --
  // that would re-route the symbol's fallback behind their back, and it is
  // exactly what a naive `defaultBookType: defaultBookType ?? "B_BOOK"` does.
  it("PRESERVES an existing A_BOOK when a later save omits the field", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await patch(fx, { ...baseBody(fx.symbolId), defaultBookType: "A_BOOK" });

    const res = await patch(fx, { ...baseBody(fx.symbolId), spreadMarkup: "2.5" });
    expect(res.status).toBe(200);

    const row = await prisma.brokerSymbol.findUniqueOrThrow({
      where: { brokerId_symbolId: { brokerId: fx.brokerId, symbolId: fx.symbolId } },
    });
    expect(row.defaultBookType).toBe("A_BOOK");
    expect(row.spreadMarkup.toString()).toBe("2.5");
  });

  it("still rejects a genuinely invalid payload", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const res = await patch(fx, { ...baseBody(fx.symbolId), tradingMode: "NONSENSE" });
    expect(res.status).toBe(400);
  });
});
