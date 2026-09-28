// scripts/seed-zzshadowbot-synth.ts against the scratch database (vitest.setup.db-guard.ts refuses anything else).
// Runs on its own tenant ("zzsynthtest", the test-only parameter) so it never races scripts/seed-zzshadowbot.test.ts,
// which rebuilds zzshadowbot in parallel.
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { SYNTH_GROUP_CONFIGS, SYNTH_SYMBOLS, SynthSeedRefused, seedSyntheticSymbols } from "./seed-zzshadowbot-synth";

const prisma = new PrismaClient();
const TENANT = "zzsynthtest";
const OTHER = "zzsynthother";
const run = (apply: boolean) => prisma.$transaction((tx) => seedSyntheticSymbols(tx, { apply, tenant: TENANT }), { timeout: 120_000 });
const CONFIGS = Object.values(SYNTH_GROUP_CONFIGS).reduce((n, c) => n + c.length, 0);
let dbReachable = false;

async function wipe(subdomain: string) {
  const b = await prisma.broker.findUnique({ where: { subdomain } });
  if (!b) return;
  await prisma.groupSymbolConfig.deleteMany({ where: { group: { brokerId: b.id } } });
  await prisma.brokerSymbol.deleteMany({ where: { brokerId: b.id } });
  await prisma.auditLog.deleteMany({ where: { brokerId: b.id } });
  await prisma.group.deleteMany({ where: { brokerId: b.id } });
  await prisma.broker.delete({ where: { id: b.id } });
}
async function tenant(subdomain: string) {
  const b = await prisma.broker.create({ data: { name: `Synth test ${subdomain}`, subdomain } });
  for (const name of Object.keys(SYNTH_GROUP_CONFIGS)) await prisma.group.create({ data: { brokerId: b.id, name, leverage: 100, category: "B_BOOK" } });
  return b;
}

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    return;
  }
  await wipe(OTHER);
  await wipe(TENANT);
  // the v* rows from an earlier run are kept only if nothing else references them
  await prisma.symbol.deleteMany({ where: { name: { in: SYNTH_SYMBOLS.map((x) => x.name) }, brokerSymbols: { none: {} }, positions: { none: {} }, orders: { none: {} } } }).catch(() => {});
  await tenant(TENANT);
}, 60_000);
afterAll(async () => {
  if (dbReachable) {
    await wipe(OTHER);
    await wipe(TENANT);
    await prisma.symbol.deleteMany({ where: { name: { in: SYNTH_SYMBOLS.map((x) => x.name) }, brokerSymbols: { none: {} }, positions: { none: {} }, orders: { none: {} } } }).catch(() => {});
    await prisma.symbol.deleteMany({ where: { name: "VGOLD" } }).catch(() => {});
  }
  await prisma.$disconnect();
}, 60_000);

describe("synthetic symbols seed", () => {
  it("a dry run plans every symbol, listing and group config and writes nothing", async () => {
    if (!dbReachable) return;
    const planned = { name: { in: SYNTH_SYMBOLS.map((x) => x.name) } };
    const before = await prisma.symbol.count({ where: planned });
    const r = await run(false);
    expect(r.changes).toBe(SYNTH_SYMBOLS.length * 2 + CONFIGS - (before > 0 ? before : 0));
    expect(await prisma.symbol.count({ where: planned })).toBe(before);
    expect(r.lines.join("\n")).toContain('reserved prefix "v" (case-sensitive, leading)');
  });

  it("apply creates the v* symbols (CRYPTO, the approved spec) listed on the tenant only; a second apply changes nothing", async () => {
    if (!dbReachable) return;
    expect((await run(true)).changes).toBeGreaterThan(0);
    const b = await prisma.broker.findUniqueOrThrow({ where: { subdomain: TENANT } });
    for (const s of SYNTH_SYMBOLS) {
      const row = await prisma.symbol.findUniqueOrThrow({ where: { name: s.name }, include: { brokerSymbols: true } });
      expect(row).toMatchObject({ quoteCurrency: s.quoteCurrency, digits: s.digits, category: "CRYPTO" });
      expect(row.contractSize.toNumber()).toBe(s.contractSize);
      expect(row.brokerSymbols.map((x) => x.brokerId)).toEqual([b.id]);
      expect(row.brokerSymbols[0].hedgedMarginPct.toNumber()).toBe(s.hedgedMarginPct);
      expect(row.brokerSymbols[0].enabled).toBe(true);
    }
    expect(await prisma.groupSymbolConfig.count({ where: { group: { brokerId: b.id } } })).toBe(CONFIGS);
    expect(await prisma.auditLog.count({ where: { brokerId: b.id, action: "SHADOWBOT_SYNTH_SEED" } })).toBe(1);
    const again = await run(true);
    expect(again.changes).toBe(0);
  });

  it("refuses when another broker lists a v* symbol", async () => {
    if (!dbReachable) return;
    const other = await tenant(OTHER);
    const vgold = await prisma.symbol.findUniqueOrThrow({ where: { name: "vGOLD" } });
    await prisma.brokerSymbol.create({ data: { brokerId: other.id, symbolId: vgold.id } });
    await expect(run(false)).rejects.toThrow(SynthSeedRefused);
    await expect(run(false)).rejects.toThrow(/another broker lists synthetic symbol/);
    await wipe(OTHER);
  });

  it("refuses a global symbol that differs from a synthetic name only in case", async () => {
    if (!dbReachable) return;
    await prisma.symbol.create({ data: { name: "VGOLD", baseCurrency: "VGOLD", quoteCurrency: "USD", category: "CRYPTO" } });
    await expect(run(false)).rejects.toThrow(/only in case/);
    await prisma.symbol.delete({ where: { name: "VGOLD" } });
    expect((await run(false)).changes).toBe(0);
  });

  it("refuses a missing tenant", async () => {
    if (!dbReachable) return;
    await expect(prisma.$transaction((tx) => seedSyntheticSymbols(tx, { apply: false, tenant: "zz-no-such-tenant" }))).rejects.toThrow(/does not exist/);
  });

  it("the main seed never disables or deletes the synthetic symbols it does not own (static)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "seed-zzshadowbot.ts"), "utf8");
    expect(src).toMatch(/r\.enabled && !isSyntheticSymbol\(r\.symbol\.name\)/);
    expect(src).toMatch(/!isSyntheticSymbol\(e\.symbol\.name\) && !g\.configs\.some/);
  });

  it("the CLI can only ever reach zzshadowbot (no tenant argument)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "seed-zzshadowbot-synth.ts"), "utf8");
    const cli = src.slice(src.indexOf("async function main()"));
    expect(cli).toContain("seedSyntheticSymbols(tx, { apply })");
    expect(cli).not.toContain("tenant");
  });
});
