import { NextRequest, NextResponse } from "next/server";
import { verifyBridgeGet } from "@/lib/bridge-auth";
import { buildBridgeConfig } from "@/lib/bridge-config";

// GET /api/bridge/config/version: only the current config version (same auth as /api/bridge/config). A bridge polls
// this and logs "config changed, restart to apply" when it differs from what it runs (no live reconnect in v1).
export async function GET(request: NextRequest) {
  const auth = await verifyBridgeGet(request.headers, request.nextUrl.pathname);
  if (!auth.ok) return NextResponse.json({ error: "forbidden", reason: auth.reason }, { status: auth.status, headers: { "cache-control": "no-store" } });
  const { version } = await buildBridgeConfig(auth.brokerId);
  return NextResponse.json({ version }, { headers: { "cache-control": "no-store", etag: `"${version}"` } });
}
