import { NextResponse } from "next/server";
import { roomApiSession } from "@/lib/room/context";
import { roomSpecs } from "@/lib/room/specs";

// GET: Contract specifications, per plan and symbol, from the broker's live configuration (lib/room/specs.ts).
export async function GET() {
  const ctx = await roomApiSession();
  if ("response" in ctx) return ctx.response;
  return NextResponse.json({ plans: await roomSpecs(ctx.session.brokerId) });
}
