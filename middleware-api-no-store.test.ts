// Owner 2026-10-28 (infra audit): every /api/* answer carries Cache-Control: no-store, set once in the middleware
// wrapper, on every branch (a forwarded route, a refusal, a broker host, the root host); pages keep their own.
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

const req = (host: string, path: string) => new NextRequest(`http://${host}${path}`, { headers: { host } });

describe("Cache-Control: no-store on /api/*", () => {
  for (const [host, path] of [[`real.${ROOT}`, "/api/trade/me"], [`real.${ROOT}`, "/api/manage/dashboard"], [`www.${ROOT}`, "/api/public/brokers"], [`nosuch.${ROOT}`, "/api/trade/me"]]) {
    it(`${host}${path}`, async () => {
      const res = await middleware(req(host, path));
      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  }
  it("a page is left alone", async () => {
    const res = await middleware(req(`real.${ROOT}`, "/trade"));
    expect(res.headers.get("cache-control")).toBeNull();
  });
});
