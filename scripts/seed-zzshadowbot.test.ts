// scripts/seed-zzshadowbot.ts against the scratch database (vitest.setup.db-guard.ts refuses anything else).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { ACCOUNTS, COVERAGE_ACCOUNT, GROUPS, SUBDOMAIN, SYMBOLS, SeedRefused, seedShadowBot, type SeedOptions } from "./seed-zzshadowbot";
import { applySpreadMarkup } from "@/lib/group-pricing";
import { checkPreTradeMargin, hedgedUsedMargin, requiredMarginFor } from "@/lib/margin";

const prisma = new PrismaClient();
const D = (v: number | string) => new Prisma.Decimal(v);
const PASSWORD = "shadow-bot-test-pw";
let passwordHash = "";
const run = (o: Partial<SeedOptions>) =>
  prisma.$transaction((tx) => seedShadowBot(tx, { apply: false, resetTrading: false, password: PASSWORD, passwordHash, ...o }), { timeout: 120_000 });

const SYMBOL_ROWS: Record<string, { base: string; digits: number; cs: string; cat: "METALS" | "FOREX" | "INDICES" | "CRYPTO" }> = {
  XAUUSD: { base: "XAU", digits: 2, cs: "100", cat: "METALS" }, EURUSD: { base: "EUR", digits: 5, cs: "100000", cat: "FOREX" },
  GBPUSD: { base: "GBP", digits: 5, cs: "100000", cat: "FOREX" }, XAGUSD: { base: "XAG", digits: 3, cs: "5000", cat: "METALS" },
  US30: { base: "USD", digits: 1, cs: "1", cat: "INDICES" }, BTCUSD: { base: "BTC", digits: 1, cs: "1", cat: "CRYPTO" }, ETHUSD: { base: "ETH", digits: 2, cs: "1", cat: "CRYPTO" },
};

async function wipe(subdomain: string) {
  const b = await prisma.broker.findUnique({ where: { subdomain } });
  if (!b) return;
  const where = { brokerId: b.id };
  await prisma.mirrorLink.deleteMany({ where: { rule: where } });
  await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
  await prisma.order.updateMany({ where, data: { closesPositionId: null } });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.transaction.deleteMany({ where });
  await prisma.mirrorRule.deleteMany({ where });
  await prisma.auditLog.deleteMany({ where });
  // the risk monitor's margin-call / stop-out notices (the negative-equity case writes one)
  await prisma.notification.deleteMany({ where });
  await prisma.broker.update({ where: { id: b.id }, data: { coverageAccountId: null } });
  await prisma.account.deleteMany({ where });
  await prisma.groupSymbolConfig.deleteMany({ where: { group: where } });
  await prisma.group.deleteMany({ where });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.delete({ where: { id: b.id } });
}

beforeAll(async () => {
  passwordHash = await bcrypt.hash(PASSWORD, 4);
  for (const [name, s] of Object.entries(SYMBOL_ROWS)) {
    await prisma.symbol.upsert({ where: { name }, update: {}, create: { name, baseCurrency: s.base, quoteCurrency: "USD", digits: s.digits, contractSize: D(s.cs), category: s.cat } });
  }
  await wipe("zzother");
  await wipe(SUBDOMAIN);
}, 60_000);
afterAll(async () => {
  await wipe("zzother");
  await wipe(SUBDOMAIN);
  await prisma.$disconnect();
}, 60_000);

describe("zzshadowbot seed", () => {
  it("dry run on an empty database plans everything and writes nothing", async () => {
    const r = await run({ apply: false });
    expect(r.changes).toBe(1 + 1 + SYMBOLS.length + GROUPS.length + GROUPS.reduce((n, g) => n + g.configs.length, 0) + ACCOUNTS.length + 1 + 2);
    expect(await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })).toBeNull();
  });

  it("apply builds the plan; a second apply changes nothing", async () => {
    const first = await run({ apply: true });
    expect(first.changes).toBeGreaterThan(0);
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
    expect(b.status).toBe("ACTIVE");
    expect(b.pricingEngineEnabled).toBe(true);
    expect(b.dealingDeskAutoFillAt).not.toBeNull(); // desk OFF
    expect(b.autoHedgeAt).not.toBeNull();
    expect(b.negativeBalanceProtection).toBe(true);
    const cov = await prisma.account.findUniqueOrThrow({ where: { accountNumber: COVERAGE_ACCOUNT }, include: { group: true } });
    expect(b.coverageAccountId).toBe(cov.id);
    expect(cov.group.category).toBe("COVERAGE");

    const accts = await prisma.account.findMany({ where: { brokerId: b.id }, include: { group: true } });
    expect(accts).toHaveLength(ACCOUNTS.length);
    for (const spec of ACCOUNTS) {
      const a = accts.find((x) => x.accountNumber === spec.number)!;
      expect([a.group.name, a.currency, a.leverage, a.balance.toNumber(), a.accountMode]).toEqual([spec.group, spec.currency, spec.leverage, spec.balance, "LIVE"]);
      expect(await bcrypt.compare(PASSWORD, a.passwordHash)).toBe(true);
    }
    const ledger = await prisma.transaction.aggregate({ where: { brokerId: b.id }, _sum: { amount: true }, _count: true });
    expect(ledger._count).toBe(ACCOUNTS.length);
    expect(ledger._sum.amount!.toNumber()).toBe(ACCOUNTS.reduce((s, a) => s + a.balance, 0));

    const xau = await prisma.brokerSymbol.findFirstOrThrow({ where: { brokerId: b.id, symbol: { name: "XAUUSD" } } });
    expect(xau.hedgedMarginPct.toNumber()).toBe(0);
    const rules = await prisma.mirrorRule.findMany({ where: { brokerId: b.id } });
    expect(rules).toHaveLength(2);
    const reversal = await prisma.group.findFirstOrThrow({ where: { brokerId: b.id, name: "SB Reversal" } });
    expect(rules.find((r) => r.sourceType === "GROUP")!.sourceId).toBe(reversal.id);
    const acctRule = rules.find((r) => r.sourceType === "ACCOUNT")!;
    expect([acctRule.multiplier.toNumber(), acctRule.fillPriceMode, acctRule.maxOpenLots!.toNumber(), acctRule.maxDailyLoss!.toNumber()]).toEqual([0.5, "MARKET", 5, 2000]);
    const admin = await prisma.adminUser.findFirstOrThrow({ where: { brokerId: b.id } });
    expect(admin.status).toBe("DISABLED");

    const second = await run({ apply: true });
    expect(second.changes).toBe(0);
    expect(second.lines.at(-1)).toMatch(/^0 change/);
  });

  it("puts drifted config back, and leaves balances alone without --reset-trading", async () => {
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
    const g = await prisma.group.findFirstOrThrow({ where: { brokerId: b.id, name: "SB Dealing Desk" } });
    await prisma.group.update({ where: { id: g.id }, data: { stopOutLevel: D(50), forceDealingMode: true } });
    await prisma.groupSymbolConfig.updateMany({ where: { groupId: g.id, symbol: { name: "XAUUSD" } }, data: { commissionPerLot: D(99) } });
    await prisma.broker.update({ where: { id: b.id }, data: { autoHedgeAt: null, tradingHaltedAt: new Date() } });
    await prisma.account.update({ where: { accountNumber: "49990008" }, data: { balance: D(123), leverage: 7 } });

    const r = await run({ apply: true });
    expect(r.lines.join("\n")).toMatch(/UPDATE group SB Dealing Desk: stopOutLevel: 50 -> 80; forceDealingMode: true -> false/);
    const g2 = await prisma.group.findUniqueOrThrow({ where: { id: g.id } });
    expect([g2.stopOutLevel.toNumber(), g2.forceDealingMode]).toEqual([80, false]);
    const cfg = await prisma.groupSymbolConfig.findFirstOrThrow({ where: { groupId: g.id, symbol: { name: "XAUUSD" } } });
    expect(cfg.commissionPerLot!.toNumber()).toBe(3.5);
    const b2 = await prisma.broker.findUniqueOrThrow({ where: { id: b.id } });
    expect(b2.autoHedgeAt).not.toBeNull();
    expect(b2.tradingHaltedAt).toBeNull();
    const a = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "49990008" } });
    expect([a.leverage, a.balance.toNumber()]).toEqual([100, 123]); // leverage is config, balance is trading state
    expect((await run({ apply: true })).changes).toBe(0);
  });

  it("--reset-trading wipes only this tenant's trading rows and re-seeds balances", async () => {
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
    // another tenant with its own ledger row, which must survive
    const other = await prisma.broker.create({ data: { name: "zz other", subdomain: "zzother" } });
    const og = await prisma.group.create({ data: { brokerId: other.id, name: "g" } });
    const oa = await prisma.account.create({ data: { brokerId: other.id, accountNumber: "48880001", email: "o@x.local", passwordHash: "x", fullName: "o", accountMode: "LIVE", groupId: og.id } });
    await prisma.transaction.create({ data: { brokerId: other.id, accountId: oa.id, type: "DEPOSIT", status: "COMPLETED", amount: D(5), balanceBefore: D(0), balanceAfter: D(5) } });
    const a1 = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "49990001" } });
    const xau = await prisma.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
    const order = await prisma.order.create({ data: { brokerId: b.id, accountId: a1.id, symbolId: xau.id, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: "seed-test-1" } });
    await prisma.position.create({ data: { brokerId: b.id, accountId: a1.id, symbolId: xau.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(4300) } });
    await prisma.transaction.create({ data: { brokerId: b.id, accountId: a1.id, type: "COMMISSION", status: "COMPLETED", amount: D(-7), balanceBefore: D(10000), balanceAfter: D(9993) } });
    await prisma.account.update({ where: { id: a1.id }, data: { balance: D(9993) } });
    const rule = await prisma.mirrorRule.findFirstOrThrow({ where: { brokerId: b.id, sourceType: "ACCOUNT" } });
    await prisma.mirrorRule.update({ where: { id: rule.id }, data: { enabled: false, killedAt: new Date(), failureCount: 3 } });

    const plain = await run({ apply: true });
    expect(plain.lines.join("\n")).toMatch(/NOTE   mirror account rule runtime state/);
    expect(await prisma.position.count({ where: { brokerId: b.id } })).toBe(1); // a plain re-run never touches trading state

    const dry = await run({ apply: false, resetTrading: true });
    expect(dry.lines.join("\n")).toMatch(/DELETE \(reset trading, zzshadowbot only\): positions 1, orders 1, transactions 15/);
    expect(await prisma.position.count({ where: { brokerId: b.id } })).toBe(1);

    await run({ apply: true, resetTrading: true });
    expect(await prisma.position.count({ where: { brokerId: b.id } })).toBe(0);
    expect(await prisma.order.count({ where: { brokerId: b.id } })).toBe(0);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a1.id } })).balance.toNumber()).toBe(10000);
    expect(await prisma.transaction.count({ where: { brokerId: b.id } })).toBe(ACCOUNTS.length);
    const rule2 = await prisma.mirrorRule.findUniqueOrThrow({ where: { id: rule.id } });
    expect([rule2.enabled, rule2.killedAt, rule2.failureCount]).toEqual([true, null, 0]);
    expect(await prisma.transaction.count({ where: { brokerId: other.id } })).toBe(1); // the other tenant is untouched
    expect(await prisma.account.count({ where: { brokerId: other.id } })).toBe(1);
  });

  it("refuses when one of its account numbers belongs to another broker", async () => {
    const other = await prisma.broker.findUniqueOrThrow({ where: { subdomain: "zzother" } });
    const og = await prisma.group.findFirstOrThrow({ where: { brokerId: other.id } });
    await prisma.account.update({ where: { accountNumber: "49990005" }, data: { accountNumber: "49990005-moved" } });
    await prisma.account.create({ data: { brokerId: other.id, accountNumber: "49990005", email: "c@x.local", passwordHash: "x", fullName: "c", accountMode: "LIVE", groupId: og.id } });
    const before = await prisma.group.findFirstOrThrow({ where: { name: "SB Pro" } });
    await prisma.group.update({ where: { id: before.id }, data: { leverage: 1 } });
    await expect(run({ apply: true })).rejects.toThrow(SeedRefused);
    await expect(run({ apply: true })).rejects.toThrow(/49990005 already belong to another broker/);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: before.id } })).leverage).toBe(1); // nothing written
    await prisma.account.delete({ where: { accountNumber: "49990005" } });
    await prisma.account.update({ where: { accountNumber: "49990005-moved" }, data: { accountNumber: "49990005" } });
    await run({ apply: true });
  });

  it("refuses to create accounts without a password", async () => {
    await wipe(SUBDOMAIN);
    await expect(prisma.$transaction((tx) => seedShadowBot(tx, { apply: true, resetTrading: false, password: null, passwordHash: null }))).rejects.toThrow(/SHADOWBOT_PASSWORD/);
    expect(await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })).toBeNull();
    await run({ apply: true });
  });

  // The owner's edge: a fully hedged XAUUSD account at 0 % hedged margin driven below zero equity. Uses the seeded
  // values and the app's own pricing/margin functions; the price is illustrative (gold ~4300, raw spread 0.30).
  it("49990013 can reach negative equity with zero used margin (never stopped out)", async () => {
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: SUBDOMAIN } });
    const acct = await prisma.account.findUniqueOrThrow({ where: { accountNumber: "49990013" }, include: { group: { include: { symbolConfigs: { include: { symbol: true } } } } } });
    const cfg = acct.group.symbolConfigs.find((c) => c.symbol.name === "XAUUSD")!;
    const pct = (await prisma.brokerSymbol.findFirstOrThrow({ where: { brokerId: b.id, symbol: { name: "XAUUSD" } } })).hedgedMarginPct;
    const [bid, ask, cs] = [D(4300), D(4300.3), D(100)];
    const lots = D(1);
    let balance = acct.balance;

    // leg 1: SELL 1.00 at bid (the markup is ask-only), full margin, passes the pre-trade gate at MC 100
    const sellMargin = requiredMarginFor(lots, cs, bid, acct.leverage);
    expect(checkPreTradeMargin({ equity: balance, usedMargin: D(0), requiredMargin: sellMargin, marginCallLevel: acct.group.marginCallLevel })).toBeNull();
    balance = balance.sub(cfg.commissionPerLot!.mul(lots));
    const sellFloat = bid.sub(ask).mul(cs).mul(lots); // a SELL closes at ask
    const levelAfterLeg1 = balance.add(sellFloat).div(sellMargin).mul(100);
    expect(levelAfterLeg1.gt(acct.group.stopOutLevel)).toBe(true); // not stopped out between the legs

    // leg 2: BUY 1.00 at ask + 60 pips; the hedge takes used margin to 0, which the gate always allows
    const buyFill = applySpreadMarkup({ side: "BUY", price: ask, spreadMarkup: cfg.spreadMarkup!, digits: 2 });
    expect(buyFill.toNumber()).toBe(4306.3);
    const legs = [
      { symbolKey: "XAU", side: "SELL" as const, volume: lots, margin: sellMargin, hedgedMarginPct: pct },
      { symbolKey: "XAU", side: "BUY" as const, volume: lots, margin: requiredMarginFor(lots, cs, bid, acct.leverage), hedgedMarginPct: pct },
    ];
    const used = hedgedUsedMargin(legs);
    expect(used.toNumber()).toBe(0);
    balance = balance.sub(cfg.commissionPerLot!.mul(lots));
    const buyFloat = bid.sub(buyFill).mul(cs).mul(lots); // a BUY closes at bid
    const equity = balance.add(sellFloat).add(buyFloat);
    expect(equity.toNumber()).toBe(-160);
    // lib/risk-monitor.ts: marginLevel = usedMargin > 0 ? ... : null, and null never stops out
    const marginLevel = used.gt(0) ? equity.div(used).mul(100) : null;
    expect(marginLevel).toBeNull();
  });
});
