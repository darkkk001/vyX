import { NextRequest, NextResponse } from "next/server";
import { isDemoBrokerId } from "@/lib/demo";
import { DEMO_REFUSAL } from "@/lib/demo-policy";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { createFundsRequest } from "@/lib/funds-request-create";

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
  // QoreTrader demo: a second check behind middleware.ts's deny list (no funds, KYC, payment methods or password on the demo)
  if (await isDemoBrokerId(session.brokerId)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });

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
      // Phase 2 batch 8 (issue 109): the broker's approve / reject note, shown to the trader beside their own
      reviewNote: t.reviewNote,
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
  // QoreTrader demo: a second check behind middleware.ts's deny list (no funds, KYC, payment methods or password on the demo)
  if (await isDemoBrokerId(session.brokerId)) return NextResponse.json({ error: DEMO_REFUSAL }, { status: 403 });

  const body = await request.json().catch(() => null);
  const type = body?.type === "WITHDRAWAL" ? "WITHDRAWAL" : body?.type === "DEPOSIT" ? "DEPOSIT" : null;
  if (!type) {
    return NextResponse.json({ error: "type must be DEPOSIT or WITHDRAWAL" }, { status: 400 });
  }

  // the request itself: lib/funds-request-create.ts (shared with the Trader's Room since 2026-11-03, logic unchanged)
  const result = await createFundsRequest({
    brokerId: session.brokerId,
    accountId: session.accountId,
    type,
    amount: body?.amount,
    paymentMethodId: body?.paymentMethodId,
    destinationAddress: body?.destinationAddress,
    receiptDataUrl: body?.receiptDataUrl,
    note: body?.note,
    pspAdapter: body?.pspAdapter,
  });
  if (!result.ok) {
    return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  }
  return NextResponse.json(result.created, { status: 201 });
}
