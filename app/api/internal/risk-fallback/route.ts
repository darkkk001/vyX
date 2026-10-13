import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { marginPassGate } from "@/lib/live-price";
import { runFullMarginPass } from "@/lib/margin-pass";
import { anyBrokerRust, readEngineHeartbeat, type EngineHeartbeat } from "@/lib/risk-fallback";
import { checkEngineHeartbeatAlert } from "@/lib/risk-engine-alert";

// Stage 6 (owner decisions b and c, 2026-10-07): the 1-minute web fallback while any broker is on the engine, and the
// stale-heartbeat alert (ops only). Vercel cron "* * * * *" (vercel.json); the 5-minute margin-monitor cron is unchanged.
// The order of the checks keeps Neon asleep when there is nothing to do: lib/risk-fallback.ts has the full reasoning.
//
//   1. the engine's book gate (HTTP to the engine, NO database): closed = nothing can move = return, no alert;
//   2. is any broker RUST (cached): none = return;
//   3. the engine's heartbeat (one row): raise / clear the ops alert from it;
//   4. fresh = the engine acts, return; stale = the web's full pass (every RUST account is WEB-owned now).
export const maxDuration = 15;

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const gate = await marginPassGate();
  if (gate.run === false) return NextResponse.json({ skipped: gate.reason, ran: false });
  // gate.run === null: the engine could not be read. That is the case the fallback exists for: go on.

  const rust = await anyBrokerRust();
  if (!rust) {
    await checkEngineHeartbeatAlert({ rust: false, active: true, heartbeat: null });
    return NextResponse.json({ skipped: "no broker is on the engine", ran: false });
  }

  let heartbeat: EngineHeartbeat;
  try {
    heartbeat = await readEngineHeartbeat();
  } catch (err) {
    // the database cannot be read: no alert about the engine for that, and the pass could not run either
    console.error("risk-fallback: heartbeat unreadable", err);
    return NextResponse.json({ skipped: "heartbeat unreadable", ran: false }, { status: 503 });
  }

  const alert = await checkEngineHeartbeatAlert({ rust: true, active: true, heartbeat });
  if (heartbeat.alive) return NextResponse.json({ skipped: "engine heartbeat fresh", ran: false, ageSecs: heartbeat.ageSecs, alert: alert.action });

  const pass = await runFullMarginPass();
  return NextResponse.json({ ran: true, fallback: true, ageSecs: heartbeat.ageSecs, alert: alert.action, ...pass });
}
