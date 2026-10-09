import { NextResponse } from "next/server";
import { getSchemaState, refreshIfBehind, runSchemaCheck, schemaLabel } from "@/lib/schema-guard";

export const dynamic = "force-dynamic";

// Public liveness route. Generic wording only: no names, versions or internal systems.
export async function GET() {
  let state = getSchemaState();
  // An instance whose startup check has not run: one check, then cached.
  if (state.status === "unchecked") state = await runSchemaCheck();
  else state = await refreshIfBehind();
  const behind = state.status === "behind";
  return NextResponse.json(
    { status: behind ? "updating" : "ok", schema: schemaLabel(state) },
    { status: behind ? 503 : 200 }
  );
}
