import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { computeRiskRadarRow } from "@/lib/risk-radar";

const WINDOW_DAYS = 30;

// The account's Risk Radar signals for the client-detail header. NOT a composite
// score (a weighted score is a separate design pass) -- this surfaces the raw
// signals the same way the RDR screen does: 30-day trade count, win rate, avg
// hold, avg lot, the martingale / latency-arb / scalp flags, and the count of
// other accounts sharing an IP with this one (LoginEvent).
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN", "SUPPORT"]) /* SUPPORT: read-only support role, lib/permissions.ts isSupportReader */ || !session!.brokerId) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const brokerId = session!.brokerId!;

  const account = await prisma.account.findUnique({ where: { id }, select: { brokerId: true, accountNumber: true } });
  if (!account || account.brokerId !== brokerId) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const positions = await prisma.position.findMany({
    where: { accountId: id, status: "CLOSED", closedAt: { gte: since } },
    select: { volume: true, realizedPnl: true, openedAt: true, closedAt: true },
  });
  const row = computeRiskRadarRow(
    id,
    account.accountNumber,
    positions.map((p) => ({
      accountId: id,
      volume: Number(p.volume),
      realizedPnl: p.realizedPnl === null ? null : Number(p.realizedPnl),
      openedAt: p.openedAt,
      closedAt: p.closedAt ?? p.openedAt,
    }))
  );

  // same-IP: other accounts (this broker) that logged in from any IP this account used
  const myIps = await prisma.loginEvent.findMany({ where: { accountId: id }, distinct: ["ipAddress"], select: { ipAddress: true } });
  let sameIpAccounts = 0;
  if (myIps.length > 0) {
    const others = await prisma.loginEvent.findMany({
      where: { brokerId, ipAddress: { in: myIps.map((e) => e.ipAddress) }, accountId: { not: id } },
      distinct: ["accountId"],
      select: { accountId: true },
    });
    sameIpAccounts = others.length;
  }

  return NextResponse.json({
    trades30d: row.trades30d,
    winRatePct: row.winRatePct,
    avgHoldMinutes: row.avgHoldMinutes,
    avgLot: row.avgLot,
    scalpFlag: row.scalpFlag,
    martingaleFlag: row.martingaleFlag,
    latencyArbFlag: row.latencyArbFlag,
    sameIpAccounts,
  });
}
