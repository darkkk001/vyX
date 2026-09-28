import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { withConfigEvent } from "@/lib/config-events";

// Phase 2 batch 8 (issues 187 / 293, owner decisions 2026-09-27 + 2026-09-28): the broker's dealer-coverage account --
// Broker.coverageAccountId, what BOOK NOW and auto-hedge book the hedge legs on -- is set HERE, on the server. The
// backoffice's old SET wrote only a local file the server never read. BROKER_ADMIN only, audited.
//   GET -> the current coverage account and the accounts that may become it (ACTIVE, in the broker's COVERAGE group).
//   PUT {accountId} -> switch. Refused while the current coverage account has open positions: its hedge legs would be
//        orphaned (the client closes they follow look for them on the coverage account of record).
async function requireBrokerAdmin() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) return null;
  return session!;
}

async function state(brokerId: string) {
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
  const candidates = await prisma.account.findMany({
    where: { brokerId, status: "ACTIVE", group: { category: "COVERAGE" } },
    select: { id: true, accountNumber: true, fullName: true, balance: true, _count: { select: { positions: { where: { status: "OPEN" } } } } },
    orderBy: { accountNumber: "asc" },
  });
  const current = broker.coverageAccountId
    ? await prisma.account.findUnique({ where: { id: broker.coverageAccountId }, select: { id: true, accountNumber: true, _count: { select: { positions: { where: { status: "OPEN" } } } } } })
    : null;
  return {
    coverageAccountId: current?.id ?? null,
    coverageAccountNumber: current?.accountNumber ?? null,
    openLegs: current?._count.positions ?? 0,
    candidates: candidates.map((c) => ({ id: c.id, accountNumber: c.accountNumber, fullName: c.fullName, balance: c.balance.toString(), openPositions: c._count.positions })),
  };
}

export async function GET() {
  const session = await requireBrokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden: the coverage account is set by a broker admin" }, { status: 403 });
  return NextResponse.json(await state(session.brokerId!));
}

async function putHandler(request: NextRequest) {
  const session = await requireBrokerAdmin();
  if (!session) return NextResponse.json({ error: "forbidden: the coverage account is set by a broker admin" }, { status: 403 });
  const brokerId = session.brokerId!;
  const body = await request.json().catch(() => null);
  const accountId = typeof body?.accountId === "string" ? body.accountId.trim() : "";
  if (!accountId) return NextResponse.json({ error: "accountId is required" }, { status: 400 });

  const target = await prisma.account.findFirst({ where: { id: accountId, brokerId }, select: { id: true, accountNumber: true, status: true, group: { select: { category: true } } } });
  if (!target) return NextResponse.json({ error: "account not found" }, { status: 404 });
  if (target.group?.category !== "COVERAGE") {
    return NextResponse.json({ error: `account ${target.accountNumber} is not in the COVERAGE group; only a coverage-group account can hold the hedge legs` }, { status: 400 });
  }
  if (target.status !== "ACTIVE") return NextResponse.json({ error: `account ${target.accountNumber} is not active` }, { status: 400 });

  const result = await prisma.$transaction(async (tx) => {
    const broker = await tx.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { coverageAccountId: true } });
    if (broker.coverageAccountId === target.id) return { unchanged: true as const };
    if (broker.coverageAccountId) {
      const open = await tx.position.count({ where: { accountId: broker.coverageAccountId, status: "OPEN" } });
      if (open > 0) return { openLegs: open };
    }
    // compare-and-set on the pointer: a BOOK NOW provisioning one at the same moment wins, and this reports it
    const swapped = await tx.broker.updateMany({ where: { id: brokerId, coverageAccountId: broker.coverageAccountId }, data: { coverageAccountId: target.id } });
    if (swapped.count === 0) return { raced: true as const };
    await tx.auditLog.create({
      data: {
        brokerId,
        actorAdminId: session.adminId,
        action: "COVERAGE_ACCOUNT_SET",
        entityType: "Broker",
        entityId: brokerId,
        oldValue: { coverageAccountId: broker.coverageAccountId },
        newValue: { coverageAccountId: target.id, accountNumber: target.accountNumber },
      },
    });
    return { set: true as const };
  });

  if ("openLegs" in result) {
    return NextResponse.json(
      { error: `the current coverage account still has ${result.openLegs} open hedge leg(s); close them before switching, or they would be orphaned`, code: "COVERAGE_HAS_OPEN_LEGS" },
      { status: 409 }
    );
  }
  if ("raced" in result) return NextResponse.json({ error: "the coverage account changed meanwhile; reload and try again" }, { status: 409 });
  return NextResponse.json(await state(brokerId));
}

export const PUT = withConfigEvent("dealing", putHandler);
