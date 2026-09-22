import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { onClose, notifyStopOut } from "@/lib/coverage";

const D = (v: string | number) => new Prisma.Decimal(v);
const REPO_ROOT = path.resolve(import.meta.dirname, "..");

// Every committed close in the app must follow through on coverage (lib/coverage.ts onClose), the
// same audit the mirror hook has: a site that closes without calling it leaves an orphan hedge or a
// phantom "covered" flag.
const CLOSE_HOOK_SITES: { file: string; occurrences: number; description: string }[] = [
  { file: "app/api/trade/positions/[id]/close/route.ts", occurrences: 1, description: "client self-close" },
  { file: "lib/risk-monitor.ts", occurrences: 2, description: "SL/TP trigger + stop-out close" },
  { file: "app/api/manage/positions/[id]/close/route.ts", occurrences: 1, description: "dealer-initiated close (incl. a coverage leg by hand)" },
  { file: "app/api/manage/positions/[id]/reverse/route.ts", occurrences: 1, description: "admin reverse -- closed leg" },
  { file: "app/api/manage/positions/[id]/void/route.ts", occurrences: 1, description: "void" },
  { file: "lib/bulk-close.ts", occurrences: 1, description: "bulk close" },
  { file: "lib/queued-close.ts", occurrences: 1, description: "dealer-accepted queued close" },
  { file: "lib/close-by.ts", occurrences: 2, description: "close-by (both legs)" },
];

describe("coverage hook wiring audit (every close call site, static)", () => {
  it.each(CLOSE_HOOK_SITES)("$file calls coverage.onClose for: $description", ({ file, occurrences }) => {
    const content = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const matches = content.match(/coverage\.onClose\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(occurrences);
  });
  it("lib/risk-monitor.ts notifies on every stop-out close", () => {
    const content = readFileSync(path.join(REPO_ROOT, "lib/risk-monitor.ts"), "utf8");
    expect(content).toMatch(/coverage\.notifyStopOut\(/);
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "coveragePositionId" FROM "Position" LIMIT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/coverage.test.ts: DB unreachable -- skipping integration tests");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    }, { timeout: 15000, maxWait: 15000 });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

type Fixture = { brokerId: string; symbolId: string; symbolName: string; clientGroupId: string; clientAccountId: string; clientAccountNumber: string; coverageAccountId: string; coverageAccountNumber: string };

// broker + symbol (bid 1.10000 / ask 1.10020) + a B-book client account + the broker's coverage
// account (pointer stamped on the broker, the way ensureCoverageAccount does it)
async function createFixture(tx: Prisma.TransactionClient, opts?: { dealerReviewed?: boolean }): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `Coverage Test Broker ${suffix}`, subdomain: `covtest-${suffix}` } });
  const symbol = await tx.symbol.create({ data: { name: `TC${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX" } });
  await tx.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await tx.livePrice.create({ data: { symbol: symbol.name, bid: D("1.10000"), ask: D("1.10020") } });
  // dealingMode AUTO = this client's closes are NOT dealer-reviewed (auto-fill): the coverage leg
  // follows the client automatically. MANUAL (opts.dealerReviewed) = the desk closes it by hand.
  const group = await tx.group.create({ data: { brokerId: broker.id, name: `Cov Client Group ${suffix}`, dealingMode: opts?.dealerReviewed ? "MANUAL" : "AUTO" } });
  const client = await tx.account.create({
    data: { brokerId: broker.id, accountNumber: `7${suffix.slice(0, 7)}`, email: `cov-client-${suffix}@test.local`, passwordHash: "x", fullName: "Cov Client", accountMode: "LIVE", groupId: group.id, balance: D(10000) },
  });
  const covGroup = await tx.group.create({ data: { brokerId: broker.id, name: `Dealer Coverage (system) ${suffix}`, category: "COVERAGE", groupType: "COVERAGE", leverage: 500 } });
  const coverage = await tx.account.create({
    data: { brokerId: broker.id, accountNumber: `6${suffix.slice(0, 7)}`, email: `cov-acct-${suffix}@test.local`, passwordHash: "x", fullName: "Dealer Coverage", accountMode: "LIVE", groupId: covGroup.id, balance: D(0) },
  });
  await tx.broker.update({ where: { id: broker.id }, data: { coverageAccountId: coverage.id } });
  return { brokerId: broker.id, symbolId: symbol.id, symbolName: symbol.name, clientGroupId: group.id, clientAccountId: client.id, clientAccountNumber: client.accountNumber, coverageAccountId: coverage.id, coverageAccountNumber: coverage.accountNumber };
}

async function createPosition(tx: Prisma.TransactionClient, fx: Fixture, p: { accountId: string; side: "BUY" | "SELL"; volume: string; openPrice: string; bookType?: "A_BOOK" | "B_BOOK"; status?: "OPEN" | "CLOSED" }) {
  const order = await tx.order.create({
    data: { brokerId: fx.brokerId, accountId: p.accountId, symbolId: fx.symbolId, side: p.side, type: "MARKET", volume: D(p.volume), status: "FILLED", filledPrice: D(p.openPrice), filledAt: new Date(), idempotencyKey: `cov:${randomUUID()}` },
  });
  return tx.position.create({
    data: { brokerId: fx.brokerId, accountId: p.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: p.side, volume: D(p.volume), openPrice: D(p.openPrice), status: p.status ?? "OPEN", bookType: p.bookType ?? "B_BOOK" },
  });
}

// BOOK NOW's own effect: the same-side leg on the coverage account + the link on the client position
async function book(tx: Prisma.TransactionClient, fx: Fixture, clientPositionId: string, side: "BUY" | "SELL", volume: string) {
  const leg = await createPosition(tx, fx, { accountId: fx.coverageAccountId, side, volume, openPrice: side === "BUY" ? "1.10020" : "1.10000", bookType: "A_BOOK" });
  await tx.position.update({ where: { id: clientPositionId }, data: { covered: true, coveredAt: new Date(), coveragePositionId: leg.id } });
  return leg;
}

describe("lib/coverage.ts onClose -- client leg closed (live DB, rolled back)", () => {
  it("closes the linked coverage leg in full at the live market when the client closes in full", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      // the client's own close has already committed (status CLOSED) when the hook runs
      await tx.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("1.10000"), closedAt: new Date() } });

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });

      const legAfter = await tx.position.findUniqueOrThrow({ where: { id: leg.id } });
      expect(legAfter.status).toBe("CLOSED");
      expect(legAfter.closePrice?.toString()).toBe("1.1"); // BUY closes at bid
      const audit = await tx.auditLog.findFirst({ where: { entityId: leg.id, action: "POSITION_COVERAGE_AUTO_CLOSED" } });
      expect(audit).not.toBeNull();
      // the coverage account realised the leg's P&L (-2.00 on 1 lot of a 100k contract, 2 pips)
      const trx = await tx.transaction.findFirst({ where: { referenceId: leg.id, type: "TRADE_PNL" } });
      expect(trx).not.toBeNull();
      expect(trx!.note).toMatch(/Coverage auto-close/);
    });
  });

  it("closes the coverage leg proportionally on a partial client close", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "SELL", volume: "2", openPrice: "1.10000" });
      const leg = await book(tx, fx, client.id, "SELL", "2");
      await tx.position.update({ where: { id: client.id }, data: { volume: D("1.5") } }); // partial 0.5 of 2 already applied

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D("0.5"), sourceVolumeBeforeClose: D(2), reason: "manual" });

      const legAfter = await tx.position.findUniqueOrThrow({ where: { id: leg.id } });
      expect(legAfter.status).toBe("OPEN");
      expect(legAfter.volume.toString()).toBe("1.5");
    });
  });

  it("is a no-op when the dealer already closed the coverage leg before the client did", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      await tx.position.update({ where: { id: leg.id }, data: { status: "CLOSED", closePrice: D("1.10000"), closedAt: new Date() } });
      const before = await tx.auditLog.count({ where: { brokerId: fx.brokerId } });

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });

      expect(await tx.auditLog.count({ where: { brokerId: fx.brokerId } })).toBe(before);
      expect(await tx.notification.count({ where: { brokerId: fx.brokerId } })).toBe(0);
    });
  });

  it("does nothing for an unbooked position", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });
      expect(await tx.auditLog.count({ where: { brokerId: fx.brokerId } })).toBe(0);
    });
  });
});

describe("lib/coverage.ts onClose -- coverage leg closed (live DB, rolled back)", () => {
  it("releases the client position (covered=false, link cleared) and notifies the dealer on a coverage stop-out", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      await tx.position.update({ where: { id: leg.id }, data: { status: "CLOSED", closePrice: D("1.09000"), closedAt: new Date() } });

      await onClose(tx, { positionId: leg.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "stop_out", marginLevel: "12.50" });

      const clientAfter = await tx.position.findUniqueOrThrow({ where: { id: client.id } });
      expect(clientAfter.status).toBe("OPEN");
      expect(clientAfter.covered).toBe(false);
      expect(clientAfter.coveragePositionId).toBeNull();
      const n = await tx.notification.findFirst({ where: { brokerId: fx.brokerId, type: "COVERAGE_STOP_OUT" } });
      expect(n).not.toBeNull();
      expect(n!.title).toContain(`Coverage stop-out: position #${leg.ticket} closed`);
      expect(n!.body).toContain(`Client ${fx.clientAccountNumber} #${client.ticket}`);
      expect(n!.body).toContain("UNHEDGED");
      expect(n!.accountId).toBeNull(); // staff-facing, not a trader copy
      const audit = await tx.auditLog.findFirst({ where: { entityId: client.id, action: "POSITION_COVERAGE_RELEASED" } });
      expect(audit).not.toBeNull();
    });
  });

  it("releases the client with a COVERAGE_RELEASED notification when the dealer closes the leg by hand", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "SELL", volume: "0.5", openPrice: "1.10000" });
      const leg = await book(tx, fx, client.id, "SELL", "0.5");
      await tx.position.update({ where: { id: leg.id }, data: { status: "CLOSED", closePrice: D("1.10020"), closedAt: new Date() } });

      await onClose(tx, { positionId: leg.id, brokerId: fx.brokerId, closedLots: D("0.5"), sourceVolumeBeforeClose: D("0.5"), reason: "manual" });

      const clientAfter = await tx.position.findUniqueOrThrow({ where: { id: client.id } });
      expect(clientAfter.covered).toBe(false);
      expect(await tx.notification.count({ where: { brokerId: fx.brokerId, type: "COVERAGE_RELEASED" } })).toBe(1);
    });
  });

  it("leaves a CLOSED client alone when its leg closes afterwards (nothing to release)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020", status: "CLOSED" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      await tx.position.update({ where: { id: leg.id }, data: { status: "CLOSED", closedAt: new Date() } });
      await onClose(tx, { positionId: leg.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });
      const clientAfter = await tx.position.findUniqueOrThrow({ where: { id: client.id } });
      expect(clientAfter.covered).toBe(true); // history keeps the link
      expect(await tx.notification.count({ where: { brokerId: fx.brokerId } })).toBe(0);
    });
  });
});

describe("lib/coverage.ts notifyStopOut (live DB, rolled back)", () => {
  it("writes a COVERAGE_STOP_OUT for the coverage account and a plain STOP_OUT for a client", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      await notifyStopOut(tx, { brokerId: fx.brokerId, accountId: fx.coverageAccountId, accountNumber: fx.coverageAccountNumber, positionId: randomUUID(), ticket: 4242, symbol: fx.symbolName, side: "BUY", volume: "1", marginLevel: "3.10", stopOutLevel: "50" });
      await notifyStopOut(tx, { brokerId: fx.brokerId, accountId: fx.clientAccountId, accountNumber: fx.clientAccountNumber, positionId: randomUUID(), ticket: 4243, symbol: fx.symbolName, side: "SELL", volume: "2", marginLevel: "40.00", stopOutLevel: "50" });
      const cov = await tx.notification.findFirst({ where: { brokerId: fx.brokerId, type: "COVERAGE_STOP_OUT" } });
      expect(cov?.title).toBe("Coverage stop-out: position #4242 closed");
      expect(cov?.body).toContain("run out of balance");
      const cli = await tx.notification.findFirst({ where: { brokerId: fx.brokerId, type: "STOP_OUT" } });
      expect(cli?.title).toBe(`Stop-out: ${fx.clientAccountNumber} #4243 closed`);
    });
  });
});

describe("lib/coverage.ts onClose -- coverage close respects dealer mode (live DB, rolled back)", () => {
  it("leaves the coverage leg OPEN and tells the dealer when the client's account is dealer-reviewed", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { dealerReviewed: true });
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      await tx.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("1.10000"), closedAt: new Date() } });

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });

      // the hedge is still the dealer's to close
      const legAfter = await tx.position.findUniqueOrThrow({ where: { id: leg.id } });
      expect(legAfter.status).toBe("OPEN");
      expect(legAfter.volume.toString()).toBe("1");
      expect(legAfter.closePrice).toBeNull();
      // nothing was realised on the coverage account
      expect(await tx.transaction.count({ where: { referenceId: leg.id, type: "TRADE_PNL" } })).toBe(0);
      // and the desk was told, with the leg's live P&L against that order
      const n = await tx.notification.findFirstOrThrow({ where: { brokerId: fx.brokerId, type: "COVERAGE_CLOSE_AWAITING_DEALER" } });
      expect(n.title).toContain(`Client closed #${client.ticket}`);
      expect(n.body).toContain(`coverage leg #${leg.ticket}`);
      expect(n.body).toMatch(/is at [+-]?\d+\.\d{2} against that order/);
      const audit = await tx.auditLog.findFirst({ where: { entityId: leg.id, action: "POSITION_COVERAGE_CLOSE_AWAITING_DEALER" } });
      expect(audit).not.toBeNull();
      // explicitly NOT the auto-close path
      expect(await tx.auditLog.count({ where: { entityId: leg.id, action: "POSITION_COVERAGE_AUTO_CLOSED" } })).toBe(0);
    });
  });

  it("auto-closes the leg when the client's account is in auto-fill (dealer review off)", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx, { dealerReviewed: false });
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "BUY", volume: "1", openPrice: "1.10020" });
      const leg = await book(tx, fx, client.id, "BUY", "1");
      await tx.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("1.10000"), closedAt: new Date() } });

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });

      const legAfter = await tx.position.findUniqueOrThrow({ where: { id: leg.id } });
      expect(legAfter.status).toBe("CLOSED");
      const audit = await tx.auditLog.findFirst({ where: { entityId: leg.id, action: "POSITION_COVERAGE_AUTO_CLOSED" } });
      expect(audit).not.toBeNull();
      expect(await tx.notification.count({ where: { brokerId: fx.brokerId, type: "COVERAGE_CLOSE_AWAITING_DEALER" } })).toBe(0);
      const trx = await tx.transaction.findFirstOrThrow({ where: { referenceId: leg.id, type: "TRADE_PNL" } });
      expect(trx.note).toMatch(/auto-fill/);
    });
  });

  it("a broker-wide dealing mode also holds the leg, even on an INHERIT group", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      // group left at the fixture's AUTO -> flip it to INHERIT and turn the broker-wide switch on
      await tx.group.update({ where: { id: fx.clientGroupId }, data: { dealingMode: "INHERIT" } });
      await tx.broker.update({ where: { id: fx.brokerId }, data: { dealingModeAt: new Date() } });
      const client = await createPosition(tx, fx, { accountId: fx.clientAccountId, side: "SELL", volume: "1", openPrice: "1.10000" });
      const leg = await book(tx, fx, client.id, "SELL", "1");
      await tx.position.update({ where: { id: client.id }, data: { status: "CLOSED", closePrice: D("1.10020"), closedAt: new Date() } });

      await onClose(tx, { positionId: client.id, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1), reason: "manual" });

      expect((await tx.position.findUniqueOrThrow({ where: { id: leg.id } })).status).toBe("OPEN");
      expect(await tx.notification.count({ where: { brokerId: fx.brokerId, type: "COVERAGE_CLOSE_AWAITING_DEALER" } })).toBe(1);
    });
  });
});
