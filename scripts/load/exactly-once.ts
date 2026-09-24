// Stage 4.6 gate -- exactly-once checker on the engine load database after a run (scripts/load/run.sh calls it).
//
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_load_engine DIRECT_URL=<same> \
//   npx tsx --conditions=react-server scripts/load/exactly-once.ts
//
// Fails (exit 1) on any of:
// - a PostCloseEffect row not DONE (PENDING left behind, or DEAD);
// - a step listed twice in one row's doneSteps;
// - two outbox rows for one close (same position + TRADE_PNL) -- the dedupe key;
// - a position with more than one TRADE_PNL (a double close);
// - a (notification type, entity, audience) or (audit action, entity) written more often than the web could.
//   Counts against the web are compared by scripts/load/diff.mjs; here only what exactly-once alone forbids.
import "./env";
import { assertLoadDb } from "./env";

async function main() {
  const { prisma } = await import("@/lib/prisma");
  await assertLoadDb(prisma);
  const problems: string[] = [];

  const byStatus = await prisma.$queryRaw<{ status: string; n: bigint }[]>`SELECT status, count(*) AS n FROM "PostCloseEffect" GROUP BY status`;
  for (const r of byStatus) if (r.status !== "DONE") problems.push(`${r.n} PostCloseEffect row(s) ${r.status}`);

  const dupSteps = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "PostCloseEffect" WHERE cardinality("doneSteps") <> (SELECT count(DISTINCT s) FROM unnest("doneSteps") s)`;
  if (dupSteps.length) problems.push(`${dupSteps.length} row(s) list a step twice, e.g. ${dupSteps[0].id}`);

  const dupRows = await prisma.$queryRaw<{ positionId: string; n: bigint }[]>`
    SELECT "positionId", count(*) AS n FROM "PostCloseEffect" WHERE kind = 'POSITION_CLOSED' GROUP BY "positionId" HAVING count(*) > 1`;
  if (dupRows.length) problems.push(`${dupRows.length} position(s) with more than one follow-up row, e.g. ${dupRows[0].positionId}`);

  const doubleClose = await prisma.$queryRaw<{ referenceId: string; n: bigint }[]>`
    SELECT "referenceId", count(*) AS n FROM "Transaction" WHERE type = 'TRADE_PNL' GROUP BY "referenceId" HAVING count(*) > 1`;
  if (doubleClose.length) problems.push(`${doubleClose.length} position(s) with more than one TRADE_PNL, e.g. ${doubleClose[0].referenceId}`);

  // a follow-up's own notices / audits are written once per close: STOP_OUT per stopped-out position, MIRROR_CLOSED per
  // target, COVERAGE_* per leg or client, DEALING_CLOSE_SUPERSEDED per queued order
  const once = await prisma.$queryRaw<{ k: string; n: bigint }[]>`
    SELECT 'notification:' || type || ':' || "entityId" || ':' || CASE WHEN "accountId" IS NULL THEN 'staff' ELSE 'trader' END AS k, count(*) AS n
      FROM "Notification" WHERE type IN ('STOP_OUT', 'COVERAGE_STOP_OUT', 'COVERAGE_RELEASED', 'COVERAGE_CLOSE_FAILED', 'COVERAGE_CLOSE_AWAITING_DEALER', 'OUTBOX_DEAD')
      GROUP BY 1 HAVING count(*) > 1
    UNION ALL
    SELECT 'audit:' || action || ':' || "entityId" AS k, count(*) AS n
      FROM "AuditLog" WHERE action IN ('MIRROR_CLOSED', 'POSITION_COVERAGE_AUTO_CLOSED', 'POSITION_COVERAGE_RELEASED', 'DEALING_CLOSE_SUPERSEDED')
      GROUP BY 1 HAVING count(*) > 1`;
  for (const r of once) problems.push(`${r.k} written ${r.n} times`);

  const [{ rows }] = await prisma.$queryRaw<{ rows: bigint }[]>`SELECT count(*) AS rows FROM "PostCloseEffect"`;
  if (problems.length) {
    console.log(`[load:exactly-once] FAIL (${rows} outbox rows):\n  ${problems.join("\n  ")}`);
    process.exitCode = 1;
  } else {
    console.log(`[load:exactly-once] OK: ${rows} outbox rows all DONE, no step twice, one row per close, no double close, no duplicate follow-up notice / audit`);
  }
  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
