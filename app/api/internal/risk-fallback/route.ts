import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { marginPassGate } from "@/lib/live-price";
import { runFullMarginPass } from "@/lib/margin-pass";
import { anyBrokerRust, readEngineHeartbeat, type EngineHeartbeat } from "@/lib/risk-fallback";
import { checkEngineHeartbeatAlert } from "@/lib/risk-engine-alert";
import { checkInfraStale } from "@/lib/infra-health";

// Stage 6 (owner decisions b and c, 2026-10-07): the 1-minute web fallback while any broker is on the engine, and the
// stale-heartbeat alert (ops only). Vercel cron "* * * * *" (vercel.json); the 5-minute margin-monitor cron is unchanged.
// The order of the checks keeps Neon asleep when there is nothing to do: lib/risk-fallback.ts has the full reasoning.
//
//   1. the engine's book gate (HTTP to the engine, NO database): closed = nothing can move = return, no alert;
//   2. is any broker RUST (cached): none = return;
//   3. the engine's heartbeat (one row): raise / clear the ops alert from it;
//   4. fresh = the engine acts, return; stale = the web's full pass (every RUST account is WEB-owned now).
export const maxDuration = 15;

// One log line per run (owner 2026-10-26, drill 7.B step 8): ran or not, why it skipped, how many accounts it checked,
// so the Vercel log alone shows the fallback took over while the heartbeat was stale and stood down once it was back.
function answer(body: { ran: boolean; skipped?: string; accountsEvaluated?: number; ageSecs?: number | null; alert?: string | null; errors?: number; [k: string]: unknown }, status = 200) {
  console.log(
    "risk-fallback:",
    JSON.stringify({ ran: body.ran, skipped: body.skipped ?? null, accountsEvaluated: body.accountsEvaluated ?? 0, errors: body.errors ?? 0, ageSecs: body.ageSecs ?? null, alert: body.alert ?? null })
  );
  return NextResponse.json(body, { status });
}

export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  // 0. the VPS infra checks' "not reporting" alert (lib/infra-health.ts): Redis only, before every gate, so it also runs
  //    while the market is closed (a dead bridge or health task matters then too)
  const stale = await checkInfraStale().catch((err) => {
    console.error("risk-fallback: infra stale check failed", err);
    return {};
  });
  if (Object.keys(stale).length > 0) console.log("risk-fallback: infra", JSON.stringify(stale));

  const gate = await marginPassGate();
  if (gate.run === false) return answer({ skipped: gate.reason, ran: false });
  // gate.run === null: the engine could not be read. That is the case the fallback exists for: go on.

  const rust = await anyBrokerRust();
  if (!rust) {
    await checkEngineHeartbeatAlert({ rust: false, active: true, heartbeat: null });
    return answer({ skipped: "no broker is on the engine", ran: false });
  }

  let heartbeat: EngineHeartbeat;
  try {
    heartbeat = await readEngineHeartbeat();
  } catch (err) {
    // the database cannot be read: no alert about the engine for that, and the pass could not run either
    console.error("risk-fallback: heartbeat unreadable", err);
    return answer({ skipped: "heartbeat unreadable", ran: false }, 503);
  }

  const alert = await checkEngineHeartbeatAlert({ rust: true, active: true, heartbeat });
  if (heartbeat.alive) return answer({ skipped: "engine heartbeat fresh", ran: false, ageSecs: heartbeat.ageSecs, alert: alert.action });

  const pass = await runFullMarginPass("risk-fallback");
  return answer({ ran: true, fallback: true, ageSecs: heartbeat.ageSecs, alert: alert.action, ...pass });
}
