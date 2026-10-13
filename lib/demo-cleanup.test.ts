import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { createAccountSession, verifyAccountSessionToken } from "@/lib/account-auth";
import { cleanDemoRedis, createOtherBroker, D, seedDemoTenant } from "@/lib/demo-test-fixtures";
import { clearDemoState, createGuestAccount, readDemoState, resetDemoBrokerCache, writeDemoState } from "@/lib/demo";
import { deleteGuestAccount, findCleanupCandidates, runDemoCleanup } from "@/lib/demo-cleanup";

// The daily clean-up of the demo's guests. The point of these tests is the REFUSALS: the delete function itself must say no to
// anything that is not a guest of the demo broker, whatever calls it, and a run must leave every other tenant byte for byte alone.
let demo: Awaited<ReturnType<typeof seedDemoTenant>>;
let other: Awaited<ReturnType<typeof createOtherBroker>>;
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY);

type Ids = { account: string; number: string; order?: string; position?: string; token?: string };
const guests: Record<string, Ids> = {};

async function makeGuest(label: string, o: { createdDaysAgo: number; loginDaysAgo?: number; orderDaysAgo?: number; withBook?: boolean }) {
  const g = (await createGuestAccount())!;
  await prisma.account.update({ where: { id: g.id }, data: { createdAt: ago(o.createdDaysAgo) } });
  await prisma.loginEvent.deleteMany({ where: { accountId: g.id } }); // the creation login; the cases below set their own
  const ids: Ids = { account: g.id, number: g.accountNumber };
  if (o.loginDaysAgo != null) await prisma.loginEvent.create({ data: { brokerId: demo.broker.id, accountId: g.id, ipAddress: "203.0.113.9", createdAt: ago(o.loginDaysAgo) } });
  if (o.orderDaysAgo != null || o.withBook) {
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const when = ago(o.orderDaysAgo ?? 20);
    const order = await prisma.order.create({
      data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("0.1"), requestedPrice: D(4400), idempotencyKey: `c:${randomUUID()}`, status: "FILLED", filledPrice: D(4400), filledAt: when, createdAt: when },
    });
    const position = await prisma.position.create({
      data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D("0.1"), openPrice: D(4400), openedAt: when },
    });
    await prisma.transaction.create({ data: { brokerId: demo.broker.id, accountId: g.id, type: "TRADE_PNL", status: "COMPLETED", amount: D(5), balanceBefore: D(10000), balanceAfter: D(10005), referenceType: "Position", referenceId: position.id } });
    await prisma.auditLog.create({ data: { brokerId: demo.broker.id, action: "ORDER_FILLED", entityType: "Position", entityId: position.id, oldValue: {}, newValue: {} } });
    await prisma.auditLog.create({ data: { brokerId: demo.broker.id, action: "ORDER_PLACED", entityType: "Order", entityId: order.id, oldValue: {}, newValue: {} } });
    await prisma.postCloseEffect.create({ data: { kind: "POSITION_CLOSED", brokerId: demo.broker.id, accountId: g.id, positionId: position.id, dedupeKey: `d:${randomUUID()}`, payload: {} } });
    ids.order = order.id;
    ids.position = position.id;
  }
  const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qEURUSD" } });
  await prisma.watchlistItem.create({ data: { accountId: g.id, symbolId: sym.id, position: 0 } });
  await prisma.notification.create({ data: { brokerId: demo.broker.id, accountId: g.id, type: "MARGIN_CALL", title: "t", body: "b" } });
  ids.token = await createAccountSession({ accountId: g.id, brokerId: demo.broker.id }, { userAgent: "t", ip: "1.1.1.1" });
  await writeDemoState(g.id, { t: Date.now(), w: 0 });
  guests[label] = ids;
  return ids;
}

async function snapshotOtherTenants() {
  const ids = [other.broker.id];
  const w = { brokerId: { in: ids } };
  return {
    accounts: await prisma.account.findMany({ where: w, orderBy: { id: "asc" } }),
    orders: await prisma.order.count({ where: w }),
    positions: await prisma.position.count({ where: w }),
    transactions: await prisma.transaction.count({ where: w }),
    audit: await prisma.auditLog.count({ where: w }),
    logins: await prisma.loginEvent.count({ where: w }),
    notifications: await prisma.notification.count({ where: w }),
    symbols: await prisma.symbol.count(),
    demoSeedAudit: await prisma.auditLog.count({ where: { brokerId: demo.broker.id, action: "QOREDEMO_SEED" } }),
  };
}

beforeAll(async () => {
  demo = await seedDemoTenant();
  other = await createOtherBroker();
  // accounts that must never be deleted, in three different ways
  await prisma.account.create({ data: { groupId: other.group.id, brokerId: other.broker.id, accountNumber: "48123456", email: "inrange@other.test", passwordHash: "x", fullName: "other tenant, inside the range", accountMode: "DEMO", balance: D(777), createdAt: ago(60) } });
  await prisma.account.create({ data: { groupId: demo.group.id, brokerId: demo.broker.id, accountNumber: "50123456", email: "outside@demo.test", passwordHash: "x", fullName: "demo broker, outside the range", accountMode: "DEMO", balance: D(888), createdAt: ago(60) } });
  await prisma.order.create({
    data: { brokerId: other.broker.id, accountId: other.account.id, symbolId: other.symbol.id, side: "BUY", type: "MARKET", volume: D("1"), idempotencyKey: `o:${randomUUID()}`, status: "FILLED", filledPrice: D(100), createdAt: ago(90) },
  });
  await makeGuest("stale", { createdDaysAgo: 8, withBook: true });
  await makeGuest("fresh", { createdDaysAgo: 0, loginDaysAgo: 0 });
  await makeGuest("recentLogin", { createdDaysAgo: 8, loginDaysAgo: 2 });
  await makeGuest("recentOrder", { createdDaysAgo: 8, orderDaysAgo: 1, withBook: true });
  await makeGuest("tooOld", { createdDaysAgo: 31, loginDaysAgo: 1, orderDaysAgo: 1, withBook: true });
  await makeGuest("sevenDaysExactly", { createdDaysAgo: 6.5, withBook: true });
}, 120_000);
afterAll(async () => {
  await cleanDemoRedis();
  delete process.env.DEMO_BROKER_SUBDOMAIN;
});

describe("which guests are due", () => {
  it("no login and no order for 7 days, or older than 30 days; never the fresh, the recently active or the under-7-day-old", async () => {
    const due = new Set(await findCleanupCandidates(prisma, demo.broker.id));
    expect(due.has(guests.stale.account)).toBe(true);
    expect(due.has(guests.tooOld.account)).toBe(true);
    for (const keep of ["fresh", "recentLogin", "recentOrder", "sevenDaysExactly"]) expect(due.has(guests[keep].account)).toBe(false);
    // the selection itself never even considers another tenant's or an out-of-range account
    const all = await prisma.account.findMany({ where: { OR: [{ accountNumber: "48123456" }, { accountNumber: "50123456" }, { id: other.account.id }] } });
    for (const a of all) expect(due.has(a.id)).toBe(false);
  });
});

describe("the delete function refuses by itself", () => {
  it("an account of ANOTHER broker inside the guest range", async () => {
    const a = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "48123456" } });
    const before = await snapshotOtherTenants();
    const r = await deleteGuestAccount(a.id);
    expect(r.deleted).toBe(false);
    expect(r.refused).toMatch(/does not belong to the demo broker/);
    expect(await prisma.account.findUnique({ where: { id: a.id } })).not.toBeNull();
    expect(await snapshotOtherTenants()).toEqual(before);
  });
  it("an account of the demo broker OUTSIDE the range", async () => {
    const a = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "50123456" } });
    const r = await deleteGuestAccount(a.id);
    expect(r.deleted).toBe(false);
    expect(r.refused).toMatch(/outside the guest range/);
    expect(await prisma.account.findUnique({ where: { id: a.id } })).not.toBeNull();
  });
  it("a live account of an ordinary broker, and an id that does not exist", async () => {
    const before = await snapshotOtherTenants();
    const r = await deleteGuestAccount(other.account.id);
    expect(r.deleted).toBe(false);
    expect(r.refused).toMatch(/does not belong to the demo broker/);
    expect((await deleteGuestAccount("no-such-account")).refused).toBe("no such account");
    expect(await snapshotOtherTenants()).toEqual(before);
  });
  it("everything, when the demo tenant is not configured or its broker is missing", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    resetDemoBrokerCache();
    expect((await deleteGuestAccount(guests.stale.account)).refused).toMatch(/DEMO_BROKER_SUBDOMAIN is not set/);
    process.env.DEMO_BROKER_SUBDOMAIN = "no-such-tenant";
    resetDemoBrokerCache();
    expect((await deleteGuestAccount(guests.stale.account)).refused).toMatch(/demo broker was not found/);
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
    resetDemoBrokerCache();
    expect(await prisma.account.findUnique({ where: { id: guests.stale.account } })).not.toBeNull();
  });
  it("a dry run counts what would go and deletes nothing", async () => {
    const r = await deleteGuestAccount(guests.stale.account, { dryRun: true });
    expect(r.deleted).toBe(false);
    expect(r.refused).toBeUndefined();
    expect(r.counts.positions).toBe(1);
    expect(r.counts.orders).toBe(1);
    expect(r.counts.auditLogs).toBeGreaterThanOrEqual(3); // account created + position + order
    expect(await prisma.account.findUnique({ where: { id: guests.stale.account } })).not.toBeNull();
  });
});

describe("the daily run", () => {
  it("deletes the idle and the too-old guest with everything of it, and nothing else anywhere", async () => {
    const before = await snapshotOtherTenants();
    const keptBefore = {
      fresh: await prisma.account.findUniqueOrThrow({ where: { id: guests.fresh.account } }),
      recentOrder: await prisma.position.count({ where: { accountId: guests.recentOrder.account } }),
    };
    const summary = await runDemoCleanup();
    expect(summary).toMatchObject({ dryRun: false, candidates: 2, deleted: 2, failed: 0 });
    expect(summary.refused).toEqual([]);

    for (const gone of ["stale", "tooOld"]) {
      const g = guests[gone];
      expect(await prisma.account.findUnique({ where: { id: g.account } })).toBeNull();
      for (const t of ["position", "order", "transaction", "loginEvent", "watchlistItem", "notification", "postCloseEffect"] as const) {
        const where = t === "position" || t === "order" || t === "transaction" || t === "loginEvent" || t === "watchlistItem" || t === "notification" || t === "postCloseEffect" ? { accountId: g.account } : {};
        // @ts-expect-error dynamic delegate access for the sweep of tables
        expect(await prisma[t].count({ where })).toBe(0);
      }
      expect(await prisma.auditLog.count({ where: { OR: [{ entityId: g.account }, ...(g.position ? [{ entityId: g.position }] : []), ...(g.order ? [{ entityId: g.order }] : [])] } })).toBe(0);
      expect(await verifyAccountSessionToken(g.token!)).toBeNull(); // the session is revoked
      expect(await readDemoState(g.account)).toBeNull(); // so is the replay cursor
    }
    // the guests that must stay are exactly as they were
    for (const keep of ["fresh", "recentLogin", "recentOrder", "sevenDaysExactly"]) {
      expect(await prisma.account.findUnique({ where: { id: guests[keep].account } })).not.toBeNull();
      expect(await verifyAccountSessionToken(guests[keep].token!)).not.toBeNull();
    }
    expect((await prisma.account.findUniqueOrThrow({ where: { id: guests.fresh.account } })).balance.equals(keptBefore.fresh.balance)).toBe(true);
    expect(await prisma.position.count({ where: { accountId: guests.recentOrder.account } })).toBe(keptBefore.recentOrder);
    // the other tenants, the out-of-range account, the in-range foreign account and the shared tables did not change
    expect(await snapshotOtherTenants()).toEqual(before);
    expect(await prisma.account.findUnique({ where: { accountNumber: "48123456" } })).not.toBeNull();
    expect(await prisma.account.findUnique({ where: { accountNumber: "50123456" } })).not.toBeNull();
    // the demo tenant's own configuration survived (symbols, group, the seed's audit row)
    expect(await prisma.brokerSymbol.count({ where: { brokerId: demo.broker.id } })).toBe(7);
    expect(await prisma.group.count({ where: { brokerId: demo.broker.id } })).toBe(1);
  }, 60_000);

  it("a second run finds nothing", async () => {
    expect(await runDemoCleanup()).toMatchObject({ candidates: 0, deleted: 0 });
  });
});

describe("the cron route", () => {
  it("needs the bearer secret, and answers an empty summary where no demo tenant is configured", async () => {
    process.env.CRON_SECRET = "cron-secret-for-test";
    const { GET } = await import("@/app/api/internal/demo-cleanup/route");
    const bad = await GET(new NextRequest("https://x.test/api/internal/demo-cleanup", { headers: { authorization: "Bearer wrong" } }));
    expect(bad.status).toBe(401);
    const none = await GET(new NextRequest("https://x.test/api/internal/demo-cleanup"));
    expect(none.status).toBe(401);
    const ok = await GET(new NextRequest("https://x.test/api/internal/demo-cleanup?dryRun=1", { headers: { authorization: "Bearer cron-secret-for-test" } }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ dryRun: true, deleted: 0 });
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    resetDemoBrokerCache();
    const empty = await GET(new NextRequest("https://x.test/api/internal/demo-cleanup", { headers: { authorization: "Bearer cron-secret-for-test" } }));
    expect(await empty.json()).toMatchObject({ candidates: 0, deleted: 0, swept: null });
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
    resetDemoBrokerCache();
  });
  it("clearDemoState is tolerant of an account with no cursor", async () => {
    await clearDemoState("never-existed");
  });
});
