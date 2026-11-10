// middleware.ts manage lock (owner 2026-11-10): the broker backoffice is the native app only. Every /manage page on a
// broker host is a 404 (no cookie or token opens it); /api/manage/* (the native
// app), the client pages (WebTrader) and the Super Admin host are not touched by it.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { mintDesktopGateToken } from "@/lib/desktop-gate";

const ROOT = "vyxtrader.test";
const SECRET = "s";
let middleware: (req: NextRequest) => Promise<Response>;

beforeAll(async () => {
  vi.stubEnv("ROOT_DOMAIN", ROOT);
  vi.stubEnv("INTERNAL_SERVICE_SECRET", SECRET);
  vi.stubGlobal("fetch", async (input: URL | string) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/internal/schema-status") return Response.json({ behind: false });
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

const req = (host: string, path: string, cookie?: string) =>
  new NextRequest(`http://${host}${path}`, { headers: { host, ...(cookie ? { cookie } : {}) } });
const BROKER = `known.${ROOT}`;

describe("manage lock", () => {
  it("every /manage page on a broker host is a 404 in a browser", async () => {
    for (const path of ["/manage", "/manage/login", "/manage/dashboard", "/manage/liquidity", "/manager/login"]) {
      expect((await middleware(req(BROKER, path))).status, path).toBe(404);
    }
  });

  it("no cookie opens it: a forged one, or even a validly signed old manage gate token, is still a 404", async () => {
    expect((await middleware(req(BROKER, "/manage/dashboard", "vyx_manage_gate=x"))).status).toBe(404);
    const signed = await mintDesktopGateToken("manage:b1", SECRET);
    expect((await middleware(req(BROKER, "/manage/dashboard", `vyx_manage_gate=${signed}`))).status).toBe(404);
  });

  it("the native app's /api/manage/*, the client pages and /manage-launch are untouched", async () => {
    for (const path of ["/api/manage/badges", "/api/manage/login", "/login", "/trade", "/manage-launch"]) {
      expect((await middleware(req(BROKER, path))).status, path).not.toBe(404);
    }
  });

  it("the Super Admin host keeps its own gate (unchanged), and /manage there is still a 404", async () => {
    expect((await middleware(req(`admin.${ROOT}`, "/manage"))).status).toBe(404);
    const api = await middleware(req(`admin.${ROOT}`, "/api/admin/brokers"));
    expect(api.status).not.toBe(404);
  });
});
