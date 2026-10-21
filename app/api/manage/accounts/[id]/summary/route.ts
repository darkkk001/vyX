import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseRange, summarizeAccount, SummaryNotFoundError } from "@/lib/account-summary";

// GET /api/manage/accounts/[id]/summary?from&to: one account's summary for the backoffice client view (the history
// summary bar) and statements. Staff session, broker-scoped: another broker's account answers 404. Same shape as
// GET /api/trade/summary; definitions in lib/account-summary.ts.
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const range = parseRange(new URL(request.url).searchParams);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  try {
    return NextResponse.json(await summarizeAccount(id, range, { brokerId: session!.brokerId! }));
  } catch (e) {
    if (e instanceof SummaryNotFoundError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
