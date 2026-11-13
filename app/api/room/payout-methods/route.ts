import { NextRequest, NextResponse } from "next/server";
import { checkClientCode, CODE_LOCKED_MESSAGE } from "@/lib/room/limits";
import type { PaymentMethodType } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { payoutMethods } from "@/lib/room/funds";
import { checkRateLimit } from "@/lib/rate-limit";

// Saved payout methods (own name only). POST {type, bank?, account?, swift?, address?} adds one; DELETE ?id= removes
// one (kept as history: removedAt). A bank account is always in the client's own name (the holder is the client's
// name, not typed); the broker checks each method before marking it verified.
const TYPES: PaymentMethodType[] = ["BANK_TRANSFER", "USDT_TRC20", "USDT_BEP20", "BTC", "ETH"];
const WALLET: Record<string, RegExp> = {
  USDT_TRC20: /^T[1-9A-HJ-NP-Za-km-z]{33}$/,
  USDT_BEP20: /^0x[0-9a-fA-F]{40}$/,
  ETH: /^0x[0-9a-fA-F]{40}$/,
  BTC: /^(bc1[0-9a-z]{25,62}|[13][1-9A-HJ-NP-Za-km-z]{25,34})$/,
};

export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  return NextResponse.json({ payoutMethods: await payoutMethods(ctx.session.clientId) });
}

export async function POST(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-payout-add:${session.clientId}`, 10, 300);
  if (!allowed) return NextResponse.json({ error: "Too many attempts. Try again later." }, { status: 429 });
  const body = await request.json().catch(() => null);
  const type = TYPES.find((t) => t === body?.type);
  if (!type) return NextResponse.json({ error: "Pick a method." }, { status: 400 });
  const open = await prisma.paymentMethod.findFirst({ where: { brokerId: session.brokerId, type, enabled: true }, select: { id: true } });
  if (!open) return NextResponse.json({ error: "Payouts to this method are not available right now." }, { status: 400 });
  const client = await prisma.client.findUniqueOrThrow({ where: { id: session.clientId }, select: { fullName: true, twoFactorEnabled: true, twoFactorSecret: true } });
  const count = await prisma.clientPayoutMethod.count({ where: { clientId: session.clientId, removedAt: null } });
  if (count >= 10) return NextResponse.json({ error: "Remove a method first (10 at most)." }, { status: 409 });

  let details: Record<string, string>;
  if (type === "BANK_TRANSFER") {
    const bank = String(body?.bank ?? "").trim().slice(0, 80);
    const account = String(body?.account ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 40);
    const swift = String(body?.swift ?? "").replace(/\s+/g, "").toUpperCase().slice(0, 11);
    if (!bank || account.length < 6) return NextResponse.json({ error: "Enter the bank and the account number or IBAN." }, { status: 400 });
    if (swift && !/^[A-Z]{6}[A-Z0-9]{2}([A-Z0-9]{3})?$/.test(swift)) return NextResponse.json({ error: "SWIFT code is 8 or 11 characters." }, { status: 400 });
    details = { bank, account, ...(swift ? { swift } : {}) };
  } else {
    const address = String(body?.address ?? "").trim();
    if (!WALLET[type].test(address)) return NextResponse.json({ error: "That wallet address is not valid for this network." }, { status: 400 });
    details = { address };
  }
  // 2FA on: a new place for money to go needs the code too, or a stolen session could line up its own address
  if (client.twoFactorEnabled && client.twoFactorSecret) {
    const code = typeof body?.code === "string" ? body.code.replace(/\s+/g, "") : "";
    if (!code) return NextResponse.json({ error: "Enter the code from your authenticator app.", code: "TWO_FACTOR_REQUIRED" }, { status: 401 });
    const checked = await checkClientCode(session.clientId, client.twoFactorSecret, code);
    if (checked === "locked") return NextResponse.json({ error: CODE_LOCKED_MESSAGE, code: "TWO_FACTOR_LOCKED" }, { status: 429 });
    if (checked === "wrong") return NextResponse.json({ error: "Wrong code.", code: "TWO_FACTOR_INVALID" }, { status: 401 });
  }
  const created = await prisma.clientPayoutMethod.create({ data: { brokerId: session.brokerId, clientId: session.clientId, type, holderName: client.fullName, details } });
  await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "PAYOUT_METHOD_ADDED", entityType: "ClientPayoutMethod", entityId: created.id, newValue: { type, ...details, source: "CLIENT" } } });
  return NextResponse.json({ payoutMethods: await payoutMethods(session.clientId) }, { status: 201 });
}

export async function DELETE(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const id = new URL(request.url).searchParams.get("id");
  const res = await prisma.clientPayoutMethod.updateMany({ where: { id: id ?? "", clientId: session.clientId, removedAt: null }, data: { removedAt: new Date() } });
  if (res.count === 0) return NextResponse.json({ error: "Not found." }, { status: 404 });
  await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "PAYOUT_METHOD_REMOVED", entityType: "ClientPayoutMethod", entityId: id!, newValue: { source: "CLIENT" } } });
  return NextResponse.json({ payoutMethods: await payoutMethods(session.clientId) });
}
