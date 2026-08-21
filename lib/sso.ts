import "server-only";
import crypto from "node:crypto";
import { getRedis } from "@/lib/redis";

// Single-use, short-lived handoff tokens for the WebTrader SSO flow (see
// app/api/trade/sso/token/route.ts and app/trade/sso/route.ts). Kept in
// Redis, not Postgres -- these are meant to be consumed within seconds of
// issuance (the broker's redirect response reaching the trader's
// browser), never queried or listed, and expiring them is just letting
// the key die rather than a cleanup job.
const TOKEN_TTL_SECONDS = 30;

function tokenKey(token: string) {
  return `sso_token:${token}`;
}

export type SsoTokenPayload = { accountId: string; brokerId: string };

export async function issueSsoToken(payload: SsoTokenPayload): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(tokenKey(token), JSON.stringify(payload), "EX", TOKEN_TTL_SECONDS);
  return token;
}

// Atomic read-then-delete via a single Redis GETDEL -- two concurrent
// requests racing on the same token (a replayed link, a doubled redirect)
// must not both succeed.
export async function consumeSsoToken(token: string): Promise<SsoTokenPayload | null> {
  const raw = await getRedis().getdel(tokenKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as SsoTokenPayload;
  } catch {
    return null;
  }
}
