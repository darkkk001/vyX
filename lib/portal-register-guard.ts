import "server-only";
import { randomBytes } from "node:crypto";
import { getRedis } from "@/lib/redis";

// Anti-bot gate for the Client Portal sign-up (owner 2026-11-03). From 2026-10-19 the Futurix portal took ~190
// sign-ups with random one-word names and no phone or country, and only a handful ever verified: scripted
// sign-ups mailing verification links to real people's inboxes. Frictionless on purpose (no CAPTCHA):
//   1. a hidden honeypot field a person never sees or fills (form-filling bots fill every field);
//   2. a form token the sign-up page issues server-side (Redis, single page view), so a script that posts straight
//      to /api/portal/register without loading the page is refused, and a token used within REGISTER_FORM_MIN_MS
//      of the page being served is refused (a person needs longer to type a name, an e-mail and a password);
//   3. a per-IP limit on the route (clientIpOf: Vercel's own address headers, not the spoofable x-forwarded-for).

export const REGISTER_HONEYPOT_FIELD = "website";
export const REGISTER_FORM_MIN_MS = 3_000;
export const REGISTER_FORM_TTL_SECONDS = 24 * 60 * 60;
// a person may correct a typo or a too-short password and send again from the same page
export const REGISTER_FORM_MAX_USES = 5;
export const REGISTER_PER_IP_PER_HOUR = 5;

const key = (token: string) => `portal-register-form:${token}`;
const usesKey = (token: string) => `portal-register-form-uses:${token}`;

/** Issued by the sign-up page per view; the form posts it back as formToken. */
export async function issueRegisterFormToken(now = Date.now()): Promise<string> {
  const token = randomBytes(18).toString("base64url");
  await getRedis().set(key(token), String(now), "EX", REGISTER_FORM_TTL_SECONDS);
  return token;
}

export type RegisterFormVerdict =
  | { ok: true }
  // filled honeypot: answered like a success (nothing created, nothing sent) so the bot learns nothing
  | { ok: false; kind: "honeypot" }
  // a person can hit these (very fast autofill, a page left open for a day): the form shows the reason
  | { ok: false; kind: "too_fast" | "form_expired" };

export async function checkRegisterForm(body: unknown, now = Date.now()): Promise<RegisterFormVerdict> {
  const b = (body ?? {}) as Record<string, unknown>;
  const trap = b[REGISTER_HONEYPOT_FIELD];
  if (typeof trap === "string" && trap.trim() !== "") return { ok: false, kind: "honeypot" };

  const token = typeof b.formToken === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(b.formToken) ? b.formToken : null;
  if (!token) return { ok: false, kind: "form_expired" };
  const redis = getRedis();
  const issued = Number(await redis.get(key(token)));
  if (!Number.isFinite(issued) || issued <= 0) return { ok: false, kind: "form_expired" };
  if (now - issued < REGISTER_FORM_MIN_MS) return { ok: false, kind: "too_fast" };
  const uses = await redis.incr(usesKey(token));
  if (uses === 1) await redis.expire(usesKey(token), REGISTER_FORM_TTL_SECONDS);
  if (uses > REGISTER_FORM_MAX_USES) return { ok: false, kind: "form_expired" };
  return { ok: true };
}
