import { checkRateLimit, clearFailures, isLockedOut, recordFailure } from "@/lib/rate-limit";
import { clientIpOf } from "@/lib/demo";
import { verifyTotp } from "@/lib/totp";

// CRM security batch (owner 2026-11-13): money and support requests are limited per client (each route) AND per IP
// (here), and every authenticator-code check after sign-in shares one lockout per client.

/** Per-IP limit for a client action, on top of the route's per-client limit. IP from Vercel's own headers. */
export async function ipAllowed(headers: { get(name: string): string | null }, brokerId: string, action: string, limit: number, windowSeconds: number): Promise<boolean> {
  return (await checkRateLimit(`${action}-ip:${brokerId}:${clientIpOf(headers)}`, limit, windowSeconds)).allowed;
}

export const CODE_FAILURES_ALLOWED = 5;
export const CODE_LOCK_SECONDS = 15 * 60;
const codeKey = (clientId: string) => `room-2fa-fail:${clientId}`;

/**
 * The authenticator code for withdrawals, new payout addresses and 2FA on/off: 5 wrong codes lock all of them for
 * 15 minutes (a stolen session can no longer guess its way through at 6 a minute).
 */
export async function checkClientCode(clientId: string, secret: string, code: string): Promise<"ok" | "wrong" | "locked"> {
  if (await isLockedOut(codeKey(clientId), CODE_FAILURES_ALLOWED)) return "locked";
  if (verifyTotp(secret, code)) { await clearFailures(codeKey(clientId)); return "ok"; }
  await recordFailure(codeKey(clientId), CODE_LOCK_SECONDS);
  return "wrong";
}
export const CODE_LOCKED_MESSAGE = "Too many wrong codes. Try again in 15 minutes.";
