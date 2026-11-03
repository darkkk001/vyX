import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Platform API bridge config, A.1.3: the LP connection CRUD (broker), the timeout / retry values (Super Admin only),
// every rule the bridge would enforce refused here first, the audit rows, and the delete guards. Real routes, scratch DB.
vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

let ready = false;
const brokers: string[] = [];
const symbols: string[] = [];
const admins: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1 FROM "LpConnection" LIMIT 1`;
    ready = true;
  } catch {
    console.warn("app/api/manage/lp-connections/route.test.ts: DB (with LpConnection) unreachable, skipping");
  }
});
afterAll(async () => {
  if (ready) {
    const where = { brokerId: { in: brokers } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.lpRoutingRule.deleteMany({ where });
    await prisma.lpConnection.deleteMany({ where });
    await prisma.liquidityProvider.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.symbol.deleteMany({ where: { id: { in: symbols } } });
    await prisma.adminUser.deleteMany({ where: { id: { in: admins } } });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.$disconnect();
});

type Fx = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  const broker = await prisma.broker.create({ data: { name: `LC ${s}`, subdomain: `lc-${s}` } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `lc-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const sa = await prisma.adminUser.create({ data: { email: `lc-sa-${s}@test.local`, passwordHash: "x", role: "SUPER_ADMIN", status: "ACTIVE" } });
  admins.push(admin.id, sa.id);
  const lp = await prisma.liquidityProvider.create({ data: { brokerId: broker.id, name: `Pepperstone ${s}`, status: "CONTRACTED" } });
  const mk = async (name: string, contractSize: number) => {
    const sym = await prisma.symbol.create({ data: { name: `${name}${s.slice(0, 4).toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize, category: "METALS" } });
    symbols.push(sym.id);
    await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: sym.id, minLot: new Prisma.Decimal("0.01"), lotStep: new Prisma.Decimal("0.01") } });
    return sym;
  };
  const gold = await mk("LG", 100);
  const fx = await mk("LE", 100000);
  return { s, broker, admin, sa, lp, gold, fx };
}

async function as(fx: Fx, role: "BROKER_ADMIN" | "SUPER_ADMIN" | "MANAGER") {
  const { getAdminSession } = await import("@/lib/auth");
  const id = role === "SUPER_ADMIN" ? fx.sa.id : fx.admin.id;
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: id, brokerId: role === "SUPER_ADMIN" ? null : fx.broker.id, role } as never);
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(`https://lc.test.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
const json = async (res: Response) => ({ status: res.status, body: await res.json() });
const ctx = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

const list = async () => json(await (await import("@/app/api/manage/lp-connections/route")).GET());
const create = async (body: unknown) => json(await (await import("@/app/api/manage/lp-connections/route")).POST(req("/api/manage/lp-connections", "POST", body)));
const patch = async (id: string, body: unknown) => json(await (await import("@/app/api/manage/lp-connections/[id]/route")).PATCH(req(`/api/manage/lp-connections/${id}`, "PATCH", body), ctx({ id })));
const del = async (id: string) => json(await (await import("@/app/api/manage/lp-connections/[id]/route")).DELETE(req(`/api/manage/lp-connections/${id}`, "DELETE"), ctx({ id })));
const addSymbol = async (id: string, body: unknown) => json(await (await import("@/app/api/manage/lp-connections/[id]/symbols/route")).POST(req(`/api/manage/lp-connections/${id}/symbols`, "POST", body), ctx({ id })));
const patchSymbol = async (id: string, rowId: string, body: unknown) =>
  json(await (await import("@/app/api/manage/lp-connections/[id]/symbols/[rowId]/route")).PATCH(req(`/x`, "PATCH", body), ctx({ id, rowId })));
const delSymbol = async (id: string, rowId: string) => json(await (await import("@/app/api/manage/lp-connections/[id]/symbols/[rowId]/route")).DELETE(req(`/x`, "DELETE"), ctx({ id, rowId })));

const session = (fx: Fx, over: Record<string, unknown> = {}) => ({
  liquidityProviderId: fx.lp.id,
  host: "demo.cfixapi.com",
  port: 5212,
  senderCompId: `demo.pepperstoneuk.${fx.s}`,
  targetCompId: "cServer",
  senderSubId: "TRADE",
  targetSubId: "TRADE",
  username: "4281366",
  tls: "WEBPKI",
  ...over,
});
const audits = (fx: Fx, action: string) => prisma.auditLog.count({ where: { brokerId: fx.broker.id, action } });

describe("LP connections: create, validate, audit", () => {
  it("a FIX 4.4 session is created and audited; the broker never sees timeouts", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const r = await create(session(fx, { targetCompId: "LP", dialect: "FIX44" }));
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ liquidityProviderId: fx.lp.id, role: "TRADE", enabled: true, port: 5212, tls: "WEBPKI", dialect: "FIX44", heartbeatSecs: 30, resetSeqOnLogon: false, symbols: [] });
    expect(r.body).not.toHaveProperty("ackTimeoutMs");
    expect(JSON.stringify(r.body)).not.toMatch(/password|maxAttempts|TtlSecs|reconcileTimeout/i);
    expect(await audits(fx, "LP_CONNECTION_CREATED")).toBe(1);
    const l = await list();
    expect(l.body).toHaveLength(1);
    expect(l.body[0]).not.toHaveProperty("maxAttempts");
  });

  it("refuses what the bridge would refuse, with the reason, and writes nothing", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const bad: [Record<string, unknown>, RegExp][] = [
      [{ port: 0 }, /port must be 1 to 65535/],
      [{ port: 70000 }, /port must be 1 to 65535/],
      [{ host: "  " }, /host is required/],
      [{ host: "https://demo.cfixapi.com" }, /host name or IP address/],
      [{ senderCompId: "demo pepper" }, /SenderCompID must have no spaces/],
      [{ targetCompId: "" }, /TargetCompID is required/],
      [{ heartbeatSecs: 0 }, /heartbeat must be 1 to 300/],
      [{ tls: "PEM" }, /TLS must be one of OFF, WEBPKI, NATIVE/],
      [{ tls: "OFF", tlsServerName: "x.example" }, /TLS server name needs TLS on/],
      [{ dialect: "CTRADER" }, /dialect must be one of FIX44, CSERVER/],
      [{ role: "HEDGE" }, /role must be one of TRADE, QUOTE/],
      [{ password: "hunter2" }, /never stored on the platform/],
    ];
    for (const [over, msg] of bad) {
      const r = await create(session(fx, { dialect: "FIX44", ...over }));
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    expect(await prisma.lpConnection.count({ where: { brokerId: fx.broker.id } })).toBe(0);
    expect(await audits(fx, "LP_CONNECTION_CREATED")).toBe(0);
  });

  it("timeouts from a broker are refused (403); another broker's provider is not found; one connection per provider and role", async () => {
    if (!ready) return;
    const fx = await fixture();
    const other = await fixture();
    await as(fx, "BROKER_ADMIN");
    expect((await create(session(fx, { dialect: "FIX44", maxAttempts: 5 }))).status).toBe(403);
    expect((await create(session(fx, { dialect: "FIX44", liquidityProviderId: other.lp.id }))).status).toBe(404);
    expect((await create(session(fx, { dialect: "FIX44" }))).status).toBe(201);
    const dup = await create(session(fx, { dialect: "FIX44" }));
    expect(dup.status).toBe(409);
    expect(dup.body.error).toMatch(/already has a connection for that role/);
    expect((await create(session(fx, { dialect: "FIX44", role: "QUOTE", port: 5211 }))).status).toBe(201);
  });

  it("a MANAGER cannot read or write connections", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "MANAGER");
    expect((await list()).status).toBe(403);
    expect((await create(session(fx))).status).toBe(403);
  });
});

describe("LP connections: cTrader symbol table", () => {
  it("a cTrader connection starts disabled without symbols, cannot be enabled until it has one, and refuses bad rows", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const c = await create(session(fx, { dialect: "CSERVER", resetSeqOnLogon: true }));
    expect(c.status).toBe(201);
    expect(c.body.enabled).toBe(false);
    const id = c.body.id;
    const on = await patch(id, { enabled: true });
    expect(on.status).toBe(409);
    expect(on.body.error).toMatch(/needs at least one symbol/);
    const badRows: [Record<string, unknown>, RegExp][] = [
      [{ venueId: "XAUUSD" }, /numeric symbol id/],
      [{ minUnits: "1.5", stepUnits: "1" }, /multiple of step units/],
      [{ contractSize: "0" }, /contract size must be a number above 0/],
      [{ stepUnits: "0.00001" }, /at most 4 decimals/],
      [{ venueId: "4 1" }, /no spaces/],
    ];
    for (const [over, msg] of badRows) {
      const r = await addSymbol(id, { symbolId: fx.gold.id, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1", ...over });
      expect(r.status, JSON.stringify(over)).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const added = await addSymbol(id, { symbolId: fx.gold.id, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1" });
    expect(added.status).toBe(201);
    expect(added.body.symbols).toEqual([expect.objectContaining({ symbolName: fx.gold.name, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1" })]);
    expect((await addSymbol(id, { symbolId: fx.gold.id, venueId: "42", contractSize: "100", minUnits: "1", stepUnits: "1" })).status).toBe(409);
    const enabled = await patch(id, { enabled: true });
    expect(enabled.status).toBe(200);
    expect(await audits(fx, "LP_CONNECTION_ENABLED")).toBe(1);
    // the last symbol of an enabled cTrader connection cannot go (the bridge would refuse the session)
    const rowId = added.body.symbols[0].id;
    const last = await delSymbol(id, rowId);
    expect(last.status).toBe(409);
    expect(last.body.error).toMatch(/disable the connection first/);
    // a row change keeps the rules; then disable and remove
    expect((await patchSymbol(id, rowId, { minUnits: "3", stepUnits: "2" })).status).toBe(400);
    expect((await patchSymbol(id, rowId, { venueId: "41", stepUnits: "1", minUnits: "2" })).body.symbols[0].minUnits).toBe("2");
    expect((await patch(id, { enabled: false })).status).toBe(200);
    expect(await audits(fx, "LP_CONNECTION_DISABLED")).toBe(1);
    expect((await delSymbol(id, rowId)).status).toBe(200);
    for (const a of ["LP_CONNECTION_SYMBOL_ADDED", "LP_CONNECTION_SYMBOL_CHANGED", "LP_CONNECTION_SYMBOL_REMOVED"]) expect(await audits(fx, a)).toBe(1);
  });

  it("a cTrader connection created with its symbols in one step is enabled; a switch to cTrader checks the existing venue ids", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const one = await create(session(fx, { dialect: "CSERVER", symbols: [{ symbolId: fx.fx.id, venueId: "1", contractSize: "100000", minUnits: "1000", stepUnits: "1000" }] }));
    expect(one.status).toBe(201);
    expect(one.body.enabled).toBe(true);
    expect(one.body.symbols).toHaveLength(1);
    // a FIX 4.4 session with a name as venue symbol cannot become cTrader
    const plain = await create(session(fx, { role: "QUOTE", dialect: "FIX44", symbols: [{ symbolId: fx.gold.id, venueId: "XAUUSD", contractSize: "100", minUnits: "1", stepUnits: "1" }] }));
    expect(plain.status).toBe(201);
    const sw = await patch(plain.body.id, { dialect: "CSERVER" });
    expect(sw.status).toBe(400);
    expect(sw.body.error).toMatch(/numeric symbol id/);
  });

  it("symbol defaults come from the platform symbol and the broker's lot settings", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const { GET } = await import("@/app/api/manage/lp-connections/symbol-defaults/route");
    const r = await json(await GET(req(`/api/manage/lp-connections/symbol-defaults?symbolId=${fx.gold.id}`, "GET")));
    expect(r.body).toEqual({ symbolId: fx.gold.id, symbolName: fx.gold.name, contractSize: "100", minUnits: "1", stepUnits: "1" });
    const e = await json(await GET(req(`/api/manage/lp-connections/symbol-defaults?symbolId=${fx.fx.id}`, "GET")));
    expect(e.body).toMatchObject({ contractSize: "100000", minUnits: "1000", stepUnits: "1000" });
  });
});

describe("LP connections: change, delete, guards", () => {
  it("PATCH audits old and new; a no-op writes nothing; the provider cannot change; another broker's connection is not found", async () => {
    if (!ready) return;
    const fx = await fixture();
    const other = await fixture();
    await as(fx, "BROKER_ADMIN");
    const c = await create(session(fx, { dialect: "FIX44", targetCompId: "LP" }));
    const r = await patch(c.body.id, { port: 5213, heartbeatSecs: 45 });
    expect(r.body).toMatchObject({ port: 5213, heartbeatSecs: 45 });
    const row = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.broker.id, action: "LP_CONNECTION_CHANGED" } });
    expect(row.oldValue).toMatchObject({ port: 5212, heartbeatSecs: 30 });
    expect(row.newValue).toMatchObject({ port: 5213, heartbeatSecs: 45 });
    expect((await patch(c.body.id, { port: 5213 })).status).toBe(200);
    expect(await audits(fx, "LP_CONNECTION_CHANGED")).toBe(1);
    expect((await patch(c.body.id, { liquidityProviderId: fx.lp.id })).status).toBe(400);
    expect((await patch(c.body.id, { ackTimeoutMs: 100 })).status).toBe(403);
    await as(other, "BROKER_ADMIN");
    expect((await patch(c.body.id, { port: 1 })).status).toBe(404);
    expect((await del(c.body.id)).status).toBe(404);
  });

  it("an LP with a bridge connection cannot be deleted (409, not a 500); after the connection goes, it can", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const c = await create(session(fx, { dialect: "CSERVER", symbols: [{ symbolId: fx.gold.id, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1" }] }));
    const { DELETE: deleteLp } = await import("@/app/api/manage/liquidity-providers/[id]/route");
    const refused = await json(await deleteLp(req(`/api/manage/liquidity-providers/${fx.lp.id}`, "DELETE"), ctx({ id: fx.lp.id })));
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("this provider has a bridge connection: delete it first");
    expect(await prisma.liquidityProvider.count({ where: { id: fx.lp.id } })).toBe(1);
    // deleting the connection takes its symbol rows with it, audited with a full snapshot
    const d = await del(c.body.id);
    expect(d.status).toBe(200);
    expect(await prisma.lpConnectionSymbol.count({ where: { lpConnectionId: c.body.id } })).toBe(0);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.broker.id, action: "LP_CONNECTION_DELETED" } });
    expect((audit.oldValue as { symbols: unknown[] }).symbols).toHaveLength(1);
    expect((await json(await deleteLp(req(`/x`, "DELETE"), ctx({ id: fx.lp.id })))).status).toBe(200);
  });

  it("what the backoffice saves is what the bridge is served (GET /api/bridge/config's builder)", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    await create(session(fx, { dialect: "CSERVER", resetSeqOnLogon: true, symbols: [{ symbolId: fx.gold.id, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1" }] }));
    const { buildBridgeConfig } = await import("@/lib/bridge-config");
    const cfg = await buildBridgeConfig(fx.broker.id);
    expect(cfg.lps).toEqual([expect.objectContaining({ id: fx.lp.id, dialect: "CSERVER", enabled: true, resetSeqOnLogon: true, ackTimeoutMs: null, symbols: [{ engine: fx.gold.name, venueId: "41", contractSize: "100", minUnits: "1", stepUnits: "1" }] })]);
  });
});

describe("LP connections: Super Admin timeouts", () => {
  it("only Super Admin sees and sets timeouts / retries, within limits, audited", async () => {
    if (!ready) return;
    const fx = await fixture();
    await as(fx, "BROKER_ADMIN");
    const c = await create(session(fx, { dialect: "FIX44", targetCompId: "LP" }));
    const admin = await import("@/app/api/admin/lp-connections/[id]/route");
    const adminList = await import("@/app/api/admin/lp-connections/route");
    // a broker admin is refused there
    expect((await admin.PATCH(req("/x", "PATCH", { maxAttempts: 5 }), ctx({ id: c.body.id }))).status).toBe(403);
    await as(fx, "SUPER_ADMIN");
    const l = await json(await adminList.GET(req(`/api/admin/lp-connections?broker=${fx.broker.subdomain}`, "GET")));
    expect(l.body[0]).toMatchObject({ ackTimeoutMs: null, orderTtlSecs: null, maxAttempts: null, reconcileTimeoutSecs: null });
    for (const [body, msg] of [
      [{ maxAttempts: 0 }, /attempts must be 1 to 20/],
      [{ ackTimeoutMs: 999999 }, /ack timeout must be 1 to 60000/],
      [{ port: 1 }, /nothing to change/],
    ] as const) {
      const r = await json(await admin.PATCH(req("/x", "PATCH", body), ctx({ id: c.body.id })));
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(msg);
    }
    const ok = await json(await admin.PATCH(req("/x", "PATCH", { ackTimeoutMs: 2500, maxAttempts: 5 }), ctx({ id: c.body.id })));
    expect(ok.body).toMatchObject({ ackTimeoutMs: 2500, maxAttempts: 5, port: 5212 });
    expect(await audits(fx, "LP_CONNECTION_TIMEOUTS_CHANGED")).toBe(1);
    // back to the bridge's default
    expect((await json(await admin.PATCH(req("/x", "PATCH", { maxAttempts: null }), ctx({ id: c.body.id })))).body.maxAttempts).toBeNull();
    // the broker still never sees them
    await as(fx, "BROKER_ADMIN");
    expect((await list()).body[0]).not.toHaveProperty("ackTimeoutMs");
  });
});
