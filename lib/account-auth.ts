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

export async function createAccountSession(payload: AccountSessionPayload): Promise<string> {
  const token = crypto.randomBytes(32).toString("hex");
  await getRedis().set(sessionKey(token), JSON.stringify(payload), "EX", SESSION_TTL_SECONDS);
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
// captured it before logout.
export async function revokeAccountSession(token: string): Promise<void> {
  await getRedis().del(sessionKey(token));
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

export function accountSessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
