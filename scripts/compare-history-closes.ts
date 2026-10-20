// Deal model step 4, reader "history": compares /api/trade/history `closes` built the old way (TRADE_PNL rows +
// notes, lib/history-closes.ts) with the new way (Deal rows, lib/deal-closes.ts), for every OPEN / CLOSED position,
// in both views (default and ?closes=1). READ ONLY: every batch runs in a READ ONLY transaction.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/compare-history-closes.ts [--out report.json] [--batch 500]
//
// Each position lands in one class per view:
//   same               identical legs (time, lots, price, P/L, close-by ticket, final)
//   filled_unknowns    old view had a close whose lots / price could not be read (null) or stayed flat for that reason;
//                      the deals state it, everything else identical (the expected improvement)
//   duplicate_booking  a 0-lot OUT (pre-guard duplicate) the old view could not place; P/L now equals the ledger
//   DIFFERENT          anything else: listed with both versions (must be explained before switching)
import fs from "node:fs";
import { Prisma, PrismaClient } from "@prisma/client";
import { closeByTarget, closesOf, type CloseLeg, type CloseTx, type Counterpart } from "../lib/history-closes";
import { closesFromDeals, type CloseDeal } from "../lib/deal-closes";

const args = process.argv.slice(2);
const arg = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const OUT = arg("--out");
const BATCH = Math.max(1, Math.min(2000, Number(arg("--batch") ?? 500)));

type Klass = "same" | "filled_unknowns" | "duplicate_booking" | "DIFFERENT";
type Diff = { ticket: number; view: "default" | "all"; klass: Klass; why: string; old: CloseLeg[] | null; neu: CloseLeg[] | null };

const eq = (a: string | null, b: string | null) => (a == null || b == null ? a === b : new Prisma.Decimal(a).eq(b));

function classify(old: CloseLeg[] | null, neu: CloseLeg[] | null): { klass: Klass; why: string } {
  if (old == null && neu == null) return { klass: "same", why: "" };
  const zeroLot = (neu ?? []).some((l) => l.volume != null && new Prisma.Decimal(l.volume).isZero());
  if (old == null) return zeroLot ? { klass: "duplicate_booking", why: "old flat, new lists a 0-lot duplicate" } : { klass: "filled_unknowns", why: "old flat (unreadable), new grouped" };
  if (neu == null) return { klass: "DIFFERENT", why: "old grouped, new flat" };
  if (old.length !== neu.length) return { klass: "DIFFERENT", why: `legs ${old.length} vs ${neu.length}` };
  let filled = false;
  for (let i = 0; i < old.length; i++) {
    const o = old[i], n = neu[i];
    if (o.at !== n.at) return { klass: "DIFFERENT", why: `leg ${i} time ${o.at} vs ${n.at}` };
    if (!eq(o.pnl, n.pnl)) return { klass: "DIFFERENT", why: `leg ${i} pnl ${o.pnl} vs ${n.pnl}` };
    if (o.final !== n.final) return { klass: "DIFFERENT", why: `leg ${i} final ${o.final} vs ${n.final}` };
    if (o.closedByTicket !== n.closedByTicket) return { klass: "DIFFERENT", why: `leg ${i} close-by ${o.closedByTicket} vs ${n.closedByTicket}` };
    if (o.volume == null || o.price == null) { filled = true; continue; }
    if (!eq(o.volume, n.volume)) return zeroLot ? { klass: "duplicate_booking", why: `leg ${i} lots ${o.volume} vs ${n.volume}` } : { klass: "DIFFERENT", why: `leg ${i} lots ${o.volume} vs ${n.volume}` };
    if (!eq(o.price, n.price)) return { klass: "DIFFERENT", why: `leg ${i} price ${o.price} vs ${n.price}` };
  }
  return filled ? { klass: "filled_unknowns", why: "old had unreadable lots / price" } : { klass: "same", why: "" };
}

async function main() {
  const url = process.env.DIRECT_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DIRECT_URL or DATABASE_URL is required");
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  console.log(`database host: ${new URL(url).host}`);
  console.log("MODE: READ ONLY comparison");
  const counts: Record<string, Record<Klass, number>> = { default: { same: 0, filled_unknowns: 0, duplicate_booking: 0, DIFFERENT: 0 }, all: { same: 0, filled_unknowns: 0, duplicate_booking: 0, DIFFERENT: 0 } };
  const diffs: Diff[] = [];
  let cursor: string | undefined;
  let positions = 0, txWithoutDeal = 0, timeMismatch = 0;
  for (;;) {
    const done = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const batch = await tx.position.findMany({
        where: { deletedAt: null, status: { in: ["OPEN", "CLOSED"] }, ...(cursor ? { id: { gt: cursor } } : {}) },
        select: { id: true, ticket: true, accountId: true, status: true, volume: true, closePrice: true, closedAt: true },
        orderBy: { id: "asc" },
        take: BATCH,
      });
      if (batch.length === 0) return true;
      cursor = batch[batch.length - 1].id;
      const ids = batch.map((p) => p.id);
      const txRows = await tx.transaction.findMany({
        where: { type: "TRADE_PNL", referenceType: "Position", referenceId: { in: ids } },
        select: { id: true, referenceId: true, amount: true, createdAt: true, note: true, closeVolume: true, closePrice: true, closeByPositionId: true },
      });
      const deals = await tx.deal.findMany({
        where: { positionId: { in: ids }, entry: { in: ["OUT", "OUT_BY"] } },
        select: { positionId: true, entry: true, ticket: true, volume: true, price: true, profit: true, executedAt: true, byPositionId: true, transactionId: true },
      });
      const byTx = new Map(deals.filter((d) => d.transactionId).map((d) => [d.transactionId!, d]));
      for (const t of txRows) {
        const d = byTx.get(t.id);
        if (!d) txWithoutDeal++;
        else if (d.executedAt.getTime() !== t.createdAt.getTime()) timeMismatch++;
      }
      const cpIds = new Set<string>(), cpTickets = new Set<number>();
      for (const t of txRows) if (t.closeByPositionId) cpIds.add(t.closeByPositionId);
      for (const t of txRows) { const g = closeByTarget(t.note); if (g) { if ("id" in g) cpIds.add(g.id); else cpTickets.add(g.ticket); } }
      for (const d of deals) if (d.byPositionId) cpIds.add(d.byPositionId);
      const counterparts: (Counterpart & { accountId: string })[] = cpIds.size + cpTickets.size === 0 ? [] : await tx.position.findMany({
        where: { OR: [{ id: { in: [...cpIds] } }, { ticket: { in: [...cpTickets] } }] },
        select: { id: true, ticket: true, status: true, volume: true, closePrice: true, closedAt: true, accountId: true },
      });
      const tickets = new Map(counterparts.map((c) => [c.id, c.ticket]));
      const txBy = new Map<string, CloseTx[]>();
      for (const t of txRows) if (t.referenceId) txBy.set(t.referenceId, [...(txBy.get(t.referenceId) ?? []), t]);
      const dealBy = new Map<string, CloseDeal[]>();
      for (const d of deals) dealBy.set(d.positionId, [...(dealBy.get(d.positionId) ?? []), d as CloseDeal]);
      for (const p of batch) {
        positions++;
        // the route only ever sees the account's own counterparts
        const own = counterparts.filter((c) => c.accountId === p.accountId);
        for (const view of ["default", "all"] as const) {
          const opts = { all: view === "all" };
          const old = closesOf(p, txBy.get(p.id) ?? [], own, opts);
          const neu = closesFromDeals(p, dealBy.get(p.id) ?? [], tickets, opts);
          const c = classify(old, neu);
          counts[view][c.klass]++;
          if (c.klass !== "same" && diffs.filter((d) => d.klass === c.klass && d.view === view).length < 50) diffs.push({ ticket: p.ticket, view, klass: c.klass, why: c.why, old, neu });
        }
      }
      return false;
    }, { timeout: 120_000, maxWait: 30_000 });
    if (done) break;
  }
  await prisma.$disconnect();
  console.log(`positions compared: ${positions}`);
  console.log(`TRADE_PNL rows without a deal: ${txWithoutDeal} (expect 0); deal time != ledger time: ${timeMismatch} (expect 0)`);
  for (const view of ["default", "all"] as const) {
    const c = counts[view];
    console.log(`view ${view.padEnd(7)}: same ${c.same}, filled_unknowns ${c.filled_unknowns}, duplicate_booking ${c.duplicate_booking}, DIFFERENT ${c.DIFFERENT}`);
  }
  for (const d of diffs.filter((d) => d.klass === "DIFFERENT").slice(0, 20)) console.log(`DIFFERENT ${d.view} #${d.ticket}: ${d.why}`);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ counts, positions, txWithoutDeal, timeMismatch, diffs }, null, 2));
  const different = counts.default.DIFFERENT + counts.all.DIFFERENT;
  console.log(different === 0 && txWithoutDeal === 0 && timeMismatch === 0 ? "RESULT: no unexplained difference" : "RESULT: differences to explain before switching");
}

main().catch((e) => { console.error(e); process.exit(1); });
