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
