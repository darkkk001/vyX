import { NextRequest, NextResponse } from "next/server";
import { secretMatches } from "@/lib/internal-auth";
import { prisma } from "@/lib/prisma";
import { validEngineId } from "@/lib/engine-registry";

export const dynamic = "force-dynamic";

// POST /api/internal/engine-status
//
// THE ENGINE'S ONE HEARTBEAT (owner 2026-11-13). The engine reports here, and THIS ROUTE writes
// Engine.lastBeatAt -- the engine never writes that row itself. The reason is the web's owner rule:
// loadRiskOwners and assertRiskActorInTx read Engine.lastBeatAt to decide whether the engine or the web
// owns a broker's accounts. If the engine wrote that row directly, it could keep saying "I am fine"
// while the platform could not hear from it at all, and the web would leave accounts to an engine it
// has lost. One beat, one path, one meaning.
//
// THE ANSWER IS THE FAST PATH, the same way the bridge's status report is (license enforcement 1.2,
// contract 2c): the reply carries the engine's current status, so a console flip to RETIRED or a
// DRAINING is acted on within one beat instead of waiting for the next config pull.
//
// An unknown engine id is a 404 and writes nothing. A typo in ENGINE_ID must not look like a healthy
// engine -- it must look like what it is, an engine nobody registered.
export async function POST(request: NextRequest) {
  if (!secretMatches(request.headers.get("x-internal-secret"), process.env.INTERNAL_SERVICE_SECRET)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  let body: { engineId?: unknown; version?: unknown; releasing?: unknown; health?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "body must be JSON" }, { status: 400 });
  }
  const engineId = body?.engineId;
  if (!validEngineId(engineId)) {
    return NextResponse.json({ error: "engineId is required and must be a valid engine id" }, { status: 400 });
  }
  const version = typeof body?.version === "string" ? body.version.slice(0, 200) : null;
  const releasing = body?.releasing === true;

  const engine = await prisma.engine.findUnique({
    where: { id: engineId },
    select: { id: true, status: true, staleAfterSecs: true },
  });
  if (!engine) {
    console.warn(JSON.stringify({ route: "engine-status", engineId, result: "unknown engine", releasing }));
    return NextResponse.json({ error: "unknown engine" }, { status: 404 });
  }

  // RELEASING is the engine standing down on purpose -- a license stop handing its risk authority over,
  // or a retirement it has just been told about. The beat is pushed PAST staleness rather than simply
  // not refreshed, so the web owns the brokers at once instead of after staleAfterSecs, during which
  // neither side would consider itself the owner.
  const beatAt = releasing ? new Date(Date.now() - (engine.staleAfterSecs + 60) * 1000) : new Date();
  await prisma.engine.update({
    where: { id: engine.id },
    data: { lastBeatAt: beatAt, ...(version ? { lastBeatVersion: version } : {}) },
  });

  console.log(
    JSON.stringify({
      route: "engine-status",
      engineId: engine.id,
      status: engine.status,
      releasing,
      health: typeof body?.health === "object" && body.health ? body.health : undefined,
    })
  );

  return NextResponse.json({
    ok: true,
    engineId: engine.id,
    // the fast path: the engine applies a non-serving status on the next turn, without waiting for a
    // config pull
    status: engine.status,
    staleAfterSecs: engine.staleAfterSecs,
    releasing,
  });
}
