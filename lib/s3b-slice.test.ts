import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item A (owner 2026-10-07): the backoffice's live book refreshes ONE account after each event. The three reads it
// uses answer for one account only (additive query parameters; without them every route answers as before).
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-slice.test.ts: DB unreachable, skipping"); } });
const brokers: string[] = []; const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `S3b Slice ${sfx}`, subdomain: `s3bsl-${sfx}` } }); brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `SL${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } }); symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("110"), ask: D("110.2") } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `SL-${sfx}`, leverage: 100 } });
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `sl-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const accs = [];
  for (let i = 0; i < 2; i++) {
    const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "3")}`;
    const a = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `sl-${n}@test.local`, passwordHash: "x", fullName: `SL ${n}`, accountMode: "LIVE", balance: D(5000), leverage: 100 } });
    const o = await prisma.order.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `sl:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    await prisma.position.create({ data: { brokerId: b.id, accountId: a.id, symbolId: sym.id, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), bookType: "B_BOOK", status: "OPEN" } });
    accs.push(a);
  }
  return { brokerId: b.id, adminId: admin.id, accs };
}
const req = (url: string) => new NextRequest("https://t.local" + url);

describe("per-account slice reads", () => {
  it("positions?accountId=&slim=1: only that account's rows, no pickers; without slim the pickers stay", async () => {
    if (!dbReachable) return;
    const w = await world();
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: w.adminId, role: "BROKER_ADMIN", brokerId: w.brokerId } as never);
    const { GET } = await import("@/app/api/manage/positions/route");
    const slim = await (await GET(req(`/api/manage/positions?accountId=${w.accs[0].id}&slim=1`))).json();
    expect(slim.rows.map((r: { accountId: string }) => r.accountId)).toEqual([w.accs[0].id]);
    expect([slim.accounts.length, slim.symbols.length, slim.groups.length, slim.ibOptions.length]).toEqual([0, 0, 0, 0]);
    expect(slim.fx).toBeTruthy();
    const full = await (await GET(req(`/api/manage/positions?accountId=${w.accs[0].id}`))).json();
    expect(full.accounts.length).toBe(2);
    const all = await (await GET(req("/api/manage/positions"))).json();
    expect(all.rows.length).toBe(2);
  });
  it("margin?accountId=: one account's row; no filter = every account with positions", async () => {
    if (!dbReachable) return;
    const w = await world();
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: w.adminId, role: "BROKER_ADMIN", brokerId: w.brokerId } as never);
    const { GET } = await import("@/app/api/manage/margin/route");
    const one = await (await GET(req(`/api/manage/margin?accountId=${w.accs[1].id}`))).json();
    expect(one.map((r: { accountId: string }) => r.accountId)).toEqual([w.accs[1].id]);
    const all = await (await GET(req("/api/manage/margin"))).json();
    expect(all.length).toBe(2);
  });
  it("accounts?accountId=: one row; no filter = every account of the broker", async () => {
    if (!dbReachable) return;
    const w = await world();
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: w.adminId, role: "BROKER_ADMIN", brokerId: w.brokerId } as never);
    const { GET } = await import("@/app/api/manage/accounts/route");
    const one = await (await GET(req(`/api/manage/accounts?accountId=${w.accs[0].id}`))).json();
    expect(one.map((r: { id: string }) => r.id)).toEqual([w.accs[0].id]);
    expect((await (await GET(req("/api/manage/accounts"))).json()).length).toBe(2);
  });
});
