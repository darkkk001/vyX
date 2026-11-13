import { prisma } from "@/lib/prisma";

/** The account WebTrader opens for a Room client (owner 2026-11-13): the oldest active live trading account. */
export function webTraderAccount(clientId: string, brokerId: string) {
  return prisma.account.findFirst({
    where: { clientId, brokerId, accountMode: "LIVE", status: "ACTIVE", isWallet: false, archivedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, accountNumber: true },
  });
}

