import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeRealizedPnl } from "@/lib/trading";

type FreshPrice = { symbol: string; bid: Prisma.Decimal; ask: Prisma.Decimal };

// Same 15s staleness threshold as everywhere else this convention is
// used (WebTrader.tsx's chart, market_data::db::get_live_price,
// services/api-gateway's getOpenPositionsSummary) -- a frozen LivePrice
// row is worse than no price at all for a risk dashboard too: showing a
// dealing desk a floating P&L computed off a dead feed could hide real
// exposure rather than flag it.
//
// Filtered in raw SQL, not `prisma.livePrice.findMany` + a JS Date
// comparison: LivePrice.updatedAt is `timestamp without time zone` (no
// `@db.Timestamptz` in schema.prisma), so a value read back through a
// Node driver gets interpreted in whatever timezone the CLIENT machine
// is set to, not UTC -- comparing it against `Date.now()` in JS silently
// produced a multi-hour-wrong answer during testing here (every price
// showed stale even seconds after being written). Comparing entirely in
// Postgres, against its own now(), sidesteps that ambiguity the same way
// the Rust engine's staleness queries already do -- this is a real,
// standing schema gap (flagged to the user separately, not fixed here:
// widening it to every DateTime column is a bigger, separate call).
async function getFreshPrices(symbolNames: string[]): Promise<Map<string, FreshPrice>> {
  if (symbolNames.length === 0) return new Map();
  const rows = await prisma.$queryRaw<FreshPrice[]>`
    SELECT symbol, bid, ask FROM "LivePrice"
    WHERE symbol = ANY(${symbolNames}) AND "updatedAt" > now() - interval '15 seconds'
  `;
  return new Map(rows.map((r) => [r.symbol, r]));
}

// Reads Prisma's `Position` table, not the Rust-owned `positions` table
// (engine/migrations) -- per ADR-003, no broker has been cut over to the
// Rust engine yet, so Prisma's Position is where actual live trading
// data exists today. Same table app/api/trade/positions/route.ts already
// reads for the trader-facing view. Revisit once a broker cuts over.
export default async function ManagerPositionsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: { select: { accountNumber: true, fullName: true } },
      symbol: { select: { name: true, digits: true, contractSize: true } },
    },
    orderBy: { openedAt: "desc" },
  });

  const symbolNames = [...new Set(positions.map((p) => p.symbol.name))];
  const priceBySymbol = await getFreshPrices(symbolNames);

  const rows = positions.map((p) => {
    const lp = priceBySymbol.get(p.symbol.name);
    const currentPrice = lp ? (p.side === "BUY" ? lp.bid : lp.ask) : null;
    const floatingPnl = currentPrice
      ? computeRealizedPnl({
          side: p.side,
          openPrice: p.openPrice,
          closePrice: currentPrice,
          volume: p.volume,
          contractSize: p.symbol.contractSize,
        })
      : null;
    return { ...p, currentPrice, floatingPnl };
  });

  // Per-symbol net exposure -- what a dealing desk actually watches: not
  // "how many positions" but "how much unhedged risk does this book
  // carry per symbol," i.e. net BUY volume minus net SELL volume.
  type Exposure = {
    symbol: string;
    digits: number;
    count: number;
    buyVolume: Prisma.Decimal;
    sellVolume: Prisma.Decimal;
    currentPrice: Prisma.Decimal | null;
  };
  const bySymbol = new Map<string, Exposure>();
  for (const row of rows) {
    const key = row.symbol.name;
    const entry = bySymbol.get(key) ?? {
      symbol: key,
      digits: row.symbol.digits,
      count: 0,
      buyVolume: new Prisma.Decimal(0),
      sellVolume: new Prisma.Decimal(0),
      currentPrice: row.currentPrice,
    };
    entry.count += 1;
    entry.buyVolume = row.side === "BUY" ? entry.buyVolume.plus(row.volume) : entry.buyVolume;
    entry.sellVolume = row.side === "SELL" ? entry.sellVolume.plus(row.volume) : entry.sellVolume;
    bySymbol.set(key, entry);
  }
  const exposureRows = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));

  const totalFloatingPnl = rows.reduce(
    (sum, r) => (r.floatingPnl ? sum.plus(r.floatingPnl) : sum),
    new Prisma.Decimal(0)
  );

  return (
    <main style={{ maxWidth: 1400, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <h1>Positions & Exposure</h1>
      <p style={{ color: "#666" }}>
        {rows.length} open position{rows.length === 1 ? "" : "s"} across this broker. Total floating
        P&L:{" "}
        <span style={{ color: totalFloatingPnl.gte(0) ? "green" : "crimson", fontFamily: "monospace" }}>
          {totalFloatingPnl.toFixed(2)}
        </span>
      </p>

      <h2>Exposure by symbol</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13, marginBottom: "2rem" }}>
        <thead>
          <tr>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Symbol</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Positions</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Buy volume</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Sell volume</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Net exposure</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Current price</th>
          </tr>
        </thead>
        <tbody>
          {exposureRows.length === 0 ? (
            <tr>
              <td colSpan={6} style={{ padding: "12px 8px", color: "#999" }}>No open positions.</td>
            </tr>
          ) : (
            exposureRows.map((e) => {
              const net = e.buyVolume.minus(e.sellVolume);
              return (
                <tr key={e.symbol}>
                  <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>{e.symbol}</td>
                  <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>{e.count}</td>
                  <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>{e.buyVolume.toFixed(2)}</td>
                  <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>{e.sellVolume.toFixed(2)}</td>
                  <td
                    align="right"
                    style={{
                      padding: "6px 8px",
                      borderBottom: "1px solid #eee",
                      fontFamily: "monospace",
                      color: net.isZero() ? undefined : net.gt(0) ? "green" : "crimson",
                    }}
                  >
                    {net.gt(0) ? "+" : ""}
                    {net.toFixed(2)}
                  </td>
                  <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>
                    {e.currentPrice ? e.currentPrice.toFixed(e.digits) : "—"}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      <h2>Open positions</h2>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Account</th>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Symbol</th>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Side</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Volume</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Open price</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Current price</th>
            <th align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Floating P&L</th>
            <th align="left" style={{ padding: "6px 8px", borderBottom: "1px solid #ccc" }}>Opened</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} style={{ padding: "12px 8px", color: "#999" }}>No open positions.</td>
            </tr>
          ) : (
            rows.map((p) => (
              <tr key={p.id}>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee" }}>
                  {p.account.accountNumber}
                  <div style={{ fontSize: 11, color: "#999" }}>{p.account.fullName}</div>
                </td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>{p.symbol.name}</td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", color: p.side === "BUY" ? "green" : "crimson" }}>
                  {p.side}
                </td>
                <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>
                  {p.volume.toFixed(2)}
                </td>
                <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>
                  {p.openPrice.toFixed(p.symbol.digits)}
                </td>
                <td align="right" style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontFamily: "monospace" }}>
                  {p.currentPrice ? p.currentPrice.toFixed(p.symbol.digits) : "—"}
                </td>
                <td
                  align="right"
                  style={{
                    padding: "6px 8px",
                    borderBottom: "1px solid #eee",
                    fontFamily: "monospace",
                    color: !p.floatingPnl ? undefined : p.floatingPnl.gte(0) ? "green" : "crimson",
                  }}
                >
                  {p.floatingPnl ? p.floatingPnl.toFixed(2) : "—"}
                </td>
                <td style={{ padding: "6px 8px", borderBottom: "1px solid #eee", fontSize: 11, color: "#999" }}>
                  {p.openedAt.toISOString().replace("T", " ").slice(0, 19)}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </main>
  );
}
