import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { runPostClose, runPostCloseBatch } from "@/lib/post-close";

// Rust cutover Stage 3: the engine's outbox dispatcher (engine/order-management/src/outbox.rs) calls this with one
// PostCloseEffect id after each automatic close the engine made; lib/post-close.ts runs the web's post-close
// sequence for it (queued-close cancel, mirror, stop-out notice, coverage, events). Retry-safe by construction, so
// the dispatcher may call it again for the same id at any time.
//
// 200 = nothing more to do for now (done / gone = already finished / busy = another run holds it);
// 503 = asked to retry later (an auto-hedged leg waiting for a live price); 500 = a step failed.
// The CALLER records the failed attempt and its backoff, never this route.
//
// Stage 4.6, ADDITIVE: `{ids: [...]}` (1-50, in order) runs one conflict group through runPostCloseBatch -- in order,
// stopping at the first row that is not finished -- and always answers 200 with `{results: [{id, status, error?}]}`
// (status done / gone / busy / retry / error / not_attempted). The single `{id}` form above is unchanged.
export const maxDuration = 30;
const MAX_BATCH = 50;

export async function POST(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.POST_CLOSE_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = (await request.json().catch(() => null)) as { id?: unknown; ids?: unknown } | null;
  if (body && typeof body === "object" && "ids" in body) {
    const ids = body.ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BATCH || !ids.every((x) => typeof x === "string" && x.length > 0 && x.length <= 64)) {
      return NextResponse.json({ error: `ids must be 1-${MAX_BATCH} ids` }, { status: 400 });
    }
    return NextResponse.json({ results: await runPostCloseBatch(ids as string[]) });
  }
  const id = typeof body?.id === "string" ? body.id : null;
  if (!id || id.length > 64) return NextResponse.json({ error: "id required" }, { status: 400 });

  const result = await runPostClose(id);
  const status = result.status === "retry" ? 503 : result.status === "error" ? 500 : 200;
  return NextResponse.json(result, { status });
}
