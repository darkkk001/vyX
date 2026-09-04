import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createNotification } from "@/lib/notifications";
import { resolvePspAdapter } from "@/lib/psp/adapter";

// Deposit/withdrawal requests -- see components/webtrader/WebTrader.tsx's
// funds modal, previously stubbed with a "not yet available" toast.
// Creates a PENDING Transaction; balance never changes here, only on
// admin review (app/api/manage/funds-requests/[id]/route.ts) -- see that
// file's doc comment for the full state-machine reasoning. Now routes
// through a real broker-configured PaymentMethod and a PspAdapter
// (lib/psp/adapter.ts) instead of ignoring method entirely -- see that
// file's own header comment for what an adapter is and isn't responsible
// for (request-time reference/status only, never balance).
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  // ADJUSTMENT included alongside the trader's own DEPOSIT/WITHDRAWAL
  // requests -- a staff-initiated balance adjustment (Manager backoffice's
  // "Adjust Balance" on an account, app/api/manage/accounts/[id]/adjust-
  // balance) changes this same balance but previously showed up nowhere
  // in the trader's own UI (not here, since it isn't a DEPOSIT/WITHDRAWAL
  // type, and not the trade-history tab either, which only lists closed
  // positions) -- reported live as "my withdrawal isn't showing up
  // anywhere," even though the balance change itself was correct.
  const requests = await prisma.transaction.findMany({
    where: { accountId: session.accountId, type: { in: ["DEPOSIT", "WITHDRAWAL", "ADJUSTMENT"] } },
    include: { paymentMethod: { select: { type: true } } },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json(
    requests.map((t) => ({
      id: t.id,
      type: t.type,
      status: t.status,
      amount: t.amount.toString(),
      note: t.note,
      createdAt: t.createdAt.toISOString(),
      paymentMethodType: t.paymentMethod?.type ?? null,
      pspStatus: t.pspStatus,
      pspReference: t.pspReference,
      confirmations: t.confirmations,
      destinationAddress: t.destinationAddress,
    }))
  );
}

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const type = body?.type === "WITHDRAWAL" ? "WITHDRAWAL" : body?.type === "DEPOSIT" ? "DEPOSIT" : null;
  if (!type) {
    return NextResponse.json({ error: "type must be DEPOSIT or WITHDRAWAL" }, { status: 400 });
  }

  let requestedAmount: Prisma.Decimal;
  try {
    requestedAmount = new Prisma.Decimal(String(body?.amount ?? ""));
  } catch {
    return NextResponse.json({ error: "invalid amount" }, { status: 400 });
  }
  if (!requestedAmount.gt(0)) {
    return NextResponse.json({ error: "amount must be positive" }, { status: 400 });
  }

  const account = await prisma.account.findUniqueOrThrow({ where: { id: session.accountId } });
  if (account.status !== "ACTIVE") {
    return NextResponse.json({ error: "account is not active" }, { status: 400 });
  }

  const paymentMethodId = typeof body?.paymentMethodId === "string" ? body.paymentMethodId : null;
  if (!paymentMethodId) {
    return NextResponse.json({ error: "paymentMethodId is required" }, { status: 400 });
  }
  const paymentMethod = await prisma.paymentMethod.findUnique({ where: { id: paymentMethodId } });
  if (!paymentMethod || paymentMethod.brokerId !== session.brokerId || !paymentMethod.enabled) {
    return NextResponse.json({ error: "unknown or disabled payment method" }, { status: 400 });
  }
  if (requestedAmount.lt(paymentMethod.minAmount)) {
    return NextResponse.json({ error: `amount is below this method's minimum of ${paymentMethod.minAmount.toString()}` }, { status: 400 });
  }
  if (paymentMethod.maxAmount && requestedAmount.gt(paymentMethod.maxAmount)) {
    return NextResponse.json({ error: `amount is above this method's maximum of ${paymentMethod.maxAmount.toString()}` }, { status: 400 });
  }

  // Crypto methods need a destination address on a withdrawal (where to
  // send it) -- BANK_TRANSFER's "address" is free-text bank details,
  // same field, same reasoning as Transaction.destinationAddress's own
  // schema comment. Not required on a deposit: the trader is sending TO
  // the broker's own walletAddress (paymentMethod.walletAddress), not
  // specifying a destination.
  const destinationAddress = typeof body?.destinationAddress === "string" ? body.destinationAddress.trim().slice(0, 500) : null;
  if (type === "WITHDRAWAL" && !destinationAddress) {
    return NextResponse.json({ error: "destinationAddress is required for a withdrawal" }, { status: 400 });
  }

  const receiptDataUrl = typeof body?.receiptDataUrl === "string" && body.receiptDataUrl.startsWith("data:") ? body.receiptDataUrl : null;

  // Signed amount, matching Transaction.amount's own doc comment
  // ("negative = debit") -- a withdrawal reduces balance once approved.
  const amount = type === "WITHDRAWAL" ? requestedAmount.negated() : requestedAmount;

  // Basic sanity guard, not a funds-hold/reservation system: can't
  // request to withdraw more than the balance right now. Approval
  // re-checks this against whatever the balance is AT approval time,
  // since trading activity between request and review can change it.
  if (type === "WITHDRAWAL" && requestedAmount.gt(account.balance)) {
    return NextResponse.json({ error: "withdrawal amount exceeds available balance" }, { status: 400 });
  }

  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) : null;

  // pspAdapter is only ever honored off the request body outside
  // production -- see resolvePspAdapter's own comment. A real trader
  // never sends this; it exists so a Playwright/dev test can pass
  // "MOCK" and get an instantly-CREDITED/PAID status timeline without
  // needing to click through backoffice review.
  const adapter = resolvePspAdapter(body?.pspAdapter);
  const pspResult =
    type === "DEPOSIT"
      ? adapter.requestDeposit({ amount: requestedAmount, methodType: paymentMethod.type })
      : adapter.requestWithdrawal({ amount: requestedAmount, methodType: paymentMethod.type, destinationAddress: destinationAddress! });

  const created = await prisma.transaction.create({
    data: {
      brokerId: session.brokerId,
      accountId: session.accountId,
      type,
      status: "PENDING",
      amount,
      // Nothing has changed yet -- both reflect the current balance
      // until an admin approves or rejects this request.
      balanceBefore: account.balance,
      balanceAfter: account.balance,
      note,
      paymentMethodId: paymentMethod.id,
      pspAdapter: adapter.kind,
      pspStatus: pspResult.pspStatus,
      pspReference: pspResult.pspReference,
      confirmations: "confirmations" in pspResult ? pspResult.confirmations : null,
      destinationAddress,
      receiptDataUrl,
    },
  });

  await createNotification(prisma, {
    brokerId: session.brokerId,
    type: "FUNDS_REQUEST",
    title: `New ${type.toLowerCase()} request`,
    body: `${account.accountNumber} requested ${requestedAmount.toString()}${note ? ` (${note})` : ""}`,
    entityType: "Transaction",
    entityId: created.id,
  });

  return NextResponse.json(
    {
      id: created.id,
      type: created.type,
      status: created.status,
      amount: created.amount.toString(),
      pspStatus: created.pspStatus,
      pspReference: created.pspReference,
    },
    { status: 201 }
  );
}
