import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { computeRealizedPnl } from "@/lib/trading";
import { getFreshPrices } from "@/lib/live-price";
import { PageHeader } from "@/components/ui/PageHeader";
import PositionsManager, {
  type PositionRow,
  type AccountOption,
  type SymbolOption,
  type GroupOption,
  type IbOption,
} from "./PositionsManager";

// Reads Prisma's `Position` table, not the Rust-owned `positions` table
// (engine/migrations) -- per ADR-003, no broker has been cut over to the
// Rust engine yet, so Prisma's Position is where actual live trading
// data exists today. Same table app/api/trade/positions/route.ts already
// reads for the trader-facing view. Revisit once a broker cuts over.
//
// Exposure aggregation, per-symbol Client Floating P&L, and the
// broker-wide Total floating P&L all live in PositionsManager.tsx now,
// recomputed from whichever subset the exposure monitor's filters leave
// -- this page only fetches the full open-position set (+ the group/IB
// info each filter needs) and hands it over as plain rows.
export default async function ManagerPositionsPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const positions = await prisma.position.findMany({
    where: { brokerId, status: "OPEN" },
    include: {
      account: {
        select: {
          accountNumber: true,
          fullName: true,
          groupId: true,
          group: { select: { name: true } },
          ibLinkAsClient: { select: { ibAccountId: true } },
        },
      },
      symbol: { select: { name: true, digits: true, contractSize: true } },
      originOrder: { select: { idempotencyKey: true } },
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
      accountId: p.accountId,
      accountNumber: p.account.accountNumber,
      accountFullName: p.account.fullName,
      groupId: p.account.groupId,
      groupName: p.account.group?.name ?? null,
      ibAccountId: p.account.ibLinkAsClient?.ibAccountId ?? null,
      symbolName: p.symbol.name,
      digits: p.symbol.digits,
      side: p.side,
      volume: p.volume.toString(),
      openPrice: p.openPrice.toFixed(p.symbol.digits),
      currentPrice: currentPrice ? currentPrice.toFixed(p.symbol.digits) : null,
      floatingPnl: floatingPnl ? floatingPnl.toFixed(2) : null,
      slPrice: p.slPrice ? p.slPrice.toFixed(p.symbol.digits) : null,
      tpPrice: p.tpPrice ? p.tpPrice.toFixed(p.symbol.digits) : null,
      isManualOrigin: p.originOrder.idempotencyKey.startsWith("manual_"),
      openedAt: p.openedAt.toISOString().replace("T", " ").slice(0, 19),
    };
  });

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

  const groups: GroupOption[] = (
    await prisma.group.findMany({ where: { brokerId }, select: { id: true, name: true }, orderBy: { name: "asc" } })
  ).map((g) => ({ id: g.id, name: g.name }));

  const ibRelationships = await prisma.ibRelationship.findMany({
    where: { brokerId },
    select: { ibAccountId: true, ibAccount: { select: { accountNumber: true, fullName: true } } },
  });
  const ibOptions: IbOption[] = [...new Map(ibRelationships.map((r) => [r.ibAccountId, r])).values()]
    .map((r) => ({ id: r.ibAccountId, accountNumber: r.ibAccount.accountNumber, fullName: r.ibAccount.fullName }))
    .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader title="Positions & Exposure" description={`${rows.length} open position${rows.length === 1 ? "" : "s"} across this broker.`} />
      <PositionsManager
        positionRows={rows}
        accounts={accounts}
        symbols={tradableSymbols}
        groups={groups}
        ibOptions={ibOptions}
      />
    </main>
  );
}
