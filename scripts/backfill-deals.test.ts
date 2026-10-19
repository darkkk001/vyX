import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma, PrismaClient } from "@prisma/client";
import { openReason, parseArgs, reasonFromNote, restoreFromLog, run, BackfillRefused } from "./backfill-deals";
import { bookPnlRealized } from "@/lib/book-pnl";

// Deal model step 3 (docs/POSITION-DEAL-MODEL.md section 4, "Backfill" row): the backfill on synthetic history in the
// scratch database, one broker per test (every run is limited to it with --broker). History is written row by row the
// way the old close paths left it (notes, no structured fields), so each case is what the live data holds.
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
    console.warn("scripts/backfill-deals.test.ts: scratch DB unreachable or deal_backfill_log migration missing, skipping");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
});

type Fx = { brokerId: string; adminId: string; accountId: string; eurAccountId: string; groupId: string; symbolId: string };
async function fixture(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Backfill ${sfx}`, subdomain: `bf-${sfx}` } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `bf-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const symbol = await prisma.symbol.create({ data: { name: `BF${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `BFG-${sfx}` } });
  const mk = (n: string, currency: string) =>
    prisma.account.create({ data: { groupId: group.id, brokerId: broker.id, accountNumber: `${n}${sfx.slice(0, 7)}`, email: `bf-${n}-${sfx}@test.local`, passwordHash: "x", fullName: "Backfill", accountMode: "LIVE", balance: D(100000), currency } });
  const [usd, eur] = [await mk("2", "USD"), await mk("1", "EUR")];
  return { brokerId: broker.id, adminId: admin.id, accountId: usd.id, eurAccountId: eur.id, groupId: group.id, symbolId: symbol.id };
}

let clock = Date.parse("2026-09-01T10:00:00Z");
const at = (plusSec = 60) => new Date((clock += plusSec * 1000));

async function position(fx: Fx, o: {
  side: "BUY" | "SELL"; orderVolume: string; volume?: string; openPrice: string; status?: "OPEN" | "CLOSED" | "VOIDED"; closePrice?: string;
  realizedPnl?: string; swap?: string; key?: string; accountId?: string;
}) {
  const accountId = o.accountId ?? fx.accountId;
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: o.side, type: "MARKET", volume: D(o.orderVolume), status: "FILLED", filledPrice: D(o.openPrice), filledAt: new Date(clock), idempotencyKey: o.key ?? `bf:${randomUUID()}` },
  });
  return prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: order.id, side: o.side, volume: D(o.volume ?? o.orderVolume), openPrice: D(o.openPrice),
      status: o.status ?? "OPEN", closePrice: o.closePrice ? D(o.closePrice) : null, realizedPnl: o.realizedPnl ? D(o.realizedPnl) : null, swap: D(o.swap ?? 0),
      openedAt: at(), closedAt: o.status && o.status !== "OPEN" ? new Date(clock + 3600_000) : null,
    },
  });
}
async function pnl(fx: Fx, positionId: string, amount: string, note: string | null, when = at(), accountId = fx.accountId) {
  return prisma.transaction.create({
    data: { brokerId: fx.brokerId, accountId, type: "TRADE_PNL", status: "COMPLETED", amount: D(amount), balanceBefore: D(0), balanceAfter: D(amount), referenceType: "Position", referenceId: positionId, note, createdAt: when },
  });
}
async function commission(fx: Fx, positionId: string, amount: string) {
  return prisma.transaction.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, type: "COMMISSION", status: "COMPLETED", amount: D(amount), balanceBefore: D(0), balanceAfter: D(amount), referenceType: "Position", referenceId: positionId, createdAt: at(1) },
  });
}
async function audit(fx: Fx, action: string, entityId: string, oldValue: object | null, newValue: object | null, when = at()) {
  return prisma.auditLog.create({ data: { brokerId: fx.brokerId, actorAdminId: fx.adminId, action, entityType: "Position", entityId, oldValue: oldValue ?? undefined, newValue: newValue ?? undefined, createdAt: when } });
}

const bf = (fx: Fx, extra: Partial<Parameters<typeof run>[1]> = {}) =>
  run(prisma, { apply: false, confirmHost: null, host: HOST, skipAmbiguous: false, from: "", batch: 500, broker: fx.brokerId, ...extra });
const apply = (fx: Fx, extra: Partial<Parameters<typeof run>[1]> = {}) => bf(fx, { apply: true, confirmHost: "127.0.0.1", ...extra });
const deals = (positionId: string) => prisma.deal.findMany({ where: { positionId }, orderBy: [{ executedAt: "asc" }, { ticket: "asc" }] });
const brief = (d: { entry: string; reason: string; side: string; volume: Prisma.Decimal; price: Prisma.Decimal; profit: Prisma.Decimal }) =>
  [d.entry, d.reason, d.side, d.volume.toString(), d.price.toString(), d.profit.toString()];
async function withoutDeal(fx: Fx) {
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "Transaction" t WHERE t."brokerId" = ${fx.brokerId} AND t.type = 'TRADE_PNL' AND NOT EXISTS (SELECT 1 FROM "Deal" d WHERE d."transactionId" = t.id)`;
  return Number(r.n);
}

describe("note and order mapping (pure)", () => {
  it("maps every close note the paths write; an unknown note is CLIENT, flagged", () => {
    expect(reasonFromNote(null)).toEqual({ reason: "CLIENT", known: true });
    expect(reasonFromNote("Partial close: 0.4 lots @ 101")).toEqual({ reason: "CLIENT", known: true });
    expect(reasonFromNote("Manual partial close by admin: 0.4 lots @ 101").reason).toBe("ADMIN");
    expect(reasonFromNote("Stop loss hit (automatic)").reason).toBe("SL");
    expect(reasonFromNote("Stop loss hit (demo)").reason).toBe("SL");
    expect(reasonFromNote("Take profit hit (automatic)").reason).toBe("TP");
    expect(reasonFromNote("Stop-out (automatic): margin level 9% at or below 50%").reason).toBe("STOP_OUT");
    expect(reasonFromNote("Bulk close (ALL)").reason).toBe("BULK");
    expect(reasonFromNote("Dealer close (at market)").reason).toBe("DEALER");
    expect(reasonFromNote("Dealer desk turned off: queued close executed at market").reason).toBe("DEALER");
    expect(reasonFromNote("Mirror close (rule r, source position s, mode SOURCE_PRICE)").reason).toBe("MIRROR");
    expect(reasonFromNote("Coverage auto-close (auto-hedged leg): client #1 closed 1 of 2").reason).toBe("COVERAGE");
    expect(reasonFromNote("Close by #100000123").reason).toBe("CLOSE_BY");
    expect(reasonFromNote("Reversed (close & reopen) by admin @ 100").reason).toBe("REVERSE");
    expect(reasonFromNote("Reversed by admin @ 4438.33")).toEqual({ reason: "REVERSE", known: true });
    expect(reasonFromNote("something else")).toEqual({ reason: "CLIENT", known: false });
  });
  it("maps the opening order's key", () => {
    expect(openReason("mirror:r:s", false)).toBe("MIRROR");
    expect(openReason("coverage_autohedge_x", false)).toBe("COVERAGE");
    expect(openReason("coverage_dealer_x", false)).toBe("COVERAGE");
    expect(openReason("manual_x", false)).toBe("ADMIN");
    expect(openReason("manual_x", true)).toBe("REVERSE");
    expect(openReason("anything", false)).toBe("CLIENT");
  });
  it("arguments", () => {
    expect(parseArgs(["--apply", "--confirm-host", "ep-x", "--skip-ambiguous", "--from", "abc", "--batch", "10"])).toMatchObject({ apply: true, confirmHost: "ep-x", skipAmbiguous: true, from: "abc", batch: 10 });
    expect(() => parseArgs(["--nope"])).toThrow(BackfillRefused);
  });
});

describe("backfill on synthetic history (scratch DB)", () => {
  it("single close: IN with the commission and its ledger row, one OUT = the Position row; initialVolume set", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "10" });
    const c = await commission(fx, p.id, "-7");
    const t = await pnl(fx, p.id, "10", null);
    const r = await apply(fx);
    expect(r.exitCode).toBe(0);
    const ds = await deals(p.id);
    expect(ds.map(brief)).toEqual([["IN", "CLIENT", "BUY", "1", "100", "0"], ["OUT", "CLIENT", "SELL", "1", "110", "10"]]);
    expect([ds[0].commission.toString(), ds[0].transactionId, ds[0].orderId, ds[1].transactionId]).toEqual(["-7", c.id, p.originOrderId, t.id]);
    expect(ds.every((d) => d.backfilled)).toBe(true);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).initialVolume?.toString()).toBe("1");
  });

  it("partial + final: OUT per piece; the dry run prints old -> new P/L and volume", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // the old model: the row keeps the last piece only (0.6 lots, P/L 6)
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "6", swap: "3" });
    await pnl(fx, p.id, "4", "Partial close: 0.4 lots @ 110");
    await pnl(fx, p.id, "6", null);
    const dry = await bf(fx);
    const line = dry.lines.find((l) => l.startsWith(`${p.ticket} |`));
    expect(line).toContain("6 -> 10");
    expect(line).toContain("0.6 -> 1");
    // broker view (minus the clients' P/L): the row's 6 -> the deals' 10
    expect(dry.lines.some((l) => l.startsWith("Backfill ") && l.includes(" USD: -6.00 -> -10.00 (difference -4.00; 1 closed position(s))"))).toBe(true);
    await apply(fx);
    expect((await deals(p.id)).map((d) => [...brief(d), d.swap.toString()])).toEqual([
      ["IN", "CLIENT", "BUY", "1", "100", "0", "0"],
      ["OUT", "CLIENT", "SELL", "0.4", "110", "4", "1.2"],
      ["OUT", "CLIENT", "SELL", "0.6", "110", "6", "1.8"],
    ]);
  });

  it("close-by instant: two OUT_BY linked both ways, the larger leg's piece from its counterpart", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "120", realizedPnl: "12" });
    const b = await position(fx, { side: "SELL", orderVolume: "0.40", openPrice: "110", status: "CLOSED", closePrice: "105", realizedPnl: "2" });
    const when = at();
    await prisma.position.update({ where: { id: b.id }, data: { closedAt: when } });
    await pnl(fx, a.id, "2", `Close by ${b.id}`, when);
    await pnl(fx, b.id, "2", `Close by #${a.ticket}`, when);
    await pnl(fx, a.id, "12", null);
    await apply(fx);
    expect((await deals(a.id)).map((d) => [...brief(d), d.byPositionId])).toEqual([
      ["IN", "CLIENT", "BUY", "1", "100", "0", null],
      ["OUT_BY", "CLOSE_BY", "SELL", "0.4", "105", "2", b.id],
      ["OUT", "CLIENT", "SELL", "0.6", "120", "12", null],
    ]);
    expect((await deals(b.id)).map((d) => [...brief(d), d.byPositionId])).toEqual([
      ["IN", "CLIENT", "SELL", "0.4", "110", "0", null],
      ["OUT_BY", "CLOSE_BY", "BUY", "0.4", "105", "2", a.id],
    ]);
  });

  it("close-by through the dealer queue (link lost): plain DEALER OUTs; the larger leg's piece is derived and its price back-solved", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "120", realizedPnl: "12" });
    const b = await position(fx, { side: "SELL", orderVolume: "0.40", openPrice: "110", status: "CLOSED", closePrice: "105", realizedPnl: "2" });
    await pnl(fx, a.id, "2", "Dealer close (at requested price)");
    await pnl(fx, b.id, "2", "Dealer close (at requested price)");
    await pnl(fx, a.id, "12", null);
    const r = await apply(fx);
    expect(r.lines.some((l) => l.startsWith(`${a.ticket}: derived close`) && l.includes("0.4 lots @ 105"))).toBe(true);
    const da = await deals(a.id);
    expect(da.map((d) => [...brief(d), d.byPositionId])).toEqual([
      ["IN", "CLIENT", "BUY", "1", "100", "0", null],
      ["OUT", "DEALER", "SELL", "0.4", "105", "2", null],
      ["OUT", "CLIENT", "SELL", "0.6", "120", "12", null],
    ]);
    expect(da[1].backfillNote).toMatch(/derived/);
    expect((await deals(b.id)).map(brief)[1]).toEqual(["OUT", "DEALER", "BUY", "0.4", "105", "2"]);
  });

  it("staff partial then staff close: ADMIN OUTs from the note and the row", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "SELL", orderVolume: "2.00", volume: "1.50", openPrice: "110", status: "CLOSED", closePrice: "104", realizedPnl: "9" });
    await prisma.position.update({ where: { id: p.id }, data: { closedByAdminId: fx.adminId } });
    await pnl(fx, p.id, "5", "Manual partial close by admin: 0.5 lots @ 100");
    await pnl(fx, p.id, "9", "Manual close by admin @ 104");
    await apply(fx);
    const ds = await deals(p.id);
    expect(ds.map(brief)).toEqual([["IN", "CLIENT", "SELL", "2", "110", "0"], ["OUT", "ADMIN", "BUY", "0.5", "100", "5"], ["OUT", "ADMIN", "BUY", "1.5", "104", "9"]]);
    expect(ds[2].adminId).toBe(fx.adminId);
  });

  it("mirror and coverage partials with no lots in the note: one unknown is derived; two unknowns are AMBIGUOUS and refuse --apply", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const m = await position(fx, { side: "SELL", orderVolume: "1.00", volume: "0.75", openPrice: "100", status: "CLOSED", closePrice: "97", realizedPnl: "2.25", key: "mirror:r1:s1" });
    await pnl(fx, m.id, "0.5", "Mirror close (rule r1, source position s1, mode SOURCE_PRICE)");
    await pnl(fx, m.id, "2.25", "Mirror close (rule r1, source position s1, mode SOURCE_PRICE)");
    const c = await position(fx, { side: "BUY", orderVolume: "2.00", volume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "101", realizedPnl: "1", key: "coverage_autohedge_x" });
    await pnl(fx, c.id, "0.5", "Coverage auto-close (auto-hedged leg): client #1 closed 0.5 of 2");
    await pnl(fx, c.id, "0.25", "Coverage auto-close (auto-hedged leg): client #1 closed 0.5 of 1.5");
    await pnl(fx, c.id, "1", "Coverage auto-close (auto-hedged leg): client #1 closed 1 of 1");

    const dry = await bf(fx);
    expect(dry.lines.some((l) => l.startsWith(`${c.ticket} (${c.id})`) && l.includes("2 TRADE_PNL rows without lots"))).toBe(true);
    const refused = await apply(fx);
    expect(refused.exitCode).toBe(2);
    expect(await prisma.deal.count({ where: { brokerId: fx.brokerId } })).toBe(0);

    const r = await apply(fx, { skipAmbiguous: true });
    expect(r.exitCode).toBe(0);
    expect((await deals(m.id)).map(brief)).toEqual([["IN", "MIRROR", "SELL", "1", "100", "0"], ["OUT", "MIRROR", "BUY", "0.25", "98", "0.5"], ["OUT", "MIRROR", "BUY", "0.75", "97", "2.25"]]);
    expect(await deals(c.id)).toHaveLength(0);
    expect(await withoutDeal(fx)).toBe(3); // the ambiguous position's rows only
  });

  it("a derived price that needs a conversion rate is AMBIGUOUS (no historical rate is stored)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.50", openPrice: "100", status: "CLOSED", closePrice: "104", realizedPnl: "1.8", accountId: fx.eurAccountId });
    await pnl(fx, p.id, "2", "Coverage auto-close (auto-hedged leg): x", at(), fx.eurAccountId);
    await pnl(fx, p.id, "1.8", null, at(), fx.eurAccountId);
    const dry = await bf(fx);
    expect(dry.lines.some((l) => l.startsWith(`${p.ticket} (${p.id})`) && l.includes("USD/EUR rate"))).toBe(true);
  });

  it("reverse close-and-reopen: the old position's OUT is REVERSE, the new one gets an IN REVERSE and reversedFromPositionId", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const old = await position(fx, { side: "BUY", orderVolume: "0.80", openPrice: "90", status: "CLOSED", closePrice: "100", realizedPnl: "8" });
    await prisma.position.update({ where: { id: old.id }, data: { closedByAdminId: fx.adminId } });
    await pnl(fx, old.id, "8", "Reversed (close & reopen) by admin @ 100");
    const reopened = await position(fx, { side: "SELL", orderVolume: "0.80", openPrice: "100", key: `manual_${randomUUID()}` });
    await audit(fx, "MANUAL_POSITION_REVERSE", old.id, { side: "BUY" }, { newPositionId: reopened.id, newSide: "SELL" });
    await apply(fx);
    expect((await deals(old.id)).map(brief)[1]).toEqual(["OUT", "REVERSE", "SELL", "0.8", "100", "8"]);
    const [inDeal] = await deals(reopened.id);
    expect([...brief(inDeal), inDeal.adminId]).toEqual(["IN", "REVERSE", "SELL", "0.8", "100", "0", fx.adminId]);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: reopened.id } })).reversedFromPositionId).toBe(old.id);
  });

  it("reverse in place: OUT + IN at the entry price at the flip; closes after it are on the new side", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // opened BUY, flipped to SELL, then closed: the row shows SELL
    const p = await position(fx, { side: "SELL", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "95", realizedPnl: "5" });
    await audit(fx, "POSITION_REVERSED_IN_PLACE", p.id, { side: "BUY" }, { side: "SELL" });
    await pnl(fx, p.id, "5", null);
    await apply(fx);
    expect((await deals(p.id)).map(brief)).toEqual([
      ["IN", "CLIENT", "BUY", "1", "100", "0"],
      ["OUT", "REVERSE", "SELL", "1", "100", "0"],
      ["IN", "REVERSE", "SELL", "1", "100", "0"],
      ["OUT", "CLIENT", "BUY", "1", "95", "5"],
    ]);
  });

  it("void: every deal of a voided position (closed or open) carries voidedAt = the void's time", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const closed = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "VOIDED", closePrice: "110", realizedPnl: "10" });
    await pnl(fx, closed.id, "10", null);
    const v1 = await audit(fx, "CLOSED_TRADE_VOID", closed.id, { status: "CLOSED" }, { status: "VOIDED" });
    const open = await position(fx, { side: "SELL", orderVolume: "0.30", openPrice: "100", status: "VOIDED" });
    const v2 = await audit(fx, "MANUAL_POSITION_VOID", open.id, { status: "OPEN" }, { status: "VOIDED" });
    await apply(fx);
    const dc = await deals(closed.id);
    expect(dc.map((d) => [d.entry, d.voidedAt?.toISOString()])).toEqual([["IN", v1.createdAt.toISOString()], ["OUT", v1.createdAt.toISOString()]]);
    const dopen = await deals(open.id);
    expect(dopen.map((d) => [d.entry, d.voidedAt?.toISOString()])).toEqual([["IN", v2.createdAt.toISOString()]]);
  });

  it("a duplicate booking from before the close guard gets an OUT of 0 lots; every TRADE_PNL row then has a deal", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "10" });
    const when = at();
    await pnl(fx, p.id, "10", null, when);
    await pnl(fx, p.id, "10", null, new Date(when.getTime() + 300));
    const r = await apply(fx);
    expect(r.lines.some((l) => l.startsWith("== duplicate bookings (OUT of 0 lots each): 1"))).toBe(true);
    expect((await deals(p.id)).map((d) => [d.entry, d.volume.toString(), d.profit.toString()])).toEqual([["IN", "1", "0"], ["OUT", "1", "10"], ["OUT", "0", "10"]]);
    expect(await withoutDeal(fx)).toBe(0);
  });

  it("each duplicate is checked for a later offsetting row of exactly the opposite amount; its ledger rows are printed", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p1 = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "10" });
    const p2 = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "107", realizedPnl: "7" });
    const w1 = at();
    await pnl(fx, p1.id, "10", null, w1);
    await pnl(fx, p1.id, "10", null, new Date(w1.getTime() + 300));
    const w2 = at();
    await pnl(fx, p2.id, "7", null, w2);
    await pnl(fx, p2.id, "7", null, new Date(w2.getTime() + 300));
    await prisma.transaction.create({
      data: { brokerId: fx.brokerId, accountId: fx.accountId, type: "ADJUSTMENT", status: "COMPLETED", amount: D(-10), balanceBefore: D(0), balanceAfter: D(-10), note: "reverse double close", createdAt: at() },
    });
    const r = await bf(fx);
    const from = r.lines.indexOf("== duplicate bookings in detail: every ledger row of the position, then the offsetting rows on its account");
    expect(from).toBeGreaterThan(0);
    const detail = r.lines.slice(from);
    expect(detail.filter((l) => l.endsWith("<- DUPLICATE"))).toHaveLength(2);
    expect(detail.some((l) => l.startsWith('  duplicate 10: OFFSET by ADJUSTMENT -10 at') && l.endsWith('"reverse double close"'))).toBe(true);
    expect(detail).toContain("  duplicate 7: no offsetting row of exactly -7");
    expect(detail).toContain("duplicates without an exact offset: total 7");
  });

  it("per-account ledger check: every touched account's balance against its ledger; the differing ones are listed, masked", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "10" });
    await commission(fx, p.id, "-7");
    await pnl(fx, p.id, "10", null);
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: D(3) } });
    const q = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "105", realizedPnl: "5", accountId: fx.eurAccountId });
    await pnl(fx, q.id, "5", null, at(), fx.eurAccountId);
    const eur = await prisma.account.findUniqueOrThrow({ where: { id: fx.eurAccountId } });
    const r = await bf(fx);
    expect(r.lines).toContain("== per-account ledger check: 2 account(s) touched; balance vs opening balance + completed balance-moving ledger rows; differing: 1");
    expect(r.lines).toContain(`MISMATCH ***${eur.accountNumber.slice(-3)}: balance 100000 vs ledger 5 (opening 0, difference 99995)`);
    expect(r.lines.at(-1)).toContain("1 account(s) differ from their ledger (listed above).");
  });

  it("--apply writes deals, initialVolume and reversedFromPositionId only: realizedPnl, closePrice and every other Position field stay", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "6", swap: "3" });
    await pnl(fx, p.id, "4", "Partial close: 0.4 lots @ 110");
    await pnl(fx, p.id, "6", null);
    const ledger = await prisma.transaction.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } });
    const accounts = await prisma.account.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } });
    const before = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
    const dry = await bf(fx);
    expect(dry.lines.some((l) => l.startsWith(`Backfill `) && l.includes(": 1 position(s), accounts ***"))).toBe(true);
    await apply(fx);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
    expect(after).toEqual({ ...before, initialVolume: D(1) });
    expect([after.realizedPnl?.toString(), after.closePrice?.toString(), after.volume.toString()]).toEqual(["6", "110", "0.6"]);
    expect(await prisma.transaction.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } })).toEqual(ledger);
    expect(await prisma.account.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } })).toEqual(accounts);
  });

  it("Book P/L uses the dashboard filter: the before figure is lib/book-pnl's, an internal account is left out", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "6" });
    await pnl(fx, p.id, "4", "Partial close: 0.4 lots @ 110");
    await pnl(fx, p.id, "6", null);
    // a test account: internal, so out of every broker-wide figure
    await prisma.account.update({ where: { id: fx.eurAccountId }, data: { isInternal: true } });
    const q = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "150", realizedPnl: "50", accountId: fx.eurAccountId });
    await pnl(fx, q.id, "50", null, at(), fx.eurAccountId);
    const lib = await bookPnlRealized(prisma, { brokerId: fx.brokerId, coverageAccountId: null }, new Date(0));
    expect(lib.map((c) => [c.currency, c.amount.toString()])).toEqual([["USD", "-6"]]);
    const r = await bf(fx);
    const from = r.lines.findIndex((l) => l.startsWith("== Book P/L, dashboard filter"));
    const section = r.lines.slice(from + 1, r.lines.indexOf("", from + 1));
    expect(section).toHaveLength(1);
    expect(section[0]).toMatch(/^Backfill \S+ \(broker …\w{4}\) USD: -6\.00 -> -10\.00 \(difference -4\.00; 1 closed position\(s\)\)$/);
  });

  it("an open position partially closed before: IN + the OUT, and IN minus OUT = the open volume", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.70", openPrice: "100" });
    await pnl(fx, p.id, "3", "Partial close: 0.3 lots @ 110");
    const r = await apply(fx);
    expect(r.exitCode).toBe(0);
    expect((await deals(p.id)).map(brief)).toEqual([["IN", "CLIENT", "BUY", "1", "100", "0"], ["OUT", "CLIENT", "SELL", "0.3", "110", "3"]]);
  });

  it("positions the dual write already covers are left alone; a legacy row next to them is filled in", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100" });
    // opened before step 1 (no IN), a legacy partial, then a close after step 1 that wrote its own deal
    await pnl(fx, p.id, "4", "Partial close: 0.4 lots @ 110");
    await prisma.position.update({ where: { id: p.id }, data: { status: "CLOSED", closePrice: D(120), realizedPnl: D(16) } });
    const t2 = await pnl(fx, p.id, "12", null);
    await prisma.deal.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, positionId: p.id, symbolId: fx.symbolId, side: "SELL", entry: "OUT", reason: "CLIENT", volume: D("0.6"), price: D(120), profit: D(12), transactionId: t2.id, executedAt: t2.createdAt } });
    await apply(fx);
    const ds = await deals(p.id);
    expect(ds.map((d) => [d.entry, d.volume.toString(), d.backfilled])).toEqual([["IN", "1", true], ["OUT", "0.4", true], ["OUT", "0.6", false]]);
  });

  it("dry run writes nothing; apply twice: the second run writes 0; resumable from a cursor", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const ps = [];
    for (let i = 0; i < 5; i++) {
      const p = await position(fx, { side: "BUY", orderVolume: "1.00", openPrice: "100", status: "CLOSED", closePrice: "101", realizedPnl: "1" });
      await pnl(fx, p.id, "1", null);
      ps.push(p);
    }
    const before = await prisma.position.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } });
    const dry = await bf(fx);
    expect(dry.written).toBe(0);
    expect(await prisma.deal.count({ where: { brokerId: fx.brokerId } })).toBe(0);
    expect(await prisma.position.findMany({ where: { brokerId: fx.brokerId }, orderBy: { id: "asc" } })).toEqual(before);

    // batches of 2, stopped after the first: resume from the printed cursor
    const ids = ps.map((p) => p.id).sort();
    const first = await apply(fx, { batch: 2 });
    expect(first.lines.filter((l) => l.startsWith("batch written:"))).toHaveLength(3);
    expect(first.lines).toContain(`batch written: 4 deal(s); resume with --from ${ids[1]}`);
    expect(first.written).toBe(10);
    const again = await apply(fx);
    expect(again.written).toBe(0);
    const resumed = await apply(fx, { from: ids[1] });
    expect(resumed.written).toBe(0);
    expect(await prisma.deal.count({ where: { brokerId: fx.brokerId } })).toBe(10);
  });

  it("dry run on a database without the deal / close_fields migrations (live before step 1): plans from the notes, --apply refused", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "110", realizedPnl: "6" });
    await pnl(fx, p.id, "4", "Partial close: 0.4 lots @ 110");
    await pnl(fx, p.id, "6", null);
    const legacy = { deals: false, closeFields: false };
    const dry = await bf(fx, { schemaOverride: legacy });
    expect(dry.lines).toContain("schema: deal tables ABSENT (dry run reads as: no deals yet); close fields ABSENT (every row read from its note)");
    expect(dry.plans[0].deals.map((d) => [d.entry, d.volume.toString()])).toEqual([["IN", "1"], ["OUT", "0.4"], ["OUT", "0.6"]]);
    await expect(bf(fx, { schemaOverride: legacy, apply: true, confirmHost: "127.0.0.1" })).rejects.toThrow(/needs the deal_model_a and close_fields migrations/);
    expect(await prisma.deal.count({ where: { brokerId: fx.brokerId } })).toBe(0);
  });

  it("--apply refuses without --confirm-host or with a host that is not this one", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await expect(bf(fx, { apply: true, confirmHost: null })).rejects.toThrow(/confirm-host/);
    await expect(bf(fx, { apply: true, confirmHost: "ep-morning-glade" })).rejects.toThrow(/not part of the database host/);
  });

  it("DealBackfillLog: restore puts the old values back, once", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const p = await position(fx, { side: "BUY", orderVolume: "1.00", volume: "0.60", openPrice: "100", status: "CLOSED", closePrice: "120", realizedPnl: "12" });
    const runId = `test-${randomUUID()}`;
    // what step 7 will do: log, then rewrite from the deals
    await prisma.dealBackfillLog.createMany({ data: [
      { runId, positionId: p.id, field: "realizedPnl", oldValue: "12", newValue: "14" },
      { runId, positionId: p.id, field: "closePrice", oldValue: "120", newValue: "114" },
    ] });
    await prisma.position.update({ where: { id: p.id }, data: { realizedPnl: D(14), closePrice: D(114) } });
    expect(await prisma.$transaction((tx) => restoreFromLog(tx, runId))).toBe(2);
    const back = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
    expect([back.realizedPnl?.toString(), back.closePrice?.toString()]).toEqual(["12", "120"]);
    expect(await prisma.$transaction((tx) => restoreFromLog(tx, runId))).toBe(0);
    expect(await prisma.dealBackfillLog.count({ where: { runId, restoredAt: null } })).toBe(0);
  });
});
