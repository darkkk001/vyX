// middleware.ts broker resolution through lib/broker-resolve-cache.ts (Neon load, 2026-10-05): parallel requests for one
// broker host make one resolve-broker call, and an unknown host still lands on /broker-not-found.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ROOT = "vyxtrader.test";
let middleware: (req: NextRequest) => Promise<Response>;
const calls: string[] = [];

beforeAll(async () => {
  vi.stubEnv("ROOT_DOMAIN", ROOT);
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s");
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/schema-status") return Response.json({ behind: false });
    calls.push(url.search);
    await new Promise((r) => setTimeout(r, 20));
    if (url.searchParams.get("subdomain") === "known") {
      return Response.json({ id: "b1", subdomain: "known", tier: "PRO", logoUrl: null, primaryColor: null, customDomain: null });
    }
    return new Response("not found", { status: 404 });
  });
  ({ middleware } = await import("@/middleware"));
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const req = (host: string, path = "/api/manage/badges") => new NextRequest(`http://${host}${path}`, { headers: { host } });

describe("middleware broker resolution", () => {
  it("nine parallel requests for one broker host make one resolve-broker call, and the next ones none", async () => {
    calls.length = 0;
    const res = await Promise.all(Array.from({ length: 9 }, () => middleware(req(`known.${ROOT}`))));
    expect(calls).toEqual(["?subdomain=known"]);
    for (const r of res) expect(r.headers.get("x-middleware-rewrite") ?? "").not.toContain("broker-not-found");
    await middleware(req(`known.${ROOT}`, "/trade"));
    expect(calls).toHaveLength(1);
  });

  it("an unknown host is rewritten to /broker-not-found and is not cached", async () => {
    calls.length = 0;
    const a = await middleware(req(`nobody.${ROOT}`));
    expect(a.headers.get("x-middleware-rewrite")).toContain("/broker-not-found");
    await middleware(req(`nobody.${ROOT}`));
    expect(calls).toEqual(["?subdomain=nobody", "?subdomain=nobody"]);
  });
});
