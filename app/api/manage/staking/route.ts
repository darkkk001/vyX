import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getAdminSession } from "@/lib/auth";
import { forbidUnlessPermissionOrSupportReader } from "@/lib/permissions";
import { planOf } from "@/lib/room/staking";

// The backoffice's staking view: total staked, stakes per client, upcoming payouts and the broker's settings. Settings are
// written through PATCH /api/manage/crm/settings.
export async function GET() {
  const session = await getAdminSession();
  if (await forbidUnlessPermissionOrSupportReader(session, "REPORTS")) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  const brokerId = session!.brokerId!;
  const [broker, active, paid] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { stakingEnabled: true, stakingMinAmount: true, stakingCycleDays: true, stakingRatePct: true } }),
    prisma.stake.findMany({ where: { brokerId, status: "ACTIVE" }, orderBy: { endAt: "asc" }, include: { client: { select: { id: true, fullName: true, email: true } }, account: { select: { accountNumber: true } } } }),
    prisma.stake.aggregate({ where: { brokerId, status: "PAID" }, _sum: { amount: true, returnAmount: true }, _count: true }),
  ]);
  const totals = new Map<string, { staked: number; returns: number }>();
  const clients = new Map<string, { clientId: string; name: string; email: string; stakes: number; staked: number }>();
  for (const s of active) {
    const t = totals.get(s.currency) ?? { staked: 0, returns: 0 };
    t.staked += s.amount.toNumber(); t.returns += s.returnAmount.toNumber();
    totals.set(s.currency, t);
    const c = clients.get(s.clientId) ?? { clientId: s.clientId, name: s.client.fullName, email: s.client.email, stakes: 0, staked: 0 };
    c.stakes += 1; c.staked += s.amount.toNumber();
    clients.set(s.clientId, c);
  }
  return NextResponse.json({
    settings: { enabled: broker.stakingEnabled, ...planOf(broker) },
    totals: [...totals].map(([currency, t]) => ({ currency, staked: t.staked.toFixed(2), returnsDue: t.returns.toFixed(2) })),
    clients: [...clients.values()].map((c) => ({ ...c, staked: c.staked.toFixed(2) })),
    upcoming: active.slice(0, 100).map((s) => ({ id: s.id, client: s.client.fullName, account: s.account.accountNumber, amount: s.amount.toFixed(2), returnAmount: s.returnAmount.toFixed(2), currency: s.currency, endAt: s.endAt.toISOString() })),
    paid: { count: paid._count, amount: (paid._sum.amount?.toNumber() ?? 0).toFixed(2), returns: (paid._sum.returnAmount?.toNumber() ?? 0).toFixed(2) },
  });
}
