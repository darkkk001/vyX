import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";
import { servedBrokerIds, validEngineId } from "@/lib/engine-registry";

export const dynamic = "force-dynamic";

// GET /api/engine/config?engineId=<ENGINE_ID>
//
// THE ENGINE'S CONFIG PULL (owner 2026-11-13). The engine asks what it is and what it serves; it does
// NOT query the control database for either.
//
// WHY THE ENGINE DOES NOT READ engine_broker_scope ITSELF. The view exists so this question has one
// answer ("SELECT broker_id FROM engine_broker_scope WHERE engine_id = $1", lib/engine-registry.ts
// servedBrokerIds), and the engine gets that answer from here. Reading it directly would give every
// regional engine credentials on the control plane and pin it to that schema; through the pull, the
// view can change shape tomorrow and only this route changes. The view already encodes "PLANNED and
// RETIRED list nothing", so the two sides cannot drift on that either -- and the engine applies the
// same rule again on its own side (engine order-management/src/engine_registry.rs), because a stand-
// down must not depend on the control plane being reachable to happen.
//
// AUTH, AND WHAT IS STILL MISSING. This is the internal shared secret for now, the same gate the other
// internal routes use. The licensed form -- signed, timestamped, nonce'd, machine-bound, like the
// bridge's config pull -- does NOT come from lib/bridge-auth.ts verifyBridgeGet as it stands: that
// helper loads a BRIDGE license and requires x-broker-id to equal that license's single brokerId. An
// engine's license is not per-broker; one engine serves many. So the engine's signed variant keys on
// the engine license and ENGINE_ID instead of a broker, which is an extension of the same scheme and
// not a second one. That lands with the app=engine license work.
export async function GET(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const engineId = request.nextUrl.searchParams.get("engineId") ?? request.headers.get("x-engine-id");
  if (!validEngineId(engineId)) {
    return NextResponse.json({ error: "engineId is required and must be a valid engine id" }, { status: 400 });
  }

  const engine = await prisma.engine.findUnique({
    where: { id: engineId },
    select: { id: true, name: true, region: true, gatewayUrl: true, status: true, staleAfterSecs: true },
  });
  if (!engine) {
    // An engine nobody registered is not a healthy engine with an empty assignment: say so, so a typo
    // in ENGINE_ID cannot read as "serve nothing, all is well".
    console.warn(JSON.stringify({ route: "engine-config", engineId, result: "unknown engine" }));
    return NextResponse.json({ error: "unknown engine" }, { status: 404 });
  }

  // The view is the single source: it lists only ACTIVE and DRAINING engines, so a PLANNED or RETIRED
  // engine gets an empty list here without this route having to know that rule.
  const assignedBrokers = await servedBrokerIds(prisma, engine.id);

  return NextResponse.json(
    {
      engineId: engine.id,
      name: engine.name,
      region: engine.region,
      gatewayUrl: engine.gatewayUrl,
      status: engine.status,
      staleAfterSecs: engine.staleAfterSecs,
      assignedBrokers,
      servedAt: new Date().toISOString(),
    },
    { headers: { "cache-control": "no-store" } }
  );
}
