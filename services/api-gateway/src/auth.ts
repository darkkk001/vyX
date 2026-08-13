// Verifies the same JWT the existing Next.js app issues
// (lib/account-auth.ts) — same cookie name, same secret, same payload
// shape. Deliberately NOT the Redis-backed opaque session described in
// docs/authentication.md §2 (that doesn't exist yet); this is the
// currently-real auth mechanism, reused rather than re-invented, per
// docs/api.md §4's open question resolving toward "trust a session the
// Gateway itself verifies" for now.

import type { NextFunction, Request, Response } from "express";
import { jwtVerify } from "jose";

const SESSION_COOKIE_NAME = "vyx_trade_session";

export type AccountSessionPayload = {
  accountId: string;
  brokerId: string;
};

function secretKey() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) throw new Error("ADMIN_SESSION_SECRET is not set");
  return new TextEncoder().encode(secret);
}

function readCookie(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export interface AuthedRequest extends Request {
  session?: AccountSessionPayload;
}

// Requires the request to also carry an X-Broker-Id header the caller
// resolved independently (the Gateway doesn't do subdomain resolution
// itself yet — that's still middleware.ts's job on the Next.js side,
// see docs/api.md §1) — a session minted for one broker is never valid
// against another, same rule as the existing getAccountSession().
export async function requireTraderSession(req: AuthedRequest, res: Response, next: NextFunction) {
  const token = readCookie(req.headers.cookie, SESSION_COOKIE_NAME);
  if (!token) {
    res.status(401).json({ error: "no session" });
    return;
  }

  let payload: AccountSessionPayload;
  try {
    const verified = await jwtVerify(token, secretKey());
    payload = verified.payload as unknown as AccountSessionPayload;
  } catch {
    res.status(401).json({ error: "invalid session" });
    return;
  }

  const requestBrokerId = req.headers["x-broker-id"];
  if (!requestBrokerId || requestBrokerId !== payload.brokerId) {
    res.status(403).json({ error: "broker mismatch" });
    return;
  }

  req.session = payload;
  next();
}
