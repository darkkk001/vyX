import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission } from "@/lib/permissions";
import { publishTradingEvent } from "@/lib/nats";
import { createNotification } from "@/lib/notifications";
import { publishFundsRequestChanged, notifyFundsRequestResolved } from "@/lib/funds-events";
import { withdrawalKycApproved } from "@/lib/withdrawal-kyc";
import { loadAccountMarginState } from "@/lib/margin";
import {
  parseStaffFundsBody,
  recordStaffFunds,
  StaffFundsError,
  MANUAL_METHOD_ID,
  MANUAL_METHOD_NAME,
  PAYMENT_METHOD_LABELS,
} from "@/lib/staff-funds";

// DEP item (owner 2026-10-05): staff record a deposit or withdrawal on this account. Contract and rules:
// docs/contracts/staff-funds.md and lib/staff-funds.ts. FUNDS_APPROVAL: BROKER_ADMIN, or a MANAGER holding it.
// SUPPORT (read-only role) is refused; another broker's account is a 404.

const fail = (code: string, error: string, status: number) => NextResponse.json({ error, code }, { status });

async function gate(id: string) {
  const session = await getAdminSession();
  if (!session || session.role === "SUPPORT" || (await forbidUnlessBrokerAdminOrPermission(session, "FUNDS_APPROVAL"))) {
    return { ok: false as const, res: fail("FORBIDDEN", "forbidden", 403) };
  }
  const account = await prisma.account.findUnique({
    where: { id },
    select: { id: true, brokerId: true, accountNumber: true, fullName: true, currency: true, balance: true, status: true, leverage: true, group: { select: { marginCallLevel: true } } },
  });
  if (!account || account.brokerId !== session.brokerId) return { ok: false as const, res: fail("NOT_FOUND", "account not found", 404) };
  return { ok: true as const, session, account };
}

// What the Deposit... / Withdraw... forms need: methods (MANUAL first), KYC, balance and margin, and whether the
// caller's entry completes at once or waits for a second admin.
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const g = await gate(id);
  if (!g.ok) return g.res;
  const { session, account } = g;

  const [methods, broker, kycApproved, margin] = await Promise.all([
    prisma.paymentMethod.findMany({ where: { brokerId: account.brokerId, enabled: true }, orderBy: { type: "asc" } }),
    prisma.broker.findUniqueOrThrow({ where: { id: account.brokerId }, select: { withdrawalApproval: true } }),
    withdrawalKycApproved(prisma, account.id),
    loadAccountMarginState(prisma, account.id, account.leverage, [], account.brokerId),
  ]);
  const isAdmin = session!.role === "BROKER_ADMIN";
  const used = margin?.usedMargin ?? null;
  return NextResponse.json({
    accountId: account.id,
    accountNumber: account.accountNumber,
    accountFullName: account.fullName,
    currency: account.currency,
    status: account.status,
    balance: account.balance.toFixed(2),
    // null when an open position cannot be valued right now; margin level is null with no open positions (never 0)
    equity: margin ? margin.equity.toFixed(2) : null,
    usedMargin: used ? used.toFixed(2) : null,
    freeMargin: margin ? margin.equity.sub(margin.usedMargin).toFixed(2) : null,
    marginLevel: margin && used && !used.isZero() ? margin.equity.div(used).mul(100).toFixed(2) : null,
    marginCallLevel: (account.group?.marginCallLevel ?? null)?.toFixed(2) ?? "100.00",
    openPositions: margin?.openPositions ?? null,
    kycApproved,
    withdrawalApproval: broker.withdrawalApproval,
    depositCompletesAtOnce: isAdmin,
    withdrawalCompletesAtOnce: isAdmin && broker.withdrawalApproval === "SINGLE",
    paymentMethods: [
      { id: MANUAL_METHOD_ID, name: MANUAL_METHOD_NAME, type: null, minAmount: null, maxAmount: null },
      ...methods.map((m) => ({
        id: m.id,
        name: PAYMENT_METHOD_LABELS[m.type] ?? m.type,
        type: m.type,
        minAmount: m.minAmount.toFixed(2),
        maxAmount: m.maxAmount ? m.maxAmount.toFixed(2) : null,
      })),
    ],
  });
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<NextResponse> {
  const { id } = await params;
  const g = await gate(id);
  if (!g.ok) return g.res;
  const { session, account } = g;

  const body = await request.json().catch(() => null);
  try {
    const input = parseStaffFundsBody(body);
    const out = await recordStaffFunds(prisma, { adminId: session!.adminId, role: session!.role === "BROKER_ADMIN" ? "BROKER_ADMIN" : "MANAGER", brokerId: account.brokerId }, account.id, input);

    if (!out.replayed) {
      const brokerId = account.brokerId;
      if (out.status === "COMPLETED") {
        await publishTradingEvent("BalanceChanged", { account_id: account.id, broker_id: brokerId, transaction_id: out.transactionId }).catch((err) =>
          console.error("[staff-funds] BalanceChanged publish failed", err)
        );
        await publishFundsRequestChanged({ brokerId, accountId: account.id, transactionId: out.transactionId, change: "approved" });
        await notifyFundsRequestResolved({ brokerId, accountId: account.id, transactionId: out.transactionId, kind: input.type, outcome: "APPROVED", amount: input.amount.toFixed(2), reviewNote: null });
      } else if (out.status === "PENDING") {
        await createNotification(prisma, {
          brokerId,
          type: "FUNDS_REQUEST",
          title: `New ${input.type.toLowerCase()} recorded by staff`,
          body: `${account.accountNumber}: ${input.amount.toFixed(2)} ${account.currency} (${input.note}), waiting for another admin`,
          entityType: "Transaction",
          entityId: out.transactionId,
        }).catch((err) => console.error("[staff-funds] staff notification failed", err));
        await publishFundsRequestChanged({ brokerId, accountId: account.id, transactionId: out.transactionId, change: out.step === "APPROVED_BY_FIRST_ADMIN" ? "marked" : "created" });
      }
    }

    const { replayed: _replayed, ...payload } = out;
    void _replayed;
    return NextResponse.json(payload, { status: out.status === "PENDING" ? 202 : 200 });
  } catch (err) {
    if (err instanceof StaffFundsError) return fail(err.code, err.message, err.status);
    throw err;
  }
}
