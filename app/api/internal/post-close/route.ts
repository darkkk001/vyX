import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { runPostClose } from "@/lib/post-close";

// Rust cutover Stage 3: the engine's outbox dispatcher (engine/order-management/src/outbox.rs) calls this with one
// PostCloseEffect id after each automatic close the engine made; lib/post-close.ts runs the web's post-close
// sequence for it (queued-close cancel, mirror, stop-out notice, coverage, events). Retry-safe by construction, so
// the dispatcher may call it again for the same id at any time.
//
// 200 = nothing more to do for now (done / gone = already finished / busy = another run holds it);
// 503 = asked to retry later (an auto-hedged leg waiting for a live price); 500 = a step failed.
// The CALLER records the failed attempt and its backoff, never this route.
export const maxDuration = 30;

export async function POST(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.POST_CLOSE_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown } | null;
  const id = typeof body?.id === "string" ? body.id : null;
  if (!id || id.length > 64) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result = await runPostClose(id);
  const status = result.status === "retry" ? 503 : result.status === "error" ? 500 : 200;
  return NextResponse.json(result, { status });
}
