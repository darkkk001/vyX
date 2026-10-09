import { NextRequest, NextResponse } from "next/server";
import { refreshIfBehind } from "@/lib/schema-guard";

export const dynamic = "force-dynamic";

// Asked by middleware.ts (Edge) whether this instance's startup schema check found the database behind the build.
// Same shared-secret gate as the other internal routes. Makes no DB query unless the instance is already behind.
export async function GET(request: NextRequest) {
  const expected = process.env.INTERNAL_SERVICE_SECRET ?? "";
  if (!expected || request.headers.get("x-internal-secret") !== expected) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const state = await refreshIfBehind();
  return NextResponse.json({ behind: state.status === "behind" });
}
