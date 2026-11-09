// L2 optimization pass: the two Upstash round trips in front of every order (2026-11-03).
//
// MEASURED FIRST. The gateway's Redis is Upstash over TLS -- `gentle-satyr-109290.upstash.io` -- and a
// single PING from this VPS is 16.9 ms p50 (50 samples: p90 17.6, p99 20.1, min 16.4). Every order paid
// two of those before it did any work:
//   1. `getTraderSession`: GET session:<token>. The token is opaque, so the account id is not known
//      until this returns -- which is why the two calls cannot be pipelined into one.
//   2. `checkRateLimit`: INCR, plus a second EXPIRE on the first request of each window (so the first
//      order of a minute paid THREE round trips, not two).
// That is the ~37 ms the per-stage timing attributed to "middleware before anything else happens".
//
// WHAT IS NOT CHANGED: the session store stays Upstash. It has to -- the WEB mints the session (on
// Vercel) and this gateway only validates it, so pointing the gateway at a local Redis would simply
// stop finding sessions and 401 every order. No auth logic moves, no token is trusted that was not
// trusted before, and a cache miss still does exactly the lookup it always did.

import { getTraderSession, getTraderSessionByToken, type AccountSessionPayload } from "./auth.js";

/**
 * How long a VALIDATED session may be answered from memory. Short on purpose, and the whole of the
 * security cost is this: a session REVOKED in Redis (a logout, an admin killing a session) keeps
 * working here for up to this long.
 *
 * What it does NOT delay, and this is the part that matters: the account's own state. Every order
 * still reads `"Account"` from Postgres and refuses a non-ACTIVE account, and the engine re-checks the
 * ingress scope and `accountMode` itself. So a disabled or suspended account is stopped immediately,
 * cache or no cache -- what the window covers is only "this particular session token was signed out".
 */
const TTL_MS = Number(process.env.GATEWAY_SESSION_CACHE_MS ?? 5_000);

type Entry = { payload: AccountSessionPayload; at: number; refreshing?: boolean };
const cache = new Map<string, Entry>();

/** Keeps the map from growing without bound on a long-lived process. */
function sweep(now: number) {
  if (cache.size < 512) return;
  for (const [k, v] of cache) if (now - v.at > TTL_MS * 4) cache.delete(k);
}

/**
 * `getTraderSession` with a short in-process cache.
 *
 * STALE-WHILE-REVALIDATE: inside the TTL the cached payload is returned with no Redis call at all.
 * Past it, the cached payload is still returned and a refresh runs in the BACKGROUND, so a trader
 * placing orders in a row never waits on Upstash after the first one -- while the entry is still
 * re-validated every TTL. A refresh that finds the session gone drops it, so the next order does the
 * full lookup and 401s.
 */
export async function getTraderSessionCachedByToken(token: string): Promise<AccountSessionPayload | null> {
  if (TTL_MS <= 0) return getTraderSessionByToken(token);
  if (!token) return null;
  const key = token;

  const now = Date.now();
  const hit = cache.get(key);
  if (hit) {
    const age = now - hit.at;
    if (age <= TTL_MS) return hit.payload;
    // stale: answer from memory, re-validate behind the request
    if (!hit.refreshing) {
      hit.refreshing = true;
      void getTraderSessionByToken(token)
        .then((fresh) => {
          if (fresh) cache.set(key, { payload: fresh, at: Date.now() });
          else cache.delete(key);
        })
        .catch(() => cache.delete(key))
        .finally(() => {
          const e = cache.get(key);
          if (e) e.refreshing = false;
        });
    }
    return hit.payload;
  }

  const fresh = await getTraderSessionByToken(token);
  if (fresh) {
    sweep(now);
    cache.set(key, { payload: fresh, at: now });
  }
  return fresh;
}

/**
 * The cookie-header form, kept for any caller that still has only a Cookie header. Resolves the token
 * first so both transports share one cache entry per session.
 */
export async function getTraderSessionCached(cookieHeader: string | undefined): Promise<AccountSessionPayload | null> {
  const { sessionTokenFrom } = await import("./auth.js");
  const token = sessionTokenFrom({ cookie: cookieHeader });
  if (!token) return getTraderSession(cookieHeader);
  return getTraderSessionCachedByToken(token);
}

/** Test/diagnostic: forget everything cached. */
export function clearSessionCache(): void {
  cache.clear();
}
