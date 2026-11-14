import "server-only";
import crypto from "node:crypto";
import { Prisma, type PrismaClient } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { computePendingCommission } from "@/lib/commission";

// Partner (IB) portal (Phase C). The broker makes a client a partner in the backoffice (Client.partnerAccountId = the
// account that receives the commissions, the existing IbRelationship.ibAccountId). Clients who sign up through the
// partner's link carry referredByClientId; each LIVE account they open is attached to the partner (IbRelationship,
// PER_LOT at the plan's rate from IbPlanRate, 0 until the broker sets one). Commission, accrual, suspension and payouts
// are the existing IB backend (lib/commission.ts, lib/ib-payout.ts); this file only reads it for the client.

type Db = PrismaClient | Prisma.TransactionClient;

/** Partner account of the client: the one the broker set, else an account that already is an IB. */
export async function partnerAccountOf(db: Db, clientId: string): Promise<{ id: string; accountNumber: string; ibSuspendedAt: Date | null } | null> {
  const c = await db.client.findUnique({ where: { id: clientId }, select: { partnerAccountId: true } });
  if (c?.partnerAccountId) {
    const a = await db.account.findFirst({ where: { id: c.partnerAccountId, clientId }, select: { id: true, accountNumber: true, ibSuspendedAt: true } });
    if (a) return a;
  }
  const rel = await db.ibRelationship.findFirst({ where: { ibAccount: { clientId } }, select: { ibAccount: { select: { id: true, accountNumber: true, ibSuspendedAt: true } } } });
  return rel?.ibAccount ?? null;
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O, 1/I: read off a card
const randomChars = (n: number) => Array.from({ length: n }, () => CODE_CHARS[crypto.randomInt(CODE_CHARS.length)]).join("");

/** A new referral code (owner 2026-11-14): 8-9 characters, up to 5 letters of the name then 4 random ("JADES7K2Q");
 *  a name with fewer than 4 letters is filled up to 4 with random ones. Codes made before keep working as they are. */
export function newReferralCode(fullName: string): string {
  const letters = fullName.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 5);
  return `${letters}${randomChars(Math.max(0, 4 - letters.length))}${randomChars(4)}`;
}

/** The client's referral code, made on first use (every client, owner 2026-11-14), unique. */
export async function referralCodeOf(clientId: string): Promise<string> {
  const c = await prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { referralCode: true, fullName: true } });
  if (c.referralCode) return c.referralCode;
  for (let i = 0; i < 8; i++) {
    const code = newReferralCode(c.fullName);
    const done = await prisma.client.updateMany({ where: { id: clientId, referralCode: null }, data: { referralCode: code } }).catch(() => ({ count: 0 }));
    if (done.count === 1) return code;
    const again = await prisma.client.findUnique({ where: { id: clientId }, select: { referralCode: true } });
    if (again?.referralCode) return again.referralCode;
  }
  throw new Error("could not make a referral code");
}

/** At account creation (lib/account-provisioning.ts, same transaction): a referred client's LIVE account joins the partner. */
export async function attachReferredAccount(tx: Prisma.TransactionClient, p: { brokerId: string; clientId: string | null; accountId: string; accountMode: string; groupId: string | null }) {
  if (!p.clientId || p.accountMode !== "LIVE") return;
  const client = await tx.client.findUnique({ where: { id: p.clientId }, select: { referredByClientId: true } });
  if (!client?.referredByClientId) return;
  const partner = await partnerAccountOf(tx, client.referredByClientId);
  if (!partner || partner.id === p.accountId) return;
  const rate = p.groupId ? await tx.ibPlanRate.findUnique({ where: { brokerId_groupId: { brokerId: p.brokerId, groupId: p.groupId } }, select: { ratePerLot: true } }) : null;
  const rel = await tx.ibRelationship.create({
    data: { brokerId: p.brokerId, ibAccountId: partner.id, clientAccountId: p.accountId, commissionType: "PER_LOT", commissionRate: rate?.ratePerLot ?? new Prisma.Decimal(0) },
  });
  await tx.auditLog.create({
    data: { brokerId: p.brokerId, clientId: client.referredByClientId, action: "IB_CLIENT_ATTACHED", entityType: "IbRelationship", entityId: rel.id, newValue: { ibAccountId: partner.id, clientAccountId: p.accountId, ratePerLot: (rate?.ratePerLot ?? 0).toString(), source: "REFERRAL_LINK" } },
  });
}

/** "500044··": the account number with its last two digits hidden (a partner never sees who their clients are). */
export function maskAccount(n: string): string {
  return n.length > 2 ? `${n.slice(0, -2)}··` : "··";
}

const ZERO = new Prisma.Decimal(0);

/**
 * The partner wallet of the top-bar money menu (owner 2026-11-10): the unpaid commission, by the same rule as
 * partnerSummary's stats.unpaid (computePendingCommission over every link of the partner account), without the rest of
 * the summary. null = the client is no IB.
 */
export async function partnerUnpaid(brokerId: string, clientId: string): Promise<{ accountNumber: string; unpaid: Prisma.Decimal } | null> {
  const partner = await partnerAccountOf(prisma, clientId);
  if (!partner) return null;
  const rels = await prisma.ibRelationship.findMany({
    where: { brokerId, ibAccountId: partner.id },
    select: { id: true, clientAccountId: true, ibAccountId: true, commissionType: true, commissionRate: true, lastPayoutAt: true, accruedUnpaid: true, accruedThrough: true, createdAt: true },
  });
  const unpaid = (await Promise.all(rels.map((r) => computePendingCommission(prisma, r)))).reduce((s, x) => s.add(x), ZERO);
  return { accountNumber: partner.accountNumber, unpaid };
}

export async function partnerSummary(brokerId: string, clientId: string, month: Date) {
  const partner = await partnerAccountOf(prisma, clientId);
  if (!partner) return null;
  const monthStart = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const monthEnd = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
  const rels = await prisma.ibRelationship.findMany({
    where: { brokerId, ibAccountId: partner.id },
    select: { id: true, clientAccountId: true, ibAccountId: true, commissionType: true, commissionRate: true, lastPayoutAt: true, accruedUnpaid: true, accruedThrough: true, createdAt: true, clientAccount: { select: { accountNumber: true } } },
    orderBy: { createdAt: "asc" },
  });
  const ids = rels.map((r) => r.clientAccountId);
  const [monthCloses, allLots, paid, pendingReq, payouts, rates] = await Promise.all([
    ids.length ? prisma.position.findMany({ where: { accountId: { in: ids }, status: "CLOSED", deletedAt: null, closedAt: { gte: monthStart, lt: monthEnd } }, select: { accountId: true, volume: true, initialVolume: true, commission: true } }) : [],
    ids.length ? prisma.$queryRaw<{ s: number | null }[]>`SELECT SUM(COALESCE(p."initialVolume", p.volume))::float8 AS s FROM "Position" p WHERE p."accountId" = ANY(${ids}) AND p.status = 'CLOSED' AND p."deletedAt" IS NULL` : [{ s: 0 }],
    prisma.transaction.aggregate({ where: { accountId: partner.id, type: "COMMISSION", referenceType: "IbRelationship", status: "COMPLETED" }, _sum: { amount: true } }),
    prisma.ibPayoutRequest.findFirst({ where: { clientId, status: "PENDING" }, select: { id: true, amount: true, createdAt: true } }),
    prisma.transaction.findMany({ where: { accountId: partner.id, type: "COMMISSION", referenceType: "IbRelationship", status: "COMPLETED" }, select: { id: true, amount: true, createdAt: true }, orderBy: { createdAt: "desc" }, take: 200 }),
    prisma.ibPlanRate.findMany({ where: { brokerId }, select: { groupId: true, ratePerLot: true } }),
  ]);
  const unpaid = (await Promise.all(rels.map((r) => computePendingCommission(prisma, r)))).reduce((s, x) => s.add(x), ZERO);

  // this month, per client: lots closed and the commission they earned at the link's rate
  const perClient = rels.map((r) => {
    const own = monthCloses.filter((c) => c.accountId === r.clientAccountId);
    const lots = own.reduce((s, c) => s + (c.initialVolume ?? c.volume).toNumber(), 0);
    const commission = r.commissionType === "PER_LOT"
      ? r.commissionRate.mul(lots).toNumber()
      : r.commissionRate.div(100).mul(own.reduce((s, c) => s.add(c.commission), ZERO)).toNumber();
    return { client: maskAccount(r.clientAccount.accountNumber), joined: r.createdAt.toISOString(), lots: lots.toFixed(1), commission: commission.toFixed(2) };
  });

  // payouts: one staff "pay" books a row per link at the same moment; rows within a minute are one payout
  const groups: { id: string; at: Date; amount: Prisma.Decimal }[] = [];
  for (const t of payouts) {
    const last = groups[groups.length - 1];
    if (last && Math.abs(last.at.getTime() - t.createdAt.getTime()) < 60_000) last.amount = last.amount.add(t.amount);
    else groups.push({ id: t.id, at: t.createdAt, amount: t.amount });
  }
  const groupsById = new Map((await prisma.group.findMany({ where: { id: { in: rates.map((r) => r.groupId) } }, select: { id: true, displayName: true } })).map((g) => [g.id, g.displayName]));
  const planRates = new Map<string, string>();
  for (const r of rates) { const name = groupsById.get(r.groupId); if (name && !planRates.has(name)) planRates.set(name, r.ratePerLot.toFixed(2)); }

  const earned = (paid._sum.amount ?? ZERO).add(unpaid);
  return {
    partnerAccount: partner.accountNumber,
    suspended: Boolean(partner.ibSuspendedAt),
    stats: {
      clients: rels.length,
      activeThisMonth: perClient.filter((c) => Number(c.lots) > 0).length,
      lots: (allLots[0]?.s ?? 0).toFixed(1),
      earned: earned.toFixed(2),
      unpaid: unpaid.toFixed(2),
    },
    month: monthStart.toISOString(),
    perClient: perClient.filter((c) => Number(c.lots) > 0 || new Date(c.joined) >= monthStart).sort((a, b) => Number(b.commission) - Number(a.commission)),
    rates: [...planRates.entries()].map(([plan, perLot]) => ({ plan, perLot })),
    payouts: groups.slice(0, 12).map((g) => ({ ref: `PAY-${g.id.slice(-4).toUpperCase()}`, at: g.at.toISOString(), amount: g.amount.toFixed(2), status: "Paid" })),
    pendingRequest: pendingReq ? { amount: pendingReq.amount.toFixed(2), at: pendingReq.createdAt.toISOString() } : null,
  };
}
