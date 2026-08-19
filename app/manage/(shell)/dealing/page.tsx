import { redirect } from "next/navigation";
import { getAdminSession, requireAdminRole } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getFreshPrices } from "@/lib/live-price";
import { PageHeader } from "@/components/ui/PageHeader";
import DealingQueueManager, { type DealingOrderRow, type RequotedOrderRow } from "./DealingQueueManager";

// Trader-submitted MARKET orders waiting for a dealer's Accept/Reject --
// only populated while Broker.dealingModeAt is set (see
// app/api/trade/orders/route.ts). Same MANAGER/BROKER_ADMIN pair as
// Positions' manual open/close, since this is the same dealing-desk
// activity, just for trader-initiated orders instead of admin-initiated ones.
export default async function ManagerDealingPage() {
  const session = await getAdminSession();
  if (!requireAdminRole(session, ["MANAGER", "BROKER_ADMIN"]) || !session!.brokerId) {
    redirect("/manage/login");
  }
  const brokerId = session!.brokerId!;

  const [pending, requoted] = await Promise.all([
    prisma.order.findMany({
      where: { brokerId, type: "MARKET", status: "PENDING" },
      include: {
        account: { select: { accountNumber: true, fullName: true } },
        symbol: { select: { name: true, digits: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.order.findMany({
      where: { brokerId, type: "MARKET", status: "REQUOTED" },
      include: {
        account: { select: { accountNumber: true, fullName: true } },
        symbol: { select: { name: true, digits: true } },
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const priceBySymbol = await getFreshPrices([...new Set(pending.map((o) => o.symbol.name))]);

  const rows: DealingOrderRow[] = pending.map((o) => {
    const live = priceBySymbol.get(o.symbol.name);
    return {
      id: o.id,
      accountNumber: o.account.accountNumber,
      accountFullName: o.account.fullName,
      symbol: o.symbol.name,
      digits: o.symbol.digits,
      side: o.side,
      volume: o.volume.toString(),
      requestedPrice: o.requestedPrice ? o.requestedPrice.toString() : null,
      createdAt: o.createdAt.toISOString().replace("T", " ").slice(0, 19),
      liveBid: live ? live.bid.toString() : null,
      liveAsk: live ? live.ask.toString() : null,
    };
  });

  const requotedRows: RequotedOrderRow[] = requoted.map((o) => ({
    id: o.id,
    accountNumber: o.account.accountNumber,
    accountFullName: o.account.fullName,
    symbol: o.symbol.name,
    digits: o.symbol.digits,
    side: o.side,
    volume: o.volume.toString(),
    requestedPrice: o.requestedPrice ? o.requestedPrice.toString() : null,
    requotedPrice: o.requotedPrice ? o.requotedPrice.toString() : null,
    createdAt: o.createdAt.toISOString().replace("T", " ").slice(0, 19),
  }));

  return (
    <main className="mx-auto max-w-[1400px]">
      <PageHeader
        title="Dealing queue"
        description={`${rows.length} order${rows.length === 1 ? "" : "s"} awaiting manual review, ${requotedRows.length} awaiting the client's answer to a requote. Only populated while dealing mode is on (Risk page).`}
      />
      <DealingQueueManager initialRows={rows} requotedRows={requotedRows} />
    </main>
  );
}
