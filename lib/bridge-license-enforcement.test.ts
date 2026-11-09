import "dotenv/config";
import { createHmac, createVerify, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// License enforcement Phase 1.2, web side (2026-11-09; contract C:\vyx\handoff\license-enforcement-contract.md).
// Real routes, scratch DB, test Redis, a throwaway signing key. Every status x reason on the three route families
// (manifest, config + version, bridge-status), the signed verdict verified with the public key, Super Admin's
// suspend / resume / revoke (auth, reason, permanence, audit + FEED rows, nudge), one server per license, and the
// suspend -> report refused -> resume -> report accepted round trip.
vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishBridgeLicenseChanged: vi.fn().mockResolvedValue(undefined) }));
// checkClientBuild reads the request headers through next/headers
const hctx = { headers: new Headers() };
vi.mock("next/headers", () => ({ headers: async () => hctx.headers, cookies: async () => ({ get: () => undefined }) }));

const SECRET = "report-secret-for-tests";
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const saved: Record<string, string | undefined> = {};
let ready = false;
const brokers: string[] = [];
const builds: string[] = [];
let superAdminId = "";
let superAdminEmail = "";

beforeAll(async () => {
  for (const k of ["CLIENT_MANIFEST_PRIVATE_KEY", "BRIDGE_REPORT_SECRET"]) saved[k] = process.env[k];
  process.env.CLIENT_MANIFEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.BRIDGE_REPORT_SECRET = SECRET;
  try {
    await prisma.$queryRaw`SELECT "suspendReason", "boundMachineId" FROM "ClientBuild" LIMIT 1`;
    await getRedis().ping();
    superAdminEmail = `ble-sa-${randomUUID().slice(0, 8)}@test.local`;
    superAdminId = (await prisma.adminUser.create({ data: { email: superAdminEmail, passwordHash: "x", role: "SUPER_ADMIN", status: "ACTIVE" } })).id;
    ready = true;
  } catch {
    console.warn("lib/bridge-license-enforcement.test.ts: DB (with the 1.2 columns) or Redis unreachable, skipping");
  }
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (ready) {
    const r = getRedis();
    for (const id of builds) await r.del(`client_build:${id}`);
    if (builds.length) await r.srem("client_builds:index", ...builds);
    for (const b of brokers) await r.del(`bridge-status:${b}`, `bridge-status-since:${b}`);
    await prisma.clientBuild.deleteMany({ where: { buildId: { in: builds } } });
    await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
    await prisma.adminUser.deleteMany({ where: { id: superAdminId } }).catch(() => {});
  }
  await prisma.$disconnect();
});
beforeEach(async () => {
  const nats = await import("@/lib/nats");
  vi.mocked(nats.publishBridgeLicenseChanged).mockClear();
});

const MACHINE = "a1".repeat(32);
const OTHER = "b2".repeat(32);
const THIRD = "c3".repeat(32);
const reportKey = (licenseId: string) => createHmac("sha256", SECRET).update(`bridge-report:${licenseId}`).digest();

async function asRole(role: string | null) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(role ? ({ adminId: superAdminId, role, brokerId: role === "SUPER_ADMIN" ? null : (brokers[0] ?? null) } as never) : null);
}
async function broker() {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `BLE ${s}`, subdomain: `ble-${s}` } });
  brokers.push(b.id);
  return b;
}
/** A license through the real issue path (columns + audit row + Redis record). */
async function issued(slug: string, o: { machineId?: string; features?: string[]; expiresDays?: number } = {}) {
  const { issueBridgeLicense } = await import("@/lib/bridge-licenses");
  const r = await issueBridgeLicense({ brokerSlug: slug, machineId: o.machineId ?? MACHINE, features: o.features ?? ["hedge"], expiresDays: o.expiresDays ?? 365, adminId: superAdminId });
  builds.push(r.licenseId);
  return r.licenseId;
}
/** A license issued before 2026-11-03: no machine hash stored (binds to its first reporter). */
async function legacyLicense(b: { id: string; subdomain: string }) {
  const { registerClientBuild } = await import("@/lib/client-builds");
  const id = `${b.subdomain}-bridge-legacy-${randomUUID().slice(0, 6)}`;
  builds.push(id);
  await registerClientBuild({ buildId: id, brokerId: b.id, brokerSubdomain: b.subdomain, app: "bridge", version: "license", note: "" }, { expiresAt: new Date(Date.now() + 100 * 86_400_000), features: ["hedge"] });
  return id;
}
async function exeBuild(b: { id: string; subdomain: string }, revoked: boolean) {
  const { registerClientBuild, setClientBuildStatus } = await import("@/lib/client-builds");
  const id = `qorebridge-0.2.0-${randomUUID().slice(0, 6)}`;
  builds.push(id);
  await registerClientBuild({ buildId: id, brokerId: b.id, brokerSubdomain: b.subdomain, app: "bridge", version: "exe", note: "" });
  if (revoked) await setClientBuildStatus(id, "REVOKED");
  return id;
}

type Verdict = { slug: string; apiHost: string; app: string; buildId: string; status: string; reason: string; suspendReason?: string; minVersion: string; iat: number; exp: number };
/** Verifies a signed verdict with the public key (as the bridge does with its compiled-in key) and returns its payload. */
function verified(v: { manifest: string; signature: string; keyId: string }): Verdict {
  expect(typeof v.keyId).toBe("string");
  const bytes = Buffer.from(v.manifest, "base64");
  const ver = createVerify("SHA256");
  ver.update(bytes);
  expect(ver.verify({ key: publicKey, dsaEncoding: "ieee-p1363" }, Buffer.from(v.signature, "base64"))).toBe(true);
  return JSON.parse(bytes.toString("utf8")) as Verdict;
}

async function manifest(slug: string, licenseId: string, extra = "") {
  const { GET } = await import("@/app/api/client/manifest/route");
  const res = await GET(new NextRequest(`https://t/api/client/manifest?slug=${slug}&app=bridge&buildId=${licenseId}${extra}`, { headers: { "x-forwarded-for": `10.7.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` } }));
  expect(res.status).toBe(200);
  return verified(await res.json());
}

async function report(licenseId: string, extra: Record<string, unknown> = { machine: MACHINE }, key?: Buffer) {
  const raw = JSON.stringify({ lps: [{ id: "lp1", status: "Ready" }], intake: "ok", feed: "off", ...extra });
  const sig = createHmac("sha256", key ?? reportKey(licenseId)).update(raw).digest("hex");
  const { POST } = await import("@/app/api/internal/bridge-status/route");
  const res = await POST(new NextRequest("https://t/api/internal/bridge-status", { method: "POST", headers: { "x-bridge-license": licenseId, "x-bridge-signature": sig }, body: raw }));
  return { status: res.status, json: await res.json() };
}

type Get = { path?: "/api/bridge/config" | "/api/bridge/config/version"; licenseId: string; brokerId: string | null; machine?: string; build?: string; signWith?: string };
async function configGet(r: Get) {
  const path = r.path ?? "/api/bridge/config";
  const time = String(Math.floor(Date.now() / 1000));
  const nonce = randomUUID().replace(/-/g, "");
  const machine = r.machine ?? MACHINE;
  const build = r.build ?? "dev";
  const sig = createHmac("sha256", reportKey(r.signWith ?? r.licenseId)).update(`GET\n${path}\n${time}\n${nonce}\n${r.licenseId}\n${machine}\n${build}`).digest("hex");
  const h: Record<string, string> = { "x-bridge-license": r.licenseId, "x-bridge-time": time, "x-bridge-nonce": nonce, "x-bridge-machine": machine, "x-bridge-build": build, "x-bridge-signature": sig };
  if (r.brokerId) h["x-broker-id"] = r.brokerId;
  const mod = path.endsWith("/version") ? await import("@/app/api/bridge/config/version/route") : await import("@/app/api/bridge/config/route");
  const res = await mod.GET(new NextRequest(`https://ble.test.local${path}`, { headers: h }));
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function act(licenseId: string, action: string, reason?: unknown, role: string | null = "SUPER_ADMIN") {
  await asRole(role);
  const { POST } = await import("@/app/api/admin/bridge-licenses/[licenseId]/route");
  const res = await POST(new NextRequest(`https://t/api/admin/bridge-licenses/${licenseId}`, { method: "POST", body: JSON.stringify({ action, reason }) }), { params: Promise.resolve({ licenseId }) });
  return { status: res.status, json: await res.json() };
}
async function list() {
  await asRole("SUPER_ADMIN");
  const { GET } = await import("@/app/api/admin/bridge-licenses/route");
  return (await (await GET()).json()) as Record<string, unknown>[];
}
async function feed(brokerId: string) {
  const { getDealerActivityFeedRows } = await import("@/lib/dealer-activity");
  return getDealerActivityFeedRows(brokerId, { dealingOnly: true });
}
const suspend = (id: string, reason = "Invoice 1042 is overdue") => act(id, "suspend", reason);

// ---------------------------------------------------------------------------------------------------------------
describe("GET /api/client/manifest?app=bridge: the signed verdict for every status", () => {
  it("ACTIVE, SUSPENDED (with the reason typed), REVOKED, EXPIRED, UNKNOWN; all verifiable with the public key", async () => {
    if (!ready) return;
    const b = await broker();
    const other = await broker();
    const id = await issued(b.subdomain);
    expect(await manifest(b.subdomain, id)).toMatchObject({ slug: b.subdomain, app: "bridge", buildId: id, status: "ACTIVE", reason: "" });
    expect((await manifest(b.subdomain, id)).suspendReason).toBeUndefined();

    expect((await suspend(id, "Unpaid invoice")).status).toBe(200);
    expect(await manifest(b.subdomain, id)).toMatchObject({ status: "SUSPENDED", reason: "suspended", suspendReason: "Unpaid invoice" });

    expect((await act(id, "revoke", "Contract ended")).status).toBe(200);
    const revoked = await manifest(b.subdomain, id);
    expect(revoked).toMatchObject({ status: "REVOKED", reason: "revoked" });
    expect(revoked.suspendReason).toBeUndefined();

    const exp = await issued(b.subdomain);
    await prisma.clientBuild.update({ where: { buildId: exp }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await manifest(b.subdomain, exp)).toMatchObject({ status: "EXPIRED", reason: "expired" });

    // another broker's slug, and an id that is no license at all
    expect(await manifest(other.subdomain, exp)).toMatchObject({ status: "UNKNOWN", reason: "unknown" });
    expect(await manifest(b.subdomain, `${b.subdomain}-bridge-nope`)).toMatchObject({ status: "UNKNOWN", reason: "unknown" });
  });

  it("machine: the license's own machine is ACTIVE, another is REFUSED / machine, a malformed one too; absent = not checked", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect(await manifest(b.subdomain, id, `&machine=${MACHINE}`)).toMatchObject({ status: "ACTIVE", reason: "" });
    expect(await manifest(b.subdomain, id, `&machine=${MACHINE.toUpperCase()}`)).toMatchObject({ status: "ACTIVE" });
    expect(await manifest(b.subdomain, id, `&machine=${OTHER}`)).toMatchObject({ status: "REFUSED", reason: "machine" });
    expect(await manifest(b.subdomain, id, `&machine=xyz`)).toMatchObject({ status: "REFUSED", reason: "machine" });
    expect(await manifest(b.subdomain, id)).toMatchObject({ status: "ACTIVE" }); // an old bridge sends no machine
  });

  it("a revoked exe build: REVOKED / revoked; a suspended license on a revoked exe is REVOKED too", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    const good = await exeBuild(b, false);
    const bad = await exeBuild(b, true);
    expect(await manifest(b.subdomain, id, `&exeBuild=${good}`)).toMatchObject({ status: "ACTIVE" });
    expect(await manifest(b.subdomain, id, `&exeBuild=${bad}`)).toMatchObject({ status: "REVOKED", reason: "revoked" });
    await suspend(id);
    expect(await manifest(b.subdomain, id, `&exeBuild=${bad}`)).toMatchObject({ status: "REVOKED", reason: "revoked" });
  });

  it("precedence: revoked beats expired, expired beats machine and suspended", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    await suspend(id);
    await prisma.clientBuild.update({ where: { buildId: id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect(await manifest(b.subdomain, id, `&machine=${OTHER}`)).toMatchObject({ status: "EXPIRED", reason: "expired" });
    await act(id, "revoke", "gone");
    expect(await manifest(b.subdomain, id, `&machine=${OTHER}`)).toMatchObject({ status: "REVOKED", reason: "revoked" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("GET /api/bridge/config and /version: license field and signed refusals", () => {
  for (const path of ["/api/bridge/config", "/api/bridge/config/version"] as const) {
    it(`${path}: ACTIVE 200 with license ACTIVE; SUSPENDED still 200 with license SUSPENDED`, async () => {
      if (!ready) return;
      const b = await broker();
      const id = await issued(b.subdomain);
      const ok = await configGet({ path, licenseId: id, brokerId: b.id });
      expect(ok.status).toBe(200);
      expect(ok.body.license).toEqual({ status: "ACTIVE", reason: "" });
      expect(typeof ok.body.version).toBe("string");
      await suspend(id);
      const s = await configGet({ path, licenseId: id, brokerId: b.id });
      expect(s.status).toBe(200);
      expect(s.body.license).toEqual({ status: "SUSPENDED", reason: "suspended" });
      expect(s.body.version).toBe(ok.body.version);
    });

    it(`${path}: revoked / expired / machine / build are 403 with the reason and a signed verdict`, async () => {
      if (!ready) return;
      const b = await broker();
      const rev = await issued(b.subdomain);
      await act(rev, "revoke", "Contract ended");
      const r1 = await configGet({ path, licenseId: rev, brokerId: b.id });
      expect([r1.status, r1.body.error, r1.body.reason]).toEqual([403, "forbidden", "revoked"]);
      expect(verified(r1.body.license)).toMatchObject({ status: "REVOKED", reason: "revoked", buildId: rev, slug: b.subdomain, app: "bridge" });
      expect(r1.body.version).toBeUndefined();

      const exp = await issued(b.subdomain);
      await prisma.clientBuild.update({ where: { buildId: exp }, data: { expiresAt: new Date(Date.now() - 1000) } });
      const r2 = await configGet({ path, licenseId: exp, brokerId: b.id });
      expect([r2.status, r2.body.reason]).toEqual([403, "expired"]);
      expect(verified(r2.body.license)).toMatchObject({ status: "EXPIRED", reason: "expired", buildId: exp });

      const m = await issued(b.subdomain);
      const r3 = await configGet({ path, licenseId: m, brokerId: b.id, machine: OTHER });
      expect([r3.status, r3.body.reason]).toEqual([403, "machine"]);
      expect(verified(r3.body.license)).toMatchObject({ status: "REFUSED", reason: "machine", buildId: m });

      const exe = await exeBuild(b, true);
      const r4 = await configGet({ path, licenseId: m, brokerId: b.id, build: exe });
      expect([r4.status, r4.body.reason]).toEqual([403, "build"]);
      expect(verified(r4.body.license)).toMatchObject({ status: "REVOKED", reason: "revoked", buildId: m });
    });

    it(`${path}: auth refusals (signature, broker, not a hedge license) carry NO verdict`, async () => {
      if (!ready) return;
      const b = await broker();
      const other = await broker();
      const id = await issued(b.subdomain);
      const sig = await configGet({ path, licenseId: id, brokerId: b.id, signWith: "someone-else" });
      expect([sig.status, sig.body.reason, sig.body.license]).toEqual([403, "signature", undefined]);
      const wrongHost = await configGet({ path, licenseId: id, brokerId: other.id });
      expect([wrongHost.status, wrongHost.body.reason, wrongHost.body.license]).toEqual([403, "broker", undefined]);
      // a revoked license on another broker's host: refused `broker`, its verdict never handed out there
      await act(id, "revoke", "x");
      expect((await configGet({ path, licenseId: id, brokerId: other.id })).body).toEqual({ error: "forbidden", reason: "broker" });
      const feedOnly = await issued(b.subdomain, { features: ["feed"] });
      expect((await configGet({ path, licenseId: feedOnly, brokerId: b.id })).body).toEqual({ error: "forbidden", reason: "license" });
      expect((await configGet({ path, licenseId: `${b.subdomain}-bridge-ghost`, brokerId: b.id })).body).toEqual({ error: "forbidden", reason: "license" });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
describe("POST /api/internal/bridge-status: verdicts on the 15 s report", () => {
  it("ACTIVE: 200 with license ACTIVE, and the online status is stored (time + machine)", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    const r = await report(id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true, badge: "CONNECTED", license: { status: "ACTIVE", reason: "" } });
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect(row.lastReportMachine).toBe(MACHINE);
    expect(Date.now() - row.lastReportAt!.getTime()).toBeLessThan(10_000);
    const shown = (await list()).find((x) => x.buildId === id)!;
    expect(shown.online).toMatchObject({ online: true, machine: `${MACHINE.slice(0, 8)}...` });
  });

  it("SUSPENDED / REVOKED / expired / machine: 403 with the reason and a signed verdict", async () => {
    if (!ready) return;
    const b = await broker();
    const s = await issued(b.subdomain);
    await suspend(s, "Pay invoice 7");
    const r1 = await report(s);
    expect([r1.status, r1.json.error, r1.json.reason]).toEqual([403, "forbidden", "suspended"]);
    expect(verified(r1.json.license)).toMatchObject({ status: "SUSPENDED", reason: "suspended", suspendReason: "Pay invoice 7", buildId: s, slug: b.subdomain });
    // a suspended bridge still reports: the platform still sees it online
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: s } })).lastReportAt).not.toBeNull();

    const rv = await issued(b.subdomain);
    await act(rv, "revoke", "Ended");
    const r2 = await report(rv);
    expect([r2.status, r2.json.reason]).toEqual([403, "revoked"]);
    expect(verified(r2.json.license)).toMatchObject({ status: "REVOKED", reason: "revoked" });

    const ex = await issued(b.subdomain);
    await prisma.clientBuild.update({ where: { buildId: ex }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const r3 = await report(ex);
    expect([r3.status, r3.json.reason]).toEqual([403, "expired"]);
    expect(verified(r3.json.license)).toMatchObject({ status: "EXPIRED", reason: "expired" });

    const m = await issued(b.subdomain);
    const r4 = await report(m, { machine: OTHER });
    expect([r4.status, r4.json.reason]).toEqual([403, "machine"]);
    expect(verified(r4.json.license)).toMatchObject({ status: "REFUSED", reason: "machine" });
    const r5 = await report(m, { machine: 42 });
    expect([r5.status, r5.json.reason]).toEqual([403, "machine"]);
  });

  it("unsigned, wrongly signed and unknown reports stay a bare 403 (no verdict); an old bridge without machine is accepted", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    const bad = await report(id, { machine: MACHINE }, Buffer.from("wrong"));
    expect([bad.status, bad.json]).toEqual([403, { error: "forbidden" }]);
    const { POST } = await import("@/app/api/internal/bridge-status/route");
    const unsigned = await POST(new NextRequest("https://t/api/internal/bridge-status", { method: "POST", headers: { "x-bridge-license": id }, body: "{}" }));
    expect([unsigned.status, await unsigned.json()]).toEqual([403, { error: "forbidden" }]);
    const ghost = await report(`${b.subdomain}-bridge-ghost`);
    expect([ghost.status, ghost.json]).toEqual([403, { error: "forbidden" }]);
    // a revoked license whose report is signed with the wrong key: still bare (nothing proven)
    await act(id, "revoke", "x");
    expect((await report(id, { machine: MACHINE }, Buffer.from("wrong"))).json).toEqual({ error: "forbidden" });

    const old = await issued(b.subdomain);
    const r = await report(old, {});
    expect(r.status).toBe(200);
    expect(r.json.license).toEqual({ status: "ACTIVE", reason: "" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("Super Admin: suspend / resume / revoke", () => {
  it("Super Admin only", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect((await act(id, "suspend", "x", "BROKER_ADMIN")).status).toBe(403);
    expect((await act(id, "suspend", "x", "MANAGER")).status).toBe(403);
    expect((await act(id, "suspend", "x", null)).status).toBe(403);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).status).toBe("ACTIVE");
  });

  it("suspend needs a reason of at most 200 characters; an unknown action or license is refused", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect((await act(id, "suspend", "")).status).toBe(400);
    expect((await act(id, "suspend", "   ")).status).toBe(400);
    expect((await act(id, "suspend")).status).toBe(400);
    expect((await act(id, "suspend", 5)).status).toBe(400);
    expect((await act(id, "suspend", "x".repeat(201))).status).toBe(400);
    expect((await act(id, "revoke", "")).status).toBe(400);
    expect((await act(id, "pause", "x")).status).toBe(400);
    expect((await act(`${b.subdomain}-bridge-ghost`, "suspend", "x")).status).toBe(404);
    // the exe build is not a license
    expect((await act(await exeBuild(b, false), "suspend", "x")).status).toBe(404);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).status).toBe("ACTIVE");
    expect((await act(id, "suspend", "y".repeat(200))).status).toBe(200);
  });

  it("suspend: SUSPENDED with reason / who / when, an audit row, a FEED entry for that broker, the nudge", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    const r = await suspend(id, "Invoice 1042 is overdue");
    expect(r).toMatchObject({ status: 200, json: { licenseId: id, status: "SUSPENDED" } });
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect([row.status, row.suspendReason, row.suspendedBy]).toEqual(["SUSPENDED", "Invoice 1042 is overdue", superAdminId]);
    expect(row.suspendedAt).not.toBeNull();
    // the Redis record (the registry) follows
    const { getClientBuild } = await import("@/lib/client-builds");
    expect((await getClientBuild(id))?.status).toBe("SUSPENDED");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "BRIDGE_LICENSE_SUSPENDED", entityId: id } });
    expect([audit.actorAdminId, audit.brokerId]).toEqual([superAdminId, b.id]);
    expect(audit.newValue).toMatchObject({ status: "SUSPENDED", reason: "Invoice 1042 is overdue" });
    expect(audit.oldValue).toMatchObject({ status: "ACTIVE" });
    const f = (await feed(b.id)).find((x) => x.action === "LICENSE_SUSPENDED");
    expect(f?.values.text).toContain("Invoice 1042 is overdue");
    expect(f?.values.text).not.toMatch(/[\u2013\u2014]/);
    const { publishBridgeLicenseChanged } = await import("@/lib/nats");
    expect(publishBridgeLicenseChanged).toHaveBeenCalledWith(b.id, id, "SUSPENDED");
    const shown = (await list()).find((x) => x.buildId === id)!;
    expect(shown).toMatchObject({ status: "SUSPENDED", suspendReason: "Invoice 1042 is overdue", suspendedBy: superAdminEmail, features: ["hedge"] });
    expect(shown.suspendedAt).toBeTruthy();
    // a second suspend is a conflict, not a second audit row
    expect((await suspend(id)).status).toBe(409);
    expect(await prisma.auditLog.count({ where: { action: "BRIDGE_LICENSE_SUSPENDED", entityId: id } })).toBe(1);
    // another broker's FEED never shows it
    const other = await broker();
    expect((await feed(other.id)).some((x) => x.action === "LICENSE_SUSPENDED")).toBe(false);
  });

  it("resume: only from SUSPENDED; ACTIVE again, audit + FEED + nudge, the suspend fields cleared", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect((await act(id, "resume")).status).toBe(409);
    await suspend(id);
    const r = await act(id, "resume");
    expect(r).toMatchObject({ status: 200, json: { status: "ACTIVE" } });
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect([row.status, row.suspendReason, row.suspendedAt, row.suspendedBy]).toEqual(["ACTIVE", null, null, null]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "BRIDGE_LICENSE_RESUMED", entityId: id } });
    expect(audit.actorAdminId).toBe(superAdminId);
    expect((await feed(b.id)).some((x) => x.action === "LICENSE_RESUMED")).toBe(true);
    const { publishBridgeLicenseChanged } = await import("@/lib/nats");
    expect(publishBridgeLicenseChanged).toHaveBeenLastCalledWith(b.id, id, "ACTIVE");
  });

  it("revoke is permanent: no resume, no suspend, no reinstatement through the old client-builds PATCH", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    await suspend(id);
    const r = await act(id, "revoke", "Contract terminated");
    expect(r).toMatchObject({ status: 200, json: { status: "REVOKED" } });
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect([row.status, row.revokedBy, row.revokeReason]).toEqual(["REVOKED", superAdminId, "Contract terminated"]);
    expect(row.revokedAt).not.toBeNull();
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "BRIDGE_LICENSE_REVOKED", entityId: id } });
    expect([audit.actorAdminId, (audit.newValue as { reason: string }).reason, (audit.oldValue as { status: string }).status]).toEqual([superAdminId, "Contract terminated", "SUSPENDED"]);
    expect((await feed(b.id)).find((x) => x.action === "LICENSE_REVOKED")?.values.text).toContain("Contract terminated");
    const { publishBridgeLicenseChanged } = await import("@/lib/nats");
    expect(publishBridgeLicenseChanged).toHaveBeenLastCalledWith(b.id, id, "REVOKED");

    expect((await act(id, "resume")).status).toBe(409);
    expect((await act(id, "suspend", "again")).status).toBe(409);
    expect((await act(id, "revoke", "again")).status).toBe(409);
    await asRole("SUPER_ADMIN");
    const { PATCH } = await import("@/app/api/admin/client-builds/route");
    const reinstate = await PATCH(new NextRequest("https://t/x", { method: "PATCH", body: JSON.stringify({ buildId: id, status: "ACTIVE" }) }));
    expect(reinstate.status).toBe(409);
    const { setClientBuildStatus, ClientBuildStatusError } = await import("@/lib/client-builds");
    await expect(setClientBuildStatus(id, "ACTIVE")).rejects.toBeInstanceOf(ClientBuildStatusError);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).status).toBe("REVOKED");
    expect((await manifest(b.subdomain, id)).status).toBe("REVOKED");
    const shown = (await list()).find((x) => x.buildId === id)!;
    expect(shown).toMatchObject({ status: "REVOKED", revokeReason: "Contract terminated", revokedBy: superAdminEmail, suspendReason: null });
  });

  it("the old PATCH: REVOKED on a license goes through the same revoke (audit, nudge); ACTIVE on a suspended one is refused; exe builds unchanged", async () => {
    if (!ready) return;
    const b = await broker();
    await asRole("SUPER_ADMIN");
    const { PATCH } = await import("@/app/api/admin/client-builds/route");
    const patch = (buildId: string, status: string, note?: string) => PATCH(new NextRequest("https://t/x", { method: "PATCH", body: JSON.stringify({ buildId, status, note }) }));
    const s = await issued(b.subdomain);
    await suspend(s);
    expect((await patch(s, "ACTIVE")).status).toBe(409);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: s } })).status).toBe("SUSPENDED");

    const id = await issued(b.subdomain);
    await asRole("SUPER_ADMIN");
    const res = await patch(id, "REVOKED", "old tool");
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("REVOKED");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: "BRIDGE_LICENSE_REVOKED", entityId: id } });
    expect([audit.actorAdminId, (audit.newValue as { reason: string }).reason]).toEqual([superAdminId, "old tool"]);
    const { publishBridgeLicenseChanged } = await import("@/lib/nats");
    expect(publishBridgeLicenseChanged).toHaveBeenLastCalledWith(b.id, id, "REVOKED");

    // the bridge exe's own build can still be revoked and reinstated (a mistaken exe revoke is undoable)
    const exe = await exeBuild(b, true);
    expect((await patch(exe, "ACTIVE")).status).toBe(200);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: exe } })).status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("one server per license (contract section 4)", () => {
  it("a bound license: another machine is refused `machine` on every route, one conflict audit row per hour, shown in Super Admin", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect((await report(id)).status).toBe(200);
    expect((await report(id, { machine: OTHER })).json.reason).toBe("machine");
    expect((await report(id, { machine: OTHER })).json.reason).toBe("machine");
    expect((await configGet({ licenseId: id, brokerId: b.id, machine: OTHER })).body.reason).toBe("machine");
    expect((await manifest(b.subdomain, id, `&machine=${OTHER}`)).reason).toBe("machine");
    // four refusals from the same machine, one audit row (rate limited per license + machine per hour)
    const conflicts = await prisma.auditLog.findMany({ where: { action: "BRIDGE_LICENSE_MACHINE_CONFLICT", entityId: id } });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].newValue).toMatchObject({ licenseId: id, machine: `${OTHER.slice(0, 8)}...`, boundMachine: `${MACHINE.slice(0, 8)}...` });
    expect(JSON.stringify(conflicts[0].newValue)).not.toContain(OTHER); // never the full hash in the audit row
    // a third machine: its own row
    await report(id, { machine: THIRD });
    expect(await prisma.auditLog.count({ where: { action: "BRIDGE_LICENSE_MACHINE_CONFLICT", entityId: id } })).toBe(2);
    // the refusals did not overwrite the online status: still the license's own machine
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect(row.lastReportMachine).toBe(MACHINE);
    expect(row.conflictMachine).toBe(THIRD);
    const shown = (await list()).find((x) => x.buildId === id)!;
    expect(shown.conflict).toMatchObject({ machine: `${THIRD.slice(0, 8)}...` });
    expect(shown.machine).toEqual({ prefix: `${MACHINE.slice(0, 8)}...`, source: "issued" });
    // the real bridge keeps working
    expect((await report(id)).status).toBe(200);
  });

  it("a license without a machine hash binds to its first reporter, sticky; the next machine is refused + audited", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await legacyLicense(b);
    expect((await list()).find((x) => x.buildId === id)?.machine).toBeNull();
    expect((await report(id, { machine: OTHER })).status).toBe(200);
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect([row.machineId, row.boundMachineId]).toEqual([null, OTHER]);
    expect(await prisma.auditLog.count({ where: { action: "BRIDGE_LICENSE_MACHINE_BOUND", entityId: id } })).toBe(1);
    expect((await list()).find((x) => x.buildId === id)?.machine).toEqual({ prefix: `${OTHER.slice(0, 8)}...`, source: "first-report" });

    // sticky: the first machine keeps it, on reports and on config fetches
    expect((await report(id, { machine: OTHER })).status).toBe(200);
    expect((await configGet({ licenseId: id, brokerId: b.id, machine: OTHER })).status).toBe(200);
    const second = await report(id, { machine: MACHINE });
    expect([second.status, second.json.reason]).toEqual([403, "machine"]);
    expect(verified(second.json.license)).toMatchObject({ status: "REFUSED", reason: "machine", buildId: id });
    expect((await configGet({ licenseId: id, brokerId: b.id, machine: MACHINE })).body.reason).toBe("machine");
    expect(await prisma.auditLog.count({ where: { action: "BRIDGE_LICENSE_MACHINE_CONFLICT", entityId: id } })).toBe(1);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).boundMachineId).toBe(OTHER);
    expect((await list()).find((x) => x.buildId === id)?.conflict).toMatchObject({ machine: `${MACHINE.slice(0, 8)}...` });
  });

  it("a license without a machine hash: a config fetch can be the first contact that binds it", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await legacyLicense(b);
    expect((await configGet({ licenseId: id, brokerId: b.id, machine: THIRD })).status).toBe(200);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).boundMachineId).toBe(THIRD);
    expect((await report(id, { machine: MACHINE })).json.reason).toBe("machine");
  });

  it("a revoked unbound license binds nothing", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await legacyLicense(b);
    await act(id, "revoke", "x");
    expect((await report(id, { machine: OTHER })).json.reason).toBe("revoked");
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } })).boundMachineId).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("end to end: suspend -> the next report is refused with a signed SUSPENDED verdict -> resume -> accepted", () => {
  it("round trip through the admin route and the status report", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    expect((await report(id)).json.license).toEqual({ status: "ACTIVE", reason: "" });

    expect((await act(id, "suspend", "Maintenance of the LP account")).status).toBe(200);
    const refused = await report(id);
    expect(refused.status).toBe(403);
    expect(refused.json.reason).toBe("suspended");
    const v = verified(refused.json.license);
    expect(v).toMatchObject({ slug: b.subdomain, app: "bridge", buildId: id, status: "SUSPENDED", reason: "suspended", suspendReason: "Maintenance of the LP account" });
    expect(v.exp).toBeGreaterThan(v.iat);
    // the config still comes (the bridge keeps its LP session), flagged SUSPENDED
    expect((await configGet({ licenseId: id, brokerId: b.id })).body.license).toEqual({ status: "SUSPENDED", reason: "suspended" });

    expect((await act(id, "resume")).status).toBe(200);
    const back = await report(id);
    expect(back.status).toBe(200);
    expect(back.json).toMatchObject({ ok: true, license: { status: "ACTIVE", reason: "" } });
    expect((await manifest(b.subdomain, id, `&machine=${MACHINE}`)).status).toBe("ACTIVE");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("readers: the columns first, the audit row only as a fallback", () => {
  it("issueBridgeLicense writes expiresAt + features; the audit row is not read for such a row", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain, { features: ["hedge", "feed"], expiresDays: 40 });
    const row = await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: id } });
    expect(row.features).toEqual(["hedge", "feed"]);
    expect(Math.abs(row.expiresAt!.getTime() - (Date.now() + 40 * 86_400_000))).toBeLessThan(5_000);
    // the audit row says something else: the column wins
    await prisma.auditLog.updateMany({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: id }, data: { newValue: { licenseId: id, features: ["feed"], expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    const { bridgeLicenseExpiries } = await import("@/lib/bridge-licenses");
    expect((await bridgeLicenseExpiries([id])).get(id)).toBe(row.expiresAt!.getTime());
    expect((await configGet({ licenseId: id, brokerId: b.id })).status).toBe(200);
  });

  it("a row the backfill could not fill: expiry and features from the audit row", async () => {
    if (!ready) return;
    const b = await broker();
    const id = await issued(b.subdomain);
    await prisma.clientBuild.update({ where: { buildId: id }, data: { expiresAt: null, features: [] } });
    const at = Date.now() + 5 * 86_400_000;
    await prisma.auditLog.updateMany({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: id }, data: { newValue: { licenseId: id, features: ["hedge"], expiresAt: new Date(at).toISOString() } } });
    const { bridgeLicenseExpiries } = await import("@/lib/bridge-licenses");
    expect((await bridgeLicenseExpiries([id])).get(id)).toBe(at);
    expect((await configGet({ licenseId: id, brokerId: b.id })).status).toBe(200);
    expect((await list()).find((x) => x.buildId === id)).toMatchObject({ expiry: "expiring" });
    await prisma.auditLog.updateMany({ where: { action: "BRIDGE_LICENSE_ISSUED", entityId: id }, data: { newValue: { licenseId: id, features: ["hedge"], expiresAt: new Date(Date.now() - 1000).toISOString() } } });
    expect((await report(id)).json.reason).toBe("expired");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("native clients: any non-ACTIVE registry record is refused (terminal / backoffice unchanged)", () => {
  it("checkClientBuild refuses SUSPENDED and REVOKED records, accepts ACTIVE, and never accepts a bridge row", async () => {
    if (!ready) return;
    const { checkClientBuild } = await import("@/lib/client-builds");
    const rec = (status: string, app = "terminal") => ({ buildId: "t-1", brokerId: "br1", brokerSubdomain: "s", app, version: "1.0.0", status, createdAt: new Date().toISOString(), revokedAt: null, note: "" }) as never;
    hctx.headers = new Headers({ "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "t-1" });
    expect(await checkClientBuild("br1", "s", Promise.resolve(rec("ACTIVE")))).toEqual({ ok: true, buildId: "t-1" });
    expect(await checkClientBuild("br1", "s", Promise.resolve(rec("REVOKED")))).toMatchObject({ ok: false, reason: "revoked" });
    expect(await checkClientBuild("br1", "s", Promise.resolve(rec("SUSPENDED")))).toMatchObject({ ok: false, reason: "revoked" });
    expect(await checkClientBuild("br1", "s", Promise.resolve(rec("ACTIVE", "bridge")))).toMatchObject({ ok: false, reason: "unknown" });
    hctx.headers = new Headers();
  });

  it("a terminal manifest is unchanged: no reason field, REVOKED for a revoked build", async () => {
    if (!ready) return;
    const b = await broker();
    const { registerClientBuild, setClientBuildStatus } = await import("@/lib/client-builds");
    const term = `ble-term-${randomUUID().slice(0, 6)}`;
    builds.push(term);
    await registerClientBuild({ buildId: term, brokerId: b.id, brokerSubdomain: b.subdomain, app: "terminal", version: "1.0.0", note: "" });
    const { GET } = await import("@/app/api/client/manifest/route");
    const get = async () => verified(await (await GET(new NextRequest(`https://t/api/client/manifest?slug=${b.subdomain}&app=terminal&buildId=${term}`, { headers: { "x-forwarded-for": `10.6.${Math.floor(Math.random() * 250)}.1` } }))).json());
    const a = await get();
    expect(a.status).toBe("ACTIVE");
    expect("reason" in a).toBe(false);
    await setClientBuildStatus(term, "REVOKED");
    expect((await get()).status).toBe("REVOKED");
  });
});
