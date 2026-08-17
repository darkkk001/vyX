import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeRealizedPnl } from "@/lib/trading";
import { getFreshPrices } from "@/lib/live-price";
import PositionsManager, { type ExposureRow, type PositionRow, type AccountOption, type SymbolOption } from "./PositionsManager";

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

  // Decimal instances can't cross the Server->Client Component boundary
  // (RSC serialization) -- every value handed to <PositionsManager> is a
  // plain string, same convention as SymbolConfigRow on the symbols screen.
  const rows: PositionRow[] = positions.map((p) => {
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
    return {
      id: p.id,
      accountNumber: p.account.accountNumber,
      accountFullName: p.account.fullName,
      symbolName: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      currentPrice: currentPrice ? currentPrice.toFixed(p.symbol.digits) : null,
      floatingPnl: floatingPnl ? floatingPnl.toFixed(2) : null,
      openedAt: p.openedAt.toISOString().replace("T", " ").slice(0, 19),
    };
  });

  // Per-symbol net exposure -- what a dealing desk actually watches: not
  // "how many positions" but "how much unhedged risk does this book
  // carry per symbol," i.e. net BUY volume minus net SELL volume.
  type ExposureAcc = {
    symbol: string;
    digits: number;
    count: number;
    buyVolume: Prisma.Decimal;
    sellVolume: Prisma.Decimal;
    currentPrice: Prisma.Decimal | null;
  };
  const bySymbol = new Map<string, ExposureAcc>();
  for (const p of positions) {
    const lp = priceBySymbol.get(p.symbol.name);
    const currentPrice = lp ? (p.side === "BUY" ? lp.bid : lp.ask) : null;
    const key = p.symbol.name;
    const entry = bySymbol.get(key) ?? {
      symbol: key,
      digits: p.symbol.digits,
      count: 0,
      buyVolume: new Prisma.Decimal(0),
      sellVolume: new Prisma.Decimal(0),
      currentPrice,
    };
    entry.count += 1;
    entry.buyVolume = p.side === "BUY" ? entry.buyVolume.plus(p.volume) : entry.buyVolume;
    entry.sellVolume = p.side === "SELL" ? entry.sellVolume.plus(p.volume) : entry.sellVolume;
    bySymbol.set(key, entry);
  }
  const exposureRows: ExposureRow[] = [...bySymbol.values()]
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
    .map((e) => {
      const net = e.buyVolume.minus(e.sellVolume);
      return {
        symbol: e.symbol,
        count: e.count,
        buyVolume: e.buyVolume.toFixed(2),
        sellVolume: e.sellVolume.toFixed(2),
        netExposure: net.toFixed(2),
        currentPrice: e.currentPrice ? e.currentPrice.toFixed(e.digits) : null,
      };
    });

  const totalFloatingPnl = positions
    .reduce((sum, p) => {
      const lp = priceBySymbol.get(p.symbol.name);
      if (!lp) return sum;
      const currentPrice = p.side === "BUY" ? lp.bid : lp.ask;
      return sum.plus(
        computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize })
      );
    }, new Prisma.Decimal(0))
    .toFixed(2);

  const accounts: AccountOption[] = (
    await prisma.account.findMany({
      where: { brokerId, status: "ACTIVE" },
      select: { id: true, accountNumber: true, fullName: true },
      orderBy: { accountNumber: "asc" },
    })
  ).map((a) => ({ id: a.id, accountNumber: a.accountNumber, fullName: a.fullName }));

  const tradableSymbols: SymbolOption[] = (
    await prisma.brokerSymbol.findMany({
      where: { brokerId, enabled: true },
      include: { symbol: { select: { id: true, name: true } } },
      orderBy: { symbol: { name: "asc" } },
    })
  ).map((bs) => ({ id: bs.symbol.id, name: bs.symbol.name }));

  return (
    <main style={{ maxWidth: 1400, margin: "2rem auto", fontFamily: "sans-serif", padding: "0 1rem" }}>
      <h1>Positions & Exposure</h1>
      <p style={{ color: "#666" }}>
        {rows.length} open position{rows.length === 1 ? "" : "s"} across this broker. Total floating
        P&L:{" "}
        <span style={{ color: Number(totalFloatingPnl) >= 0 ? "green" : "crimson", fontFamily: "monospace" }}>
          {totalFloatingPnl}
        </span>
      </p>
      <PositionsManager exposureRows={exposureRows} positionRows={rows} accounts={accounts} symbols={tradableSymbols} />
    </main>
  );
}
