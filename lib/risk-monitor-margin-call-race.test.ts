// lib/risk-monitor.ts pass 3, concurrency (prod 2026-10-02: two MARGIN_CALL notifications 82 ms apart for one account
// and one episode). The engine's risk hook calls /api/internal/margin-monitor concurrently, so two evaluations of the
// same account can both read marginCallNotifiedAt = null. The set (and the clear) are now atomic conditional updates:
// only the evaluation that flips the flag writes the notifications and publishes the MarginCall event.
// A private CRYPTO symbol (continuous session) keeps this independent of the weekday and of other tests' prices.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";

const published = vi.hoisted(() => [] as { type: string; payload: Record<string, unknown> }[]);
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return {
    ...real,
    publishTradingEvent: vi.fn(async (type: string, payload: Record<string, unknown>) => {
      published.push({ type, payload });
    }),
  };
});

import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk } from "@/lib/risk-monitor";

const D = (v: number | string) => new Prisma.Decimal(v);
const SYM = "ZRMMCRACE";
const SUB = "zz-rm-mc-race";
const CONCURRENT = 6;
let brokerId = "";
let groupId = "";
let symbolId = "";
let seq = 0;

async function price(bid: number) {
  await prisma.livePrice.upsert({ where: { symbol: SYM }, update: { bid: D(bid), ask: D(bid), tickAt: new Date() }, create: { symbol: SYM, bid: D(bid), ask: D(bid), tickAt: new Date() } });
}

async function account(balance: number) {
  seq++;
  return prisma.account.create({
    data: { brokerId, accountNumber: `4778${String(Date.now() % 100000).padStart(5, "0")}${seq}`, email: `mc${seq}@x.local`, passwordHash: "x", fullName: "mc", accountMode: "DEMO", groupId, leverage: 1, balance: D(balance) },
  });
}

async function open(accountId: string, openPrice: number) {
  seq++;
  const order = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `mc-${Date.now()}-${seq}` } });
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(openPrice) } });
}

const evaluateConcurrently = (accountId: string) => Promise.all(Array.from({ length: CONCURRENT }, () => evaluateAccountRisk(accountId)));
const marginCallEvents = (accountId: string, state: string) => published.filter((e) => e.type === "MarginCall" && e.payload.account_id === accountId && e.payload.state === state);

async function wipe() {
  const b = await prisma.broker.findUnique({ where: { subdomain: SUB } });
  if (!b) return;
  const where = { brokerId: b.id };
  await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
  await prisma.order.updateMany({ where, data: { closesPositionId: null } });
  await prisma.postCloseEffect.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.transaction.deleteMany({ where });
  await prisma.notification.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.broker.delete({ where: { id: b.id } });
}

beforeAll(async () => {
  await wipe();
  const sym = await prisma.symbol.upsert({ where: { name: SYM }, update: {}, create: { name: SYM, baseCurrency: "ZMC", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbolId = sym.id;
  const b = await prisma.broker.create({ data: { name: "rm margin call race", subdomain: SUB } });
  brokerId = b.id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } })).id;
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId } });
}, 60_000);
afterAll(async () => {
  await wipe();
  await prisma.livePrice.deleteMany({ where: { symbol: SYM } });
}, 60_000);
beforeEach(() => {
  published.length = 0;
});

describe("margin call: one notice per episode under concurrent evaluations", () => {
  it(`${CONCURRENT} concurrent evaluations of an account entering margin call write one MARGIN_CALL pair and publish one event`, async () => {
    // leverage 1, contract 1: margin = price. Balance 80, open 100, price 90: equity 70 / used 90 = 77.78 %, above the
    // 50 % stop-out and at or below the 100 % margin call.
    const a = await account(80);
    await open(a.id, 100);
    await price(90);
    const results = await evaluateConcurrently(a.id);
    for (const r of results) expect(r).toEqual({ evaluated: true, slTpClosed: [], stopOutClosed: [] });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).marginCallNotifiedAt).not.toBeNull();
    // one trader copy + one staff copy, i.e. exactly one notice per audience
    expect(await prisma.notification.count({ where: { entityId: a.id, type: "MARGIN_CALL", accountId: a.id } })).toBe(1);
    expect(await prisma.notification.count({ where: { entityId: a.id, type: "MARGIN_CALL", accountId: null } })).toBe(1);
    expect(marginCallEvents(a.id, "margin_call")).toHaveLength(1);
    expect(marginCallEvents(a.id, "margin_call")[0].payload.level).toBe("77.78");

    // still in margin call: later passes (concurrent again) stay silent
    published.length = 0;
    await evaluateConcurrently(a.id);
    expect(await prisma.notification.count({ where: { entityId: a.id, type: "MARGIN_CALL" } })).toBe(2);
    expect(marginCallEvents(a.id, "margin_call")).toHaveLength(0);
  });

  it(`${CONCURRENT} concurrent evaluations of a recovered account clear the episode once: one MARGIN_CALL_CLEARED, one event`, async () => {
    const a = await account(80);
    await open(a.id, 100);
    await price(90);
    await evaluateAccountRisk(a.id); // enters margin call
    published.length = 0;
    await prisma.account.update({ where: { id: a.id }, data: { balance: D(1000) } }); // equity 990 / 90 = 1100 %: recovered
    await evaluateConcurrently(a.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).marginCallNotifiedAt).toBeNull();
    expect(await prisma.notification.count({ where: { accountId: a.id, type: "MARGIN_CALL_CLEARED" } })).toBe(1);
    expect(marginCallEvents(a.id, "cleared")).toHaveLength(1);
    expect(marginCallEvents(a.id, "margin_call")).toHaveLength(0);

    // the next episode notifies fresh, once
    published.length = 0;
    await prisma.account.update({ where: { id: a.id }, data: { balance: D(80) } }); // back to 77.78 %
    await evaluateConcurrently(a.id);
    expect(await prisma.notification.count({ where: { entityId: a.id, type: "MARGIN_CALL", accountId: a.id } })).toBe(2);
    expect(marginCallEvents(a.id, "margin_call")).toHaveLength(1);
  });

  it(`${CONCURRENT} concurrent evaluations of an account with nothing left open clear the flag once`, async () => {
    const a = await account(80);
    const p = await open(a.id, 100);
    await price(90);
    await evaluateAccountRisk(a.id); // enters margin call
    await prisma.position.update({ where: { id: p.id }, data: { status: "CLOSED", closedAt: new Date(), closePrice: D(90) } });
    await evaluateConcurrently(a.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).marginCallNotifiedAt).toBeNull();
    const ends = await prisma.notification.findMany({ where: { accountId: a.id, type: "MARGIN_CALL_CLEARED" } });
    expect(ends.map((n) => n.body)).toEqual([expect.stringMatching(/no open position left/)]);
  });
});
