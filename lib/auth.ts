import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import type { AdminRole } from "@prisma/client";
import { getRedis } from "@/lib/redis";

export const SESSION_COOKIE_NAME = "vyx_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days -- Redis TTL backstop, same as lib/account-auth.ts's own
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days -- manage/login's "remember" checkbox

export type AdminSessionPayload = {
  adminId: string;
  role: AdminRole;
  brokerId: string | null;
  // Present on every session created after this Redis migration -- absent
  // on any session still alive from the old JWT system (none will be:
  // switching the cookie's own meaning invalidates every pre-existing
  // token outright, same one-time effect as the trader session's own
  // migration had). See lib/account-auth.ts's identical field for the
  // full reasoning -- this mirrors it exactly.
  sessionId?: string;
};

export type SessionMetadata = {
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
};

// Redis-backed opaque sessions (docs/authentication.md §2), replacing the
// original self-contained JWT -- the exact same migration
// lib/account-auth.ts already made for trader sessions, applied here so
// admin sessions get the same real revocation: deleting the Redis key
// invalidates the cookie's token immediately, rather than it staying
// valid until its own signature-checked expiry no matter what the server
// does (which is what made "log out" and "revoke a device" both purely
// cosmetic before this). Redis is never authoritative for anything
// financial (docs/security.md §2) -- an outage here means admin sessions
// can't be validated, not that broker/trading data is wrong.
function sessionKey(token: string) {
  return `admin_session:${token}`;
}
function sessionIdKey(sessionId: string) {
  return `admin_session_id:${sessionId}`;
}
function sessionMetaKey(sessionId: string) {
  return `admin_session_meta:${sessionId}`;
}
function sessionIndexKey(adminId: string) {
  return `admin_sessions_index:${adminId}`;
}

export async function createSessionToken(
  payload: Omit<AdminSessionPayload, "sessionId">,
  remember: boolean = false,
  meta?: { userAgent: string | null; ip: string | null }
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomBytes(16).toString("hex");
  const redis = getRedis();
  const ttlSeconds = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;

  await redis.set(
    sessionKey(token),
    JSON.stringify({ ...payload, sessionId } satisfies AdminSessionPayload),
    "EX",
    ttlSeconds
  );

  // Metadata is best-effort/display-only, same as lib/account-auth.ts's
  // identical block -- if this second write is slow/fails, the session
  // itself (written above) is still valid; the admin just won't see this
  // device listed until their next login.
  if (meta) {
    const metadata: SessionMetadata = { userAgent: meta.userAgent, ip: meta.ip, createdAt: new Date().toISOString() };
    await Promise.all([
      redis.set(sessionIdKey(sessionId), token, "EX", ttlSeconds),
      redis.set(sessionMetaKey(sessionId), JSON.stringify(metadata), "EX", ttlSeconds),
      redis.sadd(sessionIndexKey(payload.adminId), sessionId),
    ]);
  }

  return token;
}

export async function verifySessionToken(token: string): Promise<AdminSessionPayload | null> {
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as AdminSessionPayload;
  } catch {
    return null;
  }
}

// Real revocation -- deletes the Redis-held session record so the token
// in the (now-cleared) cookie can never be replayed, even if an attacker
// captured it before logout. See app/api/admin/logout/route.ts, the only
// caller: this is what makes "log out" real instead of client-side-only.
export async function revokeSessionToken(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
}

export type SessionListEntry = SessionMetadata & { sessionId: string; current: boolean };

// Lists this admin's active sessions with device metadata, for the
// Security panel -- identical self-healing-against-staleness behavior as
// lib/account-auth.ts's listAccountSessions (see that function's own
// comment): a sessionId whose reverse-index or metadata key has already
// expired gets dropped from the index on read rather than returned as a
// dead row.
export async function listAdminSessions(adminId: string, currentSessionId: string | undefined): Promise<SessionListEntry[]> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(adminId));
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
    await redis.srem(sessionIndexKey(adminId), ...stale);
  }

  return entries.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Revokes one session by its cosmetic id rather than its real token (same
// reasoning as lib/account-auth.ts's revokeAccountSessionById: the token
// itself is the literal credential, so it can never be handed back to the
// browser as a list item's id). Scoped to `adminId` so one admin's
// session list can never be used to guess-and-revoke a different admin's
// session even if a sessionId were somehow known.
export async function revokeSessionById(adminId: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  const token = await redis.get(sessionIdKey(sessionId));
  if (!token) return false;

  const raw = await redis.get(sessionKey(token));
  if (raw) {
    try {
      const payload = JSON.parse(raw) as AdminSessionPayload;
      if (payload.adminId !== adminId) return false;
    } catch {
      return false;
    }
  }

  await Promise.all([
    redis.del(sessionKey(token)),
    redis.del(sessionIdKey(sessionId)),
    redis.del(sessionMetaKey(sessionId)),
    redis.srem(sessionIndexKey(adminId), sessionId),
  ]);
  return true;
}

// Server Components / route handlers: read the current admin session, if
// any. For a broker-scoped admin (brokerId set — BROKER_ADMIN/SUPPORT/
// MANAGER), cross-checks it against the broker middleware.ts resolved for
// this request, same rule lib/account-auth.ts's getAccountSession()
// already applies to trader sessions: a session minted under one broker
// must never be usable against another broker's data, even with a valid
// token. Super Admin (brokerId: null) skips this — it's not broker-scoped
// and today never runs where x-broker-id is even set (admin.<ROOT_DOMAIN>
// short-circuits before middleware.ts's broker resolution).
export async function getAdminSession(): Promise<AdminSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifySessionToken(token);
  if (!session) return null;

  if (session.brokerId !== null) {
    const headerList = await headers();
    const requestBrokerId = headerList.get("x-broker-id");
    if (!requestBrokerId || requestBrokerId !== session.brokerId) return null;
  }

  return session;
}

// Returns the raw session token from the current request's cookie jar --
// needed by app/api/admin/logout (to know which Redis key to delete) and
// nowhere else; every other caller wants the decoded payload from
// getAdminSession() above instead.
export async function getAdminSessionToken(): Promise<string | null> {
  const cookieStore = await cookies();
  return cookieStore.get(SESSION_COOKIE_NAME)?.value ?? null;
}

// No shared role-check helper existed before this — every admin route
// hand-rolled its own `session.role !== "X"` check (see
// app/api/admin/brokers/route.ts's requireSuperAdmin). Added here for
// the new Manager surface since it needs the same check in multiple
// places (page guard + two API routes); existing Super Admin call sites
// are left as-is rather than migrated, to keep this change minimal.
export function requireAdminRole(session: AdminSessionPayload | null, roles: AdminRole[]): boolean {
  return session !== null && roles.includes(session.role);
}

// Phase 1 trust pack -- Broker.requireAdmin2fa's enforcement, extracted
// out of app/manage/(shell)/layout.tsx as a pure function so it's
// testable without a Server Component/session/DB round trip. A null
// broker or admin (a lookup that failed, or a brokerless Super Admin --
// this policy is meaningless there, see Broker.requireAdmin2fa's own
// schema comment) never forces anything.
export function shouldForceAdminTwoFactorSetup(
  broker: { requireAdmin2fa: boolean } | null,
  admin: { twoFactorEnabled: boolean } | null
): boolean {
  if (!broker || !admin) return false;
  return broker.requireAdmin2fa && !admin.twoFactorEnabled;
}

export function sessionCookieOptions(remember: boolean = false) {
  // Same site-wide cookie scoping as lib/account-auth.ts's
  // accountSessionCookieOptions -- see that function's comment. The
  // Manager backoffice's own real-time stream (Phase 2 of the
  // real-time-sync work) needs this admin session cookie to reach
  // feed.<ROOT_DOMAIN> the same way the trader session already does.
  const rootDomain = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];
  const domain = rootDomain === "localhost" ? undefined : `.${rootDomain}`;
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    domain,
    maxAge: remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS,
  };
}
