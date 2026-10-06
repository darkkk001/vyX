// Stage 6 (b) + (c): the 1-minute web fallback route (app/api/internal/risk-fallback). It does the full web pass only when trading is active AND some
// broker is RUST AND the engine's heartbeat is stale; in every other case it returns without evaluating anything, and while the market is idle or no
// broker is on the engine it does not read the database at all (Neon stays asleep). The stale case runs the REAL pass on the scratch DB: the web
// stops the account out exactly once and the 5-minute behaviour (lib/margin-pass.ts, shared) is unchanged.
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

process.env.REDIS_URL ??= "redis://127.0.0.1:6379";

vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn(async () => {}) };
});
vi.mock("@/lib/email/adapter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email/adapter")>()),
  sendPlatformEmail: vi.fn().mockResolvedValue({ usedMock: true }),
}));
vi.mock("@/lib/live-price", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/live-price")>()),
  marginPassGate: vi.fn(async () => ({ run: true, reason: "test" })),
}));

import { prisma } from "@/lib/prisma";
import { sendPlatformEmail } from "@/lib/email/adapter";
import { marginPassGate } from "@/lib/live-price";
import { setRiskHeartbeat } from "@/tests/support/risk-heartbeat";
import { GET } from "@/app/api/internal/risk-fallback/route";
import { anyBrokerRust, RUST_CACHE_MS, resetRiskFallbackCache } from "@/lib/risk-fallback";
import { resetEngineAlertState } from "@/lib/risk-engine-alert";

const D = (v: number | string) => new Prisma.Decimal(v);
const gate = vi.mocked(marginPassGate);
const mail = vi.mocked(sendPlatformEmail);
const brokers: string[] = [];
const symbols: string[] = [];
let seq = 0;

const call = (auth: string | null = `Bearer ${process.env.CRON_SECRET}`) =>
  GET(new NextRequest("http://localhost/api/internal/risk-fallback", { headers: auth ? { authorization: auth } : {} }));

async function scenario(authority: "RUST" | "WEB", positions = 2) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `fb ${sfx}`, subdomain: `zfb-${sfx}`, riskAuthority: authority, riskAuthorityDemoOnly: false } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `ZF${sfx.toUpperCase()}`, baseCurrency: "ZFB", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(90), ask: D(90), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `ZF-${sfx}`, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } });
  seq++;
  const a = await prisma.account.create({
    data: { brokerId: b.id, groupId: g.id, accountNumber: `6${String(Date.now() % 1000000).padStart(6, "0")}${seq}`.slice(0, 12), email: `zf${seq}-${sfx}@x.local`, passwordHash: "x", fullName: "fb", accountMode: "LIVE", leverage: 1, balance: D(20) },
  });
  const ids: string[] = [];
  for (let i = 0; i < positions; i++) {
    const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `zf-${a.id}-${i}` } });
    const p = await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100) } });
    ids.push(p.id);
  }
  return { brokerId: b.id, accountId: a.id, positionIds: ids };
}
const openCount = (accountId: string) => prisma.position.count({ where: { accountId, status: "OPEN" } });
const pnlRows = (accountId: string) => prisma.transaction.count({ where: { accountId, type: "TRADE_PNL" } });

beforeAll(async () => {
  process.env.CRON_SECRET = "fallback-test-secret";
  process.env.OPS_ALERT_EMAIL = "ops@example.test";
  // this file's own clone of the test DB: no other broker may be on the engine
  await prisma.$executeRaw`UPDATE "Broker" SET "riskAuthority" = 'WEB'::"RiskAuthority"`;
});
beforeEach(async () => {
  resetRiskFallbackCache();
  await resetEngineAlertState();
  gate.mockReset();
  gate.mockResolvedValue({ run: true, reason: "test" });
  mail.mockClear();
  await setRiskHeartbeat(prisma, 0);
});
afterAll(async () => {
  await setRiskHeartbeat(prisma, 0);
  await resetEngineAlertState();
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.postCloseEffect.deleteMany({ where }).catch(() => {});
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60_000);

describe("the 1-minute fallback route", () => {
  it("refuses a call without the cron secret", async () => {
    expect((await call(null)).status).toBe(401);
    expect((await call("Bearer nope")).status).toBe(401);
  });

  it("an idle market returns before any database read (Neon stays asleep) and raises nothing", async () => {
    gate.mockResolvedValue({ run: false, reason: "engine book gate: feed-quiet" });
    const spyQ = vi.spyOn(prisma, "$queryRaw");
    const spyR = vi.spyOn(prisma, "$executeRaw");
    const res = await (await call()).json();
    expect(res).toMatchObject({ ran: false, skipped: "engine book gate: feed-quiet" });
    expect(spyQ).not.toHaveBeenCalled();
    expect(spyR).not.toHaveBeenCalled();
    spyQ.mockRestore();
    spyR.mockRestore();
  });

  it("no broker on the engine: no pass, and the answer is cached (the second call reads nothing)", async () => {
    const s = await scenario("WEB");
    await setRiskHeartbeat(prisma, null); // stale, but nobody is on the engine
    const first = await (await call()).json();
    expect(first).toMatchObject({ ran: false, skipped: "no broker is on the engine" });
    const spyQ = vi.spyOn(prisma, "$queryRaw");
    const second = await (await call()).json();
    expect(second).toMatchObject({ ran: false });
    expect(spyQ).not.toHaveBeenCalled();
    spyQ.mockRestore();
    expect(await openCount(s.accountId)).toBe(2);
    expect(mail).not.toHaveBeenCalled();
  });

  it("the cache expires: a flip to RUST is noticed within the window, the other way too", async () => {
    const s = await scenario("WEB");
    const t0 = 1_000_000;
    expect(await anyBrokerRust(t0)).toBe(false);
    await prisma.broker.update({ where: { id: s.brokerId }, data: { riskAuthority: "RUST" } });
    expect(await anyBrokerRust(t0 + RUST_CACHE_MS.none - 1)).toBe(false); // still the cached answer
    expect(await anyBrokerRust(t0 + RUST_CACHE_MS.none + 1)).toBe(true);
    await prisma.broker.update({ where: { id: s.brokerId }, data: { riskAuthority: "WEB" } });
    expect(await anyBrokerRust(t0 + RUST_CACHE_MS.none + 2)).toBe(true);
    expect(await anyBrokerRust(t0 + RUST_CACHE_MS.none + 1 + RUST_CACHE_MS.some + 1)).toBe(false);
  });

  it("a RUST broker with a FRESH heartbeat: the engine acts, the fallback does nothing", async () => {
    const s = await scenario("RUST");
    await setRiskHeartbeat(prisma, 3, 30);
    const res = await (await call()).json();
    expect(res).toMatchObject({ ran: false, skipped: "engine heartbeat fresh" });
    expect(await openCount(s.accountId)).toBe(2);
    expect(await pnlRows(s.accountId)).toBe(0);
    expect(mail).not.toHaveBeenCalled();
  });

  it("a RUST broker with a STALE heartbeat: the web takes over and stops the account out exactly once; a second call does nothing more", async () => {
    const s = await scenario("RUST", 3);
    await setRiskHeartbeat(prisma, 45, 30);
    const res = await (await call()).json();
    expect(res).toMatchObject({ ran: true, fallback: true });
    expect(await openCount(s.accountId)).toBe(0);
    expect(await pnlRows(s.accountId)).toBe(3);
    const again = await (await call()).json();
    expect(again.ran).toBe(true); // the pass runs (still stale) and finds nothing left
    expect(await pnlRows(s.accountId)).toBe(3);
  }, 30_000);

  it("the engine cannot be read (gate null): the fallback still runs when the heartbeat is stale", async () => {
    const s = await scenario("RUST", 1);
    gate.mockResolvedValue({ run: null, reason: "engine unreadable" });
    await setRiskHeartbeat(prisma, null);
    const res = await (await call()).json();
    expect(res.ran).toBe(true);
    expect(await openCount(s.accountId)).toBe(0);
  }, 30_000);

  it("the ops alert: two stale minutes send ONE e-mail to ops and write no broker notification; a fresh heartbeat afterwards sends nothing more by itself", async () => {
    const s = await scenario("RUST", 1);
    await prisma.position.updateMany({ where: { accountId: s.accountId }, data: { slPrice: null } });
    await prisma.account.update({ where: { id: s.accountId }, data: { balance: D(100000) } }); // healthy: the pass has nothing to close
    const notificationsBefore = await prisma.notification.count({ where: { brokerId: s.brokerId } });
    await setRiskHeartbeat(prisma, 60, 30);
    expect((await (await call()).json()).alert).toBeNull();
    expect((await (await call()).json()).alert).toBe("ALERT");
    expect(mail).toHaveBeenCalledTimes(1);
    expect(mail.mock.calls[0][0].to).toBe("ops@example.test");
    expect((await (await call()).json()).alert).toBeNull();
    expect(mail).toHaveBeenCalledTimes(1);
    await setRiskHeartbeat(prisma, 1, 30);
    expect((await (await call()).json())).toMatchObject({ ran: false, alert: null }); // fresh: the recovery notice needs a minute of fresh checks
    expect(mail).toHaveBeenCalledTimes(1);
    expect(await prisma.notification.count({ where: { brokerId: s.brokerId } })).toBe(notificationsBefore);
  }, 30_000);
});
