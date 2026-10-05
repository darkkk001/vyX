import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// Groups screen SYMBOLS column (owner 2026-10-05, docs/contracts/groups-symbol-counts.md): GET /api/manage/groups
// carries restrictSymbols, enabledSymbolCount and allowedSymbolCount on every group.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (s: { role: string } | null, roles: string[]) => s !== null && roles.includes(s.role),
}));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});

const brokerIds: string[] = [];
const symbolIds: string[] = [];

async function sym(name: string) {
  const row = await prisma.symbol.create({ data: { name, baseCurrency: "USD", quoteCurrency: "USD", digits: 2, contractSize: 1, category: "INDICES" } });
  symbolIds.push(row.id);
  return row.id;
}

async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase();
  const broker = await prisma.broker.create({ data: { name: `GrpCnt ${s}`, subdomain: `grpcnt-${s.toLowerCase()}` } });
  brokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `gc-${s}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  // three enabled real symbols, one disabled, one enabled synthetic (v*) that a normal broker must never count
  const [a, b, c, off, synth] = [await sym(`GCA${s}`), await sym(`GCB${s}`), await sym(`GCC${s}`), await sym(`GCD${s}`), await sym(`vGC${s}`)];
  for (const [symbolId, enabled] of [[a, true], [b, true], [c, true], [off, false], [synth, true]] as const) {
    await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId, enabled } });
  }
  const open = await prisma.group.create({ data: { brokerId: broker.id, name: `Open-${s}`, category: "B_BOOK" } });
  const restricted = await prisma.group.create({ data: { brokerId: broker.id, name: `Two-${s}`, category: "B_BOOK", restrictSymbols: true } });
  // two allowed enabled symbols + one pointing at the DISABLED symbol + the synthetic one: only the two count
  for (const symbolId of [a, b, off, synth]) await prisma.groupSymbol.create({ data: { groupId: restricted.id, symbolId } });
  const none = await prisma.group.create({ data: { brokerId: broker.id, name: `None-${s}`, category: "B_BOOK", restrictSymbols: true } });
  // a restricted group whose allow-list still has rows once restrictSymbols is turned off counts as unrestricted
  const loose = await prisma.group.create({ data: { brokerId: broker.id, name: `Loose-${s}`, category: "B_BOOK", restrictSymbols: false } });
  await prisma.groupSymbol.create({ data: { groupId: loose.id, symbolId: a } });
  return { brokerId: broker.id, adminId: admin.id, ids: { open: open.id, restricted: restricted.id, none: none.id, loose: loose.id } };
}

async function list(fx: { brokerId: string; adminId: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { GET } = await import("./route");
  const res = await GET();
  return { status: res.status, rows: (await res.json()) as Array<{ id: string; restrictSymbols: boolean; enabledSymbolCount: number; allowedSymbolCount: number }> };
}

afterAll(async () => {
  if (!dbReachable) return;
  await prisma.groupSymbol.deleteMany({ where: { group: { brokerId: { in: brokerIds } } } });
  await prisma.brokerSymbol.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokerIds } } });
  await prisma.symbol.deleteMany({ where: { id: { in: symbolIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokerIds } } });
  await prisma.$disconnect();
});

describe("GET /api/manage/groups: symbol counts for the SYMBOLS column", () => {
  it("counts enabled symbols, allow-lists, disabled and synthetic symbols correctly", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const { status, rows } = await list(fx);
    expect(status).toBe(200);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    // 3 enabled real symbols: the disabled one and the synthetic one are not counted for a normal broker
    for (const r of rows) expect(r.enabledSymbolCount).toBe(3);
    expect(by(fx.ids.open)).toMatchObject({ restrictSymbols: false, allowedSymbolCount: 3 });
    expect(by(fx.ids.restricted)).toMatchObject({ restrictSymbols: true, allowedSymbolCount: 2 });
    expect(by(fx.ids.none)).toMatchObject({ restrictSymbols: true, allowedSymbolCount: 0 });
    expect(by(fx.ids.loose)).toMatchObject({ restrictSymbols: false, allowedSymbolCount: 3 });
  });

  it("refuses a non-staff session as before", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue(null);
    const { GET } = await import("./route");
    expect((await GET()).status).toBe(403);
  });
});
