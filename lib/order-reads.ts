import { Prisma, PrismaClient } from "@prisma/client";

// Execution latency Phase 1 (2026-10-24): the order route's reads with nested `include`s cost one sequential database
// round trip per relation level (Prisma loads each level with its own query after the parent's). These load exactly
// the same shapes with every level queried at once, from the keys the route already has, in ONE parallel round trip.
// No rule changes: the route reads the same rows as before.

type Db = PrismaClient | Prisma.TransactionClient;

export type OrderBrokerSymbol = Prisma.BrokerSymbolGetPayload<{ include: { symbol: true; tradingSessions: true } }>;
export type OrderAccount = Prisma.AccountGetPayload<{ include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } }>;

/** = prisma.brokerSymbol.findFirst({ where: { brokerId, enabled: true, symbol: { name } }, include: { symbol: true, tradingSessions: true } }) */
export async function loadOrderBrokerSymbol(db: Db, brokerId: string, symbolName: string): Promise<OrderBrokerSymbol | null> {
  const where = { brokerId, enabled: true, symbol: { name: symbolName } };
  const [brokerSymbol, symbol, tradingSessions] = await Promise.all([
    db.brokerSymbol.findFirst({ where }),
    db.symbol.findUnique({ where: { name: symbolName } }),
    db.tradingSession.findMany({ where: { brokerSymbol: where } }),
  ]);
  if (!brokerSymbol || !symbol || symbol.id !== brokerSymbol.symbolId) return null;
  return { ...brokerSymbol, symbol, tradingSessions: tradingSessions.filter((s) => s.brokerSymbolId === brokerSymbol.id) };
}

/** = prisma.account.findUniqueOrThrow({ where: { id }, include: { group: { include: { allowedSymbols: { select: { symbolId: true } } } } } }) */
export async function loadOrderAccount(db: Db, accountId: string): Promise<OrderAccount> {
  const [account, group, allowedSymbols] = await Promise.all([
    db.account.findUniqueOrThrow({ where: { id: accountId } }),
    db.group.findFirst({ where: { accounts: { some: { id: accountId } } } }),
    db.groupSymbol.findMany({ where: { group: { accounts: { some: { id: accountId } } } }, select: { symbolId: true, groupId: true } }),
  ]);
  // the group read and the account read are separate statements: use the group only if it is the account's own (every
  // account has one). If the account moved group between them, read its group the old way (rare: one more round trip,
  // never a wrong group).
  if (!group || group.id !== account.groupId) {
    const g = await db.group.findUniqueOrThrow({ where: { id: account.groupId }, include: { allowedSymbols: { select: { symbolId: true } } } });
    return { ...account, group: g };
  }
  return { ...account, group: { ...group, allowedSymbols: allowedSymbols.filter((s) => s.groupId === group.id).map(({ symbolId }) => ({ symbolId })) } };
}
