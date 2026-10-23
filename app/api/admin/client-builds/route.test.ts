// Security re-audit 2026-10-23: the native-build registry (kill switch). Only a SUPER_ADMIN session or the build
// machine's x-registry-secret may read, register, revoke / reinstate or backfill. No session, a broker's own staff,
// and any wrong secret are refused before the registry is touched.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth", () => ({ getAdminSession: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/prisma", () => ({ prisma: { broker: { findUnique: vi.fn().mockResolvedValue({ id: "b1", subdomain: "acme" }) } } }));
vi.mock("@/lib/client-builds", () => ({
  listClientBuilds: vi.fn().mockResolvedValue([]),
  getClientBuild: vi.fn().mockResolvedValue(null),
  registerClientBuild: vi.fn(async (r: object) => ({ ...r, status: "ACTIVE" })),
  setClientBuildStatus: vi.fn(async (buildId: string, status: string) => ({ buildId, status })),
  backfillClientBuildsToPostgres: vi.fn().mockResolvedValue(0),
}));

const KEY = "CLIENT_BUILD_REGISTRY_SECRET";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[KEY];
  process.env[KEY] = "registry-secret-value";
});
afterEach(() => {
  if (saved === undefined) delete process.env[KEY];
  else process.env[KEY] = saved;
  vi.clearAllMocks();
});

const BODIES: Record<"GET" | "POST" | "PATCH" | "PUT", object | undefined> = {
  GET: undefined,
  POST: { buildId: "acme-terminal-1.0.99-abc", slug: "acme", app: "terminal", version: "1.0.99" },
  PATCH: { buildId: "acme-terminal-1.0.99-abc", status: "ACTIVE" },
  PUT: undefined,
};
async function call(method: "GET" | "POST" | "PATCH" | "PUT", headers: Record<string, string> = {}) {
  const mod = await import("./route");
  const body = BODIES[method];
  const req = new NextRequest("https://t.local/api/admin/client-builds", { method, headers: { "content-type": "application/json", ...headers }, body: body ? JSON.stringify(body) : undefined });
  return (mod[method] as (r: NextRequest) => Promise<Response>)(req);
}
async function registryTouched() {
  const cb = await import("@/lib/client-builds");
  return [cb.listClientBuilds, cb.registerClientBuild, cb.setClientBuildStatus, cb.backfillClientBuildsToPostgres].some((f) => vi.mocked(f).mock.calls.length > 0);
}
const asSession = async (role: string | null) => {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(role ? ({ adminId: "a1", role, brokerId: role === "SUPER_ADMIN" ? null : "b1" } as never) : null);
};

describe("admin/client-builds: who may use the kill switch", () => {
  it("no session and no secret: every method 403, registry untouched", async () => {
    await asSession(null);
    for (const m of Object.keys(BODIES) as (keyof typeof BODIES)[]) expect((await call(m)).status, m).toBe(403);
    expect(await registryTouched()).toBe(false);
  });

  it("a broker's own staff (BROKER_ADMIN, MANAGER, SUPPORT): 403, cannot reinstate a revoked build", async () => {
    for (const role of ["BROKER_ADMIN", "MANAGER", "SUPPORT"]) {
      await asSession(role);
      for (const m of Object.keys(BODIES) as (keyof typeof BODIES)[]) expect((await call(m)).status, `${role} ${m}`).toBe(403);
    }
    expect(await registryTouched()).toBe(false);
  });

  it("wrong secrets: empty, wrong, same length, prefix, longer -> 403", async () => {
    await asSession(null);
    for (const s of ["", "nope", "registry-secret-valuX", "registry-secret", "registry-secret-value-and-more"]) {
      expect((await call("PATCH", { "x-registry-secret": s })).status, JSON.stringify(s)).toBe(403);
    }
    expect(await registryTouched()).toBe(false);
  });

  it("no secret configured: even an empty header is refused", async () => {
    delete process.env[KEY];
    await asSession(null);
    expect((await call("GET", { "x-registry-secret": "" })).status).toBe(403);
  });

  it("the build machine's secret (a trailing newline tolerated) and a SUPER_ADMIN session are accepted", async () => {
    await asSession(null);
    expect((await call("GET", { "x-registry-secret": "registry-secret-value" })).status).toBe(200);
    expect((await call("POST", { "x-registry-secret": "registry-secret-value\n" })).status).toBe(201);
    await asSession("SUPER_ADMIN");
    expect((await call("PATCH")).status).toBe(200);
  });

  it("the secret compare is the hashed constant-time one: no length check that tells the secret's length", () => {
    const src = readFileSync(join(__dirname, "route.ts"), "utf8");
    expect(src).toContain("secretMatches(provided, secret)");
    expect(src).not.toMatch(/provided\.length === secret\.length/);
  });
});
