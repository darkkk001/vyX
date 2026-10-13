import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { evaluatePendingTriggers } from "@/lib/pending-trigger";

// Rust cutover Stage 6 (risk authority). The engine calls this when a tick crossed the entry of a resting LIMIT / STOP order
// of an account the ENGINE owns (engine/market-data/src/risk_hook.rs spawn_pending_trigger, and its backstop sweep). The web's
// own sweeps (app/api/internal/margin-monitor: the cron, the hook's ?symbols= call, the backstop) skip those orders; this is
// the one route that fills them, and it fills ONLY them (scope "RUST"): each claim re-checks inside its transaction that the
// engine still owns the account (lib/pending-trigger.ts, lib/risk-owner.ts), so an account flipped back to WEB meanwhile is
// left to the web's sweeps and nothing is filled twice.
//
// Why the fill stays web code: filling a resting order OPENS a position, with every order gate (group min / max volume,
// lot step, sessions, exposure, margin, dealing routing, slippage...). The engine decides WHEN an order triggers for its
// accounts; the web's fill routine decides WHETHER it fills. Same bearer secret as margin-monitor (CRON_SECRET).
export const maxDuration = 15;

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const symbolsParam = request.nextUrl.searchParams.get("symbols");
  const symbols = symbolsParam ? symbolsParam.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 20) : undefined;
  const pending = await evaluatePendingTriggers(symbols, "RUST");
  return NextResponse.json({ scope: "RUST", symbols: symbols ?? "all", pending });
}
