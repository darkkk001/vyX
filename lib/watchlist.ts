import "server-only";
import { prisma } from "@/lib/prisma";

// The historical fixed watchlist (lib/market-simulator.ts's old SYMBOL_DEFS)
// used as a starter set for a brand-new account or a "reset to default" --
// not a hard requirement, just a sane default so a fresh terminal isn't
// either empty or instantly showing all 30 enabled symbols at once. Only
// the ones actually enabled for this broker are used; if none of them
// are (a broker with a totally different symbol lineup), falls back to
// the first N enabled symbols by name.
const DEFAULT_WATCHLIST_SYMBOL_NAMES = [
  "XAUUSD",
  "EURUSD",
  "GBPUSD",
  "BTCUSD",
  "US30",
  "USDJPY",
  "AUDUSD",
  "XAGUSD",
  "ETHUSD",
  "NAS100",
];

export type WatchlistSymbolRow = {
  id: string;
  name: string;
  category: string;
  digits: number;
  contractSize: string;
};

async function seedDefaultWatchlist(accountId: string, brokerId: string): Promise<void> {
  const enabled = await prisma.brokerSymbol.findMany({
    where: { brokerId, enabled: true },
    include: { symbol: { select: { id: true, name: true } } },
  });
  if (enabled.length === 0) return;

  const byName = new Map(enabled.map((bs) => [bs.symbol.name, bs.symbol.id]));
  let picked = DEFAULT_WATCHLIST_SYMBOL_NAMES.map((name) => byName.get(name)).filter((id): id is string => !!id);
  if (picked.length === 0) {
    picked = enabled
      .map((bs) => bs.symbol)
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 10)
      .map((s) => s.id);
  }

  await prisma.watchlistItem.createMany({
    data: picked.map((symbolId, index) => ({ accountId, symbolId, position: index })),
    skipDuplicates: true,
  });
}

// Every read goes through this -- a brand new account (no rows yet) and
// an account that just called "reset to default" look identical (zero
// rows), so both get the same lazy-seed-then-return behavior. Returns
// symbols in the account's own persisted order.
export async function getOrSeedWatchlist(accountId: string, brokerId: string): Promise<WatchlistSymbolRow[]> {
  let items = await prisma.watchlistItem.findMany({
    where: { accountId },
    orderBy: { position: "asc" },
    include: { symbol: { select: { id: true, name: true, category: true, digits: true, contractSize: true } } },
  });

  if (items.length === 0) {
    await seedDefaultWatchlist(accountId, brokerId);
    items = await prisma.watchlistItem.findMany({
      where: { accountId },
      orderBy: { position: "asc" },
      include: { symbol: { select: { id: true, name: true, category: true, digits: true, contractSize: true } } },
    });
  }

  return items.map((item) => ({
    id: item.symbol.id,
    name: item.symbol.name,
    category: item.symbol.category,
    digits: item.symbol.digits,
    contractSize: item.symbol.contractSize.toString(),
  }));
}
