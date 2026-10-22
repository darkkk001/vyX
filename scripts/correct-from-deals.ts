import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Prisma, PrismaClient } from "@prisma/client";
import { BackfillRefused, restoreFromLog } from "./backfill-deals";

// Deal model step 7 (docs/POSITION-DEAL-MODEL.md section 3.3 item 5), owner sign-off 2026-10-22 for INTERNAL accounts:
// Position.realizedPnl and closePrice of a CLOSED position recomputed from its deals.
//
//   realizedPnl = the sum of profit over its closes: OUT / OUT_BY deals with a ledger row (transactionId) and volume > 0
//   closePrice  = the volume-weighted price of the same deals, 5 dp
//
// A reverse-in-place flip writes an OUT + IN pair with no ledger row: not a close (lib/deal-closes.ts, same rule).
// The 0-lot OUT legs are duplicate bookings from before the close guard: the money moved twice and the owner settled
// it on the account balance (LEDGER_RECONCILIATION, 2026-10-19). The trade's own P/L counts each close once, so they
// are left out. Before this, realizedPnl of a multi-close position held only its last close (hotfix 2026-10-12 made it
// cumulative) and closePrice the last price.
//
// Scope: accounts with isInternal only. Non-internal accounts already match on realizedPnl; their closePrice
// differences were judged cosmetic and are not touched (owner 2026-10-21). Positions with a voided deal are skipped. A
// position whose deal lots do not add up to its opening volume is listed and refuses the run.
//
// SAFETY
//   - Default = DRY RUN (read-only transaction): prints old -> new per position and the totals.
//   - --apply needs --confirm-host <part of the database host>. One transaction: for each change a DealBackfillLog
//     row (old and new value as strings) is written first, then the Position row, guarded on the old value.
//     It prints the runId. A second run finds nothing to change.
//   - --restore <runId> --confirm-host <...> puts every logged value of that run back, once (restoreFromLog).
//
//   DATABASE_URL=... DIRECT_URL=... npx tsx scripts/correct-from-deals.ts                          (dry run)
//   ... npx tsx scripts/correct-from-deals.ts --apply --confirm-host <host part>
//   ... npx tsx scripts/correct-from-deals.ts --restore <runId> --confirm-host <host part>

type Tx = Prisma.TransactionClient;
const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);

export type Change = {
  positionId: string; ticket: number; accountNumber: string;
  oldPnl: string | null; newPnl: string; oldClose: string | null; newClose: string;
};
export type Problem = { ticket: number; accountNumber: string; why: string };

type Row = {
  positionId: string; ticket: number; accountNumber: string; realizedPnl: Prisma.Decimal | null; closePrice: Prisma.Decimal | null;
  initialVolume: Prisma.Decimal | null; pnl: Prisma.Decimal; lots: Prisma.Decimal | null; notional: Prisma.Decimal | null; voided: bigint;
};

const same = (a: Prisma.Decimal | null, b: Prisma.Decimal) => a != null && a.equals(b);

export async function plan(tx: Tx, brokerId: string | null): Promise<{ changes: Change[]; problems: Problem[] }> {
  const rows = await tx.$queryRaw<Row[]>`
    SELECT p.id AS "positionId", p.ticket, a."accountNumber", p."realizedPnl", p."closePrice", p."initialVolume",
           coalesce(sum(d.profit) FILTER (WHERE d.volume > 0), 0) AS pnl,
           sum(d.volume) FILTER (WHERE d.volume > 0) AS lots,
           sum(d.price * d.volume) FILTER (WHERE d.volume > 0) AS notional,
           count(*) FILTER (WHERE d."voidedAt" IS NOT NULL) AS voided
    FROM "Position" p
    JOIN "Account" a ON a.id = p."accountId"
    JOIN "Deal" d ON d."positionId" = p.id AND d.entry IN ('OUT', 'OUT_BY') AND d."transactionId" IS NOT NULL
    WHERE p.status = 'CLOSED' AND a."isInternal" AND (${brokerId}::text IS NULL OR p."brokerId" = ${brokerId})
    GROUP BY p.id, a."accountNumber"
    ORDER BY p.ticket`;
  const changes: Change[] = [];
  const problems: Problem[] = [];
  for (const r of rows) {
    if (Number(r.voided) > 0) continue;
    if (r.lots == null || r.notional == null || r.lots.isZero()) {
      problems.push({ ticket: r.ticket, accountNumber: r.accountNumber, why: "no close deal with lots" });
      continue;
    }
    if (r.initialVolume == null || !r.lots.equals(r.initialVolume)) {
      problems.push({ ticket: r.ticket, accountNumber: r.accountNumber, why: `deal lots ${r.lots} != opening volume ${r.initialVolume}` });
      continue;
    }
    const pnl = D(r.pnl);
    const close = r.notional.div(r.lots).toDecimalPlaces(5);
    if (same(r.realizedPnl, pnl) && same(r.closePrice, close)) continue;
    changes.push({
      positionId: r.positionId, ticket: r.ticket, accountNumber: r.accountNumber,
      oldPnl: r.realizedPnl?.toString() ?? null, newPnl: pnl.toString(), oldClose: r.closePrice?.toString() ?? null, newClose: close.toString(),
    });
  }
  return { changes, problems };
}

/** Writes the plan inside `tx`: log row first, then the Position, each guarded on the value it was planned from. */
export async function apply(tx: Tx, runId: string, changes: Change[]): Promise<number> {
  for (const c of changes) {
    await tx.dealBackfillLog.createMany({ data: [
      { runId, positionId: c.positionId, field: "realizedPnl", oldValue: c.oldPnl, newValue: c.newPnl },
      { runId, positionId: c.positionId, field: "closePrice", oldValue: c.oldClose, newValue: c.newClose },
    ] });
    const n = await tx.position.updateMany({
      where: {
        id: c.positionId, status: "CLOSED",
        realizedPnl: c.oldPnl == null ? null : D(c.oldPnl), closePrice: c.oldClose == null ? null : D(c.oldClose),
      },
      data: { realizedPnl: D(c.newPnl), closePrice: D(c.newClose) },
    });
    if (n.count !== 1) throw new BackfillRefused(`#${c.ticket} changed since it was planned; nothing written`);
  }
  return changes.length;
}

export type Opts = { apply: boolean; restore: string | null; confirmHost: string | null; host: string; broker: string | null };

export async function run(prisma: PrismaClient, opts: Opts): Promise<{ exitCode: number; lines: string[]; runId?: string; changes: Change[] }> {
  if (opts.apply || opts.restore) {
    const needle = (opts.confirmHost ?? "").trim().toLowerCase();
    if (!needle) throw new BackfillRefused("--apply / --restore need --confirm-host <part of the database host>");
    if (!opts.host.toLowerCase().includes(needle)) throw new BackfillRefused(`--confirm-host "${needle}" is not part of the database host "${opts.host}"`);
  }
  if (opts.restore) {
    const n = await prisma.$transaction((tx) => restoreFromLog(tx, opts.restore!), { timeout: 60_000 });
    return { exitCode: 0, lines: [`RESTORED: ${n} value(s) of run ${opts.restore} put back.`], changes: [] };
  }
  const work = async (tx: Tx) => {
    // SET TRANSACTION must be the first statement of its transaction
    if (!opts.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
    await tx.$executeRawUnsafe("SELECT pg_advisory_xact_lock(hashtext('correct-from-deals'))");
    const p = await plan(tx, opts.broker);
    if (opts.apply && p.problems.length === 0 && p.changes.length) {
      const runId = `step7-${new Date().toISOString().slice(0, 10)}-${randomUUID().slice(0, 8)}`;
      await apply(tx, runId, p.changes);
      return { ...p, runId };
    }
    return { ...p, runId: undefined as string | undefined };
  };
  const r = await prisma.$transaction(work, { timeout: 60_000 });

  const lines: string[] = [];
  const sum = (k: "oldPnl" | "newPnl") => r.changes.reduce((s, c) => s.add(D(c[k] ?? 0)), D(0));
  lines.push(`internal closed positions to correct: ${r.changes.length}`);
  for (const c of r.changes) {
    lines.push(`  #${c.ticket} ${c.accountNumber}: realizedPnl ${c.oldPnl} -> ${c.newPnl}, closePrice ${c.oldClose} -> ${c.newClose}`);
  }
  lines.push(`realizedPnl total: ${sum("oldPnl")} -> ${sum("newPnl")} (diff ${sum("newPnl").sub(sum("oldPnl"))})`);
  for (const p of r.problems) lines.push(`  PROBLEM #${p.ticket} ${p.accountNumber}: ${p.why}`);
  if (r.problems.length) {
    lines.push(opts.apply ? "REFUSED: fix the problems above first; nothing written." : "dry run: the problems above would refuse --apply.");
    return { exitCode: 1, lines, changes: r.changes };
  }
  if (opts.apply) lines.push(r.runId ? `APPLIED: ${r.changes.length} position(s), runId ${r.runId} (undo: --restore ${r.runId})` : "APPLIED: nothing to change.");
  else lines.push("dry run: nothing written.");
  return { exitCode: 0, lines, runId: r.runId, changes: r.changes };
}

export function parseArgs(argv: string[]) {
  let applyFlag = false; let restore: string | null = null; let confirmHost: string | null = null; let broker: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") applyFlag = true;
    else if (a === "--restore") restore = argv[++i] ?? "";
    else if (a === "--confirm-host") confirmHost = argv[++i] ?? "";
    else if (a === "--broker") broker = argv[++i] ?? null;
    else throw new BackfillRefused(`unknown argument ${a}`);
  }
  if (applyFlag && restore) throw new BackfillRefused("--apply and --restore together");
  if (restore === "") throw new BackfillRefused("--restore needs a runId");
  return { apply: applyFlag, restore, confirmHost, broker };
}

function hostOf(url: string | undefined): string {
  try { return new URL(url ?? "").host; } catch { return ""; }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new BackfillRefused("set BOTH DATABASE_URL and DIRECT_URL");
  const endpoint = (h: string) => h.replace(/-pooler(?=\.)/, "").split(":")[0];
  if (endpoint(hostOf(url)) !== endpoint(hostOf(direct))) throw new BackfillRefused(`DATABASE_URL (${hostOf(url)}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const prisma = new PrismaClient({ datasourceUrl: direct });
  try {
    const r = await run(prisma, { ...args, host: hostOf(url) });
    console.log(r.lines.join("\n"));
    process.exitCode = r.exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /correct-from-deals\.ts$/.test(process.argv[1])) {
  main().catch((err) => {
    console.error(err instanceof BackfillRefused ? `REFUSED: ${err.message}` : err);
    process.exitCode = 2;
  });
}
