import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Group volume step (lot multiplier): effective step = max(symbol step, Group.lotStep); null = unchanged. Modelled on group-min-volume.test.ts. Refused below it
// with code GROUP_MIN_VOLUME at every open path (placement, pending trigger, requote accept, dealer accept, desk flush,
// staff open); a group minimum off a symbol's volume grid is refused at SAVE with MIN_VOLUME_STEP; the terminal is
// told the effective minimum (trade/symbols). ADVERSARIAL on the local scratch DB: each refusal is proven by the order
// staying unfilled and no position existing. Real fixtures, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { checkGroupLotStep, effectiveLotStep, effectiveMaxLot, groupStepOffGrid, riskCode } from "@/lib/risk";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("group-min-volume.test.ts: DB unreachable, skipping DB tests");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.groupSymbol.deleteMany({ where: { group: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; groupId: string; symbolId: string; symbolName: string };
// symbol minimum 0.01, step 0.01; group minimum 0.50 unless said otherwise
async function fixture(groupExtra?: Partial<Prisma.GroupUncheckedCreateInput>, groupMin: string | null = "0.50"): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `LotStep ${sfx}`, subdomain: `lotstep-${sfx}` } });
  brokers.push(b.id);
  const a = await prisma.adminUser.create({ data: { brokerId: b.id, email: `mv-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `MV${sfx.toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true, tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({
    data: { brokerId: b.id, name: `MV-${sfx}`, leverage: 100, category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true, minLotSize: groupMin ? D(groupMin) : null, ...groupExtra },
  });
  return { brokerId: b.id, adminId: a.id, groupId: g.id, symbolId: s.id, symbolName: name };
}
async function account(fx: Fx) {
  const n = `4${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "2")}`;
  return prisma.account.create({
    data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: `mv-${n}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", fullName: `MV ${n}`, accountMode: "LIVE", balance: D(1_000_000), leverage: 100 },
  });
}
const asAdmin = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
const asTrader = (fx: Fx, accountId: string) => vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId: fx.brokerId } as never);
async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function queued(fx: Fx, accountId: string, volume: string, status: "PENDING" | "REQUOTED" = "PENDING") {
  return prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D("100.10"), requotedPrice: status === "REQUOTED" ? D("100.20") : null, idempotencyKey: `mv:${randomUUID()}`, status },
  });
}
const order = (fx: Fx, volume: string, type: "MARKET" | "LIMIT" = "MARKET") => ({
  symbol: fx.symbolName, side: "BUY", type, volume, price: type === "LIMIT" ? "95.00" : "100.10", idempotencyKey: `mv:${randomUUID()}`,
});

describe("rules (pure)", () => {
  const sym = { minLot: D("0.01"), lotStep: D("0.01") };
  it("effective step is the larger of symbol and group; null = the symbol's", () => {
    expect(effectiveLotStep(D("0.01"), null).toString()).toBe("0.01");
    expect(effectiveLotStep(D("0.01"), D("0.05")).toString()).toBe("0.05");
    expect(effectiveLotStep(D("0.1"), D("0.05")).toString()).toBe("0.1");
  });
  it("effective max is the lesser of symbol and group", () => {
    expect(effectiveMaxLot(D(100), null).toString()).toBe("100");
    expect(effectiveMaxLot(D(100), D(5)).toString()).toBe("5");
    expect(effectiveMaxLot(D(3), D(5)).toString()).toBe("3");
  });
  it("null group step never refuses; a set step refuses off-grid volumes with a text starting 'volume '", () => {
    expect(checkGroupLotStep(D("0.07"), null, null, sym)).toBeNull();
    expect(checkGroupLotStep(D("0.05"), D("0.05"), D("0.05"), sym)).toBeNull();
    expect(checkGroupLotStep(D("0.10"), D("0.05"), D("0.05"), sym)).toBeNull();
    const msg = checkGroupLotStep(D("0.07"), D("0.05"), D("0.05"), sym);
    expect(msg).toBe("volume must be a multiple of 0.05 lots for this account");
    expect(riskCode(msg!)).toEqual({});
  });
  it("the grid starts at the effective minimum, decimal-exact", () => {
    expect(checkGroupLotStep(D("0.30"), D("0.05"), null, sym)).toContain("0.01 plus a multiple of 0.05");
    expect(checkGroupLotStep(D("0.06"), D("0.05"), null, sym)).toBeNull(); // 0.01 + 0.05
    expect(checkGroupLotStep(D("0.25"), D("0.1"), D("0.2"), { minLot: D("0.01"), lotStep: D("0.1") })).toBe("volume must be a multiple of 0.10 lots for this account");
    expect(checkGroupLotStep(D("0.30000000000000004"), D("0.1"), D("0.2"), { minLot: D("0.01"), lotStep: D("0.1") })).not.toBeNull();
  });
  it("save check: step must be a whole multiple of each symbol step; min must be on the step grid", () => {
    const syms = [{ name: "A", minLot: D("0.01"), lotStep: D("0.01") }, { name: "B", minLot: D("0.1"), lotStep: D("0.1") }];
    expect(groupStepOffGrid(D("0.05"), null, syms)).toEqual({ stepOff: ["B"], minOff: [] });
    expect(groupStepOffGrid(D("0.20"), null, syms)).toEqual({ stepOff: [], minOff: [] });
    expect(groupStepOffGrid(D("0.20"), D("0.30"), syms)).toEqual({ stepOff: [], minOff: ["A", "B"] });
    expect(groupStepOffGrid(D("0.10"), D("0.30"), syms)).toEqual({ stepOff: [], minOff: [] });
  });
});

describe("orders route (DB)", () => {
  it("group step 0.05: 0.05 and 0.10 accepted, 0.07 refused INVALID_VOLUME; max clamps", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ lotStep: D("0.05"), maxLotSize: D("0.50") }, "0.05");
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    for (const v of ["0.05", "0.10"]) {
      const r = await call(POST, "/api/trade/orders", "POST", order(fx, v));
      expect(r.status, JSON.stringify(r.json)).toBe(201);
    }
    const bad = await call(POST, "/api/trade/orders", "POST", order(fx, "0.07"));
    expect(bad.status).toBe(400);
    expect(bad.json).toMatchObject({ clientReason: "INVALID_VOLUME" }); // the internal sentence stays in the trace
    const big = await call(POST, "/api/trade/orders", "POST", order(fx, "0.55"));
    expect(big.status).toBe(400);
    expect(await prisma.order.count({ where: { accountId: acc.id } })).toBe(2);
  });
  it("null group step: unchanged behaviour (0.07 accepted)", async () => {
    if (!dbReachable) return;
    const fx = await fixture({}, null);
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", order(fx, "0.07"))).status).toBe(201);
  });
  it("staff manual open and dealer accept also refuse an off-step volume", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ lotStep: D("0.05"), category: "DEALING" }, "0.05");
    const acc = await account(fx);
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    const r = await call(POST, "/api/manage/positions", "POST", { accountId: acc.id, symbolId: fx.symbolId, side: "BUY", volume: "0.07" });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/^volume /);
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
    const o = await queued(fx, acc.id, "0.07");
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const d = await call(PATCH, `/api/manage/dealing-queue/${o.id}`, "PATCH", { action: "ACCEPT", fillMode: "MARKET" }, { id: o.id });
    expect(d.status).toBe(400);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING");
  });
});

describe("enforced next to every group min-lot check (static)", () => {
  it.each([
    "app/api/trade/orders/route.ts",
    "lib/pending-trigger.ts",
    "lib/coverage-pending.ts",
    "app/api/trade/orders/[id]/requote-response/route.ts",
    "app/api/manage/positions/route.ts",
    "app/api/manage/dealing-queue/[id]/route.ts",
    "app/api/manage/dealing-desk-toggle/route.ts",
  ])("%s", (file) => {
    const src = read(file);
    expect(src.match(/checkGroupLotStep\(/g)?.length).toBe(src.match(/checkGroupMinLot\(/g)?.length);
  });
  it("close paths never use the group step", () => {
    for (const f of ["app/api/trade/positions/[id]/close/route.ts", "app/api/manage/positions/[id]/close/route.ts"]) expect(read(f)).not.toContain("checkGroupLotStep");
  });
});

describe("trade/symbols fields (DB)", () => {
  it("minLot/maxLot/lotStep combined, symbol* own", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ lotStep: D("0.05"), maxLotSize: D("5") }, "0.50");
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { GET } = await import("@/app/api/trade/symbols/route");
    const find = async () => ((await (await (GET as () => Promise<Response>)()).json()).symbols as Record<string, string>[]).find((s) => s.name === fx.symbolName)!;
    const row = await find();
    expect(row).toMatchObject({ minLot: "0.5", symbolMinLot: "0.01", maxLot: "5", symbolMaxLot: "100", lotStep: "0.05", symbolLotStep: "0.01" });
    await prisma.group.update({ where: { id: fx.groupId }, data: { lotStep: null, maxLotSize: null } });
    expect(await find()).toMatchObject({ maxLot: "100", lotStep: "0.01" });
  });
});

describe("group save (POST / PATCH groups)", () => {
  const form = (extra: Record<string, unknown>) => ({ name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", ...extra });
  it("POST validates the step; saved, audited, listed", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const s2 = await prisma.symbol.create({ data: { name: `${fx.symbolName}B`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    symbols.push(s2.name);
    await prisma.brokerSymbol.create({ data: { brokerId: fx.brokerId, symbolId: s2.id, minLot: D("0.1"), maxLot: D(100), lotStep: D("0.1"), enabled: true } });
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/groups/route");
    for (const bad of ["0", "-1", "abc", "101", "0.123"]) expect((await call(POST, "/api/manage/groups", "POST", form({ lotStep: bad }))).status, bad).toBe(400);
    const off = await call(POST, "/api/manage/groups", "POST", form({ lotStep: "0.05" }));
    expect(off.status).toBe(400);
    expect(off.json).toMatchObject({ code: "GROUP_STEP_OFF_GRID", symbols: [s2.name] });
    const minOff = await call(POST, "/api/manage/groups", "POST", form({ lotStep: "0.20", minLotSize: "0.30" }));
    expect(minOff.status).toBe(400);
    expect(minOff.json.code).toBe("GROUP_STEP_MIN_OFF_GRID");
    const ok = await call(POST, "/api/manage/groups", "POST", form({ lotStep: "0.20", minLotSize: "0.40" }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.lotStep).toBe("0.2");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "GROUP_CREATED", entityId: ok.json.id } });
    expect((audit.newValue as Record<string, unknown>).lotStep).toBe("0.2");
    const none = await call(POST, "/api/manage/groups", "POST", form({}));
    expect(none.json.lotStep).toBe("");
  });
  it("PATCH: audited old/new, absent keeps, empty clears, GET lists it", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ lotStep: D("0.05") }, null);
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
    const g = await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } });
    const base = { name: g.name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", isDefault: false };
    const patch = (extra: Record<string, unknown>) => call(PATCH, `/api/manage/groups/${g.id}`, "PATCH", { ...base, ...extra }, { id: g.id });
    const set = await patch({ lotStep: "0.10" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    expect(set.json.lotStep).toBe("0.1");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "GROUP_CONFIG_UPDATED", entityId: g.id }, orderBy: { createdAt: "desc" } });
    expect((audit.oldValue as Record<string, unknown>).lotStep).toBe("0.05");
    expect((audit.newValue as Record<string, unknown>).lotStep).toBe("0.1");
    expect((await patch({})).status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).lotStep?.toString()).toBe("0.1");
    expect((await patch({ minLotSize: "0.25" })).json.code).toBe("GROUP_STEP_MIN_OFF_GRID"); // kept step re-checked against a new minimum
    const { GET } = await import("@/app/api/manage/groups/route");
    const list = await (await (GET as (r: NextRequest) => Promise<Response>)(new NextRequest("https://t.local/api/manage/groups"))).json();
    expect((list as { id: string; lotStep: string }[]).find((x) => x.id === g.id)?.lotStep).toBe("0.1");
    expect((await patch({ lotStep: "" })).status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).lotStep).toBeNull();
  });
});
