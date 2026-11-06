import "server-only";
import { prisma } from "@/lib/prisma";

// My Tier (Phase B, artboard "My tier & volume"). A client's tier is set at each monthly review (the 1st of the month,
// 00:00 UTC) from the lots their LIVE accounts closed in the 90 days before it, and holds until the next review.
// Thresholds and benefits are the broker's (Broker.tierConfig); unset = Silver 0, Gold 150, Platinum 500 lots and no
// benefits listed (a benefit is a promise the broker has to make itself). A tier's maxLeverage, when set, lifts the
// plan's leverage ceiling for the client's own leverage changes.

export type TierDef = { name: string; minLots: number; benefits: string[]; maxLeverage: number | null };
export const DEFAULT_TIERS: TierDef[] = [
  { name: "Silver", minLots: 0, benefits: [], maxLeverage: null },
  { name: "Gold", minLots: 150, benefits: [], maxLeverage: null },
  { name: "Platinum", minLots: 500, benefits: [], maxLeverage: null },
];

export function tiersOf(config: unknown): TierDef[] {
  const raw = (config as { tiers?: unknown } | null)?.tiers;
  if (!Array.isArray(raw) || raw.length === 0) return DEFAULT_TIERS;
  const out: TierDef[] = [];
  for (const t of raw) {
    const r = t as Record<string, unknown>;
    const name = typeof r.name === "string" ? r.name.trim().slice(0, 24) : "";
    const minLots = Number(r.minLots);
    if (!name || !Number.isFinite(minLots) || minLots < 0) continue;
    const benefits = Array.isArray(r.benefits) ? r.benefits.filter((b): b is string => typeof b === "string" && b.trim() !== "").map((b) => b.trim().slice(0, 80)).slice(0, 8) : [];
    const ml = Number(r.maxLeverage);
    out.push({ name, minLots, benefits, maxLeverage: Number.isInteger(ml) && ml > 0 ? ml : null });
  }
  return out.length ? out.sort((a, b) => a.minLots - b.minLots) : DEFAULT_TIERS;
}

export function tierFor(tiers: TierDef[], lots: number): TierDef {
  let cur = tiers[0];
  for (const t of tiers) if (lots >= t.minLots) cur = t;
  return cur;
}

const DAY = 86400e3;
export function reviewDates(now: Date, back: number): Date[] {
  const out: Date[] = [];
  for (let i = 0; i <= back; i++) out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
  return out; // newest first
}

/** Since when the client has held the current tier: the oldest review in an unbroken run of it, never before they joined.
 *  reviews and atReview are newest first; a quiet client sits on the lowest tier at every review, joined or not. */
export function tierSince(reviews: Date[], atReview: { name: string }[], joinedAt: Date): Date {
  let since = reviews[0];
  for (let i = 1; i < reviews.length && atReview[i].name === atReview[0].name; i++) since = reviews[i];
  return since < joinedAt ? joinedAt : since;
}

export async function clientTier(brokerId: string, clientId: string, now = new Date()) {
  const [broker, client, accounts] = await Promise.all([
    prisma.broker.findUniqueOrThrow({ where: { id: brokerId }, select: { tierConfig: true } }),
    prisma.client.findUniqueOrThrow({ where: { id: clientId }, select: { createdAt: true } }),
    prisma.account.findMany({ where: { clientId, brokerId, accountMode: "LIVE", isWallet: false }, select: { id: true, accountNumber: true } }),
  ]);
  const tiers = tiersOf(broker.tierConfig);
  const ids = accounts.map((a) => a.id);
  const reviews = reviewDates(now, 12);
  const oldest = new Date(reviews[reviews.length - 1].getTime() - 90 * DAY);
  // one read: every close in the last ~15 months; the all-time total as one sum
  const [closes, all] = ids.length
    ? await Promise.all([
        prisma.position.findMany({ where: { accountId: { in: ids }, status: "CLOSED", deletedAt: null, closedAt: { gte: oldest } }, select: { accountId: true, volume: true, initialVolume: true, closedAt: true } }),
        prisma.$queryRaw<{ s: number | null }[]>`SELECT SUM(COALESCE(p."initialVolume", p.volume))::float8 AS s FROM "Position" p WHERE p."accountId" = ANY(${ids}) AND p.status = 'CLOSED' AND p."deletedAt" IS NULL`,
      ])
    : [[], [{ s: 0 }]];
  const rows = closes.map((r) => ({ accountId: r.accountId, lots: (r.initialVolume ?? r.volume).toNumber(), at: (r.closedAt ?? now).getTime() }));
  const lotsIn = (from: number, to: number, accountId?: string) => rows.reduce((s, r) => s + (r.at >= from && r.at < to && (!accountId || r.accountId === accountId) ? r.lots : 0), 0);

  const atReview = reviews.map((r) => tierFor(tiers, lotsIn(r.getTime() - 90 * DAY, r.getTime())));
  const current = atReview[0];
  const since = tierSince(reviews, atReview, client.createdAt);

  const t = now.getTime() + 1;
  const from90 = now.getTime() - 90 * DAY;
  const lots90 = lotsIn(from90, t);
  const idx = tiers.findIndex((x) => x.name === current.name);
  const next = tiers[idx + 1] ?? null;
  return {
    tiers,
    current: current.name,
    since: since.toISOString(),
    nextReview: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString(),
    next: next ? { name: next.name, minLots: next.minLots, missing: Math.max(0, next.minLots - lots90).toFixed(1) } : null,
    lots90: lots90.toFixed(1),
    lotsMonth: lotsIn(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1), t).toFixed(1),
    lotsAll: (all[0]?.s ?? 0).toFixed(1),
    hasLiveAccount: accounts.length > 0,
    perAccount: accounts.map((a) => ({ accountNumber: a.accountNumber, lots: lotsIn(from90, t, a.id).toFixed(1) })),
    maxLeverage: current.maxLeverage,
  };
}

/** The tier's leverage ceiling for this client (null = the plan decides alone). Cheap path for the leverage checks. */
export async function tierLeverageCeiling(brokerId: string, clientId: string): Promise<number | null> {
  const broker = await prisma.broker.findUnique({ where: { id: brokerId }, select: { tierConfig: true } });
  const tiers = tiersOf(broker?.tierConfig);
  if (!tiers.some((t) => t.maxLeverage)) return null;
  const t = await clientTier(brokerId, clientId);
  return t.maxLeverage;
}
