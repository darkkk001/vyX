import { NextRequest } from "next/server";
import { brandForHost } from "@/lib/broker-brand";
import { brandIconPng } from "@/lib/broker-brand-icon";

export const dynamic = "force-dynamic";

// iOS home-screen icon, 180 px (lib/broker-brand.tsx).
export async function GET(request: NextRequest) {
  const png = await brandIconPng(await brandForHost(request.headers.get("host")), 180, request.nextUrl.origin);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
}
