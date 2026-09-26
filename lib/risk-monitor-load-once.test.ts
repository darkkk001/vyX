// lib/risk-monitor.ts evaluateAccountRisk, end to end on the scratch DB (Neon load fix, 2026-09-26: positions and the
// account are read once and re-read only after a close). Behaviour is pinned here; with the statement-counting proxy
// (scripts/e2e/pg-latency-proxy.mjs, DATABASE_URL through 127.0.0.1:5599) it also reports statements per account.
// A private CRYPTO symbol (continuous session) keeps this independent of the weekday and of other tests' prices.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import net from "node:net";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { evaluateAccountRisk } from "@/lib/risk-monitor";

const D = (v: number | string) => new Prisma.Decimal(v);
const SYM = "ZRMLOADONCE";
const SUB = "zz-rm-load-once";
const PROXIED = (process.env.DATABASE_URL ?? "").includes("127.0.0.1:5599");
let brokerId = "";
let groupId = "";
let symbolId = "";
let seq = 0;
// statement counts go to STATEMENTS_OUT (vitest swallows console output from passing tests here)
const report = (label: string, n: number) => { if (process.env.STATEMENTS_OUT) fs.appendFileSync(process.env.STATEMENTS_OUT, `${label}: ${n}
`); };

function statements(cmd: "get" | "reset"): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.connect(5600, "127.0.0.1", () => s.write(cmd));
    let out = "";
    s.on("data", (d) => (out += d.toString()));
    s.on("end", () => resolve(Number(out)));
    s.on("error", reject);
  });
}

async function price(bid: number) {
  await prisma.livePrice.upsert({ where: { symbol: SYM }, update: { bid: D(bid), ask: D(bid), tickAt: new Date() }, create: { symbol: SYM, bid: D(bid), ask: D(bid), tickAt: new Date() } });
}

async function account(balance: number) {
  seq++;
  return prisma.account.create({
    data: { brokerId, accountNumber: `4777${String(Date.now() % 100000).padStart(5, "0")}${seq}`, email: `rm${seq}@x.local`, passwordHash: "x", fullName: "rm", accountMode: "DEMO", groupId, leverage: 1, balance: D(balance) },
  });
}

async function open(accountId: string, openPrice: number, opts: { sl?: number } = {}) {
  seq++;
  const order = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `rm-${Date.now()}-${seq}` } });
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(openPrice), slPrice: opts.sl != null ? D(opts.sl) : null } });
}

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
  const sym = await prisma.symbol.upsert({ where: { name: SYM }, update: {}, create: { name: SYM, baseCurrency: "ZRM", quoteCurrency: "USD", digits: 2, contractSize: D(1), category: "CRYPTO" } });
  symbolId = sym.id;
  const b = await prisma.broker.create({ data: { name: "rm load once", subdomain: SUB } });
  brokerId = b.id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 1, marginCallLevel: D(100), stopOutLevel: D(50) } })).id;
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId } });
}, 60_000);
afterAll(async () => {
  await wipe();
  await prisma.livePrice.deleteMany({ where: { symbol: SYM } });
}, 60_000);

describe("evaluateAccountRisk (load once, re-read after a close)", () => {
  it("a pass with nothing to do closes nothing and reads the account once", async () => {
    const a = await account(10_000);
    await open(a.id, 100);
    await open(a.id, 100);
    await price(100);
    if (PROXIED) await statements("reset");
    const r = await evaluateAccountRisk(a.id);
    if (PROXIED) report(`no-close pass, 2 positions`, await statements("get"));
    expect(r).toEqual({ evaluated: true, slTpClosed: [], stopOutClosed: [] });
    expect(await prisma.position.count({ where: { accountId: a.id, status: "OPEN" } })).toBe(2);
  });

  it("a stop-out cascade closes the worst first, re-measures after each close, and raises the margin call on what is left", async () => {
    // leverage 1, contract 1: margin = price. Balance 100, price 80:
    //   P1 (100) -20, P2 (90) -10, P3 (85) -5 -> equity 65 / used 240 = 27 % <= 50: close P1
    //   balance 80 -> equity 65 / 160 = 40.6 %: close P2;  balance 70 -> equity 65 / 80 = 81.25 %: stop, margin call (<= 100)
    const a = await account(100);
    const p1 = await open(a.id, 100);
    const p2 = await open(a.id, 90);
    const p3 = await open(a.id, 85);
    await price(80);
    if (PROXIED) await statements("reset");
    const r = await evaluateAccountRisk(a.id);
    if (PROXIED) report(`stop-out cascade, 2 closes`, await statements("get"));
    expect(r.stopOutClosed).toEqual([p1.id, p2.id]);
    expect(r.slTpClosed).toEqual([]);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p3.id } })).status).toBe("OPEN");
    const after = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.balance.toNumber()).toBe(70);
    expect(after.marginCallNotifiedAt).not.toBeNull();
    expect(await prisma.notification.count({ where: { brokerId, type: "MARGIN_CALL", entityId: a.id } })).toBe(2);
  });

  it("an SL close is followed by a margin pass on the re-read account, and a recovered account clears its margin call", async () => {
    const a = await account(1_000);
    const hit = await open(a.id, 100, { sl: 95 });
    const keep = await open(a.id, 90);
    await prisma.account.update({ where: { id: a.id }, data: { marginCallNotifiedAt: new Date() } });
    await price(94);
    const r = await evaluateAccountRisk(a.id);
    expect(r.slTpClosed).toEqual([hit.id]);
    expect(r.stopOutClosed).toEqual([]);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: keep.id } })).status).toBe("OPEN");
    const after = await prisma.account.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.balance.toNumber()).toBe(994); // 1000 - 6 from the SL close
    expect(after.marginCallNotifiedAt).toBeNull(); // (994 + 4) / 94 = 1062 % > 100: cleared
  });

  it("an account whose positions were all stopped out resets its margin-call flag", async () => {
    const a = await account(10);
    await open(a.id, 100);
    await prisma.account.update({ where: { id: a.id }, data: { marginCallNotifiedAt: new Date() } });
    await price(60);
    const r = await evaluateAccountRisk(a.id);
    expect(r.stopOutClosed).toHaveLength(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: a.id } })).marginCallNotifiedAt).toBeNull();
  });
});
