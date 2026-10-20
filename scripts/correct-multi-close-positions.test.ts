import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { bookPnlRealized } from "@/lib/book-pnl";
import { closePositionInTx } from "@/lib/position-close";
import { run, buildPlans, accountChecks, bookPnlBeforeAfter, CorrectionRefused, AUDIT_CORRECTED, AUDIT_REVERTED, type Opts } from "./correct-multi-close-positions";

// scripts/correct-multi-close-positions.ts on scratch data shaped like the live ones: positions closed in several
// pieces BEFORE the close-fields hotfix (realizedPnl / volume / closePrice = the last piece only, lots only in the notes).
const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "closedVolume" FROM "Position" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("correct-multi-close-positions.test.ts: DB unreachable or close_fields migration missing, skipping");
  }
});

const brokers: string[] = [];
afterEach(async () => {
  if (!dbReachable || brokers.length === 0) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.transaction.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  brokers.length = 0;
});
afterAll(async () => {
  await prisma.$disconnect();
}, 30000);

const HOST = "127.0.0.1";
const opts = (o: Partial<Opts> = {}): Opts => ({ apply: false, revert: false, confirmHost: null, host: HOST, ...o });
const APPLY = opts({ apply: true, confirmHost: "127.0" });

type Close = { lots: string; price: string; pnl: string; note: string | null; atSec: number };

async function world(opts?: { category?: "B_BOOK" | "A_BOOK" }) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Correct ${suffix}`, subdomain: `cr-${suffix}` } });
  brokers.push(broker.id);
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `G-${suffix}`, category: opts?.category ?? "B_BOOK" } });
  const symbol = await prisma.symbol.findUniqueOrThrow({ where: { name: "XAUUSD" } });
  return { brokerId: broker.id, groupId: group.id, symbolId: symbol.id, suffix };
}
type World = Awaited<ReturnType<typeof world>>;

/** A CLOSED position shaped like the live ones: realizedPnl / volume / closePrice are the last close only; the ledger is consistent. */
async function legacy(w: World, o: { orderVolume: string; swap?: string; closes: Close[]; accountNumber?: string; status?: "CLOSED" | "OPEN"; openVolume?: string; extraBalance?: number }) {
  const pnlTotal = o.closes.reduce((s, c) => s.add(c.pnl), D(0));
  const account = await prisma.account.create({
    data: { groupId: w.groupId, brokerId: w.brokerId, accountNumber: o.accountNumber ?? `5${randomUUID().replace(/-/g, "").slice(0, 7)}`, email: `cr-${randomUUID()}@test.local`, passwordHash: "x", fullName: "Correct", accountMode: "LIVE", balance: D(1000).add(pnlTotal).add(o.extraBalance ?? 0) },
  });
  await prisma.transaction.create({ data: { brokerId: w.brokerId, accountId: account.id, type: "ADJUSTMENT", status: "COMPLETED", amount: D(1000), balanceBefore: D(0), balanceAfter: D(1000), note: "Initial balance", createdAt: new Date(Date.now() - 700_000) } }); // before the closes, as in a real ledger
  const order = await prisma.order.create({
    data: { brokerId: w.brokerId, accountId: account.id, symbolId: w.symbolId, side: "BUY", type: "MARKET", volume: D(o.orderVolume), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `cr:${randomUUID()}` },
  });
  const last = o.closes[o.closes.length - 1];
  const closed = (o.status ?? "CLOSED") === "CLOSED";
  const position = await prisma.position.create({
    data: {
      brokerId: w.brokerId, accountId: account.id, symbolId: w.symbolId, originOrderId: order.id, side: "BUY", openPrice: D(100), swap: D(o.swap ?? 0),
      volume: D(closed ? last.lots : o.openVolume!), status: closed ? "CLOSED" : "OPEN", closePrice: closed ? D(last.price) : null, realizedPnl: closed ? D(last.pnl) : D(last.pnl),
      closedAt: closed ? new Date(Date.now() - 60_000) : null,
    },
  });
  let running = D(1000);
  for (const c of o.closes) {
    await prisma.transaction.create({
      data: { brokerId: w.brokerId, accountId: account.id, type: "TRADE_PNL", status: "COMPLETED", amount: D(c.pnl), balanceBefore: running, balanceAfter: running.add(c.pnl), referenceType: "Position", referenceId: position.id, note: c.note, createdAt: new Date(Date.now() - 600_000 + c.atSec * 1000) },
    });
    running = running.add(c.pnl);
  }
  return { position, account };
}

const TRI: Close[] = [
  { lots: "0.30", price: "101", pnl: "3.00", note: "Partial close: 0.30 lots @ 101", atSec: 1 },
  { lots: "0.20", price: "102", pnl: "4.00", note: "Manual partial close by admin: 0.20 lots @ 102", atSec: 2 },
  { lots: "0.50", price: "103", pnl: "15.00", note: null, atSec: 3 },
];

const snapshot = async () => ({
  positions: await prisma.$queryRaw`SELECT id, "realizedPnl", volume, "closedVolume", "closedSwap" FROM "Position" ORDER BY id`,
  txs: await prisma.$queryRaw`SELECT id, amount, "closeVolume", "closePrice", "closeSwap", "closeByPositionId" FROM "Transaction" ORDER BY id`,
  audits: await prisma.auditLog.count(),
});

describe("dry run", () => {
  it("prints the per-position table with masked accounts and writes nothing", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { position } = await legacy(w, { orderVolume: "1.00", swap: "-3.00", closes: TRI, accountNumber: "51234567" });
    const before = await snapshot();
    const r = await run(prisma, opts());
    expect(r.exitCode).toBe(0);
    expect(r.changedPositions).toBe(0);
    expect(await snapshot()).toEqual(before);
    const text = r.lines.join("\n");
    expect(text).toContain("***567");
    expect(text).not.toContain("51234567");
    const row = r.lines.find((l) => l.includes(String(position.ticket)) && l.includes("***567"))!;
    expect(row).toMatch(/0\.5 -> 1/); // old volume (last piece) -> new closedVolume
    expect(row).toMatch(/15 -> 22/); // old realizedPnl -> sum of the three TRADE_PNL amounts
    expect(row).toMatch(/none -> -3/); // closedSwap: 0.9 + 0.6 + 1.5 shares add up to the whole
    expect(row).toContain("note, note, final");
    expect(text).toContain("all affected accounts reconcile");
    expect(text).toContain("dry run: nothing written");
  });

  it("does not select the new columns (it must run on a database that does not have them yet)", async () => {
    if (!dbReachable) return;
    const w = await world();
    await legacy(w, { orderVolume: "1.00", closes: TRI });
    const seen: string[] = [];
    const record = (q: unknown) => { seen.push(typeof q === "object" && q && "sql" in q ? String((q as { sql: string }).sql) : String(q)); };
    // a transaction client that records the text of every raw statement and then runs it for real
    await prisma.$transaction(async (tx) => {
      const spy = new Proxy(tx, {
        get(target, prop, receiver) {
          if (prop === "$queryRaw") return (q: unknown, ...rest: unknown[]) => { record(q); return (target.$queryRaw as (...a: unknown[]) => unknown)(q, ...rest); };
          return Reflect.get(target, prop, receiver);
        },
      });
      const plans = await buildPlans(spy, false);
      await accountChecks(spy, plans.map((p) => p.pos.accountId));
      await bookPnlBeforeAfter(spy, plans, new Date());
    });
    const sql = seen.join("\n");
    expect(sql.length).toBeGreaterThan(100);
    for (const name of ["closedVolume", "closedSwap", "closeVolume", "closeSwap", "closeByPositionId"]) expect(sql).not.toContain(name);
    expect(sql).not.toMatch(/"closePrice"[^,]*FROM "Transaction"/); // only Position.closePrice (an old column) is read
  });
});

describe("book P/L before and after", () => {
  it("matches lib/book-pnl.ts for the before figure and moves by exactly the correction", async () => {
    if (!dbReachable) return;
    const w = await world();
    await legacy(w, { orderVolume: "1.00", closes: TRI });
    const lib = await bookPnlRealized(prisma, { brokerId: w.brokerId, coverageAccountId: null }, new Date(0));
    const r = await run(prisma, opts());
    const text = r.lines.join("\n");
    // Book P/L = minus the clients' P/L: before = -15, after = -22
    expect(lib.find((c) => c.currency === "USD")!.amount.toString()).toBe("-15");
    expect(text).toContain(`broker ${w.brokerId} USD all time: before -15.00 -> after -22.00 (change -7.00)`);
    expect(text).toContain(`broker ${w.brokerId} USD last 30 days: before -15.00 -> after -22.00`);
  });

  it("leaves out an A-book group (not held)", async () => {
    if (!dbReachable) return;
    const w = await world({ category: "A_BOOK" });
    await legacy(w, { orderVolume: "1.00", closes: TRI });
    const r = await run(prisma, opts());
    expect(r.lines.join("\n")).not.toContain(`broker ${w.brokerId}`);
  });
});

describe("ledger vs balance check", () => {
  it("stops (exit 2, nothing written, apply refused) when an affected account does not reconcile", async () => {
    if (!dbReachable) return;
    const w = await world();
    await legacy(w, { orderVolume: "1.00", closes: TRI, accountNumber: "59999111", extraBalance: 5 });
    const before = await snapshot();
    for (const o of [opts(), APPLY]) {
      const r = await run(prisma, o);
      expect(r.exitCode).toBe(2);
      expect(r.changedPositions).toBe(0);
      const text = r.lines.join("\n");
      expect(text).toContain("MISMATCH account ***111: balance 1027 vs ledger 1022 (opening 0, difference 5)");
      expect(text).toContain("STOPPED");
    }
    expect(await snapshot()).toEqual(before);
  });

  it("counts credit rows that moved the balance and ignores CREDIT_IN / CREDIT_OUT and pending requests", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { account } = await legacy(w, { orderVolume: "1.00", closes: TRI });
    const tx = (type: Prisma.TransactionCreateInput["type"], amount: number, status: "COMPLETED" | "PENDING" = "COMPLETED") =>
      prisma.transaction.create({ data: { brokerId: w.brokerId, accountId: account.id, type, status, amount: D(amount), balanceBefore: D(0), balanceAfter: D(0) } });
    await tx("CREDIT_IN", 500); // moves Account.credit, never the balance
    await tx("DEPOSIT", 300, "PENDING"); // not completed
    await tx("WITHDRAWAL", -100); // stored negative: moves the balance
    await tx("NEGATIVE_BALANCE_PROTECTION", 7);
    await tx("COMMISSION", -2);
    await tx("SWAP", -1);
    await prisma.account.update({ where: { id: account.id }, data: { balance: { increment: -100 + 7 - 2 - 1 } } });
    const r = await run(prisma, opts());
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("all affected accounts reconcile");
  });
});

describe("--apply", () => {
  it("refuses without --confirm-host, with a host that does not match, and without the new columns", async () => {
    if (!dbReachable) return;
    const w = await world();
    await legacy(w, { orderVolume: "1.00", closes: TRI });
    const before = await snapshot();
    await expect(run(prisma, opts({ apply: true }))).rejects.toThrow(CorrectionRefused);
    await expect(run(prisma, opts({ apply: true, confirmHost: "" }))).rejects.toThrow(/--confirm-host/);
    await expect(run(prisma, opts({ apply: true, confirmHost: "neon.tech" }))).rejects.toThrow(/not part of the database host/);
    await expect(run(prisma, opts({ apply: true, confirmHost: "127.0", legacySchema: true }))).rejects.toThrow(/migration is not applied/);
    expect(await snapshot()).toEqual(before);
  });

  it("writes position and ledger-row fields, stores the old values in an AuditLog row, and a second run changes nothing", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { position } = await legacy(w, { orderVolume: "1.00", swap: "-3.00", closes: TRI });
    const r = await run(prisma, APPLY);
    expect(r.exitCode).toBe(0);
    expect(r.changedPositions).toBe(1);

    const p = await prisma.position.findUniqueOrThrow({ where: { id: position.id } });
    expect([p.realizedPnl?.toString(), p.closedVolume?.toString(), p.closedSwap?.toString(), p.swap.toString(), p.volume.toString()]).toEqual(["22", "1", "-3", "-3", "0.5"]);
    const rows = await prisma.transaction.findMany({ where: { referenceId: position.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    expect(rows.map((t) => [t.closeVolume?.toString(), t.closePrice?.toString(), t.closeSwap?.toString()])).toEqual([
      ["0.3", "101", "-0.9"],
      ["0.2", "102", "-0.6"],
      ["0.5", "103", "-1.5"],
    ]);
    const audit = await prisma.auditLog.findMany({ where: { action: AUDIT_CORRECTED, entityId: position.id } });
    expect(audit).toHaveLength(1);
    const old = audit[0].oldValue as { position: Record<string, string | null>; transactions: { id: string; closeVolume: string | null }[] };
    expect(old.position).toEqual({ realizedPnl: "15", closedVolume: null, closedSwap: null });
    expect(old.transactions).toHaveLength(3);

    const snap = await snapshot();
    const again = await run(prisma, APPLY);
    expect(again.exitCode).toBe(0);
    expect(again.changedPositions).toBe(0);
    expect(await snapshot()).toEqual(snap); // no new audit row either
  });

  it("a position closed by the NEW writer needs no correction (script and closePositionInTx agree)", async () => {
    if (!dbReachable) return;
    const w = await world();
    const account = await prisma.account.create({ data: { groupId: w.groupId, brokerId: w.brokerId, accountNumber: `4${w.suffix.slice(0, 7)}`, email: `n-${w.suffix}@test.local`, passwordHash: "x", fullName: "New", accountMode: "LIVE", balance: D(1000) } });
    await prisma.transaction.create({ data: { brokerId: w.brokerId, accountId: account.id, type: "ADJUSTMENT", status: "COMPLETED", amount: D(1000), balanceBefore: D(0), balanceAfter: D(1000) } });
    const order = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: account.id, symbolId: w.symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", filledPrice: D(100), filledAt: new Date(), idempotencyKey: `n:${randomUUID()}` } });
    const p = await prisma.position.create({ data: { brokerId: w.brokerId, accountId: account.id, symbolId: w.symbolId, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100), swap: D("-1.01") } });
    for (const [lots, price] of [["0.33", "101"], ["0.33", "102"], ["0.34", "103"]]) {
      const cur = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
      await prisma.$transaction((tx) => closePositionInTx(tx, { deal: { reason: "CLIENT" }, position: { id: p.id, accountId: account.id, brokerId: w.brokerId, side: "BUY", openPrice: cur.openPrice, volume: cur.volume, symbol: { contractSize: D(1) } }, closePrice: price, closeVolume: D(lots) }));
    }
    const before = await snapshot();
    const r = await run(prisma, APPLY);
    expect(r.exitCode).toBe(0);
    expect(r.changedPositions).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it("one close without lots in its note is derived from the opening order; two stay UNKNOWN and get only the P/L", async () => {
    if (!dbReachable) return;
    const w = await world();
    const one = await legacy(w, {
      orderVolume: "1.00",
      closes: [
        { lots: "0.30", price: "101", pnl: "3.00", note: "Partial close: 0.30 lots @ 101", atSec: 1 },
        { lots: "0.20", price: "0", pnl: "2.00", note: "Mirror close (rule r, source position s, mode SOURCE_PRICE)", atSec: 2 },
        { lots: "0.50", price: "103", pnl: "15.00", note: null, atSec: 3 },
      ],
    });
    const two = await legacy(w, {
      orderVolume: "1.00",
      closes: [
        { lots: "0", price: "0", pnl: "2.00", note: "Mirror close (rule r, source position s, mode SOURCE_PRICE)", atSec: 1 },
        { lots: "0", price: "0", pnl: "3.00", note: "Coverage auto-close (auto-hedged leg): client #1 closed 1 of 2", atSec: 2 },
        { lots: "0.50", price: "103", pnl: "15.00", note: null, atSec: 3 },
      ],
    });
    const dry = await run(prisma, opts());
    const text = dry.lines.join("\n");
    expect(dry.lines.find((l) => l.includes(String(one.position.ticket)))).toContain("note, derived, final");
    expect(dry.lines.find((l) => l.includes(String(two.position.ticket)))).toContain("UNKNOWN, UNKNOWN, final");
    expect(text).toContain("2 close(s) UNKNOWN");
    await run(prisma, APPLY);
    const a = await prisma.position.findUniqueOrThrow({ where: { id: one.position.id } });
    expect([a.realizedPnl?.toString(), a.closedVolume?.toString()]).toEqual(["20", "1"]);
    const rowsOne = await prisma.transaction.findMany({ where: { referenceId: one.position.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    expect(rowsOne.map((t) => t.closeVolume?.toString())).toEqual(["0.3", "0.2", "0.5"]);
    expect(rowsOne[1].closePrice).toBeNull(); // the derived close's price is not known, so none is written
    const b = await prisma.position.findUniqueOrThrow({ where: { id: two.position.id } });
    expect([b.realizedPnl?.toString(), b.closedVolume, b.closedSwap]).toEqual(["20", null, null]);
  });

  it("reads a close-by leg's lots, price and link from the counterpart", async () => {
    if (!dbReachable) return;
    const w = await world();
    const big = await legacy(w, { orderVolume: "1.00", closes: [{ lots: "0", price: "0", pnl: "-4.00", note: null, atSec: 1 }, { lots: "0.60", price: "99", pnl: "-6.00", note: null, atSec: 2 }] });
    const small = await legacy(w, { orderVolume: "0.40", closes: [{ lots: "0.40", price: "100.05", pnl: "1.00", note: null, atSec: 1 }] });
    // wire the close-by by hand: big's first close is a close-by against small, which closed fully in it at the same instant
    const first = await prisma.transaction.findFirstOrThrow({ where: { referenceId: big.position.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    await prisma.transaction.update({ where: { id: first.id }, data: { note: `Close by ${small.position.id}` } });
    await prisma.position.update({ where: { id: small.position.id }, data: { closedAt: first.createdAt } });
    const r = await run(prisma, APPLY);
    expect(r.exitCode).toBe(0);
    const rows = await prisma.transaction.findMany({ where: { referenceId: big.position.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    expect([rows[0].closeVolume?.toString(), rows[0].closePrice?.toString(), rows[0].closeByPositionId]).toEqual(["0.4", "100.05", small.position.id]);
    expect([rows[1].closeVolume?.toString(), rows[1].closePrice?.toString()]).toEqual(["0.6", "99"]);
    const p = await prisma.position.findUniqueOrThrow({ where: { id: big.position.id } });
    expect([p.closedVolume?.toString(), p.realizedPnl?.toString()]).toEqual(["1", "-10"]);
  });
});

describe("--revert", () => {
  it("restores the old values from the AuditLog rows, leaves a REVERTED marker, and applying again works", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { position } = await legacy(w, { orderVolume: "1.00", swap: "-3.00", closes: TRI });
    const original = await snapshot();
    await run(prisma, APPLY);
    expect(await snapshot()).not.toEqual(original);

    const dry = await run(prisma, opts({ revert: true }));
    expect(dry.lines.join("\n")).toContain("would restore position");
    expect(dry.changedPositions).toBe(0);

    const rev = await run(prisma, { ...APPLY, revert: true });
    expect(rev.exitCode).toBe(0);
    expect(rev.changedPositions).toBe(1);
    const after = await snapshot();
    expect(after.positions).toEqual(original.positions);
    expect(after.txs).toEqual(original.txs);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_REVERTED, entityId: position.id } })).toBe(1);

    // nothing left to revert
    expect((await run(prisma, { ...APPLY, revert: true })).changedPositions).toBe(0);
    // and the correction can be applied again
    expect((await run(prisma, APPLY)).changedPositions).toBe(1);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: position.id } })).realizedPnl?.toString()).toBe("22");
  });

  it("is host guarded too", async () => {
    if (!dbReachable) return;
    await expect(run(prisma, opts({ revert: true, apply: true, confirmHost: "nope" }))).rejects.toThrow(CorrectionRefused);
  });
});

describe("owner decisions 2026-10-12", () => {
  it("reconciles an account whose opening balance has no ledger row (first row's balanceBefore)", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { account } = await legacy(w, { orderVolume: "1.00", closes: TRI, accountNumber: "59999221", extraBalance: 500 });
    const first = await prisma.transaction.findFirstOrThrow({ where: { accountId: account.id, type: "ADJUSTMENT" } });
    await prisma.transaction.update({ where: { id: first.id }, data: { balanceBefore: D(500), balanceAfter: D(1500) } });
    const r = await run(prisma, opts());
    expect(r.exitCode).toBe(0);
    expect(r.lines.join("\n")).toContain("all affected accounts reconcile");
  });

  it("leaves duplicate closes (same amount, no note, < 1 s apart) out of the sums, lists them, and never writes them", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { position, account } = await legacy(w, {
      orderVolume: "1.00",
      closes: [
        { lots: "1.00", price: "101", pnl: "-18.20", note: null, atSec: 1 },
        { lots: "1.00", price: "101", pnl: "-18.20", note: null, atSec: 1.12 },
      ],
      accountNumber: "59999331",
    });
    const dry = await run(prisma, opts());
    const text = dry.lines.join("\n");
    expect(dry.exitCode).toBe(0);
    expect(text).toContain("duplicate closes (same amount as the previous close, no note, < 1 s apart; left out of every sum, nothing written): 1");
    const dupLine = dry.lines.find((l) => l.includes(`ticket ${position.ticket}  ***331  amount -18.2  `)) ?? "";
    expect(dupLine).toMatch(/ 1[12][0-9] ms after the previous close/);
    expect(dry.lines.find((l) => l.startsWith(String(position.ticket)))).toContain("-18.2 -> -18.2");
    await run(prisma, APPLY);
    const rows = await prisma.transaction.findMany({ where: { referenceId: position.id, type: "TRADE_PNL" }, orderBy: { createdAt: "asc" } });
    expect(rows[1].closeVolume).toBeNull();
    expect((await prisma.position.findUniqueOrThrow({ where: { id: position.id } })).realizedPnl?.toString()).toBe("-18.2");
    expect(account.id).toBeTruthy();
  });

  it("--only-accounts limits checks and writes to those accounts and refuses an ambiguous or unknown suffix", async () => {
    if (!dbReachable) return;
    const w = await world();
    const inside = await legacy(w, { orderVolume: "1.00", closes: TRI, accountNumber: "59999708" });
    const outside = await legacy(w, { orderVolume: "1.00", closes: TRI, accountNumber: "59999704", extraBalance: 360.25 });
    const dry = await run(prisma, opts({ onlyAccounts: ["59999708"] }));
    const text = dry.lines.join("\n");
    expect(dry.exitCode).toBe(0); // the mismatching account is excluded, so it does not stop the run
    expect(text).toContain("limited to 1 account(s) (--only-accounts): ***708");
    expect(text).toContain("excluded, not checked and never written: ");
    expect(text).toContain("***704 (1 positions)");
    await run(prisma, { ...APPLY, onlyAccounts: ["59999708"] });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: inside.position.id } })).realizedPnl?.toString()).toBe("22");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: outside.position.id } })).realizedPnl?.toString()).toBe("15");
    await expect(run(prisma, opts({ onlyAccounts: ["9"] }))).rejects.toThrow(CorrectionRefused);
    await expect(run(prisma, opts({ onlyAccounts: ["12345678"] }))).rejects.toThrow(/matches 0 affected/);
  });
});
