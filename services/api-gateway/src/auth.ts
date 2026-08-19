// Verifies the same Redis-backed opaque session lib/account-auth.ts now
// issues (docs/authentication.md §2) — same cookie name, same Redis key
// convention (`trader_session:{token}`), same JSON payload shape. This
// replaced JWT verification: a JWT stays valid until its own expiry no
// matter what the server does, which meant "logout" here was only ever
// cosmetic. Reading the session from Redis means logout (or an admin
// force-revoking a session) takes effect immediately, everywhere that
// checks it — including this Gateway.

import type { NextFunction, Request, Response } from "express";
import { Redis } from "ioredis";

const SESSION_COOKIE_NAME = "vyx_trade_session";

export type AccountSessionPayload = {
  accountId: string;
  brokerId: string;
};

let redis: Redis | null = null;
export function getRedis(): Redis {
  if (!redis) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    redis = new Redis(url);
  }
  return redis;
}

function sessionKey(token: string) {
  return `trader_session:${token}`;
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

// Looks up the Redis-backed session from a raw Cookie header — shared by
// requireTraderSession (REST) and src/ws.ts (the price-stream WebSocket
// upgrade, which has no Express request/response to hang a middleware
// off of, just the raw HTTP upgrade request's headers).
export async function getTraderSession(
  cookieHeader: string | undefined
): Promise<AccountSessionPayload | null> {
  const token = readCookie(cookieHeader, SESSION_COOKIE_NAME);
  if (!token) return null;

  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;

  try {
    return JSON.parse(raw) as AccountSessionPayload;
  } catch {
    return null;
  }
}

// Requires the request to also carry an X-Broker-Id header the caller
// resolved independently (the Gateway doesn't do subdomain resolution
// itself yet — that's still middleware.ts's job on the Next.js side,
// see docs/api.md §1) — a session minted for one broker is never valid
// against another, same rule as the existing getAccountSession().
export async function requireTraderSession(req: AuthedRequest, res: Response, next: NextFunction) {
  const payload = await getTraderSession(req.headers.cookie);
  if (!payload) {
    res.status(401).json({ error: "no session" });
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
