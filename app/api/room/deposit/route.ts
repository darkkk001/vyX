import { NextRequest, NextResponse } from "next/server";
import { receiptBytesMatch } from "@/lib/kyc-upload";
import { ipAllowed } from "@/lib/room/limits";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { isPaymentReference } from "@/lib/room/funds";
import { createFundsRequest } from "@/lib/funds-request-create";
import { checkRateLimit } from "@/lib/rate-limit";
import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { withRequestKey, withTwinGuard, withClientLock, twinSince, twinAmount } from "@/lib/room/request-key";
import { depositCooldowns, depositView, pendingDeposit } from "@/lib/room/deposit-status";
import { countdown } from "@/components/room/money-input";
import { ensureWallet, WalletUnavailable } from "@/lib/room/wallet";
import { WALLET_KEY, NEW_WALLET_NUMBER } from "@/lib/room/wallet-key";

// POST {key, accountId, methodId, amount, reference, receipt?}: a deposit request to the broker (approved in the backoffice).
// The receipt is an image or PDF as a data URL, at most 8 MB. After a request, the same client sends no other deposit with
// the same method for 5 minutes (lib/room/deposit-status.ts), checked under a per-client lock so parallel sends see it.
// GET ?id=<request>: that request's state for the confirmation card. GET: the pending one to show again, and the
// per-method countdowns.
const MAX_RECEIPT_CHARS = Math.ceil((8 * 1024 * 1024 * 4) / 3) + 100;
const RECEIPT = /^data:(image\/(png|jpeg|jpg|webp)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const allowed = (await checkRateLimit(`room-deposit:${session.clientId}`, 6, 60)).allowed && (await ipAllowed(request.headers, session.brokerId, "room-deposit", 20, 60));
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  // one request per form load (body.key), and never two identical pending deposits within 60 s (lib/room/request-key.ts)
  return withRequestKey(session.clientId, "DEPOSIT", body?.key, async () => {
    // "wallet" = the funding wallet, created by this first deposit request if the client has none yet (owner 2026-11-12)
    const toWallet = body?.accountId === WALLET_KEY;
    let account = toWallet ? null : await ownAccount(session, body?.accountId);
    if (!toWallet && !account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    if (account && account.accountMode !== "LIVE") return NextResponse.json({ error: "Demo accounts are not funded." }, { status: 400 });
    // identity first (owner 2026-11-12): a client sends a deposit request only once KYC is approved. Staff deposits from
    // the backoffice do not come through here and are never held by it.
    const kyc = await prisma.clientKycRecord.findUnique({ where: { clientId: session.clientId }, select: { status: true } });
    if (kyc?.status !== "APPROVED") return NextResponse.json({ error: "Verify your identity to deposit.", code: "KYC_REQUIRED" }, { status: 403 });
    if (toWallet) {
      try {
        account = await ownAccount(session, (await ensureWallet(session.clientId, session.brokerId)).id);
      } catch (e) {
        if (e instanceof WalletUnavailable) return NextResponse.json({ error: e.message }, { status: 409 });
        throw e;
      }
      if (!account) return NextResponse.json({ error: "The wallet is not available right now." }, { status: 409 });
    }
    if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    const refOk = isPaymentReference(body?.reference, account.accountNumber) || (toWallet && isPaymentReference(body?.reference, NEW_WALLET_NUMBER));
    if (!refOk) return NextResponse.json({ error: "Reload the page for a new payment reference." }, { status: 400 });
    let receipt: string | null = null;
    if (body?.receipt != null && body.receipt !== "") {
      if (typeof body.receipt !== "string" || body.receipt.length > MAX_RECEIPT_CHARS || !RECEIPT.test(body.receipt) || !receiptBytesMatch(body.receipt)) {
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

      if (typeof body?.methodId !== "string") return NextResponse.json({ error: "Pick a payment method." }, { status: 400 });
      return withClientLock(session.clientId, `deposit:${body.methodId}`, async () => {
        const until = (await depositCooldowns(session.clientId))[body.methodId];
        if (until && new Date(until).getTime() > Date.now()) {
          return NextResponse.json({ error: `Next request with this method in ${countdown(until)}.`, code: "DEPOSIT_COOLDOWN", until }, { status: 429 });
        }
        const r = await createFundsRequest({
          brokerId: session.brokerId, accountId: account.id, type: "DEPOSIT", amount: body?.amount, paymentMethodId: body?.methodId,
          receiptDataUrl: receipt, note: `Ref ${body.reference}`, paymentReference: body.reference,
        });
        if (!r.ok) return NextResponse.json({ error: friendly(r.error) }, { status: r.status });
        await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "DEPOSIT_REQUESTED", entityType: "Transaction", entityId: r.created.id, newValue: { accountNumber: account.accountNumber, amount: r.created.amount, reference: body.reference, receipt: Boolean(receipt), source: "CLIENT" } } });
        return NextResponse.json({ status: r.created.status, id: r.created.id, reference: body.reference }, { status: 201 });
      });
    });
  });
}

export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const id = request.nextUrl.searchParams.get("id");
  if (id) {
    const v = await depositView(session.clientId, id);
    return v ? NextResponse.json(v) : NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  const [pending, cooldowns] = await Promise.all([pendingDeposit(session.clientId), depositCooldowns(session.clientId)]);
  return NextResponse.json({ pending, cooldowns, now: new Date().toISOString() });
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
