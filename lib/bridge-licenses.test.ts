import "dotenv/config";
import { createHmac, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// QoreBridge license + kill switch + CONNECTED badge, web side (owner 2026-10-23). Real routes, scratch DB, test Redis,
// a throwaway signing key (the real one is CLIENT_MANIFEST_PRIVATE_KEY).
vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const saved: Record<string, string | undefined> = {};
let ready = false;
const brokers: string[] = [];
const builds: string[] = [];
let superAdminId = "";
beforeAll(async () => {
  for (const k of ["CLIENT_MANIFEST_PRIVATE_KEY", "BRIDGE_REPORT_SECRET"]) saved[k] = process.env[k];
  process.env.CLIENT_MANIFEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.BRIDGE_REPORT_SECRET = "report-secret-for-tests";
  try {
    await prisma.$queryRaw`SELECT 1 FROM "ClientBuild" LIMIT 1`;
    await getRedis().ping();
    // the audit row names a real actor
    superAdminId = (await prisma.adminUser.create({ data: { email: `bl-sa-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "SUPER_ADMIN", status: "ACTIVE" } })).id;
    ready = true;
  } catch {
    console.warn("lib/bridge-licenses.test.ts: DB or Redis unreachable, skipping");
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) (v === undefined ? delete process.env[k] : (process.env[k] = v));
  if (ready) {
    const r = getRedis();
    for (const id of builds) await r.del(`client_build:${id}`);
    if (builds.length) await r.srem("client_builds:index", ...builds);
    await prisma.clientBuild.deleteMany({ where: { buildId: { in: builds } } });
    for (const b of brokers) await r.del(`bridge-status:${b}`, `bridge-status-since:${b}`);
    await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
    await prisma.adminUser.deleteMany({ where: { id: superAdminId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const MACHINE = "a".repeat(64);
async function asRole(role: string | null) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(role ? ({ adminId: superAdminId, role, brokerId: role === "SUPER_ADMIN" ? null : brokers[0] ?? null } as never) : null);
}
async function broker() {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `BL ${s}`, subdomain: `bl-${s}` } });
  brokers.push(b.id);
  return b;
}
async function issue(slug: string, body: Record<string, unknown> = {}) {
  await asRole("SUPER_ADMIN");
  const { POST } = await import("@/app/api/admin/bridge-licenses/route");
  const res = await POST(new NextRequest("https://t/api/admin/bridge-licenses", { method: "POST", body: JSON.stringify({ brokerSlug: slug, machineId: MACHINE, features: ["hedge"], ...body }) }));
  const json = await res.json();
  if (res.status === 201) builds.push(json.licenseId);
  return { status: res.status, json };
}
async function manifest(slug: string, buildId: string, extra = "") {
  const { GET } = await import("@/app/api/client/manifest/route");
  const res = await GET(new NextRequest(`https://t/api/client/manifest?slug=${slug}&app=bridge&buildId=${buildId}${extra}`, { headers: { "x-forwarded-for": `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } }));
  const j = await res.json();
  return JSON.parse(Buffer.from(j.manifest, "base64").toString("utf8")) as { status: string; app: string; buildId: string };
}

describe("issuing a license", () => {
  it("only Super Admin; a signed file for this broker, server and features, registered as a bridge build", async () => {
    if (!ready) return;
    const b = await broker();
    await asRole("BROKER_ADMIN");
    const { POST } = await import("@/app/api/admin/bridge-licenses/route");
    expect((await POST(new NextRequest("https://t/x", { method: "POST", body: "{}" }))).status).toBe(403);

    const r = await issue(b.subdomain, { features: ["hedge", "feed"], expiresDays: 30 });
    expect(r.status).toBe(201);
    const file = JSON.parse(r.json.file) as { payload: string; signature: string };
    const payloadBytes = Buffer.from(file.payload, "base64");
    const v = createVerify("SHA256");
    v.update(payloadBytes);
    expect(v.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(file.signature, "base64"))).toBe(true);
    const p = JSON.parse(payloadBytes.toString("utf8"));
    expect(p).toMatchObject({ kind: "qorebridge-license", licenseId: r.json.licenseId, brokerId: b.id, brokerSlug: b.subdomain, machineId: MACHINE, features: ["hedge", "feed"] });
    expect(p.expiresAt - p.issuedAt).toBe(30 * 86_400);
    expect(p.reportKey).toBe(createHmac("sha256", "report-secret-for-tests").update(`bridge-report:${r.json.licenseId}`).digest("base64"));
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: r.json.licenseId } });
    expect([row.app, row.status, row.brokerId]).toEqual(["bridge", "ACTIVE", b.id]);
  });

  it("refuses a bad machine id, an unknown feature, an unknown broker", async () => {
    if (!ready) return;
    const b = await broker();
    expect((await issue(b.subdomain, { machineId: "abc" })).status).toBe(400);
    expect((await issue(b.subdomain, { features: ["hedge", "mint"] })).status).toBe(400);
    expect((await issue("no-such-broker-xyz")).status).toBe(404);
  });
});

describe("the kill switch: /api/client/manifest?app=bridge", () => {
  it("ACTIVE, then REVOKED after Super Admin revokes; another broker's slug or a native build id is UNKNOWN", async () => {
    if (!ready) return;
    const b = await broker();
    const other = await broker();
    const { json } = await issue(b.subdomain);
    expect(await manifest(b.subdomain, json.licenseId)).toMatchObject({ status: "ACTIVE", app: "bridge", buildId: json.licenseId });
    expect((await manifest(other.subdomain, json.licenseId)).status).toBe("UNKNOWN");

    await asRole("SUPER_ADMIN");
    const { PATCH } = await import("@/app/api/admin/client-builds/route");
    expect((await PATCH(new NextRequest("https://t/x", { method: "PATCH", body: JSON.stringify({ buildId: json.licenseId, status: "REVOKED" }) }))).status).toBe(200);
    expect((await manifest(b.subdomain, json.licenseId)).status).toBe("REVOKED");

    // a terminal build asked for as a bridge, and a bridge license asked for as a terminal: both UNKNOWN
    const { registerClientBuild } = await import("@/lib/client-builds");
    const term = `bl-term-${randomUUID().slice(0, 6)}`;
    builds.push(term);
    await registerClientBuild({ buildId: term, brokerId: b.id, brokerSubdomain: b.subdomain, app: "terminal", version: "1.0.0", note: "" });
    expect((await manifest(b.subdomain, term)).status).toBe("UNKNOWN");
    const { GET } = await import("@/app/api/client/manifest/route");
    const asTerminal = await (await GET(new NextRequest(`https://t/api/client/manifest?slug=${b.subdomain}&app=terminal&buildId=${json.licenseId}`, { headers: { "x-forwarded-for": "10.8.0.1" } }))).json();
    expect(JSON.parse(Buffer.from(asTerminal.manifest, "base64").toString("utf8")).status).toBe("UNKNOWN");
  });

  it("a revoked exe build revokes every license running it", async () => {
    if (!ready) return;
    const b = await broker();
    const { json } = await issue(b.subdomain);
    const { registerClientBuild, setClientBuildStatus } = await import("@/lib/client-builds");
    const exe = `qb-exe-${randomUUID().slice(0, 6)}`;
    builds.push(exe);
    await registerClientBuild({ buildId: exe, brokerId: b.id, brokerSubdomain: b.subdomain, app: "bridge", version: "exe", note: "" });
    expect((await manifest(b.subdomain, json.licenseId, `&exeBuild=${exe}`)).status).toBe("ACTIVE");
    await setClientBuildStatus(exe, "REVOKED");
    expect((await manifest(b.subdomain, json.licenseId, `&exeBuild=${exe}`)).status).toBe("REVOKED");
  });
});

describe("the CONNECTED badge", () => {
  const report = async (licenseId: string, body: Record<string, unknown>, key?: Buffer) => {
    const raw = JSON.stringify(body);
    const k = key ?? createHmac("sha256", "report-secret-for-tests").update(`bridge-report:${licenseId}`).digest();
    const sig = createHmac("sha256", k).update(raw).digest("hex");
    const { POST } = await import("@/app/api/internal/bridge-status/route");
    return POST(new NextRequest("https://t/api/internal/bridge-status", { method: "POST", headers: { "x-bridge-license": licenseId, "x-bridge-signature": sig }, body: raw }));
  };
  const status = async (brokerId: string) => {
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "m1", role: "MANAGER", brokerId } as never);
    const { GET } = await import("@/app/api/manage/liquidity/status/route");
    return (await GET()).json();
  };

  it("no report: Not connected; a healthy report: Connected; an LP down: Degraded; a revoke silences it", async () => {
    if (!ready) return;
    const b = await broker();
    const { json } = await issue(b.subdomain);
    expect((await status(b.id)).badge).toBe("NOT_CONNECTED");
    const ok = await report(json.licenseId, { lps: [{ id: "lp1", status: "Ready" }], intake: "ok", feed: "off" });
    expect(ok.status).toBe(200);
    const s1 = await status(b.id);
    expect(s1).toMatchObject({ badge: "CONNECTED", text: "Connected" });
    expect(JSON.stringify(s1)).not.toContain("lp1"); // plain words only, no LP names
    await report(json.licenseId, { lps: [{ id: "lp1", status: "Ready" }, { id: "lp2", status: "Reconnecting" }], intake: "ok" });
    expect((await status(b.id)).badge).toBe("DEGRADED");

    const { setClientBuildStatus } = await import("@/lib/client-builds");
    await setClientBuildStatus(json.licenseId, "REVOKED");
    expect((await report(json.licenseId, { lps: [{ id: "lp1", status: "Ready" }], intake: "ok" })).status).toBe(403);
  });

  it("a report signed with the wrong key, or for another license, is refused and changes nothing", async () => {
    if (!ready) return;
    const b = await broker();
    const { json } = await issue(b.subdomain);
    expect((await report(json.licenseId, { lps: [{ status: "Ready" }], intake: "ok" }, Buffer.from("wrong"))).status).toBe(403);
    expect((await report("not-a-license", { lps: [{ status: "Ready" }], intake: "ok" })).status).toBe(403);
    expect((await status(b.id)).badge).toBe("NOT_CONNECTED");
  });

  it("a bridge that stops reporting turns Not connected after 45 s", async () => {
    if (!ready) return;
    const b = await broker();
    const { json } = await issue(b.subdomain);
    await report(json.licenseId, { lps: [{ status: "Ready" }], intake: "ok" });
    const { bridgeStatus } = await import("@/lib/bridge-status");
    expect((await bridgeStatus(b.id, Date.now() + 30_000)).badge).toBe("CONNECTED");
    const later = await bridgeStatus(b.id, Date.now() + 50_000);
    expect(later.badge).toBe("NOT_CONNECTED");
    expect(later.lastReportAt).not.toBeNull();
  });
});
