import "dotenv/config";
import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// L2 latency measurement, STEP 1: how many SEQUENTIAL database round trips does the web's market-order
// fill path make?
//
// WHY THIS IS THE NUMBER THAT MATTERS. Measured 2026-11-02: one trivial round trip from the VPS to
// Neon costs 10.1 ms (p50, same session, 29 samples). The web's own order-ack window (lib/order-latency.ts,
// read live out of Redis) puts the Vercel handler at p50 139 ms / p95 194-280 ms across brokers. If the
// path makes N sequential round trips then N x RTT is the floor, and no amount of faster code moves it.
// So before designing anything, count N.
//
// The count itself comes from the DATABASE, not from this file: the scratch cluster runs with
// log_statement = all, and the two marker statements below bracket exactly the handler's own work, so
// `scripts/latency/count-roundtrips.sh` can count the statements between them. This test's job is to
// drive the real route once, with the real fixture, and leave those markers in the log.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test DIRECT_URL=<same> \
//   REDIS_URL=redis://127.0.0.1:6399 VYX_TEST_SHARED_DB=1 \
//     npx vitest run lib/order-latency-roundtrips.test.ts
//
// VYX_TEST_SHARED_DB=1 matters: without it each test file runs against its own clone, and the clone's
// name is what the log shows, which makes the markers harder to find. Nothing here depends on sharing.
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return {
    ...real,
    publishTradingEvent: vi.fn().mockResolvedValue(undefined),
    publishBridgeNudge: vi.fn().mockResolvedValue(undefined),
    publishAlertConfig: vi.fn().mockResolvedValue(undefined),
  };
});
import { getAccountSession } from "@/lib/account-auth";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/order-latency-roundtrips.test.ts: DB unreachable, skipping");
  }
});

describe("L2 latency step 1: the web market-order path's round trips", () => {
  it("fills a market order through the real route, bracketed by markers the server log can count", async () => {
    if (!dbReachable) return;
    const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await prisma.broker.create({
      data: { name: `Lat ${suffix}`, subdomain: `lat-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: new Date() },
    });
    const symbol = await prisma.symbol.create({
      data: { name: `LT${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) },
    });
    await prisma.brokerSymbol.create({
      data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true, commissionPerLot: D(3) },
    });
    await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
    // B_BOOK, which is the common case and the cheaper one: an A_BOOK group adds the hedge intent write.
    const group = await prisma.group.create({
      data: { brokerId: broker.id, name: `LTG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true },
    });
    const account = await prisma.account.create({
      data: {
        groupId: group.id,
        brokerId: broker.id,
        accountNumber: `3${suffix.slice(0, 7)}`,
        email: `lat-${suffix}@test.local`,
        passwordHash: "x",
        fullName: "Latency Probe",
        accountMode: "LIVE",
        leverage: 100,
        balance: D(100000),
      },
    });

    vi.mocked(getAccountSession).mockResolvedValue({ accountId: account.id, brokerId: broker.id } as never);
    const { POST } = await import("@/app/api/trade/orders/route");

    // One warm-up fill first: Prisma's connection set-up and any lazily prepared statement would
    // otherwise be counted as part of the path, and they are paid once per process, not per order.
    const place = async () => {
      const req = new NextRequest("https://t.local/api/trade/orders", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ symbol: symbol.name, side: "BUY", type: "MARKET", volume: "0.01", price: "100.10", idempotencyKey: `lat:${randomUUID()}` }),
      });
      return (POST as (r: NextRequest) => Promise<Response>)(req);
    };
    expect((await place()).status).toBe(201);

    await prisma.$queryRawUnsafe("SELECT 'VYX-LATENCY-MARK-BEGIN' AS marker");
    const started = Date.now();
    const res = await place();
    const elapsedMs = Date.now() - started;
    await prisma.$queryRawUnsafe("SELECT 'VYX-LATENCY-MARK-END' AS marker");

    expect(res.status).toBe(201);
    // Against a LOCAL database each round trip is ~0.3 ms, so this is close to the path's pure compute
    // plus N x (local RTT) -- useful as the compute term of the model, not as a latency figure.
    console.log(`[latency] market-order handler against a local DB: ${elapsedMs} ms`);

    // and it really did fill, so the count covers the whole chain and not an early rejection
    const position = await prisma.position.findFirstOrThrow({ where: { accountId: account.id }, orderBy: { openedAt: "desc" } });
    expect(position.openPrice.toString()).toBe("100.1");
    const deals = await prisma.deal.count({ where: { positionId: position.id } });
    expect(deals).toBe(1);

    // leave nothing behind
    await prisma.hedgeIntent.deleteMany({ where: { brokerId: broker.id } });
    await prisma.deal.deleteMany({ where: { brokerId: broker.id } });
    await prisma.transaction.deleteMany({ where: { brokerId: broker.id } });
    await prisma.auditLog.deleteMany({ where: { brokerId: broker.id } });
    await prisma.position.deleteMany({ where: { brokerId: broker.id } });
    await prisma.order.deleteMany({ where: { brokerId: broker.id } });
    await prisma.account.deleteMany({ where: { brokerId: broker.id } });
    await prisma.group.deleteMany({ where: { brokerId: broker.id } });
    await prisma.brokerSymbol.deleteMany({ where: { brokerId: broker.id } });
    await prisma.livePrice.deleteMany({ where: { symbol: symbol.name } });
    await prisma.broker.delete({ where: { id: broker.id } });
    await prisma.symbol.delete({ where: { id: symbol.id } });
  }, 60000);
});
