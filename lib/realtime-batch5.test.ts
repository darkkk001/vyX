import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Audit 2026-09-24 Batch 5 (real-time everywhere, docs/audit/2026-09-24/realtime-contract.md).
// Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));

import { effectiveAsk, spreadRuleFromPrice } from "@/lib/trade-api";
import { withConfigEvent } from "@/lib/config-events";
import { publishTradingEvent } from "@/lib/nats";
import { getAdminSession } from "@/lib/auth";
import { getAccountSession } from "@/lib/account-auth";

const D = (v: string | number) => new Prisma.Decimal(v);
const ROOT = path.resolve(import.meta.dirname, "..");
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("realtime-batch5.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => vi.mocked(publishTradingEvent).mockClear());

const brokers: string[] = [];
const symbols: string[] = [];
type Fx = { brokerId: string; groupId: string; symbolId: string; symbolName: string; accountId: string };

async function fixture(bid: string, ask: string): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `RT B5 ${sfx}`, subdomain: `rt5-${sfx}`, pricingEngineEnabled: true, dealingModeAt: null } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `RT${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D(bid), ask: D(ask), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `RT5-${sfx}`, leverage: 100, dealingMode: "AUTO" } });
  const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `rt5-${n}@test.local`, passwordHash: "x", fullName: "B5 Client", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbolName: sym.name, accountId: acc.id };
}
function asTrader(fx: Fx) {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
}
async function asAdmin(fx: Fx) {
  const a = await prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `rt5-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: fx.brokerId } as never);
}
async function priceRow(fx: Fx) {
  asTrader(fx);
  const { GET } = await import("@/app/api/trade/prices/route");
  const rows = (await (await GET()).json()) as { symbol: string; bid: string; ask: string; askMarkup: string; spreadRule?: "markup" | "target"; targetSpread?: string }[];
  const row = rows.find((r) => r.symbol === fx.symbolName);
  expect(row, "symbol in /api/trade/prices").toBeDefined();
  return row!;
}
async function buy(fx: Fx, quoted: number) {
  asTrader(fx);
  const { POST } = await import("@/app/api/trade/orders/route");
  const req = new NextRequest("https://t.local/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.01", price: quoted.toFixed(2), idempotencyKey: randomUUID() }) });
  const res = await POST(req);
  const json = await res.json();
  expect(res.status, JSON.stringify(json)).toBe(201);
  return (await prisma.position.findUniqueOrThrow({ where: { id: json.position.id } })).openPrice.toNumber();
}
const points = (buyPrice: number, bid: number) => Math.round((buyPrice - bid) * 100);

afterAll(async () => {
  if (!dbReachable) return;
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where }).catch(() => {});
    await prisma.transaction.deleteMany({ where }).catch(() => {});
    await prisma.position.deleteMany({ where }).catch(() => {});
    await prisma.order.deleteMany({ where }).catch(() => {});
    await prisma.account.deleteMany({ where }).catch(() => {});
    await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: { in: brokers } } } }).catch(() => {});
    await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
    await prisma.adminUser.deleteMany({ where }).catch(() => {});
    await prisma.group.deleteMany({ where }).catch(() => {});
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("quote = fill: the shared test vectors (C# SpreadRule tests use the same numbers)", () => {
  const rules = {
    M: spreadRuleFromPrice({ askMarkup: "0.20", spreadRule: "markup" }),
    T: spreadRuleFromPrice({ askMarkup: "0.12", spreadRule: "target", targetSpread: "0.30" }),
  };
  it("markup: 4456.35 / 4456.53 + 0.20 -> buy 4456.73, 38 points", () => {
    const b = effectiveAsk(rules, "M", 4456.53, 4456.35);
    expect(b).toBeCloseTo(4456.73, 6);
    expect(points(b, 4456.35)).toBe(38);
  });
  it("target 0.30, raw spread below it -> buy 4456.65, 30 points", () => {
    const b = effectiveAsk(rules, "T", 4456.53, 4456.35);
    expect(b).toBeCloseTo(4456.65, 6);
    expect(points(b, 4456.35)).toBe(30);
  });
  it("target 0.30, raw spread 0.45 above it -> buy at raw ask 4456.80, 45 points (the markup computed at the last poll is NOT reused)", () => {
    const b = effectiveAsk(rules, "T", 4456.8, 4456.35);
    expect(b).toBeCloseTo(4456.8, 6);
    expect(points(b, 4456.35)).toBe(45);
  });
  it("no rule known yet -> raw ask", () => {
    expect(effectiveAsk({}, "X", 1.2345, 1.2)).toBe(1.2345);
  });
});

describe("quote = fill, end to end: /api/trade/prices + effectiveAsk == the BUY fill price", () => {
  it("markup mode (group markup 2 pips = 0.20)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("4456.35", "4456.53");
    await prisma.groupSymbolConfig.create({ data: { groupId: fx.groupId, symbolId: fx.symbolId, spreadMarkup: D(2) } });
    const row = await priceRow(fx);
    expect(row.spreadRule).toBe("markup");
    const quoted = effectiveAsk({ [fx.symbolName]: spreadRuleFromPrice(row) }, fx.symbolName, Number(row.ask), Number(row.bid));
    expect(quoted).toBeCloseTo(4456.73, 6);
    expect(await buy(fx, quoted)).toBeCloseTo(quoted, 6);
  });

  it("target mode (target 3 pips = 0.30), raw spread below target", async () => {
    if (!dbReachable) return;
    const fx = await fixture("4456.35", "4456.53");
    await prisma.groupSymbolConfig.create({ data: { groupId: fx.groupId, symbolId: fx.symbolId, targetTotalSpreadPips: D(3) } });
    const row = await priceRow(fx);
    expect(row.spreadRule).toBe("target");
    expect(Number(row.targetSpread)).toBeCloseTo(0.3, 6);
    const quoted = effectiveAsk({ [fx.symbolName]: spreadRuleFromPrice(row) }, fx.symbolName, Number(row.ask), Number(row.bid));
    expect(quoted).toBeCloseTo(4456.65, 6);
    expect(await buy(fx, quoted)).toBeCloseTo(quoted, 6);
  });

  it("target mode, the raw spread widens AFTER the poll: the client's tick-time quote still equals the fill", async () => {
    if (!dbReachable) return;
    const fx = await fixture("4456.35", "4456.53");
    await prisma.groupSymbolConfig.create({ data: { groupId: fx.groupId, symbolId: fx.symbolId, targetTotalSpreadPips: D(3) } });
    const rule = spreadRuleFromPrice(await priceRow(fx)); // polled while raw spread was 0.18
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { ask: D("4456.80"), tickAt: new Date() } }); // tick: raw 0.45
    const quoted = effectiveAsk({ [fx.symbolName]: rule }, fx.symbolName, 4456.8, 4456.35);
    expect(quoted).toBeCloseTo(4456.8, 6);
    expect(await buy(fx, quoted)).toBeCloseTo(quoted, 6);
  });

  it("a markup change is visible on the very next /api/trade/prices read (no cache, no re-login)", async () => {
    if (!dbReachable) return;
    const fx = await fixture("4456.35", "4456.53");
    const cfg = await prisma.groupSymbolConfig.create({ data: { groupId: fx.groupId, symbolId: fx.symbolId, spreadMarkup: D(2) } });
    expect(Number((await priceRow(fx)).askMarkup)).toBeCloseTo(0.2, 6);
    await prisma.groupSymbolConfig.update({ where: { id: cfg.id }, data: { spreadMarkup: D(5) } });
    const row = await priceRow(fx);
    expect(Number(row.askMarkup)).toBeCloseTo(0.5, 6);
    const quoted = effectiveAsk({ [fx.symbolName]: spreadRuleFromPrice(row) }, fx.symbolName, Number(row.ask), Number(row.bid));
    expect(await buy(fx, quoted)).toBeCloseTo(quoted, 6);
  });
});

describe("ConfigChanged: every backoffice config write announces itself", () => {
  it("withConfigEvent publishes ConfigChanged for the admin's broker on 2xx only", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "a", role: "BROKER_ADMIN", brokerId: "brk1" } as never);
    const ok = withConfigEvent("pricing", async () => new Response(null, { status: 200 }));
    const bad = withConfigEvent("pricing", async () => new Response(null, { status: 400 }));
    await bad();
    expect(publishTradingEvent).not.toHaveBeenCalled();
    await ok();
    expect(publishTradingEvent).toHaveBeenCalledWith("ConfigChanged", { broker_id: "brk1", scope: "pricing" });
  });

  it("a real group halt: 200, ConfigChanged(groups) published, and /api/trade/me reports tradingState halted", async () => {
    if (!dbReachable) return;
    const fx = await fixture("100.00", "100.10");
    await asAdmin(fx);
    asTrader(fx);
    const me = await import("@/app/api/trade/me/route");
    expect((await (await (me.GET as unknown as () => Promise<Response>)()).json()).tradingState).toBe("open");
    const { PATCH } = await import("@/app/api/manage/groups/[id]/halt/route");
    const req = new NextRequest(`https://t.local/api/manage/groups/${fx.groupId}/halt`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ halted: true }) });
    const res = await (PATCH as unknown as (r: NextRequest, c: unknown) => Promise<Response>)(req, { params: Promise.resolve({ id: fx.groupId }) });
    expect(res.status).toBe(200);
    expect(publishTradingEvent).toHaveBeenCalledWith("ConfigChanged", { broker_id: fx.brokerId, scope: "groups" });
    asTrader(fx);
    expect((await (await (me.GET as unknown as () => Promise<Response>)()).json()).tradingState).toBe("halted");
  });

  it("broker close-only -> tradingState close_only; halt wins over close-only", async () => {
    if (!dbReachable) return;
    const fx = await fixture("100.00", "100.10");
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { closeOnlyAt: new Date() } });
    asTrader(fx);
    const me = await import("@/app/api/trade/me/route");
    expect((await (await (me.GET as unknown as () => Promise<Response>)()).json()).tradingState).toBe("close_only");
    await prisma.group.update({ where: { id: fx.groupId }, data: { tradingHaltedAt: new Date() } });
    expect((await (await (me.GET as unknown as () => Promise<Response>)()).json()).tradingState).toBe("halted");
  });

  it("every broker-config write route is wrapped", () => {
    const routes: [string, string[], string][] = [
      ["symbols/route.ts", ["PATCH"], "symbols"],
      ["symbols/[id]/sessions/route.ts", ["PUT"], "sessions"],
      ["risk/route.ts", ["PATCH"], "risk"],
      ["groups/route.ts", ["POST"], "groups"],
      ["groups/[id]/route.ts", ["PATCH", "DELETE"], "groups"],
      ["groups/[id]/halt/route.ts", ["PATCH"], "groups"],
      ["groups/[id]/symbols/route.ts", ["PUT"], "groups"],
      ["groups/[id]/pricing/route.ts", ["PATCH"], "pricing"],
      ["account-types/route.ts", ["POST"], "pricing"],
      ["account-types/[id]/route.ts", ["PATCH"], "pricing"],
      ["account-types/[id]/pricing/route.ts", ["PATCH"], "pricing"],
      ["dealing-desk-toggle/route.ts", ["PATCH"], "dealing"],
      ["mirror-rules/route.ts", ["POST"], "mirror"],
      ["mirror-rules/[id]/route.ts", ["PATCH"], "mirror"],
      ["payment-methods/route.ts", ["PATCH"], "payments"],
      ["admins/route.ts", ["POST"], "permissions"],
      ["admins/[id]/route.ts", ["PATCH"], "permissions"],
      ["settings/route.ts", ["PATCH"], "settings"],
      ["kyc-requests/[id]/route.ts", ["PATCH"], "kyc"],
      ["client-kyc-requests/[id]/route.ts", ["PATCH"], "kyc"],
    ];
    for (const [rel, methods, scope] of routes) {
      const src = readFileSync(path.join(ROOT, "app", "api", "manage", rel), "utf8");
      for (const m of methods) expect(src, rel).toContain(`export const ${m} = withConfigEvent("${scope}", `);
    }
  });
});

describe("gateway fan-out (services/api-gateway/src/ws.ts)", () => {
  const ws = readFileSync(path.join(ROOT, "services", "api-gateway", "src", "ws.ts"), "utf8");
  const trader = ws.slice(ws.indexOf("export async function attachTradingEventStream"), ws.indexOf("export async function attachAdminEventStream"));
  const admin = ws.slice(ws.indexOf("export async function attachAdminEventStream"));
  it("trader stream subscribes config.> and forwards broker-wide ConfigChanged to every socket of that broker", () => {
    expect(trader).toContain('nc.subscribe("config.>")');
    expect(trader).toContain("clientsByBroker.get(parsed.broker_id)");
    expect(trader).toContain("registerClient(ws, session.accountId, session.brokerId)");
  });
  it("admin stream subscribes config.> and margin.>", () => {
    expect(admin).toContain('nc.subscribe("config.>")');
    expect(admin).toContain('nc.subscribe("margin.>")');
  });
});
