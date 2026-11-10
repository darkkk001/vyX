// Owner 2026-11-10: GET /api/manage/groups counts each group's own pricing rows by kind for the PRICING column
// (fixed spread, spread markup, commission / swaps only). Live scratch DB, real route.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

const D = (v: string) => new Prisma.Decimal(v);
let brokerId = "";
const symbols: string[] = [];
beforeAll(async () => {
  const s = randomUUID().replace(/-/g, "").slice(0, 8);
  brokerId = (await prisma.broker.create({ data: { name: `PK ${s}`, subdomain: `pk-${s}` } })).id;
});
afterAll(async () => {
  await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId } } });
  await prisma.group.deleteMany({ where: { brokerId } });
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } });
  await prisma.broker.deleteMany({ where: { id: brokerId } });
});

describe("groups list: symbolConfigKinds", () => {
  it("counts fixed (wins over a markup on the same row), markup and fees-only rows; a group with none is all zero", async () => {
    const sym = async () => {
      const n = `ZPK${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
      symbols.push(n);
      return prisma.symbol.create({ data: { name: n, baseCurrency: "ZZZ", quoteCurrency: "USD", digits: 2, contractSize: D("1"), category: "CRYPTO" } });
    };
    const [a, b, c, d] = [await sym(), await sym(), await sym(), await sym()];
    const mixed = await prisma.group.create({ data: { brokerId, name: "Mixed" } });
    const plain = await prisma.group.create({ data: { brokerId, name: "Plain" } });
    await prisma.groupSymbolConfig.createMany({
      data: [
        { groupId: mixed.id, symbolId: a.id, spreadMarkup: D("1.5") },
        { groupId: mixed.id, symbolId: b.id, targetTotalSpreadPips: D("3"), spreadMarkup: D("1") },
        { groupId: mixed.id, symbolId: c.id, commissionPerLot: D("7") },
        { groupId: mixed.id, symbolId: d.id, spreadMarkup: D("0.2") },
      ],
    });
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "x", role: "BROKER_ADMIN", brokerId } as never);
    const { GET } = await import("@/app/api/manage/groups/route");
    const rows = (await (await (GET as () => Promise<Response>)()).json()) as { id: string; symbolConfigCount: number; symbolConfigKinds: unknown }[];
    const m = rows.find((r) => r.id === mixed.id)!;
    expect(m.symbolConfigCount).toBe(4);
    expect(m.symbolConfigKinds).toEqual({ markup: 2, fixed: 1, fees: 1 });
    expect(rows.find((r) => r.id === plain.id)!.symbolConfigKinds).toEqual({ markup: 0, fixed: 0, fees: 0 });
  });
});
