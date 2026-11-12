import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { withdrawable, payoutDestination } from "@/lib/room/funds";
import { createFundsRequest } from "@/lib/funds-request-create";
import { checkRateLimit } from "@/lib/rate-limit";
import { withRequestKey, withTwinGuard, twinSince, twinAmount } from "@/lib/room/request-key";
import { verifyTotp } from "@/lib/totp";
import { findWallet } from "@/lib/room/wallet";
import { WALLET_KEY } from "@/lib/room/wallet-key";

// POST {key, accountId, payoutMethodId, amount, code?}: a withdrawal request to one of the client's own saved payout methods.
// KYC approved first (inside createFundsRequest), never more than the withdrawable amount (lib/room/funds.ts).
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-withdraw:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  // one request per form load (body.key), and never two identical withdrawals within 60 s (lib/room/request-key.ts)
  return withRequestKey(session.clientId, "WITHDRAWAL", body?.key, async () => {
    // "wallet" = the funding wallet as the page names it before it exists (owner 2026-11-12): nothing to withdraw then
    const wallet = body?.accountId === WALLET_KEY ? await findWallet(session.clientId, session.brokerId) : null;
    if (body?.accountId === WALLET_KEY && !wallet) return NextResponse.json({ error: "Not enough balance on the funding wallet." }, { status: 400 });
    const account = await ownAccount(session, wallet ? wallet.id : body?.accountId);
    if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
    if (account.accountMode !== "LIVE") return NextResponse.json({ error: "Demo accounts have nothing to withdraw." }, { status: 400 });
    // 2FA on: every withdrawal carries a code from the authenticator app. A broker may also require 2FA for withdrawing.
    const [tf, broker] = await Promise.all([
      prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { twoFactorEnabled: true, twoFactorSecret: true } }),
      prisma.broker.findUniqueOrThrow({ where: { id: session.brokerId }, select: { requireWithdrawal2fa: true } }),
    ]);
    if (broker.requireWithdrawal2fa && !(tf.twoFactorEnabled && tf.twoFactorSecret)) {
      return NextResponse.json({ error: "Withdrawals require 2FA. Turn it on in Profile.", code: "TWO_FACTOR_SETUP_REQUIRED" }, { status: 403 });
    }
    if (tf.twoFactorEnabled && tf.twoFactorSecret) {
      const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
      if (!code) return NextResponse.json({ error: "Enter the code from your authenticator app.", code: "TWO_FACTOR_REQUIRED" }, { status: 401 });
      if (!verifyTotp(tf.twoFactorSecret, code)) return NextResponse.json({ error: "Wrong code.", code: "TWO_FACTOR_INVALID" }, { status: 401 });
    }
    const payout = typeof body?.payoutMethodId === "string"
      ? await prisma.clientPayoutMethod.findFirst({ where: { id: body.payoutMethodId, clientId: session.clientId, removedAt: null } })
      : null;
    if (!payout) return NextResponse.json({ error: "Pick a payout method." }, { status: 400 });
    const method = await prisma.paymentMethod.findFirst({ where: { brokerId: session.brokerId, type: payout.type, enabled: true }, select: { id: true } });
    if (!method) return NextResponse.json({ error: "Payouts to this method are not available right now." }, { status: 400 });

    let amount: Prisma.Decimal;
    try { amount = new Prisma.Decimal(String(body?.amount ?? "")); } catch { return NextResponse.json({ error: "Enter an amount." }, { status: 400 }); }
    if (!amount.gt(0)) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });
    const { available, currency } = await withdrawable(account.id);
    if (amount.gt(available)) return NextResponse.json({ error: `Available for withdrawal: ${Number(available).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}.` }, { status: 400 });

    return withTwinGuard(session.clientId, "WITHDRAWAL", [account.id, "WITHDRAWAL", twinAmount(amount), method.id, payout.id], async () => {
      const twin = await prisma.transaction.findFirst({
        where: { accountId: account.id, type: "WITHDRAWAL", status: { in: ["PENDING", "COMPLETED"] }, amount: amount.negated(), paymentMethodId: method.id, payoutMethodId: payout.id, createdAt: { gte: twinSince() } },
        orderBy: { createdAt: "asc" }, select: { id: true, status: true },
      });
      if (twin) return NextResponse.json({ status: twin.status, id: twin.id, duplicate: true }, { status: 200 });
      const r = await createFundsRequest({
        brokerId: session.brokerId, accountId: account.id, type: "WITHDRAWAL", amount: amount.toFixed(2), paymentMethodId: method.id,
        destinationAddress: payoutDestination(payout), payoutMethodId: payout.id,
      });
      if (!r.ok) {
        const msg = r.code ? "Complete KYC before your first withdrawal." : r.error.startsWith("amount is below") ? `Below the minimum (${r.error.split("of ")[1]}).` : r.error.startsWith("amount is above") ? `Above the maximum (${r.error.split("of ")[1]}).` : r.error;
        return NextResponse.json({ error: msg, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
      }
      await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "WITHDRAWAL_REQUESTED", entityType: "Transaction", entityId: r.created.id, newValue: { accountNumber: account.accountNumber, amount: amount.toFixed(2), payoutMethodId: payout.id, status: r.created.status, source: "CLIENT" } } });
      return NextResponse.json({ status: r.created.status, id: r.created.id }, { status: 201 });
    });
  });
}
