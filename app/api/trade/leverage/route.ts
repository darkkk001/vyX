import { NextRequest, NextResponse } from "next/server";
import { getAccountSession } from "@/lib/account-auth";
import { checkRateLimit } from "@/lib/rate-limit";
import { publishAccountUpdated } from "@/lib/account-events";
import { changeOwnLeverage, tradeLeverageState } from "@/lib/trade-leverage";

// B2 (owner 2026-11-06). GET: what the apps show, never derived client-side: { current, groupMax, flexible, tradesDone,
// tradesNeeded, allowedSteps }. POST { leverage }: the trader's own change, refused with its own code and plain reason
// (FLEXIBLE_LEVERAGE_OFF, MIN_TRADES_NOT_MET, LEVERAGE_ABOVE_GROUP_MAX, LEVERAGE_INVALID, LEVERAGE_MARGIN); audited as
// LEVERAGE_CHANGED_BY_CLIENT and announced as an account update so the terminal re-reads (lib/trade-leverage.ts).
export async function GET() {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const state = await tradeLeverageState(session.accountId);
  if (!state) return NextResponse.json({ error: "account not found" }, { status: 404 });
  return NextResponse.json(state);
}

export async function POST(request: NextRequest) {
  const session = await getAccountSession();
  if (!session) return NextResponse.json({ error: "not authenticated" }, { status: 401 });
  const limited = await checkRateLimit(`trade-leverage:${session.accountId}`, 10, 60).catch(() => ({ allowed: true }));
  if (!limited.allowed) return NextResponse.json({ error: "Too many attempts. Try again in a minute.", code: "RATE_LIMITED" }, { status: 429 });

  const body = await request.json().catch(() => null);
  const result = await changeOwnLeverage({ accountId: session.accountId, brokerId: session.brokerId, raw: body?.leverage });
  if (!result.ok) return NextResponse.json({ error: result.refusal.error, code: result.refusal.code }, { status: result.refusal.status });
  await publishAccountUpdated(session.brokerId, session.accountId, "account");
  const state = await tradeLeverageState(session.accountId);
  return NextResponse.json({ leverage: result.to, ...state });
}
