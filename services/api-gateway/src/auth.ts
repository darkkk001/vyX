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

/** The token of an `Authorization: Bearer <token>` header, or null. Scheme match is case-insensitive
 *  (RFC 7235) and the token is trimmed -- the same parsing lib/app-web.ts does on the web side. */
export function bearerToken(authorization: string | undefined): string | null {
  if (!authorization) return null;
  const m = /^\s*Bearer\s+(.+)$/i.exec(authorization);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * THE SESSION TOKEN OF A REQUEST, from either transport.
 *
 * WHY BOTH. The QoreTrader web app and the mobile build it ships from (app.qoretrader.com) are ONE page
 * origin for every broker, so they can never carry a broker's session cookie: it is httpOnly, SameSite
 * Lax and scoped to that broker's own domain. lib/app-web.ts already solves this on the web side -- login
 * returns the session token in the body for those origins and `getAccountSession` accepts
 * `Authorization: Bearer <token>`. This is the same token and the SAME Redis key
 * (`trader_session:{token}`); nothing new is trusted, and no new way to mint a session is introduced.
 *
 * COOKIE WINS. The web's own rule is "accept Bearer when no cookie came", and keeping that order means
 * every existing cookie-bearing caller resolves byte for byte as before -- a browser that sends both
 * cannot be downgraded onto a header an attacker controls.
 */
export function sessionTokenFrom(headers: {
  cookie?: string | undefined;
  authorization?: string | undefined;
}): string | null {
  // An EMPTY session cookie is no cookie. `readCookie` answers "" for `vyx_trade_session=`, and "" is
  // not nullish -- so `?? bearerToken(...)` resolved the token to "" and the header was never read. A
  // caller holding a stale empty cookie (a browser that cleared the value but kept the name) would have
  // been locked out of the Bearer path entirely. The test below caught this, not the PWA.
  const fromCookie = readCookie(headers.cookie, SESSION_COOKIE_NAME);
  if (fromCookie) return fromCookie;
  return bearerToken(headers.authorization);
}

/** The Redis-backed session for an opaque token. The one lookup every transport funnels into. */
export async function getTraderSessionByToken(token: string): Promise<AccountSessionPayload | null> {
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AccountSessionPayload;
  } catch {
    return null;
  }
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
  return getTraderSessionByToken(token);
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
  // L2 optimization pass: a short in-process cache in front of the SAME lookup. The store is still
  // Upstash (the web mints the session there and this only validates it); see session-cache.ts for
  // exactly what the cache delays -- a revoked token, for up to its TTL -- and what it does not: the
  // account's own ACTIVE/DEMO state, which every order still reads from Postgres.
  const { getTraderSessionCachedByToken } = await import("./session-cache.js");
  // Cookie first, then `Authorization: Bearer` -- see sessionTokenFrom. Keyed by the TOKEN rather than by
  // the raw Cookie header, so one session resolves to one cache entry whichever transport carried it (and
  // an unrelated cookie changing no longer looks like a different session).
  const token = sessionTokenFrom({
    cookie: req.headers.cookie,
    authorization: req.headers.authorization,
  });
  const payload = token ? await getTraderSessionCachedByToken(token) : null;
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
