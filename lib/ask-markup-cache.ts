import type { Prisma, PrismaClient } from "@prisma/client";
import { loadAskRules, NO_MARKUP, type AskRule, type AskRuleKey, type AskRules } from "@/lib/ask-markup";

// Per-cycle cache for the symmetric-markup rules (owner decision 2026-10-30: "no per-position query; markup-0
// short-circuits; cache the config per cycle; cache-aside").
//
// WHY THIS EXISTS. Under the ask-only rule a BUY closed at the RAW bid, so lib/ask-markup.ts's loader deliberately
// resolved SELL positions only -- a book of only BUY positions issued no query at all. The symmetric rule marks the
// bid down by the same half, so both sides need a rule, and that cheap case became "one batched read every pass".
// loadAskRules was already BATCHED (5-6 reads over id arrays, never one per position), so the risk was never a query
// storm; it was losing the zero-query steady state on a database whose compute quota has caused an outage before
// (2026-09-26). This cache restores it: the configuration is read once and reused until it changes.
//
// CACHE-ASIDE. The caller asks for the pairs it needs; hits are served from the map, and ONLY the misses go to
// loadAskRules in one batch, after which they are written back. Nothing here reads the database on its own schedule,
// so a quiet platform makes no queries at all.
//
// NEGATIVE CACHING IS THE POINT. A pair that resolves to nothing (no BrokerSymbol row for the broker and symbol, an
// account the batch could not see) is cached as NO_MARKUP rather than left absent. Without that, exactly the cheap
// case this exists for -- an all-BUY book on symbols with no markup -- would miss on every pair on every cycle and
// re-query forever, which is worse than having no cache.
//
// MARKUP-0 SHORT-CIRCUIT. A resolved rule of zero markup needs no arithmetic either: halfMarkupPrice returns 0 and
// markedDownBid / markedUpAsk hand back the raw bid and ask untouched. So for a symbol whose levels are all zero --
// XAUUSD on a group with no GroupSymbolConfig row, where BrokerSymbol.spreadMarkup is 0 -- a BUY still closes at the
// raw bid, exactly as before, and after the first cycle it costs no query either.
//
// STALENESS. A config change is picked up within TTL_MS, or at once via invalidateAskRules() wherever the app already
// handles a ConfigChanged / AccountUpdated event (the api-gateway does the same thing for its own rule cache, see
// services/api-gateway/src/client-ask.ts's comment on not keeping Neon awake). TTL_MS is deliberately short relative
// to how often a markup is edited (rarely) and long relative to a pass (the margin monitor runs every 5 s).

type Db = PrismaClient | Prisma.TransactionClient;

/** How long a resolved rule is reused. A markup edit lands within this long unless invalidateAskRules() is called. */
export const ASK_RULE_TTL_MS = 60_000;

/** Hard ceiling, so a long-lived server instance cannot grow the map without bound. On overflow the whole map is
 *  dropped rather than evicted one by one: it is a cache, and a cold pass costs one batched read. */
const MAX_ENTRIES = 20_000;

type Entry = { rule: AskRule; at: number };

const cache = new Map<string, Entry>();
const keyOf = (accountId: string, symbolId: string) => `${accountId}|${symbolId}`;

/** Drop cached rules: everything, one account, or one (account, symbol). Call from the ConfigChanged /
 *  AccountUpdated handling so a markup edit is visible immediately instead of within ASK_RULE_TTL_MS. */
export function invalidateAskRules(scope?: { accountId: string; symbolId?: string }): void {
  if (!scope) {
    cache.clear();
    return;
  }
  if (scope.symbolId) {
    cache.delete(keyOf(scope.accountId, scope.symbolId));
    return;
  }
  const prefix = `${scope.accountId}|`;
  for (const k of cache.keys()) if (k.startsWith(prefix)) cache.delete(k);
}

/** Test / diagnostic view: how many rules are held right now. */
export function askRuleCacheSize(): number {
  return cache.size;
}

/**
 * The rules for `pairs`, cache-aside: hits from the map, one batched `loadAskRules` for the misses, then written back.
 *
 * The returned `AskRules` answers for every pair asked for -- a pair that resolved to nothing answers `NO_MARKUP`
 * (raw on both sides), the same fallback the ask-only code used for a missing rule, so callers never have to handle
 * `null`. Pairs NOT asked for are not answered, exactly like `loadAskRules`.
 */
export async function askRulesCached(db: Db, pairs: AskRuleKey[], now: number = Date.now()): Promise<AskRules> {
  const resolved = new Map<string, AskRule>();
  const misses: AskRuleKey[] = [];
  const seen = new Set<string>();

  for (const p of pairs) {
    const k = keyOf(p.accountId, p.symbolId);
    if (seen.has(k)) continue;
    seen.add(k);
    const hit = cache.get(k);
    if (hit && now - hit.at < ASK_RULE_TTL_MS) {
      resolved.set(k, hit.rule);
    } else {
      if (hit) cache.delete(k); // expired
      misses.push({ accountId: p.accountId, symbolId: p.symbolId });
    }
  }

  if (misses.length > 0) {
    const loaded = await loadAskRules(db, misses);
    if (cache.size + misses.length > MAX_ENTRIES) cache.clear();
    for (const m of misses) {
      const k = keyOf(m.accountId, m.symbolId);
      // negative result cached as NO_MARKUP on purpose -- see the module comment
      const rule = loaded.get(m.accountId, m.symbolId) ?? NO_MARKUP;
      resolved.set(k, rule);
      cache.set(k, { rule, at: now });
    }
  }

  return { get: (a, s) => resolved.get(keyOf(a, s)) ?? null };
}

/** `askRulesCached` for a set of positions -- the cached counterpart of lib/ask-markup.ts loadCloseAskRules. */
export function closeAskRulesCached(
  db: Db,
  positions: { accountId: string; symbolId: string; side: "BUY" | "SELL" }[],
  now?: number
): Promise<AskRules> {
  return askRulesCached(db, positions.map((p) => ({ accountId: p.accountId, symbolId: p.symbolId })), now);
}
