// What a symbol needs before the platform can trade it for a broker, in ONE place (hotfix 2026-10-08).
//
// Used by: GET /api/manage/symbols (the backoffice shows a red "Incomplete" chip on a row with anything missing, the
// tooltip lists these sentences), scripts/add-feed-symbol.ts (refuses to create a symbol that would be incomplete, and
// copies sessions / group rows from a template symbol of the same class) and scripts/fix-usdx.ts.
//
// The rules are the ones a symbol that already trades satisfies (US30, NAS100, EURUSD ... at Futurix), nothing more:
// trading-hours rows and group pricing rows are NOT required (no sessions = the default week, no group row = the symbol's own
// values), because the symbols that work today have neither. A row with no BrokerSymbol at all is "not set up for this
// broker", not "incomplete": it is not in the broker's list.
//
// Every sentence is plain words for a broker's staff (no field names).

type Num = string | number | { toString(): string } | null | undefined;

export type CompletenessInput = {
  symbol: {
    name: string;
    category: string | null | undefined;
    baseCurrency: string | null | undefined;
    quoteCurrency: string | null | undefined;
    digits: number | null | undefined;
    contractSize: Num;
  };
  /** null / undefined = the broker has no row for this symbol (not part of its list). */
  brokerSymbol:
    | {
        enabled: boolean;
        minLot: Num;
        maxLot: Num;
        lotStep: Num;
        hedgedMarginPct: Num;
        tradingMode: string | null | undefined;
        defaultBookType: string | null | undefined;
      }
    | null
    | undefined;
  /** Optional, only when the caller knows it (the feed's last tick for this symbol, in ms ago; null = never). undefined = unknown, not checked. */
  feedTickAgeMs?: number | null;
};

const CATEGORIES = ["FOREX", "METALS", "INDICES", "CRYPTO", "COMMODITIES", "STOCKS"];
const MODES = ["BOTH", "BUY_ONLY", "SELL_ONLY"];
const BOOKS = ["A_BOOK", "B_BOOK"];
/** A symbol whose last feed tick is older than this has no working price feed (a weekend gap is shorter than 5 days). */
export const FEED_STALE_MS = 5 * 24 * 3600 * 1000;

function num(v: Num): number {
  if (v === null || v === undefined || v === "") return NaN;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : NaN;
}

/** The missing pieces of one symbol, as plain sentences. [] = complete (or not part of the broker's list). */
export function missingForSymbol(input: CompletenessInput): string[] {
  const { symbol, brokerSymbol } = input;
  if (!brokerSymbol) return [];
  const out: string[] = [];

  if (!symbol.category || !CATEGORIES.includes(symbol.category)) out.push("Asset class is not set");
  if (!symbol.baseCurrency || !symbol.baseCurrency.trim()) out.push("Base currency is not set");
  if (!symbol.quoteCurrency || !symbol.quoteCurrency.trim()) out.push("Profit currency is not set");
  const digits = symbol.digits;
  if (digits === null || digits === undefined || !Number.isInteger(digits) || digits < 0 || digits > 8) out.push("Price digits are not set");
  if (!(num(symbol.contractSize) > 0)) out.push("Contract size is not set");

  const min = num(brokerSymbol.minLot);
  const max = num(brokerSymbol.maxLot);
  const step = num(brokerSymbol.lotStep);
  if (!(min > 0)) out.push("Minimum lot is not set");
  if (!(step > 0)) out.push("Lot step is not set");
  if (!(max > 0)) out.push("Maximum lot is not set");
  else if (min > 0 && max < min) out.push("Maximum lot is below the minimum lot");

  const hedged = num(brokerSymbol.hedgedMarginPct);
  if (!(hedged >= 0 && hedged <= 200)) out.push("Hedged margin is not set");
  if (!brokerSymbol.tradingMode || !MODES.includes(brokerSymbol.tradingMode)) out.push("Allowed sides are not set");
  if (!brokerSymbol.defaultBookType || !BOOKS.includes(brokerSymbol.defaultBookType)) out.push("Book is not set");

  if (input.feedTickAgeMs !== undefined && brokerSymbol.enabled && (input.feedTickAgeMs === null || input.feedTickAgeMs > FEED_STALE_MS)) {
    out.push("No price from the feed yet");
  }
  return out;
}

/** Minimal shape of the Prisma client / transaction this module reads (so scripts and tests can pass either or a fake). */
export type CompletenessDb = {
  symbol: { findMany(args: unknown): Promise<unknown[]> };
};

type SymbolRow = {
  id: string;
  name: string;
  category: string | null;
  baseCurrency: string | null;
  quoteCurrency: string | null;
  digits: number | null;
  contractSize: Num;
  brokerSymbols: { enabled: boolean; minLot: Num; maxLot: Num; lotStep: Num; hedgedMarginPct: Num; tradingMode: string | null; defaultBookType: string | null }[];
};

/** symbolId -> missing sentences, for this broker's symbols (all of them, or just <paramref name="symbolIds"/>). Complete ones are absent. */
export async function symbolCompleteness(db: CompletenessDb, brokerId: string, symbolIds?: string[]): Promise<Map<string, string[]>> {
  const rows = (await db.symbol.findMany({
    where: symbolIds ? { id: { in: symbolIds } } : undefined,
    include: { brokerSymbols: { where: { brokerId } } },
  })) as SymbolRow[];
  const out = new Map<string, string[]>();
  for (const s of rows) {
    const m = missingForSymbol({ symbol: s, brokerSymbol: s.brokerSymbols[0] ?? null });
    if (m.length) out.set(s.id, m);
  }
  return out;
}
