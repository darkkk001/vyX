import type { PrismaClient, Prisma } from "@prisma/client";

// Impression Pack #4 -- Client Risk Radar v1. No ML: every metric here is
// a plain aggregate or a documented threshold rule over each account's
// own closed-position history, computed fresh from Postgres on every
// call (the 5-min cache lives in the route, not here, so this function
// itself stays trivially testable with a fake position list).
export type RiskRadarPosition = {
  accountId: string;
  volume: number;
  realizedPnl: number | null;
  openedAt: Date;
  closedAt: Date;
};

export type RiskRadarRow = {
  accountId: string;
  accountNumber: string;
  trades30d: number;
  winRatePct: number | null;
  avgHoldMinutes: number | null;
  avgLot: number | null;
  profitVelocityPerDay: number;
  scalpFlag: boolean;
  martingaleFlag: boolean;
  latencyArbFlag: boolean;
  // Always false today -- see this file's own top-of-function comment on
  // why (no historical economic-calendar data source exists in this
  // codebase; /api/trade/news is forward-looking only, and Finnhub's
  // configured key doesn't have access to that endpoint at all -- see
  // lib/economic-calendar.ts's own note). The column stays visible and
  // clearly labeled rather than silently omitted, since "we don't have
  // this data yet" is itself useful information for whoever's looking at
  // this table.
  newsTraderFlag: boolean;
};

const WINDOW_DAYS = 30;
const SCALP_THRESHOLD_MINUTES = 2;
// A trade whose volume is at least this multiple of the immediately
// preceding LOSING trade's volume, repeated at least MARTINGALE_MIN_HITS
// times across the window, reads as "sizing up after a loss" -- the
// textbook martingale pattern. Doesn't try to detect a strict doubling
// specifically (real martingale sizing varies), just "meaningfully
// bigger, repeatedly, right after losing."
const MARTINGALE_SIZE_MULTIPLIER = 1.5;
const MARTINGALE_MIN_HITS = 3;

export function computeMartingaleFlag(positionsOrderedByClose: RiskRadarPosition[]): boolean {
  let hits = 0;
  for (let i = 1; i < positionsOrderedByClose.length; i++) {
    const prev = positionsOrderedByClose[i - 1];
    const curr = positionsOrderedByClose[i];
    const prevWasLoss = (prev.realizedPnl ?? 0) < 0;
    if (prevWasLoss && curr.volume >= prev.volume * MARTINGALE_SIZE_MULTIPLIER) {
      hits++;
    }
  }
  return hits >= MARTINGALE_MIN_HITS;
}

// Latency-arbitrage detection -- a trader exploiting feed latency looks
// different from an ordinary scalper: scalpFlag above only measures the
// AVERAGE hold time across every trade, which can't tell "consistently
// quick, evenly-distributed outcomes" apart from "a small burst of
// extremely fast trades that win far more often than this account's own
// normal trading does" -- the latter is the actual tell (catching a
// stale-quote window reliably wins; normal fast scalping doesn't win at
// anywhere near that rate). Needs no new schema/data source -- built
// from the exact same closed-position fields (openedAt/closedAt/
// realizedPnl) every other flag here already loads.
const LATENCY_ARB_MAX_HOLD_SECONDS = 3;
const LATENCY_ARB_MIN_FAST_TRADES = 10;
const LATENCY_ARB_WIN_RATE_DELTA_PCT = 25;

export function computeLatencyArbFlag(positions: RiskRadarPosition[]): boolean {
  const overallWins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const overallWinRate = positions.length > 0 ? (overallWins / positions.length) * 100 : 0;

  const fastTrades = positions.filter((p) => (p.closedAt.getTime() - p.openedAt.getTime()) / 1000 <= LATENCY_ARB_MAX_HOLD_SECONDS);
  if (fastTrades.length < LATENCY_ARB_MIN_FAST_TRADES) return false;

  const fastWins = fastTrades.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const fastWinRate = (fastWins / fastTrades.length) * 100;

  return fastWinRate >= overallWinRate + LATENCY_ARB_WIN_RATE_DELTA_PCT;
}

export function computeRiskRadarRow(accountId: string, accountNumber: string, positions: RiskRadarPosition[]): RiskRadarRow {
  const trades30d = positions.length;
  if (trades30d === 0) {
    return {
      accountId, accountNumber, trades30d: 0, winRatePct: null, avgHoldMinutes: null, avgLot: null,
      profitVelocityPerDay: 0, scalpFlag: false, martingaleFlag: false, latencyArbFlag: false, newsTraderFlag: false,
    };
  }

  const wins = positions.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const totalHoldMinutes = positions.reduce((sum, p) => sum + (p.closedAt.getTime() - p.openedAt.getTime()) / 60_000, 0);
  const totalVolume = positions.reduce((sum, p) => sum + p.volume, 0);
  const totalPnl = positions.reduce((sum, p) => sum + (p.realizedPnl ?? 0), 0);

  const orderedByClose = [...positions].sort((a, b) => a.closedAt.getTime() - b.closedAt.getTime());

  return {
    accountId,
    accountNumber,
    trades30d,
    winRatePct: (wins / trades30d) * 100,
    avgHoldMinutes: totalHoldMinutes / trades30d,
    avgLot: totalVolume / trades30d,
    profitVelocityPerDay: totalPnl / WINDOW_DAYS,
    scalpFlag: totalHoldMinutes / trades30d < SCALP_THRESHOLD_MINUTES,
    martingaleFlag: computeMartingaleFlag(orderedByClose),
    latencyArbFlag: computeLatencyArbFlag(positions),
    newsTraderFlag: false,
  };
}

export async function computeRiskRadar(prisma: PrismaClient, brokerId: string): Promise<RiskRadarRow[]> {
  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const accounts = await prisma.account.findMany({
    where: { brokerId },
    select: { id: true, accountNumber: true },
  });

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "CLOSED", closedAt: { gte: since, not: null } },
    select: { accountId: true, volume: true, realizedPnl: true, openedAt: true, closedAt: true },
  });

  const byAccount = new Map<string, RiskRadarPosition[]>();
  for (const p of positions) {
    if (!p.closedAt) continue;
    const list = byAccount.get(p.accountId) ?? [];
    list.push({
      accountId: p.accountId,
      volume: (p.volume as Prisma.Decimal).toNumber(),
      realizedPnl: p.realizedPnl ? (p.realizedPnl as Prisma.Decimal).toNumber() : null,
      openedAt: p.openedAt,
      closedAt: p.closedAt,
    });
    byAccount.set(p.accountId, list);
  }

  return accounts
    .map((a) => computeRiskRadarRow(a.id, a.accountNumber, byAccount.get(a.id) ?? []))
    .filter((r) => r.trades30d > 0);
}

// Same-IP multi-account detection -- a cross-account query (unlike every
// flag above, which is scoped to one account at a time), so it lives as
// its own function rather than folded into computeRiskRadarRow. Reads
// LoginEvent (durable per-login IP record -- see that model's own doc
// comment on why Redis session metadata alone couldn't answer this).
// Deliberately a REVIEW list, not an auto-flag on the account itself:
// shared IPs have real innocent causes (family wifi, corporate NAT,
// this broker's own QA/test accounts sharing one machine), so a human
// still needs to look at each cluster.
const SAME_IP_WINDOW_DAYS = 30;

export type SameIpAccount = { accountId: string; accountNumber: string; fullName: string; email: string };
export type SameIpCluster = { ipAddress: string; accounts: SameIpAccount[] };

export async function computeSameIpClusters(prisma: PrismaClient, brokerId: string): Promise<SameIpCluster[]> {
  const since = new Date(Date.now() - SAME_IP_WINDOW_DAYS * 24 * 60 * 60 * 1000);

  const events = await prisma.loginEvent.findMany({
    where: { brokerId, createdAt: { gte: since } },
    select: {
      ipAddress: true,
      account: { select: { id: true, accountNumber: true, fullName: true, email: true } },
    },
  });

  const byIp = new Map<string, Map<string, SameIpAccount>>();
  for (const e of events) {
    let accountsForIp = byIp.get(e.ipAddress);
    if (!accountsForIp) {
      accountsForIp = new Map();
      byIp.set(e.ipAddress, accountsForIp);
    }
    accountsForIp.set(e.account.id, {
      accountId: e.account.id,
      accountNumber: e.account.accountNumber,
      fullName: e.account.fullName,
      email: e.account.email,
    });
  }

  const clusters: SameIpCluster[] = [];
  for (const [ipAddress, accountsMap] of byIp) {
    const accounts = [...accountsMap.values()];
    if (accounts.length < 2) continue;
    // Exclude a legitimate linked demo/live pair (or more) under ONE
    // owner -- only a genuine cross-owner share (>= 2 distinct emails)
    // is worth a human's review time.
    const distinctEmails = new Set(accounts.map((a) => a.email));
    if (distinctEmails.size < 2) continue;
    clusters.push({ ipAddress, accounts });
  }

  return clusters.sort((a, b) => b.accounts.length - a.accounts.length);
}
