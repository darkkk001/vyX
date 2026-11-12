import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { gridCounts, gridOff } from "./migrate-chart-grid-off";
import { DEFAULT_CHART_SETTINGS, mergeChartSettings } from "@/lib/chart-settings";

// The grid-off backfill on the scratch database: only a stored showGrid true becomes false; every other key, every other account and every
// other column is left as it was; after it, every account resolves to the grid OFF.
afterAll(async () => { await prisma.$disconnect(); }, 60000);
const D = (v: number) => new Prisma.Decimal(v);

describe("migrate-chart-grid-off", () => {
  it("turns a saved grid off, keeps everything else, and leaves every account with the grid off", async () => {
    try { await prisma.$queryRaw`SELECT 1 FROM "Account" LIMIT 1`; } catch { return; }
    expect(DEFAULT_CHART_SETTINGS.showGrid).toBe(false);
    const s = randomUUID().slice(0, 8);
    const b = await prisma.broker.create({ data: { name: `G ${s}`, subdomain: `grid-${s}` } });
    const g = await prisma.group.create({ data: { brokerId: b.id, name: "G", leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", dealingMode: "AUTO", isClientSelectable: true } });
    const mk = (n: string, cs: Prisma.InputJsonValue | typeof Prisma.DbNull) => prisma.account.create({ data: { brokerId: b.id, groupId: g.id, accountNumber: `6${n}${s.replace(/\D/g, "").padEnd(5, "1").slice(0, 5)}`, email: `${n}-${s}@test.local`, passwordHash: "x", fullName: n, accountMode: "LIVE", leverage: 100, balance: D(100), chartSettings: cs } });
    const on = await mk("1", { showGrid: true, theme: "dark", candleUpColor: "#00ff00", showSessionHighLow: true });
    const off = await mk("2", { showGrid: false, theme: "light" });
    const absent = await mk("3", { theme: "dark" });
    const none = await mk("4", Prisma.DbNull);
    const ids = [on.id, off.id, absent.id, none.id];
    const before = await gridCounts(prisma);
    const updatedAtBefore = (await prisma.account.findUniqueOrThrow({ where: { id: off.id } })).updatedAt;

    const changed = await gridOff(prisma);
    const after = await gridCounts(prisma);
    expect(changed).toBe(before.gridTrue);
    expect(after.gridTrue).toBe(0);
    expect(after.gridFalse).toBe(before.gridFalse + changed);
    expect(after.withBlob).toBe(before.withBlob);
    expect(after.accounts).toBe(before.accounts);

    const rows = new Map((await prisma.account.findMany({ where: { id: { in: ids } }, select: { id: true, chartSettings: true, updatedAt: true } })).map((r) => [r.id, r]));
    expect(rows.get(on.id)!.chartSettings).toEqual({ showGrid: false, theme: "dark", candleUpColor: "#00ff00", showSessionHighLow: true });   // only the one key
    expect(rows.get(off.id)!.chartSettings).toEqual({ showGrid: false, theme: "light" });
    expect(rows.get(absent.id)!.chartSettings).toEqual({ theme: "dark" });   // not touched: the new default gives it no grid
    expect(rows.get(none.id)!.chartSettings).toBeNull();
    expect(rows.get(off.id)!.updatedAt.getTime()).toBe(updatedAtBefore.getTime());   // an untouched row is not rewritten
    // every account resolves to the grid OFF (the stored blob merged over the defaults, as GET /api/trade/chart-settings does)
    for (const r of rows.values()) expect(mergeChartSettings(r.chartSettings as never).showGrid).toBe(false);
    // a second run changes nothing
    expect(await gridOff(prisma)).toBe(0);
  }, 120000);
});
