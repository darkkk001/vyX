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

export async function middleware(request: NextRequest) {
  const host = request.headers.get("host") ?? "";
  const hostname = host.split(":")[0];
  const rootDomain = (process.env.ROOT_DOMAIN ?? "localhost:3000").split(":")[0];

  const isRootOrSuperAdmin =
    hostname === rootDomain || hostname === `${SUPER_ADMIN_SUBDOMAIN}.${rootDomain}`;

  if (isRootOrSuperAdmin) {
    return NextResponse.next();
  }

  const isSubdomainOfRoot = hostname.endsWith(`.${rootDomain}`);
  const subdomain = isSubdomainOfRoot
    ? hostname.slice(0, -(rootDomain.length + 1))
    : null;

  const lookupUrl = new URL("/api/internal/resolve-broker", request.url);
  if (subdomain) {
    lookupUrl.searchParams.set("subdomain", subdomain);
  } else {
    lookupUrl.searchParams.set("customDomain", hostname);
  }

  const resolveResponse = await fetch(lookupUrl, {
    headers: { "x-internal-request": "middleware" },
  });

  if (!resolveResponse.ok) {
    return NextResponse.rewrite(new URL("/broker-not-found", request.url));
  }

  const broker = (await resolveResponse.json()) as {
    id: string;
    subdomain: string;
    tier: string;
    logoUrl: string | null;
    primaryColor: string | null;
  };

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-broker-id", broker.id);
  requestHeaders.set("x-broker-slug", broker.subdomain);
  requestHeaders.set("x-broker-tier", broker.tier);
  requestHeaders.set("x-broker-logo-url", broker.logoUrl ?? "");
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
