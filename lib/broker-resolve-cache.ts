// The broker lookup cache middleware.ts puts in front of /api/internal/resolve-broker (one Neon query per call). Plain
// module code with no Node or server-only imports, so it runs on the Edge isolate as well as in the tests.
//
// Neon load (2026-10-05): resolve-broker ran at ~3.7 calls/s, about 0.6 per backoffice API request. Two causes:
//   - no in-flight sharing: N parallel requests that missed the cache together (the backoffice's 9 badge requests)
//     made N lookups. Now concurrent misses for one hostname share ONE lookup.
//   - a 30 s fresh window. Broker metadata (tier/logo/color/custom domain) changes rarely; now 5 min.
// Unchanged: a failed lookup falls back to an entry up to STALE_MS old (a DB/network blip serves slightly stale broker
// info instead of taking the broker's site down), and a failure is never cached, so the next request retries.

export const BROKER_FRESH_MS = 5 * 60_000;
export const BROKER_STALE_MS = 30 * 60_000;

export type BrokerResolver<T> = {
  /** The value for `key`: cached while fresh, else `fetcher()` (one call shared by every concurrent caller for that
   *  key; the first caller's fetcher is the one that runs). A failed fetch falls back to a cached value up to staleMs
   *  old; with none, the fetch's error is thrown. */
  resolve(key: string, fetcher: () => Promise<T>): Promise<T>;
};

export function createBrokerResolver<T>(
  opts: { freshMs?: number; staleMs?: number; now?: () => number } = {}
): BrokerResolver<T> {
  const freshMs = opts.freshMs ?? BROKER_FRESH_MS;
  const staleMs = opts.staleMs ?? BROKER_STALE_MS;
  const now = opts.now ?? Date.now;
  const cache = new Map<string, { value: T; fetchedAt: number }>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    async resolve(key, fetcher) {
      const startedAt = now();
      const cached = cache.get(key);
      if (cached && startedAt - cached.fetchedAt < freshMs) return cached.value;
      let pending = inFlight.get(key);
      if (!pending) {
        pending = fetcher()
          .then((value) => {
            cache.set(key, { value, fetchedAt: startedAt });
            return value;
          })
          .finally(() => inFlight.delete(key));
        inFlight.set(key, pending);
      }
      try {
        return await pending;
      } catch (err) {
        if (cached && startedAt - cached.fetchedAt < staleMs) return cached.value;
        throw err;
      }
    },
  };
}
