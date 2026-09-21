import type { Prisma, PrismaClient } from "@prisma/client";
import { legacyGroupTypeFor } from "@/lib/group-routing";

/**
 * The starter state every NEW broker is provisioned with.
 *
 * Before this existed, POST /api/admin/brokers created a Broker row and
 * nothing else: no groups, no symbols. The tenant was born unusable --
 * provisionAccount resolves the broker's isDefault group, found none, and
 * threw NO_GROUP_AVAILABLE, so the broker could not create a single account.
 * Meanwhile prisma/seed.ts DID create groups and symbols, by hand, so the two
 * paths had drifted apart. This module is the one definition both now call.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

/**
 * The curated platform-default symbol set.
 *
 * This is NOT an invented list. It is the exact set that both real production
 * brokers (futurixglobal and novamarkets) independently converged on -- 16
 * enabled symbols, identical on both, out of the 30 that exist in the Symbol
 * master.
 *
 * The other 14 are enabled by NO broker: AUDJPY CADJPY CHFJPY EURCHF EURGBP
 * EURJPY GBPJPY USDCAD USDCHF USDJPY XAUEUR GER40 JPN225 UK100. That set is
 * every JPY cross, the non-USD-quoted majors, EUR-quoted gold and the non-US
 * indices -- the shape of a feed that only carries USD-quoted instruments,
 * not a product choice. No broker curating a lineup drops USDJPY while
 * keeping SOLUSD. Treated as dead and deliberately not shipped to new tenants.
 *
 * digits and contractSize are properties of the instrument itself and live on
 * the GLOBAL Symbol row (Symbol.name is @unique -- symbols are shared
 * platform-wide, never per-broker), so they are stated once here and upserted
 * rather than copied per broker.
 */
export const STARTER_SYMBOLS = [
  { name: "EURUSD", baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
  { name: "GBPUSD", baseCurrency: "GBP", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
  { name: "AUDUSD", baseCurrency: "AUD", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
  { name: "NZDUSD", baseCurrency: "NZD", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
  { name: "XAUUSD", baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: "100", category: "METALS" },
  { name: "XAGUSD", baseCurrency: "XAG", quoteCurrency: "USD", digits: 3, contractSize: "5000", category: "METALS" },
  { name: "XPTUSD", baseCurrency: "XPT", quoteCurrency: "USD", digits: 2, contractSize: "100", category: "METALS" },
  { name: "NAS100", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "INDICES" },
  { name: "US30", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "INDICES" },
  { name: "US500", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "INDICES" },
  { name: "BTCUSD", baseCurrency: "BTC", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "CRYPTO" },
  { name: "ETHUSD", baseCurrency: "ETH", quoteCurrency: "USD", digits: 2, contractSize: "1", category: "CRYPTO" },
  { name: "SOLUSD", baseCurrency: "SOL", quoteCurrency: "USD", digits: 2, contractSize: "1", category: "CRYPTO" },
  { name: "XRPUSD", baseCurrency: "XRP", quoteCurrency: "USD", digits: 4, contractSize: "100", category: "CRYPTO" },
  { name: "SpotCrude", baseCurrency: "USD", quoteCurrency: "USD", digits: 3, contractSize: "100", category: "COMMODITIES" },
  { name: "SpotBrent", baseCurrency: "USD", quoteCurrency: "USD", digits: 3, contractSize: "100", category: "COMMODITIES" },
] as const;

/**
 * The three starter groups.
 *
 * Every BrokerSymbol field except brokerId/symbolId is left at its schema
 * default, which is what every one of futurixglobal's 16 enabled rows already
 * holds -- verified row by row against production, they carry no per-broker
 * tuning at all (minLot 0.01, maxLot 100, lotStep 0.01, swaps 0, commission 0,
 * stopLevel 0, tradingMode BOTH, spreadMarkup 0). Restating those defaults
 * here would create a second place to keep them correct, so they are not
 * restated.
 *
 * spreadMarkup 0 is the deliberate "source spread" position: the group, not
 * the symbol, is where a broker adds markup -- see
 * docs/CURRENT-STRUCTURE-MAP.md.
 */
export const STARTER_GROUPS = [
  {
    name: "Standard",
    category: "B_BOOK",
    modeRestriction: "ANY",
    dealingMode: "INHERIT",
    isDefault: true,
    isClientSelectable: true,
    leverage: 100,
  },
  {
    name: "Demo",
    category: "B_BOOK",
    modeRestriction: "DEMO_ONLY",
    dealingMode: "INHERIT",
    isDefault: false,
    isClientSelectable: true,
    leverage: 100,
  },
  {
    name: "Dealing",
    category: "DEALING",
    modeRestriction: "ANY",
    dealingMode: "INHERIT",
    isDefault: false,
    isClientSelectable: true,
    leverage: 100,
  },
] as const;

export type StarterStateResult = {
  groupsCreated: number;
  symbolsCreated: number;
  brokerSymbolsCreated: number;
  deskTurnedOff: boolean;
};

/**
 * Give a broker everything it needs to be usable: three groups and the 16
 * starter symbols.
 *
 * Idempotent by design -- every write is guarded on a real unique constraint
 * (Symbol.name, Group.brokerId_name, BrokerSymbol.brokerId_symbolId) and an
 * existing row is skipped, never rewritten. Re-running therefore cannot
 * overwrite a value a broker has since tuned, which is what lets
 * prisma/seed.ts call it on every run.
 *
 * MUST be called with the caller's transaction client so a broker is never
 * left half-provisioned: POST /api/admin/brokers creates the Broker, the
 * AuditLog and optionally the first AdminUser in one transaction, and this
 * joins it.
 */
export async function provisionStarterState(tx: Tx, brokerId: string): Promise<StarterStateResult> {
  // "Fresh" is decided BEFORE anything is written, and only a broker with no
  // groups at all counts as new. This is what makes the desk switch below safe
  // on a re-run.
  const existingGroups = await tx.group.count({ where: { brokerId } });
  const isFresh = existingGroups === 0;

  let symbolsCreated = 0;
  const symbolIdByName = new Map<string, string>();
  for (const def of STARTER_SYMBOLS) {
    const before = await tx.symbol.findUnique({ where: { name: def.name }, select: { id: true } });
    const symbol = before ?? (await tx.symbol.create({ data: { ...def } }));
    if (!before) symbolsCreated++;
    symbolIdByName.set(def.name, symbol.id);
  }

  let groupsCreated = 0;
  for (const g of STARTER_GROUPS) {
    const existing = await tx.group.findUnique({
      where: { brokerId_name: { brokerId, name: g.name } },
      select: { id: true },
    });
    if (existing) continue;
    await tx.group.create({
      data: {
        brokerId,
        name: g.name,
        leverage: g.leverage,
        category: g.category,
        modeRestriction: g.modeRestriction,
        dealingMode: g.dealingMode,
        isDefault: g.isDefault,
        isClientSelectable: g.isClientSelectable,
        // The pre-Stage-1 shadow column. Nothing reads it, but backoffice
        // builds older than 1.0.10 still display it, so it is derived from the
        // routing rather than left at its own unrelated default. Stage 5 drops
        // the column and this line with it.
        groupType: legacyGroupTypeFor({ category: g.category, modeRestriction: g.modeRestriction }),
      },
    });
    groupsCreated++;
  }

  let brokerSymbolsCreated = 0;
  for (const def of STARTER_SYMBOLS) {
    const symbolId = symbolIdByName.get(def.name);
    if (!symbolId) continue;
    const existing = await tx.brokerSymbol.findUnique({
      where: { brokerId_symbolId: { brokerId, symbolId } },
      select: { id: true },
    });
    if (existing) continue;
    await tx.brokerSymbol.create({ data: { brokerId, symbolId, enabled: true } });
    brokerSymbolsCreated++;
  }

  // The Dealing group ships desk-OFF: its orders auto-fill, and nothing
  // reaches the manual queue until the broker turns the desk on. The switch is
  // Broker.dealingDeskAutoFillAt and it is INVERTED -- a timestamp means
  // auto-fill (desk off), NULL means the dealer is on. A brand-new broker's
  // column is null, so leaving it alone would ship the desk ON and every
  // order would sit unfilled in a queue nobody is watching.
  //
  // Guarded on isFresh so a seed re-run against a broker that has deliberately
  // turned its desk on cannot turn it back off.
  let deskTurnedOff = false;
  if (isFresh) {
    await tx.broker.update({ where: { id: brokerId }, data: { dealingDeskAutoFillAt: new Date() } });
    deskTurnedOff = true;
  }

  return { groupsCreated, symbolsCreated, brokerSymbolsCreated, deskTurnedOff };
}
