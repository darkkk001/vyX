import { NextRequest, NextResponse } from "next/server";
import { verifyBridgeGet } from "@/lib/bridge-auth";
import { buildBridgeConfig } from "@/lib/bridge-config";

// GET /api/bridge/config: a licensed QoreBridge's LP connections, LP symbol tables and routing rules, for its
// license's broker only (lib/bridge-config.ts; auth lib/bridge-auth.ts). No secrets. ETag = the config version:
// If-None-Match with the current version answers 304. Called at bridge start; the bridge polls /version between.
export async function GET(request: NextRequest) {
  const auth = await verifyBridgeGet(request.headers, request.nextUrl.pathname);
  if (!auth.ok) return NextResponse.json({ error: "forbidden", reason: auth.reason }, { status: auth.status, headers: { "cache-control": "no-store" } });
  const config = await buildBridgeConfig(auth.brokerId);
  const etag = `"${config.version}"`;
  const headers = { "cache-control": "no-store", etag };
  if (request.headers.get("if-none-match") === etag) return new NextResponse(null, { status: 304, headers });
  return NextResponse.json(config, { headers });
}
