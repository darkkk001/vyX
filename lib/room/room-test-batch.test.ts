import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Futurix Room test feedback (owner 2026-11-05): Analytics and the Journal read the same trades, the sidebar shows the
// broker's name beside its logo, a staff deposit names its method, and a method saved in the backoffice reaches Deposit.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: number | string) => new Prisma.Decimal(v);
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let clientId = "";
let groupId = "";
let symbolId = "";
let seq = 0;

async function account(accountMode: "LIVE" | "DEMO") {
  seq++;
  return prisma.account.create({ data: { brokerId, clientId, accountNumber: `7${Date.now() % 1_000_000}${seq}`, email: `room-${seq}-${s}@x.local`, passwordHash: "x", fullName: "Room", accountMode, groupId, leverage: 100, balance: D(1000) } });
}
async function closedTrade(accountId: string, pnl: number) {
  const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `room-${++seq}-${s}` } });
  const now = Date.now();
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "CLOSED", openedAt: new Date(now - 60_000), closedAt: new Date(now - 30_000), closePrice: D(101), realizedPnl: D(pnl) } });
}
async function signedIn() {
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
}
async function screens(query: string) {
  await signedIn();
  const { GET: analytics } = await import("@/app/api/room/analytics/route");
  const { GET: journal } = await import("@/app/api/room/journal/route");
  const a = await (await analytics(new NextRequest(`https://t.local/api/room/analytics?${query}`))).json();
  const j = await (await journal(new NextRequest(`https://t.local/api/room/journal?${query}`))).json();
  return { a, j };
}

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("room-test-batch.test.ts: DB unreachable, skipping"); return; }
  const broker = await prisma.broker.create({ data: { name: `Room ${s}`, subdomain: `room-${s}` } });
  brokerId = broker.id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  clientId = (await prisma.client.create({ data: { brokerId, email: `room-${s}@x.local`, passwordHash: "x", fullName: "Room" } })).id;
  symbolId = (await prisma.symbol.findFirstOrThrow({ select: { id: true } })).id;
});

afterAll(async () => {
  if (dbReachable) await prisma.$disconnect();
});

describe("Analytics and the Journal read the same trades", () => {
  it("a client who only traded on demo sees those trades on both, for All accounts and for the account itself", async () => {
    if (!dbReachable) return;
    await account("LIVE");
    const demo = await account("DEMO");
    await closedTrade(demo.id, 25);
    await closedTrade(demo.id, -10);
    for (const query of ["account=all&period=90d", `account=${demo.id}&period=90d`]) {
      const { a, j } = await screens(query);
      expect(a.tiles.trades).toBe(2);
      expect(j.total).toBe(2);
      expect(Number(a.tiles.net)).toBe(j.rows.reduce((n: number, r: { net: string }) => n + Number(r.net), 0));
    }
  });
});

describe("History method", () => {
  it("a deposit booked by staff reads Manual, a method deposit keeps its name", async () => {
    if (!dbReachable) return;
    const acc = await account("LIVE");
    const pm = await prisma.paymentMethod.create({ data: { brokerId, type: "BANK_TRANSFER" } });
    const tx = (data: Partial<Prisma.TransactionUncheckedCreateInput>) => prisma.transaction.create({ data: { brokerId, accountId: acc.id, type: "DEPOSIT", status: "COMPLETED", amount: D(100), balanceBefore: D(0), balanceAfter: D(100), ...data } });
    const staff = await tx({ pspAdapter: "STAFF" });
    const bank = await tx({ paymentMethodId: pm.id });
    const out = await tx({ type: "WITHDRAWAL", amount: D(-50), pspAdapter: "STAFF" });
    const { roomTransactions } = await import("@/lib/room/transactions");
    const { rows } = await roomTransactions({ accountIds: [acc.id] }, new Set([acc.accountNumber]), { skip: 0, take: 10 });
    const method = (id: string) => rows.find((r) => r.id === id)?.method;
    expect(method(staff.id)).toBe("Manual");
    expect(method(bank.id)).toBe("Bank transfer");
    expect(method(out.id)).toBe("Manual");
    await prisma.transaction.deleteMany({ where: { accountId: acc.id } });
    await prisma.paymentMethod.delete({ where: { id: pm.id } });
  });
});

describe("Payment methods reach the Deposit page", () => {
  it("saved and enabled through the backoffice route it is listed with its details; turned off it is gone", async () => {
    if (!dbReachable) return;
    const admin = await prisma.adminUser.create({ data: { brokerId, email: `pm-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, brokerId, role: "BROKER_ADMIN" } as never);
    const { PATCH } = await import("@/app/api/manage/payment-methods/route");
    const { roomMethods } = await import("@/lib/room/funds");
    const save = (enabled: boolean) => PATCH(new NextRequest("https://t.local/api/manage/payment-methods", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "USDT_TRC20", enabled, minAmount: "50", maxAmount: null, feePercent: "0", feeFixed: "0", instructions: "Send TRC-20 only", walletAddress: "TAddr123" }) }));
    expect((await save(true)).status).toBe(200);
    const listed = await roomMethods(brokerId);
    expect(listed.map((m) => [m.type, m.min, m.wallet, m.instructions])).toEqual([["USDT_TRC20", "50.00", "TAddr123", "Send TRC-20 only"]]);
    expect((await save(false)).status).toBe(200);
    expect(await roomMethods(brokerId)).toEqual([]);
  });
});

describe("Sidebar brand", () => {
  it("the sidebar asks for the name beside the logo; login and onboarding do not", () => {
    const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    expect(src("components/room/RoomSidebar.tsx")).toContain("logoUrl={logoUrl} showName");
    expect(src("components/room/RoomBrand.tsx")).toMatch(/showName \? <>\{logo\}<span className="r-wordmark">\{name\}<\/span><\/> : logo/);
    expect(src("components/room/Onboarding.tsx")).not.toContain("showName");
  });
});

describe("Analytics: previous period, breakdown and the chart series", () => {
  it("the previous window is the same length just before; all time has none", async () => {
    const { previousWindow } = await import("@/lib/room/analytics");
    const now = new Date("2026-11-05T12:00:00Z");
    const w = previousWindow("30d", now)!;
    expect(w.to.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(w.from.toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(previousWindow("all", now)).toBeNull();
  });
  it("delta is against the size of the previous figure, and absent with nothing to compare", async () => {
    const { deltaPct } = await import("@/lib/room/analytics");
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(-50, -100)).toBe(50);
    expect(deltaPct(50, -100)).toBe(150);
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(null, 10)).toBeNull();
  });
  it("net reconciles with the breakdown, the daily series adds up, and the previous period drives the deltas", async () => {
    if (!dbReachable) return;
    const acc = await account("LIVE");
    const closed = async (ms: number, pnl: number, swap: number, commission: number) => {
      const o = await prisma.order.create({ data: { brokerId, accountId: acc.id, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `room-${++seq}-${s}` } });
      await prisma.position.create({ data: { brokerId, accountId: acc.id, symbolId, originOrderId: o.id, side: "BUY", volume: D(2), openPrice: D(100), status: "CLOSED", openedAt: new Date(ms - 60_000), closedAt: new Date(ms), closePrice: D(101), realizedPnl: D(pnl), swap: D(swap), commission: D(commission) } });
    };
    const now = Date.now();
    await closed(now - 86400e3, 100, -3, 7);
    await closed(now - 2 * 86400e3, -40, 1, 2);
    await closed(now - 40 * 86400e3, 20, 0, 0); // in the 30 days before this period
    const { a } = await screens(`account=${acc.id}&period=30d`);
    expect(a.breakdown).toMatchObject({ profit: "100.00", loss: "-40.00", cost: "11.00", unrealised: "0.00" });
    expect(Number(a.tiles.net)).toBeCloseTo(100 - 40 - 11, 2);
    expect(a.deltas.net).toBe(145);
    expect(a.deltas.trades).toBe(100);
    expect(a.daily.reduce((n: number, x: { net: string }) => n + Number(x.net), 0)).toBeCloseTo(49, 2);
    expect(a.daily.reduce((n: number, x: { trades: number }) => n + x.trades, 0)).toBe(2);
    expect(a.daily.reduce((n: number, x: { lots: string }) => n + Number(x.lots), 0)).toBe(4);
    const all = (await screens(`account=${acc.id}&period=all`)).a;
    expect(Object.values(all.deltas).every((v) => v === null)).toBe(true);
    expect(all.daily.reduce((n: number, x: { trades: number }) => n + x.trades, 0)).toBe(3);
  });
});

describe("Sidebar and header", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("My Tier is on the Dashboard with no tab; an old link lands there", () => {
    expect(src("components/room/RoomSidebar.tsx")).not.toContain("/room/tier");
    expect(src("app/(broker)/room/(shell)/page.tsx")).toContain("<TierPanel />");
    expect(src("app/(broker)/room/(shell)/tier/page.tsx")).toContain('redirect("/room#tier")');
  });
  it("Refer & earn sits in the foot, outside the partner-only group; the theme switch writes the cookie RoomFrame reads", () => {
    const side = src("components/room/RoomSidebar.tsx");
    expect(side.indexOf('className="r-refer"')).toBeGreaterThan(side.indexOf('className="r-side-foot"'));
    expect(src("components/room/ThemeToggle.tsx")).toContain("room_theme=");
    expect(src("components/room/RoomFrame.tsx")).toContain('get("room_theme")');
  });
});
