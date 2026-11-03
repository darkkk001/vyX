import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { accountEquityCurve } from "@/lib/equity-curve";

// Trader's Room Analytics (Phase B, artboard "Analytics"): every figure computed here from the client's closed trades
// and ledger; the room only draws them. A trade = a CLOSED position (voided and deleted ones are left out), counted in
// the period of its close. Net per trade = realizedPnl + swap - commission (Position.swap is signed as the client sees
// it, Position.commission is the cost the client paid).
//
// Sessions by the trade's OPEN time, UTC: Asia 23:00-07:00, London 07:00-12:00, New York 12:00-21:00, Rollover
// 21:00-23:00. R multiple = the price move in the trade's favour / the distance to its stop loss (the SL the trade
// closed with; a trade without one has no R). Risk % = the money at the stop / the account's equity when it opened.

export type Period = "30d" | "90d" | "ytd" | "all";
export function periodStart(p: Period, now = new Date()): Date | null {
  if (p === "30d") return new Date(now.getTime() - 30 * 86400e3);
  if (p === "90d") return new Date(now.getTime() - 90 * 86400e3);
  if (p === "ytd") return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  return null;
}

const SESSIONS = ["Asia", "London", "New York", "Rollover"] as const;
export function sessionOf(d: Date): (typeof SESSIONS)[number] {
  const h = d.getUTCHours();
  if (h >= 23 || h < 7) return "Asia";
  if (h < 12) return "London";
  if (h < 21) return "New York";
  return "Rollover";
}
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** "A", "A and B", "A, B and C" */
const listOf = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

const f2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

export type AnalyticsTrade = {
  id: string; accountId: string; accountNumber: string; symbol: string; side: "BUY" | "SELL"; lots: number;
  openedAt: Date; closedAt: Date; openPrice: number; closePrice: number; sl: number | null; net: number; r: number | null; riskPct: number | null;
};

export async function loadTrades(accounts: { id: string; accountNumber: string }[], from: Date | null): Promise<Omit<AnalyticsTrade, "riskPct">[]> {
  if (accounts.length === 0) return [];
  const numberById = new Map(accounts.map((a) => [a.id, a.accountNumber]));
  const rows = await prisma.position.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) }, status: "CLOSED", deletedAt: null, ...(from ? { closedAt: { gte: from } } : {}) },
    select: { id: true, accountId: true, side: true, volume: true, initialVolume: true, openPrice: true, closePrice: true, slPrice: true, realizedPnl: true, swap: true, commission: true, openedAt: true, closedAt: true, symbol: { select: { name: true } } },
    orderBy: { closedAt: "asc" },
    take: 20_000,
  });
  return rows.map((p) => {
    const open = p.openPrice.toNumber();
    const close = (p.closePrice ?? p.openPrice).toNumber();
    const sl = p.slPrice ? p.slPrice.toNumber() : null;
    const move = p.side === "BUY" ? close - open : open - close;
    const dist = sl != null ? Math.abs(open - sl) : 0;
    return {
      id: p.id, accountId: p.accountId, accountNumber: numberById.get(p.accountId) ?? "", symbol: p.symbol.name, side: p.side,
      lots: (p.initialVolume ?? p.volume).toNumber(), openedAt: p.openedAt, closedAt: p.closedAt ?? p.openedAt,
      openPrice: open, closePrice: close, sl,
      net: (p.realizedPnl ?? new Prisma.Decimal(0)).add(p.swap).sub(p.commission).toNumber(),
      r: sl != null && dist > 0 ? move / dist : null,
    };
  });
}

/** The value of a step series at time t (the last point at or before t), or null before its first point. */
function valueAt(points: { t: number; v: number }[], t: number): number | null {
  let lo = 0, hi = points.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (points[m].t <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans >= 0 ? points[ans].v : null;
}

export async function roomAnalytics(brokerId: string, accounts: { id: string; accountNumber: string; plan: string }[], period: Period, now = new Date()) {
  const from = periodStart(period, now);
  const curveFrom = from ?? new Date(now.getTime() - 365 * 86400e3);
  const [raw, curves] = await Promise.all([
    loadTrades(accounts, from),
    Promise.all(accounts.map(async (a) => {
      const [curve, start] = await Promise.all([accountEquityCurve(a.id, brokerId, curveFrom, now), equityAt(a.id, curveFrom)]);
      return { id: a.id, start, ...curve };
    })),
  ]);
  // each line starts at the period's first moment (balance + credit then), so a quiet stretch still draws
  const series = new Map(curves.map((c) => [c.id, [
    ...(c.start != null ? [{ t: curveFrom.getTime(), v: c.start }] : []),
    ...c.points.map((p) => ({ t: new Date(p.t).getTime(), v: Number(p.equity) })).filter((p) => p.t > curveFrom.getTime()),
  ]]));

  // risk %: money at the stop / equity when the trade opened (only trades with a stop and a known equity)
  const trades: AnalyticsTrade[] = raw.map((t) => {
    let riskPct: number | null = null;
    const move = Math.abs(t.closePrice - t.openPrice);
    if (t.sl != null && move > 0) {
      const riskMoney = (Math.abs(t.openPrice - t.sl) / move) * Math.abs(t.net);
      const eq = valueAt(series.get(t.accountId) ?? [], t.openedAt.getTime());
      if (eq && eq > 0) riskPct = (riskMoney / eq) * 100;
    }
    return { ...t, riskPct };
  });

  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net < 0);
  const sum = (xs: AnalyticsTrade[]) => xs.reduce((s, t) => s + t.net, 0);
  const grossWin = sum(wins), grossLoss = sum(losses);
  const net = grossWin + grossLoss;
  const lots = trades.reduce((s, t) => s + t.lots, 0);

  // equity curve: every account's series summed at the union of their times, then the last value of each day
  const times = [...new Set([...series.values()].flatMap((p) => p.map((x) => x.t)))].sort((a, b) => a - b);
  const combined = times.map((t) => {
    let v = 0, any = false;
    for (const pts of series.values()) { const x = valueAt(pts, t); if (x != null) { v += x; any = true; } }
    return any ? { t, v } : null;
  }).filter((x): x is { t: number; v: number } => x !== null && x.t >= curveFrom.getTime());
  const byDay = new Map<string, { t: number; v: number }>();
  for (const p of combined) byDay.set(new Date(p.t).toISOString().slice(0, 10), p);
  const curve = [...byDay.entries()].map(([day, p]) => ({ day, equity: f2(p.v) }));
  let peak = -Infinity, maxDd = 0;
  for (const p of combined) { if (p.v > peak) peak = p.v; if (peak > 0) maxDd = Math.max(maxDd, (peak - p.v) / peak); }
  const low = combined.reduce<{ t: number; v: number } | null>((m, p) => (!m || p.v < m.v ? p : m), null);
  const high = combined.reduce<{ t: number; v: number } | null>((m, p) => (!m || p.v > m.v ? p : m), null);

  // by session, weekday, symbol
  const bySession = SESSIONS.map((s) => ({ name: s, net: f2(sum(trades.filter((t) => sessionOf(t.openedAt) === s))) }));
  const weekdays = [1, 2, 3, 4, 5, ...(trades.some((t) => [0, 6].includes(t.closedAt.getUTCDay())) ? [6, 0] : [])];
  const byDayOfWeek = weekdays.map((d) => ({ name: DAYS[d], net: f2(sum(trades.filter((t) => t.closedAt.getUTCDay() === d))) }));
  const symbols = new Map<string, { net: number; lots: number }>();
  for (const t of trades) { const s = symbols.get(t.symbol) ?? { net: 0, lots: 0 }; s.net += t.net; s.lots += t.lots; symbols.set(t.symbol, s); }
  const bySymbol = [...symbols.entries()].map(([name, s]) => ({ name, net: f2(s.net), lots: s.lots })).sort((a, b) => Number(b.net) - Number(a.net));

  // risk panel
  const withR = trades.filter((t) => t.r != null);
  const winR = withR.filter((t) => t.net > 0);
  const risked = trades.filter((t) => t.riskPct != null);
  let streakW = 0, streakL = 0, w = 0, l = 0;
  for (const t of trades) {
    if (t.net > 0) { w += 1; l = 0; } else if (t.net < 0) { l += 1; w = 0; } else { w = 0; l = 0; }
    streakW = Math.max(streakW, w); streakL = Math.max(streakL, l);
  }
  const holdMs = trades.length ? trades.reduce((s, t) => s + (t.closedAt.getTime() - t.openedAt.getTime()), 0) / trades.length : 0;
  const noSl = trades.filter((t) => t.sl == null);
  const worst = trades.reduce<AnalyticsTrade | null>((m, t) => (!m || t.net < m.net ? t : m), null);

  // one-line captions: plain statements of the data
  const posSessions = bySession.filter((s) => Number(s.net) > 0).sort((a, b) => Number(b.net) - Number(a.net));
  const negSessions = bySession.filter((s) => Number(s.net) < 0);
  const losingNames = listOf(negSessions.map((x) => x.name));
  const sessionCaption = trades.length === 0 ? ""
    : posSessions[0] ? `Most of the profit comes in the ${posSessions[0].name} session${losingNames ? `; ${losingNames} trades run at a net loss.` : "."}`
    : losingNames ? `${losingNames} trades run at a net loss.` : "";
  const dayBest = [...byDayOfWeek].sort((a, b) => Number(b.net) - Number(a.net))[0];
  const dayLosing = byDayOfWeek.filter((d) => Number(d.net) < 0).map((d) => FULL_DAY[d.name]);
  const losingLine = dayLosing.length === 0 ? "no day is losing." : dayLosing.length === 1 ? `${dayLosing[0]} is the only losing one.` : `${listOf(dayLosing)} are losing.`;
  const dayCaption = trades.length === 0 ? "" : Number(dayBest.net) > 0 ? `${FULL_DAY[dayBest.name]} is the strongest day; ${losingLine}` : losingLine.replace(/^./, (c) => c.toUpperCase());
  const topSym = bySymbol[0];
  // share of the profit = of what the profitable symbols made together
  const profitTotal = bySymbol.reduce((s2, x) => s2 + Math.max(0, Number(x.net)), 0);
  const symCaption = !topSym || Number(topSym.net) <= 0 || profitTotal <= 0 || lots <= 0 ? "" : `${topSym.name} carries ${Math.round((Number(topSym.net) / profitTotal) * 100)}% of the profit on ${Math.round((topSym.lots / lots) * 100)}% of the volume.`;
  const riskCaption = trades.length === 0 ? "" : noSl.length === 0 ? "Every trade had a stop loss." : `${noSl.length} ${noSl.length === 1 ? "trade" : "trades"} ran without a stop loss.${worst && worst.net < 0 && worst.sl == null ? " The largest loss came from one of them." : ""}`;

  const pick = (t: AnalyticsTrade) => ({ id: t.id, closedAt: t.closedAt.toISOString(), symbol: t.symbol, side: t.side, lots: t.lots.toFixed(2), r: t.r == null ? null : t.r.toFixed(1), net: f2(t.net) });
  const byNet = [...trades].sort((a, b) => b.net - a.net);
  return {
    period,
    from: from?.toISOString() ?? null,
    tiles: {
      net: f2(net),
      winRate: trades.length ? ((wins.length / trades.length) * 100).toFixed(1) : "0.0",
      profitFactor: grossLoss < 0 ? (grossWin / Math.abs(grossLoss)).toFixed(2) : null,
      trades: trades.length,
      lots: lots.toFixed(1),
      avgWin: wins.length ? f2(grossWin / wins.length) : "0.00",
      avgLoss: losses.length ? f2(grossLoss / losses.length) : "0.00",
    },
    curve,
    curveLow: low ? { equity: f2(low.v), day: new Date(low.t).toISOString().slice(0, 10) } : null,
    curveHigh: high ? { equity: f2(high.v), day: new Date(high.t).toISOString().slice(0, 10) } : null,
    bySession, sessionCaption,
    byDayOfWeek, dayCaption,
    bySymbol: bySymbol.slice(0, 6).map(({ name, net: n }) => ({ name, net: n })), symCaption,
    risk: {
      avgRiskPct: risked.length ? (risked.reduce((s, t) => s + (t.riskPct ?? 0), 0) / risked.length).toFixed(1) : null,
      avgWinR: winR.length ? (winR.reduce((s, t) => s + (t.r ?? 0), 0) / winR.length).toFixed(1) : null,
      maxDrawdownPct: combined.length ? (maxDd * 100).toFixed(1) : null,
      longestWin: streakW,
      longestLoss: streakL,
      avgHoldMinutes: Math.round(holdMs / 60000),
      withoutSl: noSl.length,
      largestLoss: worst && worst.net < 0 ? f2(worst.net) : "0.00",
    },
    riskCaption,
    best: byNet.slice(0, 3).filter((t) => t.net > 0).map(pick),
    worst: [...byNet].reverse().slice(0, 3).filter((t) => t.net < 0).map(pick),
    perAccount: accounts.map((a) => {
      const own = trades.filter((t) => t.accountId === a.id);
      return { id: a.id, accountNumber: a.accountNumber, plan: a.plan, net: f2(sum(own)), lots: own.reduce((s, t) => s + t.lots, 0).toFixed(1), trades: own.length };
    }),
  };
}

const FULL_DAY: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

/** Balance + credit at `at` from the ledger: today's value minus every completed equity-moving row booked since (the
 *  same rule as lib/equity-curve.ts ledgerAfter); null for an account opened after `at`. */
export async function equityAt(accountId: string, at: Date): Promise<number | null> {
  const a = await prisma.account.findUnique({ where: { id: accountId }, select: { balance: true, credit: true, createdAt: true } });
  if (!a || a.createdAt > at) return null;
  const rows = await prisma.$queryRaw<{ s: Prisma.Decimal | null }[]>`
    SELECT SUM(t.amount) AS s FROM "Transaction" t
    WHERE t."accountId" = ${accountId} AND t.status = 'COMPLETED' AND t.type <> 'CREDIT'
      AND (CASE WHEN t.type IN ('DEPOSIT', 'WITHDRAWAL') THEN t."updatedAt" ELSE t."createdAt" END) >= ${at}`;
  return a.balance.add(a.credit).sub(rows[0]?.s ?? 0).toNumber();
}
