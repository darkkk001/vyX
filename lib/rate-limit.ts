import "server-only";
import { getRedis } from "@/lib/redis";

// One atomic step: count, and give the key its window when it has none. INCR then EXPIRE as two calls left a key with
// no expiry whenever the second call failed, and that key then refused its login forever (infra audit 2026-10-28). The
// TTL = -1 check also heals any key already stuck that way. ARGV[2] (optional): at this count, restart the window, so a
// lockout reached on the Nth failure lasts the full window from that failure.
const INCR_WITH_WINDOW = `
local c = redis.call('INCR', KEYS[1])
if c == 1 or redis.call('TTL', KEYS[1]) == -1 or (ARGV[2] and tonumber(ARGV[2]) == c) then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return c`;

async function incrWithWindow(redisKey: string, windowSeconds: number, restartAt?: number): Promise<number> {
  const args = restartAt === undefined ? [String(windowSeconds)] : [String(windowSeconds), String(restartAt)];
  return Number(await getRedis().eval(INCR_WITH_WINDOW, 1, redisKey, ...args));
}

// Redis down must not turn into a login error (owner 2026-10-28): every helper here lets the request through and logs.
function failOpen(what: string, key: string, err: unknown): void {
  console.warn(`[rate-limit] ${what} skipped for ${key}: Redis unavailable (${err instanceof Error ? err.message : String(err)})`);
}

// Fixed-window counter — simple, and correct enough for login-attempt
// throttling (docs/authentication.md §2's "closes the no-rate-limiting
// gap" item). Not used for anything financial, so the small edge-of-window
// burst a fixed window allows (vs. a sliding window) isn't worth the
// extra complexity here.
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number
): Promise<{ allowed: boolean; remaining: number }> {
  const redisKey = `ratelimit:${key}`;
  try {
    const count = await incrWithWindow(redisKey, windowSeconds);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
  } catch (err) {
    failOpen("rate limit", redisKey, err);
    return { allowed: true, remaining: limit };
  }
}

// Failure-only lockout, for the second factor (pentest 2026-09-18 #4).
// checkRateLimit above counts every attempt against a key the caller
// chooses; the 2FA verify routes keyed it on the pending token, so each
// fresh login handed the same account a fresh guess budget and no number
// of wrong codes ever locked the ACCOUNT. These count wrong codes per
// principal across every pending token, and only wrong codes -- a
// genuine sign-in from a sixth device in the window must not be locked
// out by its own successes.
const LOCKOUT_KEY_PREFIX = "lockout:";

export async function isLockedOut(key: string, limit: number): Promise<boolean> {
  return (await lockoutRemainingSeconds(key, limit)) > 0;
}

/** Seconds left on a lockout (0 = not locked): for the Retry-After of the refusal. */
export async function lockoutRemainingSeconds(key: string, limit: number): Promise<number> {
  const redisKey = `${LOCKOUT_KEY_PREFIX}${key}`;
  try {
    const [[, count], [, ttl]] = (await getRedis().multi().get(redisKey).ttl(redisKey).exec()) as [[unknown, string | null], [unknown, number]];
    if (Number(count ?? 0) < limit) return 0;
    return ttl > 0 ? ttl : 1;
  } catch (err) {
    failOpen("lockout check", redisKey, err);
    return 0;
  }
}

/** Counts one failure. `lockAt`: the failure that locks restarts the window, so the lock lasts the full window. */
export async function recordFailure(key: string, windowSeconds: number, lockAt?: number): Promise<number> {
  const redisKey = `${LOCKOUT_KEY_PREFIX}${key}`;
  try {
    return await incrWithWindow(redisKey, windowSeconds, lockAt);
  } catch (err) {
    failOpen("failure count", redisKey, err);
    return 0;
  }
}

export async function clearFailures(key: string): Promise<void> {
  const redisKey = `${LOCKOUT_KEY_PREFIX}${key}`;
  try {
    await getRedis().del(redisKey);
  } catch (err) {
    failOpen("failure reset", redisKey, err);
  }
}
