import { NextResponse } from "next/server";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { bridgeConsole, bridgeStatus } from "@/lib/bridge-status";
import { prisma } from "@/lib/prisma";

// GET /api/manage/liquidity/status: the Liquidity screen's badge (owner 2026-10-23). Any staff of the broker; plain
// words only ("Connected" / "Degraded" / "Not connected"), when it last changed, and when the bridge last reported.
//
// Phase 2.1 #4 (the status console): `console` = the bridge's v2 detail (per-lane health, held intents, license state,
// overall health) with each lane's LP name joined from this broker's providers, or null when the bridge reports no v2
// fields or has stopped reporting. Only for the staff who may open the Liquidity providers screen (BROKER_ADMIN, the
// LP routes' rule); for everyone else the answer is the badge alone, as before, with no LP names or internals.
export async function GET() {
  const session = await getAdminSession();
  if (!session?.brokerId) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session.brokerId;
  const status = await bridgeStatus(brokerId);
  if (!requireAdminRole(session, ["BROKER_ADMIN"])) return NextResponse.json(status);
  const lpNames = async (ids: string[]) =>
    new Map((await prisma.liquidityProvider.findMany({ where: { brokerId, id: { in: ids } }, select: { id: true, name: true } })).map((p) => [p.id, p.name]));
  return NextResponse.json({ ...status, console: await bridgeConsole(brokerId, lpNames) });
}
