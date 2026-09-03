import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { matchesSymbolFilter, roundMirrorVolume, computeProportionalCloseVolume, onFill, onClose, type MirrorSourcePosition } from "@/lib/mirror";
import { computeRealizedPnl } from "@/lib/trading";

const D = (v: string | number) => new Prisma.Decimal(v);

// ---------------------------------------------------------------------------
// Wiring audit -- static, no DB, always runs. This repo has no HTTP/route-
// level test harness (no route handler anywhere is under test -- confirmed
// by grep before writing this file), so a real "does hitting this endpoint
// actually mirror the fill" test would mean building session-mocking
// infrastructure from scratch, well beyond this fix's scope. What IS cheap
// and genuinely worth having: a regression guard that fails loudly the
// moment someone edits one of these files and drops the mirror call --
// exactly the silent-gap class of bug this whole fix responds to (a real
// dealer-accept fill went unmirrored with zero trace). Every entry below is
// a fill or close call site enumerated by reading each file directly.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(import.meta.dirname, "..");

function readRepoFile(relativePath: string): string {
  return readFileSync(path.join(REPO_ROOT, relativePath), "utf8");
}

const FILL_HOOK_SITES: { file: string; occurrences: number; description: string }[] = [
  { file: "app/api/trade/orders/route.ts", occurrences: 2, description: "direct MARKET fill + Smart Dealer auto-accept" },
  { file: "app/api/manage/dealing-queue/[id]/route.ts", occurrences: 1, description: "dealer ACCEPT" },
  { file: "app/api/trade/orders/[id]/requote-response/route.ts", occurrences: 1, description: "client accepts a requote" },
  { file: "app/api/trade/orders/[id]/fill/route.ts", occurrences: 1, description: "pending LIMIT/STOP trigger fill" },
  { file: "app/api/manage/positions/route.ts", occurrences: 1, description: "admin manual open (execute for client)" },
  { file: "app/api/manage/positions/[id]/reverse/route.ts", occurrences: 1, description: "admin reverse -- new leg" },
];

const CLOSE_HOOK_SITES: { file: string; occurrences: number; description: string }[] = [
  { file: "app/api/trade/positions/[id]/close/route.ts", occurrences: 1, description: "client self-close" },
  { file: "lib/risk-monitor.ts", occurrences: 2, description: "SL/TP trigger + stop-out close" },
  { file: "app/api/manage/positions/[id]/close/route.ts", occurrences: 1, description: "dealer-initiated close" },
  { file: "app/api/manage/positions/[id]/reverse/route.ts", occurrences: 1, description: "admin reverse -- closed leg" },
  { file: "app/api/manage/positions/[id]/void/route.ts", occurrences: 1, description: "void of a manually-opened, mirrored position" },
];

describe("mirror hook wiring audit (every fill/close call site, static)", () => {
  it.each(FILL_HOOK_SITES)("$file calls mirror.onFill*/onFillPosition for: $description", ({ file, occurrences }) => {
    const content = readRepoFile(file);
    const matches = content.match(/mirror\.onFill(Position)?\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(occurrences);
  });

  it.each(CLOSE_HOOK_SITES)("$file calls mirror.onClose for: $description", ({ file, occurrences }) => {
    const content = readRepoFile(file);
    const matches = content.match(/mirror\.onClose\(/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(occurrences);
  });
});

// ---------------------------------------------------------------------------
// Pure functions -- no DB, always run. Same convention as lib/risk.test.ts /
// lib/margin.test.ts (no DOM/integration infra in this repo before this file).
// ---------------------------------------------------------------------------

describe("matchesSymbolFilter", () => {
  it("matches every symbol when the filter is null, undefined, or blank", () => {
    expect(matchesSymbolFilter(null, "XAUUSD")).toBe(true);
    expect(matchesSymbolFilter(undefined, "XAUUSD")).toBe(true);
    expect(matchesSymbolFilter("  ", "XAUUSD")).toBe(true);
  });

  it("matches only symbols in the CSV allowlist, case-insensitively", () => {
    expect(matchesSymbolFilter("XAUUSD,EURUSD", "xauusd")).toBe(true);
    expect(matchesSymbolFilter("XAUUSD,EURUSD", "EURUSD")).toBe(true);
    expect(matchesSymbolFilter("XAUUSD,EURUSD", "GBPUSD")).toBe(false);
  });

  it("tolerates stray whitespace around CSV entries", () => {
    expect(matchesSymbolFilter(" XAUUSD , EURUSD ", "EURUSD")).toBe(true);
  });
});

describe("roundMirrorVolume", () => {
  it("scales by the multiplier and rounds to the nearest lot step", () => {
    // 1.00 * 0.5 = 0.50, already on a 0.01 step
    expect(roundMirrorVolume(D(1), D(0.5), D(0.01), D(100), D(0.01)).toString()).toBe("0.5");
  });

  it("rounds a non-step-aligned result to the nearest lot step", () => {
    // 1.00 * 0.33 = 0.33 -> nearest 0.1 step is 0.3
    expect(roundMirrorVolume(D(1), D(0.33), D(0.1), D(100), D(0.1)).toString()).toBe("0.3");
  });

  it("clamps up to minLot rather than mirroring nothing", () => {
    // 0.10 * 0.01 = 0.001, far below the 0.01 minLot
    expect(roundMirrorVolume(D(0.1), D(0.01), D(0.01), D(100), D(0.01)).toString()).toBe("0.01");
  });

  it("clamps down to maxLot when the scaled volume would exceed it", () => {
    expect(roundMirrorVolume(D(500), D(1), D(0.01), D(100), D(0.01)).toString()).toBe("100");
  });

  it("falls back to a plain clamp (no stepping) when lotStep is zero or negative", () => {
    expect(roundMirrorVolume(D(5), D(1), D(1), D(10), D(0)).toString()).toBe("5");
  });
});

describe("computeProportionalCloseVolume", () => {
  it("closes the target proportionally to a partial source close", () => {
    // half the source closed -> half the target closes
    expect(computeProportionalCloseVolume(D(0.5), D(1), D(2)).toString()).toBe("1");
  });

  it("fully closes the target when the source is fully closed", () => {
    expect(computeProportionalCloseVolume(D(1), D(1), D(2)).toString()).toBe("2");
  });

  it("never leaves an unclosable sliver when the closed lots slightly overshoot the source's own volume (float-safety edge)", () => {
    // closedLots > sourceVolumeBeforeClose -- proportion > 1 -- must fully
    // close the target rather than something above 100% of it.
    expect(computeProportionalCloseVolume(D("1.0000001"), D(1), D(2)).toString()).toBe("2");
  });

  it("treats a zero-or-less source volume as a full close (defensive, shouldn't happen in practice)", () => {
    expect(computeProportionalCloseVolume(D(1), D(0), D(2)).toString()).toBe("2");
  });
});

// ---------------------------------------------------------------------------
// Integration tests against the real dev database, gated on reachability
// (this repo's dev DATABASE_URL is the same live Prisma Postgres instance
// production uses -- see project memory -- so every fixture here is created
// and asserted on INSIDE one outer prisma.$transaction per test, then rolled
// back via a deliberate throw at the end, exactly like the migration's own
// verify-then-rollback script. Nothing here ever commits.
// ---------------------------------------------------------------------------

let dbReachable = false;

beforeAll(async () => {
  try {
    // Not just a bare connectivity check -- this repo's dev DATABASE_URL is
    // reachable well before a given mirror migration has actually been
    // applied to it (deliberately held back for review before each
    // deploy). Probing MirrorRule.fillPriceMode specifically (not just the
    // table) means these tests skip cleanly pre-migration and start
    // running for real the moment it's applied, rather than red-failing
    // every run in between.
    await prisma.$queryRaw`SELECT "fillPriceMode" FROM "MirrorRule" LIMIT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/mirror.test.ts: DB unreachable or a mirror migration not yet applied -- skipping integration tests");
  }
});

afterAll(async () => {
  await prisma.$disconnect();
});

class RollbackSignal extends Error {}

// Runs `fn` inside one interactive transaction, then always rolls it back --
// `fn`'s own fixture writes and the onFill/onClose calls it makes all share
// this one transaction (see lib/mirror.ts's withTx, which runs directly
// against an already-open Prisma.TransactionClient instead of opening a
// nested one). A real assertion failure inside `fn` propagates out normally
// since only RollbackSignal is swallowed below.
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

type Fixture = {
  brokerId: string;
  adminId: string;
  symbolId: string;
  symbolName: string;
  groupId: string;
  sourceAccountId: string;
  targetAccountId: string;
};

// A fresh broker/admin/symbol/group/source-account/target-account for every
// test -- random suffixes throughout so this never collides with real
// production rows (accountNumber/subdomain/email/Symbol.name are all
// globally unique columns).
async function createFixture(
  tx: Prisma.TransactionClient,
  opts?: { symbolPrice?: { bid: string; ask: string } | null }
): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);

  const broker = await tx.broker.create({
    data: { name: `Mirror Test Broker ${suffix}`, subdomain: `mirrortest-${suffix}` },
  });
  const admin = await tx.adminUser.create({
    data: { brokerId: broker.id, email: `mirror-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  const symbol = await tx.symbol.create({
    data: { name: `TS${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "FOREX" },
  });
  await tx.brokerSymbol.create({
    data: {
      brokerId: broker.id,
      symbolId: symbol.id,
      minLot: D(0.01),
      maxLot: D(100),
      lotStep: D(0.01),
      tradingMode: "BOTH",
    },
  });
  if (opts?.symbolPrice !== null) {
    const price = opts?.symbolPrice ?? { bid: "1.10000", ask: "1.10020" };
    await tx.livePrice.create({ data: { symbol: symbol.name, bid: D(price.bid), ask: D(price.ask) } });
  }
  const group = await tx.group.create({ data: { brokerId: broker.id, name: `Mirror Source Group ${suffix}` } });
  const sourceAccount = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `9${suffix.slice(0, 7)}`,
      email: `mirror-source-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Mirror Source",
      accountMode: "LIVE",
      groupId: group.id,
      balance: D(10000),
    },
  });
  const targetAccount = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `8${suffix.slice(0, 7)}`,
      email: `mirror-target-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "Mirror Target (Master)",
      accountMode: "LIVE",
      balance: D(100000),
    },
  });

  return {
    brokerId: broker.id,
    adminId: admin.id,
    symbolId: symbol.id,
    symbolName: symbol.name,
    groupId: group.id,
    sourceAccountId: sourceAccount.id,
    targetAccountId: targetAccount.id,
  };
}

async function createRule(
  tx: Prisma.TransactionClient,
  fx: Fixture,
  overrides?: Partial<{
    symbolFilter: string | null;
    maxOpenLots: string | null;
    maxDailyLoss: string | null;
    multiplier: string;
    enabled: boolean;
    killedAt: Date | null;
    fillPriceMode: "SOURCE_PRICE" | "MARKET";
  }>
) {
  return tx.mirrorRule.create({
    data: {
      brokerId: fx.brokerId,
      sourceType: "GROUP",
      sourceId: fx.groupId,
      targetAccountId: fx.targetAccountId,
      direction: "REVERSE",
      multiplier: D(overrides?.multiplier ?? "1"),
      symbolFilter: overrides?.symbolFilter ?? null,
      maxOpenLots: overrides?.maxOpenLots != null ? D(overrides.maxOpenLots) : null,
      maxDailyLoss: overrides?.maxDailyLoss != null ? D(overrides.maxDailyLoss) : null,
      enabled: overrides?.enabled ?? true,
      killedAt: overrides?.killedAt ?? null,
      // Explicit even though the schema column itself defaults to
      // SOURCE_PRICE too -- every existing test that cares about MARKET's
      // live-bid/ask behavior opts in explicitly below, so a future
      // schema-default change can't silently flip what these tests mean.
      fillPriceMode: overrides?.fillPriceMode ?? "SOURCE_PRICE",
      createdById: fx.adminId,
    },
  });
}

// Creates a real Order + Position pair directly (bypassing openPositionFromOrder,
// which needs a live pricing/margin round trip this helper doesn't) -- used to
// seed a pre-existing mirrored position for the kill-switch and onClose tests.
async function createManualPosition(
  tx: Prisma.TransactionClient,
  fx: Fixture,
  params: { accountId: string; side: "BUY" | "SELL"; volume: string; openPrice: string; status?: "OPEN" | "CLOSED" }
) {
  const order = await tx.order.create({
    data: {
      brokerId: fx.brokerId,
      accountId: params.accountId,
      symbolId: fx.symbolId,
      side: params.side,
      type: "MARKET",
      volume: D(params.volume),
      status: "FILLED",
      filledPrice: D(params.openPrice),
      filledAt: new Date(),
      idempotencyKey: `manual:${randomUUID()}`,
    },
  });
  return tx.position.create({
    data: {
      brokerId: fx.brokerId,
      accountId: params.accountId,
      symbolId: fx.symbolId,
      originOrderId: order.id,
      side: params.side,
      volume: D(params.volume),
      openPrice: D(params.openPrice),
      status: params.status ?? "OPEN",
    },
  });
}

function sourcePosition(fx: Fixture, overrides?: Partial<MirrorSourcePosition>): MirrorSourcePosition {
  return {
    id: randomUUID(),
    brokerId: fx.brokerId,
    accountId: fx.sourceAccountId,
    symbolId: fx.symbolId,
    symbolName: fx.symbolName,
    side: "BUY",
    volume: D(1),
    openPrice: D("1.10020"), // matches createFixture's own default ask -- a real BUY naturally fills there
    ...overrides,
  };
}

// Plain describe, not describe.skipIf -- skipIf's condition is evaluated at
// collection time, before beforeAll (where dbReachable is actually
// determined) has run, so it would always see the initial `false`. Each
// test below guards itself with `if (!dbReachable) return;` instead, which
// runs after beforeAll and skips real work safely without ever failing.
describe("lib/mirror.ts onFill (live DB, rolled back)", () => {
  it("MARKET mode: mirrors a fill in a source group as a REVERSED fill on the target at live server price", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx, { fillPriceMode: "MARKET" });
      const source = sourcePosition(fx, { side: "BUY", volume: D(1) });

      await onFill(tx, source);

      const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      expect(link).not.toBeNull();
      expect(link!.ruleId).toBe(rule.id);

      const targetPosition = await tx.position.findUnique({ where: { id: link!.targetPositionId } });
      expect(targetPosition).not.toBeNull();
      expect(targetPosition!.accountId).toBe(fx.targetAccountId);
      expect(targetPosition!.side).toBe("SELL"); // REVERSE of the source's BUY
      expect(targetPosition!.volume.toString()).toBe("1");
      // SELL side + zero spreadMarkup on this fixture's BrokerSymbol -> the
      // raw server bid, unmarked-up (lib/group-pricing.ts's applySpreadMarkup).
      expect(targetPosition!.openPrice.toString()).toBe("1.1");

      const audit = await tx.auditLog.findFirst({ where: { entityId: targetPosition!.id, action: "MIRROR_FILLED" } });
      expect(audit).not.toBeNull();
    });
  });

  it("applies the rule's multiplier and rounds to the target symbol's lot step", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      await createRule(tx, fx, { multiplier: "0.5" });
      const source = sourcePosition(fx, { volume: D(1) });

      await onFill(tx, source);

      const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      const targetPosition = await tx.position.findUnique({ where: { id: link!.targetPositionId } });
      expect(targetPosition!.volume.toString()).toBe("0.5");
    });
  });

  it("skips a symbol excluded by the rule's symbolFilter -- no mirror at all", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      await createRule(tx, fx, { symbolFilter: "SOMEOTHERSYMBOL" });
      const source = sourcePosition(fx);

      await onFill(tx, source);

      const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      expect(link).toBeNull();
    });
  });

  it("is idempotent -- calling onFill twice for the same source position only ever produces one mirror", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      await createRule(tx, fx);
      const source = sourcePosition(fx);

      await onFill(tx, source);

      // The retry's duplicate MirrorLink insert really does hit Postgres's
      // unique constraint (that's the whole point) -- production is fine
      // because withTx opens a real nested sub-transaction there, which
      // contains the failure to just that sub-transaction. Here `tx` is
      // already an open transaction (this test's own outer rollback), so
      // withTx deliberately does NOT nest one (see its own comment) --
      // meaning the constraint violation would otherwise abort this whole
      // shared transaction. A manual savepoint reproduces the same
      // containment a real nested transaction would have given us.
      await tx.$executeRawUnsafe("SAVEPOINT idempotency_retry");
      try {
        await onFill(tx, source); // retry of the exact same fill event
      } finally {
        await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT idempotency_retry");
      }

      const links = await tx.mirrorLink.findMany({ where: { sourcePositionId: source.id } });
      expect(links).toHaveLength(1);

      const targetPositions = await tx.position.findMany({ where: { accountId: fx.targetAccountId } });
      expect(targetPositions).toHaveLength(1);
    });
  });

  it("kills the rule and places no order once maxOpenLots is already at/over cap", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx, { maxOpenLots: "0.5" });

      // Pre-existing mirrored position already at the cap.
      const existingTarget = await createManualPosition(tx, fx, { accountId: fx.targetAccountId, side: "SELL", volume: "1", openPrice: "1.1" });
      await tx.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: randomUUID(), targetPositionId: existingTarget.id } });

      const source = sourcePosition(fx); // a brand-new fill attempt

      await onFill(tx, source);

      const newLink = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      expect(newLink).toBeNull(); // no order placed for this fill

      const refreshedRule = await tx.mirrorRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(refreshedRule.enabled).toBe(false);
      expect(refreshedRule.killedAt).not.toBeNull();

      const killAudit = await tx.auditLog.findFirst({ where: { entityId: rule.id, action: "MIRROR_KILL_SWITCH" } });
      expect(killAudit).not.toBeNull();
      const notification = await tx.notification.findFirst({ where: { brokerId: fx.brokerId, type: "MIRROR_KILL_SWITCH", entityId: rule.id } });
      expect(notification).not.toBeNull();
    });
  });

  it("MARKET mode: a mirror-side rejection never throws out to the caller, and never affects the client's own fill", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      // No LivePrice row for this fixture's symbol -- forces the "no live
      // price for symbol" rejection branch inside mirrorFillForRule. Only
      // reachable in MARKET mode -- SOURCE_PRICE never looks at LivePrice
      // at all (see the dedicated test for that below).
      const fx = await createFixture(tx, { symbolPrice: null });
      const rule = await createRule(tx, fx, { fillPriceMode: "MARKET" });
      const source = sourcePosition(fx);

      await expect(onFill(tx, source)).resolves.toBeUndefined(); // never throws

      const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      expect(link).toBeNull();

      const refreshedRule = await tx.mirrorRule.findUniqueOrThrow({ where: { id: rule.id } });
      expect(refreshedRule.failureCount).toBe(1);

      const failureAudit = await tx.auditLog.findFirst({ where: { entityId: rule.id, action: "MIRROR_FAILED" } });
      expect(failureAudit).not.toBeNull();
    });
  });

  it("logs MIRROR_SKIPPED_RULE_DISABLED and mirrors nothing when a matching rule is manually disabled", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx, { enabled: false });
      const source = sourcePosition(fx);

      await onFill(tx, source);

      const link = await tx.mirrorLink.findUnique({ where: { sourcePositionId: source.id } });
      expect(link).toBeNull();

      const skipAudit = await tx.auditLog.findFirst({ where: { entityId: rule.id, action: "MIRROR_SKIPPED_RULE_DISABLED" } });
      expect(skipAudit).not.toBeNull();
      expect((skipAudit!.newValue as { reason?: string } | null)?.reason).toBe("rule manually disabled");
    });
  });

  it("logs MIRROR_SKIPPED_RULE_DISABLED with a kill-switch reason when a matching rule was killed", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx, { enabled: false, killedAt: new Date() });
      const source = sourcePosition(fx);

      await onFill(tx, source);

      const skipAudit = await tx.auditLog.findFirst({ where: { entityId: rule.id, action: "MIRROR_SKIPPED_RULE_DISABLED" } });
      expect(skipAudit).not.toBeNull();
      expect((skipAudit!.newValue as { reason?: string } | null)?.reason).toBe("rule killed by kill-switch");
    });
  });

  it("does not log MIRROR_SKIPPED_RULE_DISABLED for a disabled rule whose symbolFilter wouldn't have matched anyway", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx, { enabled: false, symbolFilter: "SOMEOTHERSYMBOL" });
      const source = sourcePosition(fx);

      await onFill(tx, source);

      const skipAudit = await tx.auditLog.findFirst({ where: { entityId: rule.id, action: "MIRROR_SKIPPED_RULE_DISABLED" } });
      expect(skipAudit).toBeNull();
    });
  });

  it("SOURCE_PRICE (default): fills the mirror at exactly the source's own openPrice, no live price needed at all", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      // No LivePrice row for this fixture's symbol at all -- proves
      // SOURCE_PRICE genuinely never reads it, unlike MARKET mode (see
      // that mode's own "no live price" rejection test above).
      const fx = await createFixture(tx, { symbolPrice: null });
      await createRule(tx, fx); // default fillPriceMode: SOURCE_PRICE
      const sourceOpenPrice = D("97.531");
      const source = sourcePosition(fx, { side: "BUY", openPrice: sourceOpenPrice });

      await onFill(tx, source);

      const link = await tx.mirrorLink.findUniqueOrThrow({ where: { sourcePositionId: source.id } });
      const targetPosition = await tx.position.findUniqueOrThrow({ where: { id: link.targetPositionId } });
      expect(targetPosition.side).toBe("SELL"); // REVERSE of the source's BUY
      // Exactly the source's own price -- no live bid/ask, no spread markup.
      expect(targetPosition.openPrice.toString()).toBe(sourceOpenPrice.toString());

      const audit = await tx.auditLog.findFirst({ where: { entityId: targetPosition.id, action: "MIRROR_FILLED" } });
      expect((audit!.newValue as { fillPriceMode?: string })?.fillPriceMode).toBe("SOURCE_PRICE");
    });
  });

  it("round trip: under SOURCE_PRICE (default), the master's realized P/L is exactly the negative of the client's own P/L", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx); // has a real LivePrice row too -- irrelevant under SOURCE_PRICE, proving the price mode (not feed availability) drives this
      await createRule(tx, fx); // default fillPriceMode: SOURCE_PRICE
      const sourceOpenPrice = D("100.00");
      const sourceClosePrice = D("105.00"); // a real market move between open and close
      // Small enough that the required margin (contractSize * volume *
      // price / leverage) stays well inside the target account's fixture
      // balance -- contractSize defaults to 100000 (Symbol's own schema
      // default), leverage to 100, so 0.1 lots @ ~100 is ~$10,000 margin
      // against a $100,000 balance.
      const volume = D("0.1");
      const source = sourcePosition(fx, { side: "BUY", volume, openPrice: sourceOpenPrice });

      await onFill(tx, source);
      const link = await tx.mirrorLink.findUniqueOrThrow({ where: { sourcePositionId: source.id } });
      const targetAfterOpen = await tx.position.findUniqueOrThrow({ where: { id: link.targetPositionId } });
      expect(targetAfterOpen.openPrice.toString()).toBe(sourceOpenPrice.toString());

      await onClose(tx, {
        positionId: source.id,
        brokerId: fx.brokerId,
        closedLots: volume,
        sourceVolumeBeforeClose: volume,
        closePrice: sourceClosePrice,
      });

      const targetAfterClose = await tx.position.findUniqueOrThrow({ where: { id: link.targetPositionId } });
      expect(targetAfterClose.status).toBe("CLOSED");
      // Exactly the source's own close price -- unadjusted for the
      // target's reversed side, which is precisely what makes the P/L
      // negation below exact rather than approximate.
      expect(targetAfterClose.closePrice?.toString()).toBe(sourceClosePrice.toString());

      const symbol = await tx.symbol.findUniqueOrThrow({ where: { id: fx.symbolId } });
      const clientPnl = computeRealizedPnl({
        side: "BUY",
        openPrice: sourceOpenPrice,
        closePrice: sourceClosePrice,
        volume,
        contractSize: symbol.contractSize,
      });
      const masterPnl = targetAfterClose.realizedPnl!;
      expect(masterPnl.toString()).toBe(clientPnl.neg().toString());
      expect(masterPnl.gt(0)).toBe(false); // sanity: client was profitable (BUY, price rose), so master must be negative
      expect(clientPnl.gt(0)).toBe(true);

      const closeAudit = await tx.auditLog.findFirst({ where: { entityId: targetAfterClose.id, action: "MIRROR_CLOSED" } });
      expect((closeAudit!.newValue as { fillPriceMode?: string })?.fillPriceMode).toBe("SOURCE_PRICE");
    });
  });
});

describe("lib/mirror.ts onClose (live DB, rolled back)", () => {
  it("partially closes the linked target position proportionally to the source's partial close", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx);
      const sourcePositionId = randomUUID();
      const targetPosition = await createManualPosition(tx, fx, { accountId: fx.targetAccountId, side: "SELL", volume: "1", openPrice: "1.1" });
      await tx.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId, targetPositionId: targetPosition.id } });

      await onClose(tx, { positionId: sourcePositionId, brokerId: fx.brokerId, closedLots: D(0.5), sourceVolumeBeforeClose: D(1) });

      const refreshedTarget = await tx.position.findUniqueOrThrow({ where: { id: targetPosition.id } });
      expect(refreshedTarget.status).toBe("OPEN"); // partial close keeps it open
      expect(refreshedTarget.volume.toString()).toBe("0.5");

      const closeAudit = await tx.auditLog.findFirst({ where: { entityId: targetPosition.id, action: "MIRROR_CLOSED" } });
      expect(closeAudit).not.toBeNull();
    });
  });

  it("fully closes the linked target position when the source is fully closed", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx);
      const sourcePositionId = randomUUID();
      const targetPosition = await createManualPosition(tx, fx, { accountId: fx.targetAccountId, side: "SELL", volume: "1", openPrice: "1.1" });
      await tx.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId, targetPositionId: targetPosition.id } });

      await onClose(tx, { positionId: sourcePositionId, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1) });

      const refreshedTarget = await tx.position.findUniqueOrThrow({ where: { id: targetPosition.id } });
      expect(refreshedTarget.status).toBe("CLOSED");
    });
  });

  it("is a no-op for a source position that was never mirrored", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      await expect(
        onClose(tx, { positionId: randomUUID(), brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1) })
      ).resolves.toBeUndefined();
    });
  });

  it("is idempotent -- a retried onClose on an already-closed target is a harmless no-op", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const rule = await createRule(tx, fx);
      const sourcePositionId = randomUUID();
      const targetPosition = await createManualPosition(tx, fx, { accountId: fx.targetAccountId, side: "SELL", volume: "1", openPrice: "1.1", status: "CLOSED" });
      await tx.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId, targetPositionId: targetPosition.id } });

      await expect(
        onClose(tx, { positionId: sourcePositionId, brokerId: fx.brokerId, closedLots: D(1), sourceVolumeBeforeClose: D(1) })
      ).resolves.toBeUndefined();

      const refreshedTarget = await tx.position.findUniqueOrThrow({ where: { id: targetPosition.id } });
      expect(refreshedTarget.status).toBe("CLOSED"); // untouched
    });
  });
});
