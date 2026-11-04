import "dotenv/config";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { Prisma, type RoutingCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// L2 cutover STAGE 5, web side (design option (b), C:\vyx\handoff\l2-cutover-design.md section 3).
//
// When the ENGINE owns the fill path it must not write "HedgeIntent" itself. It writes a
// "PostCloseEffect" of kind POSITION_OPENED inside the fill's own transaction, carrying the IN deal's
// id, and the intent is written HERE by lib/post-close.ts -- so lib/hedge.ts stays the only intent
// writer and "an intent exists iff its deal committed" stays in one place.
//
// This file is the web half of that handshake. The engine half is
// engine/order-management/tests/order_book_prisma_db.rs, which asserts the engine writes exactly the
// row this file consumes: kind POSITION_OPENED, dedupeKey `open:<positionId>:<dealId>`, payload
// { dealId }. The two halves meet on that shape, so both sides assert it rather than assume it.
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test DIRECT_URL=<same> \
//     npx vitest run lib/post-close-open.test.ts
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return {
    ...real,
    publishTradingEvent: vi.fn().mockResolvedValue(undefined),
    publishBridgeNudge: vi.fn().mockResolvedValue(undefined),
  };
});
import { runPostClose } from "@/lib/post-close";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "seq" FROM "HedgeIntent" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/post-close-open.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
afterAll(async () => {
  for (const brokerId of brokers) {
    await prisma.hedgeIntent.deleteMany({ where: { brokerId } });
    await prisma.postCloseEffect.deleteMany({ where: { brokerId } });
    await prisma.deal.deleteMany({ where: { brokerId } });
    await prisma.transaction.deleteMany({ where: { brokerId } });
    await prisma.position.deleteMany({ where: { brokerId } });
    await prisma.order.deleteMany({ where: { brokerId } });
    await prisma.account.deleteMany({ where: { brokerId } });
    await prisma.group.deleteMany({ where: { brokerId } });
    await prisma.broker.delete({ where: { id: brokerId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

/** A filled order, its open position and its IN deal — the rows the engine's Stage 4 chain leaves. */
async function engineFill(category: RoutingCategory) {
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `s5 ${tag}`, subdomain: `s5-${tag}`, negativeBalanceProtection: true } });
  brokers.push(broker.id);
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `S5-${tag}`, category } });
  const account = await prisma.account.create({
    data: {
      brokerId: broker.id,
      groupId: group.id,
      accountNumber: `8${tag.slice(0, 7)}`,
      email: `s5-${tag}@test.local`,
      passwordHash: "x",
      fullName: "Stage 5",
      accountMode: "LIVE",
      balance: D(100000),
      leverage: 100,
    },
  });
  const symbol = await prisma.symbol.create({
    data: { name: `ZH${tag.slice(0, 6).toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "METALS" },
  });
  const order = await prisma.order.create({
    data: {
      brokerId: broker.id,
      accountId: account.id,
      symbolId: symbol.id,
      side: "BUY",
      type: "MARKET",
      volume: D("0.01"),
      status: "FILLED",
      filledPrice: D("4299.13"),
      filledAt: new Date(),
      idempotencyKey: `engine:${tag}`,
      source: "API",
    },
  });
  // no ticket, no groupCategoryAtOpen: both BEFORE INSERT triggers fill them, exactly as the engine's insert leaves it
  const position = await prisma.position.create({
    data: {
      brokerId: broker.id,
      accountId: account.id,
      symbolId: symbol.id,
      originOrderId: order.id,
      side: "BUY",
      volume: D("0.01"),
      openPrice: D("4299.13"),
      bookType: category === "A_BOOK" || category === "COVERAGE" ? "A_BOOK" : "B_BOOK",
    },
  });
  const deal = await prisma.deal.create({
    data: {
      brokerId: broker.id,
      accountId: account.id,
      positionId: position.id,
      orderId: order.id,
      symbolId: symbol.id,
      side: "BUY",
      entry: "IN",
      reason: "CLIENT",
      source: "API",
      volume: D("0.01"),
      price: D("4299.13"),
      executedAt: position.openedAt,
    },
  });
  return { broker, group, account, symbol, order, position, deal };
}

/** The PostCloseEffect row the engine writes — the shape its own test asserts. */
async function queuePositionOpened(f: Awaited<ReturnType<typeof engineFill>>, payload: Prisma.InputJsonValue = { dealId: "" }) {
  const body = payload as { dealId?: string };
  return prisma.postCloseEffect.create({
    data: {
      kind: "POSITION_OPENED",
      dedupeKey: `open:${f.position.id}:${body.dealId ?? "none"}`,
      brokerId: f.broker.id,
      accountId: f.account.id,
      positionId: f.position.id,
      payload,
    },
  });
}

describe("L2 Stage 5: the web turns the engine's POSITION_OPENED row into the hedge intent", () => {
  it("an A-book engine fill is hedged exactly as the web's own open path hedges it", async () => {
    if (!dbReachable) return;
    const f = await engineFill("A_BOOK");
    // the stamp trigger really fired, which is what makes this position hedgeable at all
    expect(f.position.groupCategoryAtOpen).toBe("A_BOOK");
    // and the engine wrote no intent of its own: that is the whole point of option (b)
    expect(await prisma.hedgeIntent.count({ where: { positionId: f.position.id } })).toBe(0);

    const row = await queuePositionOpened(f, { dealId: f.deal.id });
    await expect(runPostClose(row.id)).resolves.toMatchObject({ status: "done" });

    const intents = await prisma.hedgeIntent.findMany({ where: { positionId: f.position.id } });
    expect(intents).toHaveLength(1);
    const intent = intents[0];
    // the row lib/hedge.ts writes, field for field -- an OPEN intent QoreBridge can act on
    expect(intent.dealId).toBe(f.deal.id);
    expect(intent.kind).toBe("OPEN");
    expect(intent.side).toBe("BUY");
    expect(intent.symbol).toBe(f.symbol.name);
    expect(intent.groupId).toBe(f.group.id);
    expect(intent.volume.toString()).toBe("0.01");
    expect(intent.clientPrice?.toString()).toBe("4299.13");
    expect(intent.reason).toBe("CLIENT");

    // and the row is marked done, so the dispatcher stops retrying it
    const done = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(done.status).toBe("DONE");
    expect(done.doneSteps).toContain("hedge_open");
  });

  it("a replayed row writes one intent, not two", async () => {
    if (!dbReachable) return;
    const f = await engineFill("A_BOOK");
    const row = await queuePositionOpened(f, { dealId: f.deal.id });
    await expect(runPostClose(row.id)).resolves.toMatchObject({ status: "done" });
    // a second run of a DONE row is turned away, and a re-opened one skips the step it already did
    await expect(runPostClose(row.id)).resolves.toMatchObject({ status: "gone" });
    await prisma.postCloseEffect.update({ where: { id: row.id }, data: { status: "PENDING", leaseUntil: null } });
    await expect(runPostClose(row.id)).resolves.toMatchObject({ status: "done" });
    expect(await prisma.hedgeIntent.count({ where: { positionId: f.position.id } })).toBe(1);
  });

  it("a B-book position is declined here even if it was queued, so the engine's gate is not the only guard", async () => {
    if (!dbReachable) return;
    // The engine queues only an A_BOOK stamp. This asserts the second line of defence: hedgeDealInTx
    // applies the FULL routing rule, so a row that should never have been queued writes nothing.
    const f = await engineFill("B_BOOK");
    expect(f.position.groupCategoryAtOpen).toBe("B_BOOK");
    const row = await queuePositionOpened(f, { dealId: f.deal.id });
    await expect(runPostClose(row.id)).resolves.toMatchObject({ status: "done" });
    expect(await prisma.hedgeIntent.count({ where: { positionId: f.position.id } })).toBe(0);
  });

  it("an A-book row queued without a dealId fails loudly instead of silently leaving the position unhedged", async () => {
    if (!dbReachable) return;
    const f = await engineFill("A_BOOK");
    const row = await queuePositionOpened(f, {});
    const result = await runPostClose(row.id);
    expect(result.status).not.toBe("done");
    expect(result.error).toContain("cannot hedge");
    expect(await prisma.hedgeIntent.count({ where: { positionId: f.position.id } })).toBe(0);
    // the row keeps its lastError, so the dispatcher's alerting can see it
    const after = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id } });
    expect(after.lastError).toContain("cannot hedge");
  });

  it("POSITION_CLOSED still reaches closeSteps, so adding this branch did not displace the close side", async () => {
    if (!dbReachable) return;
    // The close-side gate (lib/post-close.test.ts) is the real test of closeSteps, and it needs the
    // rust harness DB. This asserts the one thing adding a branch to the dispatch chain could break:
    // that POSITION_CLOSED is still routed there. A row with no payload fails INSIDE closeSteps, so
    // the error naming a close field -- rather than "unknown kind" -- is the proof it was dispatched.
    const f = await engineFill("B_BOOK");
    const row = await prisma.postCloseEffect.create({
      data: { kind: "POSITION_CLOSED", dedupeKey: `close:${f.position.id}:none`, brokerId: f.broker.id, accountId: f.account.id, positionId: f.position.id, reason: "stop_loss", payload: {} },
    });
    const result = await runPostClose(row.id);
    expect(result.status).not.toBe("done");
    expect(result.error).not.toContain("unknown PostCloseEffect kind");
  });

  it("an unknown kind is still refused, so this branch did not open the door to anything else", async () => {
    if (!dbReachable) return;
    const f = await engineFill("A_BOOK");
    const row = await prisma.postCloseEffect.create({
      data: { kind: "POSITION_SOMETHING", dedupeKey: `x:${f.position.id}`, brokerId: f.broker.id, accountId: f.account.id, positionId: f.position.id, payload: {} },
    });
    const result = await runPostClose(row.id);
    expect(result.status).not.toBe("done");
    expect(result.error).toContain("unknown PostCloseEffect kind");
  });
});
