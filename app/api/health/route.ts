import { NextResponse } from "next/server";
import { getSchemaState, refreshIfStale, runSchemaCheck, schemaLabel } from "@/lib/schema-guard";
import { probeDatabase } from "@/lib/db-probe";

export const dynamic = "force-dynamic";

// Public liveness route. Generic wording only: no names, versions or internal systems.
// Database (lib/db-probe.ts, incident 2026-10-27): a NEW connection, cached 10 s per instance; when it is refused the
// answer is 503 "db":"down", so a check that wants 200 turns red (the old answer stayed 200 all through the outage).
export async function GET() {
  let state = getSchemaState();
  // An instance whose startup check has not run: one check, then cached.
  if (state.status === "unchecked") state = await runSchemaCheck();
  else state = await refreshIfStale();
  const behind = state.status === "behind";
  if (behind) return NextResponse.json({ status: "updating", schema: schemaLabel(state) }, { status: 503 });
  const db = await probeDatabase();
  if (!db.ok) {
    return NextResponse.json(
      { status: "down", schema: schemaLabel(state), db: "down", reason: db.reason, down_secs: db.downSecs },
      { status: 503, headers: { "x-vyx-db": `down reason=${db.reason} secs=${db.downSecs}`, "cache-control": "no-store" } }
    );
  }
  return NextResponse.json({ status: "ok", schema: schemaLabel(state), db: "ok" }, { headers: { "x-vyx-db": "ok", "cache-control": "no-store" } });
}
