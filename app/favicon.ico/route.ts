import { NextRequest } from "next/server";
import { brandForHost, icoFromPng } from "@/lib/broker-brand";
import { brandIconPng } from "@/lib/broker-brand-icon";

export const dynamic = "force-dynamic";

// The tenant's own favicon (lib/broker-brand.tsx); replaces the framework's default file.
export async function GET(request: NextRequest) {
  const brand = await brandForHost(request.headers.get("host"));
  const ico = icoFromPng(await brandIconPng(brand, 32, request.nextUrl.origin), 32);
  return new Response(new Uint8Array(ico), { headers: { "Content-Type": "image/x-icon", "Cache-Control": "public, max-age=3600" } });
}
