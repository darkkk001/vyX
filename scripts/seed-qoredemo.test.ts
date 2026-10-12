import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { createOtherBroker } from "@/lib/demo-test-fixtures";
import { DEMO_SYMBOLS } from "@/lib/demo-prices";
import { SeedRefused, seedQoreDemo, SUBDOMAIN } from "./seed-qoredemo";

// scripts/seed-qoredemo.ts against a throwaway clone of the scratch database: a dry run writes nothing, an apply creates exactly
// the approved tenant, a second apply changes nothing, and every guard refuses BEFORE any write.
const D = (v: number | string) => new Prisma.Decimal(v);
const run = (apply: boolean) => prisma.$transaction(async (tx) => {
  if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
  return seedQoreDemo(tx, { apply });
}, { timeout: 120_000, maxWait: 30_000 });

let other: Awaited<ReturnType<typeof createOtherBroker>>;
beforeAll(async () => {
  other = await createOtherBroker();
}, 60_000);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("guards refuse before any write", () => {
  it("a foreign account inside the guest range", async () => {
    const a = await prisma.account.create({ data: { groupId: other.group.id, brokerId: other.broker.id, accountNumber: "48000007", email: "r@o.test", passwordHash: "x", fullName: "r", accountMode: "DEMO" } });
    await expect(run(true)).rejects.toThrow(/inside the guest range/);
    await expect(run(true)).rejects.toBeInstanceOf(SeedRefused);
    expect(await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })).toBeNull(); // nothing was written
    await prisma.account.delete({ where: { id: a.id } });
  });
  it("the custom domain already belongs to another broker", async () => {
    await prisma.broker.update({ where: { id: other.broker.id }, data: { customDomain: "demo.qoretrader.com" } });
    await expect(run(true)).rejects.toThrow(/already belongs to the broker/);
    await prisma.broker.update({ where: { id: other.broker.id }, data: { customDomain: null } });
    expect(await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })).toBeNull();
  });
  it("a q-symbol that exists with a different definition", async () => {
    const s = await prisma.symbol.create({ data: { name: "qXAUUSD", baseCurrency: "XAU", quoteCurrency: "USD", digits: 3, contractSize: D(100), category: "METALS" } });
    await expect(run(true)).rejects.toThrow(/different definition/);
    await prisma.symbol.delete({ where: { id: s.id } });
    expect(await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })).toBeNull();
  });
  it("a real symbol whose digits disagree with the demo's", async () => {
    const real = await prisma.symbol.findFirst({ where: { name: "EURUSD" } });
    if (!real) return; // this database has no real EURUSD to disagree with
    await prisma.symbol.update({ where: { id: real.id }, data: { digits: 4 } });
    await expect(run(false)).rejects.toThrow(/fix lib\/demo-prices\.ts first/);
    await prisma.symbol.update({ where: { id: real.id }, data: { digits: real.digits } });
  });
});

describe("dry run, apply, re-apply", () => {
  it("a dry run plans every change and writes nothing", async () => {
    const before = { brokers: await prisma.broker.count(), symbols: await prisma.symbol.count(), groups: await prisma.group.count() };
    const r = await run(false);
    expect(r.changes).toBe(24);
    expect(r.lines.join("\n")).toContain("DRY RUN");
    expect(await prisma.broker.count()).toBe(before.brokers);
    expect(await prisma.symbol.count()).toBe(before.symbols);
    expect(await prisma.group.count()).toBe(before.groups);
  });
  it("apply creates exactly the approved tenant", async () => {
    const r = await run(true);
    expect(r.changes).toBe(24);
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN }, include: { groups: true, adminUsers: true, brokerSymbols: { include: { symbol: true, tradingSessions: true } }, accounts: true } });
    expect(b).toMatchObject({
      name: "QoreTrader Demo", customDomain: "demo.qoretrader.com", status: "ACTIVE", emailEnabled: false, ssoSecret: null, autoHedgeAt: null, dealingDeskAutoFillAt: null,
      negativeBalanceProtection: true, maxOpenPositionsPerAccount: 20, defaultAccountCurrency: "USD", primaryColor: "#7A1A3A", logoUrl: "/qoretrader-demo/qoretrader-lockup-light.svg",
    });
    expect(b.accounts).toHaveLength(0); // the seed creates no accounts
    expect(b.groups).toHaveLength(1);
    expect(b.groups[0]).toMatchObject({ name: "Demo", category: "B_BOOK", modeRestriction: "DEMO_ONLY", isDefault: true, leverage: 100, groupType: "DEMO" });
    expect(b.groups[0].marginCallLevel.equals(100)).toBe(true);
    expect(b.groups[0].stopOutLevel.equals(50)).toBe(true);
    expect(b.adminUsers).toHaveLength(1);
    expect(b.adminUsers[0]).toMatchObject({ status: "DISABLED", role: "BROKER_ADMIN" });
    expect(b.brokerSymbols).toHaveLength(7);
    for (const bs of b.brokerSymbols) {
      expect(bs).toMatchObject({ enabled: true, tradingMode: "BOTH", defaultBookType: "B_BOOK" });
      expect(bs.spreadMarkup.equals(0) && bs.commissionPerLot.equals(0) && bs.swapLong.equals(0) && bs.swapShort.equals(0)).toBe(true);
      expect(bs.tradingSessions).toHaveLength(7);
      expect(new Set(bs.tradingSessions.map((s) => `${s.dayOfWeek}|${s.openTime}|${s.closeTime}`)).size).toBe(7);
    }
    const defs = await prisma.symbol.findMany({ where: { name: { in: DEMO_SYMBOLS.map((d) => d.name) } } });
    expect(defs).toHaveLength(7);
    for (const d of DEMO_SYMBOLS) {
      const row = defs.find((x) => x.name === d.name)!;
      expect([row.digits, row.contractSize.toNumber(), row.category, row.quoteCurrency]).toEqual([d.digits, d.contractSize, d.category, d.quoteCurrency]);
    }
    // the symbols are assigned to NO other broker
    expect(await prisma.brokerSymbol.count({ where: { symbol: { name: { startsWith: "q" } }, brokerId: { not: b.id } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { brokerId: b.id, action: "QOREDEMO_SEED" } })).toBe(1);
  });
  it("a second apply changes nothing, and a drifted field is put back by a re-run", async () => {
    const again = await run(true);
    expect(again.changes).toBe(0);
    await prisma.broker.update({ where: { subdomain: SUBDOMAIN }, data: { maxOpenPositionsPerAccount: 500, emailEnabled: true } });
    const fix = await run(true);
    expect(fix.changes).toBe(1);
    expect(fix.lines.join("\n")).toMatch(/maxOpenPositionsPerAccount: 500 -> 20/);
    expect((await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } })).maxOpenPositionsPerAccount).toBe(20);
  });
  it("after guests exist the seed still runs (their numbers belong to the demo broker)", async () => {
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
    const g = await prisma.group.findFirstOrThrow({ where: { brokerId: b.id } });
    await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: "48000100", email: "guest-48000100@demo.invalid", passwordHash: "x", fullName: "Demo trader", accountMode: "DEMO" } });
    expect((await run(false)).changes).toBe(0);
  });
});
