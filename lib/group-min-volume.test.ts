import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Group minimum volume (owner 2026-10-06): the smallest order = max(symbol minimum, Group.minLotSize). Refused below it
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
import { checkGroupMinLot, effectiveMinLot, groupMinOffGrid, riskCode } from "@/lib/risk";

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
  const b = await prisma.broker.create({ data: { name: `MinVol ${sfx}`, subdomain: `minvol-${sfx}` } });
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
const MESSAGE = "The smallest trade allowed for this account is 0.50 lots.";

describe("effective minimum (pure)", () => {
  it("is the larger of the symbol and group minimums; null group = the symbol's", () => {
    expect(effectiveMinLot(D("0.01"), null).toString()).toBe("0.01");
    expect(effectiveMinLot(D("0.01"), D("0.5")).toString()).toBe("0.5");
    expect(effectiveMinLot(D("1"), D("0.5")).toString()).toBe("1");
  });
  it("refuses below it with a plain sentence that maps to GROUP_MIN_VOLUME; at or above passes", () => {
    expect(checkGroupMinLot(D("0.49"), D("0.5"), D("0.01"))).toBe(MESSAGE);
    expect(riskCode(MESSAGE)).toEqual({ code: "GROUP_MIN_VOLUME" });
    expect(checkGroupMinLot(D("0.50"), D("0.5"), D("0.01"))).toBeNull();
    expect(checkGroupMinLot(D("0.01"), null, D("0.01"))).toBeNull();
    expect(riskCode("volume exceeds this account's group max lot size of 5")).toEqual({});
  });
  it("finds the symbols a group minimum is off-grid for", () => {
    const syms = [
      { name: "A", minLot: D("0.01"), lotStep: D("0.01") },
      { name: "B", minLot: D("0.1"), lotStep: D("0.1") },
      { name: "C", minLot: D("1"), lotStep: D("1") }, // its own minimum is above the group's: not affected
    ];
    expect(groupMinOffGrid(D("0.25"), syms)).toEqual(["B"]);
    expect(groupMinOffGrid(D("0.30"), syms)).toEqual([]);
  });
});

describe("enforced next to every group max-lot check (static)", () => {
  it.each([
    "app/api/trade/orders/route.ts",
    "lib/pending-trigger.ts",
    "app/api/trade/orders/[id]/requote-response/route.ts",
    "app/api/manage/positions/route.ts",
    "app/api/manage/dealing-queue/[id]/route.ts",
    "app/api/manage/dealing-desk-toggle/route.ts",
  ])("%s", (file) => {
    const src = read(file);
    expect(src.match(/checkGroupMaxLot\(/g)?.length).toBe(src.match(/checkGroupMinLot\(/g)?.length);
    expect(src).toContain("riskCode(riskError)");
  });
});

describe("refused below the group minimum at every open path (DB)", () => {
  it("client placement, market and pending: 400 GROUP_MIN_VOLUME, nothing written; 0.50 passes", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    for (const type of ["MARKET", "LIMIT"] as const) {
      const r = await call(POST, "/api/trade/orders", "POST", order(fx, "0.49", type));
      expect(r.status).toBe(400);
      expect(r.json).toMatchObject({ code: "GROUP_MIN_VOLUME", error: MESSAGE });
    }
    expect(await prisma.order.count({ where: { accountId: acc.id } })).toBe(0);
    expect((await call(POST, "/api/trade/orders", "POST", order(fx, "0.50"))).status).toBe(201);
  });

  it("pending trigger: an order resting from before the minimum was raised is rejected, never filled", async () => {
    if (!dbReachable) return;
    const fx = await fixture({}, null);
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/route");
    expect((await call(POST, "/api/trade/orders", "POST", order(fx, "0.10", "LIMIT"))).status).toBe(201);
    await prisma.group.update({ where: { id: fx.groupId }, data: { minLotSize: D("0.50") } });
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D("94.90"), ask: D("95.00"), tickAt: new Date() } });
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: acc.id } });
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    const out = await triggerPendingOrder(o.id, "95.00", "server");
    expect(out).toMatchObject({ kind: "rejected", reason: MESSAGE, detail: { code: "GROUP_MIN_VOLUME" } });
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("dealer accept: 400 GROUP_MIN_VOLUME, order stays PENDING, no position", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ category: "DEALING" });
    const acc = await account(fx);
    const o = await queued(fx, acc.id, "0.10");
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    const r = await call(PATCH, `/api/manage/dealing-queue/${o.id}`, "PATCH", { action: "ACCEPT", fillMode: "MARKET" }, { id: o.id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("GROUP_MIN_VOLUME");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("client accepting a requote: 400 GROUP_MIN_VOLUME, order stays REQUOTED, no position", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ category: "DEALING" });
    const acc = await account(fx);
    const o = await queued(fx, acc.id, "0.10", "REQUOTED");
    asTrader(fx, acc.id);
    const { POST } = await import("@/app/api/trade/orders/[id]/requote-response/route");
    const r = await call(POST, `/api/trade/orders/${o.id}/requote-response`, "POST", { accept: true }, { id: o.id });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("GROUP_MIN_VOLUME");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).status).toBe("REQUOTED");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });

  it("desk-off flush: the small order is skipped with GROUP_MIN_VOLUME, a big enough one fills", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ category: "DEALING", groupType: "DEALING", dealingMode: "INHERIT" });
    const acc = await account(fx);
    const small = await queued(fx, acc.id, "0.10");
    const big = await queued(fx, acc.id, "0.50");
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-desk-toggle/route");
    const r = await call(PATCH, "/api/manage/dealing-desk-toggle", "PATCH", { dealerOn: false });
    expect(r.status).toBe(200);
    const byId = new Map((r.json.flushed as { orderId: string; status: string; code?: string }[]).map((x) => [x.orderId, x]));
    expect(byId.get(small.id)).toMatchObject({ status: "skipped", code: "GROUP_MIN_VOLUME" });
    expect(byId.get(big.id)?.status).toBe("filled");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: small.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(1);
  });

  it("staff manual open: 400 GROUP_MIN_VOLUME, no position", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const acc = await account(fx);
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/positions/route");
    const r = await call(POST, "/api/manage/positions", "POST", { accountId: acc.id, symbolId: fx.symbolId, side: "BUY", volume: "0.10" });
    expect(r.status).toBe(400);
    expect(r.json.code).toBe("GROUP_MIN_VOLUME");
    expect(await prisma.position.count({ where: { accountId: acc.id } })).toBe(0);
  });
});

describe("the terminal is told the effective minimum (trade/symbols)", () => {
  it("minLot = max(symbol, group) for this account; symbolMinLot stays the symbol's own", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const acc = await account(fx);
    asTrader(fx, acc.id);
    const { GET } = await import("@/app/api/trade/symbols/route");
    const res = await (GET as () => Promise<Response>)();
    const row = ((await res.json()).symbols as { name: string; minLot: string; symbolMinLot: string }[]).find((s) => s.name === fx.symbolName)!;
    expect(row.minLot).toBe("0.5");
    expect(row.symbolMinLot).toBe("0.01");
    await prisma.group.update({ where: { id: fx.groupId }, data: { minLotSize: null } });
    const row2 = ((await (await (GET as () => Promise<Response>)()).json()).symbols as { name: string; minLot: string }[]).find((s) => s.name === fx.symbolName)!;
    expect(row2.minLot).toBe("0.01");
  });
});

describe("group save (POST / PATCH groups)", () => {
  const form = (extra: Record<string, unknown>) => ({ name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", ...extra });

  it("POST: positive, at most the max, on every symbol's grid (MIN_VOLUME_STEP lists the symbols); saved and audited", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    // a second symbol with a coarser grid: 0.1 + n x 0.1
    const s2 = await prisma.symbol.create({ data: { name: `${fx.symbolName}B`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    symbols.push(s2.name);
    await prisma.brokerSymbol.create({ data: { brokerId: fx.brokerId, symbolId: s2.id, minLot: D("0.1"), maxLot: D(100), lotStep: D("0.1"), enabled: true } });
    asAdmin(fx);
    const { POST } = await import("@/app/api/manage/groups/route");
    expect((await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "0" }))).status).toBe(400);
    expect((await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "-1" }))).status).toBe(400);
    expect((await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "abc" }))).status).toBe(400);
    expect((await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "6", maxLotSize: "5" }))).status).toBe(400);
    const off = await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "0.25" }));
    expect(off.status).toBe(400);
    expect(off.json).toMatchObject({ code: "MIN_VOLUME_STEP", symbols: [s2.name] });
    expect(String(off.json.error)).toContain(s2.name);
    const ok = await call(POST, "/api/manage/groups", "POST", form({ minLotSize: "0.30", maxLotSize: "5" }));
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);
    expect(ok.json.minLotSize).toBe("0.3");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "GROUP_CREATED", entityId: ok.json.id } });
    expect((audit.newValue as Record<string, unknown>).minLotSize).toBe("0.3");
  });

  it("PATCH: old and new value audited; absent keeps it (older forms); empty clears; a max below the kept minimum is refused; GET returns it", async () => {
    if (!dbReachable) return;
    const fx = await fixture({}, "0.20");
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
    const g = await prisma.group.findUniqueOrThrow({ where: { id: fx.groupId } });
    const base = { name: g.name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", isDefault: false };
    const patch = (extra: Record<string, unknown>) => call(PATCH, `/api/manage/groups/${g.id}`, "PATCH", { ...base, ...extra }, { id: g.id });

    const set = await patch({ minLotSize: "0.40" });
    expect(set.status, JSON.stringify(set.json)).toBe(200);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "GROUP_CONFIG_UPDATED", entityId: g.id }, orderBy: { createdAt: "desc" } });
    expect((audit.oldValue as Record<string, unknown>).minLotSize).toBe("0.2");
    expect((audit.newValue as Record<string, unknown>).minLotSize).toBe("0.4");

    expect((await patch({})).status).toBe(200); // an older form: no field at all
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).minLotSize?.toString()).toBe("0.4");
    const lowMax = await patch({ maxLotSize: "0.30" });
    expect(lowMax.status).toBe(400);
    expect((await patch({ minLotSize: "0.25" })).json.code).toBeUndefined(); // on the 0.01 grid: fine
    expect((await patch({ minLotSize: "0.255" })).status).toBe(400); // 2 decimals at most

    const { GET } = await import("@/app/api/manage/groups/route");
    const list = await (await (GET as (r: NextRequest) => Promise<Response>)(new NextRequest("https://t.local/api/manage/groups"))).json();
    expect((list as { id: string; minLotSize: string }[]).find((x) => x.id === g.id)?.minLotSize).toBe("0.25");

    expect((await patch({ minLotSize: "" })).status).toBe(200);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: g.id } })).minLotSize).toBeNull();
  });
});
