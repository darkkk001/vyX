// Security re-audit 2026-10-23: a client-sent x-broker-id (or any x-broker-* / x-pathname) never reaches a page or
// route. The broker comes only from the host. Next carries the forwarded request headers on the middleware response as
// x-middleware-request-<name> (listed in x-middleware-override-headers), so the test reads exactly what a route sees.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ROOT = "vyxtrader.test";
let middleware: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  vi.stubEnv("ROOT_DOMAIN", ROOT);
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s");
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/schema-status") return Response.json({ behind: false });
    if (url.searchParams.get("subdomain") === "real") {
      return Response.json({ id: "real-broker", subdomain: "real", tier: "PRO", logoUrl: null, primaryColor: null, customDomain: null });
    }
    return new Response("not found", { status: 404 });
  });
  ({ middleware } = await import("@/middleware"));
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const FORGED = { "x-broker-id": "victim-broker", "x-broker-slug": "victim", "x-broker-tier": "ENTERPRISE", "x-broker-anything": "x", "x-pathname": "/security" };
const forged = (host: string, path = "/api/trade/login") => new NextRequest(`http://${host}${path}`, { headers: { host, ...FORGED } });

/** The request headers a route behind this middleware receives (only those the middleware forwards). */
function forwarded(res: Response): Record<string, string> {
  const names = (res.headers.get("x-middleware-override-headers") ?? "").split(",").filter(Boolean);
  return Object.fromEntries(names.map((n) => [n, res.headers.get(`x-middleware-request-${n}`) ?? ""]));
}
const brokerKeys = (h: Record<string, string>) => Object.keys(h).filter((k) => k.startsWith("x-broker-"));

describe("middleware drops client-sent broker headers", () => {
  for (const host of [`www.${ROOT}`, ROOT, `admin.${ROOT}`]) {
    it(`root / admin host ${host}: no x-broker-* reaches the route; x-pathname is the real path`, async () => {
      const h = forwarded(await middleware(forged(host)));
      expect(brokerKeys(h)).toEqual([]);
      expect(h["x-pathname"]).toBe("/api/trade/login");
    });
  }

  it("broker host: x-broker-id is the host's broker, never the forged one; unknown x-broker-* is dropped", async () => {
    const h = forwarded(await middleware(forged(`real.${ROOT}`)));
    expect(h["x-broker-id"]).toBe("real-broker");
    expect(h["x-broker-slug"]).toBe("real");
    expect(h["x-broker-tier"]).toBe("PRO");
    expect(h).not.toHaveProperty("x-broker-anything");
    expect(h["x-pathname"]).toBe("/api/trade/login");
  });

  it("unknown host (broker-not-found rewrite): the forged headers do not travel with the rewrite", async () => {
    const res = await middleware(forged(`nobody.${ROOT}`));
    expect(res.headers.get("x-middleware-rewrite")).toContain("/broker-not-found");
    const h = forwarded(res);
    expect(brokerKeys(h)).toEqual([]);
    expect(h).not.toHaveProperty("x-pathname");
  });
});
