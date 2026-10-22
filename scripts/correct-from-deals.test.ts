import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { BackfillRefused } from "./backfill-deals";
import { parseArgs, run } from "./correct-from-deals";

// Deal model step 7 on internal accounts (owner 2026-10-22), on synthetic positions and deals in the scratch database.
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const prisma = new PrismaClient();
const HOST = "127.0.0.1:5499";

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "DealBackfillLog" LIMIT 1`;
    const [where] = await prisma.$queryRaw<{ port: number }[]>`SELECT inet_server_port() AS port`;
    dbReachable = Number(where.port) === 5499;
  } catch {
    console.warn("scripts/correct-from-deals.test.ts: scratch DB unreachable or deal migrations missing, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Fx = { brokerId: string; internalId: string; clientId: string; symbolId: string };
async function fixture(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Step7 ${sfx}`, subdomain: `s7-${sfx}` } });
  const symbol = await prisma.symbol.create({ data: { name: `S7${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `S7G-${sfx}` } });
  const mk = (n: string, isInternal: boolean) =>
    prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${sfx.slice(0, 7)}`, email: `s7-${n}-${sfx}@test.local`, passwordHash: "x", fullName: "Step7", accountMode: "LIVE", balance: D(100000), currency: "USD", isInternal } });
  const [internal, client] = [await mk("7", true), await mk("8", false)];
  return { brokerId: broker.id, internalId: internal.id, clientId: client.id, symbolId: symbol.id };
}

let clock = Date.parse("2026-09-01T10:00:00Z");
const at = () => new Date((clock += 60_000));

// a closed BUY of `lots` at 100 with the given closes [lots, price, profit], each with its TRADE_PNL row, after an
// optional reverse-in-place flip pair (no ledger row); realizedPnl / closePrice = the last close
async function closed(fx: Fx, accountId: string, lots: string, closes: [string, string, string][], flip = false) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(lots), status: "FILLED", filledPrice: D(100), filledAt: at(), idempotencyKey: `s7:${randomUUID()}` },
  });
  const last = closes[closes.length - 1];
  const p = await prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D(last[0]), openPrice: D(100),
      status: "CLOSED", closePrice: D(last[1]), realizedPnl: D(last[2]), initialVolume: D(lots), openedAt: at(), closedAt: at(),
    },
  });
  const base = { brokerId: fx.brokerId, accountId, positionId: p.id, symbolId: fx.symbolId };
  await prisma.deal.create({ data: { ...base, side: "BUY", entry: "IN", reason: "CLIENT", volume: D(lots), price: D(100), executedAt: at() } });
  if (flip) {
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "REVERSE", volume: D(lots), price: D(100), executedAt: at() } });
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "IN", reason: "REVERSE", volume: D(lots), price: D(100), executedAt: at() } });
  }
  for (const [v, price, profit] of closes) {
    const t = await prisma.transaction.create({
      data: { brokerId: fx.brokerId, accountId, type: "TRADE_PNL", status: "COMPLETED", amount: D(profit), balanceBefore: D(0), balanceAfter: D(profit), referenceType: "Position", referenceId: p.id, createdAt: at() },
    });
    await prisma.deal.create({ data: { ...base, side: "SELL", entry: "OUT", reason: "CLIENT", volume: D(v), price: D(price), profit: D(profit), transactionId: t.id, executedAt: at() } });
  }
  return p;
}

const opts = (fx: Fx, extra: Partial<Parameters<typeof run>[1]> = {}) =>
  ({ apply: false, restore: null, confirmHost: null, host: HOST, broker: fx.brokerId, ...extra });
const row = async (id: string) => {
  const p = await prisma.position.findUniqueOrThrow({ where: { id } });
  return [p.realizedPnl?.toString(), p.closePrice?.toString()];
};

describe("arguments (pure)", () => {
  it("parses and refuses", () => {
    expect(parseArgs(["--apply", "--confirm-host", "ep-x"])).toMatchObject({ apply: true, confirmHost: "ep-x", restore: null });
    expect(parseArgs(["--restore", "r1", "--confirm-host", "ep-x"])).toMatchObject({ apply: false, restore: "r1" });
    expect(() => parseArgs(["--apply", "--restore", "r1"])).toThrow(BackfillRefused);
    expect(() => parseArgs(["--nope"])).toThrow(BackfillRefused);
  });
});

describe("step 7 on internal accounts (scratch DB)", () => {
  it("rewrites a multi-close internal position, skips a 0-lot duplicate booking and client accounts, restores once", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // three partials: realizedPnl held only the last one (2.00), closePrice the last price
    const multi = await closed(fx, fx.internalId, "1.00", [["0.50", "110", "5"], ["0.30", "120", "6"], ["0.20", "110", "2"]]);
    // one close plus a duplicate booking (0 lots, same money): the trade's P/L is the one close
    const dup = await closed(fx, fx.internalId, "0.10", [["0.10", "105", "0.5"], ["0.00", "105", "0.5"]]);
    // a reverse-in-place flip before one close: the flip's OUT is not a close, nothing to change
    const flipped = await closed(fx, fx.internalId, "0.10", [["0.10", "90", "-1"]], true);
    // the same shape on a client account is out of scope
    const client = await closed(fx, fx.clientId, "1.00", [["0.50", "110", "5"], ["0.50", "120", "10"]]);

    const dry = await run(prisma, opts(fx));
    expect(dry.exitCode).toBe(0);
    expect(dry.changes.map((c) => [c.ticket, c.newPnl, c.newClose])).toEqual([[multi.ticket, "13", "113"]]);
    expect(await row(multi.id)).toEqual(["2", "110"]);

    await expect(run(prisma, opts(fx, { apply: true }))).rejects.toThrow(/confirm-host/);
    const done = await run(prisma, opts(fx, { apply: true, confirmHost: "127.0.0.1" }));
    expect(done.runId).toBeTruthy();
    expect(await row(multi.id)).toEqual(["13", "113"]);
    expect(await row(dup.id)).toEqual(["0.5", "105"]);
    expect(await row(flipped.id)).toEqual(["-1", "90"]);
    expect(await row(client.id)).toEqual(["10", "120"]);
    const log = await prisma.dealBackfillLog.findMany({ where: { runId: done.runId }, orderBy: { field: "asc" } });
    expect(log.map((l) => [l.field, l.oldValue, l.newValue])).toEqual([["closePrice", "110", "113"], ["realizedPnl", "2", "13"]]);

    // a second run finds nothing
    expect((await run(prisma, opts(fx, { apply: true, confirmHost: "127.0.0.1" }))).changes).toEqual([]);

    const back = await run(prisma, opts(fx, { restore: done.runId!, confirmHost: "127.0.0.1" }));
    expect(back.lines[0]).toMatch(/RESTORED: 2 value/);
    expect(await row(multi.id)).toEqual(["2", "110"]);
    expect((await run(prisma, opts(fx, { restore: done.runId!, confirmHost: "127.0.0.1" }))).lines[0]).toMatch(/RESTORED: 0 value/);
  });

  it("refuses the whole run when an internal position's close lots do not add up", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const ok = await closed(fx, fx.internalId, "1.00", [["0.50", "110", "5"], ["0.50", "120", "10"]]);
    const short = await closed(fx, fx.internalId, "1.00", [["0.40", "110", "4"], ["0.50", "120", "10"]]);
    const r = await run(prisma, opts(fx, { apply: true, confirmHost: "127.0.0.1" }));
    expect(r.exitCode).toBe(1);
    expect(r.lines.join("\n")).toMatch(new RegExp(`PROBLEM #${short.ticket}.*0\\.9 != opening volume 1`));
    expect(await row(ok.id)).toEqual(["10", "120"]);
  });
});
