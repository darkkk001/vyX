import "dotenv/config";
import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// Platform API bridge config, A.1.2 (owner decisions 2026-11-03): GET /api/bridge/config and /version. Real routes,
// scratch DB, test Redis. Every refusal the auth promises (lib/bridge-auth.ts) is exercised, plus broker scoping and
// "no secrets in the payload".
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const SECRET = "report-secret-for-tests";
const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const saved: Record<string, string | undefined> = {};
let ready = false;
const brokers: string[] = [];
const builds: string[] = [];
const symbols: string[] = [];
let superAdminId = "";

beforeAll(async () => {
  for (const k of ["CLIENT_MANIFEST_PRIVATE_KEY", "BRIDGE_REPORT_SECRET"]) saved[k] = process.env[k];
  process.env.CLIENT_MANIFEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  process.env.BRIDGE_REPORT_SECRET = SECRET;
  try {
    await prisma.$queryRaw`SELECT "machineId" FROM "ClientBuild" LIMIT 1`;
    await prisma.$queryRaw`SELECT 1 FROM "LpConnection" LIMIT 1`;
    await getRedis().ping();
    superAdminId = (await prisma.adminUser.create({ data: { email: `bc-sa-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "SUPER_ADMIN", status: "ACTIVE" } })).id;
    ready = true;
  } catch {
    console.warn("app/api/bridge/config/route.test.ts: DB (with LpConnection) or Redis unreachable, skipping");
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
    await prisma.clientBuild.deleteMany({ where: { buildId: { in: builds } } });
    await prisma.lpRoutingRule.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.lpConnection.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.liquidityProvider.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.symbol.deleteMany({ where: { id: { in: symbols } } });
    await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.group.deleteMany({ where: { brokerId: { in: brokers } } });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
    await prisma.adminUser.deleteMany({ where: { id: superAdminId } }).catch(() => {});
  }
  await prisma.$disconnect();
});

const MACHINE = "ab".repeat(32);
const key = (licenseId: string) => createHmac("sha256", SECRET).update(`bridge-report:${licenseId}`).digest();

async function brokerWithConfig() {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `BC ${s}`, subdomain: `bc-${s}` } });
  brokers.push(b.id);
  const lp = await prisma.liquidityProvider.create({ data: { brokerId: b.id, name: `LP ${s}`, status: "CONTRACTED" } });
  const sym = await prisma.symbol.create({ data: { name: `BC${s.slice(0, 5).toUpperCase()}`, baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: 100000, category: "FOREX" } });
  symbols.push(sym.id);
  const conn = await prisma.lpConnection.create({
    data: { brokerId: b.id, liquidityProviderId: lp.id, host: "demo.cfixapi.com", port: 5212, senderCompId: `demo.${s}`, targetCompId: "cServer", senderSubId: "TRADE", targetSubId: "TRADE", username: "4281366", tls: "WEBPKI", dialect: "CSERVER", resetSeqOnLogon: true },
  });
  await prisma.lpConnectionSymbol.create({ data: { lpConnectionId: conn.id, symbolId: sym.id, venueId: "1", contractSize: new Prisma.Decimal(100000), minUnits: new Prisma.Decimal(1000), stepUnits: new Prisma.Decimal(1000) } });
  const group = await prisma.group.create({ data: { brokerId: b.id, name: `G ${s}`, category: "A_BOOK" } as never });
  await prisma.lpRoutingRule.create({ data: { brokerId: b.id, liquidityProviderId: lp.id, groupId: group.id, symbolId: sym.id, priority: 1, weight: new Prisma.Decimal("0.5") } });
  return { broker: b, lp, conn, sym };
}

/** A license row as issueBridgeLicense leaves it (ClientBuild + its BRIDGE_LICENSE_ISSUED audit row). */
async function license(brokerId: string, subdomain: string, o: { machineId?: string | null; features?: string[]; expiresInDays?: number; status?: "ACTIVE" | "REVOKED" } = {}) {
  const id = `${subdomain}-bridge-test-${randomUUID().slice(0, 6)}`;
  builds.push(id);
  await prisma.clientBuild.create({
    data: { buildId: id, brokerId, brokerSubdomain: subdomain, app: "bridge", version: "license", status: o.status ?? "ACTIVE", createdAt: new Date(), note: "", machineId: o.machineId === undefined ? MACHINE : o.machineId },
  });
  await prisma.auditLog.create({
    data: { brokerId, actorAdminId: superAdminId, action: "BRIDGE_LICENSE_ISSUED", entityType: "ClientBuild", entityId: id, newValue: { licenseId: id, features: o.features ?? ["hedge"], expiresAt: new Date(Date.now() + (o.expiresInDays ?? 365) * 86_400_000).toISOString() } },
  });
  return id;
}

type Req = { path?: string; licenseId: string; brokerId: string | null; machine?: string; build?: string; time?: number; nonce?: string; signWith?: string; signPath?: string; ifNoneMatch?: string };
function request(r: Req) {
  const path = r.path ?? "/api/bridge/config";
  const time = String(r.time ?? Math.floor(Date.now() / 1000));
  const machine = r.machine ?? MACHINE;
  const build = r.build ?? "qorebridge-0.1.0-test";
  const nonce = r.nonce ?? randomUUID().replace(/-/g, "");
  const signed = `GET\n${r.signPath ?? path}\n${time}\n${nonce}\n${r.licenseId}\n${machine}\n${build}`;
  const sig = createHmac("sha256", key(r.signWith ?? r.licenseId)).update(signed).digest("hex");
  const h: Record<string, string> = { "x-bridge-license": r.licenseId, "x-bridge-time": time, "x-bridge-nonce": nonce, "x-bridge-machine": machine, "x-bridge-build": build, "x-bridge-signature": sig };
  if (r.brokerId) h["x-broker-id"] = r.brokerId; // what middleware sets from the host
  if (r.ifNoneMatch) h["if-none-match"] = r.ifNoneMatch;
  return new NextRequest(`https://bc.test.local${path}`, { headers: h });
}
async function call(r: Req) {
  const mod = (r.path ?? "/api/bridge/config").endsWith("/version") ? await import("@/app/api/bridge/config/version/route") : await import("@/app/api/bridge/config/route");
  const res = await mod.GET(request(r));
  const text = await res.text();
  return { status: res.status, etag: res.headers.get("etag"), body: text ? JSON.parse(text) : null, text };
}

const refused = async (req: Omit<Req, "licenseId" | "brokerId"> & Partial<Pick<Req, "licenseId" | "brokerId">>, opts: Parameters<typeof license>[2] = {}, reason?: string) => {
  const { broker } = await brokerWithConfig();
  const id = await license(broker.id, broker.subdomain, opts);
  const r = await call({ licenseId: id, brokerId: broker.id, ...req });
  expect(r.status).toBe(403);
  if (reason) expect(r.body.reason).toBe(reason);
  expect(r.body.lps).toBeUndefined();
  return r;
};

describe("GET /api/bridge/config: auth", () => {
  it("the right license on its own broker's host gets its config", async () => {
    if (!ready) return;
    const { broker, lp, sym } = await brokerWithConfig();
    const id = await license(broker.id, broker.subdomain);
    const r = await call({ licenseId: id, brokerId: broker.id });
    expect(r.status).toBe(200);
    expect(r.body.brokerId).toBe(broker.id);
    expect(r.body.lps).toHaveLength(1);
    expect(r.body.lps[0]).toMatchObject({ id: lp.id, role: "TRADE", enabled: true, host: "demo.cfixapi.com", port: 5212, targetCompId: "cServer", tls: "WEBPKI", dialect: "CSERVER", heartbeatSecs: 30, resetSeqOnLogon: true, ackTimeoutMs: null });
    expect(r.body.lps[0].symbols).toEqual([{ engine: sym.name, venueId: "1", contractSize: "100000", minUnits: "1000", stepUnits: "1000" }]);
    expect(r.body.routing).toEqual([expect.objectContaining({ lpId: lp.id, symbol: sym.name, priority: 1, weight: "0.5", enabled: true })]);
    expect(r.etag).toBe(`"${r.body.version}"`);
    // no secret of any kind
    expect(r.text).not.toMatch(/password|secret|reportKey|tls_ca|machine/i);
  });


  it("wrong signature (another license's key) is refused", async () => {
    if (!ready) return;
    await refused({ signWith: "someone-else" }, {}, "signature");
  });
  it("a signature for another path is refused (a /version signature cannot read the config)", async () => {
    if (!ready) return;
    await refused({ signPath: "/api/bridge/config/version" }, {}, "signature");
  });
  it("stale timestamp (5 minutes old) and a future one are refused", async () => {
    if (!ready) return;
    await refused({ time: Math.floor(Date.now() / 1000) - 300 }, {}, "clock");
    await refused({ time: Math.floor(Date.now() / 1000) + 300 }, {}, "clock");
  });
  it("the same signed request twice: the replay is refused", async () => {
    if (!ready) return;
    const { broker } = await brokerWithConfig();
    const id = await license(broker.id, broker.subdomain);
    const time = Math.floor(Date.now() / 1000);
    const nonce = randomUUID().replace(/-/g, "");
    expect((await call({ licenseId: id, brokerId: broker.id, time, nonce })).status).toBe(200);
    const again = await call({ licenseId: id, brokerId: broker.id, time, nonce });
    expect(again.status).toBe(403);
    expect(again.body.reason).toBe("replay");
  });
  it("missing headers are refused", async () => {
    if (!ready) return;
    const mod = await import("@/app/api/bridge/config/route");
    const res = await mod.GET(new NextRequest("https://bc.test.local/api/bridge/config"));
    expect(res.status).toBe(403);
  });
  it("revoked, expired and feed-only licenses are refused", async () => {
    if (!ready) return;
    await refused({}, { status: "REVOKED" }, "license");
    await refused({}, { expiresInDays: -1 }, "license");
    await refused({}, { features: ["feed"] }, "license");
  });
  it("an unknown license id, and a terminal build presented as a license, are refused", async () => {
    if (!ready) return;
    const { broker } = await brokerWithConfig();
    const ghost = `${broker.subdomain}-bridge-ghost`;
    expect((await call({ licenseId: ghost, brokerId: broker.id })).body.reason).toBe("license");
    const term = `term-${randomUUID().slice(0, 6)}`;
    builds.push(term);
    await prisma.clientBuild.create({ data: { buildId: term, brokerId: broker.id, brokerSubdomain: broker.subdomain, app: "terminal", version: "1.0.0", status: "ACTIVE", createdAt: new Date(), note: "" } });
    expect((await call({ licenseId: term, brokerId: broker.id })).body.reason).toBe("license");
  });
  it("machine mismatch is refused, and so is a license issued before machine binding (no hash stored)", async () => {
    if (!ready) return;
    await refused({ machine: "cd".repeat(32) }, {}, "machine");
    await refused({}, { machineId: null }, "machine");
  });
  it("a revoked bridge exe build is refused", async () => {
    if (!ready) return;
    const { broker } = await brokerWithConfig();
    const exe = `qorebridge-0.1.0-revoked-${randomUUID().slice(0, 6)}`;
    builds.push(exe);
    await prisma.clientBuild.create({ data: { buildId: exe, brokerId: broker.id, brokerSubdomain: broker.subdomain, app: "bridge", version: "exe", status: "REVOKED", createdAt: new Date(), note: "" } });
    const id = await license(broker.id, broker.subdomain);
    const r = await call({ licenseId: id, brokerId: broker.id, build: exe });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("build");
  });
  it("cross-broker: broker X's license on broker Y's host is refused, and Y's config never leaks", async () => {
    if (!ready) return;
    const x = await brokerWithConfig();
    const y = await brokerWithConfig();
    const id = await license(x.broker.id, x.broker.subdomain);
    const r = await call({ licenseId: id, brokerId: y.broker.id });
    expect(r.status).toBe(403);
    expect(r.body.reason).toBe("broker");
    expect(r.text).not.toContain(y.lp.id);
    // and no host at all (root domain: middleware sets no broker) is refused too
    expect((await call({ licenseId: id, brokerId: null })).body.reason).toBe("broker");
    // on its own host it sees only its own broker's rows
    const own = await call({ licenseId: id, brokerId: x.broker.id });
    expect(own.status).toBe(200);
    expect(own.text).not.toContain(y.lp.id);
    expect(own.text).not.toContain(y.broker.id);
  });
});

describe("GET /api/bridge/config: version", () => {
  it("/version returns the same version; If-None-Match answers 304; an edit changes the version", async () => {
    if (!ready) return;
    const { broker, conn } = await brokerWithConfig();
    const id = await license(broker.id, broker.subdomain);
    const full = await call({ licenseId: id, brokerId: broker.id });
    const v = await call({ licenseId: id, brokerId: broker.id, path: "/api/bridge/config/version" });
    expect(v.status).toBe(200);
    expect(v.body).toEqual({ version: full.body.version });
    expect((await call({ licenseId: id, brokerId: broker.id, ifNoneMatch: `"${full.body.version}"` })).status).toBe(304);
    await prisma.lpConnection.update({ where: { id: conn.id }, data: { heartbeatSecs: 45 } });
    const after = await call({ licenseId: id, brokerId: broker.id, path: "/api/bridge/config/version" });
    expect(after.body.version).not.toBe(full.body.version);
  });
  it("/version applies the same auth (machine mismatch refused)", async () => {
    if (!ready) return;
    await refused({ path: "/api/bridge/config/version", machine: "ef".repeat(32) }, {}, "machine");
  });
});

describe("license issue stores the full machine hash", () => {
  it("issueBridgeLicense writes ClientBuild.machineId (all 64 characters)", async () => {
    if (!ready) return;
    const { broker } = await brokerWithConfig();
    const { issueBridgeLicense } = await import("@/lib/bridge-licenses");
    const issued = await issueBridgeLicense({ brokerSlug: broker.subdomain, machineId: MACHINE.toUpperCase(), features: ["hedge"], expiresDays: 30, adminId: superAdminId });
    builds.push(issued.licenseId);
    expect((await prisma.clientBuild.findUniqueOrThrow({ where: { buildId: issued.licenseId } })).machineId).toBe(MACHINE);
  });
});

describe("signature test vector (shared with qorebridge bin/qorebridge/src/platform_config.rs)", () => {
  it("fixed inputs give the fixed signature", async () => {
    const { bridgeSignedString } = await import("@/lib/bridge-auth");
    const k = createHmac("sha256", "vector-secret").update("bridge-report:zzzqa-bridge-20261103-abcdef").digest();
    const signed = bridgeSignedString("/api/bridge/config", "1762160000", "0123456789abcdef0123456789abcdef", "zzzqa-bridge-20261103-abcdef", "ab".repeat(32), "qorebridge-0.1.0-test");
    const sig = createHmac("sha256", k).update(signed).digest("hex");
    expect({ key: k.toString("base64"), sig }).toMatchInlineSnapshot(`
      {
        "key": "HGjuSCRVm2k4rcdJIx7Ktx/zulFM+Ckbf5HN6Lh+eaM=",
        "sig": "7c0bbda3736bb5a57f889334c97f954fe365ff836bce34e9ed56340293c57c51",
      }
    `);
  });
});
