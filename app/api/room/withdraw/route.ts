import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession, ownAccount } from "@/lib/room/context";
import { withdrawable, payoutDestination } from "@/lib/room/funds";
import { createFundsRequest } from "@/lib/funds-request-create";
import { checkRateLimit } from "@/lib/rate-limit";
import { verifyTotp } from "@/lib/totp";

// POST {accountId, payoutMethodId, amount}: a withdrawal request to one of the client's own saved payout methods.
// KYC approved first (inside createFundsRequest), never more than the withdrawable amount (lib/room/funds.ts).
export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-withdraw:${session.clientId}`, 6, 60);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute." }, { status: 429 });

  const body = await request.json().catch(() => null);
  const account = await ownAccount(session, body?.accountId);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  if (account.accountMode !== "LIVE") return NextResponse.json({ error: "Demo accounts have nothing to withdraw." }, { status: 400 });
  // 2FA on: every withdrawal carries a code from the authenticator app
  const tf = await prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { twoFactorEnabled: true, twoFactorSecret: true } });
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
  if (!method) return NextResponse.json({ error: "Your broker does not pay out to this method right now." }, { status: 400 });

  let amount: Prisma.Decimal;
  try { amount = new Prisma.Decimal(String(body?.amount ?? "")); } catch { return NextResponse.json({ error: "Enter an amount." }, { status: 400 }); }
  if (!amount.gt(0)) return NextResponse.json({ error: "Enter an amount." }, { status: 400 });
  const { available, currency } = await withdrawable(account.id);
  if (amount.gt(available)) return NextResponse.json({ error: `Available for withdrawal: ${Number(available).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}.` }, { status: 400 });

  const r = await createFundsRequest({
    brokerId: session.brokerId, accountId: account.id, type: "WITHDRAWAL", amount: amount.toFixed(2), paymentMethodId: method.id,
    destinationAddress: payoutDestination(payout), payoutMethodId: payout.id,
  });
  if (!r.ok) {
    const msg = r.code ? "Verify your identity before your first withdrawal." : r.error.startsWith("amount is below") ? `Below the minimum (${r.error.split("of ")[1]}).` : r.error.startsWith("amount is above") ? `Above the maximum (${r.error.split("of ")[1]}).` : r.error;
    return NextResponse.json({ error: msg, ...(r.code ? { code: r.code } : {}) }, { status: r.status });
  }
  await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "WITHDRAWAL_REQUESTED", entityType: "Transaction", entityId: r.created.id, newValue: { accountNumber: account.accountNumber, amount: amount.toFixed(2), payoutMethodId: payout.id, status: r.created.status, source: "CLIENT" } } });
  return NextResponse.json({ status: r.created.status, id: r.created.id }, { status: 201 });
}
