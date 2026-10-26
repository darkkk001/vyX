import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { SummaryNotFoundError } from "@/lib/account-summary";
import { realizedPeriods } from "@/lib/account-periods";

// GET /api/manage/accounts/[id]/summary/periods: one account's realized Day / Week P/L for the backoffice client view,
// the same body as GET /api/trade/summary/periods. Staff session, broker-scoped: another broker's account answers 404.
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  try {
    return NextResponse.json(await realizedPeriods(id, { brokerId: session!.brokerId! }));
  } catch (e) {
    if (e instanceof SummaryNotFoundError) return NextResponse.json({ error: "not found" }, { status: 404 });
    throw e;
  }
}
