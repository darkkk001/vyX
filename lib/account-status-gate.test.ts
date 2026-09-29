import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// The suspension hole (2026-09-29, split out of the held trading-rights batch, owner decision), ADVERSARIAL on the
// local scratch DB: the order routes never looked at Account.status and suspending never ended sessions, so a client
// signed in before a suspension could keep opening. A SUSPENDED / CLOSED account must now open nothing on any path,
// and suspending must sign it out everywhere. Closing and the automatic closes stay unaffected. Real fixtures.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
  revokeAllAccountSessions: vi.fn().mockResolvedValue(1),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession, revokeAllAccountSessions } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { checkAccountStatusForOpen } from "@/lib/risk";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("account-status-gate.test.ts: DB unreachable, skipping DB tests");
  }
});
beforeEach(() => vi.mocked(revokeAllAccountSessions).mockClear());
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function fixture(status: "ACTIVE" | "SUSPENDED" | "CLOSED" = "ACTIVE") {
  const b = await prisma.broker.create({ data: { name: `SG ${randomUUID().slice(0, 8)}`, subdomain: `sg-${randomUUID().slice(0, 8)}` } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isClientSelectable: true } });
  const name = `SG${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.00"), tickAt: new Date() } });
  const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
  const acc = await prisma.account.create({
    data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `sg-${n}@test.local`, passwordHash: "x", fullName: `SG ${n}`, accountMode: "LIVE", balance: D("100000"), leverage: 100, status },
  });
  return { brokerId: b.id, symbolId: s.id, symbolName: name, acc };
}
async function admin(brokerId: string) {
  return prisma.adminUser.create({ data: { brokerId, email: `sg-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
}
function as(a: { id: string; role: string; brokerId: string | null }) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: a.brokerId } as never);
}
function trader(accountId: string, brokerId: string) {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId } as never);
}
async function openPosition(brokerId: string, accountId: string, symbolId: string) {
  const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `sg:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "OPEN" } });
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const limitOrder = (symbol: string) => ({ symbol, side: "BUY", type: "LIMIT", volume: "0.10", price: "95.00", idempotencyKey: `sg:${randomUUID()}` });

describe("checkAccountStatusForOpen (pure)", () => {
  it("only an ACTIVE account may open", () => {
    expect(checkAccountStatusForOpen({ status: "ACTIVE" })).toBeNull();
    expect(checkAccountStatusForOpen({ status: "SUSPENDED" })).toContain("suspended");
    expect(checkAccountStatusForOpen({ status: "CLOSED" })).toContain("closed");
  });
});

// Every OPEN gate (the group close-only list): placement, pending trigger, requote accept, staff manual open, dealer
// accept, desk flush, copy-rule open.
const OPEN_GATES = [
  "app/api/trade/orders/route.ts",
  "lib/pending-trigger.ts",
  "app/api/trade/orders/[id]/requote-response/route.ts",
  "app/api/manage/positions/route.ts",
  "app/api/manage/dealing-queue/[id]/route.ts",
  "app/api/manage/dealing-desk-toggle/route.ts",
  "lib/mirror.ts",
];

describe("the gate is at every open path (static)", () => {
  it.each(OPEN_GATES)("%s checks the account status before opening", (file) => {
    expect(read(file)).toMatch(/checkAccountStatusForOpen\([^)]*\) \?\?/);
  });
  it("both reverse modes check it (a reverse opens the other side)", () => {
    const src = read("lib/position-actions.ts");
    for (const fn of ["executeReverseInPlace", "executeReverseCloseReopen"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 900);
      expect(body).toContain("assertMayOpen(position)");
    }
  });
  it("closes never look at it: the automatic closes (SL/TP, stop-out), the staff closes and the trader's own close", () => {
    for (const file of ["lib/risk-monitor.ts", "lib/position-close.ts", "app/api/manage/positions/[id]/close/route.ts", "app/api/manage/positions/close-bulk/route.ts", "app/api/trade/positions/[id]/close/route.ts"]) {
      expect(read(file)).not.toMatch(/checkAccountStatusForOpen/);
    }
  });
});

describe("a suspended / closed account opens nothing (DB)", () => {
  it("a SUSPENDED account signed in before the suspension cannot place an order; a CLOSED one neither; an ACTIVE one can", async () => {
    if (!dbReachable) return;
    const { POST } = await import("@/app/api/trade/orders/route");
    for (const status of ["SUSPENDED", "CLOSED"] as const) {
      const f = await fixture(status);
      trader(f.acc.id, f.brokerId);
      const r = await call(POST, "/api/trade/orders", "POST", limitOrder(f.symbolName));
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toContain(status === "SUSPENDED" ? "suspended" : "closed");
      expect(await prisma.order.count({ where: { accountId: f.acc.id } })).toBe(0);
    }
    const ok = await fixture();
    trader(ok.acc.id, ok.brokerId);
    expect((await call(POST, "/api/trade/orders", "POST", limitOrder(ok.symbolName))).status).toBe(201);
  });

  it("a resting order of an account suspended after placing it is rejected when it triggers, never filled", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    trader(f.acc.id, f.brokerId);
    const { POST } = await import("@/app/api/trade/orders/route");
    const placed = await call(POST, "/api/trade/orders", "POST", limitOrder(f.symbolName));
    expect(placed.status).toBe(201);
    await prisma.account.update({ where: { id: f.acc.id }, data: { status: "SUSPENDED" } });
    const order = await prisma.order.findFirstOrThrow({ where: { accountId: f.acc.id } });
    const { triggerPendingOrder } = await import("@/lib/pending-trigger");
    const out = await triggerPendingOrder(order.id, "95.00", "server");
    expect(out.kind).toBe("rejected");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).not.toBe("FILLED");
    expect(await prisma.position.count({ where: { accountId: f.acc.id } })).toBe(0);
  });

  it("a reverse (both modes) is refused on a suspended account; the position stays as it was", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const pos = await openPosition(f.brokerId, f.acc.id, f.symbolId);
    await prisma.account.update({ where: { id: f.acc.id }, data: { status: "SUSPENDED" } });
    const a = await admin(f.brokerId);
    const { executeReverseInPlace, executeReverseCloseReopen } = await import("@/lib/position-actions");
    await expect(prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId: f.brokerId, positionId: pos.id, adminId: a.id }))).rejects.toThrow(/suspended/);
    await expect(prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId: f.brokerId, positionId: pos.id, adminId: a.id }))).rejects.toThrow(/suspended/);
    const after = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect([after.side, after.status]).toEqual(["BUY", "OPEN"]);
  });
});

describe("suspending signs the account out everywhere (DB)", () => {
  it("ACTIVE -> SUSPENDED revokes every session of the account", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    as(await admin(f.brokerId));
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    expect((await call(PATCH, "/x", "PATCH", { status: "SUSPENDED" }, { id: f.acc.id })).status).toBe(200);
    expect(revokeAllAccountSessions).toHaveBeenCalledWith(f.acc.id);
  });
  it("ACTIVE -> CLOSED revokes them too", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    as(await admin(f.brokerId));
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    expect((await call(PATCH, "/x", "PATCH", { status: "CLOSED" }, { id: f.acc.id })).status).toBe(200);
    expect(revokeAllAccountSessions).toHaveBeenCalledWith(f.acc.id);
  });
  it("a change that is not a suspension (leverage; re-activation) signs nobody out", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    as(await admin(f.brokerId));
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    expect((await call(PATCH, "/x", "PATCH", { leverage: 200 }, { id: f.acc.id })).status).toBe(200);
    const s = await fixture("SUSPENDED");
    as(await admin(s.brokerId));
    expect((await call(PATCH, "/x", "PATCH", { status: "ACTIVE" }, { id: s.acc.id })).status).toBe(200);
    expect(revokeAllAccountSessions).not.toHaveBeenCalled();
  });
});
