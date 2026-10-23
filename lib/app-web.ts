// QoreTrader web app (app.qoretrader.com, the mobile app's Flutter web build): one page origin
// for every broker, so it can never carry a broker's session cookie (httpOnly, SameSite=Lax,
// scoped to that broker's own domain) and its fetch() calls are cross-origin. For that origin
// only, the trader API answers CORS and takes the session as a bearer token instead:
// - login / verify-2fa return the session token in the JSON body when the request asks with
//   `X-Session-Transport: header` from an allowed origin;
// - getAccountSession and logout accept `Authorization: Bearer <token>` when no cookie came.
// No credentials mode: the web app never sends cookies, so no Allow-Credentials.

const DEFAULT_ORIGINS = "https://app.qoretrader.com";

export function appWebOrigins(): string[] {
  return (process.env.APP_WEB_ORIGINS ?? DEFAULT_ORIGINS)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function isAppWebOrigin(origin: string | null | undefined): boolean {
  return !!origin && appWebOrigins().includes(origin);
}

/** The routes the web app calls: the trader API, the public broker directory, and the public liveness route (it asks
 *  the VPS execution endpoint's /api/health before sending orders there; execution latency Phase 1). */
export function isAppWebPath(pathname: string): boolean {
  return pathname.startsWith("/api/trade/") || pathname === "/api/public/brokers" || pathname === "/api/health";
}

/** CORS headers for an allowed web app origin on its routes; null for anything else. */
export function appWebCorsHeaders(origin: string | null, pathname: string): Record<string, string> | null {
  if (!isAppWebPath(pathname) || !isAppWebOrigin(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin!,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, X-Client-Platform, X-Session-Transport",
    "Access-Control-Max-Age": "600",
    Vary: "Origin",
  };
}

/** The session token of an `Authorization: Bearer <token>` header, or null. */
export function bearerToken(authorization: string | null | undefined): string | null {
  if (!authorization) return null;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  return m ? m[1] : null;
}

/** The login answer carries the session token: asked for, from an allowed web app origin. */
export function wantsSessionToken(h: { get(name: string): string | null }): boolean {
  return h.get("x-session-transport") === "header" && isAppWebOrigin(h.get("origin"));
}
