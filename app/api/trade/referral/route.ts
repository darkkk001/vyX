import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { getAccountSession } from "@/lib/account-auth";
import { partnerAccountOf } from "@/lib/room/partner";
import { requestOrigin } from "@/lib/request-origin";

// Owner 2026-11-10: the terminal's share card shows the trader's referral (partner / IB) code with a QR. READ ONLY: the code is the
// one the Trader's Room partner portal already uses (Client.referralCode, link /r/<code>, lib/room/partner.ts). It is shown only
// when the signed-in account's client IS a partner and already has a code; this route never creates a code.
// GET -> { code, link, qr } or { code: null } (not a partner / no code yet / an account without a client).
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const account = await prisma.account.findUnique({ where: { id: session.accountId }, select: { clientId: true } });
  if (!account?.clientId) return NextResponse.json({ code: null });
  const client = await prisma.client.findUnique({ where: { id: account.clientId }, select: { referralCode: true } });
  if (!client?.referralCode || !(await partnerAccountOf(prisma, account.clientId))) return NextResponse.json({ code: null });
  const link = `${requestOrigin(request)}/r/${client.referralCode}`;
  return NextResponse.json({ code: client.referralCode, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }) });
}
