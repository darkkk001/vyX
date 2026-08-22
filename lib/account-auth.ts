import "server-only";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

export const ACCOUNT_SESSION_COOKIE_NAME = "vyx_trade_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type AccountSessionPayload = {
  accountId: string;
  brokerId: string;
  // Present on every session created after device/session management
  // shipped -- absent on any session still alive from before that (a
  // 7-day TTL means old ones age out on their own; they simply won't
  // appear in the "your active sessions" list or be revocable by id in
  // the meantime, which is fine -- the token itself still authenticates
  // requests normally either way).
  sessionId?: string;
};

export type SessionMetadata = {
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
};

// Redis-backed opaque sessions (docs/authentication.md §2), replacing the
// original self-contained JWT. The cookie now holds a random token that's
// meaningless on its own — the actual session data lives in Redis, keyed
// by that token, so deleting the Redis key revokes the session
// immediately (a JWT stays valid until its own expiry no matter what the
// server does; that's the gap this closes). Redis is never authoritative
// for anything financial — an outage here means sessions can't be
// validated, not that trading data is wrong (docs/security.md §2).
function sessionKey(token: string) {
  return `trader_session:${token}`;
}

// Device/session management (docs/webtrader-stm-architecture-review.md
// §3 item 8) needs to list and individually revoke a trader's *other*
// sessions from the current one -- but the session token itself is the
// literal credential that authenticates every request, so it can never
// be handed back to the browser as a list item's id (that would let any
// one of a trader's own devices silently borrow another device's live
// session by copying the id into its own cookie). `sessionId` is a
// second, purely-cosmetic random identifier: safe to display and safe to
// send back for a revoke request, because on its own it can't
// authenticate anything -- revoking still goes through
// `trader_session_id:{sessionId}` -> token -> the real session key,
// entirely server-side.
function sessionIdKey(sessionId: string) {
  return `trader_session_id:${sessionId}`;
}
function sessionMetaKey(sessionId: string) {
  return `trader_session_meta:${sessionId}`;
}
function sessionIndexKey(accountId: string) {
  return `trader_sessions_index:${accountId}`;
}

export async function createAccountSession(
  payload: Omit<AccountSessionPayload, "sessionId">,
  meta?: { userAgent: string | null; ip: string | null }
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomBytes(16).toString("hex");
  const redis = getRedis();

  await redis.set(
    sessionKey(token),
    JSON.stringify({ ...payload, sessionId } satisfies AccountSessionPayload),
    "EX",
    SESSION_TTL_SECONDS
  );

  // Metadata is best-effort/display-only (see the routes that read it) --
  // if this second write is slow/fails, the session itself (written
  // above) is still valid; the trader just won't see this device listed
  // until their next login.
  if (meta) {
    const metadata: SessionMetadata = { userAgent: meta.userAgent, ip: meta.ip, createdAt: new Date().toISOString() };
    await Promise.all([
      redis.set(sessionIdKey(sessionId), token, "EX", SESSION_TTL_SECONDS),
      redis.set(sessionMetaKey(sessionId), JSON.stringify(metadata), "EX", SESSION_TTL_SECONDS),
      redis.sadd(sessionIndexKey(payload.accountId), sessionId),
    ]);
  }

  return token;
}

export async function verifyAccountSessionToken(
  token: string
): Promise<AccountSessionPayload | null> {
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AccountSessionPayload;
  } catch {
    return null;
  }
}

// Real revocation — deletes the Redis-held session record so the token in
// the (now-cleared) cookie can never be replayed, even if an attacker
// captured it before logout. Doesn't bother cleaning up the
// sessionId/metadata/index entries for this token -- they carry the same
// TTL as the session itself, so they age out together; `listAccountSessions`
// already self-heals past anything that's revoked-but-not-yet-expired
// (see its own comment).
export async function revokeAccountSession(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
}

export type SessionListEntry = SessionMetadata & { sessionId: string; current: boolean };

// Lists this account's active sessions with device metadata, for the
// Security panel. Self-healing against staleness rather than needing a
// cleanup job: a sessionId whose reverse-index or metadata key has
// already expired (the underlying session was revoked, or its TTL simply
// ran out) is dropped from the account's index set on read instead of
// being returned as a dead row.
export async function listAccountSessions(
  accountId: string,
  currentSessionId: string | undefined
): Promise<SessionListEntry[]> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(accountId));
  if (sessionIds.length === 0) return [];

  const entries: SessionListEntry[] = [];
  const stale: string[] = [];

  for (const sessionId of sessionIds) {
    const [token, rawMeta] = await Promise.all([
      redis.get(sessionIdKey(sessionId)),
      redis.get(sessionMetaKey(sessionId)),
    ]);
    if (!token || !rawMeta) {
      stale.push(sessionId);
      continue;
    }
    try {
      const meta = JSON.parse(rawMeta) as SessionMetadata;
      entries.push({ ...meta, sessionId, current: sessionId === currentSessionId });
    } catch {
      stale.push(sessionId);
    }
  }

  if (stale.length > 0) {
    await redis.srem(sessionIndexKey(accountId), ...stale);
  }

  return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Revokes one session by its cosmetic id rather than its real token --
// see sessionIdKey's doc comment. Scoped to `accountId` so one account's
// session list can never be used to guess-and-revoke a different
// account's session even if a sessionId were somehow known.
export async function revokeAccountSessionById(accountId: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  const token = await redis.get(sessionIdKey(sessionId));
  if (!token) return false;

  const raw = await redis.get(sessionKey(token));
  if (raw) {
    try {
      const payload = JSON.parse(raw) as AccountSessionPayload;
      if (payload.accountId !== accountId) return false;
    } catch {
      return false;
    }
  }

  await Promise.all([
    redis.del(sessionKey(token)),
    redis.del(sessionIdKey(sessionId)),
    redis.del(sessionMetaKey(sessionId)),
    redis.srem(sessionIndexKey(accountId), sessionId),
  ]);
  return true;
}

// Server Components / route handlers: read the current trader session, if
// any, and cross-check it against the broker resolved by middleware.ts for
// this request — a session minted under one broker must never be usable
// against another broker's data, even if the token itself is valid.
export async function getAccountSession(): Promise<AccountSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(ACCOUNT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifyAccountSessionToken(token);
  if (!session) return null;

  const headerList = await headers();
  const requestBrokerId = headerList.get("x-broker-id");
  if (!requestBrokerId || requestBrokerId !== session.brokerId) return null;

  return session;
}

// Shared by the JSON login route (WebTrader's own fetch-based login) and
// the form-POST login-redirect route (the root-domain launcher's cross-site
// submit) — same credential check, same constant-shape failure either way.
export async function authenticateAccount(
  brokerId: string,
  accountNumber: string,
  password: string
) {
  if (!accountNumber || !password) return null;

  const account = await prisma.account.findUnique({ where: { accountNumber } });
  if (!account || account.brokerId !== brokerId || account.status !== "ACTIVE") return null;

  const passwordMatches = await bcrypt.compare(password, account.passwordHash);
  if (!passwordMatches) return null;

  return account;
}

// Shared tail of both login paths that can actually complete a session
// (the plain-credentials branch of app/api/trade/login, and
// app/api/trade/login/verify-2fa once a 2FA-gated account's code checks
// out) -- one place for "create the session, and if this account was
// already signed into a *different* account in this browser, audit it as
// a switch" (docs/webtrader-stm-architecture-review.md §4.2's Account
// Selector), so the two entry points can't drift on when that audit
// fires.
export async function completeAccountLogin(
  account: { id: string; brokerId: string },
  previousSession: AccountSessionPayload | null,
  meta: { userAgent: string | null; ip: string | null }
): Promise<string> {
  const token = await createAccountSession({ accountId: account.id, brokerId: account.brokerId }, meta);

  if (previousSession && previousSession.accountId !== account.id) {
    await prisma.auditLog.create({
      data: {
        brokerId: account.brokerId,
        action: "WEBTRADER_ACCOUNT_SWITCH",
        entityType: "Account",
        entityId: account.id,
        oldValue: { accountId: previousSession.accountId },
        newValue: { accountId: account.id },
      },
    });
  }

  return token;
}

export function accountSessionCookieOptions() {
  // Scoped to the whole site (".vyxtrader.com"), not just the issuing
  // subdomain -- the WS Gateway lives on its own subdomain
  // (feed.<ROOT_DOMAIN>, see services/api-gateway/src/ws.ts's
  // getTraderSession(req.headers.cookie) check) and a browser never
  // sends a cookie to a subdomain the cookie wasn't scoped to. Without
  // this, every WS handshake 401s and WebTrader.tsx silently falls back
  // to its 2s HTTP poll forever. No `domain` in local dev (ROOT_DOMAIN
  // unset/localhost) -- there's only one host there, nothing to share
  // the cookie with, and "localhost" isn't a valid cookie domain value.
  const rootDomain = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];
  const domain = rootDomain === "localhost" ? undefined : `.${rootDomain}`;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    domain,
    maxAge: SESSION_TTL_SECONDS,
  };
}
