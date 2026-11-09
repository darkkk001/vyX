import { NextRequest, NextResponse } from "next/server";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { isPaymentReference } from "@/lib/room/funds";
import { createFundsRequest } from "@/lib/funds-request-create";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withRequestKey, withTwinGuard, twinSince, twinAmount } from "@/lib/room/request-key";

// POST {key, accountId, methodId, amount, reference, receipt?}: a deposit request to the broker (approved in the backoffice).
// The receipt is an image or PDF as a data URL, at most 8 MB.
const MAX_RECEIPT_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 100;
const RECEIPT = /^data:(image\/(png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-deposit:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  // one request per form load (body.key), and never two identical pending deposits within 60 s (lib/room/request-key.ts)
  return withRequestKey(session.clientId, "DEPOSIT", body?.key, async () => {
    const account = await ownAccount(session, body?.accountId);
    if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    if (account.accountMode !== "LIVE") return NextResponse.json({ error: "Demo accounts are not funded." }, { status: 400 });
    if (!isPaymentReference(body?.reference, account.accountNumber)) return NextResponse.json({ error: "Reload the page for a new payment reference." }, { status: 400 });
    let receipt: string | null = null;
    if (body?.receipt != null && body.receipt !== "") {
      if (typeof body.receipt !== "string" || body.receipt.length > MAX_RECEIPT_CHARS || !RECEIPT.test(body.receipt)) {
        return NextResponse.json({ error: "Receipt must be JPG, PNG or PDF, up to 8 MB." }, { status: 400 });
      }
      receipt = body.receipt;
    }
    // the same amount and method from this account within 60 s, even from another form: one request (lib/room/request-key.ts)
    const amount = decimalOrNull(body?.amount);
    const guard = (fn: () => Promise<NextResponse>) =>
      amount && typeof body?.methodId === "string" ? withTwinGuard(session.clientId, "DEPOSIT", [account.id, "DEPOSIT", twinAmount(amount), body.methodId], fn) : fn();
    return guard(async () => {
      // the same payment reference, or the same amount and method still pending from the last 60 s: that request
      const twin = await prisma.transaction.findFirst({
        where: {
          accountId: account.id, type: "DEPOSIT",
          OR: [
            { paymentReference: body.reference },
            ...(amount && typeof body?.methodId === "string"
              ? [{ status: "PENDING" as const, amount, paymentMethodId: body.methodId, createdAt: { gte: twinSince() } }]
              : []),
          ],
        },
        orderBy: { createdAt: "asc" },
        select: { id: true, status: true, paymentReference: true },
      });
      if (twin) return NextResponse.json({ status: twin.status, id: twin.id, reference: twin.paymentReference, duplicate: true }, { status: 200 });

      const r = await createFundsRequest({
        brokerId: session.brokerId, accountId: account.id, type: "DEPOSIT", amount: body?.amount, paymentMethodId: body?.methodId,
        receiptDataUrl: receipt, note: `Ref ${body.reference}`, paymentReference: body.reference,
      });
      if (!r.ok) return NextResponse.json({ error: friendly(r.error) }, { status: r.status });
      await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "DEPOSIT_REQUESTED", entityType: "Transaction", entityId: r.created.id, newValue: { accountNumber: account.accountNumber, amount: r.created.amount, reference: body.reference, receipt: Boolean(receipt), source: "CLIENT" } } });
      return NextResponse.json({ status: r.created.status, id: r.created.id, reference: body.reference }, { status: 201 });
    });
  });
}

function decimalOrNull(v: unknown): Prisma.Decimal | null {
  try { const d = new Prisma.Decimal(String(v ?? "")); return d.gt(0) ? d : null; } catch { return null; }
}

function friendly(e: string): string {
  if (e.startsWith("amount is below")) return `Below this method's minimum (${e.split("of ")[1]}).`;
  if (e.startsWith("amount is above")) return `Above this method's maximum (${e.split("of ")[1]}).`;
  if (e === "invalid amount" || e === "amount must be positive") return "Enter an amount.";
  if (e === "unknown or disabled payment method") return "Pick a payment method.";
  if (e === "account is not active") return "This account is not active.";
  return e;
}
