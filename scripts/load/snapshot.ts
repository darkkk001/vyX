// Stage 4 load harness -- the canonical end state of a load database (docs/RUST-CUTOVER-PLAN.md §4.3), written as JSON
// so scripts/load/diff.mjs can compare the web run with the engine run id by id.
//
//   DATABASE_URL=<vyx_load_web|vyx_load_engine> DIRECT_URL=<same> npx tsx --conditions=react-server scripts/load/snapshot.ts <out.json>
//
// Order-independent on purpose: the engine run is concurrent, so rows are keyed and sorted, never compared by
// insertion time. Not compared, by design: event publishes, activity origin, timestamps.
import "./env";
import fs from "node:fs";
import { assertLoadDb } from "./env";

export type Snapshot = {
  accounts: Record<string, { balance: string; credit: string; marginCallNotified: boolean; txns: string[] }>;
  positions: Record<string, { status: string; volume: string; closePrice: string | null; realizedPnl: string | null; closedBy: string | null }>;
  queuedOrders: Record<string, string>;
  sideEffects: Record<string, number>;
};

// who closed a position, from its TRADE_PNL note (the same notes both engines write)
function closedBy(note: string | null): string {
  if (!note) return "?";
  if (note.startsWith("Stop loss")) return "stop_loss";
  if (note.startsWith("Take profit")) return "take_profit";
  if (note.startsWith("Stop-out")) return "stop_out";
  if (note.startsWith("Mirror close")) return "mirror";
  if (note.startsWith("Coverage auto-close")) return "coverage_auto";
  return `other:${note.slice(0, 40)}`;
}

export async function takeSnapshot(): Promise<Snapshot> {
  const { prisma } = await import("@/lib/prisma");
  await assertLoadDb(prisma);
  const snap: Snapshot = { accounts: {}, positions: {}, queuedOrders: {}, sideEffects: {} };

  const txns = await prisma.transaction.findMany({ select: { accountId: true, referenceId: true, type: true, amount: true, note: true } });
  const byAccount = new Map<string, string[]>();
  const pnlNote = new Map<string, string | null>();
  for (const t of txns) {
    const list = byAccount.get(t.accountId) ?? [];
    list.push(`${t.referenceId ?? "-"}|${t.type}|${t.amount.toString()}`);
    byAccount.set(t.accountId, list);
    if (t.type === "TRADE_PNL" && t.referenceId) pnlNote.set(t.referenceId, t.note);
  }
  for (const a of await prisma.account.findMany({ orderBy: { id: "asc" }, select: { id: true, balance: true, credit: true, marginCallNotifiedAt: true } })) {
    snap.accounts[a.id] = { balance: a.balance.toString(), credit: a.credit.toString(), marginCallNotified: a.marginCallNotifiedAt != null, txns: (byAccount.get(a.id) ?? []).sort() };
  }
  for (const p of await prisma.position.findMany({ orderBy: { id: "asc" }, select: { id: true, status: true, volume: true, closePrice: true, realizedPnl: true } })) {
    snap.positions[p.id] = {
      status: p.status,
      volume: p.volume.toString(),
      closePrice: p.closePrice?.toString() ?? null,
      realizedPnl: p.realizedPnl?.toString() ?? null,
      closedBy: p.status === "OPEN" ? null : closedBy(pnlNote.get(p.id) ?? null),
    };
  }
  for (const o of await prisma.order.findMany({ where: { closesPositionId: { not: null } }, orderBy: { id: "asc" }, select: { id: true, status: true } })) {
    snap.queuedOrders[o.id] = o.status;
  }
  const effects = await prisma.$queryRaw<{ k: string; n: bigint }[]>`
    SELECT 'notification:' || type || ':' || coalesce("entityId", '-') || ':' || CASE WHEN "accountId" IS NULL THEN 'staff' ELSE 'trader' END AS k, count(*) AS n FROM "Notification" GROUP BY 1
    UNION ALL
    SELECT 'audit:' || action || ':' || coalesce("entityId", '-') AS k, count(*) AS n FROM "AuditLog" GROUP BY 1`;
  for (const e of [...effects].sort((x, y) => (x.k < y.k ? -1 : 1))) snap.sideEffects[e.k] = Number(e.n);
  return snap;
}

if (process.argv[1]?.endsWith("snapshot.ts")) {
  takeSnapshot()
    .then(async (s) => {
      fs.writeFileSync(process.argv[2], JSON.stringify(s, null, 1) + "\n");
      console.log(`[load:snapshot] ${Object.keys(s.accounts).length} accounts, ${Object.keys(s.positions).length} positions -> ${process.argv[2]}`);
      await (await import("@/lib/prisma")).prisma.$disconnect();
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
