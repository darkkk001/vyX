import { NextRequest, NextResponse } from "next/server";
import { brandForHost, webManifest } from "@/lib/broker-brand";

export const dynamic = "force-dynamic";

// The tenant's web manifest: its name and icons for "Add to Home Screen" (lib/broker-brand.tsx).
export async function GET(request: NextRequest) {
  return NextResponse.json(webManifest(await brandForHost(request.headers.get("host"))), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=3600" } });
}
