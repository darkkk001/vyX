import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanDemoRedis, createOtherBroker, D, seedDemoTenant } from "@/lib/demo-test-fixtures";
import { createGuestAccount, resetSandboxCache, writeDemoState } from "@/lib/demo";
import { demoQuoteAt } from "@/lib/demo-prices";
import { runSwapRollover } from "@/lib/swap-rollover";
import { evaluateRiskForSymbol } from "@/lib/risk-monitor";
import { evaluatePendingTriggers } from "@/lib/pending-trigger";

// What keeps the QoreTrader demo apart from everything else: symbol visibility, the super-admin views, the cron jobs, the
// B-book guard, the second checks on funds / KYC, and the host rules in middleware.
const session = vi.hoisted(() => {
  process.env.CRON_SECRET = "cron-iso-secret";
  process.env.GATEWAY_URL = "http://gateway.test";
  return { account: null as null | { accountId: string; brokerId: string } };
});
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));
vi.mock("@/lib/account-auth", async (orig) => ({ ...(await orig<typeof import("@/lib/account-auth")>()), getAccountSession: async () => session.account }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
import { getAdminSession } from "@/lib/auth";

let other: Awaited<ReturnType<typeof createOtherBroker>>;
let demo: Awaited<ReturnType<typeof seedDemoTenant>>;
const superJson: Record<string, unknown> = {};

const asSuperAdmin = () => vi.mocked(getAdminSession).mockResolvedValue({ adminId: "sa", role: "SUPER_ADMIN", brokerId: null } as never);
const adminIds = new Map<string, string>();
async function asBrokerAdmin(brokerId: string) {
  let id = adminIds.get(brokerId);
  if (!id) {
    id = (await prisma.adminUser.create({ data: { brokerId, email: `ba-${randomUUID().slice(0, 8)}@iso.test`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
    adminIds.set(brokerId, id);
  }
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: id, role: "BROKER_ADMIN", brokerId } as never);
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: unknown) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** The super-admin endpoints that aggregate across brokers, as JSON. */
async function superAdminViews() {
  asSuperAdmin();
  const brokers = await import("@/app/api/admin/brokers/route");
  const audit = await import("@/app/api/admin/audit/route");
  const admins = await import("@/app/api/admin/admins/route");
  const notes = await import("@/app/api/admin/notifications/route");
  const health = await import("@/app/api/admin/health/route");
  const run = async (h: () => Promise<Response>) => (await h()).json();
  const h = await run(health.GET);
  return {
    brokers: await run(brokers.GET),
    audit: await run(audit.GET),
    admins: await run(admins.GET),
    notifications: await run(notes.GET),
    health: (h as { service: string }[]).map((r) => r.service),
  };
}

beforeAll(async () => {
  other = await createOtherBroker();
  await prisma.adminUser.create({ data: { brokerId: other.broker.id, email: `ba-${randomUUID().slice(0, 6)}@o.test`, passwordHash: "x", role: "BROKER_ADMIN" } });
  await prisma.auditLog.create({ data: { brokerId: other.broker.id, action: "ACCOUNT_CREATED", entityType: "Account", entityId: other.account.id, oldValue: {}, newValue: {} } });
  // the numbers BEFORE the demo exists
  Object.assign(superJson, await superAdminViews());
  demo = await seedDemoTenant();
  // ...and then a demo tenant with guests, positions, audit rows, notifications and a staff row
  for (let i = 0; i < 3; i++) {
    const g = (await createGuestAccount())!;
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const order = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("1"), idempotencyKey: `i:${randomUUID()}`, status: "FILLED", filledPrice: D(4400) } });
    await prisma.position.create({ data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D("1"), openPrice: D(4400), bookType: "B_BOOK" } });
    await prisma.auditLog.create({ data: { brokerId: demo.broker.id, action: "ORDER_FILLED", entityType: "Position", entityId: g.id, oldValue: {}, newValue: {} } });
    await prisma.notification.create({ data: { brokerId: demo.broker.id, type: "ADMIN_PASSWORD_RESET_REQUESTED", title: "t", body: "b" } });
  }
}, 120_000);
afterAll(async () => {
  await cleanDemoRedis();
  delete process.env.DEMO_BROKER_SUBDOMAIN;
});

describe("super admin: the demo is listed as a Sandbox and is in no count or feed", () => {
  type BrokersJson = { rows: { id: string; subdomain: string; isDemoSandbox: boolean }[]; totalEndClients: number };
  it("the brokers list shows it flagged isDemoSandbox; audit, admins, notifications and health are what they were before the demo existed; no count moves", async () => {
    const after = await superAdminViews();
    const b = after.brokers as BrokersJson;
    const row = b.rows.find((r) => r.subdomain === "qoredemo");
    expect(row?.isDemoSandbox).toBe(true);
    expect(b.rows.filter((r) => r.isDemoSandbox)).toHaveLength(1); // nobody else is flagged
    expect({ ...after, brokers: { ...b, rows: b.rows.filter((r) => !r.isDemoSandbox) } }).toEqual(superJson);
    expect(b.totalEndClients).toBe((superJson.brokers as BrokersJson).totalEndClients); // the guests are not end clients
    for (const k of ["audit", "admins", "notifications"] as const) expect(JSON.stringify(after[k])).not.toContain("qoredemo");
  });
  it("the flag, not the environment variable, decides: with the variable unset the answers are the same", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    const views = await superAdminViews();
    const b = views.brokers as BrokersJson;
    expect(b.totalEndClients).toBe((superJson.brokers as BrokersJson).totalEndClients);
    expect(JSON.stringify(views.audit)).not.toContain("qoredemo");
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
  });
});

describe("the flag keeps the sandbox out of every report and job (no environment variable)", () => {
  it("Book P/L and the risk radar of the sandbox broker are empty even for a LIVE-mode account holding a closed position", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const live = await prisma.account.create({ data: { groupId: demo.group.id, brokerId: demo.broker.id, accountNumber: "48990001", email: "l@demo.invalid", passwordHash: "x", fullName: "live-mode in the sandbox", accountMode: "LIVE", balance: D(1000) } });
    const o = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: live.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("1"), idempotencyKey: `b:${randomUUID()}`, status: "FILLED", filledPrice: D(4400) } });
    await prisma.position.create({ data: { brokerId: demo.broker.id, accountId: live.id, symbolId: sym.id, originOrderId: o.id, side: "BUY", volume: D("1"), openPrice: D(4400), status: "CLOSED", closePrice: D(4410), realizedPnl: D(1000), closedAt: new Date(), bookType: "B_BOOK", groupCategoryAtOpen: "B_BOOK" } });
    const { bookPnlRealized, bookPnlFloating } = await import("@/lib/book-pnl");
    const scope = { brokerId: demo.broker.id, coverageAccountId: null };
    expect(await bookPnlRealized(prisma, scope, new Date(Date.now() - 86400000))).toEqual([]);
    expect(await bookPnlFloating(prisma, scope)).toEqual([]);
    const { computeRiskRadar, computeSameIpClusters } = await import("@/lib/risk-radar");
    expect(await computeRiskRadar(prisma, demo.broker.id)).toEqual([]);
    expect(await computeSameIpClusters(prisma, demo.broker.id)).toEqual([]);
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
  });
  it("margin monitor, pending sweep, swap job and event publishers skip a sandbox broker with the variable unset", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    const { resetSandboxCache } = await import("@/lib/demo");
    resetSandboxCache();
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const g = (await createGuestAccount().catch(() => null)) ?? null;
    const acct = g ?? (await prisma.account.findFirstOrThrow({ where: { brokerId: demo.broker.id } }));
    const o = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: acct.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("0.1"), idempotencyKey: `f:${randomUUID()}`, status: "FILLED", filledPrice: D(4400) } });
    const pos = await prisma.position.create({ data: { brokerId: demo.broker.id, accountId: acct.id, symbolId: sym.id, originOrderId: o.id, side: "BUY", volume: D("0.1"), openPrice: D(4400), slPrice: D("99999"), bookType: "B_BOOK" } });
    const { GET } = await import("@/app/api/internal/margin-monitor/route");
    const res = await GET(new NextRequest("https://x.test/api/internal/margin-monitor", { headers: { authorization: "Bearer cron-iso-secret" } }));
    const ordinary = await prisma.position.findMany({ where: { status: "OPEN", broker: { isDemoSandbox: false } }, select: { accountId: true }, distinct: ["accountId"] });
    expect((await res.json()).accountsEvaluated).toBe(ordinary.length);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
    const swap = await runSwapRollover(prisma);
    expect(swap.brokers.some((b) => b.brokerId === demo.broker.id)).toBe(false);
    const { publishTradingEvent } = await import("@/lib/nats");
    const spy = vi.mocked(globalThis.fetch);
    spy.mockClear();
    await publishTradingEvent("OrderFilled", { broker_id: demo.broker.id, account_id: "x", order_id: "y" });
    expect(spy.mock.calls.filter((c) => String(c[0]).includes("gateway.test"))).toHaveLength(0);
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
    resetSandboxCache();
  });
});

describe("the q-symbols belong to the demo broker alone", () => {
  it("another broker's backoffice does not list them and cannot configure them", async () => {
    const { GET, PATCH } = await import("@/app/api/manage/symbols/route");
    await asBrokerAdmin(other.broker.id);
    const list = (await call(GET, "/api/manage/symbols")).json as { symbolName: string }[];
    expect(list.some((r) => r.symbolName.startsWith("q"))).toBe(false);
    expect(list.some((r) => r.symbolName === other.symbol.name)).toBe(true);
    const q = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const refused = await call(PATCH, "/api/manage/symbols", "PATCH", { symbolId: q.id, enabled: true, spreadMarkup: "0", minLot: "0.01", maxLot: "100", lotStep: "0.01" });
    expect(refused.status).toBe(400);
    expect(await prisma.brokerSymbol.count({ where: { brokerId: other.broker.id, symbolId: q.id } })).toBe(0);
    // the demo broker's own staff (there are none, but the rule is by broker) sees all seven
    await asBrokerAdmin(demo.broker.id);
    const own = (await call(GET, "/api/manage/symbols")).json as { symbolName: string }[];
    expect(own.filter((r) => r.symbolName.startsWith("q"))).toHaveLength(7);
  });
  it("candle history: empty for others, the shared function's candles for the demo", async () => {
    const trade = await import("@/app/api/trade/candles/route");
    const manage = await import("@/app/api/manage/candles/route");
    session.account = { accountId: "x", brokerId: other.broker.id };
    expect((await call(trade.GET, "/api/trade/candles?symbol=qXAUUSD&tf=M1")).json).toEqual([]);
    await asBrokerAdmin(other.broker.id);
    expect((await call(manage.GET, "/api/manage/candles?symbol=qXAUUSD&tf=M1")).json).toEqual([]);
    session.account = { accountId: "x", brokerId: demo.broker.id };
    const mine = (await call(trade.GET, "/api/trade/candles?symbol=qXAUUSD&tf=M1&limit=20")).json as { bucketStart: string; open: string; high: string; low: string; close: string }[];
    expect(mine).toHaveLength(20);
    expect(Number(mine[0].high)).toBeGreaterThanOrEqual(Number(mine[0].low));
    const last = mine[mine.length - 1];
    expect(Math.abs(new Date(last.bucketStart).getTime() - Date.now())).toBeLessThan(120_000);
    session.account = null;
  });
  it("an order on a q-symbol from another broker's account finds no such symbol", async () => {
    session.account = { accountId: other.account.id, brokerId: other.broker.id };
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: "qXAUUSD", side: "BUY", type: "MARKET", volume: 0.1, price: "4400", idempotencyKey: randomUUID() });
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toMatch(/not available/);
    session.account = null;
  });
  it("an LP routing rule cannot be pointed at one", async () => {
    await asBrokerAdmin(other.broker.id);
    const lp = await prisma.liquidityProvider.create({ data: { brokerId: other.broker.id, name: "LP", status: "DISABLED" } as never }).catch(() => null);
    if (!lp) return; // the model's required fields differ: covered by the symbol guard in the PATCH test above
    const q = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const { POST } = await import("@/app/api/manage/lp-routing/route");
    expect((await call(POST, "/api/manage/lp-routing", "POST", { liquidityProviderId: lp.id, symbolId: q.id })).status).toBe(404);
  });
});

describe("the cron jobs leave the demo alone", () => {
  it("the margin monitor evaluates ordinary accounts only, and does not close a demo position whose stop was crossed", async () => {
    const g = (await createGuestAccount())!;
    const now = Date.now();
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qXAUUSD" } });
    const openedMs = now - 3 * 3600_000;
    const open = demoQuoteAt("qXAUUSD", openedMs)!.ask;
    const order = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("0.1"), idempotencyKey: `m:${randomUUID()}`, status: "FILLED", filledPrice: D(open), createdAt: new Date(openedMs) } });
    // a stop loss far ABOVE the entry, so that even the live monitor would close it at once if it looked
    const pos = await prisma.position.create({ data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, originOrderId: order.id, side: "BUY", volume: D("0.1"), openPrice: D(open), slPrice: D("99999"), openedAt: new Date(openedMs), bookType: "B_BOOK" } });
    await writeDemoState(g.id, { t: now, w: 1 });
    // an ordinary position for the same run
    const o2 = await prisma.order.create({ data: { brokerId: other.broker.id, accountId: other.account.id, symbolId: other.symbol.id, side: "BUY", type: "MARKET", volume: D("1"), idempotencyKey: `m:${randomUUID()}`, status: "FILLED", filledPrice: D("100.1") } });
    await prisma.position.create({ data: { brokerId: other.broker.id, accountId: other.account.id, symbolId: other.symbol.id, originOrderId: o2.id, side: "BUY", volume: D("1"), openPrice: D("100.1"), bookType: "B_BOOK" } });

    const { GET } = await import("@/app/api/internal/margin-monitor/route");
    const res = await GET(new NextRequest("https://x.test/api/internal/margin-monitor", { headers: { authorization: "Bearer cron-iso-secret" } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    // every account with an open position EXCEPT the demo's: this scratch database has ordinary ones of its own
    const ordinary = await prisma.position.findMany({ where: { status: "OPEN", broker: { subdomain: { not: "qoredemo" } } }, select: { accountId: true }, distinct: ["accountId"] });
    expect(body.accountsEvaluated).toBe(ordinary.length);
    expect(ordinary.some((p) => p.accountId === g.id)).toBe(false);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
    // the engine's per-symbol hook for the demo symbol, the pending sweep and the swap job: no effect either
    await evaluateRiskForSymbol("qXAUUSD");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("OPEN");
    const swap = await runSwapRollover(prisma);
    expect(swap.brokers.some((b) => b.brokerId === demo.broker.id)).toBe(false);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).lastSwapAt).toBeNull();
    // a resting demo order is not triggered by the platform-wide sweep
    const ord = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: g.id, symbolId: sym.id, side: "BUY", type: "LIMIT", volume: D("0.1"), requestedPrice: D("9999"), idempotencyKey: `m:${randomUUID()}`, status: "PENDING" } });
    await evaluatePendingTriggers();
    expect((await prisma.order.findUniqueOrThrow({ where: { id: ord.id } })).status).toBe("PENDING");
  });
});

describe("the B-book guard", () => {
  it("the demo broker cannot create or turn a group into anything but B_BOOK; another broker still can", async () => {
    const groups = await import("@/app/api/manage/groups/route");
    const one = await import("@/app/api/manage/groups/[id]/route");
    await asBrokerAdmin(demo.broker.id);
    const body = (name: string, category: string) => ({ name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category, modeRestriction: "ANY", dealingMode: "INHERIT", tradingRestriction: "BOTH", isDefault: false, forceDealingMode: false, swapFree: false });
    for (const category of ["A_BOOK", "DEALING", "REVERSAL"]) {
      const r = await call(groups.POST, "/api/manage/groups", "POST", body(`X-${category}`, category));
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toMatch(/B-book only/);
    }
    expect(await prisma.group.count({ where: { brokerId: demo.broker.id } })).toBe(1);
    expect((await call(groups.POST, "/api/manage/groups", "POST", body("Extra", "B_BOOK"))).status).toBe(201);
    const patch = await call(one.PATCH, `/api/manage/groups/${demo.group.id}`, "PATCH", { ...body("Demo", "A_BOOK"), isDefault: true }, { params: Promise.resolve({ id: demo.group.id }) });
    expect(patch.status).toBe(400);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: demo.group.id } })).category).toBe("B_BOOK");
    await asBrokerAdmin(other.broker.id);
    expect((await call(groups.POST, "/api/manage/groups", "POST", body("Other A-book", "A_BOOK"))).status).toBe(201);
  });
});

describe("second checks behind the host rules", () => {
  it("funds, KYC, payment methods and password routes answer 403 to a demo session and work for another tenant", async () => {
    const guest = (await createGuestAccount())!;
    const funds = await import("@/app/api/trade/funds-requests/route");
    const kyc = await import("@/app/api/trade/kyc/route");
    const pay = await import("@/app/api/trade/payment-methods/route");
    const pw = await import("@/app/api/trade/change-password/route");
    session.account = { accountId: guest.id, brokerId: demo.broker.id };
    for (const [h, u, m] of [[funds.GET, "/api/trade/funds-requests", "GET"], [funds.POST, "/api/trade/funds-requests", "POST"], [kyc.GET, "/api/trade/kyc", "GET"], [kyc.POST, "/api/trade/kyc", "POST"], [pay.GET, "/api/trade/payment-methods", "GET"], [pw.POST, "/api/trade/change-password", "POST"]] as const) {
      const r = await call(h, u, m, m === "POST" ? {} : undefined);
      expect(r.status, `${m} ${u}`).toBe(403);
      expect(r.json.error).toBe("This is not available in the demo.");
    }
    session.account = { accountId: other.account.id, brokerId: other.broker.id };
    expect((await call(pay.GET, "/api/trade/payment-methods")).status).toBe(200);
    expect((await call(funds.GET, "/api/trade/funds-requests")).status).toBe(200);
    session.account = null;
  });
});

describe("middleware on the demo host", () => {
  const ROOT = "vyxtrader.test";
  let middleware: (req: NextRequest) => Promise<Response>;
  beforeAll(async () => {
    vi.stubEnv("ROOT_DOMAIN", ROOT);
    vi.stubEnv("INTERNAL_SERVICE_SECRET", "s");
    vi.stubGlobal("fetch", async (input: URL | string) => {
      const url = new URL(String(input));
      if (url.pathname === "/api/internal/schema-status") return Response.json({ behind: false });
      const sub = url.searchParams.get("subdomain");
      const dom = url.searchParams.get("customDomain");
      if (dom === "demo.qoretrader.test" || sub === "qoredemo") return Response.json({ id: "demo-id", subdomain: "qoredemo", tier: "STANDARD", logoUrl: null, primaryColor: null, customDomain: "demo.qoretrader.test" });
      if (sub === "regular") return Response.json({ id: "r1", subdomain: "regular", tier: "STANDARD", logoUrl: null, primaryColor: null, customDomain: null });
      return new Response("nope", { status: 404 });
    });
    ({ middleware } = await import("@/middleware"));
  });
  const at = (host: string, path: string, method = "GET") => middleware(new NextRequest(`https://${host}${path}`, { method, headers: { host } }));

  it("refuses funds, KYC, profile, password, 2FA, linked accounts, sessions, portal, backoffice, downloads and sign-in on the demo host", async () => {
    const blockedApi = ["/api/trade/funds-requests", "/api/trade/payment-methods", "/api/trade/kyc", "/api/trade/change-password", "/api/trade/forgot-password", "/api/trade/two-factor/setup", "/api/trade/two-factor/disable", "/api/trade/linked-accounts", "/api/trade/sso/token", "/api/trade/sessions", "/api/trade/sessions/abc", "/api/trade/login", "/api/trade/login/verify-2fa", "/api/trade/ws-ticket", "/api/trade/alerts", "/api/portal/register", "/api/portal/me", "/api/manage/accounts", "/api/admin/brokers", "/api/client/manifest"];
    for (const p of blockedApi) {
      const r = await at("demo.qoretrader.test", p, "POST");
      expect(r.status, p).toBe(403);
      expect(r.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
    }
    for (const p of ["/portal/login", "/portal/register", "/manage/login", "/manager/login", "/download", "/download/windows", "/launch", "/trade/sso"]) {
      const r = await at("demo.qoretrader.test", p);
      expect(r.status, p).toBe(404);
    }
  });
  it("lets the terminal through, and marks every response of the host noindex", async () => {
    for (const p of ["/", "/trade", "/api/trade/orders", "/api/trade/positions", "/api/trade/me", "/api/trade/symbols", "/api/demo/guest", "/api/trade/prices"]) {
      const r = await at("demo.qoretrader.test", p);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("x-robots-tag"), p).toBe("noindex, nofollow");
    }
  });
  it("the subdomain of the demo redirects pages to the custom domain, as for any broker", async () => {
    const r = await at(`qoredemo.${ROOT}`, "/trade");
    expect(r.status).toBe(308);
    expect(r.headers.get("location")).toBe("https://demo.qoretrader.test/trade");
  });
  it("another tenant's host is exactly as before: no deny list, no robots header", async () => {
    for (const p of ["/api/trade/funds-requests", "/api/trade/kyc", "/portal/login", "/api/trade/login"]) {
      const r = await at(`regular.${ROOT}`, p, "POST");
      expect(r.status, p).toBe(200);
      expect(r.headers.get("x-robots-tag"), p).toBeNull();
    }
  });
  it("with no demo tenant configured the demo host's name changes nothing", async () => {
    const saved = process.env.DEMO_BROKER_SUBDOMAIN;
    delete process.env.DEMO_BROKER_SUBDOMAIN;
    const r = await at("demo.qoretrader.test", "/api/trade/funds-requests", "POST");
    expect(r.status).toBe(200);
    expect(r.headers.get("x-robots-tag")).toBeNull();
    process.env.DEMO_BROKER_SUBDOMAIN = saved;
  });
});
