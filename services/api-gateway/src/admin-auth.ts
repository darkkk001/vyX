// Verifies the same JWT lib/auth.ts (Next.js) signs for the backoffice's
// vyx_admin_session cookie -- unlike the trader session (Redis-backed,
// see src/auth.ts), the admin session was never migrated off JWT, so
// there's no session store to query here: this just needs the same
// signing secret and the same jose verify call lib/auth.ts's own
// verifySessionToken makes. ADMIN_SESSION_SECRET must be the exact same
// value in this process's env as in Vercel/Next.js's -- a mismatch fails
// closed (every admin socket gets 401), not open.

import { jwtVerify } from "jose";

const SESSION_COOKIE_NAME = "vyx_admin_session";

export type AdminSessionPayload = {
  adminId: string;
  role: string;
  brokerId: string | null;
};

let secretKeyBytes: Uint8Array | null = null;
function secretKey(): Uint8Array {
  if (!secretKeyBytes) {
    const secret = process.env.ADMIN_SESSION_SECRET;
    if (!secret) throw new Error("ADMIN_SESSION_SECRET is not set");
    secretKeyBytes = new TextEncoder().encode(secret);
  }
  return secretKeyBytes;
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
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as AdminSessionPayload;
  } catch {
    return null;
  }
}
