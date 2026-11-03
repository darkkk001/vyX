import { NextResponse } from "next/server";
import { roomApiSession } from "@/lib/room/context";
import { clientTier } from "@/lib/room/tier";

// GET: the client's tier, volume and the broker's tier table (lib/room/tier.ts).
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  return NextResponse.json(await clientTier(ctx.session.brokerId, ctx.session.clientId));
}
