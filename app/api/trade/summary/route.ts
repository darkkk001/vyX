import { NextRequest, NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { parseRange, summarizeAccount } from "@/lib/account-summary";

// GET /api/trade/summary?from&to: the signed-in account's summary over the range (both ISO, inclusive; default the last
// 90 days): opening / closing balance, trades (closes, wins, volume, gross P/L, commission, swap, net), funds lines
// (deposits, withdrawals, credit, adjustments, transfers, negative-balance protection) and the reconciliation check.
// The terminal's history summary bar and the account statement read it. Definitions: lib/account-summary.ts.
export async function GET(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) {
    return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  }
  const range = parseRange(new URL(request.url).searchParams);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  return NextResponse.json(await summarizeAccount(session.accountId, range));
}
