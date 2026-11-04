import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { SESSION_PRESETS } from "@/lib/symbol-sessions";

// Server-defined session presets (owner 2026-11-04) so every app offers the same ones. All times UTC.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  return NextResponse.json(SESSION_PRESETS);
}
