import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getDealerActivityFeedRows } from "@/lib/dealer-activity";

// Live Exposure's own feed (2026-09-04 refinement) -- the WHOLE broker's
// live trade activity (every account, dealingOnly left off so
// getDealerActivityFeedRows returns everyone), not just DEALING-group
// accounts. Named for what it is here -- "live activity", not "dealer
// activity" -- since this surface is platform-wide, not dealer-specific;
// the dealer's own DEALING-only view is the separate
// GET /api/manage/dealing-desk backing the Dealing page's Activity tab.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await getDealerActivityFeedRows(session!.brokerId!);
  return NextResponse.json({ rows });
}
