// lib/risk-monitor.ts evaluateAccountsRisk (margin-monitor load, 2026-10-05): a per-symbol pass reads positions, broker
// symbols + sessions, FX and the SELL ask rules ONCE for all its accounts instead of once per account.
//  1. Same outcome: two identical books (one per private symbol) -- SL hit, stop-out cascade, margin call in and out,
//     SELLs priced by a group markup and by an account override on a pricing-engine broker, two brokers, mixed groups --
//     one evaluated the old way (evaluateAccountRisk per account), one by evaluateRiskForSymbol. Every balance, close
//     price, P/L, position status, margin-call flag and notification must match.
//  2. Statements: the old per-account loop grows with the number of accounts; the shared pass stays constant.
// Private CRYPTO symbols (continuous session) keep this independent of the weekday.
import { statements } from "@/tests/support/counting-prisma";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk, evaluateRiskForSymbol } from "@/lib/risk-monitor";

const D = (v: number | string) => new Prisma.Decimal(v);
const SUB = "zz-rmb-";
let seq = 0;
const report = (line: string) => {
  if (process.env.STATEMENTS_OUT) fs.appendFileSync(process.env.STATEMENTS_OUT, line + "\n");
};

type Book = {
  symbol: string;
  symbolId: string;
  plain: string; // broker, pricing engine off
  engine: string; // broker, pricing engine on
  gA: string; // plain broker, no group config
  gB: string; // plain broker, group markup 5 pips
  gC: string; // engine broker
};

async function makeBook(tag: string): Promise<Book> {
  const symbol = `ZRMB${tag}`;
  const sym = await prisma.symbol.upsert({ where: { name: symbol }, update: {}, create: { name: symbol, baseCurrency: "ZRB", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  const plain = (await prisma.broker.create({ data: { name: `rmb plain ${tag}`, subdomain: `${SUB}p-${tag.toLowerCase()}` } })).id;
  const engine = (await prisma.broker.create({ data: { name: `rmb engine ${tag}`, subdomain: `${SUB}e-${tag.toLowerCase()}`, pricingEngineEnabled: true } })).id;
  const group = async (brokerId: string, name: string) => (await prisma.group.create({ data: { brokerId, name, leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } })).id;
  const gA = await group(plain, "gA");
  const gB = await group(plain, "gB");
  const gC = await group(engine, "gC");
  await prisma.brokerSymbol.create({ data: { brokerId: plain, symbolId: sym.id } });
  await prisma.brokerSymbol.create({ data: { brokerId: engine, symbolId: sym.id } });
  await prisma.groupSymbolConfig.create({ data: { groupId: gB, symbolId: sym.id, spreadMarkup: D(5) } });
  // bid 80, ask 80.5 (pip 0.1): a SELL in gB closes at 81.0, the gC account with a 3-pip override at 80.8
  await prisma.livePrice.upsert({ where: { symbol }, update: { bid: D(80), ask: D(80.5), tickAt: new Date() }, create: { symbol, bid: D(80), ask: D(80.5), tickAt: new Date() } });
  return { symbol, symbolId: sym.id, plain, engine, gA, gB, gC };
}

async function account(brokerId: string, groupId: string, balance: number, extra: Partial<Prisma.AccountUncheckedCreateInput> = {}) {
  seq++;
  return prisma.account.create({
    data: { brokerId, groupId, accountNumber: `4778${String(Date.now() % 100000).padStart(5, "0")}${seq}`, email: `rmb${seq}@x.local`, passwordHash: "x", fullName: "rmb", accountMode: "DEMO", leverage: 1, balance: D(balance), ...extra },
  });
}

async function open(book: Book, a: { id: string; brokerId: string }, side: "BUY" | "SELL", openPrice: number, opts: { sl?: number } = {}) {
  seq++;
  const order = await prisma.order.create({ data: { brokerId: a.brokerId, accountId: a.id, symbolId: book.symbolId, side, type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `rmb-${Date.now()}-${seq}` } });
  return prisma.position.create({ data: { brokerId: a.brokerId, accountId: a.id, symbolId: book.symbolId, originOrderId: order.id, side, volume: D(1), openPrice: D(openPrice), slPrice: opts.sl != null ? D(opts.sl) : null } });
}

// The labelled scenario; returns label -> account id
async function scenario(book: Book): Promise<Record<string, string>> {
  const slHit = await account(book.plain, book.gA, 10_000);
  await open(book, slHit, "BUY", 100, { sl: 85 }); // bid 80 <= 85: SL
  await open(book, slHit, "BUY", 90);
  const cascade = await account(book.plain, book.gA, 100); // stop-out cascade (see risk-monitor-load-once.test.ts)
  await open(book, cascade, "BUY", 100);
  await open(book, cascade, "BUY", 90);
  await open(book, cascade, "BUY", 85);
  const sellCall = await account(book.plain, book.gB, 60); // SELL at the group's ask 81.0: ~60 % -> margin call, no stop-out
  await open(book, sellCall, "SELL", 70);
  const sellSl = await account(book.engine, book.gC, 1_000); // SL 80.6: hit only at the account's ask 80.8, not the raw 80.5
  await prisma.accountSymbolConfig.create({ data: { accountId: sellSl.id, symbolId: book.symbolId, spreadMarkup: D(3) } });
  await open(book, sellSl, "SELL", 90, { sl: 80.6 });
  await open(book, sellSl, "SELL", 95);
  const recovered = await account(book.engine, book.gC, 10_000, { marginCallNotifiedAt: new Date() });
  await open(book, recovered, "BUY", 79);
  const idle = await account(book.plain, book.gB, 10_000);
  await open(book, idle, "BUY", 85);
  await open(book, idle, "SELL", 85);
  return { slHit: slHit.id, cascade: cascade.id, sellCall: sellCall.id, sellSl: sellSl.id, recovered: recovered.id, idle: idle.id };
}

async function outcome(ids: Record<string, string>) {
  const out: Record<string, unknown> = {};
  for (const [label, id] of Object.entries(ids)) {
    const a = await prisma.account.findUniqueOrThrow({ where: { id } });
    const positions = await prisma.position.findMany({ where: { accountId: id }, orderBy: [{ openedAt: "asc" }, { id: "asc" }] });
    const notes = await prisma.notification.findMany({ where: { entityId: id }, select: { type: true, accountId: true, body: true } });
    out[label] = {
      balance: a.balance.toString(),
      inMarginCall: a.marginCallNotifiedAt != null,
      positions: positions.map((p) => ({ side: p.side, open: p.openPrice.toString(), status: p.status, close: p.closePrice?.toString() ?? null, pnl: p.realizedPnl?.toString() ?? null })),
      notes: notes.map((n) => `${n.type}|${n.accountId ? "trader" : "staff"}|${n.body.replace(/\d{6,}/g, "#")}`).sort(),
    };
  }
  return out;
}

async function openAccountIds(symbol: string) {
  const rows = await prisma.position.findMany({ where: { status: "OPEN", symbol: { name: symbol } }, select: { accountId: true }, distinct: ["accountId"] });
  return rows.map((r) => r.accountId);
}

async function wipe() {
  const brokers = await prisma.broker.findMany({ where: { subdomain: { startsWith: SUB } }, select: { id: true } });
  for (const b of brokers) {
    const where = { brokerId: b.id };
    await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
    await prisma.order.updateMany({ where, data: { closesPositionId: null } });
    await prisma.postCloseEffect.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.notification.deleteMany({ where });
    await prisma.auditLog.deleteMany({ where });
    await prisma.accountSymbolConfig.deleteMany({ where: { account: { brokerId: b.id } } });
    await prisma.account.deleteMany({ where });
    await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: b.id } } });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.delete({ where: { id: b.id } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "ZRMB" } } });
}

beforeAll(async () => {
  await wipe();
}, 60_000);
afterAll(async () => {
  await wipe();
  await prisma.$disconnect();
}, 60_000);

describe("evaluateAccountsRisk (one shared read per symbol pass)", () => {
  it("decides exactly what the per-account evaluation decides", async () => {
    const legacyBook = await makeBook("L");
    const batchBook = await makeBook("N");
    const legacyIds = await scenario(legacyBook);
    const batchIds = await scenario(batchBook);

    for (const id of await openAccountIds(legacyBook.symbol)) await evaluateAccountRisk(id);
    await evaluateRiskForSymbol(batchBook.symbol);

    const legacy = await outcome(legacyIds);
    const batch = await outcome(batchIds);
    expect(batch).toEqual(legacy);

    // and the scenario really exercised every branch (so "equal" is not "both did nothing")
    const L = legacy as Record<string, { balance: string; inMarginCall: boolean; positions: { status: string; close: string | null }[]; notes: string[] }>;
    expect(L.slHit.positions.map((p) => p.status)).toEqual(["CLOSED", "OPEN"]);
    expect(L.cascade.positions.map((p) => p.status)).toEqual(["CLOSED", "CLOSED", "OPEN"]);
    expect(L.cascade.inMarginCall).toBe(true);
    expect(L.sellCall.inMarginCall).toBe(true);
    expect(L.sellCall.positions[0].status).toBe("OPEN");
    expect(L.sellSl.positions.map((p) => p.status)).toEqual(["CLOSED", "OPEN"]);
    expect(L.sellSl.positions[0].close).toBe("80.8"); // the account's ask, not the raw 80.5
    expect(L.recovered.inMarginCall).toBe(false);
    expect(L.recovered.notes.some((n) => n.startsWith("MARGIN_CALL_CLEARED|trader"))).toBe(true);
    expect(L.idle.positions.map((p) => p.status)).toEqual(["OPEN", "OPEN"]);
    expect(L.idle.notes).toEqual([]);
  });

  it("reads a constant number of statements per pass, whatever the number of accounts", async () => {
    const counts: Record<string, { legacy: number; batch: number }> = {};
    for (const n of [4, 12]) {
      const legacyBook = await makeBook(`QL${n}`);
      const batchBook = await makeBook(`QN${n}`);
      for (const book of [legacyBook, batchBook]) {
        for (let i = 0; i < n; i++) {
          // nothing to do (well above every level), half BUYs on the plain broker, half SELLs on the engine broker
          // with their own override: every account needs its positions, its broker symbol, and (SELL) its ask rule
          if (i % 2 === 0) {
            const a = await account(book.plain, i % 4 === 0 ? book.gA : book.gB, 100_000);
            await open(book, a, "BUY", 80);
          } else {
            const a = await account(book.engine, book.gC, 100_000);
            await prisma.accountSymbolConfig.create({ data: { accountId: a.id, symbolId: book.symbolId, spreadMarkup: D(1) } });
            await open(book, a, "SELL", 81);
          }
        }
      }
      const ids = await openAccountIds(legacyBook.symbol);
      statements.n = 0;
      for (const id of ids) await evaluateAccountRisk(id);
      const legacy = statements.n;
      statements.n = 0;
      await evaluateRiskForSymbol(batchBook.symbol);
      const batch = statements.n - 1; // minus the distinct-accounts query the legacy count did not include
      counts[n] = { legacy, batch };
      report(`margin-monitor ?symbols= pass, ${n} accounts: per-account ${legacy} statements, shared ${batch}`);
    }
    expect(counts[12].batch).toBe(counts[4].batch);
    expect(counts[12].legacy).toBeGreaterThan(counts[4].legacy);
    expect(counts[4].batch).toBeLessThan(counts[4].legacy);
  });
});
