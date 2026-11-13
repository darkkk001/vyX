import "server-only";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { cookieScopeDomain } from "@/lib/cookie-domain";

// Client Portal session -- a close mirror of lib/account-auth.ts's own
// Redis-backed opaque session, deliberately kept as a SEPARATE cookie and
// a separate Redis keyspace from the trader (Account) session: "who is
// this person" (Client) and "which trading account is this request for"
// (Account) are different questions, and the portal answers the first
// one, then hands off into the second via the existing SSO ticket
// mechanism (lib/sso.ts) when a client picks an account to act on -- see
// the Client Portal design doc's own §4/§7/§8 for why. This file does
// NOT replace or touch account-auth.ts's own session at all.
export const CLIENT_SESSION_COOKIE_NAME = "vyx_client_session";
// Two limits (owner 2026-11-05). Idle: no real activity for the broker's clientIdleMinutes ends the session. Absolute:
// activity or not, a session ends this long after sign-in. "Remember me" only decides whether the cookie outlives the
// browser; it does not lengthen either limit.
export const CLIENT_ABSOLUTE_SECONDS = 60 * 60 * 12;
export const CLIENT_IDLE_DEFAULT_MINUTES = 30;
export const CLIENT_IDLE_MIN_MINUTES = 5;
export const CLIENT_IDLE_MAX_MINUTES = 240;

/** A broker's idle setting as typed: whole minutes in range, else null. */
export function parseIdleMinutes(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= CLIENT_IDLE_MIN_MINUTES && n <= CLIENT_IDLE_MAX_MINUTES ? n : null;
}

export type ClientSessionPayload = {
  clientId: string;
  brokerId: string;
  // Cosmetic per-session id (same reasoning as lib/account-auth.ts's
  // sessionId: the token is the credential and is never listed or handed
  // back). Present on every session minted since revoke-all shipped; a
  // session from before simply isn't in the index and ages out on its TTL.
  sessionId?: string;
  // Set at sign-in; a session from before these limits gets them the first time it is read.
  absoluteExpiresAt?: number; // ms since the epoch
  idleSeconds?: number;
};

function sessionKey(token: string) {
  return `client_session:${token}`;
}
// Exists while the session is not idle: real activity re-arms it, the background reads of an open tab do not.
function sessionIdleKey(token: string) {
  return `client_session_idle:${token}`;
}
function sessionIdKey(sessionId: string) {
  return `client_session_id:${sessionId}`;
}
function sessionIndexKey(clientId: string) {
  return `client_sessions_index:${clientId}`;
}
// Display-only device details of a session (Trader's Room "Active sessions", 2026-11-03), same idea as
// lib/account-auth.ts's session metadata. A session minted without them is listed as an unknown device.
function sessionMetaKey(sessionId: string) {
  return `client_session_meta:${sessionId}`;
}
export type ClientSessionMeta = { userAgent: string | null; ip: string | null; createdAt: string };
function emailVerifyKey(token: string) {
  return `client_email_verify:${token}`;
}
function passwordResetKey(token: string) {
  return `client_password_reset:${token}`;
}

// 24h -- long enough for someone to actually open their inbox, unlike
// lib/sso.ts's 30s handoff tokens (a completely different kind of token,
// meant to be consumed within the same request/redirect cycle).
const EMAIL_VERIFY_TTL_SECONDS = 60 * 60 * 24;
// 1h -- a password-reset link is more sensitive to leave open-ended than
// an email-verify one (whoever holds it can take over the account, not
// just prove they own the inbox), same order-of-magnitude window most
// real password-reset flows use.
const PASSWORD_RESET_TTL_SECONDS = 60 * 60;

export async function issueEmailVerificationToken(clientId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(emailVerifyKey(token), clientId, "EX", EMAIL_VERIFY_TTL_SECONDS);
  return token;
}

// Single-use -- GETDEL, same atomic read-then-delete lib/sso.ts's own
// consumeSsoToken uses, so a replayed/double-clicked verify link can't
// consume the same token twice.
export async function consumeEmailVerificationToken(token: string): Promise<string | null> {
  return getRedis().getdel(emailVerifyKey(token));
}

// ttlSeconds: a CRM invitation (lead converted by staff) lives 72 h; a self-service reset keeps the default
export async function issuePasswordResetToken(clientId: string, ttlSeconds: number = PASSWORD_RESET_TTL_SECONDS): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(passwordResetKey(token), clientId, "EX", ttlSeconds);
  return token;
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  return getRedis().getdel(passwordResetKey(token));
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

async function brokerIdleSeconds(brokerId: string): Promise<number> {
  const b = await prisma.broker.findUnique({ where: { id: brokerId }, select: { clientIdleMinutes: true } });
  return (b?.clientIdleMinutes ?? CLIENT_IDLE_DEFAULT_MINUTES) * 60;
}

export async function createClientSession(
  payload: Omit<ClientSessionPayload, "sessionId">,
  remember: boolean = true,
  meta?: { userAgent: string | null; ip: string | null }
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const sessionId = crypto.randomBytes(16).toString("hex");
  const ttlSeconds = CLIENT_ABSOLUTE_SECONDS;
  const idleSeconds = await brokerIdleSeconds(payload.brokerId);
  const redis = getRedis();
  await redis.set(sessionKey(token), JSON.stringify({ ...payload, sessionId, absoluteExpiresAt: Date.now() + ttlSeconds * 1000, idleSeconds } satisfies ClientSessionPayload), "EX", ttlSeconds);
  // Indexed under the client so revokeAllClientSessions can find it when
  // the credential changes (pentest 2026-09-18 finding #2).
  const metadata: ClientSessionMeta = { userAgent: meta?.userAgent?.slice(0, 300) ?? null, ip: meta?.ip ?? null, createdAt: new Date().toISOString() };
  await Promise.all([
    redis.set(sessionIdleKey(token), "1", "EX", idleSeconds),
    redis.set(sessionIdKey(sessionId), token, "EX", ttlSeconds),
    redis.set(sessionMetaKey(sessionId), JSON.stringify(metadata), "EX", ttlSeconds),
    redis.sadd(sessionIndexKey(payload.clientId), sessionId),
  ]);
  return token;
}

/** The client's live sessions, newest first; stale index entries are dropped on the way. */
export async function listClientSessions(clientId: string, currentSessionId: string | undefined): Promise<(ClientSessionMeta & { sessionId: string; current: boolean })[]> {
  const redis = getRedis();
  const ids = await redis.smembers(sessionIndexKey(clientId));
  const out: (ClientSessionMeta & { sessionId: string; current: boolean })[] = [];
  const stale: string[] = [];
  for (const id of ids) {
    const [token, raw] = await Promise.all([redis.get(sessionIdKey(id)), redis.get(sessionMetaKey(id))]);
    if (!token) { stale.push(id); continue; }
    let meta: ClientSessionMeta = { userAgent: null, ip: null, createdAt: "" };
    try { if (raw) meta = JSON.parse(raw) as ClientSessionMeta; } catch { /* listed as unknown */ }
    out.push({ ...meta, sessionId: id, current: id === currentSessionId });
  }
  if (stale.length) await redis.srem(sessionIndexKey(clientId), ...stale);
  return out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Ends one of the client's own sessions by its display id; false when it is not theirs or already gone. */
export async function revokeClientSessionById(clientId: string, sessionId: string): Promise<boolean> {
  const redis = getRedis();
  if (!(await redis.sismember(sessionIndexKey(clientId), sessionId))) return false;
  const token = await redis.get(sessionIdKey(sessionId));
  await Promise.all([
    token ? redis.del(sessionKey(token), sessionIdleKey(token)) : Promise.resolve(0),
    redis.del(sessionIdKey(sessionId)),
    redis.del(sessionMetaKey(sessionId)),
    redis.srem(sessionIndexKey(clientId), sessionId),
  ]);
  return Boolean(token);
}

export async function verifyClientSessionToken(token: string): Promise<ClientSessionPayload | null> {
  const redis = getRedis();
  const [raw, idle] = await redis.mget(sessionKey(token), sessionIdleKey(token));
  if (!raw) return null;
  let session: ClientSessionPayload;
  try {
    session = JSON.parse(raw) as ClientSessionPayload;
  } catch {
    return null;
  }
  // signed in before these limits: both clocks start now, nobody is thrown out by the release itself
  if (!session.absoluteExpiresAt) {
    session = { ...session, absoluteExpiresAt: Date.now() + CLIENT_ABSOLUTE_SECONDS * 1000, idleSeconds: await brokerIdleSeconds(session.brokerId) };
    await Promise.all([
      redis.set(sessionKey(token), JSON.stringify(session), "EX", CLIENT_ABSOLUTE_SECONDS),
      redis.set(sessionIdleKey(token), "1", "EX", session.idleSeconds!),
    ]);
    return session;
  }
  if (Date.now() >= session.absoluteExpiresAt || !idle) {
    await revokeClientSession(token);
    return null;
  }
  return session;
}

/** Ends a session completely: the credential and its entry in the Active sessions list. */
export async function revokeClientSession(token: string): Promise<void> {
  const redis = getRedis();
  const raw = await redis.get(sessionKey(token));
  await redis.del(sessionKey(token), sessionIdleKey(token));
  let session: ClientSessionPayload | null = null;
  try { session = raw ? (JSON.parse(raw) as ClientSessionPayload) : null; } catch { /* nothing more to clean */ }
  if (!session?.sessionId) return;
  await Promise.all([
    redis.del(sessionIdKey(session.sessionId)),
    redis.del(sessionMetaKey(session.sessionId)),
    redis.srem(sessionIndexKey(session.clientId), session.sessionId),
  ]);
}

// Revokes EVERY session a client has -- called after every passwordHash
// write (self-service change-password keeps the caller's own session via
// `exceptSessionId`; the forgot-password reset revokes all, the client is
// asked to sign in again with the new credential). Mirrors
// lib/account-auth.ts's revokeAllAccountSessions.
export async function revokeAllClientSessions(clientId: string, exceptSessionId?: string): Promise<number> {
  const redis = getRedis();
  const sessionIds = await redis.smembers(sessionIndexKey(clientId));
  let revoked = 0;
  for (const sessionId of sessionIds) {
    if (exceptSessionId && sessionId === exceptSessionId) continue;
    const token = await redis.get(sessionIdKey(sessionId));
    await Promise.all([
      token ? redis.del(sessionKey(token), sessionIdleKey(token)) : Promise.resolve(0),
      redis.del(sessionIdKey(sessionId)),
      redis.del(sessionMetaKey(sessionId)),
      redis.srem(sessionIndexKey(clientId), sessionId),
    ]);
    if (token) revoked++;
  }
  return revoked;
}

// Server Components / route handlers: read the current client session, if
// any, cross-checked against the broker resolved by middleware.ts for
// this request -- same rule getAccountSession() already applies, a
// session minted under one broker is never valid against another's.
// A read counts as activity unless the caller says it is a background read: the Trader's Room API is read every second
// by an open tab, so roomApiSession passes activity: false and the room reports real input itself (/api/room/activity).
export async function getClientSession(opts: { activity?: boolean } = {}): Promise<ClientSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CLIENT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifyClientSessionToken(token);
  if (!session) return null;

  const headerList = await headers();
  const requestBrokerId = headerList.get("x-broker-id");
  if (!requestBrokerId || requestBrokerId !== session.brokerId) return null;

  // a client who is no longer ACTIVE (suspended / closed) loses every live session within a minute (owner 2026-11-13).
  // The status is cached in Redis for 60 s: the room reads this API every second per open tab, so no DB read each time.
  if (!(await clientIsActive(session.clientId))) return null;

  if (opts.activity !== false && session.idleSeconds) await getRedis().set(sessionIdleKey(token), "1", "EX", session.idleSeconds);
  return session;
}

// Compared against when there is no usable client, so an unknown address costs the same time as a wrong password.
let decoyHash: Promise<string> | null = null;

// Constant-shape failure regardless of which check fails (no account,
// wrong broker, unverified email, wrong password) -- same reasoning as
// authenticateAccount's own comment: never let a login form distinguish
// "wrong email" from "wrong password" from "not verified yet" through
// timing or a different error class this function itself returns (the
// route handler decides what to tell the client; this just proves or
// disproves the credential).
export async function authenticateClient(brokerId: string, email: string, password: string) {
  if (!email || !password) return null;

  const client = await prisma.client.findUnique({ where: { brokerId_email: { brokerId, email } } });
  if (!client || client.status !== "ACTIVE") {
    await bcrypt.compare(password, await (decoyHash ??= bcrypt.hash(crypto.randomBytes(16).toString("hex"), 10)));
    return null;
  }

  const passwordMatches = await bcrypt.compare(password, client.passwordHash);
  if (!passwordMatches) return null;

  return client;
}

// Host-aware cookie domain, reusing the exact fix that closed the
// custom-domain login outage for the trader session (lib/cookie-domain.ts)
// -- the portal is a new caller of already-proven infrastructure, not a
// new place for that bug to reappear.
export async function clientSessionCookieOptions(remember: boolean = true) {
  const domain = await cookieScopeDomain();
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    domain,
    ...(remember ? { maxAge: CLIENT_ABSOLUTE_SECONDS } : {}),
  };
}

const CLIENT_STATUS_CACHE_SECONDS = 60;
/** Client.status === "ACTIVE", cached per client for a minute in Redis (see getClientSession). */
export async function clientIsActive(clientId: string): Promise<boolean> {
  const key = `client_status:${clientId}`;
  const redis = getRedis();
  const cached = await redis.get(key);
  if (cached) return cached === "ACTIVE";
  const c = await prisma.client.findUnique({ where: { id: clientId }, select: { status: true } });
  const status = c?.status ?? "MISSING";
  await redis.set(key, status, "EX", CLIENT_STATUS_CACHE_SECONDS);
  return status === "ACTIVE";
}
