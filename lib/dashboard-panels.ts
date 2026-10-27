import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { readVpsPrices } from "@/lib/market-data-client";
import { getFreshPrices } from "@/lib/live-price";
import { conversionRate, loadFxLookup } from "@/lib/fx";
import { bridgeStatus } from "@/lib/bridge-status";
import type { DashRange } from "@/lib/dash-range";

// The backoffice Dashboard's range-following cards and the 1.0.96 panels (owner 2026-10-27, #29 and #35 A/B/E/F/G/H/I/J).
// Server-computed, per the source-of-truth rule: the app shows these, it derives nothing. `who` is the dashboard's own
// client definition (app/api/manage/dashboard/route.ts clientAccountSql: no internal account, no hedge account, no COVERAGE
// group, the scope's account mode), alias a = Account, so every panel counts exactly the accounts the cards count.
// Money is per account currency and never summed across currencies.

const DAY_MS = 86_400_000;
const FRESH_MS = 15_000;
const END = new Date("9999-12-31T00:00:00Z");
const d2 = (v: Prisma.Decimal.Value | null) => new Prisma.Decimal(v ?? 0).toFixed(2);
const lots = (v: Prisma.Decimal.Value | null) => new Prisma.Decimal(v ?? 0).toFixed(2);

// ------------------------------------------------------------------------------------------------ #29 period cards
/** Deposits / withdrawals over the range (money counted when it moved: approval, as the Deposits cards and the account
 *  summary count it), per currency, with one bucket per 24 h step from the range start (the broker trading day). */
export async function periodMoney(brokerId: string, who: Prisma.Sql, range: DashRange) {
  const to = range.to ?? END;
  const rows = await prisma.$queryRaw<{ currency: string; type: "DEPOSIT" | "WITHDRAWAL"; day: number; n: bigint; total: Prisma.Decimal | null }[]>`
    SELECT a.currency, t.type::text AS type, floor(extract(epoch FROM t."updatedAt" - ${range.from}::timestamptz) / 86400)::int AS day,
           COUNT(*)::bigint AS n, SUM(t.amount) AS total
    FROM "Transaction" t JOIN "Account" a ON a.id = t."accountId"
    WHERE t."brokerId" = ${brokerId} AND t.type IN ('DEPOSIT', 'WITHDRAWAL') AND t.status = 'COMPLETED'
      AND t."updatedAt" >= ${range.from} AND t."updatedAt" < ${to} AND ${who}
    GROUP BY 1, 2, 3`;
  const days = Math.max(1, Math.ceil(((range.to ?? new Date()).getTime() - range.from.getTime()) / DAY_MS));
  const byCcy = new Map<string, { dep: { n: number; s: Prisma.Decimal }; wd: { n: number; s: Prisma.Decimal }; daily: { deposits: Prisma.Decimal; withdrawals: Prisma.Decimal }[] }>();
  for (const r of rows) {
    const c = byCcy.get(r.currency) ?? {
      dep: { n: 0, s: new Prisma.Decimal(0) },
      wd: { n: 0, s: new Prisma.Decimal(0) },
      daily: Array.from({ length: days }, () => ({ deposits: new Prisma.Decimal(0), withdrawals: new Prisma.Decimal(0) })),
    };
    const amount = new Prisma.Decimal(r.total ?? 0).abs();
    const slot = r.type === "DEPOSIT" ? c.dep : c.wd;
    slot.n += Number(r.n);
    slot.s = slot.s.add(amount);
    const b = c.daily[Math.min(Math.max(r.day, 0), days - 1)];
    if (r.type === "DEPOSIT") b.deposits = b.deposits.add(amount);
    else b.withdrawals = b.withdrawals.add(amount);
    byCcy.set(r.currency, c);
  }
  return [...byCcy.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([currency, c]) => ({
      currency,
      deposits: { count: c.dep.n, amount: c.dep.s.toFixed(2) },
      withdrawals: { count: c.wd.n, amount: c.wd.s.toFixed(2) },
      net: c.dep.s.sub(c.wd.s).toFixed(2),
      byDay: c.daily.map((d, i) => ({ from: new Date(range.from.getTime() + i * DAY_MS).toISOString(), deposits: d.deposits.toFixed(2), withdrawals: d.withdrawals.toFixed(2) })),
    }));
}

/** Clients opened in the range, live and demo, with the split. `whoAll` = the client definition without the mode. */
export async function periodNewClients(whoAll: Prisma.Sql, range: DashRange) {
  const [r] = await prisma.$queryRaw<{ live: bigint; demo: bigint }[]>`
    SELECT COUNT(*) FILTER (WHERE a."accountMode" = 'LIVE')::bigint AS live, COUNT(*) FILTER (WHERE a."accountMode" = 'DEMO')::bigint AS demo
    FROM "Account" a WHERE ${whoAll} AND a."createdAt" >= ${range.from} AND a."createdAt" < ${range.to ?? END}`;
  const live = Number(r?.live ?? 0), demo = Number(r?.demo ?? 0);
  return { total: live + demo, live, demo };
}

// ------------------------------------------------------------------------------------------------ B traders online
/** Accounts with an open terminal / web connection right now (the gateway's trading stream, owner 2026-10-27), counted
 *  over the dashboard's clients. status "unavailable" = the gateway could not be asked (never shown as 0 online). */
export async function onlineNow(brokerId: string, who: Prisma.Sql): Promise<{ status: "ok" | "unavailable"; count: number }> {
  const url = `${process.env.GATEWAY_URL ?? "http://127.0.0.1:8080"}/internal/online?brokerId=${encodeURIComponent(brokerId)}`;
  let ids: string[];
  try {
    const res = await fetch(url, { headers: { "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET ?? "" }, signal: AbortSignal.timeout(2000), cache: "no-store" });
    if (!res.ok) return { status: "unavailable", count: 0 };
    const body = (await res.json()) as { accountIds?: unknown };
    if (!Array.isArray(body.accountIds)) return { status: "unavailable", count: 0 };
    ids = body.accountIds.filter((x): x is string => typeof x === "string");
  } catch {
    return { status: "unavailable", count: 0 };
  }
  if (ids.length === 0) return { status: "ok", count: 0 };
  const [r] = await prisma.$queryRaw<{ n: bigint }[]>`SELECT COUNT(*)::bigint AS n FROM "Account" a WHERE a.id = ANY(${ids}) AND ${who}`;
  return { status: "ok", count: Number(r?.n ?? 0) };
}

// ------------------------------------------------------------------------------------------------ F feed + bridge
/** One compact read of the price feed and the liquidity bridge. Plain states, no infrastructure detail (brokers never
 *  see engine / gateway names): feed LIVE = at least one of the broker's symbols ticked in the last 15 s; QUIET = none
 *  did (markets closed, or the feed stopped); UNAVAILABLE = prices could not be read. */
export async function feedAndBridge(brokerId: string) {
  const symbols = await prisma.brokerSymbol.findMany({ where: { brokerId, enabled: true }, select: { symbol: { select: { name: true } } } });
  const names = new Set(symbols.map((s) => s.symbol.name));
  let feed: { status: "LIVE" | "QUIET" | "UNAVAILABLE"; symbolsTicking: number; symbolsTotal: number; lastTickAt: string | null };
  const r = await readVpsPrices();
  if (!r.ok) feed = { status: "UNAVAILABLE", symbolsTicking: 0, symbolsTotal: names.size, lastTickAt: null };
  else {
    const mine = r.value.filter((p) => names.has(p.symbol));
    const ticking = mine.filter((p) => p.ageMs <= FRESH_MS).length;
    const last = mine.map((p) => p.tickAt).filter(Boolean).sort().at(-1) ?? null;
    feed = { status: ticking > 0 ? "LIVE" : "QUIET", symbolsTicking: ticking, symbolsTotal: names.size, lastTickAt: last };
  }
  const bridge = await bridgeStatus(brokerId).catch(() => null);
  return { feed, bridge: bridge ? { badge: bridge.badge, text: bridge.text, since: bridge.since, lastReportAt: bridge.lastReportAt } : null };
}

// ------------------------------------------------------------------------------------------------ G/H winners, losers
/** Top 5 winners and losers by realized net P/L over [from, now), per currency. The account summary's netPnl
 *  (lib/account-summary.ts): closes' profit + commission charged on opens (IN deals) + SWAP rows booked, never voided or
 *  deleted trades. Client view: positive = the client won. */
export async function topAccounts(brokerId: string, who: Prisma.Sql, from: Date) {
  const rows = await prisma.$queryRaw<{ id: string; accountNumber: string; fullName: string | null; currency: string; gross: Prisma.Decimal; commission: Prisma.Decimal; swap: Prisma.Decimal; net: Prisma.Decimal }[]>`
    WITH live_deals AS (
      SELECT d."accountId", d.entry, d.profit, d.commission FROM "Deal" d JOIN "Position" p ON p.id = d."positionId"
      WHERE d."brokerId" = ${brokerId} AND d."executedAt" >= ${from} AND d."voidedAt" IS NULL AND p."deletedAt" IS NULL
    ), per AS (
      SELECT "accountId",
             SUM(profit) FILTER (WHERE entry IN ('OUT', 'OUT_BY')) AS gross,
             SUM(commission) FILTER (WHERE entry = 'IN') AS commission
      FROM live_deals GROUP BY 1
    ), sw AS (
      SELECT t."accountId", SUM(t.amount) AS swap FROM "Transaction" t
      WHERE t."brokerId" = ${brokerId} AND t.type = 'SWAP' AND t.status = 'COMPLETED' AND t."hiddenForPositionId" IS NULL AND t."createdAt" >= ${from}
      GROUP BY 1
    )
    SELECT a.id, a."accountNumber", a."fullName", a.currency,
           COALESCE(per.gross, 0) AS gross, COALESCE(per.commission, 0) AS commission, COALESCE(sw.swap, 0) AS swap,
           COALESCE(per.gross, 0) + COALESCE(per.commission, 0) + COALESCE(sw.swap, 0) AS net
    FROM "Account" a LEFT JOIN per ON per."accountId" = a.id LEFT JOIN sw ON sw."accountId" = a.id
    WHERE ${who} AND (per."accountId" IS NOT NULL OR sw."accountId" IS NOT NULL)`;
  const row = (r: (typeof rows)[number]) => ({
    accountId: r.id,
    accountNumber: r.accountNumber,
    name: r.fullName ?? "",
    netPnl: d2(r.net),
    grossPnl: d2(r.gross),
    commission: d2(new Prisma.Decimal(r.commission).neg()), // a cost: positive = charged
    swap: d2(new Prisma.Decimal(r.swap).neg()), // a cost: positive = charged
  });
  const byCcy = new Map<string, typeof rows>();
  for (const r of rows) byCcy.set(r.currency, [...(byCcy.get(r.currency) ?? []), r]);
  return [...byCcy.entries()]
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([currency, list]) => {
      const sorted = [...list].sort((x, y) => new Prisma.Decimal(y.net).cmp(new Prisma.Decimal(x.net)));
      return {
        currency,
        winners: sorted.filter((r) => new Prisma.Decimal(r.net).gt(0)).slice(0, 5).map(row),
        losers: sorted.filter((r) => new Prisma.Decimal(r.net).lt(0)).reverse().slice(0, 5).map(row),
      };
    });
}

// ------------------------------------------------------------------------------------------------ I net exposure
/** The clients' open positions netted per symbol (buy lots - sell lots), biggest first by notional: |net lots| x contract
 *  size x mid, converted to USD so symbols compare. notionalUsd null = no fresh price or no USD rate (listed last). */
export async function netExposure(brokerId: string, who: Prisma.Sql, limit = 10) {
  const rows = await prisma.$queryRaw<{ symbol: string; quote: string; contractSize: Prisma.Decimal; buy: Prisma.Decimal | null; sell: Prisma.Decimal | null; positions: bigint }[]>`
    SELECT s.name AS symbol, s."quoteCurrency" AS quote, s."contractSize" AS "contractSize",
           SUM(p.volume) FILTER (WHERE p.side = 'BUY') AS buy, SUM(p.volume) FILTER (WHERE p.side = 'SELL') AS sell, COUNT(*)::bigint AS positions
    FROM "Position" p JOIN "Account" a ON a.id = p."accountId" JOIN "Symbol" s ON s.id = p."symbolId"
    WHERE p."brokerId" = ${brokerId} AND p.status = 'OPEN' AND p."deletedAt" IS NULL AND ${who}
    GROUP BY 1, 2, 3`;
  const [prices, fx] = await Promise.all([getFreshPrices(rows.map((r) => r.symbol)), loadFxLookup(prisma, rows.map((r) => [r.quote, "USD"] as const))]);
  const out = rows.map((r) => {
    const buy = new Prisma.Decimal(r.buy ?? 0), sell = new Prisma.Decimal(r.sell ?? 0), net = buy.sub(sell);
    const p = prices.get(r.symbol);
    const rate = conversionRate(r.quote, "USD", fx);
    const notional = p && rate ? net.abs().mul(r.contractSize).mul(p.bid.add(p.ask).div(2)).mul(rate) : null;
    return { symbol: r.symbol, buyLots: lots(buy), sellLots: lots(sell), netLots: lots(net), positions: Number(r.positions), notionalUsd: notional ? notional.toFixed(2) : null, _n: notional };
  });
  out.sort((x, y) => (x._n && y._n ? y._n.cmp(x._n) : x._n ? -1 : y._n ? 1 : Number(new Prisma.Decimal(y.netLots).abs().sub(new Prisma.Decimal(x.netLots).abs()))));
  return out.slice(0, limit).map(({ _n, ...r }) => (void _n, r));
}

// ------------------------------------------------------------------------------------------------ large positions
/** The Needs attention LARGE POSITION flag (owner 2026-10-27): an account whose open lots are at least 25% of the
 *  clients' open lots AND at least 1.0 lot. Both together, so a small account on a small book (0.17 lot = "100% of book")
 *  is never flagged. Book = every open position of the dashboard's clients, both sides, all symbols. */
export const LARGE_POSITION_RULE = { minSharePct: 25, minLots: 1 } as const;
export async function largePositions(brokerId: string, who: Prisma.Sql) {
  const rows = await prisma.$queryRaw<{ id: string; accountNumber: string; fullName: string | null; lots: Prisma.Decimal; positions: bigint }[]>`
    SELECT a.id, a."accountNumber", a."fullName", SUM(p.volume) AS lots, COUNT(*)::bigint AS positions
    FROM "Position" p JOIN "Account" a ON a.id = p."accountId"
    WHERE p."brokerId" = ${brokerId} AND p.status = 'OPEN' AND p."deletedAt" IS NULL AND ${who}
    GROUP BY 1, 2, 3`;
  const book = rows.reduce((t, r) => t.add(r.lots), new Prisma.Decimal(0));
  const flagged = book.gt(0)
    ? rows
        .map((r) => ({ r, share: new Prisma.Decimal(r.lots).div(book).mul(100) }))
        .filter(({ r, share }) => share.gte(LARGE_POSITION_RULE.minSharePct) && new Prisma.Decimal(r.lots).gte(LARGE_POSITION_RULE.minLots))
        .sort((x, y) => y.share.cmp(x.share))
    : [];
  return {
    rule: { minSharePct: LARGE_POSITION_RULE.minSharePct, minLots: lots(LARGE_POSITION_RULE.minLots) },
    bookLots: lots(book),
    count: flagged.length,
    rows: flagged.map(({ r, share }) => ({
      kind: "LARGE_POSITION" as const,
      accountId: r.id,
      accountNumber: r.accountNumber,
      name: r.fullName ?? "",
      lots: lots(r.lots),
      positions: Number(r.positions),
      sharePct: share.toFixed(0),
    })),
  };
}

// ------------------------------------------------------------------------------------------------ J big trades
/** Trades OPENED in the range with 1 lot or more (the opening deal), newest first, not voided or deleted. */
export async function bigTrades(brokerId: string, who: Prisma.Sql, range: DashRange, minLots = 1, limit = 20) {
  const rows = await prisma.$queryRaw<{ ticket: number; accountNumber: string; fullName: string | null; symbol: string; side: string; volume: Prisma.Decimal; price: Prisma.Decimal; at: Date }[]>`
    SELECT p.ticket, a."accountNumber", a."fullName", s.name AS symbol, d.side::text AS side, d.volume, d.price, d."executedAt" AS at
    FROM "Deal" d JOIN "Position" p ON p.id = d."positionId" JOIN "Account" a ON a.id = d."accountId" JOIN "Symbol" s ON s.id = d."symbolId"
    WHERE d."brokerId" = ${brokerId} AND d.entry = 'IN' AND d.volume >= ${minLots} AND d."voidedAt" IS NULL AND p."deletedAt" IS NULL
      AND d."executedAt" >= ${range.from} AND d."executedAt" < ${range.to ?? END} AND ${who}
    ORDER BY d."executedAt" DESC LIMIT ${limit}`;
  return rows.map((r) => ({ ticket: r.ticket, accountNumber: r.accountNumber, name: r.fullName ?? "", symbol: r.symbol, side: r.side, lots: lots(r.volume), price: new Prisma.Decimal(r.price).toString(), at: r.at.toISOString() }));
}
