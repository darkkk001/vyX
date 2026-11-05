// Per-client-IP throttle for /v1/* and /internal/*, applied at the Gateway because the Caddy build on
// the VPS has no rate-limit module.
//
// OFF unless GATEWAY_EDGE_RATE_LIMIT_PER_MIN is set to a positive number. It ships disabled because
// server-side web traffic reaches this Gateway from a small set of shared IPs, so a per-IP number has
// to be chosen against real traffic: too low, and it refuses real orders.
//
// What it deliberately does not count:
//  - a request with no X-Forwarded-For, which came over loopback and not through Caddy (local tools,
//    the watchdog, runbook checks);
//  - a request carrying a valid x-internal-secret, which is a trusted service.
//
// It covers only what reaches this process. The engine routes Caddy sends straight to :8081 are not
// seen here, so they stay unthrottled until the edge itself can do it.

import type { NextFunction, Request, Response } from "express";
import { internalSecretOk } from "./internal-secret.js";
import { checkRateLimitLocal } from "./rate-limit.js";

const WINDOW_SECONDS = 60;

export function parseEdgeLimit(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : 0;
}

// Caddy appends the address it saw, so the LAST entry is the one a client cannot forge.
export function clientIpFrom(forwardedFor: string | string[] | undefined): string | null {
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
  if (!header) return null;
  const last = header.split(",").pop()?.trim();
  return last ? last : null;
}

export function edgeRateLimit(limitPerMinute: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limited = req.path.startsWith("/v1/") || req.path.startsWith("/internal/");
    if (limitPerMinute <= 0 || !limited) {
      next();
      return;
    }
    const ip = clientIpFrom(req.headers["x-forwarded-for"]);
    if (!ip || internalSecretOk(req.headers["x-internal-secret"])) {
      next();
      return;
    }
    const { allowed } = checkRateLimitLocal(`edge:${ip}`, limitPerMinute, WINDOW_SECONDS);
    if (allowed) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(WINDOW_SECONDS));
    res.status(429).json({ error: "too many requests, slow down" });
  };
}
