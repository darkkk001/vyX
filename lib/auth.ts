import "server-only";
import { checkClientBuild } from "@/lib/client-builds";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import type { AdminRole } from "@prisma/client";
import { getRedis } from "@/lib/redis";
import { prisma } from "@/lib/prisma";
import { cookieScopeDomain } from "@/lib/cookie-domain";
import { clientIpFromHeaders, ipAllowed, passwordExpired } from "@/lib/ip-allowlist";

export const SESSION_COOKIE_NAME = "vyx_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days -- Redis TTL backstop, same as lib/account-auth.ts's own
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days -- manage/login's "remember" checkbox

// A SUPER_ADMIN that hasn't enrolled 2FA yet (2026-09-15 audit, item 3a) is
// confined to exactly the endpoints needed to enroll (and to log out) on the
// API side; every other /api/admin/* call is treated as unauthenticated until
// it enrols. Page navigation is steered to /security by the super-admin shell
// layout instead, so this only needs the API surface.
const SUPER_ADMIN_ENROLLMENT_API_ALLOWLIST = new Set([
  "/api/admin/two-factor/setup",
  "/api/admin/two-factor/confirm",
  "/api/admin/two-factor/status",
  "/api/admin/two-factor/disable",
  "/api/admin/shell-info",
  "/api/admin/sessions",
  "/api/admin/theme",
  "/api/admin/logout",
]);

// Phase 2 batch 4 (owner decision 2026-09-26): 2FA is MANDATORY for every
// backoffice staff member (BROKER_ADMIN / MANAGER / SUPPORT) at every broker,
// regardless of Broker.requireAdmin2fa. A staff member without 2FA who signs in
// gets an ENROLMENT-ONLY session: it may call exactly these API paths (enrol,
// read its own 2FA status / sessions, sign out, the minimal shell-info the
// native backoffice needs to show the enrolment step). Every other /api/* call
// is answered 403 { error, code: "TWO_FACTOR_SETUP_REQUIRED" } -- enforced here,
// in getAdminSession, so no route can forget it. Confirming enrolment flips
// AdminUser.twoFactorEnabled, which getAdminSession re-reads on every request,
// so the same session becomes full on the very next call.
export const TWO_FACTOR_SETUP_REQUIRED = "TWO_FACTOR_SETUP_REQUIRED";
export const TWO_FACTOR_SETUP_REQUIRED_PATH = "/api/manage/two-factor-required";
export const STAFF_ENROLLMENT_API_ALLOWLIST: ReadonlySet<string> = new Set([
  "/api/admin/two-factor/setup",
  "/api/admin/two-factor/confirm",
  "/api/admin/two-factor/status",
  "/api/admin/sessions",
  "/api/admin/logout",
  "/api/manage/shell-info",
]);

export const PASSWORD_CHANGE_REQUIRED = "PASSWORD_CHANGE_REQUIRED";
export const PASSWORD_CHANGE_REQUIRED_PATH = "/api/manage/password-change-required";
export const PASSWORD_CHANGE_API_ALLOWLIST: ReadonlySet<string> = new Set([
  "/api/admin/change-password",
  "/api/admin/logout",
  "/api/admin/sessions",
  "/api/admin/theme",
  "/api/manage/shell-info",
]);

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
  // Sign-in time (ms since epoch). Step 3b item 2a (owner 2026-10-07): the broker's session timeout ends a staff session
  // that many minutes after SIGN-IN, not after the last click (the backoffice polls, so "idle" would never be reached).
  // Absent on a session minted before this field: no timeout is applied to it until its next sign-in.
  iat?: number;
  // Set (never stored) by getAdminSession for a broker staff session whose
  // admin has not enrolled 2FA yet -- the session reached an allowlisted
  // enrolment path (see STAFF_ENROLLMENT_API_ALLOWLIST) or a web page (the
  // manage shell layout steers those to /manage/security).
  twoFactorSetupRequired?: boolean;
  // Set (never stored) by getAdminSession when the broker's password change interval has run out for this person (step 3b item 3):
  // the session may only change the password, read its shell-info and sign out.
  passwordChangeRequired?: boolean;
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
    JSON.stringify({ ...payload, sessionId, iat: Date.now() } satisfies AdminSessionPayload),
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
  const redis = getRedis();
  const raw = await redis.get(sessionKey(token));
  await redis.del(sessionKey(token));
  // Also drop the device-list entry (Phase 2 batch 4, audit line 457): a
  // signed-out session must not linger in "your sessions" until its index
  // entry happens to be swept.
  if (!raw) return;
  try {
    const payload = JSON.parse(raw) as AdminSessionPayload;
    if (payload.sessionId) {
      await Promise.all([
        redis.del(sessionIdKey(payload.sessionId)),
        redis.del(sessionMetaKey(payload.sessionId)),
        redis.srem(sessionIndexKey(payload.adminId), payload.sessionId),
      ]);
    }
  } catch {
    /* the session itself is gone; the index self-heals on the next read */
  }
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

// Revokes EVERY session an admin has (2026-09-15 audit, item 3b): called when
// an admin is disabled so their Redis tokens die at that moment instead of
// staying valid for their 7/30-day TTL, and best-effort from getAdminSession
// when it notices a now-disabled account. Walks the same index listAdminSessions
// reads; sessions minted without metadata aren't indexed, same as that reader.
export async function revokeAllAdminSessions(adminId: string): Promise<number> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(adminId));
  let revoked = 0;
  for (const sessionId of sessionIds) {
    const token = await redis.get(sessionIdKey(sessionId));
    await Promise.all([
      token ? redis.del(sessionKey(token)) : Promise.resolve(0),
      redis.del(sessionIdKey(sessionId)),
      redis.del(sessionMetaKey(sessionId)),
    ]);
    if (token) revoked++;
  }
  await redis.del(sessionIndexKey(adminId));
  return revoked;
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
/** True when a session whose last activity was at `lastActivity` has been idle past the broker's timeout (null timeout or unknown time: never). */
export function sessionExpired(lastActivity: number | undefined, timeoutMinutes: number | null, now: number): boolean {
  if (timeoutMinutes === null || timeoutMinutes <= 0 || typeof lastActivity !== "number") return false;
  return now - lastActivity > timeoutMinutes * 60_000;
}

// Idle session timeout (step 3b, owner 2026-10-07): the clock is time since the last ACTIVE request, not since sign-in.
// Last activity lives in its own Redis key (the session record itself is never rewritten), with a TTL of the timeout plus
// a minute so it cleans itself up; a write happens at most once per ACTIVITY_WRITE_EVERY_MS, so a busy session costs one
// GET per request and about one SET a minute, and the database is never touched. Requests the backoffice marks
// X-Vyx-Background (live refreshes and safety reads fired while nobody is at the keyboard) and the event stream do not
// count as activity: they are checked against the limit but never extend it.
export const BACKGROUND_REQUEST_HEADER = "x-vyx-background";
const ACTIVITY_WRITE_EVERY_MS = 15_000;
function sessionActivityKey(sessionId: string) {
  return `admin_session_activity:${sessionId}`;
}
/** Reads the last-activity time (falls back to sign-in), refuses an idle session, otherwise extends it. Returns true when the session is still valid. */
export async function checkIdleSession(
  session: { sessionId?: string; iat?: number },
  timeoutMinutes: number | null,
  background: boolean,
  now: number = Date.now(),
): Promise<boolean> {
  if (timeoutMinutes === null || timeoutMinutes <= 0 || !session.sessionId) return true; // no timeout set: today's behaviour
  const redis = getRedis();
  const key = sessionActivityKey(session.sessionId);
  const stored = Number(await redis.get(key));
  const last = Number.isFinite(stored) && stored > 0 ? stored : session.iat;
  if (sessionExpired(last, timeoutMinutes, now)) return false;
  if (!background && (typeof last !== "number" || now - last >= ACTIVITY_WRITE_EVERY_MS)) {
    await redis.set(key, String(now), "EX", timeoutMinutes * 60 + 60).catch(() => {});
  }
  return true;
}

export async function getAdminSession(): Promise<AdminSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE_NAME)?.value;
  if (!token) return null; // no cookie at all -- a real "not logged in", nothing to log

  const session = await verifySessionToken(token);
  if (!session) {
    // Cookie present but Redis has nothing for it (expired/logged-out-
    // elsewhere/wrong environment's session store) -- every caller today
    // treats this identically to "not logged in" (null), which is
    // correct; logged because a client reporting "403 forbidden" when
    // this is what actually happened is exactly the 401-vs-403
    // conflation this diagnostic exists to catch.
    console.error("[auth] getAdminSession: session token not found in Redis", {
      pathname: (await headers()).get("x-pathname"),
    });
    return null;
  }

  // native-client build binding (lib/client-builds.ts): a revoked / foreign / unregistered build gets no session
  {
    const h = await headers();
    const verdict = await checkClientBuild(session.brokerId, h.get("x-broker-slug"));
    if (!verdict.ok) { console.error("[auth] getAdminSession: client build rejected", verdict); return null; }
  }
  if (session.brokerId !== null) {
    const headerList = await headers();
    const requestBrokerId = headerList.get("x-broker-id");
    if (!requestBrokerId || requestBrokerId !== session.brokerId) {
      // Valid session, WRONG TENANT for this request -- the case that
      // most easily gets misread as a permission problem ("I'm a Broker
      // Admin, why am I forbidden?") when it's actually an auth/routing
      // mismatch: this admin's session was minted under one brokerId,
      // but middleware.ts resolved a different (or no) x-broker-id for
      // the host this particular request actually hit. Logged with both
      // ids specifically so that distinction is visible without needing
      // to reproduce with a debugger attached.
      console.error("[auth] getAdminSession: x-broker-id mismatch, rejecting session", {
        pathname: headerList.get("x-pathname"),
        sessionBrokerId: session.brokerId,
        requestBrokerId: requestBrokerId ?? null,
        adminId: session.adminId,
      });
      return null;
    }
  }

  // Live account state, re-read every request (2026-09-15 audit, item 3b): a
  // disabled admin -- or one whose role was changed underneath its session --
  // is cut off on the very next request, instead of the Redis token staying
  // usable for its 7/30-day TTL. One indexed primary-key read; admin/backoffice
  // traffic is low enough for this to be cheap.
  const liveAdmin = await prisma.adminUser.findUnique({
    where: { id: session.adminId },
    select: { status: true, role: true, twoFactorEnabled: true, passwordChangedAt: true, createdAt: true, broker: { select: { sessionTimeoutMinutes: true, staffIpAllowlist: true, passwordMaxAgeDays: true } } },
  });
  if (!liveAdmin || liveAdmin.status !== "ACTIVE" || liveAdmin.role !== session.role) {
    if (liveAdmin && liveAdmin.status !== "ACTIVE") {
      // best-effort: clear the now-dead sessions so they stop lingering
      await revokeAllAdminSessions(session.adminId).catch(() => {});
    }
    return null;
  }

  // Session timeout (step 3b item 2a): idle time, broker staff only, applied on every request so a lowered limit bites at once.
  if (!(await checkIdleSession(session, liveAdmin.broker?.sessionTimeoutMinutes ?? null, (await headers()).get(BACKGROUND_REQUEST_HEADER) === "1"))) {
    await revokeSessionToken(token).catch(() => {});
    return null;
  }

  // Staff IP allowlist (step 3b item 3): broker staff only, checked on every request (the address is the first hop of x-forwarded-for).
  if (liveAdmin.broker && liveAdmin.broker.staffIpAllowlist.length > 0 && !ipAllowed(clientIpFromHeaders(await headers()), liveAdmin.broker.staffIpAllowlist)) {
    console.error("[auth] getAdminSession: address not on the staff allowlist", { adminId: session.adminId });
    return null;
  }

  // SUPER_ADMIN must have 2FA enrolled (item 3a). Until it does, a password-only
  // session may hit only the enrollment endpoints (and its own logout) on the
  // API side -- everything else reads as unauthenticated; the shell layout steers
  // page navigation to /security.
  if (liveAdmin.role === "SUPER_ADMIN" && !liveAdmin.twoFactorEnabled) {
    const path = (await headers()).get("x-pathname") ?? "";
    if (path.startsWith("/api/") && !SUPER_ADMIN_ENROLLMENT_API_ALLOWLIST.has(path)) {
      return null;
    }
  }

  // Broker staff must have 2FA enrolled too (Phase 2 batch 4, mandatory for
  // every staff member at every broker -- Broker.requireAdmin2fa no longer
  // matters). An enrolment-only session reaching any other API path is sent to
  // TWO_FACTOR_SETUP_REQUIRED_PATH, which answers 403 { error, code } -- a
  // redirect (thrown, so the calling route never continues) is the one way a
  // shared helper can dictate the response body of every route that calls it.
  // No x-pathname at all (a request that skipped middleware.ts) fails closed.
  if (liveAdmin.role !== "SUPER_ADMIN" && !liveAdmin.twoFactorEnabled) {
    const path = (await headers()).get("x-pathname") ?? "";
    if (path.length === 0) return null;
    if (path.startsWith("/api/") && !STAFF_ENROLLMENT_API_ALLOWLIST.has(path)) {
      redirect(TWO_FACTOR_SETUP_REQUIRED_PATH);
    }
    return { ...session, twoFactorSetupRequired: true };
  }

  // Password change interval (step 3b item 3): an expired password confines the session to changing it.
  if (liveAdmin.broker && passwordExpired(liveAdmin.passwordChangedAt, liveAdmin.createdAt, liveAdmin.broker.passwordMaxAgeDays, new Date())) {
    const path = (await headers()).get("x-pathname") ?? "";
    if (path.startsWith("/api/") && !PASSWORD_CHANGE_API_ALLOWLIST.has(path)) redirect(PASSWORD_CHANGE_REQUIRED_PATH);
    return { ...session, passwordChangeRequired: true };
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

// Phase 1 trust pack -- the web manage shell's forced-2FA-setup rule, kept as
// a pure function so it's testable without a Server Component. Phase 2 batch 4
// (owner decision): 2FA is mandatory for every backoffice staff member, so the
// broker's requireAdmin2fa flag no longer decides anything -- an admin without
// 2FA is always sent to enrol. A failed admin lookup never forces anything
// (the session check itself already failed closed in that case).
export function shouldForceAdminTwoFactorSetup(admin: { twoFactorEnabled: boolean } | null): boolean {
  if (!admin) return false;
  return !admin.twoFactorEnabled;
}

export async function sessionCookieOptions(remember: boolean = false) {
  // Same site-wide cookie scoping as lib/account-auth.ts's
  // accountSessionCookieOptions -- see that function's comment. The
  // Manager backoffice's own real-time stream (Phase 2 of the
  // real-time-sync work) needs this admin session cookie to reach
  // feed.<ROOT_DOMAIN> the same way the trader session already does.
  //
  // Host-aware since the 2026-09-07 outage fix (same cause as
  // account-auth.ts's cookie, just never hit yet for an admin session --
  // an admin logging into /manage/login on a broker's own custom domain
  // would have silently dropped this cookie the exact same way). See
  // cookieScopeDomain's own comment.
  const domain = await cookieScopeDomain();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    domain,
    maxAge: remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS,
  };
}
