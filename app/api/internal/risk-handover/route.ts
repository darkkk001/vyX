import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { readEngineHeartbeat } from "@/lib/risk-fallback";
import { runFullMarginPass } from "@/lib/margin-pass";

export const dynamic = "force-dynamic";

// GET /api/internal/risk-handover
//
// THE CONFIRMATION HALF OF A LICENSE STOP (owner decision 2026-11-13). A licensed engine whose license
// is revoked, expired or machine-refused must not simply stop: stopping would end SL/TP and stop-out
// evaluation for every account it owns, which is an outage, not a kill switch. So the engine does this,
// in this order (engine order-management/src/license_gate.rs):
//
//   1. refuse new orders at once -- the commercial lever, which is safe to apply immediately;
//   2. record the intent durably (an ENGINE_RISK_HANDOVER_INTENT audit row per broker);
//   3. release: push its own "risk" heartbeat past staleAfterSecs, which is what makes every RUST
//      account WEB-owned (lib/risk-fallback.ts);
//   4. ASK HERE, and keep evaluating risk until this route says tookOver -- for ever, if need be.
//
// This route exists rather than the engine calling /api/internal/risk-fallback because that one is
// authorised with CRON_SECRET, the cron's key to every internal cron route, and an engine has no
// business holding it. Here the gate is the INTERNAL_SERVICE_SECRET the engine already has.
//
// IT REFUSES WHILE THE ENGINE IS STILL BEATING. That check is the reason the answer means anything: if
// the web confirmed takeover while the engine's heartbeat was fresh, both sides would consider
// themselves the owner and both would act on the same accounts. A fresh heartbeat answers
// tookOver: false with a reason, and the engine keeps acting -- which is correct, because it still is
// the owner.
export async function GET(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const engine = request.headers.get("x-engine-id") ?? "unknown";

  let heartbeat;
  try {
    heartbeat = await readEngineHeartbeat();
  } catch (err) {
    // The database could not be read. NOT a takeover: the web cannot claim to own accounts it cannot
    // read, and the engine must keep acting. 503 so the engine logs it as a problem rather than a no.
    console.error("risk-handover: the engine heartbeat could not be read", err);
    return NextResponse.json({ tookOver: false, reason: "heartbeat unreadable" }, { status: 503 });
  }

  if (heartbeat.alive) {
    console.log(
      JSON.stringify({
        route: "risk-handover",
        engine,
        tookOver: false,
        reason: "engine heartbeat still fresh",
        ageSecs: heartbeat.ageSecs,
      })
    );
    return NextResponse.json({
      tookOver: false,
      reason: "the engine's heartbeat is still fresh, so it has not released its authority yet",
      ageSecs: heartbeat.ageSecs,
      staleAfterSecs: heartbeat.staleAfterSecs,
    });
  }

  // The engine has released. Run the web's own full pass, as owner, and report that it ran -- this is
  // the evidence the engine waits for, so it has to be a pass that actually happened, not a promise.
  const pass = await runFullMarginPass("engine-handover");
  console.log(
    JSON.stringify({
      route: "risk-handover",
      engine,
      tookOver: true,
      ageSecs: heartbeat.ageSecs,
      accountsEvaluated: pass.accountsEvaluated ?? 0,
      errors: pass.errors ?? 0,
    })
  );
  return NextResponse.json({
    tookOver: true,
    ageSecs: heartbeat.ageSecs,
    engineVersion: heartbeat.engineVersion,
    instance: heartbeat.instance,
    ...pass,
  });
}
