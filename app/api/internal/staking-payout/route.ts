import { NextRequest, NextResponse } from "next/server";
import { bearerMatches } from "@/lib/internal-auth";
import { payDueStakes } from "@/lib/room/staking";

// Vercel Cron (vercel.json), same bearer secret as swap-rollover: pays every stake whose cycle has ended, for every broker.
export async function GET(request: NextRequest) {
  if (!bearerMatches(request.headers.get("authorization"), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return NextResponse.json(await payDueStakes());
}
