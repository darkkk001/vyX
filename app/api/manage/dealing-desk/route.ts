import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getDealerActivityFeedRows, getDealingDeskRestingOrders, getDealingGroupAccounts } from "@/lib/dealer-activity";

// Dealing page refinement (2026-09-04): "nothing about a dealing-group
// account happens without appearing here." Cold-load backing for
// DealingDeskPanel.tsx -- the ONLY place a dealer-activity feed is mounted
// (a separate, general every-account feed briefly lived on Live Exposure
// too; removed the same day as redundant clutter -- the dealer's view
// belongs here, not scattered elsewhere). Everything below is scoped to
// accounts whose Group.groupType is DEALING. Combines all three pieces
// this panel needs into one request: the account list (filter dropdown,
// and what "DEALING-group" even means today), the currently-resting
// LIMIT/STOP orders (a persistent view, not just feed rows that scroll
// away), and the last 50 DEALING-only feed rows.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const brokerId = session!.brokerId!;

  const [accounts, restingOrders, feedRows] = await Promise.all([
    getDealingGroupAccounts(brokerId),
    getDealingDeskRestingOrders(brokerId),
    getDealerActivityFeedRows(brokerId, { dealingOnly: true }),
  ]);

  return NextResponse.json({ accounts, restingOrders, feedRows });
}
