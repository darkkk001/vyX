import { NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { realizedPeriods } from "@/lib/account-periods";

// GET /api/trade/summary/periods: the signed-in account's realized P/L of the current trading day and week (deals
// closed in the period with their commission and swap; never floating), with the boundaries the server used.
// Terminal 1.0.96's Day / Week P/L read it. Definitions: lib/account-periods.ts.
export async function GET() {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  return NextResponse.json(await realizedPeriods(session.accountId));
}
