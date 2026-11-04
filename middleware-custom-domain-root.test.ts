// 2026-11-04 (owner, live issue): on a broker's custom client domain the root "/" redirects to /login (the client portal), never the
// platform's built-in broker landing. The platform subdomains keep their landing; nothing else changes.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const ROOT = "vyxtrader.test";
let middleware: (req: NextRequest) => Promise<Response>;

const BROKER = { id: "fx-broker", subdomain: "futurixglobal", tier: "PRO", logoUrl: null, primaryColor: null, customDomain: "my.futurix.test", customDomainLive: true };
const OTHER = { id: "qt-broker", subdomain: "qoretrader", tier: "PRO", logoUrl: null, primaryColor: null, customDomain: null };

beforeAll(async () => {
  vi.stubEnv("ROOT_DOMAIN", ROOT);
  vi.stubEnv("INTERNAL_SERVICE_SECRET", "s");
  vi.stubEnv("DEMO_BROKER_SUBDOMAIN", "qoredemo");
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/schema-status") return Response.json({ behind: false });
    if (url.searchParams.get("customDomain") === "my.futurix.test") return Response.json(BROKER);
    if (url.searchParams.get("subdomain") === "futurixglobal") return Response.json(BROKER);
    if (url.searchParams.get("subdomain") === "qoretrader") return Response.json(OTHER);
    if (url.searchParams.get("customDomain") === "demo.qore.test") return Response.json({ ...OTHER, id: "demo-id", subdomain: process.env.DEMO_BROKER_SUBDOMAIN ?? "qoredemo", customDomain: "demo.qore.test", customDomainLive: true });
    return new Response("not found", { status: 404 });
  });
  ({ middleware } = await import("@/middleware"));
});
afterAll(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const req = (host: string, path: string) => new NextRequest(`https://${host}${path}`, { headers: { host } });

describe("custom client domain root", () => {
  it("my.<broker>/ redirects to /login (307), keeping the query", async () => {
    const res = await middleware(req("my.futurix.test", "/?ref=site"));
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location")!).pathname).toBe("/login");
    expect(new URL(res.headers.get("location")!).search).toBe("?ref=site");
    expect(new URL(res.headers.get("location")!).host).toBe("my.futurix.test");
  });

  it("/login on the custom domain is served (rewritten to the portal sign-in), not redirected", async () => {
    const res = await middleware(req("my.futurix.test", "/login"));
    expect(res.status).not.toBe(307);
    expect(res.headers.get("x-middleware-rewrite") ?? "").toContain("/portal/login");
  });

  it("other paths on the custom domain are untouched", async () => {
    const res = await middleware(req("my.futurix.test", "/trade"));
    expect(res.headers.get("location")).toBeNull();
  });

  it("the QoreTrader public demo's custom domain keeps its root (the demo terminal)", async () => {
    const res = await middleware(req("demo.qore.test", "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("a platform subdomain without a custom domain keeps its landing at /", async () => {
    const res = await middleware(req(`qoretrader.${ROOT}`, "/"));
    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });

  it("the broker's platform subdomain still sends pages to its custom domain (root included, then / -> /login there)", async () => {
    const res = await middleware(req(`futurixglobal.${ROOT}`, "/"));
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://my.futurix.test/");
  });
});
