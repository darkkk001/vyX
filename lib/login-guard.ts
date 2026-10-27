import "server-only";
import { NextResponse } from "next/server";
import { clientIpOf } from "@/lib/client-ip";
import { checkRateLimit, clearFailures, lockoutRemainingSeconds, recordFailure } from "@/lib/rate-limit";

// Login hardening (owner 2026-10-28, infra audit): on top of each route's own 5 / min per account, every password
// login (trader, staff, portal, super admin) gets
// - a per-IP limit, so one password sprayed across many accounts from one address is slowed down;
// - a lockout after wrong passwords per account, so guessing one account stops for 15 minutes.
// A request with no trusted address ("unknown") skips only the per-IP limit: one shared bucket for every such request
// would let anyone lock everybody out. Redis down lets the login through (lib/rate-limit.ts fails open).

export type LoginKind = "trade" | "manage" | "portal" | "admin";

export const LOGIN_PER_IP = { limit: 20, windowSeconds: 60 } as const;
export const PASSWORD_LOCKOUT = { failures: 5, windowSeconds: 15 * 60 } as const;

export type LoginRefusal = { status: 429; error: string; code: "LOGIN_IP_LIMIT" | "LOGIN_LOCKED"; retryAfterSeconds: number };

const lockKey = (kind: LoginKind, identity: string) => `login-pw:${kind}:${identity.toLowerCase()}`;

/** Checked before any password compare. `identity` = the account the attempt names (per route: broker + login). */
export async function loginRefusal(kind: LoginKind, headers: { get(name: string): string | null }, identity: string): Promise<LoginRefusal | null> {
  const ip = clientIpOf(headers);
  if (ip !== "unknown") {
    const { allowed } = await checkRateLimit(`login-ip:${kind}:${ip}`, LOGIN_PER_IP.limit, LOGIN_PER_IP.windowSeconds);
    if (!allowed) {
      return { status: 429, error: "too many sign-in attempts from this network, try again in a minute", code: "LOGIN_IP_LIMIT", retryAfterSeconds: LOGIN_PER_IP.windowSeconds };
    }
  }
  const lockedFor = await lockoutRemainingSeconds(lockKey(kind, identity), PASSWORD_LOCKOUT.failures);
  if (lockedFor > 0) {
    const minutes = Math.max(1, Math.ceil(lockedFor / 60));
    return { status: 429, error: `too many wrong passwords, try again in ${minutes} minute${minutes === 1 ? "" : "s"}`, code: "LOGIN_LOCKED", retryAfterSeconds: lockedFor };
  }
  return null;
}

export function loginRefusalResponse(r: LoginRefusal): NextResponse {
  return NextResponse.json({ error: r.error, code: r.code }, { status: r.status, headers: { "Retry-After": String(r.retryAfterSeconds) } });
}

/** A wrong password (or an unknown login: same count, so a lockout never tells which logins exist). */
export async function loginFailed(kind: LoginKind, identity: string): Promise<void> {
  await recordFailure(lockKey(kind, identity), PASSWORD_LOCKOUT.windowSeconds, PASSWORD_LOCKOUT.failures);
}

/** The right password: the failures so far no longer count. */
export async function loginSucceeded(kind: LoginKind, identity: string): Promise<void> {
  await clearFailures(lockKey(kind, identity));
}
