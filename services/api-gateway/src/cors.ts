// Browser CORS for the PWA (app.qoretrader.com), which calls this Gateway directly.
//
// It lives here and NOT in Caddy on purpose: the Caddyfile's {$VAR} secrets are emptied by a bare
// `caddy reload` (scripts/caddy-reload.ps1 has the incident), and headers set at the edge would also
// have to echo a per-request origin.
//
// UNCREDENTIALED by design: the PWA sends `Authorization: Bearer`, never a cookie, so
// Access-Control-Allow-Credentials is never set and a browser will not attach cookies cross-origin.
// The cookie path used by same-origin callers does not pass through any CORS decision.
//
// The origin is only ever echoed from the allow-list, never `*`, and every in-scope response carries
// `Vary: Origin` so a shared cache cannot serve one origin's answer to another.

import type { NextFunction, Request, Response } from "express";

export const DEFAULT_CORS_ORIGINS = ["https://app.qoretrader.com"];
export const CORS_ALLOW_METHODS = "GET, POST, OPTIONS";
export const CORS_ALLOW_HEADERS = "content-type, authorization, x-broker-id, idempotency-key";
export const CORS_MAX_AGE_SECONDS = "600";

/** Normalises one origin to scheme://host[:port], or null if it is not a plain https origin. */
export function normalizeOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed.includes("*")) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password) return null;
  if (url.pathname !== "/" || url.search || url.hash) return null;
  return url.origin;
}

/**
 * The allow-list: the defaults plus GATEWAY_CORS_ORIGINS (comma-separated, the per-broker origins).
 * An entry that is not a plain https origin is dropped and logged, so a typo or a `*` can never widen
 * the list.
 */
export function parseAllowedOrigins(raw: string | undefined): Set<string> {
  const allowed = new Set<string>(DEFAULT_CORS_ORIGINS);
  for (const entry of (raw ?? "").split(",")) {
    if (!entry.trim()) continue;
    const origin = normalizeOrigin(entry);
    if (origin) allowed.add(origin);
    else console.warn(`GATEWAY_CORS_ORIGINS: ignoring invalid origin entry: ${entry.trim()}`);
  }
  return allowed;
}

// Only the browser-facing surface. /internal/* is server to server and never gets CORS headers.
function inCorsScope(path: string): boolean {
  return path === "/health" || path === "/v1" || path.startsWith("/v1/");
}

/**
 * Must be the FIRST middleware, ahead of express.json(), so that:
 *  - it replaces Express's automatic OPTIONS responder (every OPTIONS ends here with a 204), and
 *  - a 401 or 429 further down still carries the header, so the browser can read the refusal.
 *
 * A refused origin gets the same status with no Access-Control-* headers at all: the browser blocks
 * the call, and nothing about the allow-list is revealed.
 */
export function corsMiddleware(allowed: Set<string>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const scoped = inCorsScope(req.path);
    const origin = req.headers.origin;
    const permitted = scoped && typeof origin === "string" && allowed.has(origin);

    if (scoped) res.vary("Origin");
    if (permitted) res.setHeader("Access-Control-Allow-Origin", origin);

    if (req.method !== "OPTIONS") {
      next();
      return;
    }
    if (permitted) {
      res.setHeader("Access-Control-Allow-Methods", CORS_ALLOW_METHODS);
      res.setHeader("Access-Control-Allow-Headers", CORS_ALLOW_HEADERS);
      res.setHeader("Access-Control-Max-Age", CORS_MAX_AGE_SECONDS);
    }
    res.status(204).end();
  };
}
