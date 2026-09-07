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
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days, same convention as account-auth.ts
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

export type ClientSessionPayload = {
  clientId: string;
  brokerId: string;
};

function sessionKey(token: string) {
  return `client_session:${token}`;
}
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

export async function issuePasswordResetToken(clientId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(passwordResetKey(token), clientId, "EX", PASSWORD_RESET_TTL_SECONDS);
  return token;
}

export async function consumePasswordResetToken(token: string): Promise<string | null> {
  return getRedis().getdel(passwordResetKey(token));
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 10);
}

export async function createClientSession(
  payload: ClientSessionPayload,
  remember: boolean = true
): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  const ttlSeconds = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
  await getRedis().set(sessionKey(token), JSON.stringify(payload), "EX", ttlSeconds);
  return token;
}

export async function verifyClientSessionToken(token: string): Promise<ClientSessionPayload | null> {
  const raw = await getRedis().get(sessionKey(token));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as ClientSessionPayload;
  } catch {
    return null;
  }
}

export async function revokeClientSession(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
}

// Server Components / route handlers: read the current client session, if
// any, cross-checked against the broker resolved by middleware.ts for
// this request -- same rule getAccountSession() already applies, a
// session minted under one broker is never valid against another's.
export async function getClientSession(): Promise<ClientSessionPayload | null> {
  const cookieStore = await cookies();
  const token = cookieStore.get(CLIENT_SESSION_COOKIE_NAME)?.value;
  if (!token) return null;

  const session = await verifyClientSessionToken(token);
  if (!session) return null;

  const headerList = await headers();
  const requestBrokerId = headerList.get("x-broker-id");
  if (!requestBrokerId || requestBrokerId !== session.brokerId) return null;

  return session;
}

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
  if (!client || client.status !== "ACTIVE") return null;

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
    ...(remember ? { maxAge: REMEMBER_TTL_SECONDS } : {}),
  };
}
