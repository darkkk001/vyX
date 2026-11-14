import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { clientRef, handleOf } from "@/lib/crm/core";

// CRM — CLIENTS. Stage: DORMANT = no sign-in and no closed trade for 60 days (and registered over 60 days ago),
// else FUNDED = a completed deposit on a live account, else ACTIVE. Money figures over LIVE accounts only, in the
// broker's default currency (an account in another currency is left out of the sums and counted in `otherCurrency`).

const DAY = 86400e3;
export type Stage = "ACTIVE" | "FUNDED" | "DORMANT";

export async function crmClientRows(brokerId: string, now = new Date()) {
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true } });
  const ccy = broker.defaultAccountCurrency;
  const clients = await prisma.client.findMany({
    where: { brokerId },
    select: {
      id: true, clientNumber: true, fullName: true, email: true, phone: true, country: true, createdAt: true, lastLoginAt: true, ownerAdminId: true, source: true, status: true,
      referredByClientId: true,
      kycRecord: { select: { status: true } },
      accounts: { select: { id: true, accountMode: true, balance: true, currency: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 5000,
  });
  const liveIds = clients.flatMap((c) => c.accounts.filter((a) => a.accountMode === "LIVE").map((a) => a.id));
  const [deposits, lastTrades] = liveIds.length
    ? await Promise.all([
        prisma.transaction.groupBy({ by: ["accountId"], where: { accountId: { in: liveIds }, type: "DEPOSIT", status: "COMPLETED" }, _sum: { amount: true } }),
        prisma.position.groupBy({ by: ["accountId"], where: { accountId: { in: liveIds }, status: "CLOSED" }, _max: { closedAt: true } }),
      ])
    : [[], []];
  const depBy = new Map(deposits.map((d) => [d.accountId, d._sum.amount ?? new Prisma.Decimal(0)]));
  const tradeBy = new Map(lastTrades.map((t) => [t.accountId, t._max.closedAt]));
  const owners = await prisma.adminUser.findMany({ where: { brokerId }, select: { id: true, email: true } });
  const handle = new Map(owners.map((o) => [o.id, handleOf(o.email)]));
  // owner 2026-11-14: the referrer (the client whose link this one signed up through), shown in OWNER when no staff member is assigned
  const refIds = [...new Set(clients.map((c) => c.referredByClientId).filter((x): x is string => !!x))];
  const referrers = refIds.length
    ? await prisma.client.findMany({ where: { id: { in: refIds }, brokerId }, select: { id: true, clientNumber: true } })
    : [];
  const refBy = new Map(referrers.map((r) => [r.id, clientRef(r.clientNumber)]));
  return clients.map((c) => {
    const live = c.accounts.filter((a) => a.accountMode === "LIVE" && a.currency === ccy);
    const balance = live.reduce((s, a) => s.add(a.balance), new Prisma.Decimal(0));
    const depositsLtd = live.reduce((s, a) => s.add(depBy.get(a.id) ?? 0), new Prisma.Decimal(0));
    const lastTrade = c.accounts.map((a) => tradeBy.get(a.id)).filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const lastSeen = [c.lastLoginAt, lastTrade].filter((x): x is Date => !!x).sort((a, b) => b.getTime() - a.getTime())[0] ?? null;
    const cutoff = now.getTime() - 60 * DAY;
    const dormant = c.createdAt.getTime() < cutoff && (!lastSeen || lastSeen.getTime() < cutoff);
    const stage: Stage = dormant ? "DORMANT" : depositsLtd.gt(0) ? "FUNDED" : "ACTIVE";
    return {
      id: c.id,
      ref: clientRef(c.clientNumber),
      fullName: c.fullName,
      email: c.email,
      kyc: c.kycRecord?.status ?? "NONE",
      accounts: c.accounts.length,
      balance: balance.toFixed(2),
      depositsLtd: depositsLtd.toFixed(2),
      lastLoginAt: c.lastLoginAt?.toISOString() ?? null,
      owner: c.ownerAdminId ? { id: c.ownerAdminId, handle: handle.get(c.ownerAdminId) ?? "STAFF" } : null,
      referrer: c.referredByClientId && refBy.has(c.referredByClientId) ? { id: c.referredByClientId, ref: refBy.get(c.referredByClientId)! } : null,
      stage,
      suspended: c.status !== "ACTIVE",
      otherCurrency: c.accounts.some((a) => a.accountMode === "LIVE" && a.currency !== ccy),
      createdAt: c.createdAt.toISOString(),
    };
  });
}

export async function deposits30d(brokerId: string, now = new Date()) {
  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { defaultAccountCurrency: true } });
  const agg = await prisma.transaction.aggregate({
    where: { brokerId, type: "DEPOSIT", status: "COMPLETED", updatedAt: { gte: new Date(now.getTime() - 30 * DAY) }, account: { accountMode: "LIVE", currency: broker.defaultAccountCurrency, clientId: { not: null } } },
    _sum: { amount: true },
  });
  return { amount: (agg._sum.amount ?? new Prisma.Decimal(0)).toFixed(2), currency: broker.defaultAccountCurrency };
}
