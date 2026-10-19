// Deal model step 3 (docs/POSITION-DEAL-MODEL.md section 3.3 item 3): writes the deals that history implies, for every
// position, so the Deal table covers trades from before the dual write (steps 1 and 2).
//
// Per position (ordered by id, batches of 500):
//   - IN, unless the position already has its opening IN (orderId = the opening Order): volume = the opening Order's,
//     price = Position.openPrice, time = openedAt, commission = its COMMISSION rows (transactionId when there is exactly
//     one), reason from the opening Order (mirror: MIRROR, coverage_: COVERAGE, manual_: ADMIN or REVERSE, else CLIENT);
//   - OUT / OUT_BY per TRADE_PNL row that has no deal yet, in createdAt order, profit = the row's amount (exact):
//       structured close fields (close_fields hotfix and the step-0 correction) first; else the last row of a closed
//       position takes Position.volume / closePrice; else "Partial close: V lots @ P" / "Manual partial close by admin:
//       V lots @ P"; else a "Close by <id|#ticket>" leg takes its counterpart's lots and price; else UNKNOWN;
//   - exactly one UNKNOWN row: lots = opening volume - what is still open - the known lots, price back-solved from the
//     P&L (only when the symbol quotes in the account's currency: no historical conversion rate is stored), flagged
//     backfilled with a note. Two or more, a back-solve that needs a conversion rate, or lots that do not add up: the
//     position is AMBIGUOUS, listed, and written by --apply only with --skip-ambiguous (then left without deals);
//   - a duplicate booking from before the close guard (same amount as the previous close, both notes null, < 1 s apart,
//     the step-0 rule) moved money, so it gets an OUT of 0 lots with a note (every TRADE_PNL row has a deal);
//   - reverse in place (AuditLog POSITION_REVERSED_IN_PLACE and its coverage / mirror followers): the OUT + IN pair at
//     the entry price with profit 0 (owner decision 2026-10-19), and every close's side follows the side at that time;
//   - reverse close-and-reopen (AuditLog MANUAL_POSITION_REVERSE): the new position gets reversedFromPositionId;
//   - voided positions: every deal of theirs gets voidedAt (the void's AuditLog time);
//   - Position.initialVolume = the IN volume where it is still null.
// Checks per position: closed -> the OUT lots add up to the IN volume; open -> IN minus the OUT lots = Position.volume.
//
// SAFETY
//   - Default = DRY RUN: each batch is read in a READ ONLY transaction, nothing is written. The dry run also works on a
//     database WITHOUT the deal migrations (live before step 1 ships): no Deal table = no deals yet, initialVolume and
//     reversedFromPositionId read as unset; without the close_fields columns every row is read from its note. --apply
//     needs both migrations (20261019120000_deal_model_a and 20261012130000_close_fields). It prints, per position whose
//     history differs from its row, old -> new P/L, volume and close price, the AMBIGUOUS list, the duplicate bookings,
//     and totals (deals by entry and reason, Book P/L before / after).
//   - Writing needs --apply AND --confirm-host <part of the database host>; DATABASE_URL and DIRECT_URL must point at the
//     same database. A full dry pass runs first; AMBIGUOUS positions refuse the run unless --skip-ambiguous.
//   - Idempotent and resumable: an OUT is keyed by its unique transactionId (createMany skips an existing one), an IN by
//     the opening Order, a flip by its AuditLog id; each batch re-plans inside its own write transaction. A second run
//     writes nothing. --from <position id> starts after that id (the last line of each batch prints it).
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/backfill-deals.ts                                   (dry run)
//   ... npx tsx scripts/backfill-deals.ts --out backfill-report.json                                    (dry run + JSON report)
//   ... npx tsx scripts/backfill-deals.ts --apply --confirm-host <host part> [--skip-ambiguous] [--from <id>]
//   --broker <id> limits any run to one broker; --batch <n> changes the batch size (default 500).
import fs from "node:fs";
import { Prisma, PrismaClient, type DealEntry, type DealReason, type OrderSide, type OrderSource } from "@prisma/client";
import { accountChecks, CLOSE_BY, PARTIAL, splitDuplicates } from "./correct-multi-close-positions";

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);
const PAIR_WINDOW_MS = 5000;
export const BATCH = 500;

export class BackfillRefused extends Error {}

export type PosRow = {
  id: string; ticket: number; accountId: string; accountNumber: string; brokerId: string; symbolId: string; symbol: string; side: OrderSide; status: string;
  volume: Prisma.Decimal; openPrice: Prisma.Decimal; closePrice: Prisma.Decimal | null; realizedPnl: Prisma.Decimal | null; swap: Prisma.Decimal;
  openedAt: Date; closedAt: Date | null; deletedAt: Date | null; initialVolume: Prisma.Decimal | null; reversedFromPositionId: string | null; closedByAdminId: string | null;
  orderId: string; orderVolume: Prisma.Decimal; orderSource: OrderSource; orderKey: string; accountCurrency: string; quoteCurrency: string; contractSize: Prisma.Decimal;
};
export type TxRow = {
  id: string; referenceId: string; amount: Prisma.Decimal; createdAt: Date; note: string | null;
  closeVolume: Prisma.Decimal | null; closePrice: Prisma.Decimal | null; closeSwap: Prisma.Decimal | null; closeByPositionId: string | null;
};
type CommissionRow = { id: string; referenceId: string; amount: Prisma.Decimal };
type ExistingDeal = {
  id: string; positionId: string; entry: DealEntry; reason: DealReason; orderId: string | null; transactionId: string | null; volume: Prisma.Decimal;
  price: Prisma.Decimal; profit: Prisma.Decimal; swap: Prisma.Decimal; executedAt: Date; backfillNote: string | null; voidedAt: Date | null;
};
type AuditRow = { id: string; action: string; entityId: string | null; createdAt: Date; actorAdminId: string | null; oldValue: Prisma.JsonValue; newValue: Prisma.JsonValue };
type Counterpart = { id: string; ticket: number; status: string; volume: Prisma.Decimal; closePrice: Prisma.Decimal | null; closedAt: Date | null };

export type DealDraft = {
  positionId: string; brokerId: string; accountId: string; symbolId: string; orderId: string | null; side: OrderSide; entry: DealEntry; reason: DealReason;
  source: OrderSource | null; volume: Prisma.Decimal; price: Prisma.Decimal; profit: Prisma.Decimal; commission: Prisma.Decimal; swap: Prisma.Decimal;
  byPositionId: string | null; transactionId: string | null; adminId: string | null; executedAt: Date; voidedAt: Date | null; backfillNote: string;
};
export type PositionPlan = {
  pos: PosRow;
  deals: DealDraft[];
  setInitialVolume: Prisma.Decimal | null;
  setReversedFrom: string | null;
  /** voided position: the void's time, set on every deal of it still without voidedAt */
  voidedAt: Date | null;
  existingToVoid: string[];
  ambiguous: string[];
  notes: string[];
  duplicates: number;
  /** the duplicate TRADE_PNL rows themselves (the report checks each for an offsetting ADJUSTMENT) */
  duplicateRows: TxRow[];
  inVolume: Prisma.Decimal;
  ledgerPnl: Prisma.Decimal;
  outProfit: Prisma.Decimal;
  vwap: Prisma.Decimal | null;
};

const FLIP_ACTIONS = ["POSITION_REVERSED_IN_PLACE", "MIRROR_REVERSED_IN_PLACE", "POSITION_COVERAGE_REVERSED_IN_PLACE"];
const VOID_ACTIONS = ["MANUAL_POSITION_VOID", "CLOSED_TRADE_VOID"];
const opposite = (s: OrderSide): OrderSide => (s === "BUY" ? "SELL" : "BUY");
const str = (v: Prisma.Decimal | null | undefined) => (v == null ? "-" : v.toString());
const json = (v: Prisma.JsonValue, key: string): string | null => (v && typeof v === "object" && !Array.isArray(v) && typeof v[key] === "string" ? (v[key] as string) : null);

/** The reason of a close from its TRADE_PNL note (the notes every close path writes; null = a plain client close). */
export function reasonFromNote(note: string | null): { reason: DealReason; known: boolean } {
  if (note == null || PARTIAL.test(note) && note.startsWith("Partial close")) return { reason: "CLIENT", known: true };
  const starts: [string, DealReason][] = [
    ["Stop loss hit", "SL"], ["Take profit hit", "TP"], ["Stop-out", "STOP_OUT"], ["Bulk close", "BULK"], ["STM bulk close", "BULK"],
    ["Manual partial close by admin", "ADMIN"], ["Manual close by admin", "ADMIN"], ["Dealer close", "DEALER"], ["Dealer desk turned off", "DEALER"],
    ["Mirror close", "MIRROR"], ["Coverage auto-close", "COVERAGE"], ["Close by ", "CLOSE_BY"], ["Reversed (close & reopen)", "REVERSE"],
    // the older wording of the same close-and-reopen note (live 100000606, 2026-10-19 dry run)
    ["Reversed by admin @ ", "REVERSE"],
  ];
  for (const [prefix, reason] of starts) if (note.startsWith(prefix)) return { reason, known: true };
  return { reason: "CLIENT", known: false };
}

/** The reason of an open from its opening Order (the idempotency keys the open paths use). */
export function openReason(orderKey: string, reversedFrom: boolean): DealReason {
  if (orderKey.startsWith("mirror:")) return "MIRROR";
  if (orderKey.startsWith("coverage_")) return "COVERAGE";
  if (orderKey.startsWith("manual_")) return reversedFrom ? "REVERSE" : "ADMIN";
  return "CLIENT";
}

/** One position's deals from its history. Pure: everything it needs is passed in. */
export function planPosition(input: {
  pos: PosRow;
  rows: TxRow[];
  commissions: CommissionRow[];
  existing: ExistingDeal[];
  audits: AuditRow[]; // flips and voids of this position
  reversedFrom: { oldPositionId: string; adminId: string | null } | null;
  counterparts: Counterpart[];
  usedTransactionIds: Set<string>;
}): PositionPlan {
  const { pos, existing } = input;
  const ambiguous: string[] = [];
  const notes: string[] = [];
  const deals: DealDraft[] = [];
  const base = { positionId: pos.id, brokerId: pos.brokerId, accountId: pos.accountId, symbolId: pos.symbolId, backfillNote: "" };
  const inVolume = pos.orderVolume;

  // the side over time: reverse in place flips it (AuditLog old -> new side)
  const flips = input.audits
    .filter((a) => FLIP_ACTIONS.includes(a.action))
    .map((a) => ({ id: a.id, at: a.createdAt, from: json(a.oldValue, "side") as OrderSide | null, to: json(a.newValue, "side") as OrderSide | null, adminId: a.actorAdminId }))
    .filter((f) => f.from && f.to)
    .sort((x, y) => x.at.getTime() - y.at.getTime());
  const initialSide: OrderSide = flips[0]?.from ?? pos.side;
  const sideAt = (t: Date): OrderSide => {
    let side = initialSide;
    for (const f of flips) if (f.at.getTime() <= t.getTime()) side = f.to!;
    return side;
  };

  const voidAudit = input.audits.filter((a) => VOID_ACTIONS.includes(a.action)).sort((x, y) => x.createdAt.getTime() - y.createdAt.getTime())[0];
  const voidedAt = pos.status === "VOIDED" ? voidAudit?.createdAt ?? pos.closedAt ?? new Date() : null;

  // ---- closes ----
  const { kept, duplicates } = splitDuplicates(input.rows) as { kept: TxRow[]; duplicates: TxRow[] };
  const isClosed = pos.status !== "OPEN" && kept.length > 0;
  const dealOf = new Map(existing.filter((d) => d.transactionId).map((d) => [d.transactionId!, d]));
  type Close = { tx: TxRow; lots: Prisma.Decimal | null; price: Prisma.Decimal | null; closeBy: string | null; basis: string; swap: Prisma.Decimal | null; existing: ExistingDeal | null };
  const closes: Close[] = kept.map((tx, i) => {
    const have = dealOf.get(tx.id) ?? null;
    if (have) return { tx, lots: have.volume, price: have.price, closeBy: null, basis: "existing deal", swap: have.swap, existing: have };
    const m = tx.note ? CLOSE_BY.exec(tx.note) : null;
    const cp = m ? input.counterparts.find((c) => (m[1] === "#" ? String(c.ticket) === m[2] : c.id === m[2])) : undefined;
    const noteCloseBy = cp ? cp.id : null;
    if (tx.closeVolume != null) return { tx, lots: tx.closeVolume, price: tx.closePrice, closeBy: tx.closeByPositionId ?? noteCloseBy, basis: "structured fields", swap: tx.closeSwap, existing: null };
    if (isClosed && i === kept.length - 1) return { tx, lots: pos.volume, price: pos.closePrice, closeBy: noteCloseBy, basis: "final close (Position row)", swap: null, existing: null };
    const pm = tx.note ? PARTIAL.exec(tx.note) : null;
    if (pm) return { tx, lots: D(pm[1]), price: D(pm[2]), closeBy: null, basis: "note", swap: null, existing: null };
    if (cp && cp.status !== "OPEN" && cp.closedAt && Math.abs(cp.closedAt.getTime() - tx.createdAt.getTime()) <= PAIR_WINDOW_MS) {
      return { tx, lots: cp.volume, price: cp.closePrice, closeBy: cp.id, basis: "close-by counterpart", swap: null, existing: null };
    }
    return { tx, lots: null, price: null, closeBy: noteCloseBy, basis: "UNKNOWN", swap: null, existing: null };
  });

  const unknown = closes.filter((c) => c.lots == null);
  if (unknown.length > 1) {
    ambiguous.push(`${unknown.length} TRADE_PNL rows without lots: ${unknown.map((c) => `${c.tx.createdAt.toISOString()} ${c.tx.amount} "${c.tx.note ?? ""}"`).join("; ")}`);
  } else if (unknown.length === 1) {
    const u = unknown[0];
    const known = closes.reduce((s, c) => (c.lots ? s.add(c.lots) : s), ZERO);
    const lots = inVolume.sub(isClosed ? ZERO : pos.volume).sub(known);
    if (lots.lte(0)) {
      ambiguous.push(`the one close without lots ("${u.tx.note ?? ""}") leaves ${lots} lots`);
    } else if (pos.quoteCurrency !== pos.accountCurrency) {
      ambiguous.push(`the one close without lots ("${u.tx.note ?? ""}") needs the ${pos.quoteCurrency}/${pos.accountCurrency} rate of ${u.tx.createdAt.toISOString()} to back-solve its price`);
    } else {
      // profit = sign * (price - open) * lots * contractSize, sign +1 for a BUY position at the time
      const sign = sideAt(u.tx.createdAt) === "BUY" ? 1 : -1;
      u.lots = lots;
      u.price = pos.openPrice.add(u.tx.amount.div(lots.mul(pos.contractSize)).mul(sign)).toDecimalPlaces(5);
      u.basis = "derived (lots = opening - open - known closes, price back-solved from the P&L)";
      notes.push(`derived close ${u.tx.createdAt.toISOString()}: ${lots} lots @ ${u.price}`);
    }
  }

  const allKnown = closes.every((c) => c.lots != null);
  const outLots = closes.reduce((s, c) => (c.lots ? s.add(c.lots) : s), ZERO);
  if (allKnown) {
    if (isClosed && !outLots.eq(inVolume)) ambiguous.push(`closed: the closes add up to ${outLots} lots, the opening order to ${inVolume}`);
    if (!isClosed && !inVolume.sub(outLots).eq(pos.volume)) ambiguous.push(`open: opening ${inVolume} - closed ${outLots} != open volume ${pos.volume}`);
  }

  // pro-rata swap for closes that carry no share of their own (lib/position-close.ts rule); the final close takes the rest
  if (allKnown) {
    let attributed = ZERO;
    let openLots = inVolume;
    closes.forEach((c, i) => {
      if (c.swap == null) {
        const last = isClosed && i === closes.length - 1;
        const remainder = pos.swap.sub(attributed);
        c.swap = last ? remainder.toDecimalPlaces(2) : remainder.mul(c.lots!).div(openLots).toDecimalPlaces(2);
      }
      attributed = attributed.add(c.swap);
      openLots = openLots.sub(c.lots!);
    });
  }

  // ---- IN ----
  const openingIn = existing.find((d) => d.entry === "IN" && d.orderId === pos.orderId);
  if (!openingIn) {
    const commission = input.commissions.reduce((s, c) => s.add(c.amount), ZERO);
    const single = input.commissions.length === 1 && !input.usedTransactionIds.has(input.commissions[0].id) ? input.commissions[0].id : null;
    deals.push({
      ...base, orderId: pos.orderId, side: initialSide, entry: "IN", reason: openReason(pos.orderKey, input.reversedFrom != null), source: pos.orderSource,
      volume: inVolume, price: pos.openPrice, profit: ZERO, commission, swap: ZERO, byPositionId: null, transactionId: single,
      adminId: input.reversedFrom?.adminId ?? null, executedAt: pos.openedAt, voidedAt, backfillNote: "backfill: IN from the opening order",
    });
  }

  // ---- flips (reverse in place) ----
  for (const f of flips) {
    const already = existing.some((d) => d.backfillNote === `backfill: flip ${f.id}` || (d.reason === "REVERSE" && d.entry === "OUT" && d.transactionId == null && Math.abs(d.executedAt.getTime() - f.at.getTime()) <= PAIR_WINDOW_MS));
    if (already) continue;
    const lotsBefore = closes.filter((c) => c.lots && c.tx.createdAt.getTime() < f.at.getTime()).reduce((s, c) => s.add(c.lots!), ZERO);
    const lots = inVolume.sub(lotsBefore);
    if (lots.lte(0)) { ambiguous.push(`reverse in place at ${f.at.toISOString()} with ${lots} lots open`); continue; }
    const common = { ...base, orderId: null, side: f.to!, reason: "REVERSE" as const, source: "ADMIN" as const, volume: lots, price: pos.openPrice, profit: ZERO, commission: ZERO, swap: ZERO,
      byPositionId: null, transactionId: null, adminId: f.adminId, executedAt: f.at, voidedAt, backfillNote: `backfill: flip ${f.id}` };
    deals.push({ ...common, entry: "OUT" }, { ...common, entry: "IN" });
  }

  // ---- OUT / OUT_BY ----
  for (const c of closes) {
    if (c.existing || c.lots == null) continue;
    const { reason: noteReason, known } = reasonFromNote(c.tx.note);
    if (!known) notes.push(`reason of "${c.tx.note}" not recognised: CLIENT`);
    const reason: DealReason = c.closeBy && noteReason === "CLIENT" ? "CLOSE_BY" : noteReason;
    const last = c === closes[closes.length - 1] && isClosed;
    deals.push({
      ...base, orderId: null, side: opposite(sideAt(c.tx.createdAt)), entry: c.closeBy ? "OUT_BY" : "OUT", reason, source: null,
      volume: c.lots, price: c.price ?? pos.openPrice, profit: c.tx.amount, commission: ZERO, swap: c.swap ?? ZERO, byPositionId: c.closeBy,
      transactionId: c.tx.id, adminId: last && (reason === "ADMIN" || reason === "REVERSE") ? pos.closedByAdminId : null,
      executedAt: c.tx.createdAt, voidedAt, backfillNote: `backfill: ${c.basis}`,
    });
  }
  for (const d of duplicates) {
    if (dealOf.has(d.id)) continue;
    deals.push({
      ...base, orderId: null, side: opposite(sideAt(d.createdAt)), entry: "OUT", reason: "CLIENT", source: null, volume: ZERO, price: pos.closePrice ?? pos.openPrice,
      profit: d.amount, commission: ZERO, swap: ZERO, byPositionId: null, transactionId: d.id, adminId: null, executedAt: d.createdAt, voidedAt,
      backfillNote: "backfill: duplicate booking from before the close guard (0228edd): money moved, no lots",
    });
  }

  const ledgerPnl = input.rows.reduce((s, t) => s.add(t.amount), ZERO);
  const lotsWithPrice = closes.filter((c) => c.lots && c.price);
  const vwapLots = lotsWithPrice.reduce((s, c) => s.add(c.lots!), ZERO);
  const vwap = vwapLots.gt(0) ? lotsWithPrice.reduce((s, c) => s.add(c.lots!.mul(c.price!)), ZERO).div(vwapLots).toDecimalPlaces(5) : null;
  const outProfit = closes.reduce((s, c) => s.add(c.tx.amount), ZERO).add(duplicates.reduce((s, d) => s.add(d.amount), ZERO));

  return {
    pos,
    deals: ambiguous.length ? [] : deals,
    setInitialVolume: pos.initialVolume == null && !ambiguous.length ? inVolume : null,
    setReversedFrom: pos.reversedFromPositionId == null && input.reversedFrom ? input.reversedFrom.oldPositionId : null,
    voidedAt,
    existingToVoid: voidedAt ? existing.filter((d) => d.voidedAt == null).map((d) => d.id) : [],
    ambiguous,
    notes,
    duplicates: duplicates.length,
    duplicateRows: duplicates,
    inVolume,
    ledgerPnl,
    outProfit,
    vwap,
  };
}

export type Schema = { deals: boolean; closeFields: boolean };

/** Which of the migrations this script reads are on the database (a dry run may run before they are deployed). */
export async function detectSchema(tx: Tx): Promise<Schema> {
  const cols = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY(${["Deal", "Position", "Transaction"]}::text[])`;
  const has = (t: string, c: string) => cols.some((r) => r.table_name === t && r.column_name === c);
  return {
    deals: has("Deal", "transactionId") && has("Position", "initialVolume") && has("Position", "reversedFromPositionId"),
    closeFields: has("Transaction", "closeVolume") && has("Transaction", "closePrice") && has("Transaction", "closeSwap") && has("Transaction", "closeByPositionId"),
  };
}

/** Reads one batch (positions after `afterId`, by id) and plans each position. */
export async function planBatch(tx: Tx, afterId: string, limit: number, brokerId: string | null = null, schema: Schema = { deals: true, closeFields: true }): Promise<PositionPlan[]> {
  const brokerFilter = brokerId ? Prisma.sql`AND p."brokerId" = ${brokerId}` : Prisma.empty;
  const dealCols = schema.deals ? Prisma.sql`p."initialVolume", p."reversedFromPositionId"` : Prisma.sql`NULL::numeric AS "initialVolume", NULL::text AS "reversedFromPositionId"`;
  const closeCols = schema.closeFields
    ? Prisma.sql`"closeVolume", "closePrice", "closeSwap", "closeByPositionId"`
    : Prisma.sql`NULL::numeric AS "closeVolume", NULL::numeric AS "closePrice", NULL::numeric AS "closeSwap", NULL::text AS "closeByPositionId"`;
  const positions = await tx.$queryRaw<PosRow[]>`
    SELECT p.id, p.ticket, p."accountId", a."accountNumber", p."brokerId", p."symbolId", s.name AS symbol, p.side, p.status::text AS status,
           p.volume, p."openPrice", p."closePrice", p."realizedPnl", p.swap, p."openedAt", p."closedAt", p."deletedAt", ${dealCols},
           p."closedByAdminId", o.id AS "orderId", o.volume AS "orderVolume", o.source AS "orderSource", o."idempotencyKey" AS "orderKey",
           a.currency AS "accountCurrency", s."quoteCurrency", s."contractSize"
      FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Symbol" s ON s.id = p."symbolId" JOIN "Order" o ON o.id = p."originOrderId"
     WHERE p.id > ${afterId} ${brokerFilter}
     ORDER BY p.id
     LIMIT ${limit}`;
  if (positions.length === 0) return [];
  const ids = positions.map((p) => p.id);
  const rows = await tx.$queryRaw<TxRow[]>`
    SELECT id, "referenceId", amount, "createdAt", note, ${closeCols}
      FROM "Transaction" WHERE type = 'TRADE_PNL' AND "referenceType" = 'Position' AND "referenceId" = ANY(${ids}::text[])
     ORDER BY "createdAt", id`;
  const commissions = await tx.$queryRaw<CommissionRow[]>`
    SELECT id, "referenceId", amount FROM "Transaction"
     WHERE type = 'COMMISSION' AND status = 'COMPLETED' AND "referenceType" = 'Position' AND "referenceId" = ANY(${ids}::text[])`;
  const existing = !schema.deals ? [] : await tx.$queryRaw<ExistingDeal[]>`
    SELECT id, "positionId", entry, reason, "orderId", "transactionId", volume, price, profit, swap, "executedAt", "backfillNote", "voidedAt"
      FROM "Deal" WHERE "positionId" = ANY(${ids}::text[])`;
  const usedTx = !schema.deals ? [] : await tx.$queryRaw<{ transactionId: string }[]>`
    SELECT "transactionId" FROM "Deal" WHERE "transactionId" = ANY(${commissions.map((c) => c.id)}::text[])`;
  const audits = await tx.$queryRaw<AuditRow[]>`
    SELECT id, action, "entityId", "createdAt", "actorAdminId", "oldValue", "newValue" FROM "AuditLog"
     WHERE action = ANY(${[...FLIP_ACTIONS, ...VOID_ACTIONS]}::text[]) AND "entityId" = ANY(${ids}::text[])`;
  const reverses = await tx.$queryRaw<{ entityId: string; actorAdminId: string | null; newPositionId: string }[]>`
    SELECT "entityId", "actorAdminId", "newValue"->>'newPositionId' AS "newPositionId" FROM "AuditLog"
     WHERE action = 'MANUAL_POSITION_REVERSE' AND "newValue"->>'newPositionId' = ANY(${ids}::text[])`;
  const cbIds = new Set<string>(); const cbTickets = new Set<number>();
  for (const t of rows) {
    const m = t.note ? CLOSE_BY.exec(t.note) : null;
    if (!m) continue;
    if (m[1] === "#") { const n = Number(m[2]); if (Number.isInteger(n)) cbTickets.add(n); } else cbIds.add(m[2]);
  }
  const counterparts = cbIds.size + cbTickets.size === 0 ? [] : await tx.$queryRaw<Counterpart[]>`
    SELECT id, ticket, status::text AS status, volume, "closePrice", "closedAt" FROM "Position" WHERE id = ANY(${[...cbIds]}::text[]) OR ticket = ANY(${[...cbTickets]}::int[])`;

  const used = new Set(usedTx.map((u) => u.transactionId));
  return positions.map((pos) => {
    const rev = reverses.find((r) => r.newPositionId === pos.id);
    return planPosition({
      pos,
      rows: rows.filter((r) => r.referenceId === pos.id),
      commissions: commissions.filter((c) => c.referenceId === pos.id),
      existing: existing.filter((d) => d.positionId === pos.id),
      audits: audits.filter((a) => a.entityId === pos.id),
      reversedFrom: rev ? { oldPositionId: rev.entityId, adminId: rev.actorAdminId } : null,
      counterparts,
      usedTransactionIds: used,
    });
  });
}

/** Writes one batch's plans (inside the caller's transaction). Returns the number of deals written. */
export async function writePlans(tx: Tx, plans: PositionPlan[]): Promise<number> {
  let written = 0;
  for (const p of plans) {
    if (p.ambiguous.length) continue;
    if (p.deals.length) {
      // OUT / OUT_BY / IN-with-commission: the unique transactionId makes a replay a no-op
      const r = await tx.deal.createMany({ data: p.deals.map((d) => ({ ...d, backfilled: true })), skipDuplicates: true });
      written += r.count;
    }
    if (p.setInitialVolume || p.setReversedFrom) {
      await tx.position.update({
        where: { id: p.pos.id },
        data: { ...(p.setInitialVolume ? { initialVolume: p.setInitialVolume } : {}), ...(p.setReversedFrom ? { reversedFromPositionId: p.setReversedFrom } : {}) },
      });
    }
    if (p.existingToVoid.length) await tx.deal.updateMany({ where: { id: { in: p.existingToVoid }, voidedAt: null }, data: { voidedAt: p.voidedAt } });
  }
  return written;
}

export type Opts = {
  apply: boolean; confirmHost: string | null; host: string; skipAmbiguous: boolean; from: string; batch: number; outFile?: string | null;
  /** limit the run to one broker (tests; or one tenant at a time) */
  broker?: string | null;
  /** test hook: behave as a database without these migrations */
  schemaOverride?: Schema;
};
export type Result = { exitCode: number; lines: string[]; written: number; plans: PositionPlan[] };

function report(plans: PositionPlan[], lines: string[]): PositionPlan[] {
  const changed = plans.filter((p) => !p.ambiguous.length && p.pos.status === "CLOSED" && (
    !(p.pos.realizedPnl ?? ZERO).eq(p.ledgerPnl) || !p.pos.volume.eq(p.inVolume) || (p.vwap != null && p.pos.closePrice != null && !p.pos.closePrice.eq(p.vwap))));
  lines.push("", `== positions whose row differs from their deals (old -> new): ${changed.length}`);
  lines.push("ticket | account | symbol | P/L old -> new | volume old -> new | close price old -> new (VWAP)");
  for (const p of changed) {
    lines.push(`${p.pos.ticket} | ***${p.pos.accountNumber.slice(-3)} | ${p.pos.symbol} | ${str(p.pos.realizedPnl)} -> ${p.ledgerPnl} | ${p.pos.volume} -> ${p.inVolume} | ${str(p.pos.closePrice)} -> ${str(p.vwap)}`);
  }
  const amb = plans.filter((p) => p.ambiguous.length);
  lines.push("", `== AMBIGUOUS (nothing written for these; --apply needs --skip-ambiguous): ${amb.length}`);
  for (const p of amb) lines.push(`${p.pos.ticket} (${p.pos.id}) ***${p.pos.accountNumber.slice(-3)} ${p.pos.symbol} ${p.pos.status}: ${p.ambiguous.join(" | ")}`);
  const dups = plans.filter((p) => p.duplicates > 0);
  lines.push("", `== duplicate bookings (OUT of 0 lots each): ${dups.reduce((s, p) => s + p.duplicates, 0)} on ${dups.length} position(s)`);
  for (const p of dups) lines.push(`${p.pos.ticket} ***${p.pos.accountNumber.slice(-3)}: ${p.duplicates}`);
  const derived = plans.filter((p) => p.notes.length);
  lines.push("", `== derived / unrecognised (written with a backfill note): ${derived.length}`);
  for (const p of derived) lines.push(`${p.pos.ticket}: ${p.notes.join(" | ")}`);

  const counts = new Map<string, number>();
  for (const p of plans) for (const d of p.deals) counts.set(`${d.entry} ${d.reason}`, (counts.get(`${d.entry} ${d.reason}`) ?? 0) + 1);
  const closed = plans.filter((p) => p.pos.status === "CLOSED" && p.pos.deletedAt == null);
  const bookOld = closed.reduce((s, p) => s.add(p.pos.realizedPnl ?? ZERO), ZERO);
  const bookNew = closed.reduce((s, p) => s.add(p.outProfit), ZERO);
  lines.push("", "== totals");
  lines.push(`positions scanned: ${plans.length} (open ${plans.filter((p) => p.pos.status === "OPEN").length}, closed ${plans.filter((p) => p.pos.status === "CLOSED").length}, voided ${plans.filter((p) => p.pos.status === "VOIDED").length})`);
  lines.push(`deals to write: ${[...counts.values()].reduce((s, n) => s + n, 0)}  (${[...counts.entries()].sort().map(([k, n]) => `${k} ${n}`).join(", ") || "none"})`);
  lines.push(`initialVolume to set: ${plans.filter((p) => p.setInitialVolume).length}; reversedFromPositionId to set: ${plans.filter((p) => p.setReversedFrom).length}; deals to mark voided: ${plans.reduce((s, p) => s + p.existingToVoid.length, 0)} existing + new ones on voided positions`);
  lines.push(`ambiguous positions: ${amb.length}; changed rows (old -> new above): ${changed.length}`);
  lines.push(`Book P/L of closed positions: row realizedPnl ${bookOld} -> sum of OUT profit ${bookNew} (difference ${bookNew.sub(bookOld)})`);
  return changed;
}

/** Ledger rows that undo money (an admin's manual correction, or the negative-balance write-off paired with a close). */
const OFFSET_TYPES = ["ADJUSTMENT", "NEGATIVE_BALANCE_PROTECTION", "CREDIT"];

/** Read-only checks printed after the report (docs/POSITION-DEAL-MODEL.md section 0): every touched account's balance
 *  against its ledger, each duplicate booking against any later offsetting ledger row, and the brokers of the changed
 *  positions. Nothing here changes what --apply writes. Returns the accounts whose balance differs from the ledger. */
export async function preApplyChecks(tx: Tx, plans: PositionPlan[], changed: PositionPlan[], lines: string[]): Promise<number> {
  const accountIds = [...new Set(plans.map((p) => p.pos.accountId))];
  const check = await accountChecks(tx, accountIds);
  lines.push("", `== per-account ledger check: ${check.checked} account(s) touched; balance vs opening balance + completed balance-moving ledger rows; differing: ${check.diffs.length}`);
  for (const d of check.diffs) {
    lines.push(`MISMATCH ***${d.accountNumber.slice(-3)}: balance ${d.balance} vs ledger ${d.ledger} (opening ${d.opening}, difference ${d.balance.sub(d.ledger)})`);
  }

  const dups = plans.filter((p) => p.duplicateRows.length);
  if (dups.length) {
    lines.push("", "== duplicate bookings in detail: every ledger row of the position, then the offsetting rows on its account");
    const ids = dups.map((p) => p.pos.id);
    const rows = await tx.$queryRaw<{ id: string; referenceId: string; type: string; status: string; amount: Prisma.Decimal; balanceBefore: Prisma.Decimal | null; balanceAfter: Prisma.Decimal | null; createdAt: Date; note: string | null }[]>`
      SELECT id, "referenceId", type::text AS type, status::text AS status, amount, "balanceBefore", "balanceAfter", "createdAt", note
        FROM "Transaction" WHERE "referenceId" = ANY(${ids}::text[]) ORDER BY "createdAt", id`;
    const dupAccounts = [...new Set(dups.map((p) => p.pos.accountId))];
    const offsets = await tx.$queryRaw<{ id: string; accountId: string; type: string; status: string; amount: Prisma.Decimal; createdAt: Date; referenceType: string | null; referenceId: string | null; note: string | null }[]>`
      SELECT id, "accountId", type::text AS type, status::text AS status, amount, "createdAt", "referenceType", "referenceId", note
        FROM "Transaction" WHERE "accountId" = ANY(${dupAccounts}::text[]) AND type::text = ANY(${OFFSET_TYPES}::text[]) ORDER BY "createdAt", id`;
    const usedOffsets = new Set<string>();
    let unmatched = ZERO;
    for (const p of dups) {
      lines.push(`${p.pos.ticket} ***${p.pos.accountNumber.slice(-3)} ${p.pos.symbol}:`);
      const dupIds = new Set(p.duplicateRows.map((d) => d.id));
      for (const r of rows.filter((r) => r.referenceId === p.pos.id)) {
        lines.push(`  ${r.createdAt.toISOString()} ${r.type} ${r.status} ${r.amount} balance ${str(r.balanceBefore)} -> ${str(r.balanceAfter)}${dupIds.has(r.id) ? "  <- DUPLICATE" : ""}${r.note ? `  "${r.note.slice(0, 60)}"` : ""}`);
      }
      for (const d of p.duplicateRows) {
        // an offset: a completed row on the same account, after the duplicate, for exactly the opposite amount, not used yet
        const o = offsets.find((o) => !usedOffsets.has(o.id) && o.accountId === p.pos.accountId && o.status === "COMPLETED" && o.createdAt >= d.createdAt && D(o.amount).eq(D(d.amount).neg()));
        if (o) {
          usedOffsets.add(o.id);
          lines.push(`  duplicate ${d.amount}: OFFSET by ${o.type} ${o.amount} at ${o.createdAt.toISOString()}${o.note ? ` "${o.note.slice(0, 60)}"` : ""}`);
        } else {
          unmatched = unmatched.add(d.amount);
          lines.push(`  duplicate ${d.amount}: no offsetting row of exactly ${D(d.amount).neg()}`);
        }
      }
    }
    const firstDup = dups.flatMap((p) => p.duplicateRows).reduce((m, d) => (d.createdAt < m ? d.createdAt : m), new Date(8.64e15));
    const later = offsets.filter((o) => o.createdAt >= firstDup);
    lines.push(`offsetting-type rows (${OFFSET_TYPES.join(", ")}) on those accounts since the first duplicate: ${later.length}`);
    for (const o of later) {
      const acct = dups.find((p) => p.pos.accountId === o.accountId)!.pos.accountNumber.slice(-3);
      lines.push(`  ***${acct} ${o.createdAt.toISOString()} ${o.type} ${o.status} ${o.amount} ref ${o.referenceType ?? "-"}${usedOffsets.has(o.id) ? "  (matched above)" : ""}${o.note ? `  "${o.note.slice(0, 80)}"` : ""}`);
    }
    lines.push(`duplicates without an exact offset: total ${unmatched}`);
  }

  const brokerIds = [...new Set(changed.map((p) => p.pos.brokerId))];
  const brokers = brokerIds.length ? await tx.$queryRaw<{ id: string; name: string }[]>`SELECT id, name FROM "Broker" WHERE id = ANY(${brokerIds}::text[])` : [];
  lines.push("", `== changed positions by broker: ${brokerIds.length} broker(s)`);
  for (const b of brokerIds) {
    const ps = changed.filter((p) => p.pos.brokerId === b);
    const accts = [...new Set(ps.map((p) => `***${p.pos.accountNumber.slice(-3)}`))].join(", ");
    lines.push(`${brokers.find((x) => x.id === b)?.name ?? "?"} (broker …${b.slice(-4)}): ${ps.length} position(s), accounts ${accts}`);
  }
  return check.diffs.length;
}

export async function run(prisma: PrismaClient, opts: Opts): Promise<Result> {
  const lines: string[] = [`database host: ${opts.host}`, opts.apply ? "MODE: APPLY" : "MODE: DRY RUN (nothing is written)"];
  if (opts.apply) {
    const needle = (opts.confirmHost ?? "").trim().toLowerCase();
    if (!needle) throw new BackfillRefused("--apply needs --confirm-host <part of the database host>");
    if (!opts.host.toLowerCase().includes(needle)) throw new BackfillRefused(`--confirm-host "${needle}" is not part of the database host "${opts.host}"`);
  }

  const schema = opts.schemaOverride ?? (await prisma.$transaction((tx) => detectSchema(tx)));
  lines.push(`schema: deal tables ${schema.deals ? "present" : "ABSENT (dry run reads as: no deals yet)"}; close fields ${schema.closeFields ? "present" : "ABSENT (every row read from its note)"}`);
  if (opts.apply && !(schema.deals && schema.closeFields)) {
    throw new BackfillRefused("--apply needs the deal_model_a and close_fields migrations on this database");
  }

  // full dry pass (read only): the report, and the ambiguous list --apply checks first
  const plans: PositionPlan[] = [];
  let cursor = opts.from;
  for (;;) {
    const batch = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return planBatch(tx, cursor, opts.batch, opts.broker ?? null, schema);
    });
    if (batch.length === 0) break;
    plans.push(...batch);
    cursor = batch[batch.length - 1].pos.id;
  }
  const changed = report(plans, lines);
  const ledgerDiffs = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    return preApplyChecks(tx, plans, changed, lines);
  }, { timeout: 120_000 });
  if (opts.outFile) {
    fs.writeFileSync(opts.outFile, JSON.stringify(plans.map((p) => ({
      ticket: p.pos.ticket, id: p.pos.id, account: `***${p.pos.accountNumber.slice(-3)}`, status: p.pos.status, ambiguous: p.ambiguous, notes: p.notes,
      old: { realizedPnl: p.pos.realizedPnl?.toString() ?? null, volume: p.pos.volume.toString(), closePrice: p.pos.closePrice?.toString() ?? null },
      new: { realizedPnl: p.ledgerPnl.toString(), volume: p.inVolume.toString(), closePrice: p.vwap?.toString() ?? null },
      deals: p.deals.map((d) => ({ entry: d.entry, reason: d.reason, side: d.side, volume: d.volume.toString(), price: d.price.toString(), profit: d.profit.toString(), swap: d.swap.toString(), byPositionId: d.byPositionId, transactionId: d.transactionId, executedAt: d.executedAt.toISOString(), note: d.backfillNote })),
    })), null, 1) + "\n");
    lines.push(`JSON report: ${opts.outFile}`);
  }
  const ambiguousCount = plans.filter((p) => p.ambiguous.length).length;
  if (!opts.apply) {
    lines.push("", `dry run: nothing written.${ambiguousCount ? ` ${ambiguousCount} AMBIGUOUS position(s) need the owner's sign-off (--skip-ambiguous) before --apply.` : ""}${ledgerDiffs ? ` ${ledgerDiffs} account(s) differ from their ledger (listed above).` : ""}`);
    return { exitCode: 0, lines, written: 0, plans };
  }
  if (ambiguousCount && !opts.skipAmbiguous) {
    lines.push("", `REFUSED: ${ambiguousCount} AMBIGUOUS position(s). Nothing written. Re-run with --skip-ambiguous once the owner has signed the list off.`);
    return { exitCode: 2, lines, written: 0, plans };
  }

  // write pass: each batch re-planned and written in one transaction (a close meanwhile is seen, a replay writes nothing)
  let written = 0;
  cursor = opts.from;
  for (;;) {
    const { n, last } = await prisma.$transaction(async (tx) => {
      // one writer at a time: the opening IN has no unique key of its own, so two concurrent runs must not both plan it
      await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('backfill-deals'))");
      const batch = await planBatch(tx, cursor, opts.batch, opts.broker ?? null);
      return { n: await writePlans(tx, batch), last: batch.length ? batch[batch.length - 1].pos.id : null };
    }, { timeout: 120_000 });
    if (!last) break;
    written += n;
    cursor = last;
    lines.push(`batch written: ${n} deal(s); resume with --from ${last}`);
  }
  lines.push("", `APPLIED: ${written} deal(s) written.`);
  return { exitCode: 0, lines, written, plans };
}

/** Step 7's undo (docs/POSITION-DEAL-MODEL.md section 3.3 item 5): puts every not-yet-restored DealBackfillLog row of
 *  `runId` back onto its Position (realizedPnl / closePrice, the only fields the correction rewrites) and marks it
 *  restored. Returns the rows restored; a second call restores nothing. */
export async function restoreFromLog(tx: Tx, runId: string): Promise<number> {
  const rows = await tx.dealBackfillLog.findMany({ where: { runId, restoredAt: null }, orderBy: { createdAt: "desc" } });
  for (const r of rows) {
    if (r.field !== "realizedPnl" && r.field !== "closePrice") throw new BackfillRefused(`DealBackfillLog ${r.id}: field ${r.field} cannot be restored`);
    await tx.position.update({ where: { id: r.positionId }, data: { [r.field]: r.oldValue == null ? null : D(r.oldValue) } });
    await tx.dealBackfillLog.update({ where: { id: r.id }, data: { restoredAt: new Date() } });
  }
  return rows.length;
}

function hostOf(url: string | undefined): string {
  try { return new URL(url ?? "").host; } catch { return ""; }
}

export function parseArgs(argv: string[]) {
  let apply = false; let confirmHost: string | null = null; let skipAmbiguous = false; let from = ""; let batch = BATCH; let outFile: string | null = null; let broker: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-host") confirmHost = argv[++i] ?? "";
    else if (a.startsWith("--confirm-host=")) confirmHost = a.slice("--confirm-host=".length);
    else if (a === "--skip-ambiguous") skipAmbiguous = true;
    else if (a === "--from") from = argv[++i] ?? "";
    else if (a === "--batch") batch = Number(argv[++i]);
    else if (a === "--out") outFile = argv[++i] ?? null;
    else if (a === "--broker") broker = argv[++i] ?? null;
    else throw new BackfillRefused(`unknown argument ${a}`);
  }
  if (!Number.isInteger(batch) || batch < 1) throw new BackfillRefused("--batch must be a positive integer");
  return { apply, confirmHost, skipAmbiguous, from, batch, outFile, broker };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new BackfillRefused("set BOTH DATABASE_URL and DIRECT_URL (prisma migrate and this script must agree on the database)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace(/-pooler(?=\.)/, "").split(":")[0];
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new BackfillRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const prisma = new PrismaClient();
  try {
    const r = await run(prisma, { ...args, host });
    console.log(r.lines.join("\n"));
    process.exitCode = r.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /backfill-deals\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof BackfillRefused ? `REFUSED: ${err.message}` : err);
    process.exitCode = 2;
  });
}
