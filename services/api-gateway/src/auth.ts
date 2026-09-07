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
function wsTicketKey(ticket: string) {
  return `trader_ws_ticket:${ticket}`;
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

// 2026-09-07 -- alternative to the cookie-based lookup above, for a
// browser WS handshake that can't carry this Gateway's session cookie at
// all: a broker's own custom domain (e.g. futurixglobal.com) is an
// unrelated domain to feed.<ROOT_DOMAIN> this Gateway lives on, so a
// cookie scoped to the custom domain (see the Next app's
// cookieScopeDomain) never reaches here. The Next app mints a short-lived
// ticket instead (POST /api/trade/ws-ticket, same-origin on whatever
// domain the page is actually on) and the client passes it as a `ticket`
// query param on the WS URL. Single-use -- deleted on the first (and
// only ever) read, so a ticket that leaked into, say, a proxy access log
// can't be replayed after the legitimate handshake already consumed it;
// it also just expires on its own 30s after being minted if never used.
export async function getTraderSessionByTicket(
  ticket: string
): Promise<AccountSessionPayload | null> {
  const redis = getRedis();
  const key = wsTicketKey(ticket);
  const raw = await redis.get(key);
  if (!raw) return null;
  await redis.del(key);

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
