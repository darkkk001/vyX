import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { forbidUnlessBrokerAdminOrPermission, PERMISSION_LABELS } from "@/lib/permissions";
import { dealerPnl, hedgeBook } from "@/lib/hedge-book";
import { parseDashRange, rangeJson } from "@/lib/dash-range";
import { tradingDayStart } from "@/lib/trading-day";

// GET /api/manage/coverage/book (Dealing redesign D10, owner 2026-10-26): the hedge book per symbol, the ONE answer behind
// the Dealing HEDGE MANAGER and the hedge account panel (lib/hedge-book.ts). DEALING: BROKER_ADMIN, or a MANAGER granted it.
// ?range=1D|5D|7D|1M (or any lib/dash-range.ts key / from-to; default 1D): the DEALER P/L card over that range.
export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (await forbidUnlessBrokerAdminOrPermission(session!, "DEALING")) {
    return NextResponse.json({ error: "forbidden", permission: "DEALING", permissionLabel: PERMISSION_LABELS.DEALING }, { status: 403 });
  }
  const range = parseDashRange(request.nextUrl.searchParams, (await tradingDayStart()).start, "TODAY");
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  const brokerId = session!.brokerId!;
  const [book, pnl] = await Promise.all([hedgeBook(brokerId), dealerPnl(brokerId, range)]);
  return NextResponse.json({ ...book, dealerPnl: { range: rangeJson(range), ...pnl } });
}
