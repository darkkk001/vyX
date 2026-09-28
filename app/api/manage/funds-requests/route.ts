import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessPermissionOrSupportReader } from "@/lib/permissions";

// BROKER_ADMIN by default -- same finance carve-out as balance
// adjustment/leverage edits (AdminRole.MANAGER's own schema comment: "not
// KYC/finance") -- delegatable via FUNDS_APPROVAL (see
// lib/permissions.ts). Lists PENDING requests first (what needs action),
// then recent resolved ones for context.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessPermissionOrSupportReader(session, "FUNDS_APPROVAL") /* SUPPORT reads (view only) */) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const requests = await prisma.transaction.findMany({
    where: { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] } },
    include: {
      // issue 132: whether a withdrawal could be paid (the account's own KYC, or its portal client's)
      account: { select: { accountNumber: true, fullName: true, balance: true, kycRecord: { select: { status: true } }, client: { select: { kycRecord: { select: { status: true } } } } } },
      markedByAdmin: { select: { email: true } },
    },
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 200,
  });

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: session!.brokerId! }, select: { withdrawalApproval: true } });
  const kpis = await fundsKpis(brokerId);
  return NextResponse.json({
    currentAdminId: session!.adminId,
    // D5: SINGLE = a BROKER_ADMIN's APPROVE completes a withdrawal at once; DUAL = mark + a second admin confirms
    withdrawalApproval: broker.withdrawalApproval,
    kpis,
    rows: requests.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      amount: t.amount.toString(),
      note: t.note,
      reviewNote: t.reviewNote, // issue 109: the reviewing admin's note, separate from the trader's
      kycApproved: t.account.kycRecord?.status === "APPROVED" || t.account.client?.kycRecord?.status === "APPROVED",
      accountId: t.accountId,
      accountNumber: t.account.accountNumber,
      accountFullName: t.account.fullName,
      currentBalance: t.account.balance.toString(),
      markedByAdminId: t.markedByAdminId,
      markedByAdminEmail: t.markedByAdmin?.email ?? null,
      createdAt: t.createdAt.toISOString(),
    })),
  });
}

// Phase 2 batch 8 (issue 110): the deposits screen's tiles, computed over ALL of the broker's requests (they came from
// the latest 200 rows before). Amounts are money moved: a withdrawal is stored negative, reported positive. The 30-day
// window is on the request's createdAt, as the screen always counted.
async function fundsKpis(brokerId: string) {
  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const base = { brokerId, type: { in: ["DEPOSIT", "WITHDRAWAL"] as ("DEPOSIT" | "WITHDRAWAL")[] } };
  const [pending, marked, done30, rejected] = await Promise.all([
    prisma.transaction.groupBy({ by: ["type"], where: { ...base, status: "PENDING" }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.transaction.count({ where: { brokerId, type: "WITHDRAWAL", status: "PENDING", markedByAdminId: { not: null } } }),
    prisma.transaction.groupBy({ by: ["type"], where: { ...base, status: "COMPLETED", createdAt: { gte: since30 } }, _count: { _all: true }, _sum: { amount: true } }),
    prisma.transaction.count({ where: { ...base, status: "REJECTED" } }),
  ]);
  const pick = (rows: typeof pending, type: "DEPOSIT" | "WITHDRAWAL") => {
    const r = rows.find((x) => x.type === type);
    return { count: r?._count._all ?? 0, amount: (r?._sum.amount ?? new Prisma.Decimal(0)).abs().toFixed(2) };
  };
  const dep30 = pick(done30, "DEPOSIT");
  return {
    pendingDeposits: pick(pending, "DEPOSIT"),
    pendingWithdrawals: pick(pending, "WITHDRAWAL"),
    markedWithdrawals: marked,
    deposits30d: dep30,
    withdrawals30d: pick(done30, "WITHDRAWAL"),
    avgDeposit30d: dep30.count > 0 ? new Prisma.Decimal(dep30.amount).div(dep30.count).toFixed(2) : null,
    rejectedAllTime: rejected,
  };
}
