import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Symbols tab server part (backoffice 1.0.101), contract C:\vyx\handoff\symbols-server-contract-1101.md.
// Real fixtures on the local scratch DB (each test file runs on its own clone), own cleanup.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));

import { getAdminSession } from "@/lib/auth";
import { getAccountSession } from "@/lib/account-auth";

let dbReachable = false;
beforeAll(async () => {
  process.env.SESSIONS_QUOTE_ENABLED = "1";
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("symbols-tab.test.ts: DB unreachable, skipping");
  }
});

type Fx = { brokerId: string; adminId: string; sfx: string };
const brokerIds: string[] = [];
const symbolIds: string[] = [];

async function fixture(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `SymTab ${sfx}`, subdomain: `symtab-${sfx}` } });
  brokerIds.push(b.id);
  const a = await prisma.adminUser.create({ data: { brokerId: b.id, email: `symtab-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  return { brokerId: b.id, adminId: a.id, sfx };
}
async function mkSymbol(fx: Fx, tag: string, quote = "USD") {
  const s = await prisma.symbol.create({ data: { name: `ST${tag}${fx.sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: quote, digits: 5, contractSize: "100000", category: "FOREX" } });
  symbolIds.push(s.id);
  return s;
}
async function mkRow(fx: Fx, symbolId: string, data: Record<string, unknown> = {}) {
  return prisma.brokerSymbol.create({ data: { brokerId: fx.brokerId, symbolId, enabled: false, ...data } });
}
function as(fx: Fx, role = "BROKER_ADMIN") {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role, brokerId: fx.brokerId } as never);
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
async function call(handler: unknown, method: string, body?: unknown, id = "x", query = "") {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": typeof body === "string" ? "text/csv" : "application/json" };
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  const res = await (handler as (r: NextRequest, c: unknown) => Promise<Response>)(new NextRequest(`https://t.local/api/manage/symbols${query}`, init as never), ctx(id));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}
const audit = (fx: Fx, entityId: string) => prisma.auditLog.findMany({ where: { brokerId: fx.brokerId, entityId }, orderBy: { createdAt: "asc" } });

afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokerIds } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.tradingSession.deleteMany({ where: { brokerSymbol: where } }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { id: { in: symbolIds } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

// field, a valid value, the stored/returned form, a value the route must refuse
const FIELDS: [string, unknown, unknown, unknown][] = [
  ["tickSize", "0.00001", "0.00001", "abc"],
  ["tickValue", "1.5", "1.5", "-2"],
  ["marginCurrency", "usd", "USD", "US"],
  ["profitCurrency", "eur", "EUR", "EURO"],
  ["executionMode", "INSTANT", "INSTANT", "SOMETIMES"],
  ["fillPolicy", "IOC", "IOC", "RETURN"],
  ["swapType", "PERCENT", "PERCENT", "TIME"],
  ["tripleSwapDay", 3, 3, 7],
  ["freezeLevel", 12, 12, -1],
  ["marginInitial", "0.0125", "0.0125", "-1"],
  ["marginMaintenance", "0.005", "0.005", "x"],
  ["description", "Spot gold", "Spot gold", "x".repeat(501)],
  ["displayOrder", 4, 4, -3],
];

describe("new BrokerSymbol fields: default, validation, audit row (PATCH /symbols/[id])", () => {
  it("GET lists every new field as null for a row that has none set, and for a symbol with no row", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const withRow = await mkSymbol(fx, "A");
    const noRow = await mkSymbol(fx, "B");
    await mkRow(fx, withRow.id);
    as(fx);
    const { GET } = await import("./route");
    const rows = (await (await GET()).json()) as Record<string, unknown>[];
    for (const sym of [withRow, noRow]) {
      const r = rows.find((x) => x.symbolId === sym.id)!;
      for (const [field] of FIELDS) expect(r[field], `${sym.name}.${field}`).toBeNull();
      expect(r.sessions).toEqual([]);
      expect(typeof r.hoursSummary).toBe("string");
      expect(r.hoursSummary).not.toBe("");
      expect(r.timeZone).toBeNull();
      expect(r.lpRouting).toEqual([]);
      expect(r.lpConnections).toEqual([]);
    }
  });

  it.each(FIELDS)("%s: refuses a bad value, stores a good one, writes an audit row", async (field, good, stored, bad) => {
    if (!dbReachable) return;
    const fx = await fixture();
    const sym = await mkSymbol(fx, "F");
    const row = await mkRow(fx, sym.id);
    as(fx);
    const { PATCH } = await import("./[id]/route");

    const refused = await call(PATCH, "PATCH", { [field]: bad }, row.id);
    expect(refused.status).toBe(400);
    expect(refused.json.fieldErrors[0].field).toBe(field);
    expect(await audit(fx, row.id)).toHaveLength(0);

    const done = await call(PATCH, "PATCH", { [field]: good }, row.id);
    expect(done.status).toBe(200);
    expect(done.json[field]).toBe(stored);
    const log = await audit(fx, row.id);
    expect(log).toHaveLength(1);
    expect(log[0].action).toBe("SYMBOL_CONFIG_UPDATED");
    expect((log[0].newValue as Record<string, unknown>)[field]).toBe(stored);
    expect((log[0].oldValue as Record<string, unknown>)[field]).toBeNull();

    // clearing it (null) is a change with its own audit row; sending it again changes nothing and writes nothing
    const cleared = await call(PATCH, "PATCH", { [field]: null }, row.id);
    expect(cleared.json[field]).toBeNull();
    expect(await audit(fx, row.id)).toHaveLength(2);
    await call(PATCH, "PATCH", { [field]: null }, row.id);
    expect(await audit(fx, row.id)).toHaveLength(2);
  });

  it("tradingMode accepts CLOSE_ONLY; another broker's symbol is 404; SUPPORT is 403", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const other = await fixture();
    const sym = await mkSymbol(fx, "M");
    const row = await mkRow(fx, sym.id);
    const { PATCH } = await import("./[id]/route");
    as(fx);
    expect((await call(PATCH, "PATCH", { tradingMode: "CLOSE_ONLY" }, row.id)).json.tradingMode).toBe("CLOSE_ONLY");
    expect((await call(PATCH, "PATCH", { tradingMode: "NOPE" }, row.id)).status).toBe(400);
    as(other);
    expect((await call(PATCH, "PATCH", { tradingMode: "BOTH" }, row.id)).status).toBe(404);
    as(fx, "SUPPORT");
    expect((await call(PATCH, "PATCH", { tradingMode: "BOTH" }, row.id)).status).toBe(403);
  });

  it("the existing PATCH /symbols takes the new fields too and audits them", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const sym = await mkSymbol(fx, "O");
    as(fx);
    const { PATCH } = await import("./route");
    const res = await call(PATCH, "PATCH", { symbolId: sym.id, spreadMarkup: "1", minLot: "0.01", maxLot: "10", lotStep: "0.01", swapLong: "0", swapShort: "0", commissionPerLot: "0", enabled: true, tradingMode: "BOTH", freezeLevel: 9, swapType: "POINTS" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ freezeLevel: 9, swapType: "POINTS", tickSize: null });
    const bad = await call(PATCH, "PATCH", { symbolId: sym.id, spreadMarkup: "1", minLot: "0.01", maxLot: "10", lotStep: "0.01", swapLong: "0", swapShort: "0", commissionPerLot: "0", enabled: true, tradingMode: "BOTH", tripleSwapDay: 9 });
    expect(bad.status).toBe(400);
    const log = await audit(fx, res.json.brokerSymbolId);
    expect((log[0].newValue as Record<string, unknown>).freezeLevel).toBe(9);
  });
});

describe("sessions", () => {
  it("refuses an overlap with rowErrors, stores a midnight crossing as two rows, keeps kind, GET returns kind", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const sym = await mkSymbol(fx, "S");
    const row = await mkRow(fx, sym.id);
    as(fx);
    const { GET, PUT } = await import("./[id]/sessions/route");

    const overlap = await call(PUT, "PUT", { sessions: [{ kind: "TRADE", dayOfWeek: 1, openTime: "08:00", closeTime: "12:00" }, { kind: "TRADE", dayOfWeek: 1, openTime: "11:00", closeTime: "14:00" }] }, row.id);
    expect(overlap.status).toBe(400);
    expect(overlap.json.rowErrors).toEqual([{ index: 1, reason: expect.stringContaining("overlaps") }]);
    expect(await prisma.tradingSession.count({ where: { brokerSymbolId: row.id } })).toBe(0);

    const saved = await call(PUT, "PUT", { sessions: [{ kind: "TRADE", dayOfWeek: 1, openTime: "22:00", closeTime: "02:00" }, { kind: "QUOTE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }, { dayOfWeek: 3, openTime: "08:00", closeTime: "17:00" }] }, row.id);
    expect(saved.status).toBe(200);
    expect(saved.json.map((s: { kind: string; dayOfWeek: number; openTime: string; closeTime: string }) => `${s.kind} ${s.dayOfWeek} ${s.openTime}-${s.closeTime}`).sort()).toEqual([
      "QUOTE 1 08:00-17:00",
      "TRADE 1 22:00-24:00",
      "TRADE 2 00:00-02:00",
      "TRADE 3 08:00-17:00",
    ]);
    const got = await call(GET, "GET", undefined, row.id);
    expect(got.json).toHaveLength(4);
    expect(got.json.every((s: { kind: string }) => s.kind === "TRADE" || s.kind === "QUOTE")).toBe(true);
    const log = await audit(fx, row.id);
    expect(log.filter((l) => l.action === "SYMBOL_SESSIONS_UPDATED")).toHaveLength(1);

    // the list shows the sessions and the server-built hours line
    as(fx);
    const list = (await (await (await import("./route")).GET()).json()) as { symbolId: string; sessions: unknown[]; hoursSummary: string }[];
    const r = list.find((x) => x.symbolId === sym.id)!;
    expect(r.sessions).toHaveLength(4);
    expect(r.hoursSummary).toContain("quotes");
  });

  it("an old client without kind still works (TRADE)", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const row = await mkRow(fx, (await mkSymbol(fx, "K")).id);
    as(fx);
    const { PUT } = await import("./[id]/sessions/route");
    const res = await call(PUT, "PUT", { sessions: [{ dayOfWeek: 2, openTime: "08:00", closeTime: "17:00" }] }, row.id);
    expect(res.json[0].kind).toBe("TRADE");
  });

  it("GET presets returns the server-defined list", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    as(fx);
    const { GET } = await import("./presets/route");
    const res = await (GET as unknown as () => Promise<Response>)();
    const json = (await res.json()) as { id: string; name: string; sessions: { kind: string }[] }[];
    expect(json.map((p) => p.name)).toEqual(["FX week", "24/7", "Metals", "Indices", "Crypto"]);
    as(fx, "SUPPORT");
    expect((await (GET as unknown as () => Promise<Response>)()).status).toBe(403);
  });
});

describe("bulk PATCH /symbols/bulk", () => {
  it("returns one result per id, a failing row does not stop the others, one audit row per changed symbol", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const other = await fixture();
    const a = await mkRow(fx, (await mkSymbol(fx, "A")).id);
    const b = await mkRow(fx, (await mkSymbol(fx, "B")).id, { minLot: "5", maxLot: "50" }); // maxLot 2 would fall below its minLot
    const c = await mkRow(fx, (await mkSymbol(fx, "C")).id);
    const foreign = await mkRow(other, (await mkSymbol(other, "D")).id);
    as(fx);
    const { PATCH } = await import("./bulk/route");
    const res = await call(PATCH, "PATCH", { ids: [a.id, b.id, "no-such-id", foreign.id, c.id], set: { maxLot: "2", spreadMarkup: "1.5", sessions: [{ dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }] } });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([
      { id: a.id, ok: true },
      { id: b.id, ok: false, error: expect.stringContaining("minLot") },
      { id: "no-such-id", ok: false, error: "symbol not found" },
      { id: foreign.id, ok: false, error: "symbol not found" },
      { id: c.id, ok: true },
    ]);
    expect((await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: a.id } })).maxLot.toString()).toBe("2");
    expect((await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: b.id } })).maxLot.toString()).toBe("50");
    expect(await prisma.tradingSession.count({ where: { brokerSymbolId: c.id } })).toBe(1);
    expect(await audit(fx, a.id)).toHaveLength(1);
    expect(await audit(fx, c.id)).toHaveLength(1);
    expect(await audit(fx, b.id)).toHaveLength(0);
    expect(await audit(other, foreign.id)).toHaveLength(0);
  });

  it("refuses a bad set before touching any row", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await mkRow(fx, (await mkSymbol(fx, "A")).id);
    as(fx);
    const { PATCH } = await import("./bulk/route");
    expect((await call(PATCH, "PATCH", { ids: [a.id], set: { maxLot: "-1" } })).status).toBe(400);
    expect((await call(PATCH, "PATCH", { ids: [a.id], set: { description: "x" } })).status).toBe(400);
    expect((await call(PATCH, "PATCH", { ids: [], set: { enabled: true } })).status).toBe(400);
    const badSessions = await call(PATCH, "PATCH", { ids: [a.id], set: { sessions: [{ dayOfWeek: 1, openTime: "10:00", closeTime: "10:00" }] } });
    expect(badSessions.status).toBe(400);
    expect(badSessions.json.rowErrors).toHaveLength(1);
    as(fx, "SUPPORT");
    expect((await call(PATCH, "PATCH", { ids: [a.id], set: { maxLot: "2" } })).status).toBe(403);
  });

  it("enabling a non-USD symbol fails that row only", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const usd = await mkRow(fx, (await mkSymbol(fx, "U")).id);
    const jpy = await mkRow(fx, (await mkSymbol(fx, "J", "JPY")).id);
    as(fx);
    const { PATCH } = await import("./bulk/route");
    const res = await call(PATCH, "PATCH", { ids: [jpy.id, usd.id], set: { enabled: true } });
    expect(res.json.results[0]).toMatchObject({ id: jpy.id, ok: false });
    expect(res.json.results[1]).toEqual({ id: usd.id, ok: true });
  });
});

describe("add and clone (POST /symbols)", () => {
  it("add: refuses a symbol outside the catalogue and says why, adds a catalogue symbol (disabled unless asked), refuses a duplicate", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const sym = await mkSymbol(fx, "N");
    as(fx);
    const { POST } = await import("./route");
    const unknown = await call(POST, "POST", { symbolName: "NOPE9999" });
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toContain("not in the platform catalogue");
    const bad = await call(POST, "POST", { symbolName: sym.name, freezeLevel: -1 });
    expect(bad.status).toBe(400);
    const added = await call(POST, "POST", { symbolName: sym.name, freezeLevel: 4, tickSize: "0.01", maxLot: "20", sessions: [{ dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }] });
    expect(added.status).toBe(201);
    expect(added.json).toMatchObject({ symbolName: sym.name, enabled: false, freezeLevel: 4, tickSize: "0.01", maxLot: "20", description: null });
    expect(added.json.sessions).toHaveLength(1);
    const log = await audit(fx, added.json.brokerSymbolId);
    expect(log.map((l) => l.action)).toEqual(["SYMBOL_ADDED"]);
    expect((await call(POST, "POST", { symbolName: sym.name })).status).toBe(409);
  });

  it("clone: copies every setting and the sessions to another catalogue symbol", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const src = await mkRow(fx, (await mkSymbol(fx, "S")).id, {
      enabled: true,
      spreadMarkup: "2",
      swapLong: "-1.5",
      minLot: "0.1",
      maxLot: "30",
      tradingMode: "CLOSE_ONLY",
      stopLevel: 7,
      hedgedMarginPct: "100",
      tickSize: "0.001",
      swapType: "MONEY",
      tripleSwapDay: 5,
      description: "source",
      displayOrder: 3,
    });
    await prisma.tradingSession.createMany({
      data: [
        { brokerSymbolId: src.id, kind: "TRADE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" },
        { brokerSymbolId: src.id, kind: "QUOTE", dayOfWeek: 2, openTime: "00:00", closeTime: "24:00" },
      ],
    });
    const target = await mkSymbol(fx, "T");
    as(fx);
    const { POST } = await import("./route");
    const res = await call(POST, "POST", { fromBrokerSymbolId: src.id, symbolName: target.name });
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ symbolName: target.name, enabled: true, spreadMarkup: "2", swapLong: "-1.5", minLot: "0.1", maxLot: "30", tradingMode: "CLOSE_ONLY", stopLevel: 7, tickSize: "0.001", swapType: "MONEY", tripleSwapDay: 5, description: "source", displayOrder: 3 });
    const copy = await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: res.json.brokerSymbolId }, include: { tradingSessions: true } });
    expect(copy.hedgedMarginPct.toString()).toBe("100");
    expect(copy.symbolId).toBe(target.id);
    expect(copy.tradingSessions.map((s) => `${s.kind} ${s.dayOfWeek} ${s.openTime}-${s.closeTime}`).sort()).toEqual(["QUOTE 2 00:00-24:00", "TRADE 1 08:00-17:00"]);
    expect((await audit(fx, copy.id))[0]).toMatchObject({ action: "SYMBOL_ADDED" });
    // cloning from another broker's row is refused
    const other = await fixture();
    const foreign = await mkRow(other, (await mkSymbol(other, "F")).id);
    expect((await call(POST, "POST", { fromBrokerSymbolId: foreign.id, symbolName: (await mkSymbol(fx, "G")).name })).status).toBe(404);
  });
});

describe("CSV import", () => {
  const HEADER = "symbolName,enabled,spreadMarkup,maxLot,freezeLevel,swapType,tickSize,description";

  it("dry run writes nothing and reports every row; apply writes only the ok rows, one audit row each", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const upd = await mkSymbol(fx, "U");
    const same = await mkSymbol(fx, "S");
    const created = await mkSymbol(fx, "C");
    const bad = await mkSymbol(fx, "B");
    const updRow = await mkRow(fx, upd.id);
    await mkRow(fx, same.id, { spreadMarkup: "1" });
    const csv = [
      HEADER,
      `${upd.name},true,2,50,6,POINTS,0.01,"Euro, spot"`,
      `${same.name},,1,,,,,`,
      `${created.name},false,0.5,10,,,,`,
      `${bad.name},true,1,10,-5,,,`,
      `NOPE9999,true,1,10,,,,`,
      `${upd.name},true,1,10,,,,`,
    ].join("\r\n");
    as(fx);
    const { POST } = await import("./import/route");

    const before = { bs: await prisma.brokerSymbol.count({ where: { brokerId: fx.brokerId } }), log: await prisma.auditLog.count({ where: { brokerId: fx.brokerId } }) };
    const dry = await call(POST, "POST", csv, "x", "/import?dryRun=1");
    expect(dry.status).toBe(200);
    expect(dry.json.rows).toEqual([
      { line: 2, symbol: upd.name, action: "update", ok: true, errors: [] },
      { line: 3, symbol: same.name, action: "skip", ok: true, errors: [] },
      { line: 4, symbol: created.name, action: "create", ok: true, errors: [] },
      { line: 5, symbol: bad.name, action: "skip", ok: false, errors: [expect.stringContaining("freezeLevel")] },
      { line: 6, symbol: "NOPE9999", action: "skip", ok: false, errors: [expect.stringContaining("not in the platform catalogue")] },
      { line: 7, symbol: upd.name, action: "skip", ok: false, errors: [expect.stringContaining("twice")] },
    ]);
    expect({ bs: await prisma.brokerSymbol.count({ where: { brokerId: fx.brokerId } }), log: await prisma.auditLog.count({ where: { brokerId: fx.brokerId } }) }).toEqual(before);
    expect((await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: updRow.id } })).freezeLevel).toBeNull();

    const applied = await call(POST, "POST", csv);
    expect(applied.status).toBe(200);
    expect(applied.json.rows.map((r: { action: string; ok: boolean }) => `${r.action}:${r.ok}`)).toEqual(["update:true", "skip:true", "create:true", "skip:false", "skip:false", "skip:false"]);
    const u = await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: updRow.id } });
    expect(u).toMatchObject({ enabled: true, freezeLevel: 6, swapType: "POINTS", description: "Euro, spot" });
    expect(u.maxLot.toString()).toBe("50");
    expect(await prisma.brokerSymbol.count({ where: { brokerId: fx.brokerId, symbolId: bad.id } })).toBe(0);
    const made = await prisma.brokerSymbol.findFirstOrThrow({ where: { brokerId: fx.brokerId, symbolId: created.id } });
    expect(made.enabled).toBe(false);
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId } })).toBe(before.log + 2); // one update, one create
  });

  it("refuses a file without a symbolName column and a non-manager", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    as(fx);
    const { POST } = await import("./import/route");
    expect((await call(POST, "POST", "foo,bar\n1,2\n")).status).toBe(400);
    as(fx, "SUPPORT");
    expect((await call(POST, "POST", `${HEADER}\nX,,,,,,,\n`)).status).toBe(403);
  });
});

describe("order and the trader list", () => {
  it("PATCH /symbols/order sets displayOrder with per-row results; /api/trade/symbols returns displayOrder first, nulls last, then name", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const other = await fixture();
    const names: Record<string, string> = {};
    const rows: Record<string, { id: string }> = {};
    for (const tag of ["A", "B", "C", "D"]) {
      const s = await mkSymbol(fx, tag);
      names[tag] = s.name;
      rows[tag] = await mkRow(fx, s.id, { enabled: true });
    }
    const foreign = await mkRow(other, (await mkSymbol(other, "Z")).id);
    as(fx);
    const { PATCH } = await import("./order/route");
    const res = await call(PATCH, "PATCH", { order: [{ id: rows.C.id, displayOrder: 1 }, { id: rows.B.id, displayOrder: 2 }, { id: foreign.id, displayOrder: 0 }] });
    expect(res.status).toBe(200);
    expect(res.json.results).toEqual([
      { id: rows.C.id, ok: true },
      { id: rows.B.id, ok: true },
      { id: foreign.id, ok: false, error: "symbol not found" },
    ]);
    expect((await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: foreign.id } })).displayOrder).toBeNull();
    expect(await audit(fx, rows.C.id)).toHaveLength(1);
    // the same order again changes nothing and writes no audit row
    await call(PATCH, "PATCH", { order: [{ id: rows.C.id, displayOrder: 1 }] });
    expect(await audit(fx, rows.C.id)).toHaveLength(1);
    expect((await call(PATCH, "PATCH", { order: [{ id: rows.C.id, displayOrder: -1 }] })).status).toBe(400);
    expect((await call(PATCH, "PATCH", { order: [{ id: rows.C.id, displayOrder: 1 }, { id: rows.C.id, displayOrder: 2 }] })).status).toBe(400);

    const account = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `ST-${fx.sfx}`, leverage: 100 } });
    const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
    const acc = await prisma.account.create({ data: { groupId: account.id, brokerId: fx.brokerId, accountNumber: n, email: `st-${n}@test.local`, passwordHash: "x", fullName: "ST", accountMode: "LIVE", balance: "1000", leverage: 100 } });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/trade/symbols/route");
    const list = (await (await GET()).json()) as { symbols: { name: string }[] };
    expect(list.symbols.map((s) => s.name)).toEqual([names.C, names.B, names.A, names.D]);
  });
});

describe("quote sessions are off until the server flag is set", () => {
  it("PUT refuses QUOTE rows with 400 unless SESSIONS_QUOTE_ENABLED=1; TRADE rows and GET are unaffected", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const row = await mkRow(fx, (await mkSymbol(fx, "Q")).id);
    await prisma.tradingSession.create({ data: { brokerSymbolId: row.id, kind: "QUOTE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" } });
    as(fx);
    const { PUT, GET } = await import("./[id]/sessions/route");
    const quote = { sessions: [{ kind: "QUOTE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }] };
    const prev = process.env.SESSIONS_QUOTE_ENABLED;
    try {
      delete process.env.SESSIONS_QUOTE_ENABLED;
      const off = await call(PUT, "PUT", quote, row.id);
      expect(off.status).toBe(400);
      expect(off.json.error).toBe("Quote sessions arrive with the next server update");
      expect((await call(PUT, "PUT", { sessions: [{ kind: "TRADE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }] }, row.id)).status).toBe(200);
      await prisma.tradingSession.create({ data: { brokerSymbolId: row.id, kind: "QUOTE", dayOfWeek: 2, openTime: "08:00", closeTime: "17:00" } });
      expect((await call(GET, "GET", undefined, row.id)).json.map((s: { kind: string }) => s.kind).sort()).toEqual(["QUOTE", "TRADE"]);
      process.env.SESSIONS_QUOTE_ENABLED = "0";
      expect((await call(PUT, "PUT", quote, row.id)).status).toBe(400);
      process.env.SESSIONS_QUOTE_ENABLED = "1";
      expect((await call(PUT, "PUT", quote, row.id)).status).toBe(200);
    } finally {
      process.env.SESSIONS_QUOTE_ENABLED = prev;
    }
  });
});

// Permissions (bfe2161 rule): settings and hours need GROUPS_SYMBOLS, pricing keeps PRICING, enabling keeps EMERGENCY_CONTROLS,
// all judged on the fields a request CHANGES.
describe("write permissions on every new route", () => {
  async function manager(fx: Fx, extra: string[]): Promise<Fx> {
    const a = await prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `perm-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "MANAGER", extraPermissions: extra } });
    return { ...fx, adminId: a.id };
  }
  const refused = (r: { status: number; json: { permission?: string; permissionLabel?: string } }, permission: string) => {
    expect(r.status).toBe(403);
    expect(r.json.permission).toBe(permission);
    expect(typeof r.json.permissionLabel).toBe("string");
  };

  it("without GROUPS_SYMBOLS every write route answers 403 with the key and label; with it the same request passes", async () => {
    if (!dbReachable) return;
    const base = await fixture();
    const a = await mkSymbol(base, "A");
    const b2 = await mkSymbol(base, "B");
    const row = await mkRow(base, a.id, { displayOrder: 1 });
    const src = await mkRow(base, b2.id);
    const target = await mkSymbol(base, "T");
    const noKey = await manager(base, []);
    const withKey = await manager(base, ["GROUPS_SYMBOLS"]);
    const { PATCH: patchId } = await import("./[id]/route");
    const { PATCH: bulk } = await import("./bulk/route");
    const { PATCH: order } = await import("./order/route");
    const { POST: importPost } = await import("./import/route");
    const { POST: post } = await import("./route");
    const { PUT: putSessions } = await import("./[id]/sessions/route");
    const csv = `symbolName,freezeLevel
${a.name},4
`;

    as(noKey, "MANAGER");
    refused(await call(patchId, "PATCH", { freezeLevel: 5 }, row.id), "GROUPS_SYMBOLS");
    refused(await call(bulk, "PATCH", { ids: [row.id], set: { maxLot: "2" } }), "GROUPS_SYMBOLS");
    refused(await call(bulk, "PATCH", { ids: [row.id], set: { sessions: [] } }), "GROUPS_SYMBOLS");
    refused(await call(order, "PATCH", { order: [{ id: row.id, displayOrder: 9 }] }), "GROUPS_SYMBOLS");
    refused(await call(importPost, "POST", csv, "x", "/import?dryRun=1"), "GROUPS_SYMBOLS");
    refused(await call(importPost, "POST", csv, "x", "/import"), "GROUPS_SYMBOLS");
    refused(await call(post, "POST", { symbolName: target.name }), "GROUPS_SYMBOLS");
    refused(await call(post, "POST", { fromBrokerSymbolId: src.id, symbolName: target.name }), "GROUPS_SYMBOLS");
    refused(await call(putSessions, "PUT", { sessions: [] }, row.id), "GROUPS_SYMBOLS");
    // nothing changed
    expect((await prisma.brokerSymbol.findUniqueOrThrow({ where: { id: row.id } })).freezeLevel).toBeNull();
    expect(await prisma.brokerSymbol.count({ where: { brokerId: base.brokerId, symbolId: target.id } })).toBe(0);
    // a save that changes nothing is not gated
    expect((await call(order, "PATCH", { order: [{ id: row.id, displayOrder: 1 }] })).status).toBe(200);
    expect((await call(patchId, "PATCH", { freezeLevel: null }, row.id)).status).toBe(200);
    // reads keep today's rule
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(200);

    as(withKey, "MANAGER");
    expect((await call(patchId, "PATCH", { freezeLevel: 5 }, row.id)).status).toBe(200);
    expect((await call(importPost, "POST", csv, "x", "/import?dryRun=1")).status).toBe(200);
    expect((await call(order, "PATCH", { order: [{ id: row.id, displayOrder: 9 }] })).status).toBe(200);
    expect((await call(putSessions, "PUT", { sessions: [] }, row.id)).status).toBe(200);
    expect((await call(post, "POST", { symbolName: target.name })).status).toBe(201);
  });

  it("pricing needs PRICING and enabling needs EMERGENCY_CONTROLS on top, on bulk, add and import", async () => {
    if (!dbReachable) return;
    const base = await fixture();
    const sym = await mkSymbol(base, "P");
    const row = await mkRow(base, sym.id);
    const cfgOnly = await manager(base, ["GROUPS_SYMBOLS"]);
    const cfgPricing = await manager(base, ["GROUPS_SYMBOLS", "PRICING"]);
    const { PATCH: bulk } = await import("./bulk/route");
    const { POST: post } = await import("./route");
    const { POST: importPost } = await import("./import/route");
    const newSym = await mkSymbol(base, "N");

    as(cfgOnly, "MANAGER");
    refused(await call(bulk, "PATCH", { ids: [row.id], set: { swapLong: "-1" } }), "PRICING");
    refused(await call(bulk, "PATCH", { ids: [row.id], set: { enabled: true } }), "EMERGENCY_CONTROLS");
    refused(await call(post, "POST", { symbolName: newSym.name, spreadMarkup: "1" }), "PRICING");
    refused(await call(importPost, "POST", `symbolName,spreadMarkup
${sym.name},2
`, "x", "/import?dryRun=1"), "PRICING");
    // an unchanged pricing value is not a pricing change
    expect((await call(bulk, "PATCH", { ids: [row.id], set: { spreadMarkup: "0", maxLot: "5" } })).json.results[0].ok).toBe(true);
    as(cfgPricing, "MANAGER");
    expect((await call(bulk, "PATCH", { ids: [row.id], set: { swapLong: "-1" } })).status).toBe(200);
    refused(await call(bulk, "PATCH", { ids: [row.id], set: { enabled: true } }), "EMERGENCY_CONTROLS");
  });
});
