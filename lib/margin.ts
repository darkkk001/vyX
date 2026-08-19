import "server-only";
import { PrismaClient } from "@prisma/client";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";

export type AccountMarginSnapshot = {
  accountId: string;
  accountNumber: string;
  balance: number;
  equity: number;
  usedMargin: number;
  exposure: number;
  positionCount: number;
  marginCallLevel: number;
  stopOutLevel: number;
  marginLevel: number | null; // null = no used margin (no fresh price for any open position)
};

// Shared by the Risk Dashboard stats (app/manage/(shell)/risk/page.tsx),
// the Risk report CSV (app/api/manage/reports/risk/route.ts), and the
// Margin monitoring page (app/manage/(shell)/margin/page.tsx) -- was
// duplicated across the first two in Phase A, factored out here rather
// than adding a third copy. Margin level = equity / usedMargin * 100,
// same formula components/webtrader/WebTrader.tsx's client-side
// marginLevel already uses, computed broker-wide here instead of for one
// logged-in trader.
export async function computeAccountMarginSnapshots(prisma: PrismaClient, brokerId: string): Promise<AccountMarginSnapshot[]> {
  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: {
        select: { id: true, accountNumber: true, balance: true, leverage: true, group: { select: { marginCallLevel: true, stopOutLevel: true } } },
      },
      symbol: { select: { name: true, contractSize: true } },
    },
  });

  const priceBySymbol = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);

  const byAccount = new Map<string, AccountMarginSnapshot>();
  for (const p of positions) {
    const snap = byAccount.get(p.account.id) ?? {
      accountId: p.account.id,
      accountNumber: p.account.accountNumber,
      balance: p.account.balance.toNumber(),
      equity: p.account.balance.toNumber(),
      usedMargin: 0,
      exposure: 0,
      positionCount: 0,
      marginCallLevel: p.account.group?.marginCallLevel.toNumber() ?? 100,
      stopOutLevel: p.account.group?.stopOutLevel.toNumber() ?? 50,
      marginLevel: null,
    };
    snap.exposure += p.volume.toNumber();
    snap.positionCount += 1;

    const live = priceBySymbol.get(p.symbol.name);
    if (live) {
      const currentPrice = p.side === "BUY" ? live.bid : live.ask;
      snap.equity += computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).toNumber();
      snap.usedMargin += p.symbol.contractSize.toNumber() * p.volume.toNumber() * live.bid.toNumber() / p.account.leverage;
    }

    byAccount.set(p.account.id, snap);
  }

  for (const snap of byAccount.values()) {
    snap.marginLevel = snap.usedMargin > 0 ? (snap.equity / snap.usedMargin) * 100 : null;
  }

  return [...byAccount.values()];
}
