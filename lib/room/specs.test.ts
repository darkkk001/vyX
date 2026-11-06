import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Contract specifications: every figure comes from the live configuration of each plan.
vi.mock("@/lib/live-price", async (importActual) => ({ ...(await importActual<typeof import("@/lib/live-price")>()), getLivePriceRows: vi.fn() }));

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
const name = `SP${s}`.toUpperCase();

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("specs.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Sp ${s}`, subdomain: `sp-${s}` } })).id;
  const sym = await prisma.symbol.create({ data: { name, baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: D(100000), category: "FOREX" } });
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId: sym.id, enabled: true } });
  const plan = (n: string) => prisma.group.create({ data: { brokerId, name: n, displayName: n, leverage: 1000, isClientSelectable: true, category: "B_BOOK" } });
  const [pro, zero] = await Promise.all([plan("Pro"), plan("Zero")]);
  await prisma.groupSymbolConfig.create({ data: { groupId: pro.id, symbolId: sym.id, spreadMarkup: D("0.1") } });
  await prisma.groupSymbolConfig.create({ data: { groupId: zero.id, symbolId: sym.id, spreadMarkup: D(0), commissionPerLot: D("0.10") } });
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

describe("contract specifications", () => {
  it("each plan shows its own spread and commission, with the contract size and hours from the symbol", async () => {
    if (!dbReachable) return;
    const { getLivePriceRows } = await import("@/lib/live-price");
    vi.mocked(getLivePriceRows).mockResolvedValue(new Map([[name, { bid: D("1.12270"), ask: D("1.12272") }]]) as never);
    const { roomSpecs } = await import("@/lib/room/specs");
    const plans = await roomSpecs(brokerId);
    const row = (p: string) => plans.find((x) => x.name === p)!.rows.find((r) => r.symbol === name)!;
    expect(row("Pro")).toMatchObject({ spreadPips: "0.3", commissionPerLot: null, contractSize: "100000" });
    expect(row("Zero")).toMatchObject({ spreadPips: "0.2", commissionPerLot: "0.10" });
    expect(row("Pro").hours).toContain("Sun 17:00");
    expect(JSON.stringify(plans)).not.toMatch(/markup|raw/i);
  });
  it("no live price: no spread, nothing made up", async () => {
    if (!dbReachable) return;
    const { getLivePriceRows } = await import("@/lib/live-price");
    vi.mocked(getLivePriceRows).mockResolvedValue(new Map() as never);
    const { roomSpecs } = await import("@/lib/room/specs");
    expect((await roomSpecs(brokerId))[0].rows.find((r) => r.symbol === name)!.spreadPips).toBeNull();
  });
});
