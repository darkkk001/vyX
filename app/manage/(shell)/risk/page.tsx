import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFreshPrices } from "@/lib/live-price";
import { computeRealizedPnl } from "@/lib/trading";
import { PageHeader } from "@/components/ui/PageHeader";
import { StatCard, StatGrid } from "@/components/ui/StatCard";
import RiskSettingsManager from "./RiskSettingsManager";

// Finance/ops-tier screen -- same BROKER_ADMIN-only carve-out as
// Funds/KYC/IB/Team, not the broader MANAGER+BROKER_ADMIN gate. See
// lib/risk.ts for how these settings are actually enforced on the live
// trading path (app/api/trade/orders, app/api/manage/positions).
export default async function ManagerRiskPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const broker = await prisma.broker.findUniqueOrThrow({ where: { id: brokerId } });

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: { select: { id: true, balance: true, leverage: true, group: { select: { marginCallLevel: true, stopOutLevel: true } } } },
      symbol: { select: { name: true, contractSize: true } },
    },
  });

  const priceBySymbol = await getFreshPrices([...new Set(positions.map((p) => p.symbol.name))]);

  let totalExposure = 0;
  let totalFloatingPnl = 0;
  const byAccount = new Map<string, { balance: number; leverage: number; marginCallLevel: number; stopOutLevel: number; equity: number; usedMargin: number }>();

  for (const p of positions) {
    totalExposure += p.volume.toNumber();
    const live = priceBySymbol.get(p.symbol.name);
    if (!live) continue; // no fresh price -- excluded from P&L/margin, not fabricated
    const currentPrice = p.side === "BUY" ? live.bid : live.ask;
    const pnl = computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice: currentPrice, volume: p.volume, contractSize: p.symbol.contractSize }).toNumber();
    totalFloatingPnl += pnl;

    const acc = byAccount.get(p.account.id) ?? {
      balance: p.account.balance.toNumber(),
      leverage: p.account.leverage,
      marginCallLevel: p.account.group?.marginCallLevel.toNumber() ?? 100,
      stopOutLevel: p.account.group?.stopOutLevel.toNumber() ?? 50,
      equity: p.account.balance.toNumber(),
      usedMargin: 0,
    };
    acc.equity += pnl;
    acc.usedMargin += p.symbol.contractSize.toNumber() * p.volume.toNumber() * live.bid.toNumber() / p.account.leverage;
    byAccount.set(p.account.id, acc);
  }

  let atMarginCall = 0;
  let atStopOut = 0;
  for (const acc of byAccount.values()) {
    if (acc.usedMargin <= 0) continue;
    const marginLevel = (acc.equity / acc.usedMargin) * 100;
    if (marginLevel < acc.stopOutLevel) atStopOut++;
    else if (marginLevel < acc.marginCallLevel) atMarginCall++;
  }

  return (
    <main className="mx-auto max-w-4xl">
      <PageHeader
        title="Risk"
        description="Broker-wide trading controls. Existing open positions are never touched by these — they only affect new orders."
      />
      <div className="mb-6">
        <StatGrid columns={4}>
          <StatCard label="Open exposure" value={`${totalExposure.toLocaleString("en-US")} lots`} />
          <StatCard label="Floating P&L" value={`${totalFloatingPnl >= 0 ? "+" : ""}${totalFloatingPnl.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`} />
          <StatCard label="Open positions" value={String(positions.length)} />
          <StatCard
            label="Accounts at risk"
            value={`${atMarginCall + atStopOut}`}
          />
        </StatGrid>
        <p className="mt-2 text-xs text-[var(--text-3)]">
          {atStopOut} account{atStopOut === 1 ? "" : "s"} below stop-out, {atMarginCall} below margin call — informational only, not yet enforced automatically (see Group.stopOutLevel).
        </p>
      </div>
      <RiskSettingsManager
        initial={{
          dealingMode: broker.dealingModeAt != null,
          totalExposureLimit: broker.totalExposureLimit ? broker.totalExposureLimit.toString() : null,
          maxOpenPositionsPerAccount: broker.maxOpenPositionsPerAccount,
        }}
      />
    </main>
  );
}
