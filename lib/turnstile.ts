import "server-only";
import { prisma } from "@/lib/prisma";

// Cloudflare Turnstile on the Trader's Room sign-in and sign-up (owner 2026-11-05). One platform key pair
// (TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY; the widget is created as Invisible in Cloudflare), switched per broker
// (Broker.humanCheckEnabled). It covers the room's forms only, so a broker without the CRM module never meets it.
//
// If Cloudflare cannot be reached the check is skipped and logged: an outage there must not lock every client out, and
// the login and sign-up limits stay in force behind it.

const VERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const VERIFY_TIMEOUT_MS = 5000;

export const humanCheckConfigured = () => Boolean(process.env.TURNSTILE_SITE_KEY && process.env.TURNSTILE_SECRET_KEY);

/** The site key when this broker's room asks for the check, else null. */
export async function humanCheckSiteKey(brokerId: string): Promise<string | null> {
  if (!humanCheckConfigured()) return null;
  const b = await prisma.broker.findUnique({ where: { id: brokerId }, select: { humanCheckEnabled: true, crmEnabled: true } });
  return b?.humanCheckEnabled && b.crmEnabled ? process.env.TURNSTILE_SITE_KEY! : null;
}

export async function verifyHumanCheck(token: unknown, ip: string | null): Promise<"ok" | "bad" | "unavailable"> {
  if (typeof token !== "string" || !token || token.length > 2048) return "bad";
  try {
    const res = await fetch(VERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.TURNSTILE_SECRET_KEY, response: token, ...(ip ? { remoteip: ip } : {}) }),
      signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`siteverify ${res.status}`);
    const body = (await res.json()) as { success?: boolean };
    return body.success === true ? "ok" : "bad";
  } catch (err) {
    console.error("[turnstile] check skipped, Cloudflare unavailable", err);
    return "unavailable";
  }
}
