import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getDealerActivityFeedRows } from "@/lib/dealer-activity";

// General dealer-awareness activity feed -- cold-load backing for
// DealerActivityFeed.tsx on Live Exposure (every account, DEALING ones
// amber-highlighted). See lib/dealer-activity.ts's getDealerActivityFeedRows
// for the query itself and its own disclosed backfill gaps; the
// Dealing-page-specific, DEALING-only variant (plus the resting-orders
// list) is GET /api/manage/dealing-desk.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const rows = await getDealerActivityFeedRows(session!.brokerId!);
  return NextResponse.json({ rows });
}
