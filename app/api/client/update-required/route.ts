import { NextRequest, NextResponse } from "next/server";
import { updateRequiredBody } from "@/lib/client-builds";

// Mandatory-update policy (owner 2026-10-29): where getAdminSession / getAccountSession send a request from a build below its broker's minimum
// version. Every method answers the same 426 { error: "UPDATE_REQUIRED", minVersion, latestVersion }, so a followed 307 lands here too; the
// apps switch to their blocking "Update required" screen. The manifest and the feed stay reachable (they never call those helpers).
function refuse(request: NextRequest) {
  const q = request.nextUrl.searchParams;
  return NextResponse.json(updateRequiredBody({ minVersion: q.get("min") ?? "", latestVersion: q.get("latest") ?? "" }), { status: 426 });
}

export const GET = refuse;
export const POST = refuse;
export const PATCH = refuse;
export const PUT = refuse;
export const DELETE = refuse;
