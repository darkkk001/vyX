import "dotenv/config";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { cleanDemoRedis, D, seedDemoTenant } from "@/lib/demo-test-fixtures";
import { createGuestAccount } from "@/lib/demo";
import { demoQuoteAt } from "@/lib/demo-prices";
import { displayCurrency } from "@/lib/demo-policy";
import { FxRateUnavailableError } from "@/lib/fx";

// "QJP" is the demo's INTERNAL quote currency for USDJPY (a private conversion pair, lib/demo-prices.ts). Nobody may ever see it:
// every place a symbol's quote currency, or the conversion pair, can reach a screen must say JPY. This renders / serialises each
// such surface for qUSDJPY and fails on "QJP".
const session = vi.hoisted(() => ({ account: null as null | { accountId: string; brokerId: string } }));
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));
vi.mock("@/lib/account-auth", async (orig) => ({ ...(await orig<typeof import("@/lib/account-auth")>()), getAccountSession: async () => session.account }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_s: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined), withTradingEventBuffer: (_b: unknown, f: () => unknown) => f(), deferTradingEvents: (f: () => unknown) => f() }));
import { getAdminSession } from "@/lib/auth";

let demo: Awaited<ReturnType<typeof seedDemoTenant>>;
let guest: { id: string };

beforeAll(async () => {
  demo = await seedDemoTenant();
  guest = (await createGuestAccount())!;
  session.account = { accountId: guest.id, brokerId: demo.broker.id };
  // an open USDJPY position, so that backoffice position rows carry the pair
  const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qUSDJPY" } });
  const q = demoQuoteAt("qUSDJPY", Date.now())!;
  const o = await prisma.order.create({ data: { brokerId: demo.broker.id, accountId: guest.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D("0.1"), idempotencyKey: "qjp-1", status: "FILLED", filledPrice: D(q.ask) } });
  await prisma.position.create({ data: { brokerId: demo.broker.id, accountId: guest.id, symbolId: sym.id, originOrderId: o.id, side: "BUY", volume: D("0.1"), openPrice: D(q.ask), bookType: "B_BOOK" } });
}, 120_000);
afterAll(async () => {
  await cleanDemoRedis();
  delete process.env.DEMO_BROKER_SUBDOMAIN;
});

async function call(handler: unknown, url: string, method = "GET", body?: unknown) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest) => Promise<Response>)(req);
  return { status: res.status, text: await res.text() };
}
const noQjp = (label: string, text: string) => expect(text, label).not.toMatch(/QJP/i);

describe("the demo's USDJPY never shows QJP", () => {
  it("the symbol list a terminal renders says JPY", async () => {
    const { GET } = await import("@/app/api/trade/symbols/route");
    const r = await call(GET, "/api/trade/symbols");
    expect(r.status).toBe(200);
    noQjp("/api/trade/symbols", r.text);
    const jpy = (JSON.parse(r.text) as { symbols: { name: string; quoteCurrency: string }[] }).symbols.find((s) => s.name === "qUSDJPY");
    expect(jpy?.quoteCurrency).toBe("JPY");
  });
  it("the prices answer, its conversion block and its rates say JPY (USDJPY, never USDQJP)", async () => {
    const { GET } = await import("@/app/api/trade/prices/route");
    const r = await call(GET, "/api/trade/prices?fx=1");
    expect(r.status).toBe(200);
    noQjp("/api/trade/prices?fx=1", r.text);
    const fx = (JSON.parse(r.text) as { fx: { quotes: { symbol: string }[]; rates: Record<string, string> } }).fx;
    expect(fx.quotes.map((q) => q.symbol)).toContain("USDJPY");
    expect(Object.keys(fx.rates)).toContain("JPY");
    noQjp("/api/trade/prices", (await call(GET, "/api/trade/prices")).text);
  });
  it("the browser's local answers (prices, candles, conversion) say JPY", async () => {
    const { installDemoClient } = await import("@/lib/demo-client");
    const { apiCall, setApiHook } = await import("@/lib/desktop-api");
    installDemoClient(Date.now());
    const prices = await apiCall("/api/trade/prices?fx=1");
    noQjp("local prices", JSON.stringify(prices));
    noQjp("local candles", JSON.stringify(await apiCall("/api/trade/candles?symbol=USDJPY&tf=M1")));
    setApiHook(null);
  });
  it("the backoffice position list (what the native backoffice renders, statements and CSV are built from it) says JPY", async () => {
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "x", role: "BROKER_ADMIN", brokerId: demo.broker.id } as never);
    const admin = await prisma.adminUser.findFirstOrThrow({ where: { brokerId: demo.broker.id } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: demo.broker.id } as never);
    const { GET } = await import("@/app/api/manage/positions/route");
    const r = await call(GET, "/api/manage/positions");
    expect(r.status).toBe(200);
    noQjp("/api/manage/positions", r.text);
    expect(r.text).toContain("USDJPY");
  });
  it("the backoffice symbol list and the 'cannot enable' sentence say JPY", async () => {
    const admin = await prisma.adminUser.findFirstOrThrow({ where: { brokerId: demo.broker.id } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: demo.broker.id } as never);
    const symbols = await import("@/app/api/manage/symbols/route");
    noQjp("/api/manage/symbols", (await call(symbols.GET, "/api/manage/symbols")).text);
    const sym = await prisma.symbol.findUniqueOrThrow({ where: { name: "qUSDJPY" } });
    const r = await call(symbols.PATCH, "/api/manage/symbols", "PATCH", { symbolId: sym.id, enabled: true, spreadMarkup: "0", minLot: "0.01", maxLot: "100", lotStep: "0.01", swapLong: "0", swapShort: "0", commissionPerLot: "0", maxExposure: null, tradingMode: "BOTH", defaultBookType: "B_BOOK" });
    noQjp("PATCH /api/manage/symbols", r.text);
  });
  it("an FX error sentence, the display helper and the news currencies say JPY", async () => {
    noQjp("FxRateUnavailableError", new FxRateUnavailableError("QJP", "USD").message);
    expect(displayCurrency("USDQJP")).toBe("USDJPY");
    expect(displayCurrency("QJP")).toBe("JPY");
    const { symbolNewsCurrencies } = await import("@/lib/risk-radar");
    expect(symbolNewsCurrencies({ baseCurrency: "USD", quoteCurrency: "QJP" })).toEqual(["USD", "JPY"]);
  });
  it("the position DTOs, history, audit and ledger rows a terminal reads carry no currency of the symbol", async () => {
    for (const [mod, url] of [["@/app/api/trade/positions/route", "/api/trade/positions"], ["@/app/api/trade/history/route", "/api/trade/history"], ["@/app/api/trade/audit/route", "/api/trade/audit"], ["@/app/api/trade/transactions/route", "/api/trade/transactions"], ["@/app/api/trade/me/route", "/api/trade/me"]] as const) {
      const { GET } = await import(/* @vite-ignore */ mod);
      noQjp(url, (await call(GET, url)).text);
    }
  });
});

describe("source guard: QJP is spelled only where it is internal", () => {
  // the files that may contain the code: the price module that defines it, the replay's rate lookup, the conversion alias in the
  // live-price layer, the display scrub, the seed (it creates the symbol), and tests
  const ALLOWED = [
    "lib/demo-prices.ts", "lib/demo-policy.ts", "lib/demo-sweep-core.ts", "lib/demo-sweep.ts", "lib/live-price.ts", "lib/risk-radar.ts", "lib/fx.ts",
    "scripts/seed-qoredemo.ts", "app/api/trade/prices/route.ts", "app/api/trade/symbols/route.ts",
  ];
  const ROOT = path.resolve(import.meta.dirname, "..");
  const SKIP = new Set(["node_modules", ".next", ".git", "engine", "desktop-tauri", "manager-tauri", "admin-tauri", "native-backoffice", "services", "docs", "public", ".tmp-calib"]);
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (SKIP.has(e)) continue;
      const p = path.join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(ts|tsx|css|json)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
    }
    return out;
  }
  it("no other file in the app mentions it", () => {
    const hits = walk(ROOT).filter((f) => /QJP/.test(readFileSync(f, "utf8"))).map((f) => path.relative(ROOT, f).split(path.sep).join("/"));
    expect(hits.filter((f) => !ALLOWED.includes(f))).toEqual([]);
  });
  it("the allowed files that sit on a response path scrub it (the prices and symbols routes call displayCurrency)", () => {
    for (const f of ["app/api/trade/prices/route.ts", "app/api/trade/symbols/route.ts"]) expect(readFileSync(path.join(ROOT, f), "utf8")).toMatch(/displayCurrency/);
  });
});
