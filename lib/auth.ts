import "server-only";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import type { AdminRole } from "@prisma/client";
import { getRedis } from "@/lib/redis";

export const SESSION_COOKIE_NAME = "vyx_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days -- Redis TTL backstop, both remembered and not (see lib/account-auth.ts's identical comment on why this differs from the cookie's own maxAge)
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days -- "Keep me signed in" on /manage/login

export type AdminSessionPayload = {
  adminId: string;
  role: AdminRole;
  brokerId: string | null;
  // Present on every session created after this Phase 1 trust pack --
  // absent only on a session somehow still alive from before it, which
  // can't actually happen (this replaced JWTs outright, not alongside
  // them, so there's no old-format session left to decode once this
  // ships -- unlike lib/account-auth.ts's own sessionId, which stayed
  // optional because that migration was additive to an already-opaque
  // token).
  sessionId?: string;
};

export type AdminSessionMetadata = {
  userAgent: string | null;
  ip: string | null;
  createdAt: string;
};

// Phase 1 trust pack §2 -- Redis-backed opaque admin sessions, replacing
// the original self-contained JWT (docs/authentication.md §2 already did
// this for traders; this is the same rewrite applied to AdminUser). The
// cookie now holds a random token that's meaningless on its own -- the
// actual session data lives in Redis, keyed by that token, so deleting
// the Redis key revokes the session immediately (a JWT stayed valid
// until its own expiry no matter what the server did -- disabling an
// admin, or "sign out everywhere," were both purely cosmetic before
// this: the existing token kept authenticating every request against
// this app AND services/api-gateway's admin event stream until it
// naturally expired). Redis is never authoritative for anything
// financial -- an outage here means admin sessions can't be validated,
// not that trading/ledger data is wrong (docs/security.md §2), same rule
// lib/account-auth.ts already documents for trader sessions.
function sessionKey(token: string) {
  return `admin_session:${token}`;
}

// Same cosmetic-id-vs-real-token split as lib/account-auth.ts's own
// sessionIdKey -- see that function's doc comment for the full reasoning
// (the token itself is the literal credential, so it can never be handed
// back to the browser as a list item's id).
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
  remember = false,
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

  // Metadata is best-effort/display-only, same convention as
  // lib/account-auth.ts's createAccountSession -- every real call site in
  // this app now passes it (unlike the trader path, where it's still
  // genuinely optional), since revokeAllAdminSessions below can only find
  // what's indexed here.
  if (meta) {
    const metadata: AdminSessionMetadata = { userAgent: meta.userAgent, ip: meta.ip, createdAt: new Date().toISOString() };
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
// in the (now-cleared) cookie can never be replayed. Doesn't bother
// cleaning up the sessionId/metadata/index entries for this token --
// same reasoning as lib/account-auth.ts's revokeAccountSession (they
// share the session's own TTL and age out together; listAdminSessions
// already self-heals past anything revoked-but-not-yet-expired).
export async function revokeAdminSession(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
}

export type AdminSessionListEntry = AdminSessionMetadata & { sessionId: string; current: boolean };

// Lists this admin's active sessions with device metadata, for the
// Security panel's "sign out everywhere" / per-session revoke. Same
// self-healing shape as lib/account-auth.ts's listAccountSessions.
export async function listAdminSessions(
  adminId: string,
  currentSessionId: string | undefined
): Promise<AdminSessionListEntry[]> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(adminId));
  if (sessionIds.length === 0) return [];

  const entries: AdminSessionListEntry[] = [];
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
      const meta = JSON.parse(rawMeta) as AdminSessionMetadata;
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

// Revokes one session by its cosmetic id -- scoped to `adminId` so one
// admin's session list can never be used to guess-and-revoke a different
// admin's session even if a sessionId were somehow known. Same shape as
// lib/account-auth.ts's revokeAccountSessionById.
export async function revokeAdminSessionById(adminId: string, sessionId: string): Promise<boolean> {
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

// Every session this admin has, gone at once -- the actual enforcement
// half of "disabling/demoting an AdminUser revokes all their sessions
// immediately" (app/api/manage/admins/[id]/route.ts and its Super Admin
// twin call this on any status/role change away from active-and-eligible,
// not just on disable). Walks the same index listAdminSessions/
// revokeAdminSessionById use rather than duplicating their per-session
// cleanup, and clears the index set itself at the end so a stale index
// can't linger past every session it pointed to already being gone.
export async function revokeAllAdminSessions(adminId: string): Promise<number> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(adminId));
  if (sessionIds.length === 0) return 0;

  let revoked = 0;
  for (const sessionId of sessionIds) {
    const token = await redis.get(sessionIdKey(sessionId));
    if (token) {
      await redis.del(sessionKey(token));
      revoked++;
    }
    await Promise.all([redis.del(sessionIdKey(sessionId)), redis.del(sessionMetaKey(sessionId))]);
  }
  await redis.del(sessionIndexKey(adminId));
  return revoked;
}

// Server Components / route handlers: read the current admin session, if
// any. For a broker-scoped admin (brokerId set -- BROKER_ADMIN/SUPPORT/
// MANAGER), cross-checks it against the broker middleware.ts resolved for
// this request, same rule lib/account-auth.ts's getAccountSession()
// already applies to trader sessions: a session minted under one broker
// must never be usable against another broker's data, even with a valid
// token. Super Admin (brokerId: null) skips this -- it's not broker-scoped
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

// Reads the raw token straight off the cookie, for the one caller that
// needs it directly (POST /api/manage/logout and its Super Admin twin,
// to revoke the Redis-held session on logout instead of just clearing
// the cookie -- clearing the cookie alone left the session valid and
// replayable from a copied token, same gap lib/account-auth.ts's own
// logout route already closed for traders).
export async function getCurrentAdminSessionToken(): Promise<string | null> {
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

export function sessionCookieOptions(remember = false) {
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
