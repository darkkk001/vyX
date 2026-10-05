import { Prisma, type PrismaClient } from "@prisma/client";
import { newsHistoryFrom } from "@/lib/economic-events";

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
  // web4 (issues.md 151, owner 2026-09-30): computed from the high-impact event history (EconomicEvent), see
  // computeNewsTraderFlag below. false while nothing qualifies, and always false for trades before the history starts.
  newsTraderFlag: boolean;
  // web4: the evidence behind newsTraderFlag (absent / null when there is no event history yet)
  news?: NewsTraderEvidence | null;
};

export type NewsTrade = { openedAt: Date; currencies: string[]; closed: boolean; realizedPnl: Prisma.Decimal | null };
export type NewsEvent = { eventAt: Date; currency: string };
export type NewsTraderEvidence = {
  flag: boolean;
  newsTrades: number; // trades opened within +/-2 min of a matching high-impact event
  totalTrades: number; // trades opened in the window
  sharePct: number | null;
  netPnl: string; // realized P/L of the CLOSED news trades, in the account currency, 2 dp
  currency: string;
  openNewsTrades: number; // news trades still open: counted in newsTrades / sharePct, not in netPnl
  windowFrom: string; // ISO: the start actually used (the later of 30 days ago and the history start)
  collectingHistory: boolean; // true while the history is shorter than the 30-day window
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

// web4 (issues.md 151, owner 2026-09-30): news trading. Over the window, a trade is a NEWS trade when it was OPENED
// within +/-2 minutes (inclusive, to the millisecond: 2:00 counts, 2:01 does not) of a HIGH-impact economic event
// whose currency is one of the symbol's currencies (see symbolNewsCurrencies). Flag = at least 5 news trades AND
// news trades are at least 30% of all trades opened in the window AND the realized P/L of the closed news trades is
// above 0 (net profitable). A news trade still open counts toward the 5 and the 30% but not toward the P/L.
export const NEWS_WINDOW_MS = 2 * 60_000;
export const NEWS_MIN_TRADES = 5;
export const NEWS_MIN_SHARE_PCT = 30;

// The currencies whose news moves a symbol: its stored base and quote currency (Symbol.baseCurrency /
// quoteCurrency), kept only when they are currency codes the calendar publishes (ForexFactory: USD EUR GBP JPY AUD
// NZD CAD CHF CNY). EURUSD -> EUR + USD; XAUUSD / XAGUSD / XPTUSD (metals, base XAU/XAG/XPT) -> USD; BTCUSD / ETHUSD
// (crypto) -> USD; US30 / NAS100 / US500 (indices, stored USD/USD) -> USD. A symbol with neither (a synthetic test
// symbol) matches no event. Calendar rows for "All" (not one currency) are never recorded, so they never match.
export const NEWS_CURRENCIES = new Set(["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "CNY"]);
export function symbolNewsCurrencies(symbol: { baseCurrency: string; quoteCurrency: string }): string[] {
  return [...new Set([symbol.baseCurrency, symbol.quoteCurrency].map((c) => c.toUpperCase()))].filter((c) => NEWS_CURRENCIES.has(c));
}

export function computeNewsTraderFlag(
  trades: NewsTrade[],
  events: NewsEvent[],
  ctx: { currency: string; windowFrom: Date; collectingHistory: boolean }
): NewsTraderEvidence {
  const inWindow = trades.filter((t) => t.openedAt.getTime() >= ctx.windowFrom.getTime());
  const news = inWindow.filter((t) =>
    events.some((e) => t.currencies.includes(e.currency) && Math.abs(t.openedAt.getTime() - e.eventAt.getTime()) <= NEWS_WINDOW_MS)
  );
  const net = news.filter((t) => t.closed).reduce((sum, t) => sum.add(t.realizedPnl ?? 0), new Prisma.Decimal(0));
  const total = inWindow.length;
  const flag = news.length >= NEWS_MIN_TRADES && news.length * 100 >= NEWS_MIN_SHARE_PCT * total && net.gt(0);
  return {
    flag,
    newsTrades: news.length,
    totalTrades: total,
    sharePct: total > 0 ? Math.round((news.length / total) * 1000) / 10 : null,
    netPnl: net.toFixed(2),
    currency: ctx.currency,
    openNewsTrades: news.filter((t) => !t.closed).length,
    windowFrom: ctx.windowFrom.toISOString(),
    collectingHistory: ctx.collectingHistory,
  };
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

  // owner 2026-10-05: internal (test / staff) accounts are left out of the radar like the broker's system accounts
  const accounts = await prisma.account.findMany({
    where: { brokerId, isInternal: false },
    select: { id: true, accountNumber: true },
  });

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "CLOSED", closedAt: { gte: since, not: null }, account: { isInternal: false } },
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

  const rows = accounts
    .map((a) => computeRiskRadarRow(a.id, a.accountNumber, byAccount.get(a.id) ?? []))
    .filter((r) => r.trades30d > 0);

  // web4: the news-trading flag, from the high-impact event history (global, market-wide data) matched against THIS
  // broker's own positions only.
  const news = await computeNewsEvidence(prisma, brokerId, since);
  for (const r of rows) {
    const e = news.byAccount.get(r.accountId) ?? null;
    r.news = e;
    r.newsTraderFlag = e?.flag ?? false;
  }
  return rows;
}

export type NewsHistoryStatus = { historyFrom: string | null; windowFrom: string | null; collectingHistory: boolean };

// The window is the last 30 days, but never earlier than where the history starts (lib/economic-events.ts
// newsHistoryFrom): trades opened before the history cannot be judged, so they are neither news trades nor counted in
// the 30% share. While the history is younger than 30 days the flag uses what exists and says so
// (collectingHistory: true). With no history at all nothing is computed (every flag false, news null).
export async function computeNewsEvidence(prisma: PrismaClient, brokerId: string, since: Date) {
  const historyFrom = await newsHistoryFrom(prisma);
  const byAccount = new Map<string, NewsTraderEvidence>();
  if (!historyFrom) return { byAccount, status: { historyFrom: null, windowFrom: null, collectingHistory: true } as NewsHistoryStatus };
  const windowFrom = historyFrom > since ? historyFrom : since;
  const collectingHistory = historyFrom > since;
  const [positions, events] = await Promise.all([
    prisma.position.findMany({
      where: { brokerId, openedAt: { gte: windowFrom }, deletedAt: null, account: { isInternal: false } },
      select: { accountId: true, openedAt: true, status: true, realizedPnl: true, symbol: { select: { baseCurrency: true, quoteCurrency: true } }, account: { select: { currency: true } } },
    }),
    prisma.economicEvent.findMany({
      where: { impact: "high", eventAt: { gte: new Date(windowFrom.getTime() - NEWS_WINDOW_MS), lte: new Date(Date.now() + NEWS_WINDOW_MS) } },
      select: { eventAt: true, currency: true },
    }),
  ]);
  const grouped = new Map<string, { currency: string; trades: NewsTrade[] }>();
  for (const p of positions) {
    const g = grouped.get(p.accountId) ?? { currency: p.account.currency, trades: [] };
    g.trades.push({ openedAt: p.openedAt, currencies: symbolNewsCurrencies(p.symbol), closed: p.status === "CLOSED", realizedPnl: p.realizedPnl });
    grouped.set(p.accountId, g);
  }
  for (const [accountId, g] of grouped) byAccount.set(accountId, computeNewsTraderFlag(g.trades, events, { currency: g.currency, windowFrom, collectingHistory }));
  return { byAccount, status: { historyFrom: historyFrom.toISOString(), windowFrom: windowFrom.toISOString(), collectingHistory } as NewsHistoryStatus };
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
    where: { brokerId, createdAt: { gte: since }, account: { isInternal: false } },
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
