// Local-only latency bench for the three trader money routes (latency fixes 1 + 2, 2026-09-26).
// Runs the REAL route handlers and the REAL session check against the scratch DB behind scripts/e2e/pg-latency-proxy.mjs
// (+6.5 ms per DB round trip, the production fra1 -> Neon figure). Redis round trips are simulated at 8 ms and a gateway
// publish at 15 ms (both measured / estimated in docs/audit/2026-09-24/latency-breakdown.md). Skipped unless LATENCY_BENCH=1.
//   node scripts/e2e/pg-latency-proxy.mjs 5599 127.0.0.1:5499 3.25
//   LATENCY_BENCH=1 DATABASE_URL=postgresql://postgres@127.0.0.1:5599/vyx_test DIRECT_URL=... MARKET_DATA_PRICES= \
//     npx vitest run scripts/e2e/latency-bench.test.ts
import net from "node:net";
import { appendFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";

const REDIS_RTT = 8;
const GATEWAY_RTT = 15;
// precise: Windows setTimeout ticks at ~15.6 ms, which would inflate an 8 ms Redis round trip to ~16 ms
const sleep = (ms: number) =>
  new Promise<void>((r) => {
    const end = performance.now() + ms;
    const spin = () => (performance.now() >= end ? r() : setImmediate(spin));
    spin();
  });
const state = { token: "bench-token", session: "", build: JSON.stringify({ buildId: "bench-build", brokerId: "", status: "ACTIVE" }) };

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => ({ value: state.token }) }),
  headers: async () => new Headers({ "x-broker-id": JSON.parse(state.session || "{}").brokerId ?? "", "x-broker-slug": "bench", "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "bench-build" }),
}));
vi.mock("@/lib/redis", () => ({
  getRedis: () =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (key?: string) => {
          await sleep(REDIS_RTT);
          if (method === "get" && typeof key === "string") return key.includes("bench-build") ? state.build : key.includes(state.token) ? state.session : null;
          if (method === "mget") return [];
          return null;
        },
      }
    ),
}));
const published: string[] = [];
vi.mock("@/lib/nats", () => ({
  publishTradingEvent: async (type: string) => {
    await sleep(GATEWAY_RTT);
    published.push(type);
  },
  publishAlertConfig: async () => {},
}));

import { prisma } from "@/lib/prisma";
import { detachForBench, settleAfterResponse } from "@/lib/after-response";

const D = (v: string | number) => new Prisma.Decimal(v);
const RUN = process.env.LATENCY_BENCH === "1" && (process.env.DATABASE_URL ?? "").includes("127.0.0.1:5599");
const N = Number(process.env.LATENCY_BENCH_N ?? 15);

function statements(cmd: "get" | "reset"): Promise<number> {
  return new Promise((resolve) => {
    const s = net.connect(5600, "127.0.0.1", () => s.write(cmd));
    s.on("data", (d) => resolve(Number(d.toString())));
    s.on("error", () => resolve(-1));
  });
}
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const p90 = (a: number[]) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.9))];

const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!RUN) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: { in: brokers } } } }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

describe.skipIf(!RUN)("latency bench (real handlers, +6.5 ms per DB round trip)", () => {
  it("market BUY, SL/TP modify, close", async () => {
    const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
    const b = await prisma.broker.create({ data: { name: `LAT ${sfx}`, subdomain: `lat${sfx}`, pricingEngineEnabled: true, dealingModeAt: null } });
    brokers.push(b.id);
    const sym = await prisma.symbol.create({ data: { name: `LAT${sfx.toUpperCase()}`, baseCurrency: "XAU", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
    symbols.push(sym.name);
    await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
    await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("4456.35"), ask: D("4456.53"), tickAt: new Date() } });
    const g = await prisma.group.create({ data: { brokerId: b.id, name: `Standard-${sfx}`, leverage: 100, dealingMode: "AUTO" } });
    await prisma.groupSymbolConfig.create({ data: { groupId: g.id, symbolId: sym.id, spreadMarkup: D(15), commissionPerLot: D(7) } });
    const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: `9${Date.now().toString().slice(-7)}`, email: `lat-${sfx}@test.local`, passwordHash: "x", fullName: "Bench", accountMode: "DEMO", balance: D(1000000), leverage: 100 } });
    // production behaviour: after-response work (mirror, dealer feed, publish) does not hold the measured response
    detachForBench(process.env.LATENCY_BENCH_LABEL !== "before");
    state.session = JSON.stringify({ accountId: acc.id, brokerId: b.id });
    state.build = JSON.stringify({ buildId: "bench-build", brokerId: b.id, status: "ACTIVE" });

    const orders = await import("@/app/api/trade/orders/route");
    const modify = await import("@/app/api/trade/positions/[id]/route");
    const close = await import("@/app/api/trade/positions/[id]/close/route");
    const req = (url: string, method: string, body: unknown) => new NextRequest(`https://bench.local${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

    const t = { buy: [] as number[], modify: [] as number[], close: [] as number[] };
    const q = { buy: [] as number[], modify: [] as number[], close: [] as number[] };
    // two other open positions, so the margin check has real work (as on a live account)
    for (let i = 0; i < 2; i++) await orders.POST(req("/api/trade/orders", "POST", { symbol: sym.name, side: "BUY", type: "MARKET", volume: "0.01", price: "4456.68", idempotencyKey: randomUUID() }));

    for (let i = 0; i < N + 1; i++) {
      await prisma.livePrice.update({ where: { symbol: sym.name }, data: { tickAt: new Date() } });
      await statements("reset");
      let s = performance.now();
      const r = await orders.POST(req("/api/trade/orders", "POST", { symbol: sym.name, side: "BUY", type: "MARKET", volume: "0.01", price: "4456.68", idempotencyKey: randomUUID() }));
      const buyMs = performance.now() - s;
      const buyQ = await statements("get");
      expect(r.status).toBe(201);
      const posId = (await r.json()).position.id as string;
      await settleAfterResponse(); await sleep(150); // let background work finish before the next measured request

      await statements("reset");
      s = performance.now();
      const m = await modify.PATCH(req(`/api/trade/positions/${posId}`, "PATCH", { slPrice: "4400.00", tpPrice: "4500.00" }), { params: Promise.resolve({ id: posId }) });
      const modMs = performance.now() - s;
      const modQ = await statements("get");
      expect(m.status).toBe(200);
      await settleAfterResponse(); await sleep(150);

      await statements("reset");
      s = performance.now();
      const c = await close.POST(req(`/api/trade/positions/${posId}/close`, "POST", { closePrice: "4456.35" }), { params: Promise.resolve({ id: posId }) });
      const closeMs = performance.now() - s;
      const closeQ = await statements("get");
      expect(c.status).toBe(200);
      await settleAfterResponse(); await sleep(150);

      if (i === 0) continue; // warm-up
      t.buy.push(buyMs); t.modify.push(modMs); t.close.push(closeMs);
      q.buy.push(buyQ); q.modify.push(modQ); q.close.push(closeQ);
    }
    const line = (k: keyof typeof t) => `${k.padEnd(6)} median ${median(t[k]).toFixed(0)} ms  p90 ${p90(t[k]).toFixed(0)} ms  statements before response ${median(q[k])}`;
    const out = `\nLATENCY BENCH (${process.env.LATENCY_BENCH_LABEL ?? ""}, n=${N}, DB RTT 6.5 ms, Redis 8 ms, gateway 15 ms)\n${line("buy")}\n${line("modify")}\n${line("close")}\n`;
    appendFileSync(process.env.LATENCY_BENCH_OUT ?? "latency-bench.txt", out);
  }, 600000);
});
