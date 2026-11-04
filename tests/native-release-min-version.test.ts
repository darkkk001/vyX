import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Mandatory-update policy (owner 2026-10-29, web-min-version-brief.md): per broker and app, builds below the minimum get 426 UPDATE_REQUIRED.
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/download-feed", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/download-feed")>()),
  readFeedInfo: vi.fn(async (kind: string) => ({ version: kind === "terminal" ? "1.0.102" : "1.0.100", setupPath: "/x", setupFile: "x" })),
}));
const headerBag = new Map<string, string>();
vi.mock("next/headers", () => ({ headers: async () => ({ get: (k: string) => headerBag.get(k.toLowerCase()) ?? null }) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("native-release-min-version.test.ts: DB unreachable, skipping"); }
});
const brokers: string[] = [];
const builds: string[] = [];
const admins: string[] = [];
async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `MinV ${s}`, subdomain: `minv-${s}` } });
  brokers.push(broker.id);
  const sa = await prisma.adminUser.create({ data: { email: `sa-${s}@test.local`, passwordHash: "x", role: "SUPER_ADMIN" } });
  admins.push(sa.id);
  return { s, broker, sa };
}
afterAll(async () => {
  if (!dbReachable) return;
  const { getRedis } = await import("@/lib/redis");
  for (const b of builds) { await getRedis().del(`client_build:${b}`); await getRedis().srem("client_builds:index", b); }
  await prisma.clientBuild.deleteMany({ where: { buildId: { in: builds } } });
  await prisma.brokerAppMinVersion.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: admins } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

const confirm = (v: string) => `Clients below v${v} must update before they can trade.`;
async function put(sa: { id: string }, brokerId: string, body: unknown) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: sa.id, brokerId: null, role: "SUPER_ADMIN" } as never);
  const { PUT } = await import("@/app/api/admin/brokers/[id]/min-version/route");
  const res = await PUT(new NextRequest("https://test.local/x", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: brokerId }) });
  return { status: res.status, body: await res.json() };
}
async function register(brokerId: string, slug: string, app: "terminal" | "backoffice", version: string) {
  const { registerClientBuild } = await import("@/lib/client-builds");
  const buildId = `${slug}-${app}-${version}-${randomUUID().slice(0, 8)}`;
  builds.push(buildId);
  await registerClientBuild({ buildId, brokerId, brokerSubdomain: slug, app, version, note: "" });
  return buildId;
}
async function verdict(brokerId: string, slug: string, buildId: string) {
  headerBag.clear();
  headerBag.set("x-client-platform", "DESKTOP_NATIVE");
  headerBag.set("x-client-build", buildId);
  const { checkClientBuild } = await import("@/lib/client-builds");
  return checkClientBuild(brokerId, slug);
}

describe("minimum version", () => {
  it("below is refused with the versions, equal and above pass, the other app is untouched, and removing it releases the build", async () => {
    if (!dbReachable) return;
    const { broker, sa } = await fixture();
    const old = await register(broker.id, broker.subdomain, "terminal", "1.0.100");
    const same = await register(broker.id, broker.subdomain, "terminal", "1.0.101");
    const bo = await register(broker.id, broker.subdomain, "backoffice", "1.0.98");
    expect((await put(sa, broker.id, { app: "terminal", minVersion: "1.0.101", reason: "crash fix", confirm: confirm("1.0.101") })).status).toBe(200);
    expect(await verdict(broker.id, broker.subdomain, old)).toEqual({ ok: false, reason: "update-required", buildId: old, minVersion: "1.0.101", latestVersion: "1.0.102" });
    expect((await verdict(broker.id, broker.subdomain, same)).ok).toBe(true);
    expect((await verdict(broker.id, broker.subdomain, bo)).ok).toBe(true);
    const newer = await register(broker.id, broker.subdomain, "terminal", "1.0.102");
    expect((await verdict(broker.id, broker.subdomain, newer)).ok).toBe(true);
    expect((await put(sa, broker.id, { app: "terminal", minVersion: null })).status).toBe(200);
    expect((await verdict(broker.id, broker.subdomain, old)).ok).toBe(true);
    expect(await prisma.auditLog.count({ where: { brokerId: broker.id, action: "MIN_VERSION_SET" } })).toBe(2);
  });

  it("a minimum above the latest published version, a bad version or a wrong confirmation is refused", async () => {
    if (!dbReachable) return;
    const { broker, sa } = await fixture();
    expect((await put(sa, broker.id, { app: "terminal", minVersion: "1.0.103", confirm: confirm("1.0.103") })).status).toBe(409);
    expect((await put(sa, broker.id, { app: "terminal", minVersion: "latest" })).status).toBe(400);
    expect((await put(sa, broker.id, { app: "terminal", minVersion: "1.0.101", confirm: "yes" })).status).toBe(400);
    expect(await prisma.brokerAppMinVersion.count({ where: { brokerId: broker.id } })).toBe(0);
  });

  it("another broker's builds are never affected", async () => {
    if (!dbReachable) return;
    const a = await fixture();
    const b = await fixture();
    const other = await register(b.broker.id, b.broker.subdomain, "terminal", "1.0.90");
    await put(a.sa, a.broker.id, { app: "terminal", minVersion: "1.0.101", confirm: confirm("1.0.101") });
    expect((await verdict(b.broker.id, b.broker.subdomain, other)).ok).toBe(true);
  });

  it("the update-required route answers 426 with the shape the apps read", async () => {
    const { GET, POST } = await import("@/app/api/client/update-required/route");
    for (const h of [GET, POST]) {
      const r = await h(new NextRequest("https://test.local/api/client/update-required?min=1.0.101&latest=1.0.102"));
      expect(r.status).toBe(426);
      expect(await r.json()).toEqual({ error: "UPDATE_REQUIRED", minVersion: "1.0.101", latestVersion: "1.0.102" });
    }
  });
});
