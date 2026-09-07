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
