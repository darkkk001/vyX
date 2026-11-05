import { NextRequest, NextResponse } from "next/server";
import { brandForHost } from "@/lib/broker-brand";
import { brandIconPng } from "@/lib/broker-brand-icon";

export const dynamic = "force-dynamic";
const SIZES = new Set([192, 512]);

// The web manifest's icons (lib/broker-brand.tsx).
export async function GET(request: NextRequest, { params }: { params: Promise<{ size: string }> }) {
  const size = Number((await params).size);
  if (!SIZES.has(size)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const png = await brandIconPng(await brandForHost(request.headers.get("host")), size, request.nextUrl.origin);
  return new Response(new Uint8Array(png), { headers: { "Content-Type": "image/png", "Cache-Control": "public, max-age=3600" } });
}
