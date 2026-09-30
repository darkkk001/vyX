import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { resolveEntityLabels } from "@/lib/entity-labels";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { tradingDayStart } from "@/lib/trading-day";
import { humanizeAction, excludeSuperAdminActor, auditActorKind, auditSource } from "@/lib/audit-labels";

const DAY_MS = 24 * 60 * 60 * 1000;

// Same 8-way parallel Prisma read app/manage/(shell)/dashboard/page.tsx's
// Server Component used to do inline (no client component existed for
// this page at all before) -- exposed as JSON so a new DashboardManager.tsx
// can self-fetch it, matching every other converted Manager page. Decimal
// sums are resolved to plain numbers here (RSC serialization never
// allowed raw Decimal across the boundary either), and audit rows are
// pre-humanized server-side, same convention as /api/manage/audit.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * DAY_MS);
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS);

  const [
    totalClients,
    newClients7d,
    depositsSum,
    activeTrades,
    activeTradeAccounts,
    pendingKyc,
    pendingWithdrawals,
    activity,
    depositsWithdrawals14d,
  ] = await Promise.all([
    prisma.account.count({ where: { brokerId } }),
    prisma.account.count({ where: { brokerId, createdAt: { gte: sevenDaysAgo } } }),
    prisma.transaction.aggregate({
      where: { brokerId, type: "DEPOSIT", status: "COMPLETED", createdAt: { gte: thirtyDaysAgo } },
      _sum: { amount: true },
    }),
    // 2026-09-06 interim demo-exclusion (Section C audit) -- "Active
    // trades" is a business-volume number a broker checks daily; blending
    // in demo/test accounts' positions overstates real trading activity.
    // Scoped narrowly to just this stat pair (same reasoning applies to
    // the Reports Summary stats in .../reports/summary/route.ts) -- the
    // rest of this route (totalClients, deposits, pending KYC/withdrawal
    // queues) is left as-is, since those are either not business-volume
    // numbers or are operational queues staff still need to act on
    // regardless of account mode. Full demo/live separation across every
    // report is deferred to the Phase 2 Reporting v2 module.
    prisma.position.count({ where: { brokerId, status: "OPEN", account: { accountMode: "LIVE" } } }),
    prisma.position.findMany({
      where: { brokerId, status: "OPEN", account: { accountMode: "LIVE" } },
      select: { accountId: true },
      distinct: ["accountId"],
    }),
    // both KYC queues: in-app (KycRecord) + Client Portal (ClientKycRecord)
    Promise.all([
      prisma.kycRecord.count({ where: { status: "PENDING", account: { brokerId } } }),
      prisma.clientKycRecord.count({ where: { status: "PENDING", client: { brokerId } } }),
    ]).then(([a, b]) => a + b),
    prisma.transaction.aggregate({
      where: { brokerId, type: "WITHDRAWAL", status: "PENDING" },
      _sum: { amount: true },
      _count: true,
    }),
    prisma.auditLog.findMany({
      where: { brokerId, ...excludeSuperAdminActor },
      orderBy: { createdAt: "desc" },
      take: 15,
      include: { actorAdmin: { select: { email: true } } },
    }),
    // Dashboard "Net deposits (7d)" trend + "Deposits vs withdrawals" chart
    // (design ref: futurix-dashboard-design.html) both need day-bucketed
    // COMPLETED deposit/withdrawal amounts -- one 14-day-back query so the
    // 7d sum and the prior-7d comparator come from the same read, bucketed
    // in JS below rather than 14 separate day-range queries.
    prisma.transaction.findMany({
      where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] }, status: "COMPLETED", createdAt: { gte: fourteenDaysAgo } },
      select: { type: true, amount: true, createdAt: true },
    }),
  ]);

  const dayKey = (d: Date) => d.toISOString().slice(0, 10);
  const byDay = new Map<string, { deposits: number; withdrawals: number }>();
  for (let i = 6; i >= 0; i -= 1) {
    byDay.set(dayKey(new Date(now.getTime() - i * DAY_MS)), { deposits: 0, withdrawals: 0 });
  }
  let netDeposits7d = 0;
  let netDepositsPrior7d = 0;
  // Audit 2026-09-24 (money): Transaction.amount is already SIGNED (a withdrawal is negative), so the net is the plain
  // sum; negating withdrawals again used to ADD them. Chart buckets carry magnitudes (both bars drawn upward).
  for (const t of depositsWithdrawals14d) {
    const signed = t.amount.toNumber();
    if (t.createdAt >= sevenDaysAgo) {
      netDeposits7d += signed;
      const bucket = byDay.get(dayKey(t.createdAt));
      if (bucket) {
        if (t.type === "DEPOSIT") bucket.deposits += Math.abs(signed);
        else bucket.withdrawals += Math.abs(signed);
      }
    } else {
      netDepositsPrior7d += signed;
    }
  }

  // Broker-book result of trades closed since the trading day started (owner decision: 22:00 UTC rollover). The
  // broker's side of a broker-book trade is the client's result reversed. Live client accounts only: no demo, no
  // voided trades (status CLOSED only), no broker hedge legs (coverage account / COVERAGE groups). Audit 2026-09-24.
  // Batch 4 (owner decision): the charts' own D1 boundary, DST-aware (lib/trading-day.ts); 22:00 UTC only as fallback
  const tradingDay = await tradingDayStart(now);
  const tradingDayStartAt = tradingDay.start;
  const brokerRow = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
  const closedToday = await prisma.position.aggregate({
    where: {
      brokerId,
      status: "CLOSED",
      deletedAt: null,
      bookType: "B_BOOK",
      closedAt: { gte: tradingDayStartAt },
      account: { accountMode: "LIVE", group: { category: { not: "COVERAGE" } } },
      ...(brokerRow.coverageAccountId ? { accountId: { not: brokerRow.coverageAccountId } } : {}),
    },
    _sum: { realizedPnl: true },
    _count: true,
  });
  const brokerBookClosedToday = -(closedToday._sum.realizedPnl?.toNumber() ?? 0);

  const entityLabels = await resolveEntityLabels(brokerId, activity.map((a) => ({ entityType: a.entityType, entityId: a.entityId })));
  const clients = await clientTotals(brokerId, brokerRow.coverageAccountId, { sevenDaysAgo, fourteenDaysAgo, thirtyDaysAgo, tradingDayStartAt });
  return NextResponse.json({
    // Step 2 (owner 2026-09-30): the same figures for real clients only (live accounts, no broker hedge / coverage
    // account, no COVERAGE-category group), with every money figure split by account currency and never summed across
    // currencies. The older top-level fields above keep their shape for backoffice 1.0.55 and older.
    clients,
    totalClients,
    newClients7d,
    depositsSum30d: depositsSum._sum.amount?.toNumber() ?? 0,
    activeTrades,
    activeTradeAccountCount: activeTradeAccounts.length,
    pendingKyc,
    pendingWithdrawalCount: pendingWithdrawals._count,
    // a positive amount of money waiting to go out (withdrawal rows are stored negative)
    pendingWithdrawalSum: Math.abs(pendingWithdrawals._sum.amount?.toNumber() ?? 0),
    brokerBookClosedToday,
    brokerBookClosedTodayCount: closedToday._count,
    tradingDayStart: tradingDayStartAt.toISOString(),
    tradingDaySource: tradingDay.source,
    netDeposits7d,
    netDepositsPrior7d,
    depositsWithdrawalsByDay: [...byDay.entries()].map(([date, v]) => ({ date, deposits: v.deposits, withdrawals: v.withdrawals })),
    activity: activity.map((a) => ({
      id: a.id,
      actionLabel: humanizeAction(a.action),
      actorEmail: a.actorAdmin?.email ?? "system",
      actorKind: auditActorKind(a), // Step 2: STAFF / SYSTEM / CLIENT / DIRECT
      source: auditSource(a.newValue),
      entityId: a.entityId,
      entityType: a.entityType,
      // readable identity (ticket / account number / name) -- never a cuid on a screen
      entityLabel: entityLabels.get(a.entityId ?? "") ?? "",
      createdAtLabel: a.createdAt.toISOString().replace("T", " ").slice(0, 19),
    })),
  });
}

type Windows = { sevenDaysAgo: Date; fourteenDaysAgo: Date; thirtyDaysAgo: Date; tradingDayStartAt: Date };
type MoneyRow = { currency: string; bucket: string; n: bigint; total: Prisma.Decimal | null };

// Step 2: "a client" = a LIVE account that is not the broker's hedge (coverage) account and whose group, if any, is not
// in the COVERAGE category. Demo accounts are left out of every count and sum here.
function clientAccountSql(brokerId: string, coverageAccountId: string | null) {
  return Prisma.sql`a."brokerId" = ${brokerId} AND a."accountMode" = 'LIVE'
    AND (${coverageAccountId}::text IS NULL OR a.id <> ${coverageAccountId})
    AND NOT EXISTS (SELECT 1 FROM "Group" g WHERE g.id = a."groupId" AND g.category = 'COVERAGE')`;
}

async function clientTotals(brokerId: string, coverageAccountId: string | null, w: Windows) {
  const who = clientAccountSql(brokerId, coverageAccountId);
  const [counts] = await prisma.$queryRaw<{ total: bigint; new7d: bigint; activeAccounts: bigint; openPositions: bigint }[]>`
    SELECT COUNT(*)::bigint AS total,
           COUNT(*) FILTER (WHERE a."createdAt" >= ${w.sevenDaysAgo})::bigint AS "new7d",
           COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM "Position" p WHERE p."accountId" = a.id AND p.status = 'OPEN'))::bigint AS "activeAccounts",
           COALESCE(SUM((SELECT COUNT(*) FROM "Position" p WHERE p."accountId" = a.id AND p.status = 'OPEN')), 0)::bigint AS "openPositions"
    FROM "Account" a WHERE ${who}`;
  const money = await prisma.$queryRaw<MoneyRow[]>`
    SELECT a.currency, x.bucket, COUNT(*)::bigint AS n, SUM(x.amount) AS total FROM (
      SELECT t."accountId", t.amount,
        CASE
          WHEN t.status = 'PENDING' AND t.type = 'WITHDRAWAL' THEN 'pendingWithdrawals'
          WHEN t.status = 'COMPLETED' AND t."createdAt" >= ${w.sevenDaysAgo} THEN 'net7d'
          WHEN t.status = 'COMPLETED' AND t."createdAt" >= ${w.fourteenDaysAgo} THEN 'netPrior7d'
          ELSE NULL END AS bucket
      FROM "Transaction" t
      WHERE t."brokerId" = ${brokerId} AND t.type IN ('DEPOSIT', 'WITHDRAWAL')
      UNION ALL
      SELECT t."accountId", t.amount, 'deposits30d' FROM "Transaction" t
      WHERE t."brokerId" = ${brokerId} AND t.type = 'DEPOSIT' AND t.status = 'COMPLETED' AND t."createdAt" >= ${w.thirtyDaysAgo}
      UNION ALL
      SELECT p."accountId", -p."realizedPnl", 'brokerBookClosedToday' FROM "Position" p
      WHERE p."brokerId" = ${brokerId} AND p.status = 'CLOSED' AND p."deletedAt" IS NULL AND p."bookType" = 'B_BOOK'
        AND p."closedAt" >= ${w.tradingDayStartAt} AND p."realizedPnl" IS NOT NULL
    ) x JOIN "Account" a ON a.id = x."accountId"
    WHERE x.bucket IS NOT NULL AND ${who}
    GROUP BY 1, 2`;
  const byCcy = new Map<string, Record<string, { count: number; amount: string }>>();
  for (const r of money) {
    const row = byCcy.get(r.currency) ?? {};
    const total = new Prisma.Decimal(r.total ?? 0);
    // pending withdrawals are money waiting to go out: shown positive (rows are stored negative)
    row[r.bucket] = { count: Number(r.n), amount: (r.bucket === "pendingWithdrawals" ? total.abs() : total).toFixed(2) };
    byCcy.set(r.currency, row);
  }
  const zero = { count: 0, amount: "0.00" };
  return {
    total: Number(counts?.total ?? 0),
    new7d: Number(counts?.new7d ?? 0),
    activeAccounts: Number(counts?.activeAccounts ?? 0),
    openPositions: Number(counts?.openPositions ?? 0),
    excludes: "demo accounts, the broker hedge account and COVERAGE groups",
    byCurrency: [...byCcy.entries()]
      .sort(([x], [y]) => x.localeCompare(y))
      .map(([currency, r]) => ({
        currency,
        deposits30d: r.deposits30d ?? zero,
        net7d: r.net7d ?? zero,
        netPrior7d: r.netPrior7d ?? zero,
        pendingWithdrawals: r.pendingWithdrawals ?? zero,
        brokerBookClosedToday: r.brokerBookClosedToday ?? zero,
      })),
  };
}
