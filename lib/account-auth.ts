import "server-only";
import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import { prisma } from "@/lib/prisma";

export const ACCOUNT_SESSION_COOKIE_NAME = "vyx_trade_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

export type AccountSessionPayload = {
  accountId: string;
  brokerId: string;
};

function secretKey() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }
  // Deliberately reuses the admin secret rather than adding a second env
  // var — the two token types carry different payload shapes and cookie
  // names, so there's no confusion risk, and it keeps setup to one secret.
  return new TextEncoder().encode(secret);
}

export async function createAccountSessionToken(payload: AccountSessionPayload) {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(secretKey());
}

export async function verifyAccountSessionToken(
  token: string
): Promise<AccountSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as AccountSessionPayload;
  } catch {
    return null;
  }
}

// Server Components / route handlers: read the current trader session, if
// any, and cross-check it against the broker resolved by middleware.ts for
// this request — a session minted under one broker must never be usable
// against another broker's data, even if the JWT itself is valid.
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
