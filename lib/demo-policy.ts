// QoreTrader demo: which requests the demo tenant refuses, and how it is told apart from every other tenant. Pure and
// edge-safe (no Prisma, no Node APIs): middleware.ts and the server routes both import it.
//
// The tenant is marked by ONE environment variable, DEMO_BROKER_SUBDOMAIN (no schema change). Unset = there is no demo tenant
// and every function here says "not demo": a deployment without the variable behaves exactly as before.

export function demoSubdomain(): string | null {
  const v = (process.env.DEMO_BROKER_SUBDOMAIN ?? "").trim().toLowerCase();
  return v === "" ? null : v;
}

/** Is this the demo tenant? `slug` is the x-broker-slug middleware resolved (Broker.subdomain). */
export function isDemoTenant(slug: string | null | undefined): boolean {
  const demo = demoSubdomain();
  return demo != null && typeof slug === "string" && slug.toLowerCase() === demo;
}

export type DemoBlock = { status: 403 | 404; reason: string };

const DEMO_NOT_AVAILABLE = "This is not available in the demo.";

// API routes the demo tenant refuses outright (exact path or any path below it).
const BLOCKED_API_PREFIXES = [
  "/api/trade/funds-requests",
  "/api/trade/payment-methods",
  "/api/trade/kyc",
  "/api/trade/change-password",
  "/api/trade/forgot-password",
  "/api/trade/two-factor",
  "/api/trade/linked-accounts",
  "/api/trade/sso",
  "/api/trade/sessions",
  "/api/trade/login", // no password sign-in on the demo host (login, verify-2fa, login-redirect)
  "/api/trade/login-redirect",
  "/api/trade/ws-ticket", // no gateway sockets: prices run in the browser
  "/api/trade/alerts", // alerts are watched by the engine, which has no demo prices
  "/api/portal",
  "/api/manage",
  "/api/admin",
  "/api/client",
  "/api/public",
];

// Pages the demo tenant refuses (404, as if they were not there).
const BLOCKED_PAGE_PREFIXES = ["/portal", "/manage", "/manage-launch", "/manager", "/traders", "/download", "/launch", "/trade/sso", "/login", "/brokers", "/admins", "/billing", "/health", "/security", "/trials", "/notifications", "/audit"];

function under(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(prefix + "/");
}

/** The refusal for `pathname` on the demo tenant, or null when the request may go on. */
export function demoBlockFor(pathname: string): DemoBlock | null {
  if (pathname.startsWith("/api/")) {
    if (pathname.startsWith("/api/internal")) return null; // never reached through middleware's matcher; the crons guard themselves
    if (pathname.startsWith("/api/demo/")) return null; // the guest route and its siblings
    return BLOCKED_API_PREFIXES.some((p) => under(pathname, p)) ? { status: 403, reason: DEMO_NOT_AVAILABLE } : null;
  }
  return BLOCKED_PAGE_PREFIXES.some((p) => under(pathname, p)) ? { status: 404, reason: "Not found" } : null;
}

/** Header every response of the demo host carries: search engines must not index the demo. */
export const DEMO_ROBOTS_HEADER = "noindex, nofollow";

export const DEMO_BANNER_TEXT = "Demo account with simulated prices. QoreTrader is a technology provider, not a broker.";
export const DEMO_REFUSAL = DEMO_NOT_AVAILABLE;

// ---- keeping the demo out of every cross-tenant view and job ----
// Prisma filters for "everything except the demo broker". Empty (no filter at all) when no demo tenant is configured, so a
// deployment without DEMO_BROKER_SUBDOMAIN runs exactly the queries it always ran.

/** For a model with a `broker` relation (Account, Position, Order, AuditLog, Notification, AdminUser ...). */
export function excludeDemoByBrokerRelation(): { broker?: { subdomain: { not: string } } } {
  const sub = demoSubdomain();
  return sub ? { broker: { subdomain: { not: sub } } } : {};
}

/** For the Broker model itself. */
export function excludeDemoBroker(): { subdomain?: { not: string } } {
  const sub = demoSubdomain();
  return sub ? { subdomain: { not: sub } } : {};
}

// ---- the reserved range of guest account numbers (pure, so scripts can use it without the server-only modules) ----
export const GUEST_NUMBER_MIN = 48_000_000;
export const GUEST_NUMBER_MAX = 48_999_999;
const GUEST_NUMBER_RE = /^48[0-9]{6}$/;

/** Is this an account number inside the guest range (8 digits, 48000000..48999999)? */
export function isGuestAccountNumber(n: string | null | undefined): boolean {
  return typeof n === "string" && GUEST_NUMBER_RE.test(n);
}
