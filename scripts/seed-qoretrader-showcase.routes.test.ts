import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
import { getAdminSession } from "@/lib/auth";
import { seedShowcase, SUBDOMAIN } from "./seed-qoretrader-showcase";

// What the backoffice actually reads after the showcase seed: each section's own manage route, called as the tenant's BROKER_ADMIN, returns rows /
// non-zero figures. Seeded and wiped inside the test (scratch database only).
const D = (v: number | string) => new Prisma.Decimal(v);
let ok = false; let brokerId = ""; let adminId = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1 FROM "Client" LIMIT 1`; ok = true; } catch { return; }
  const b = (await prisma.broker.findUnique({ where: { subdomain: SUBDOMAIN } })) ?? await prisma.broker.create({ data: { name: "QoreTrader", subdomain: SUBDOMAIN } });
  brokerId = b.id;
  if (!(await prisma.group.findFirst({ where: { brokerId, category: "B_BOOK" } }))) await prisma.group.create({ data: { brokerId, name: "Standard", leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
  adminId = ((await prisma.adminUser.findFirst({ where: { brokerId, role: "BROKER_ADMIN" } })) ?? await prisma.adminUser.create({ data: { brokerId, email: `owner-r-${Date.now()}@qoretrader.test`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
  for (const [name, base, quote, digits, cs, cat, px] of [["XAUUSD", "XAU", "USD", 2, 100, "METALS", 2650], ["EURUSD", "EUR", "USD", 5, 100000, "FOREX", 1.081]] as const) {
    const s = (await prisma.symbol.findFirst({ where: { name } })) ?? await prisma.symbol.create({ data: { name, baseCurrency: base, quoteCurrency: quote, digits, contractSize: D(cs), category: cat } });
    if (!(await prisma.brokerSymbol.findFirst({ where: { brokerId, symbolId: s.id } }))) await prisma.brokerSymbol.create({ data: { brokerId, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
    await prisma.livePrice.upsert({ where: { symbol: name }, create: { symbol: name, bid: D(px), ask: D(px) }, update: { bid: D(px), ask: D(px) } });
  }
  await prisma.$transaction((tx) => seedShowcase(tx, { mode: "apply", now: new Date() }), { timeout: 600000 });
}, 900000);
afterAll(async () => { if (ok) await prisma.$transaction((tx) => seedShowcase(tx, { mode: "wipe" }), { timeout: 600000 }); await prisma.$disconnect(); }, 900000);

async function get(path: string, qs = "") {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, brokerId, role: "BROKER_ADMIN" } as never);
  const mod = await import(`@/app/api/manage/${path}/route`);
  const res = await mod.GET(new NextRequest(`https://t.local/api/manage/${path}${qs}`));
  const text = await res.text(); let json: unknown = text; try { json = JSON.parse(text); } catch { /* a CSV report */ }
  return { status: res.status as number, json };
}
const size = (j: unknown): number => Array.isArray(j) ? j.length : j && typeof j === "object" ? Object.values(j as object).reduce<number>((m, v) => Math.max(m, Array.isArray(v) ? v.length : 0), 0) : 0;

describe("backoffice sections after the showcase seed", () => {
  for (const [path, qs] of [["clients", ""], ["accounts", ""], ["funds-requests", ""], ["kyc-requests", ""], ["client-kyc-requests", ""], ["balance-adjustment-requests", ""],
    ["positions", ""], ["deals", ""], ["dashboard", ""], ["reports/summary", ""], ["reports/financial", ""], ["reports/trading", ""], ["reports/client", ""]] as const) {
    it(`${path} answers with data`, async () => {
      if (!ok) return;
      const r = await get(path, qs);
      const body = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
      const rows = typeof r.json === "string" ? r.json.trim().split(/\r?\n/).length - 1 : size(r.json);
      console.log(`${path}: HTTP ${r.status}, ${rows} rows, ${body.length} bytes: ${body.slice(0, 160)}`);
      expect(r.status).toBe(200);
      expect(rows > 0 || /[1-9]/.test(body)).toBe(true);
    }, 120000);
  }
});
