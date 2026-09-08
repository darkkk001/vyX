import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { verifyDesktopGateToken } from "@/lib/desktop-gate";

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

// 2026-09-07 architecture decision, refined 2026-09-08 -- application-only
// surfaces, modeled on MT5's own split (download the terminal, enter
// account+password, reach the broker's server -- never a browser URL for
// the terminal itself, let alone its backoffice). Manager/Broker-Admin
// backoffice and Super Admin must never be reachable by a browser, on ANY
// domain (a broker's own subdomain/customDomain, admin.<ROOT_DOMAIN>, or
// the bare root) -- only through the packaged desktop apps (manager-tauri/
// admin-tauri).
//
// 2026-09-08 -- manager-tauri/admin-tauri now load these pages' own real,
// live URL directly (WebviewUrl::External), the same fix already applied
// to desktop-tauri/the trader terminal, instead of maintaining a second
// hand-copied UI that inevitably drifts from the real one (confirmed live
// that it had). That means this can no longer be an unconditional block --
// something has to let the genuine desktop app's own real page-navigation
// requests through while still 404ing every browser. See lib/
// desktop-gate.ts, app/api/manage/desktop-gate/route.ts and app/api/admin/
// desktop-gate/route.ts for the full mint side of this: each app's build
// carries its own secret (Broker.desktopGateSecret for manager-tauri,
// SUPER_ADMIN_DESKTOP_GATE_SECRET for admin-tauri -- see rebrand.js), the
// app trades it once for a short-lived signed cookie by navigating to that
// route, and every request after that (real in-app navigation, exactly
// like a normal browser tab) carries the cookie automatically. Everything
// below only ever checks for that cookie -- a browser with no way to mint
// one keeps getting exactly the same unconditional 404 as before.
//
// Manager: every /manage/* page (NOT /manage-launch, a separate,
// unrelated desktop-app broker-picker screen -- this check only matches
// the literal segment boundary). Super Admin: (super-admin) is a Next.js
// route group, invisible in the URL, so its pages are these bare
// top-level paths -- hardcoded rather than pattern-matched since there's
// no way to ask the Edge runtime "what page would handle this path" and
// this app's own list of Super Admin pages changes rarely (it's a whole
// nav, not a per-feature thing) -- keep this in sync with
// app/(super-admin)/(shell)/*'s own directory listing if a page is ever
// added or removed there.
const MANAGE_GATE_COOKIE = "vyx_manage_gate";
const SUPER_ADMIN_GATE_COOKIE = "vyx_admin_gate";

const SUPER_ADMIN_PAGE_PATHS = new Set([
  "/login",
  "/brokers",
  "/admins",
  "/audit",
  "/billing",
  "/health",
  "/notifications",
  "/security",
  "/trials",
]);

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

// 2026-09-08 TEMPORARY, requested directly -- Futurix's customDomain
// (futurixglobal.com) is correctly configured in the database and
// already added to this Vercel project, but its DNS still points at its
// registrar's own nameservers rather than Vercel (confirmed live: the
// apex resolves to a non-Vercel IP), so redirecting there sends every
// page to a domain that can't be reached at all right now. Skips the
// customDomain redirect below for just this one broker until DNS is
// fixed, keeping the subdomain (futurixglobal.vyxtrader.com) directly
// usable in the meantime -- remove this once futurixglobal.com actually
// resolves through Vercel.
const CUSTOM_DOMAIN_REDIRECT_SKIP_SUBDOMAINS = new Set(["futurixglobal"]);

// 2026-09-08 -- friendly entry-point aliases, requested directly: a
// broker's own staff/traders land on a clean, on-brand URL
// (/manager/login, /traders/login) instead of the app's own internal
// path names (/manage/login, /trade/login). Deliberately just the login
// entry point, not every page under each tree -- once past login, the
// app's own existing internal navigation already uses /manage/*//trade/*
// consistently everywhere, so there's nothing else to alias. Generic
// (not Futurix-specific) -- any broker gets these for free.
const PATH_ALIASES: Record<string, string> = {
  "/manager/login": "/manage/login",
  "/traders/login": "/trade/login",
};

export async function middleware(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  const effectivePathname = PATH_ALIASES[pathname] ?? pathname;
  const isManagePage = effectivePathname === "/manage" || effectivePathname.startsWith("/manage/");
  const isSuperAdminPage = SUPER_ADMIN_PAGE_PATHS.has(effectivePathname);

  // 2026-09-08 TEMPORARY REVERSAL, requested directly -- the native-app
  // track this gate was built for (see the architecture comment below)
  // isn't ready yet, and Futurix needs a working backoffice on the web
  // right now. /manage/* is unblocked for browsers again, exactly like
  // before the 2026-09-07 lockdown -- normal broker resolution, normal
  // page rendering, no cookie required. The gate machinery itself
  // (MANAGE_GATE_COOKIE, lib/desktop-gate.ts, the /api/manage/
  // desktop-gate route) is left in place, unused, so re-enabling the
  // block later is just restoring the two checks below, not rebuilding
  // them. Super Admin's own block (isSuperAdminPage, further down) is
  // untouched -- only /manage/* was asked to be reopened.
  //
  // if (isManagePage && !request.cookies.get(MANAGE_GATE_COOKIE)?.value) {
  //   return new NextResponse("Not found", { status: 404 });
  // }

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

  if (isSuperAdminPage) {
    // No broker involved for Super Admin -- bind the check to the actual
    // host too (not just cookie presence), so a token can only ever pass
    // on the one real Super Admin host it was minted for.
    const internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? "";
    const gateCookie = request.cookies.get(SUPER_ADMIN_GATE_COOKIE)?.value;
    const isSuperAdminHost = hostname === `${SUPER_ADMIN_SUBDOMAIN}.${rootDomain}`;
    const gateValid =
      isSuperAdminHost &&
      !!gateCookie &&
      !!internalSecret &&
      (await verifyDesktopGateToken(gateCookie, "super-admin", internalSecret));
    if (!gateValid) {
      return new NextResponse("Not found", { status: 404 });
    }
    // Valid -- fall through exactly like a normal request; isSuperAdminHost
    // being required above means isRootOrSuperAdmin is guaranteed true next.
  }

  if (isRootOrSuperAdmin) {
    // /manage/* still has no meaning on the admin or root domain (no
    // broker to resolve there) regardless of the temporary reversal
    // above -- this was never gate-related, just "there's nothing to
    // serve here," so it stays.
    if (isManagePage) {
      return new NextResponse("Not found", { status: 404 });
    }
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

  // 2026-09-08 TEMPORARY REVERSAL -- see the top-of-function comment.
  // /manage/* now falls straight through to the same custom-domain-
  // redirect and header-attachment logic as any other page on this
  // broker, same as before the 2026-09-07 lockdown.
  //
  // if (isManagePage) {
  //   const internalSecret = process.env.INTERNAL_SERVICE_SECRET ?? "";
  //   const gateCookie = request.cookies.get(MANAGE_GATE_COOKIE)!.value;
  //   const gateValid =
  //     !!internalSecret && (await verifyDesktopGateToken(gateCookie, `manage:${broker.id}`, internalSecret));
  //   if (!gateValid) {
  //     return new NextResponse("Not found", { status: 404 });
  //   }
  // }

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
    !request.nextUrl.pathname.startsWith("/api/") &&
    !CUSTOM_DOMAIN_REDIRECT_SKIP_SUBDOMAINS.has(subdomain)
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
  // effectivePathname (not the raw request path) so a page reached via a
  // PATH_ALIASES entry sees the same value it would if visited directly.
  requestHeaders.set("x-pathname", effectivePathname);
  requestHeaders.set("x-broker-primary-color", broker.primaryColor ?? "");

  // A PATH_ALIASES match rewrites to the real page internally -- the
  // browser's URL bar keeps showing the friendly alias (/manager/login,
  // /traders/login) while the actual page rendered is the one at
  // effectivePathname, exactly like the /broker-not-found rewrite above.
  if (effectivePathname !== pathname) {
    const rewriteUrl = new URL(`${effectivePathname}${request.nextUrl.search}`, request.url);
    return NextResponse.rewrite(rewriteUrl, { request: { headers: requestHeaders } });
  }

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
