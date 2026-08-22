import "server-only";
import { SignJWT, jwtVerify } from "jose";
import { cookies, headers } from "next/headers";
import type { AdminRole } from "@prisma/client";

export const SESSION_COOKIE_NAME = "vyx_admin_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days
const REMEMBER_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days -- "Keep me signed in" on /manage/login

export type AdminSessionPayload = {
  adminId: string;
  role: AdminRole;
  brokerId: string | null;
};

function secretKey() {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret) {
    throw new Error("ADMIN_SESSION_SECRET is not set");
  }
  return new TextEncoder().encode(secret);
}

export async function createSessionToken(payload: AdminSessionPayload, remember = false) {
  const ttl = remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS;
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ttl}s`)
    .sign(secretKey());
}

export async function verifySessionToken(
  token: string
): Promise<AdminSessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey());
    return payload as unknown as AdminSessionPayload;
  } catch {
    return null;
  }
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

// No shared role-check helper existed before this — every admin route
// hand-rolled its own `session.role !== "X"` check (see
// app/api/admin/brokers/route.ts's requireSuperAdmin). Added here for
// the new Manager surface since it needs the same check in multiple
// places (page guard + two API routes); existing Super Admin call sites
// are left as-is rather than migrated, to keep this change minimal.
export function requireAdminRole(session: AdminSessionPayload | null, roles: AdminRole[]): boolean {
  return session !== null && roles.includes(session.role);
}

export function sessionCookieOptions(remember = false) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: remember ? REMEMBER_TTL_SECONDS : SESSION_TTL_SECONDS,
  };
}
