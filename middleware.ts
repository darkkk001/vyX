import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// Resolves which Broker a request belongs to, from the Host header:
//   - subdomain:      brokername.<ROOT_DOMAIN>
//   - custom domain:  trade.brokername.com
// and attaches the result as request headers so downstream layouts/routes
// (and eventually API routes) can scope every query by brokerId without
// re-deriving it. Runs on the Edge runtime, so it cannot use Prisma
// directly — it calls an internal Node-runtime API route instead, which is
// the one thing this file talks to over the network.
//
// "admin.<ROOT_DOMAIN>" and the bare root domain are the Super Admin app
// and never resolve to a broker.

const SUPER_ADMIN_SUBDOMAIN = "admin";

type BrokerInfo = {
  id: string;
  subdomain: string;
  tier: string;
  logoUrl: string | null;
  primaryColor: string | null;
  customDomain: string | null;
};

// Module-scope cache, not Next.js's fetch Data Cache (a prior attempt using
// `next: { revalidate: 60 }` here broke broker resolution in production --
// Edge Middleware and the Data Cache didn't compose the way that assumed).
// This is a plain Map on the Edge isolate instead: every request currently
// pays a full middleware -> resolve-broker -> Prisma -> Postgres round trip
// before the actual page/API even starts, which is the dominant cost behind
// the 2-5s per-click slowness in the backoffice app. Broker metadata here
// (tier/logo/color) changes rarely, so a short fresh window removes that
// round trip for almost every request without going stale in any way a user
// would notice.
//
// FRESH_MS: served instantly, no fetch at all.
// STALE_MS: still used as a fallback if a re-fetch fails, instead of
//   rewriting to /broker-not-found -- this is the same failure mode that hit
//   production during the Prisma plan-limit outage (every broker's site
//   404ing at once because the lookup fetch failed). A transient DB/network
//   blip now degrades to "serving slightly-stale broker info" instead of
//   "site down."
const FRESH_MS = 30_000;
const STALE_MS = 30 * 60_000;
const brokerCache = new Map<string, { broker: BrokerInfo; fetchedAt: number }>();

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  const rootDomain = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];

  // The apex domain 308-redirects to www (Vercel domain config), so the
  // hostname actually seen here on most root-domain traffic is
  // "www.<ROOT_DOMAIN>", not the bare root — without this, every request to
  // the live site's root domain fell through to the custom-domain lookup
  // below, which always failed and rewrote to /broker-not-found. This broke
  // the Super Admin app (and anything else meant to live at the root)
  // entirely in production.
  const isRootOrSuperAdmin =
    hostname === rootDomain ||
    hostname === `www.${rootDomain}` ||
    hostname === `${SUPER_ADMIN_SUBDOMAIN}.${rootDomain}`;

  if (isRootOrSuperAdmin) {
    return NextResponse.next();
  }

  const isSubdomainOfRoot = hostname.endsWith(`.${rootDomain}`);
  const subdomain = isSubdomainOfRoot
    ? hostname.slice(0, -(rootDomain.length + 1))
    : null;

  const cacheKey = hostname;
  const cached = brokerCache.get(cacheKey);
  const now = Date.now();

  let broker: BrokerInfo;

  if (cached && now - cached.fetchedAt < FRESH_MS) {
    broker = cached.broker;
  } else {
    const lookupUrl = new URL("/api/internal/resolve-broker", request.url);
    if (subdomain) {
      lookupUrl.searchParams.set("subdomain", subdomain);
    } else {
      lookupUrl.searchParams.set("customDomain", hostname);
    }

    try {
      // 2026-09-05 security fix -- resolve-broker now requires this same
      // shared secret every other internal-only route on the platform
      // already checks (see that route's own comment for the finding).
      // "x-internal-request" above was never actually checked by the
      // route it was sent to -- purely documentation of intent, not a
      // real gate -- which is exactly how the route stayed reachable from
      // outside despite the comment implying otherwise.
      const resolveResponse = await fetch(lookupUrl, {
        headers: {
          "x-internal-request": "middleware",
          "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET ?? "",
        },
      });

      if (!resolveResponse.ok) {
        throw new Error(`resolve-broker returned ${resolveResponse.status}`);
      }

      broker = (await resolveResponse.json()) as BrokerInfo;
      brokerCache.set(cacheKey, { broker, fetchedAt: now });
    } catch (err) {
      // Fall back to a stale-but-recent cache entry rather than taking the
      // whole broker's site down on a transient DB/network blip -- see the
      // brokerCache comment above.
      if (cached && now - cached.fetchedAt < STALE_MS) {
        broker = cached.broker;
      } else {
        return NextResponse.rewrite(new URL("/broker-not-found", request.url));
      }
    }
  }

  // A broker with a customDomain configured gets ONE canonical address --
  // their own domain, not two live URLs for the same site. If this request
  // reached us on the *.{ROOT_DOMAIN} subdomain (subdomain is non-null --
  // see isSubdomainOfRoot above) and that broker has a customDomain set,
  // send it there instead of serving the subdomain directly.
  //
  // Can't loop: a request that already arrived on the custom domain falls
  // into the `customDomain` lookup branch above (hostname doesn't end in
  // `.${rootDomain}`), where `subdomain` is null, so this check is false
  // for it regardless of what broker.customDomain says. The `!== hostname`
  // guard is a second, belt-and-suspenders line against a misconfigured
  // customDomain that happens to equal the current host.
  // Brokers with no customDomain (the common case) have broker.customDomain
  // === null, so this never fires for them -- their subdomain keeps working
  // exactly as it does today.
  //
  // 2026-09-07 outage fix -- this used to redirect EVERY request,
  // /api/* included. That's fine for a top-level page navigation, but
  // WebTrader's own client-side polling (api/trade/prices, api/trade/
  // orders, .../positions -- confirmed live via `vercel logs` all
  // returning 308 on the subdomain) issues same-origin fetch() calls
  // from whatever origin the page already loaded on; a 308 across
  // origins drops the session cookie (scoped to the subdomain) and/or
  // gets blocked by CORS, breaking every open tab that hadn't yet
  // itself navigated over to the custom domain -- and any other client
  // (bundled desktop shell, a bookmarked/hardcoded subdomain URL) that
  // talks to the subdomain's API directly would break the same way.
  // Only real page navigations get redirected now; API traffic on the
  // subdomain keeps working exactly as before, custom domain or not.
  if (
    subdomain &&
    broker.customDomain &&
    broker.customDomain !== hostname &&
    !request.nextUrl.pathname.startsWith("/api/")
  ) {
    const redirectUrl = new URL(
      `${request.nextUrl.pathname}${request.nextUrl.search}`,
      `https://${broker.customDomain}`,
    );
    return NextResponse.redirect(redirectUrl, 308);
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-broker-id", broker.id);
  requestHeaders.set("x-broker-slug", broker.subdomain);
  requestHeaders.set("x-broker-tier", broker.tier);
  requestHeaders.set("x-broker-logo-url", broker.logoUrl ?? "");
  // Phase 1 trust pack -- app/manage/(shell)/layout.tsx needs to know the
  // current path server-side (to exempt /manage/security itself from its
  // own requireAdmin2fa redirect, or it would loop) and the App Router
  // gives a Server Component no built-in way to read that; middleware is
  // the one place that already has request.nextUrl.pathname for free.
  requestHeaders.set("x-pathname", request.nextUrl.pathname);
  requestHeaders.set("x-broker-primary-color", broker.primaryColor ?? "");

  return NextResponse.next({ request: { headers: requestHeaders } });
}

export const config = {
  matcher: [
    /*
     * Match everything except:
     * - /api/internal/* (called by this middleware itself — matching it
     *   here would recurse into resolve-broker forever)
     * - /_next/* (Next.js internals)
     * - static files (favicon, images, etc.)
     *
     * Every other /api/* route (e.g. /api/trade/*) IS matched, since those
     * routes need the x-broker-* headers this middleware attaches — a
     * narrower matcher that excluded all of /api silently broke broker
     * resolution for every trade API call while leaving page loads working,
     * which is exactly the bug this comment is here to prevent regressing.
     */
    "/((?!api/internal|_next/static|_next/image|favicon.ico|.*\\..*).*)",
  ],
};
