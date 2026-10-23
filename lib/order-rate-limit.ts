import "server-only";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// Order rate limit per account (owner 2026-10-23, docs/ORDER-RATE-LIMIT-DESIGN.md). A token bucket in Redis, one per
// account: `burst` orders may arrive back to back, then `perMinute` keep coming forever. Generous on purpose: live peaks
// over 30 days were 25 orders in a second and 90 in a minute for the busiest account, and a back-test bot sending one
// order every 100 ms never touches the default. Per broker, Super Admin sets Broker.orderBurst / orderPerMinute (null =
// default, 0 = off). If Redis cannot be reached the order is allowed: trading never stops because the limiter's store did.

export const DEFAULT_ORDER_BURST = 100;
export const DEFAULT_ORDERS_PER_MINUTE = 600;
export const ORDER_RATE_LIMITED_MESSAGE = "Too many orders in a short time. Wait a moment and try again.";

export type OrderLimits = { burst: number; perMinute: number } | null; // null = no cap

const LIMITS_TTL_MS = 60_000;
const limitsCache = new Map<string, { at: number; limits: OrderLimits }>();

export function resetOrderLimitsCache(): void {
  limitsCache.clear();
}

/** The broker's cap: its own values where set, the platform default otherwise; null when either is 0 (off). */
export function limitsFrom(row: { orderBurst: number | null; orderPerMinute: number | null } | null): OrderLimits {
  const burst = row?.orderBurst ?? DEFAULT_ORDER_BURST;
  const perMinute = row?.orderPerMinute ?? DEFAULT_ORDERS_PER_MINUTE;
  return burst <= 0 || perMinute <= 0 ? null : { burst, perMinute };
}

export async function orderLimitsFor(brokerId: string): Promise<OrderLimits> {
  const hit = limitsCache.get(brokerId);
  if (hit && Date.now() - hit.at < LIMITS_TTL_MS) return hit.limits;
  const row = await prisma.broker.findUnique({ where: { id: brokerId }, select: { orderBurst: true, orderPerMinute: true } });
  const limits = limitsFrom(row);
  limitsCache.set(brokerId, { at: Date.now(), limits });
  return limits;
}

// KEYS[1] = bucket; ARGV = burst, refill per ms, now ms, ttl s. Returns {1, 0} when a token was taken, {0, ms until the
// next token} when not. Atomic: two orders of one account on two instances can never both take the last token.
const TAKE = `
local burst = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local b = redis.call('HMGET', KEYS[1], 't', 'at')
local tokens = tonumber(b[1])
local at = tonumber(b[2])
if tokens == nil then tokens = burst; at = now end
if now > at then tokens = math.min(burst, tokens + (now - at) * rate) end
local ok = 0
local wait = 0
if tokens >= 1 then tokens = tokens - 1; ok = 1 else wait = math.ceil((1 - tokens) / rate) end
redis.call('HSET', KEYS[1], 't', tostring(tokens), 'at', tostring(math.max(now, at)))
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[4]))
return {ok, wait}
`;

export type TakeResult = { allowed: true } | { allowed: false; retryAfterMs: number };

/** Takes one order token for the account. A refused request takes nothing. */
export async function takeOrderToken(accountId: string, limits: OrderLimits, now: number = Date.now()): Promise<TakeResult> {
  if (!limits) return { allowed: true };
  const rate = limits.perMinute / 60_000;
  const ttl = Math.ceil(limits.burst / rate / 1000) + 60; // a full refill, then the key is gone
  try {
    const [ok, wait] = (await getRedis().eval(TAKE, 1, `order-bucket:${accountId}`, limits.burst, rate, now, ttl)) as [number, number];
    return ok === 1 ? { allowed: true } : { allowed: false, retryAfterMs: Math.max(1, wait) };
  } catch (err) {
    console.error("order rate limit: Redis unreachable, order allowed", err);
    return { allowed: true };
  }
}

/** True for the first refusal of a throttled episode (one trace row per episode, not one per request). */
export async function firstRefusalOfEpisode(accountId: string, retryAfterMs: number): Promise<boolean> {
  try {
    const set = await getRedis().set(`order-bucket-episode:${accountId}`, "1", "PX", retryAfterMs + 60_000, "NX");
    return set === "OK";
  } catch {
    return false;
  }
}
