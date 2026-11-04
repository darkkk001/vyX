import { NextRequest, NextResponse } from "next/server";
import QRCode from "qrcode";
import { prisma } from "@/lib/prisma";
import { roomApiSession } from "@/lib/room/context";
import { partnerSummary, referralCodeOf, partnerAccountOf } from "@/lib/room/partner";
import { computePendingCommission } from "@/lib/commission";
import { createNotification } from "@/lib/notifications";
import { checkRateLimit } from "@/lib/rate-limit";
import { Prisma } from "@prisma/client";
import { requestOrigin } from "@/lib/request-origin";

// Partner portal. GET ?month=YYYY-MM -> link, QR, stats, the month's commission per (masked) client, rates, payouts.
// POST -> a payout request for everything unpaid (staff pay it in the backoffice IB tab). 404 for a non-partner.
export async function GET(request: NextRequest) {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const m = new URL(request.url).searchParams.get("month");
  const now = new Date();
  const month = m && /^\d{4}-\d{2}$/.test(m) ? new Date(`${m}-01T00:00:00Z`) : now;
  const summary = await partnerSummary(session.brokerId, session.clientId, month > now ? now : month);
  if (!summary) return NextResponse.json({ error: "Not a partner." }, { status: 404 });
  const code = await referralCodeOf(session.clientId);
  const link = `${requestOrigin(request)}/r/${code}`;
  return NextResponse.json({ ...summary, code, link, qr: await QRCode.toDataURL(link, { margin: 1, width: 240 }) });
}

export async function POST() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  const { session } = ctx;
  const { allowed } = await checkRateLimit(`room-ib-payout:${session.clientId}`, 3, 3600);
  if (!allowed) return NextResponse.json({ error: "Too many requests. Try again later." }, { status: 429 });
  const partner = await partnerAccountOf(prisma, session.clientId);
  if (!partner) return NextResponse.json({ error: "Not a partner." }, { status: 404 });
  if (partner.ibSuspendedAt) return NextResponse.json({ error: "Your partner account is on hold. Contact your broker." }, { status: 409 });
  const pending = await prisma.ibPayoutRequest.findFirst({ where: { clientId: session.clientId, status: "PENDING" }, select: { id: true } });
  if (pending) return NextResponse.json({ error: "A payout request is already with your broker." }, { status: 409 });
  const rels = await prisma.ibRelationship.findMany({ where: { brokerId: session.brokerId, ibAccountId: partner.id } });
  const unpaid = (await Promise.all(rels.map((r) => computePendingCommission(prisma, r)))).reduce((s, x) => s.add(x), new Prisma.Decimal(0));
  if (unpaid.lte(0)) return NextResponse.json({ error: "Nothing to pay out yet." }, { status: 400 });
  const req = await prisma.ibPayoutRequest.create({ data: { brokerId: session.brokerId, clientId: session.clientId, ibAccountId: partner.id, amount: unpaid.toDecimalPlaces(2) } });
  await createNotification(prisma, { brokerId: session.brokerId, type: "IB_PAYOUT_REQUESTED", title: "Partner payout request", body: `${partner.accountNumber}: ${unpaid.toFixed(2)}`, entityType: "IbPayoutRequest", entityId: req.id });
  await prisma.auditLog.create({ data: { brokerId: session.brokerId, clientId: session.clientId, action: "IB_PAYOUT_REQUESTED", entityType: "Account", entityId: partner.id, newValue: { amount: unpaid.toFixed(2), requestId: req.id, source: "CLIENT" } } });
  return NextResponse.json({ status: "requested", amount: unpaid.toFixed(2) }, { status: 201 });
}
