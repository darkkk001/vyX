import { NextRequest, NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { parseRange, summarizeAccounts, SummaryTooManyError } from "@/lib/account-summary";

// GET /api/manage/accounts/summary?accountIds=a,b&groupId=g&from&to: statements over several accounts and / or a whole
// group: { from, to, accounts: [summary of each], totals: [one per currency] }. Staff session, broker-scoped: ids of
// another broker are left out. At least one of accountIds / groupId; at most 500 accounts per call.
const MAX_ACCOUNTS = 500;

export async function GET(request: NextRequest) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const sp = new URL(request.url).searchParams;
  const range = parseRange(sp);
  if ("error" in range) return NextResponse.json({ error: range.error }, { status: 400 });
  const accountIds = (sp.get("accountIds") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const groupId = sp.get("groupId")?.trim() || undefined;
  if (accountIds.length === 0 && !groupId) return NextResponse.json({ error: "accountIds or groupId is required" }, { status: 400 });
  if (accountIds.length > MAX_ACCOUNTS) return NextResponse.json({ error: `at most ${MAX_ACCOUNTS} accounts per call` }, { status: 400 });
  try {
    return NextResponse.json(await summarizeAccounts({ brokerId: session!.brokerId!, accountIds, groupId, max: MAX_ACCOUNTS }, range));
  } catch (e) {
    if (e instanceof SummaryTooManyError) return NextResponse.json({ error: e.message }, { status: 400 });
    throw e;
  }
}
