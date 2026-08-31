// Verifies the same Redis-backed opaque session lib/auth.ts now issues
// (Phase 1 trust pack §2) -- same cookie name, same Redis key convention
// (`admin_session:{token}`), same JSON payload shape as src/auth.ts's own
// trader-session twin. This replaced JWT verification: a JWT stays valid
// until its own expiry no matter what the server does, which meant an
// admin being disabled/demoted (or an explicit "sign out everywhere")
// never actually closed an already-open connection here -- this Gateway
// kept trusting the old JWT for up to its full 7/30-day life regardless.
// ADMIN_SESSION_SECRET is no longer read here at all (nothing left to
// HMAC-verify) -- see .env.example's own updated comment.

import { getRedis } from "./auth.js";

const SESSION_COOKIE_NAME = "vyx_admin_session";

export type AdminSessionPayload = {
  adminId: string;
  role: string;
  brokerId: string | null;
};

function sessionKey(token: string): string {
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
// the check that actually matters here. Deleting the Redis key (logout,
// a forced revoke, or an admin being disabled/demoted) makes this return
// null on the very next call -- unlike the old JWT, there's no window
// where a revoked admin's already-open WebSocket keeps receiving events
// until the token's own expiry.
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

export function readAdminSessionToken(cookieHeader: string | undefined): string | null {
  return readCookie(cookieHeader, SESSION_COOKIE_NAME);
}

// Re-checked periodically against every open admin WebSocket connection
// (src/ws.ts's attachAdminEventStream) -- a WS upgrade only authenticates
// once, at connect time, so without this a revoked/disabled admin's
// already-open connection would otherwise keep receiving events until
// they closed the tab themselves. A plain key existence check, not a
// full getAdminSession() re-parse -- the connection's brokerId/role are
// already cached on the WebSocket from the original upgrade and can't
// change mid-connection (an admin doesn't get reassigned to a different
// broker while logged in), only "does this token's session still exist"
// can.
export async function isAdminSessionValid(token: string): Promise<boolean> {
  const exists = await getRedis().exists(sessionKey(token));
  return exists === 1;
}
