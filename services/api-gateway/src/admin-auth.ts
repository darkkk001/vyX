// Verifies the same Redis-backed opaque session lib/auth.ts (Next.js) now
// issues (docs/authentication.md §2 -- admin sessions migrated off JWT
// the same way trader sessions already were, see src/auth.ts's own
// comment for the original reasoning). Same cookie name, same Redis key
// convention (`admin_session:{token}`), same JSON payload shape. This
// replaced JWT verification: a JWT stayed valid until its own expiry no
// matter what the server did, which meant "log out" or "revoke a device"
// here was only ever cosmetic. Reading the session from Redis means
// either takes effect immediately, everywhere that checks it -- including
// this Gateway.

import { Redis } from "ioredis";

const SESSION_COOKIE_NAME = "vyx_admin_session";

export type AdminSessionPayload = {
  adminId: string;
  role: string;
  brokerId: string | null;
};

let redis: Redis | null = null;
function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    redis = new Redis(url);
  }
  return redis;
}

function sessionKey(token: string) {
  return `admin_session:${token}`;
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Used only by src/ws.ts's admin event-stream upgrade handler, which has
// no Express request/response to hang middleware off -- same reasoning
// as src/auth.ts's getTraderSession. Doesn't cross-check x-broker-id the
// way lib/auth.ts's own getAdminSession does for Server Components: a
// browser WebSocket upgrade can't send that header either, and the only
// consumer of this (attachAdminEventStream) already scopes every
// forwarded message to payload.brokerId === session.brokerId, which is
// the check that actually matters here.
export async function getAdminSession(cookieHeader: string | undefined): Promise<AdminSessionPayload | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!token) return null;

  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AdminSessionPayload;
  } catch {
    return null;
  }
}
