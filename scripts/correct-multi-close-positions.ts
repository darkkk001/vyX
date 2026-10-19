// Correction of the positions that were closed in more than one piece (docs/POSITION-DEAL-MODEL.md section 0, item 3).
//
// Before the close-fields hotfix, Position.realizedPnl / volume / closePrice held only the LAST close of a position that
// was closed in parts. This script rebuilds, for every position (deletedAt null) with 2 or more TRADE_PNL rows:
//   - realizedPnl  = the sum of its TRADE_PNL amounts (cumulative),
//   - closedVolume = the sum of the lots of its closes,
//   - closedSwap   = Position.swap split pro rata over its closes (the same rule closePositionInTx applies from now on),
// and the structured fields on each TRADE_PNL row (closeVolume, closePrice, closeSwap, closeByPositionId) where they can
// be determined. Lots that cannot be determined exactly are reported as UNKNOWN and never guessed; such a position gets
// its realizedPnl corrected (always exact) and nothing lot-based.
//
// SAFETY
//   - Default = DRY RUN. Every read is inside ONE transaction that starts with SET TRANSACTION READ ONLY (and reads one
//     snapshot). It reads only columns that exist before the close_fields migration, so it can be dry-run on a database
//     that does not have the new columns yet.
//   - The run STOPS (exit code 2, nothing written, --apply refused) if any affected account's balance differs from its
//     opening balance (the balanceBefore of its first completed balance-moving ledger row: seeded demo balances have no
//     ledger row of their own) plus the sum of its completed balance-moving ledger rows.
//   - Duplicate closes (owner decision 2026-10-12): a TRADE_PNL row with the same amount as the position's previous one,
//     both notes null, less than 1 s apart, is a double booking from before the close guard (0228edd), not a partial. It
//     is left out of the sums and listed separately; nothing is written to it.
//   - --only-accounts <n,n> limits the run to those accounts (full number or a unique suffix such as 708); every other
//     affected account is listed as excluded and is neither checked nor written. Owner decision 2026-10-12: apply only
//     to ***708 and ***001; ***680 and ***704 are excluded (their balances differ from the ledger, see the 2026-10-12
//     investigation in docs/POSITION-DEAL-MODEL.md).
//   - Writing needs --apply AND --confirm-host <substring of the database host>, and the new columns must exist. The checks
//     are re-run inside the write transaction. Every old value is stored first, per position, in an AuditLog row
//     (POSITION_CLOSE_FIELDS_CORRECTED) so --revert can restore it. Idempotent: a second run changes nothing.
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/correct-multi-close-positions.ts                      (dry run)
//   ... npx tsx scripts/correct-multi-close-positions.ts --only-accounts 708,001                          (dry run, two accounts)
//   ... npx tsx scripts/correct-multi-close-positions.ts --apply --confirm-host <host substring>
//   ... npx tsx scripts/correct-multi-close-positions.ts --revert                                         (dry run of a revert)
//   ... npx tsx scripts/correct-multi-close-positions.ts --revert --apply --confirm-host <host substring>
import { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const ZERO = D(0);

export const AUDIT_CORRECTED = "POSITION_CLOSE_FIELDS_CORRECTED";
export const AUDIT_REVERTED = "POSITION_CLOSE_FIELDS_REVERTED";

/** Ledger rows that move Account.balance (amount is signed; WITHDRAWAL and TRANSFER_OUT are stored negative). CREDIT is
 *  credit used up by a loss (it adds to the balance, lib/position-close.ts); CREDIT_IN / CREDIT_OUT move Account.credit only. */
export const BALANCE_TYPES = ["DEPOSIT", "WITHDRAWAL", "CREDIT", "ADJUSTMENT", "NEGATIVE_BALANCE_PROTECTION", "COMMISSION", "SWAP", "TRADE_PNL", "TRANSFER_IN", "TRANSFER_OUT"] as const;

const NEW_COLUMNS = [
  ["Position", "closedVolume"], ["Position", "closedSwap"],
  ["Transaction", "closeVolume"], ["Transaction", "closePrice"], ["Transaction", "closeSwap"], ["Transaction", "closeByPositionId"],
] as const;

export class CorrectionRefused extends Error {}

export type Opts = {
  apply: boolean;
  revert: boolean;
  confirmHost: string | null;
  host: string;
  /** limit to these accounts (full account number or a suffix that matches exactly one affected account) */
  onlyAccounts?: string[] | null;
  /** test hook: behave as a database without the new columns (never select them) */
  legacySchema?: boolean;
  now?: Date;
};
export type Result = { exitCode: number; lines: string[]; changedPositions: number };

type PosRow = {
  id: string; ticket: number; accountId: string; accountNumber: string; brokerId: string; currency: string; symbol: string; side: string; status: string;
  volume: Prisma.Decimal; closePrice: Prisma.Decimal | null; realizedPnl: Prisma.Decimal | null; swap: Prisma.Decimal; orderVolume: Prisma.Decimal;
  closedVolume?: Prisma.Decimal | null; closedSwap?: Prisma.Decimal | null;
};
type TxRow = {
  id: string; referenceId: string; amount: Prisma.Decimal; createdAt: Date; note: string | null;
  closeVolume?: Prisma.Decimal | null; closePrice?: Prisma.Decimal | null; closeSwap?: Prisma.Decimal | null; closeByPositionId?: string | null;
};
type Counterpart = { id: string; ticket: number; status: string; volume: Prisma.Decimal; closePrice: Prisma.Decimal | null; closedAt: Date | null };

type Basis = "structured" | "final" | "note" | "counterpart" | "derived" | "UNKNOWN";
type CloseCalc = {
  tx: TxRow; lots: Prisma.Decimal | null; basis: Basis; price: Prisma.Decimal | null; closeBy: string | null; swapShare: Prisma.Decimal | null;
};
export type Plan = {
  pos: PosRow;
  closes: CloseCalc[];
  newRealizedPnl: Prisma.Decimal;
  newClosedVolume: Prisma.Decimal | null;
  newClosedSwap: Prisma.Decimal | null;
  changes: { position: Record<string, string | null>; transactions: { id: string; set: Record<string, string | null> }[] };
  changed: boolean;
  unknownCloses: number;
  /** TRADE_PNL rows recognised as duplicate bookings: left out of every sum, never written */
  duplicates: TxRow[];
};

export const PARTIAL = /^(?:Manual partial close by admin|Partial close): ([0-9]+(?:\.[0-9]+)?) lots @ ([0-9]+(?:\.[0-9]+)?)$/;
export const CLOSE_BY = /^Close by (#?)(\S+)$/;
const PAIR_WINDOW_MS = 5000;
const DUPLICATE_WINDOW_MS = 1000;

const str = (v: Prisma.Decimal | null | undefined) => (v == null ? null : v.toString());
const eq = (a: Prisma.Decimal | null | undefined, b: Prisma.Decimal | null | undefined) => (a == null || b == null ? a == null && b == null : a.eq(b));
export const mask = (accountNumber: string) => `***${accountNumber.slice(-3)}`;

async function hasNewColumns(tx: Tx): Promise<boolean> {
  const names = NEW_COLUMNS.map(([, c]) => c);
  const rows = await tx.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY(${["Position", "Transaction"]}::text[]) AND column_name = ANY(${names}::text[])`;
  return NEW_COLUMNS.every(([t, c]) => rows.some((r) => r.table_name === t && r.column_name === c));
}

/** The positions to correct and the corrected values. Reads only (and only existing columns when `cols` is false). */
export async function buildPlans(tx: Tx, cols: boolean): Promise<Plan[]> {
  const posCols = cols ? Prisma.sql`, p."closedVolume", p."closedSwap"` : Prisma.empty;
  const positions = await tx.$queryRaw<PosRow[]>`
    SELECT p.id, p.ticket, p."accountId", a."accountNumber", a."brokerId", a.currency, s.name AS symbol, p.side::text AS side, p.status::text AS status,
           p.volume, p."closePrice", p."realizedPnl", p.swap, o.volume AS "orderVolume" ${posCols}
      FROM "Position" p
      JOIN "Account" a ON a.id = p."accountId"
      JOIN "Symbol" s ON s.id = p."symbolId"
      JOIN "Order" o ON o.id = p."originOrderId"
     WHERE p."deletedAt" IS NULL
       AND (SELECT COUNT(*) FROM "Transaction" t WHERE t.type = 'TRADE_PNL' AND t."referenceType" = 'Position' AND t."referenceId" = p.id) >= 2
     ORDER BY p.ticket`;
  if (positions.length === 0) return [];
  const ids = positions.map((p) => p.id);
  const txCols = cols ? Prisma.sql`, t."closeVolume", t."closePrice", t."closeSwap", t."closeByPositionId"` : Prisma.empty;
  const txs = await tx.$queryRaw<TxRow[]>`
    SELECT t.id, t."referenceId", t.amount, t."createdAt", t.note ${txCols}
      FROM "Transaction" t
     WHERE t.type = 'TRADE_PNL' AND t."referenceType" = 'Position' AND t."referenceId" = ANY(${ids}::text[])
     ORDER BY t."createdAt", t.id`;
  const byPos = new Map<string, TxRow[]>();
  for (const t of txs) byPos.set(t.referenceId, [...(byPos.get(t.referenceId) ?? []), t]);

  // close-by counterparts, by id or by ticket
  const cbIds = new Set<string>(); const cbTickets = new Set<number>();
  for (const t of txs) {
    const m = t.note ? CLOSE_BY.exec(t.note) : null;
    if (!m) continue;
    if (m[1] === "#") { const n = Number(m[2]); if (Number.isInteger(n)) cbTickets.add(n); } else cbIds.add(m[2]);
  }
  const counterparts = cbIds.size + cbTickets.size === 0 ? [] : await tx.$queryRaw<Counterpart[]>`
    SELECT id, ticket, status::text AS status, volume, "closePrice", "closedAt" FROM "Position"
     WHERE id = ANY(${[...cbIds]}::text[]) OR ticket = ANY(${[...cbTickets]}::int[])`;

  return positions.map((pos) => planOne(pos, byPos.get(pos.id) ?? [], counterparts, cols));
}

/** Splits a position's TRADE_PNL rows into real closes and duplicate bookings (same amount as the previous real close,
 *  both notes null, less than 1 s apart: the double close the guard of 0228edd stopped on 2026-08-27). */
export function splitDuplicates(rows: TxRow[]): { kept: TxRow[]; duplicates: TxRow[] } {
  const kept: TxRow[] = []; const duplicates: TxRow[] = [];
  for (const t of rows) {
    const prev = kept[kept.length - 1];
    const dup = prev != null && t.note == null && prev.note == null && D(t.amount).eq(D(prev.amount))
      && t.createdAt.getTime() - prev.createdAt.getTime() < DUPLICATE_WINDOW_MS;
    (dup ? duplicates : kept).push(t);
  }
  return { kept, duplicates };
}

function planOne(pos: PosRow, allRows: TxRow[], counterparts: Counterpart[], cols: boolean): Plan {
  const { kept: rows, duplicates } = splitDuplicates(allRows);
  const isClosed = pos.status === "CLOSED";
  const closes: CloseCalc[] = rows.map((tx, i) => {
    const final = isClosed && i === rows.length - 1;
    const m = tx.note ? CLOSE_BY.exec(tx.note) : null;
    const cp = m ? counterparts.find((c) => (m[1] === "#" ? String(c.ticket) === m[2] : c.id === m[2])) : undefined;
    const noteCloseBy = cp ? cp.id : null;
    if (cols && tx.closeVolume != null) {
      return { tx, lots: tx.closeVolume, basis: "structured", price: tx.closePrice ?? null, closeBy: tx.closeByPositionId ?? noteCloseBy, swapShare: null };
    }
    if (final) return { tx, lots: pos.volume, basis: "final", price: pos.closePrice, closeBy: noteCloseBy, swapShare: null };
    const pm = tx.note ? PARTIAL.exec(tx.note) : null;
    if (pm) return { tx, lots: D(pm[1]), basis: "note", price: D(pm[2]), closeBy: null, swapShare: null };
    // a close-by leg that left the position open: the counterpart closed fully in the same close-by, with the same lots and price
    if (cp && cp.status === "CLOSED" && cp.closedAt && Math.abs(cp.closedAt.getTime() - tx.createdAt.getTime()) <= PAIR_WINDOW_MS) {
      return { tx, lots: cp.volume, basis: "counterpart", price: cp.closePrice, closeBy: cp.id, swapShare: null };
    }
    return { tx, lots: null, basis: "UNKNOWN", price: null, closeBy: noteCloseBy, swapShare: null };
  });

  // Exactly one close without lots: the closes together always add up to the opening order's volume (less what is still
  // open), so its lots are that difference. Exact arithmetic, flagged "derived"; two or more unknowns stay UNKNOWN.
  const unknown = closes.filter((c) => c.lots == null);
  if (unknown.length === 1) {
    const known = closes.reduce((s, c) => (c.lots ? s.add(c.lots) : s), ZERO);
    const lots = pos.orderVolume.sub(pos.status === "OPEN" ? pos.volume : ZERO).sub(known);
    if (lots.gt(0)) { unknown[0].lots = lots; unknown[0].basis = "derived"; }
  }
  const unknownCloses = closes.filter((c) => c.lots == null).length;

  const newRealizedPnl = rows.reduce((s, t) => s.add(t.amount), ZERO);
  const allKnown = unknownCloses === 0;
  const newClosedVolume = allKnown ? closes.reduce((s, c) => s.add(c.lots!), ZERO) : null;

  // pro-rata swap, the same rule as lib/position-close.ts: share = round2((swap - attributed) * lots / open lots before the
  // close); the final close takes exactly the remainder
  let newClosedSwap: Prisma.Decimal | null = null;
  if (allKnown) {
    let attributed = ZERO;
    let openLots = newClosedVolume! .add(pos.status === "OPEN" ? pos.volume : ZERO);
    closes.forEach((c, i) => {
      const last = isClosed && i === closes.length - 1;
      const remainder = pos.swap.sub(attributed);
      c.swapShare = last ? remainder.toDecimalPlaces(2) : remainder.mul(c.lots!).div(openLots).toDecimalPlaces(2);
      attributed = attributed.add(c.swapShare);
      openLots = openLots.sub(c.lots!);
    });
    newClosedSwap = attributed;
  }

  const position: Record<string, string | null> = {};
  if (!eq(pos.realizedPnl, newRealizedPnl)) position.realizedPnl = str(newRealizedPnl);
  if (allKnown && cols && !eq(pos.closedVolume, newClosedVolume)) position.closedVolume = str(newClosedVolume);
  if (allKnown && cols && !eq(pos.closedSwap, newClosedSwap)) position.closedSwap = str(newClosedSwap);
  const transactions: { id: string; set: Record<string, string | null> }[] = [];
  for (const c of closes) {
    const set: Record<string, string | null> = {};
    if (c.lots && !eq(c.tx.closeVolume, c.lots)) set.closeVolume = str(c.lots);
    if (c.price && !eq(c.tx.closePrice, c.price)) set.closePrice = str(c.price);
    if (c.swapShare && !eq(c.tx.closeSwap, c.swapShare)) set.closeSwap = str(c.swapShare);
    if (c.closeBy && c.tx.closeByPositionId !== c.closeBy) set.closeByPositionId = c.closeBy;
    if (Object.keys(set).length) transactions.push({ id: c.tx.id, set });
  }
  // when the new columns do not exist yet, "changes" is only what the position's realizedPnl needs; the rest is previewed
  // through the new values in the table and is written once the migration is deployed
  const changed = Object.keys(position).length > 0 || transactions.length > 0;
  return { pos, closes, newRealizedPnl, newClosedVolume, newClosedSwap, changes: { position, transactions }, changed, unknownCloses, duplicates };
}

type AccountDiff = { accountNumber: string; balance: Prisma.Decimal; ledger: Prisma.Decimal; opening: Prisma.Decimal };

/** Per affected account: Account.balance against its opening balance (the balanceBefore of its first completed
 *  balance-moving ledger row) plus the sum of its completed balance-moving ledger rows. */
export async function accountChecks(tx: Tx, accountIds: string[]): Promise<{ checked: number; diffs: AccountDiff[] }> {
  if (accountIds.length === 0) return { checked: 0, diffs: [] };
  const rows = await tx.$queryRaw<{ accountNumber: string; balance: Prisma.Decimal; ledger: Prisma.Decimal | null; opening: Prisma.Decimal | null }[]>`
    SELECT a."accountNumber", a.balance,
           COALESCE(SUM(t.amount) FILTER (WHERE t.status = 'COMPLETED' AND t.type::text = ANY(${[...BALANCE_TYPES]}::text[])), 0) AS ledger,
           (SELECT f."balanceBefore" FROM "Transaction" f
             WHERE f."accountId" = a.id AND f.status = 'COMPLETED' AND f.type::text = ANY(${[...BALANCE_TYPES]}::text[])
             ORDER BY f."createdAt", f.id LIMIT 1) AS opening
      FROM "Account" a LEFT JOIN "Transaction" t ON t."accountId" = a.id
     WHERE a.id = ANY(${accountIds}::text[])
     GROUP BY a.id, a."accountNumber", a.balance ORDER BY a."accountNumber"`;
  const diffs = rows
    .map((r) => ({ accountNumber: r.accountNumber, balance: D(r.balance), opening: D(r.opening ?? 0), ledger: D(r.opening ?? 0).add(D(r.ledger ?? 0)) }))
    .filter((r) => !r.balance.eq(r.ledger));
  return { checked: rows.length, diffs };
}

// Same filter as lib/book-pnl.ts heldSql (held-book, live, non-internal, no coverage account/group, B_BOOK / DEALING at open).
// A test compares this script's "before" with bookPnlRealized so the two cannot drift apart.
function heldSql(brokerId: string, coverageAccountId: string | null) {
  return Prisma.sql`p."brokerId" = ${brokerId} AND p."deletedAt" IS NULL
    AND a."accountMode" = 'LIVE' AND a."isInternal" = false
    AND (${coverageAccountId}::text IS NULL OR a.id <> ${coverageAccountId})
    AND (g.category IS NULL OR g.category <> 'COVERAGE')
    AND COALESCE(p."groupCategoryAtOpen"::text, g.category::text) IN ('B_BOOK', 'DEALING')
    AND p."bookType" = 'B_BOOK'`;
}

export type BookRow = { brokerId: string; currency: string; window: "all time" | "last 30 days"; before: Prisma.Decimal; after: Prisma.Decimal };

export async function bookPnlBeforeAfter(tx: Tx, plans: Plan[], now: Date): Promise<BookRow[]> {
  const out: BookRow[] = [];
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const brokerIds = [...new Set(plans.map((p) => p.pos.brokerId))];
  for (const brokerId of brokerIds) {
    const broker = await tx.$queryRaw<{ coverageAccountId: string | null }[]>`SELECT "coverageAccountId" FROM "Broker" WHERE id = ${brokerId}`;
    const cov = broker[0]?.coverageAccountId ?? null;
    const held = heldSql(brokerId, cov);
    for (const [window, from] of [["all time", null], ["last 30 days", since]] as const) {
      const totals = await tx.$queryRaw<{ currency: string; total: Prisma.Decimal | null }[]>`
        SELECT a.currency, -SUM(p."realizedPnl") AS total
          FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
         WHERE ${held} AND p.status = 'CLOSED' AND p."realizedPnl" IS NOT NULL AND (${from}::timestamptz IS NULL OR p."closedAt" >= ${from})
         GROUP BY a.currency ORDER BY a.currency`;
      const mine = plans.filter((p) => p.pos.brokerId === brokerId && p.pos.status === "CLOSED" && p.pos.realizedPnl != null);
      const heldIds = mine.length === 0 ? [] : await tx.$queryRaw<{ id: string }[]>`
        SELECT p.id FROM "Position" p JOIN "Account" a ON a.id = p."accountId" LEFT JOIN "Group" g ON g.id = a."groupId"
         WHERE ${held} AND p.id = ANY(${mine.map((p) => p.pos.id)}::text[]) AND p.status = 'CLOSED' AND (${from}::timestamptz IS NULL OR p."closedAt" >= ${from})`;
      const heldSet = new Set(heldIds.map((r) => r.id));
      const delta = new Map<string, Prisma.Decimal>();
      for (const p of mine) if (heldSet.has(p.pos.id)) delta.set(p.pos.currency, (delta.get(p.pos.currency) ?? ZERO).add(p.newRealizedPnl.sub(p.pos.realizedPnl!)));
      const currencies = new Set([...totals.map((t) => t.currency), ...delta.keys()]);
      for (const currency of [...currencies].sort()) {
        const before = D(totals.find((t) => t.currency === currency)?.total ?? 0);
        out.push({ brokerId, currency, window, before, after: before.sub(delta.get(currency) ?? ZERO) });
      }
    }
  }
  return out;
}

const pad = (s: string, n: number) => (s.length >= n ? s : s + " ".repeat(n - s.length));
const arrow = (a: string | null | undefined, b: string | null | undefined) => `${a ?? "none"} -> ${b ?? "n/a"}`;

function planTable(plans: Plan[]): string[] {
  const head = ["ticket", "account", "symbol", "side", "status", "closes", "volume -> closedVolume", "how the lots were found", "realizedPnl old -> new", "closedSwap old -> new"];
  const rows = plans.map((p) => [
    String(p.pos.ticket), mask(p.pos.accountNumber), p.pos.symbol, p.pos.side, p.pos.status, String(p.closes.length),
    arrow(p.pos.volume.toString(), p.newClosedVolume?.toString()),
    p.closes.map((c) => c.basis).join(", ") + (p.unknownCloses ? `  <- ${p.unknownCloses} close(s) UNKNOWN, no lot-based fields written` : ""),
    arrow(p.pos.realizedPnl?.toString(), p.newRealizedPnl.toString()),
    arrow(p.pos.closedSwap?.toString(), p.newClosedSwap?.toString()),
  ]);
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  return [head, ...rows].map((r) => r.map((c, i) => pad(c, w[i])).join("  ").trimEnd());
}

async function applyPlans(tx: Tx, plans: Plan[]): Promise<number> {
  let n = 0;
  for (const p of plans) {
    if (!p.changed) continue;
    const txIds = p.changes.transactions.map((t) => t.id);
    const oldTx = txIds.length === 0 ? [] : await tx.$queryRaw<{ id: string; closeVolume: Prisma.Decimal | null; closePrice: Prisma.Decimal | null; closeSwap: Prisma.Decimal | null; closeByPositionId: string | null }[]>`
      SELECT id, "closeVolume", "closePrice", "closeSwap", "closeByPositionId" FROM "Transaction" WHERE id = ANY(${txIds}::text[])`;
    const oldVal = {
      position: { realizedPnl: str(p.pos.realizedPnl), closedVolume: str(p.pos.closedVolume), closedSwap: str(p.pos.closedSwap) },
      transactions: oldTx.map((t) => ({ id: t.id, closeVolume: str(t.closeVolume), closePrice: str(t.closePrice), closeSwap: str(t.closeSwap), closeByPositionId: t.closeByPositionId })),
    };
    const newVal = {
      position: { realizedPnl: p.changes.position.realizedPnl ?? str(p.pos.realizedPnl), closedVolume: p.changes.position.closedVolume ?? str(p.pos.closedVolume), closedSwap: p.changes.position.closedSwap ?? str(p.pos.closedSwap) },
      transactions: p.changes.transactions.map((t) => ({ id: t.id, ...t.set })),
    };
    await tx.auditLog.create({ data: { brokerId: p.pos.brokerId, action: AUDIT_CORRECTED, entityType: "Position", entityId: p.pos.id, oldValue: oldVal as Prisma.InputJsonValue, newValue: newVal as Prisma.InputJsonValue } });
    await setPositionFields(tx, p.pos.id, newVal.position);
    for (const t of p.changes.transactions) await setTxFields(tx, t.id, t.set);
    n++;
  }
  return n;
}

async function setPositionFields(tx: Tx, id: string, v: { realizedPnl: string | null; closedVolume: string | null; closedSwap: string | null }) {
  await tx.$executeRaw`UPDATE "Position" SET "realizedPnl" = ${v.realizedPnl}::numeric, "closedVolume" = ${v.closedVolume}::numeric, "closedSwap" = ${v.closedSwap}::numeric WHERE id = ${id}`;
}
async function setTxFields(tx: Tx, id: string, v: Record<string, string | null | undefined>) {
  // only the keys present are touched
  if ("closeVolume" in v) await tx.$executeRaw`UPDATE "Transaction" SET "closeVolume" = ${v.closeVolume ?? null}::numeric WHERE id = ${id}`;
  if ("closePrice" in v) await tx.$executeRaw`UPDATE "Transaction" SET "closePrice" = ${v.closePrice ?? null}::numeric WHERE id = ${id}`;
  if ("closeSwap" in v) await tx.$executeRaw`UPDATE "Transaction" SET "closeSwap" = ${v.closeSwap ?? null}::numeric WHERE id = ${id}`;
  if ("closeByPositionId" in v) await tx.$executeRaw`UPDATE "Transaction" SET "closeByPositionId" = ${v.closeByPositionId ?? null} WHERE id = ${id}`;
}

type Corrected = { id: string; brokerId: string | null; entityId: string; oldValue: { position: { realizedPnl: string | null; closedVolume: string | null; closedSwap: string | null }; transactions: { id: string; closeVolume: string | null; closePrice: string | null; closeSwap: string | null; closeByPositionId: string | null }[] } };

async function revertAll(tx: Tx, write: boolean, lines: string[]): Promise<number> {
  const corrected = await tx.$queryRaw<Corrected[]>`
    SELECT a.id, a."brokerId", a."entityId", a."oldValue" FROM "AuditLog" a
     WHERE a.action = ${AUDIT_CORRECTED}
       AND NOT EXISTS (SELECT 1 FROM "AuditLog" r WHERE r.action = ${AUDIT_REVERTED} AND r."newValue"->>'revertedAuditId' = a.id)
     ORDER BY a."createdAt" DESC, a.id`;
  const seen = new Set<string>();
  let n = 0;
  for (const c of corrected) {
    if (seen.has(c.entityId)) continue; // newest unreverted correction per position only; older ones were superseded by it
    seen.add(c.entityId);
    lines.push(`${write ? "restoring" : "would restore"} position ${c.entityId}: realizedPnl ${c.oldValue.position.realizedPnl ?? "none"}, closedVolume ${c.oldValue.position.closedVolume ?? "none"}, closedSwap ${c.oldValue.position.closedSwap ?? "none"}, ${c.oldValue.transactions.length} ledger row(s)`);
    if (write) {
      await setPositionFields(tx, c.entityId, c.oldValue.position);
      for (const t of c.oldValue.transactions) await setTxFields(tx, t.id, t);
      await tx.auditLog.create({ data: { brokerId: c.brokerId, action: AUDIT_REVERTED, entityType: "Position", entityId: c.entityId, newValue: { revertedAuditId: c.id } } });
    }
    n++;
  }
  return n;
}

export async function run(prisma: PrismaClient, opts: Opts): Promise<Result> {
  const writing = opts.apply;
  if (writing) {
    const needle = (opts.confirmHost ?? "").trim().toLowerCase();
    if (!needle) throw new CorrectionRefused("--apply needs --confirm-host <part of the database host>");
    if (!opts.host.toLowerCase().includes(needle)) throw new CorrectionRefused(`--confirm-host "${needle}" is not part of the database host "${opts.host}"`);
  }
  const now = opts.now ?? new Date();
  const lines: string[] = [`mode: ${opts.revert ? "REVERT" : "CORRECT"} ${writing ? "APPLY" : "DRY RUN"}`, `database host: ${opts.host}`];

  return prisma.$transaction(
    async (tx): Promise<Result> => {
      if (!writing) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      const cols = opts.legacySchema ? false : await hasNewColumns(tx);
      lines.push(`new columns present: ${cols ? "yes" : "no (migration 2026101213xxxx_close_fields not deployed here: lot-based fields are previewed only)"}`);
      if (writing && !cols) throw new CorrectionRefused("the close_fields migration is not applied on this database: --apply refused");

      if (opts.revert) {
        if (!cols) throw new CorrectionRefused("the close_fields migration is not applied on this database: nothing to revert");
        const n = await revertAll(tx, writing, lines);
        lines.push(`${n} position(s) ${writing ? "restored" : "would be restored (dry run, add --apply --confirm-host to write)"}`);
        return { exitCode: 0, lines, changedPositions: writing ? n : 0 };
      }

      const found = await buildPlans(tx, cols);
      lines.push(`positions with 2 or more TRADE_PNL rows: ${found.length}`);
      const plans = selectAccounts(found, opts.onlyAccounts ?? null, lines);
      lines.push("", ...planTable(plans), "");
      const dups = found.flatMap((p) => p.duplicates.map((d) => ({ p, d })));
      lines.push(`duplicate closes (same amount as the previous close, no note, < 1 s apart; left out of every sum, nothing written): ${dups.length}`);
      for (const { p, d } of dups) {
        const prev = p.closes.filter((c) => c.tx.createdAt.getTime() <= d.createdAt.getTime()).at(-1)?.tx;
        const ms = prev ? d.createdAt.getTime() - prev.createdAt.getTime() : null;
        lines.push(`  ticket ${p.pos.ticket}  ${mask(p.pos.accountNumber)}  amount ${d.amount.toString()}  ${ms ?? "?"} ms after the previous close  ${d.createdAt.toISOString()}${plans.includes(p) ? "" : "  (account excluded)"}`);
      }
      lines.push("");

      const accountIds = [...new Set(plans.map((p) => p.pos.accountId))];
      const check = await accountChecks(tx, accountIds);
      lines.push(`ledger check: ${check.checked} affected account(s), balance vs the sum of completed balance-moving ledger rows (${BALANCE_TYPES.join(", ")})`);
      if (check.diffs.length > 0) {
        for (const d of check.diffs) lines.push(`  MISMATCH account ${mask(d.accountNumber)}: balance ${d.balance} vs ledger ${d.ledger} (opening ${d.opening}, difference ${d.balance.sub(d.ledger)})`);
        lines.push("STOPPED: at least one affected account does not reconcile. Nothing written; --apply is refused until this is explained.");
        return { exitCode: 2, lines, changedPositions: 0 };
      }
      lines.push("  all affected accounts reconcile");

      const book = await bookPnlBeforeAfter(tx, plans, now);
      lines.push("", "Book P/L (lib/book-pnl.ts rule: held book, live, non-internal, no coverage), per broker and account currency:");
      if (book.length === 0) lines.push("  no affected position counts toward Book P/L");
      for (const b of book) lines.push(`  broker ${b.brokerId} ${b.currency} ${b.window}: before ${b.before.toFixed(2)} -> after ${b.after.toFixed(2)} (change ${b.after.sub(b.before).toFixed(2)})`);

      const toChange = plans.filter((p) => p.changed).length;
      if (!writing) {
        lines.push("", `dry run: nothing written. ${toChange} position(s) would change. Add --apply --confirm-host <host part> to write.`);
        return { exitCode: 0, lines, changedPositions: 0 };
      }
      const n = await applyPlans(tx, plans);
      lines.push("", `applied: ${n} position(s) corrected, old values stored in AuditLog ${AUDIT_CORRECTED}.`);
      return { exitCode: 0, lines, changedPositions: n };
    },
    { timeout: 300_000, maxWait: 20_000, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
  );
}

/** --only-accounts: each entry is a full account number or a suffix matching exactly one affected account. */
export function selectAccounts(plans: Plan[], only: string[] | null, lines: string[]): Plan[] {
  if (!only || only.length === 0) return plans;
  const numbers = [...new Set(plans.map((p) => p.pos.accountNumber))];
  const chosen = new Set<string>();
  for (const raw of only) {
    const want = raw.trim();
    if (!want) continue;
    const hits = numbers.filter((n) => n === want || n.endsWith(want));
    if (hits.length !== 1) throw new CorrectionRefused(`--only-accounts "${want}" matches ${hits.length} affected account(s); give more digits`);
    chosen.add(hits[0]);
  }
  const kept = plans.filter((p) => chosen.has(p.pos.accountNumber));
  const excluded = numbers.filter((n) => !chosen.has(n));
  lines.push(`limited to ${chosen.size} account(s) (--only-accounts): ${[...chosen].map(mask).join(", ")}; ${kept.length} position(s)`);
  if (excluded.length) lines.push(`excluded, not checked and never written: ${excluded.map((n) => `${mask(n)} (${plans.filter((p) => p.pos.accountNumber === n).length} positions)`).join(", ")}`);
  return kept;
}

function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

export function parseArgs(argv: string[]): { apply: boolean; revert: boolean; confirmHost: string | null; onlyAccounts: string[] | null } {
  let apply = false; let revert = false; let confirmHost: string | null = null; let onlyAccounts: string[] | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--revert") revert = true;
    else if (a === "--confirm-host") confirmHost = argv[++i] ?? "";
    else if (a.startsWith("--confirm-host=")) confirmHost = a.slice("--confirm-host=".length);
    else if (a === "--only-accounts") onlyAccounts = (argv[++i] ?? "").split(",").filter(Boolean);
    else if (a.startsWith("--only-accounts=")) onlyAccounts = a.slice("--only-accounts=".length).split(",").filter(Boolean);
    else throw new CorrectionRefused(`unknown argument: ${a}`);
  }
  return { apply, revert, confirmHost, onlyAccounts };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new CorrectionRefused("set DATABASE_URL and DIRECT_URL in the environment");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new CorrectionRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const prisma = new PrismaClient();
  try {
    const result = await run(prisma, { ...args, host });
    for (const l of result.lines) console.log(l);
    process.exitCode = result.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /correct-multi-close-positions\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof CorrectionRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
