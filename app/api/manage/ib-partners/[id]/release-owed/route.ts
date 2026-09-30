import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import { IbPartnerError, releaseFrozenOwed } from "@/lib/ib-partner";

// Step 2 (owner 2026-09-30): pay a SUSPENDED partner's frozen owed amount without resuming it -- an explicit,
// audited admin release. BROKER_ADMIN only (a MANAGER gets 403: it may only file payouts for a second admin, and a
// suspended partner's payouts are refused). Money moves only through lib/ib-payout.ts executeIbPayout, the same path
// as every IB payout. Body: { note?: string }. Audited (IB_FROZEN_PAY_RELEASED per link + IB_PARTNER_OWED_RELEASED).
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await request.json().catch(() => ({}));
  const note = typeof body?.note === "string" ? body.note.trim().slice(0, 500) || null : null;
  try {
    const r = await prisma.$transaction((tx) => releaseFrozenOwed(tx, { brokerId: session!.brokerId!, ibAccountId: id, adminId: session!.adminId, note }));
    await publishTradingEvent("BalanceChanged", { account_id: id, broker_id: session!.brokerId!, transaction_id: r.paid[0]?.transactionId }).catch(() => {});
    return NextResponse.json({ ibAccountId: id, released: r.total.toFixed(2), payouts: r.paid, stillSuspended: true });
  } catch (e) {
    if (e instanceof IbPartnerError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
