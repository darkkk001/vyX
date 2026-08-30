import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { getOrderAckStats } from "@/lib/order-latency";

// Phase 0 money-risk patch item 3 (docs/ROADMAP.md) -- legacy Next.js/
// Vercel path's own order-ack latency, read straight from Redis (see
// lib/order-latency.ts's own comment on why: this route runs as a Vercel
// serverless function, no shared in-process memory across invocations,
// unlike the Rust/gateway path's own window in
// services/api-gateway/src/ws.ts's gatewayStats, which is a genuinely
// long-running process). No internal-service-secret hop needed here
// (unlike app/api/manage/feed-health/route.ts's two probes) -- this data
// already lives inside this same Vercel deployment, gated on the
// ordinary admin session like every other /api/manage/* route.
export async function GET() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const stats = await getOrderAckStats(session!.brokerId!);
  return NextResponse.json(stats);
}
