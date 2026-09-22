import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";

// Same query app/manage/(shell)/deals/page.tsx's Server Component used
// to do inline -- exposed as JSON so DealsManager can fetch it itself
// (both the website and a bundled manager-shell desktop app use this
// one path now).
//
// Optional query filters (all broker-scoped, all narrowing): from / to
// (ISO date or datetime; range on closedAt -- `to` is inclusive of the
// whole day when only a date is given), accountId, groupId. Used by the
// backoffice dealing-group HISTORY view's date-range picker.
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const sp = request.nextUrl.searchParams;
  const accountId = sp.get("accountId")?.trim() || null;
  const groupId = sp.get("groupId")?.trim() || null;

  // Range on closedAt. A bare "YYYY-MM-DD" for `to` means "through the end
  // of that day" -- widen to the next midnight so the whole day is included
  // rather than only trades closed at exactly 00:00:00.
  const closedAt: Prisma.DateTimeFilter = {};
  const fromRaw = sp.get("from")?.trim();
  if (fromRaw) {
    const d = new Date(fromRaw);
    if (!Number.isNaN(d.getTime())) closedAt.gte = d;
  }
  const toRaw = sp.get("to")?.trim();
  if (toRaw) {
    const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(toRaw);
    const d = new Date(toRaw);
    if (!Number.isNaN(d.getTime())) {
      if (dateOnly) d.setUTCDate(d.getUTCDate() + 1);
      closedAt.lt = d;
    }
  }

  // VYX-POSITION-TOOLS-V0 -- VOIDED rows belong here too (the brief's
  // "visible to admins" for Void has nowhere else to land: the Live
  // Exposure page only ever shows status: OPEN, so a just-voided position
  // used to vanish from every backoffice view the instant it voided).
  // deletedAt: null hides a soft-deleted row from this normal-browsing
  // list -- "recoverable from the audit view" (the brief's own words)
  // means the audit log, not this list; see POSITION_DELETED's own
  // AuditLog entry for the full record.
  const positions = await prisma.position.findMany({
    where: {
      brokerId,
      status: { in: ["CLOSED", "VOIDED"] },
      deletedAt: null,
      ...(accountId ? { accountId } : {}),
      ...(groupId ? { account: { groupId } } : {}),
      ...(closedAt.gte || closedAt.lt ? { closedAt } : {}),
    },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { closedAt: "desc" },
    take: 500,
  });

  return NextResponse.json(
    positions.map((p) => ({
      id: p.id,
      ticket: p.ticket,
      accountNumber: p.account.accountNumber,
      accountFullName: p.account.fullName,
      symbol: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      status: p.status,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      closePrice: p.closePrice ? p.closePrice.toFixed(p.symbol.digits) : "-",
      commission: p.commission.toFixed(2),
      swap: p.swap.toFixed(2),
      realizedPnl: p.realizedPnl ? p.realizedPnl.toFixed(2) : "-",
      closedAt: p.closedAt ? p.closedAt.toISOString().replace("T", " ").slice(0, 19) : "-",
      // dealer coverage (2026-09-22): a booked client trade keeps its hedge-leg id after closing so the
      // Smart Dealer Manager can show the closing side with both P&Ls
      covered: p.covered,
      coveragePositionId: p.coveragePositionId,
    }))
  );
}
