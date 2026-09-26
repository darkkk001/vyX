import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, type RoutingCategory } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 2 (owner decision 2026-09-26): routing by the group's category, end to end through the real routes on
// the local scratch DB. B_BOOK = auto-fill never queued; DEALING = follows the dealer desk (queued when on), plus the
// per-group "Always send to dealer"; REVERSAL = auto-fill; A_BOOK = no accounts, no orders until an LP is connected;
// COVERAGE = system only.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/client-auth", () => ({ getClientSession: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getClientSession } from "@/lib/client-auth";
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch2.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function broker(deskOn: boolean) {
  const b = await prisma.broker.create({ data: { name: `P2B2 ${randomUUID().slice(0, 8)}`, subdomain: `p2b2-${randomUUID().slice(0, 8)}`, dealingDeskAutoFillAt: deskOn ? null : new Date(), dealingModeAt: null } });
  brokers.push(b.id);
  const name = `RT${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbols.push(name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  return { brokerId: b.id, symbolName: name };
}
async function accountIn(brokerId: string, category: RoutingCategory, opts?: { force?: boolean; dealingMode?: "INHERIT" | "MANUAL" | "AUTO" }) {
  const g = await prisma.group.create({
    data: { brokerId, name: `${category}-${randomUUID().slice(0, 6)}`, leverage: 100, category, modeRestriction: category === "A_BOOK" || category === "COVERAGE" ? "LIVE_ONLY" : "ANY", forceDealingMode: opts?.force ?? false, dealingMode: opts?.dealingMode ?? "INHERIT", isClientSelectable: true },
  });
  const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId, accountNumber: n, email: `rt-${n}@test.local`, passwordHash: "x", fullName: "RT", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  return { groupId: g.id, accountId: acc.id };
}
async function marketBuy(brokerId: string, accountId: string, symbolName: string) {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId } as never);
  const { POST } = await import("@/app/api/trade/orders/route");
  const res = await POST(new NextRequest("https://t.local/api/trade/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ symbol: symbolName, side: "BUY", type: "MARKET", volume: "0.1", price: "100.10", idempotencyKey: randomUUID() }) }));
  return { status: res.status, json: await res.json() };
}
const outcome = (r: { status: number; json: { position?: unknown; order?: { status: string }; code?: string } }) =>
  r.status === 201 && r.json.position ? "FILLED" : r.status === 201 && r.json.order?.status === "PENDING" ? "QUEUED" : `REFUSED ${r.json.code}`;

describe("market orders by category and desk switch", () => {
  it.each([
    ["B_BOOK", true, false, "FILLED"], // never queued, even with the desk on
    ["B_BOOK", true, true, "FILLED"], // "always to dealer" means nothing outside DEALING
    ["DEALING", true, false, "QUEUED"], // desk on -> the dealer
    ["DEALING", false, false, "FILLED"], // desk off -> auto-fill
    ["DEALING", false, true, "QUEUED"], // desk off + "Always send to dealer"
    ["REVERSAL", true, false, "FILLED"],
    ["A_BOOK", true, false, "REFUSED LP_NOT_CONNECTED"],
    ["COVERAGE", true, false, "REFUSED SYSTEM_ACCOUNT"],
  ] as const)("%s, desk on=%s, always-to-dealer=%s -> %s", async (category, deskOn, force, expected) => {
    if (!dbReachable) return;
    const b = await broker(deskOn);
    const a = await accountIn(b.brokerId, category, { force });
    const r = await marketBuy(b.brokerId, a.accountId, b.symbolName);
    expect(outcome(r)).toBe(expected);
    if (category === "A_BOOK") expect(r.json.error).toMatch(/liquidity provider and none is connected/);
  });

  it("the retired per-group dealing mode no longer routes: a B_BOOK group set to MANUAL still auto-fills", async () => {
    if (!dbReachable) return;
    const b = await broker(true);
    const a = await accountIn(b.brokerId, "B_BOOK", { dealingMode: "MANUAL" });
    expect(outcome(await marketBuy(b.brokerId, a.accountId, b.symbolName))).toBe("FILLED");
  });

  it("a client close follows the same rule: B_BOOK closes at once with the desk on", async () => {
    if (!dbReachable) return;
    const b = await broker(true);
    const a = await accountIn(b.brokerId, "B_BOOK");
    const opened = await marketBuy(b.brokerId, a.accountId, b.symbolName);
    const id = opened.json.position.id as string;
    const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
    const res = await POST(new NextRequest(`https://t.local/api/trade/positions/${id}/close`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ closePrice: "100.00" }) }), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(200); // 202 would mean queued for the dealer
    expect((await prisma.position.findUniqueOrThrow({ where: { id } })).status).toBe("CLOSED");
  });
});

describe("A_BOOK without a connected LP takes no accounts; COVERAGE is system only", () => {
  it("account creation into an A_BOOK group is refused (every creation path goes through provisionAccount)", async () => {
    if (!dbReachable) return;
    const b = await broker(false);
    const g = await prisma.group.create({ data: { brokerId: b.brokerId, name: `A-${randomUUID().slice(0, 6)}`, leverage: 100, category: "A_BOOK", modeRestriction: "LIVE_ONLY", isClientSelectable: true } });
    const { provisionAccount } = await import("@/lib/account-provisioning");
    await expect(
      provisionAccount({ brokerId: b.brokerId, fullName: "X", email: `x-${randomUUID().slice(0, 6)}@test.local`, passwordHash: "x", accountMode: "LIVE", accountTypeId: null, currency: "USD", leverage: 100, groupId: g.id, initialBalance: D(0), country: null, phone: null, dateOfBirth: null, clientId: null } as never)
    ).rejects.toMatchObject({ code: "LP_NOT_CONNECTED" });
  });

  it("switching a group that has accounts to A_BOOK is refused", async () => {
    if (!dbReachable) return;
    const b = await broker(false);
    const a = await accountIn(b.brokerId, "B_BOOK");
    const admin = await prisma.adminUser.create({ data: { brokerId: b.brokerId, email: `p2b2-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.brokerId } as never);
    const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
    const res = await PATCH(
      new NextRequest(`https://t.local/api/manage/groups/${a.groupId}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Now A-book", leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "A_BOOK" }) }),
      { params: Promise.resolve({ id: a.groupId }) }
    );
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("LP_NOT_CONNECTED");
  });

  it("\"Always send to dealer\" is stored only on a DEALING group", async () => {
    if (!dbReachable) return;
    const b = await broker(false);
    const admin = await prisma.adminUser.create({ data: { brokerId: b.brokerId, email: `p2b2-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.brokerId } as never);
    const { POST } = await import("@/app/api/manage/groups/route");
    const mk = async (category: string) =>
      (await (await POST(new NextRequest("https://t.local/api/manage/groups", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: `F-${randomUUID().slice(0, 6)}`, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category, forceDealingMode: true }) }))).json());
    const dealing = await mk("DEALING");
    const bbook = await mk("B_BOOK");
    expect((await prisma.group.findUniqueOrThrow({ where: { id: dealing.id ?? dealing.group?.id } })).forceDealingMode).toBe(true);
    expect((await prisma.group.findUniqueOrThrow({ where: { id: bbook.id ?? bbook.group?.id } })).forceDealingMode).toBe(false);
  });

  it("signup never offers A_BOOK (no LP) or COVERAGE; the backoffice list flags acceptsAccounts", async () => {
    if (!dbReachable) return;
    const b = await broker(false);
    const ids: Record<string, string> = {};
    for (const category of ["B_BOOK", "A_BOOK", "COVERAGE"] as const) {
      const g = await prisma.group.create({ data: { brokerId: b.brokerId, name: `S-${category}-${randomUUID().slice(0, 4)}`, leverage: 100, category, modeRestriction: "ANY", isClientSelectable: true } });
      ids[category] = g.id;
    }
    vi.mocked(getClientSession).mockResolvedValue({ clientId: "c", brokerId: b.brokerId } as never);
    const portal = await import("@/app/api/portal/groups/route");
    const offered = ((await (await portal.GET(new Request("https://t.local/api/portal/groups?mode=LIVE"))).json()) as { id: string }[]).map((g) => g.id);
    expect(offered).toContain(ids.B_BOOK);
    expect(offered).not.toContain(ids.A_BOOK);
    expect(offered).not.toContain(ids.COVERAGE);

    const admin = await prisma.adminUser.create({ data: { brokerId: b.brokerId, email: `p2b2-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.brokerId } as never);
    const manage = await import("@/app/api/manage/groups/route");
    const list = (await (await (manage.GET as unknown as () => Promise<Response>)()).json()) as { id: string; acceptsAccounts: boolean }[];
    const flag = (id: string) => list.find((g) => g.id === id)?.acceptsAccounts;
    expect([flag(ids.B_BOOK), flag(ids.A_BOOK), flag(ids.COVERAGE)]).toEqual([true, false, false]);
  });
});
