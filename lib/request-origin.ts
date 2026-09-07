import "server-only";
import type { NextRequest } from "next/server";

// new URL(request.url).origin -- the pattern already used elsewhere in
// this codebase (app/api/trade/login-redirect/route.ts, app/(broker)/
// trade/sso/route.ts) -- does NOT reliably reflect the actual incoming
// Host in local dev: confirmed live here (curl with an explicit
// `Host: acmefx.localhost:3000` header still got back a bare
// `http://localhost:3000` origin from every one of this file's own
// callers before this fix). middleware.ts never has this problem because
// it reads the Host header directly (`request.headers.get("host")`),
// never request.url -- this does the same thing, for the same reason,
// wherever a route needs to build an absolute link back to itself (an
// email verification/reset link, a redirect target) rather than just
// parse the current request's own path/query.
export function requestOrigin(request: NextRequest): string {
  const host = request.headers.get("host") ?? "localhost:3000";
  // Vercel always sets this for real traffic; nothing sets it for a
  // plain local dev server, where http is always correct anyway.
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  return `${proto}://${host}`;
}

// For a link meant to be clicked later, from anywhere (an email
// verification/reset link) -- NOT for redirecting/echoing the current
// request, which is what requestOrigin above is for. The difference
// matters: requestOrigin reflects whatever Host the request actually
// arrived on, which for an API route is whatever origin the client's
// page happened to load from (the *.ROOT_DOMAIN subdomain, a bare
// internal hostname used to reach the server, a dev tunnel, etc --
// middleware.ts only redirects *page* navigations to a broker's
// customDomain, never API traffic, so a subdomain-origin API call is
// completely normal, not a bug). A mailed link isn't "the current
// request" -- it has to be the broker's one real public address,
// always, or a client's verify/reset link is dev-artifact garbage
// (confirmed live: a registration hit through a temporary local Host
// override produced "http://trade.futurixglobal.com:3000/...".) Built
// from the broker's own stored domain config instead: customDomain if
// set (always https, no port -- that's a broker's real, permanent
// domain regardless of which environment generated the link), else
// subdomain.ROOT_DOMAIN (https/no-port once ROOT_DOMAIN is a real
// domain; local dev's own bare "localhost" root keeps http+port since
// that fallback only ever matters for a broker that hasn't set up a
// real domain yet, i.e. this environment IS the only place it resolves).
export function brokerPublicOrigin(broker: { customDomain: string | null; subdomain: string }): string {
  if (broker.customDomain) {
    return `https://${broker.customDomain}`;
  }

  const rootDomain = process.env.ROOT_DOMAIN ?? "localhost:3000";
  const [rootHost, rootPort] = rootDomain.split(":");
  const host = `${broker.subdomain}.${rootHost}`;
  return rootHost === "localhost" ? `http://${host}:${rootPort ?? "3000"}` : `https://${host}`;
}
