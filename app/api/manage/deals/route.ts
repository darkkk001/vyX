import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { tradingDayStart } from "@/lib/trading-day";
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
const DEALS_LIMIT = 500;

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
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
  if (fromRaw === "trading-day") {
    // the broker's trading day, the charts' own D1 boundary (lib/trading-day.ts; Batch 4)
    closedAt.gte = (await tradingDayStart()).start;
  } else if (fromRaw) {
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
  const dealsWhere: Prisma.PositionWhereInput = {
    brokerId,
    status: { in: ["CLOSED", "VOIDED"] },
    deletedAt: null,
    ...(accountId ? { accountId } : {}),
    ...(groupId ? { account: { groupId } } : {}),
    ...(closedAt.gte || closedAt.lt ? { closedAt } : {}),
  };
  const positions = await prisma.position.findMany({
    where: dealsWhere,
    include: {
      account: { select: { accountNumber: true, fullName: true, currency: true } },
      // the hedge leg this trade was booked against: whether the platform opened it (auto-hedge) or
      // the dealer did (BOOK NOW) decides who closes it, so it decides how a still-open leg reads
      // in the Smart Dealer Manager -- AWAITING DEALER vs a real ORPHAN (lib/coverage.ts onClose)
      coveragePosition: { select: { autoHedged: true, status: true } },
      symbol: { select: { name: true, digits: true } },
    },
    orderBy: { closedAt: "desc" },
    take: DEALS_LIMIT + 1,
  });
  // Phase 2 batch 6 (issues 108 / 114): one row past the cap tells whether the list was cut; the body stays the bare
  // array every client parses, the answer goes in headers (x-truncated, x-total-count only when cut)
  const truncated = positions.length > DEALS_LIMIT;
  if (truncated) positions.length = DEALS_LIMIT;
  const headers: Record<string, string> = { "x-row-limit": String(DEALS_LIMIT), "x-truncated": truncated ? "true" : "false" };
  if (truncated) headers["x-total-count"] = String(await prisma.position.count({ where: dealsWhere }));

  return NextResponse.json(
    positions.map((p) => ({
      id: p.id,
      ticket: p.ticket,
      accountNumber: p.account.accountNumber,
      currency: p.account.currency, // web5 (owner 2026-09-30): the deal's account currency (P/L, swap, commission are in it)
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
      // Phase 2 batch 7 (issue 284): the open time, same format, so a closed row's OPENED cell is filled
      openedAt: p.openedAt.toISOString().replace("T", " ").slice(0, 19),
      // dealer coverage (2026-09-22): a booked client trade keeps its hedge-leg id after closing so the
      // Smart Dealer Manager can show the closing side with both P&Ls
      covered: p.covered,
      coveragePositionId: p.coveragePositionId,
      // true when the platform opened the hedge (and so closes it itself); false = the dealer booked
      // it by hand and the dealer closes it
      coverageAutoHedged: p.coveragePosition?.autoHedged ?? false,
      // A_BOOK / B_BOOK: the Smart Dealer Manager's realized DEALER P/L counts only the desk's own
      // B-book closes (2026-09-23); an A-book trade's result is the LP's, not the dealer's
      bookType: p.bookType,
    })),
    { headers }
  );
}
