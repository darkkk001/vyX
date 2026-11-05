import type { Prisma, PrismaClient } from "@prisma/client";

// HMR plugin (high margin requirement windows), owner spec 2026-11-06 (C1-C3).
//
// While Broker.hmrEnabled is on and an enabled HmrWindow for currency X is active (startsAt <= now < endsAt), a NEW
// position on a symbol in X's correlation list opens with effective leverage
//     min(account leverage, group maximum, HMR leverage of every active window touching that symbol)
// That figure is used for the open's margin check and, when it is below the account's leverage, stored on the position
// (Position.openLeverage). The position keeps its margin at that leverage until it closes, also after the window ends
// (owner decision Q1). Existing positions are never touched. Margin everywhere is per position:
//     leverage = position.openLeverage ?? account.leverage
// The Rust engine implements the same rules (engine/order-management/src/hmr.rs); docs/contracts/gate-vectors.json holds the
// shared vectors both sides must agree on (web: lib/hmr.test.ts, engine: the gate_parity test).

export const HMR_CURRENCIES = ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF"] as const;

export type HmrSymbolInfo = { name: string; baseCurrency: string; quoteCurrency: string };

// Index / metal symbols the spec adds to a currency's list (C2), when the broker has them enabled.
const EXTRA_SYMBOLS: Record<string, string[]> = {
  USD: ["XAUUSD", "XAGUSD", "USDX", "DXY", "US30", "NAS100", "SPX500"],
  EUR: ["GER40", "EU50"],
  GBP: ["UK100"],
  JPY: ["JPN225"],
  AUD: ["AUS200"],
};

/** The default correlation map (C2), built from the broker's ENABLED symbols only: a symbol the broker has not enabled is never listed. */
export function defaultHmrCorrelations(enabled: HmrSymbolInfo[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const cur of HMR_CURRENCIES) {
    const extra = new Set(EXTRA_SYMBOLS[cur] ?? []);
    out[cur] = enabled
      .filter((s) => s.baseCurrency === cur || s.quoteCurrency === cur || extra.has(s.name))
      .map((s) => s.name)
      .sort();
  }
  return out;
}

export type HmrWindowLite = { id: string; currency: string; startsAt: Date; endsAt: Date; leverage: number; enabled: boolean };

export type HmrState = {
  enabled: boolean;
  /** enabled windows that have not ended yet (active and upcoming) */
  windows: HmrWindowLite[];
  /** currency -> symbol names */
  symbolsByCurrency: Map<string, Set<string>>;
};

export const HMR_OFF: HmrState = { enabled: false, windows: [], symbolsByCurrency: new Map() };

/** Windows in effect for `symbol` at `now`, lowest leverage first (ties: the one ending last). */
export function activeHmrWindows(state: HmrState, symbol: string, now: Date): HmrWindowLite[] {
  if (!state.enabled) return [];
  const t = now.getTime();
  return state.windows
    .filter((w) => w.enabled && w.startsAt.getTime() <= t && t < w.endsAt.getTime() && state.symbolsByCurrency.get(w.currency)?.has(symbol))
    .sort((a, b) => a.leverage - b.leverage || b.endsAt.getTime() - a.endsAt.getTime());
}

export type OpenLeverage = {
  /** leverage the open's margin check uses */
  leverage: number;
  /** what to store on the position: the effective leverage when it is below the account's, else null (= follow the account) */
  openLeverage: number | null;
  /** the window that set the figure (lowest leverage), null when HMR did not lower it */
  hmr: { currency: string; endsAt: Date; leverage: number; symbol: string } | null;
};

/** The effective leverage for a NEW position (C3). `groupMax` null = no group ceiling. */
export function effectiveOpenLeverage(p: { accountLeverage: number; groupMax: number | null; state: HmrState; symbol: string; now: Date }): OpenLeverage {
  const base = p.groupMax != null ? Math.min(p.accountLeverage, p.groupMax) : p.accountLeverage;
  const windows = activeHmrWindows(p.state, p.symbol, p.now);
  const lowest = windows[0];
  const leverage = lowest ? Math.min(base, lowest.leverage) : base;
  const hmrBound = lowest != null && lowest.leverage < base;
  return {
    leverage,
    openLeverage: leverage < p.accountLeverage ? leverage : null,
    hmr: hmrBound ? { currency: lowest.currency, endsAt: lowest.endsAt, leverage: lowest.leverage, symbol: p.symbol } : null,
  };
}

function hhmm(d: Date): string {
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}

/** The refusal text that names HMR (C3): "HMR in effect for USD until 14:30 UTC: leverage 1:20 on new XAUUSD positions". */
export function hmrRefusalText(h: { currency: string; endsAt: Date; leverage: number; symbol: string }): string {
  return `HMR in effect for ${h.currency} until ${hhmm(h.endsAt)} UTC: leverage 1:${h.leverage} on new ${h.symbol} positions`;
}

/** Margin leverage of one position (the formula both web and engine use). */
export function positionLeverage(p: { openLeverage: number | null | undefined }, accountLeverage: number): number {
  return p.openLeverage ?? accountLeverage;
}

type Db = PrismaClient | Prisma.TransactionClient;

// A short cache per broker: the order hot path reads this on every open. Window edges are evaluated against the clock at
// each call (the cache holds the windows, not "is one active"), so only an EDIT lags, by at most HMR_CACHE_MS in another
// worker; the plugin routes clear this process's copy at once.
const HMR_CACHE_MS = 3000;
const cache = new Map<string, { at: number; state: HmrState }>();
export function resetHmrCache(brokerId?: string): void {
  if (brokerId) cache.delete(brokerId);
  else cache.clear();
}

export async function loadHmrState(db: Db, brokerId: string, now: Date = new Date(), opts: { fresh?: boolean } = {}): Promise<HmrState> {
  const hit = cache.get(brokerId);
  if (!opts.fresh && hit && Date.now() - hit.at < HMR_CACHE_MS) return hit.state;
  const broker = await db.broker.findUnique({ where: { id: brokerId }, select: { hmrEnabled: true } });
  let state: HmrState = HMR_OFF;
  if (broker?.hmrEnabled) {
    const [windows, correlations] = await Promise.all([
      db.hmrWindow.findMany({ where: { brokerId, enabled: true, endsAt: { gt: now } }, select: { id: true, currency: true, startsAt: true, endsAt: true, leverage: true, enabled: true } }),
      db.hmrCorrelation.findMany({ where: { brokerId }, select: { currency: true, symbols: true } }),
    ]);
    state = { enabled: true, windows, symbolsByCurrency: new Map(correlations.map((c) => [c.currency, new Set(c.symbols)])) };
  }
  cache.set(brokerId, { at: Date.now(), state });
  return state;
}

/** One call for an open path: the broker's HMR state + the account's and group's figures -> the effective leverage. */
export async function resolveOpenLeverage(db: Db, p: { brokerId: string; accountLeverage: number; groupMax: number | null; symbol: string; now?: Date }): Promise<OpenLeverage> {
  const now = p.now ?? new Date();
  const state = await loadHmrState(db, p.brokerId, now);
  return effectiveOpenLeverage({ accountLeverage: p.accountLeverage, groupMax: p.groupMax, state, symbol: p.symbol, now });
}

/** Seeds the broker's missing correlation rows from its enabled symbols (idempotent; never overwrites an edited row). */
export async function seedHmrCorrelations(db: Db, brokerId: string): Promise<void> {
  const rows = await db.brokerSymbol.findMany({ where: { brokerId, enabled: true }, select: { symbol: { select: { name: true, baseCurrency: true, quoteCurrency: true } } } });
  const map = defaultHmrCorrelations(rows.map((r) => r.symbol));
  await db.hmrCorrelation.createMany({ data: Object.entries(map).map(([currency, symbols]) => ({ brokerId, currency, symbols })), skipDuplicates: true });
}
