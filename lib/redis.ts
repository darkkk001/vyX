import "server-only";
import { Redis } from "ioredis";

// Single shared connection per server process — ioredis handles
// reconnection/backoff itself, so this doesn't need its own retry logic.
// Never the authoritative store for anything financial (see
// docs/security.md §2) — only session state and rate-limit counters live
// here; a Redis outage means sessions can't be validated (users get
// logged out / can't log in), never that trading data becomes wrong.
let client: Redis | null = null;

export function getRedis(): Redis {
  if (!client) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    client = new Redis(url);
  }
  return client;
}
