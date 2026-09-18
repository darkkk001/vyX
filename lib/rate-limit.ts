import "server-only";
import { getRedis } from "@/lib/redis";

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
  const redis = getRedis();
  const redisKey = `ratelimit:${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return { allowed: count <= limit, remaining: Math.max(0, limit - count) };
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
  const count = await getRedis().get(`${LOCKOUT_KEY_PREFIX}${key}`);
  return Number(count ?? 0) >= limit;
}

export async function recordFailure(key: string, windowSeconds: number): Promise<number> {
  const redis = getRedis();
  const redisKey = `${LOCKOUT_KEY_PREFIX}${key}`;
  const count = await redis.incr(redisKey);
  if (count === 1) {
    await redis.expire(redisKey, windowSeconds);
  }
  return count;
}

export async function clearFailures(key: string): Promise<void> {
  await getRedis().del(`${LOCKOUT_KEY_PREFIX}${key}`);
}
