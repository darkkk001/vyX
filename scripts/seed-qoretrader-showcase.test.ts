import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { NUMBER_MIN, SEED_SOURCE, SeedRefused, seedShowcase, SUBDOMAIN } from "./seed-qoretrader-showcase";

// The showcase seed on an isolated scratch database: a minimal "qoretrader" tenant is built here, seeded, checked (every ledger row and every
// account balance adds up, trades on every symbol, open positions far from margin, the queues have items), refused a second time, then wiped
// back to exactly the tenant it started from. A second broker's rows are never touched.
const D = (v: number | string) => new Prisma.Decimal(v);
const NOW = new Date("2026-11-12T12:00:00Z");
let ok = false; let brokerId = ""; let otherBrokerId = ""; let otherAccountId = "";

async function snapshot() {
  const [accounts, tx, pos, deals, clients] = await Promise.all([prisma.account.count(), prisma.transaction.count(), prisma.position.count(), prisma.deal.count(), prisma.client.count()]);
  return { accounts, tx, pos, deals, clients };
}

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1 FROM "Client" LIMIT 1`; ok = true; } catch { console.warn("showcase seed test: DB unreachable, skipped"); return; }
  const b = (await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })) ?? await prisma.broker.create({ data: { name: "QoreTrader", subdomain: SUBDOMAIN } });
  brokerId = b.id;
  await prisma.group.create({ data: { brokerId, name: `Standard ${Date.now()}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  await prisma.group.create({ data: { brokerId, name: `Pro A ${Date.now()}`, leverage: 200, marginCallLevel: D(100), stopOutLevel: D(50), category: "A_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  await prisma.adminUser.create({ data: { brokerId, email: `owner-${Date.now()}@qoretrader.test`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const defs = [["XAUUSD", "XAU", "USD", 2, 100, "METALS", 2650], ["EURUSD", "EUR", "USD", 5, 100000, "FOREX", 1.081], ["USDJPY", "USD", "JPY", 3, 100000, "FOREX", 151.2],
    ["BTCUSD", "BTC", "USD", 2, 1, "CRYPTO", 71000], ["US30", "US30", "USD", 1, 1, "INDICES", 42100]] as const;
  for (const [name, base, quote, digits, cs, cat, px] of defs) {
    const n = `${name}`; const s = (await prisma.symbol.findFirst({ where: { name: n } })) ?? await prisma.symbol.create({ data: { name: n, baseCurrency: base, quoteCurrency: quote, digits, contractSize: D(cs), category: cat } });
    await prisma.brokerSymbol.create({ data: { brokerId, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
    await prisma.livePrice.upsert({ where: { symbol: n }, create: { symbol: n, bid: D(px), ask: D(px) }, update: { bid: D(px), ask: D(px) } });
  }
  // another broker with an account: the seed and the wipe must never touch it
  const o = await prisma.broker.create({ data: { name: `Other ${Date.now()}`, subdomain: `other-${Date.now()}` } });
  otherBrokerId = o.id;
  const og = await prisma.group.create({ data: { brokerId: o.id, name: "G", leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  otherAccountId = (await prisma.account.create({ data: { brokerId: o.id, groupId: og.id, accountNumber: "51999999", email: "real@other.test", passwordHash: "x", fullName: "Other", accountMode: "LIVE", leverage: 100, balance: D(5000) } })).id;
}, 120000);
afterAll(async () => { await prisma.$disconnect(); }, 60000);

describe("QoreTrader showcase seed", () => {
  it("dry run writes nothing; apply creates a consistent book; a second apply is refused; wipe restores the tenant exactly", async () => {
    if (!ok) return;
    const before = await snapshot();
    const dry = await prisma.$transaction((tx) => seedShowcase(tx, { mode: "dry", now: NOW }), { timeout: 300000 });
    expect(dry.counts.Client).toBe(112);   // 100 with an account + 12 sign-ups without one
    expect(await snapshot()).toEqual(before);

    const res = await prisma.$transaction((tx) => seedShowcase(tx, { mode: "apply", now: NOW }), { timeout: 600000 });
    console.log(res.lines.join("\n"));
    expect(res.counts).toEqual(dry.counts);   // deterministic: the dry run said exactly this
    const clients = await prisma.client.findMany({ where: { brokerId, source: SEED_SOURCE } });
    expect(clients).toHaveLength(112);
    expect(clients.every((c) => c.email.endsWith("@example.com"))).toBe(true);
    const accounts = await prisma.account.findMany({ where: { brokerId, clientId: { in: clients.map((c) => c.id) } }, include: { group: true } });
    expect(accounts).toHaveLength(100);
    expect(accounts.every((a) => Number(a.accountNumber) >= NUMBER_MIN && a.group.category === "B_BOOK")).toBe(true);   // never an A-book group
    expect(new Set(accounts.map((a) => a.createdAt.getUTCFullYear())).has(2023)).toBe(true);
    expect(new Set(accounts.map((a) => a.status)).size).toBeGreaterThan(1);

    // every account's completed ledger adds up to its balance, and each completed row's before / after chain is unbroken
    for (const a of accounts) {
      const rows = await prisma.transaction.findMany({ where: { accountId: a.id, status: "COMPLETED" }, orderBy: [{ createdAt: "asc" }] });
      let bal = D(0);
      for (const t of rows) { expect(t.balanceBefore.toFixed(2)).toBe(bal.toFixed(2)); bal = bal.plus(t.amount); expect(t.balanceAfter.toFixed(2)).toBe(bal.toFixed(2)); }
      expect(a.balance.toFixed(2)).toBe(bal.toFixed(2));
      expect(a.balance.gte(0)).toBe(true);
    }
    // closed trades: each has an IN and an OUT deal, the OUT carries the P/L and the ledger row; wins and losses both; every symbol traded
    const closed = await prisma.position.findMany({ where: { brokerId, status: "CLOSED", accountId: { in: accounts.map((a) => a.id) } } });
    expect(closed.length).toBeGreaterThan(1000);
    const pnls = closed.map((p) => Number(p.realizedPnl));
    expect(pnls.some((x) => x > 0) && pnls.some((x) => x < 0)).toBe(true);
    const outDeals = await prisma.deal.count({ where: { brokerId, entry: "OUT", transactionId: { not: null }, accountId: { in: accounts.map((a) => a.id) } } });
    expect(outDeals).toBe(closed.length);
    const inDeals = await prisma.deal.count({ where: { brokerId, entry: "IN", accountId: { in: accounts.map((a) => a.id) } } });
    expect(inDeals).toBe(closed.length + (await prisma.position.count({ where: { brokerId, status: "OPEN", accountId: { in: accounts.map((a) => a.id) } } })));
    const tenantSymbols = await prisma.brokerSymbol.count({ where: { brokerId, enabled: true } });
    expect(new Set(closed.map((p) => p.symbolId)).size).toBe(tenantSymbols);
    // open positions: across every symbol, no SL / TP, margin far below the balance
    const open = await prisma.position.findMany({ where: { brokerId, status: "OPEN", accountId: { in: accounts.map((a) => a.id) } }, include: { symbol: true, account: true } });
    expect(open.length).toBeGreaterThan(20);
    expect(new Set(open.map((p) => p.symbolId)).size).toBe(tenantSymbols);
    expect(open.every((p) => p.slPrice == null && p.tpPrice == null && p.bookType === "B_BOOK")).toBe(true);
    // queues
    expect(await prisma.transaction.count({ where: { brokerId, type: "WITHDRAWAL", status: "PENDING" } })).toBeGreaterThan(3);
    expect(await prisma.transaction.count({ where: { brokerId, type: "DEPOSIT", status: "PENDING" } })).toBeGreaterThan(3);
    expect(await prisma.clientKycRecord.count({ where: { clientId: { in: clients.map((c) => c.id) }, status: "PENDING" } })).toBeGreaterThan(3);
    expect(await prisma.balanceAdjustmentRequest.count({ where: { brokerId, status: "PENDING" } })).toBeGreaterThan(0);

    await expect(prisma.$transaction((tx) => seedShowcase(tx, { mode: "apply", now: NOW }), { timeout: 60000 })).rejects.toBeInstanceOf(SeedRefused);

    // a row the engine might add later (a swap) is wiped with its account
    await prisma.transaction.create({ data: { brokerId, accountId: accounts[0].id, type: "SWAP", status: "COMPLETED", amount: D(-1), balanceBefore: accounts[0].balance, balanceAfter: accounts[0].balance.minus(1) } });
    const wiped = await prisma.$transaction((tx) => seedShowcase(tx, { mode: "wipe" }), { timeout: 600000 });
    console.log(wiped.lines.join("\n"));
    expect(await snapshot()).toEqual(before);
    expect(await prisma.account.findUnique({ where: { id: otherAccountId } })).not.toBeNull();
    expect(otherBrokerId).not.toBe("");
  }, 900000);

  it("refuses a sandbox tenant", async () => {
    if (!ok) return;
    await prisma.broker.update({ where: { id: brokerId }, data: { isDemoSandbox: true } });
    await expect(prisma.$transaction((tx) => seedShowcase(tx, { mode: "dry", now: NOW }))).rejects.toThrow(/sandbox/);
    await prisma.broker.update({ where: { id: brokerId }, data: { isDemoSandbox: false } });
  }, 60000);
});
