import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Credit add / remove + per-account trading rights + the suspension hole (2026-09-28, owner decisions), ADVERSARIAL:
// every path is attacked on the local scratch DB -- a close-only / read-only / suspended account tries to place,
// close, change and cancel; a rights drop must cancel pending opens at once and leave queued closes; a MANAGER tries
// to apply credit directly and to approve their own request; two admins approve the same request at once; a removal
// tries to go below zero and to push open positions into margin call. Real fixtures, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn(), revokeAllAccountSessions: vi.fn().mockResolvedValue(1) }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession, revokeAllAccountSessions } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import { checkAccountTradingRights } from "@/lib/risk";
import { evaluateCreditRemoval } from "@/lib/credit-adjustment";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("account-trading-rights.test.ts: DB unreachable, skipping DB tests");
  }
});
beforeEach(() => {
  vi.mocked(publishTradingEvent).mockClear();
  vi.mocked(revokeAllAccountSessions).mockClear();
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.balanceAdjustmentRequest.deleteMany({ where }).catch(() => {});
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

async function fixture(opts: { balance?: string; credit?: string; rights?: "FULL" | "CLOSE_ONLY" | "READ_ONLY" } = {}) {
  const b = await prisma.broker.create({ data: { name: `TR ${randomUUID().slice(0, 8)}`, subdomain: `tr-${randomUUID().slice(0, 8)}` } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isClientSelectable: true } });
  const name = `TR${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.00"), tickAt: new Date() } });
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  const acc = await prisma.account.create({
    data: {
      groupId: g.id, brokerId: b.id, accountNumber: n, email: `tr-${n}@test.local`, passwordHash: "x", fullName: `TR ${n}`, accountMode: "LIVE",
      balance: D(opts.balance ?? "100000"), credit: D(opts.credit ?? "0"), leverage: 100, tradingRights: opts.rights ?? "FULL",
    },
  });
  return { brokerId: b.id, groupId: g.id, symbolId: s.id, symbolName: name, acc };
}
async function admin(brokerId: string, role: "BROKER_ADMIN" | "MANAGER" = "BROKER_ADMIN", perms: string[] = []) {
  return prisma.adminUser.create({ data: { brokerId, email: `tr-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms as never } });
}
function as(a: { id: string; role: string; brokerId: string | null }) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: a.brokerId } as never);
}
function trader(accountId: string, brokerId: string) {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId } as never);
}
async function openPosition(brokerId: string, accountId: string, symbolId: string, volume = "1") {
  const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D(100), idempotencyKey: `tr:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(volume), openPrice: D(100), status: "OPEN" } });
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const limitOrder = (symbol: string) => ({ symbol, side: "BUY", type: "LIMIT", volume: "0.10", price: "95.00", idempotencyKey: `tr:${randomUUID()}` });

describe("checkAccountTradingRights (pure)", () => {
  it("open needs ACTIVE + FULL; close / modify are refused only when READ_ONLY", () => {
    const acc = (status: "ACTIVE" | "SUSPENDED" | "CLOSED", tradingRights: "FULL" | "CLOSE_ONLY" | "READ_ONLY") => ({ status, tradingRights });
    expect(checkAccountTradingRights(acc("ACTIVE", "FULL"), "open")).toBeNull();
    expect(checkAccountTradingRights(acc("ACTIVE", "CLOSE_ONLY"), "open")).toContain("close-only");
    expect(checkAccountTradingRights(acc("ACTIVE", "READ_ONLY"), "open")).toContain("read-only");
    expect(checkAccountTradingRights(acc("SUSPENDED", "FULL"), "open")).toContain("suspended");
    expect(checkAccountTradingRights(acc("CLOSED", "FULL"), "open")).toContain("closed");
    expect(checkAccountTradingRights(acc("ACTIVE", "CLOSE_ONLY"), "close")).toBeNull();
    expect(checkAccountTradingRights(acc("ACTIVE", "CLOSE_ONLY"), "modify")).toBeNull();
    expect(checkAccountTradingRights(acc("ACTIVE", "READ_ONLY"), "close")).toContain("read-only");
    expect(checkAccountTradingRights(acc("ACTIVE", "READ_ONLY"), "modify")).toContain("read-only");
  });
});

// Every OPEN gate (the group close-only list) plus reverse; every trader close / change / cancel route.
const OPEN_GATES = [
  "app/api/trade/orders/route.ts",
  "lib/pending-trigger.ts",
  "app/api/trade/orders/[id]/requote-response/route.ts",
  "app/api/manage/positions/route.ts",
  "app/api/manage/dealing-queue/[id]/route.ts",
  "app/api/manage/dealing-desk-toggle/route.ts",
  "lib/mirror.ts",
];
const TRADER_ROUTES = [
  "app/api/trade/positions/[id]/close/route.ts",
  "app/api/trade/positions/close-by/route.ts",
  "app/api/trade/positions/close-bulk/route.ts",
  "app/api/trade/positions/[id]/route.ts",
  "app/api/trade/orders/[id]/route.ts",
];
describe("the gate is at every path (static)", () => {
  it.each(OPEN_GATES)("%s checks the account's rights before opening", (file) => {
    expect(read(file)).toMatch(/checkAccountTradingRights\([^)]*"open"\)/);
  });
  it("both reverse modes check the rights (a reverse opens the other side)", () => {
    const src = read("lib/position-actions.ts");
    for (const fn of ["executeReverseInPlace", "executeReverseCloseReopen"]) {
      const body = src.slice(src.indexOf(`export async function ${fn}`), src.indexOf(`export async function ${fn}`) + 900);
      expect(body).toContain("assertMayOpen(position)");
    }
  });
  it.each(TRADER_ROUTES)("%s refuses a read-only account", (file) => {
    expect(read(file)).toMatch(/tradingRightsRefusal\(/);
  });
  it("the automatic closes (SL/TP, stop-out) and the staff close never look at trading rights", () => {
    for (const file of ["lib/risk-monitor.ts", "lib/position-close.ts", "app/api/manage/positions/[id]/close/route.ts", "app/api/manage/positions/close-bulk/route.ts"]) {
      expect(read(file)).not.toMatch(/checkAccountTradingRights|tradingRightsRefusal/);
    }
  });
});

describe("trading rights on the trader routes (DB)", () => {
  it("a close-only account cannot place an order, a read-only one neither, a FULL one can (the hole: nothing checked it)", async () => {
    if (!dbReachable) return;
    const { POST } = await import("@/app/api/trade/orders/route");
    for (const rights of ["CLOSE_ONLY", "READ_ONLY"] as const) {
      const f = await fixture({ rights });
      trader(f.acc.id, f.brokerId);
      const r = await call(POST, "/api/trade/orders", "POST", limitOrder(f.symbolName));
      expect(r.status).toBe(400);
      expect(String(r.json.error)).toContain(rights === "CLOSE_ONLY" ? "close-only" : "read-only");
      expect(await prisma.order.count({ where: { accountId: f.acc.id } })).toBe(0);
    }
    const ok = await fixture();
    trader(ok.acc.id, ok.brokerId);
    expect((await call(POST, "/api/trade/orders", "POST", limitOrder(ok.symbolName))).status).toBe(201);
  });

  it("a SUSPENDED account signed in before the suspension cannot place an order", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    await prisma.account.update({ where: { id: f.acc.id }, data: { status: "SUSPENDED" } });
    trader(f.acc.id, f.brokerId);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", limitOrder(f.symbolName));
    expect(r.status).toBe(400);
    expect(String(r.json.error)).toContain("suspended");
    expect(await prisma.order.count({ where: { accountId: f.acc.id } })).toBe(0);
  });

  it("close-only may close and change SL/TP; read-only may do neither", async () => {
    if (!dbReachable) return;
    const { POST: close } = await import("@/app/api/trade/positions/[id]/close/route");
    const { PATCH: modify } = await import("@/app/api/trade/positions/[id]/route");
    const ro = await fixture({ rights: "READ_ONLY" });
    const p1 = await openPosition(ro.brokerId, ro.acc.id, ro.symbolId);
    trader(ro.acc.id, ro.brokerId);
    const refusedClose = await call(close, "/x", "POST", { closePrice: "100.00" }, { id: p1.id });
    expect(refusedClose).toMatchObject({ status: 403, json: { code: "TRADING_RIGHTS" } });
    const refusedSl = await call(modify, "/x", "PATCH", { slPrice: "90.00" }, { id: p1.id });
    expect(refusedSl).toMatchObject({ status: 403, json: { code: "TRADING_RIGHTS" } });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe("OPEN");

    const co = await fixture({ rights: "CLOSE_ONLY" });
    const p2 = await openPosition(co.brokerId, co.acc.id, co.symbolId);
    trader(co.acc.id, co.brokerId);
    const sl = await call(modify, "/x", "PATCH", { slPrice: "90.00" }, { id: p2.id });
    expect(sl.status).toBe(200);
    const closed = await call(close, "/x", "POST", { closePrice: "100.00" }, { id: p2.id });
    expect(closed.status).toBe(200);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p2.id } })).status).toBe("CLOSED");
  });

  it("read-only cannot cancel its own pending order; staff can still close its position", async () => {
    if (!dbReachable) return;
    const f = await fixture({ rights: "READ_ONLY" });
    const pending = await prisma.order.create({ data: { brokerId: f.brokerId, accountId: f.acc.id, symbolId: f.symbolId, side: "BUY", type: "LIMIT", volume: D("0.1"), requestedPrice: D(90), idempotencyKey: `tr:${randomUUID()}`, status: "PENDING" } });
    trader(f.acc.id, f.brokerId);
    const { DELETE } = await import("@/app/api/trade/orders/[id]/route");
    expect((await call(DELETE, "/x", "DELETE", undefined, { id: pending.id })).status).toBe(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe("PENDING");
    const pos = await openPosition(f.brokerId, f.acc.id, f.symbolId);
    as(await admin(f.brokerId));
    const { POST } = await import("@/app/api/manage/positions/[id]/close/route");
    const r = await call(POST, "/x", "POST", {}, { id: pos.id });
    expect(r.status).toBe(200);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("CLOSED");
  });

  it("a reverse (both modes) is refused on a close-only account", async () => {
    if (!dbReachable) return;
    const f = await fixture({ rights: "CLOSE_ONLY" });
    const pos = await openPosition(f.brokerId, f.acc.id, f.symbolId);
    const a = await admin(f.brokerId);
    const { executeReverseInPlace, executeReverseCloseReopen } = await import("@/lib/position-actions");
    await expect(prisma.$transaction((tx) => executeReverseInPlace(tx, { brokerId: f.brokerId, positionId: pos.id, adminId: a.id }))).rejects.toThrow(/close-only/);
    await expect(prisma.$transaction((tx) => executeReverseCloseReopen(tx, { brokerId: f.brokerId, positionId: pos.id, adminId: a.id }))).rejects.toThrow(/close-only/);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).side).toBe("BUY");
  });
});

describe("changing trading rights (DB)", () => {
  it("dropping below FULL cancels the pending opens at once (reason stored, audited, trader told) and keeps a queued close", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const limit = await prisma.order.create({ data: { brokerId: f.brokerId, accountId: f.acc.id, symbolId: f.symbolId, side: "BUY", type: "LIMIT", volume: D("0.1"), requestedPrice: D(90), idempotencyKey: `tr:${randomUUID()}`, status: "PENDING" } });
    const queuedOpen = await prisma.order.create({ data: { brokerId: f.brokerId, accountId: f.acc.id, symbolId: f.symbolId, side: "SELL", type: "MARKET", volume: D("0.1"), requestedPrice: D(100), idempotencyKey: `tr:${randomUUID()}`, status: "PENDING" } });
    const pos = await openPosition(f.brokerId, f.acc.id, f.symbolId);
    const queuedClose = await prisma.order.create({ data: { brokerId: f.brokerId, accountId: f.acc.id, symbolId: f.symbolId, side: "SELL", type: "MARKET", volume: D("1"), requestedPrice: D(100), idempotencyKey: `tr:${randomUUID()}`, status: "PENDING", closesPositionId: pos.id } });
    const a = await admin(f.brokerId);
    as(a);
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    const r = await call(PATCH, "/x", "PATCH", { tradingRights: "CLOSE_ONLY" }, { id: f.acc.id });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tradingRights: "CLOSE_ONLY", cancelledPendingOrders: 2 });
    for (const id of [limit.id, queuedOpen.id]) {
      const o = await prisma.order.findUniqueOrThrow({ where: { id } });
      expect(o.status).toBe("CANCELLED");
      expect(o.rejectionReason).toContain("close-only");
    }
    expect((await prisma.order.findUniqueOrThrow({ where: { id: queuedClose.id } })).status).toBe("PENDING");
    const audits = await prisma.auditLog.findMany({ where: { brokerId: f.brokerId } });
    expect(audits.filter((x) => x.action === "PENDING_ORDER_CANCELLED_BY_TRADING_RIGHTS")).toHaveLength(2);
    expect(audits.find((x) => x.action === "ACCOUNT_TRADING_RIGHTS_CHANGED")).toMatchObject({ actorAdminId: a.id, oldValue: { tradingRights: "FULL" }, newValue: { tradingRights: "CLOSE_ONLY" } });
    const note = await prisma.notification.findFirst({ where: { brokerId: f.brokerId, accountId: f.acc.id, type: "TRADING_RIGHTS_CHANGED" } });
    expect(note?.title).toContain("2 pending orders were cancelled");
    const cancelledEvents = vi.mocked(publishTradingEvent).mock.calls.filter((c) => c[0] === "OrderCancelled");
    expect(cancelledEvents).toHaveLength(2);
    // the same value again changes nothing and cancels nothing
    const again = await call(PATCH, "/x", "PATCH", { tradingRights: "CLOSE_ONLY" }, { id: f.acc.id });
    expect(again.json.cancelledPendingOrders).toBe(0);
  });

  it("a MANAGER without the Client trading permission cannot change it; with it, can", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    as(await admin(f.brokerId, "MANAGER"));
    expect((await call(PATCH, "/x", "PATCH", { tradingRights: "READ_ONLY" }, { id: f.acc.id })).status).toBe(403);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).tradingRights).toBe("FULL");
    as(await admin(f.brokerId, "MANAGER", ["CLIENT_TRADING"]));
    expect((await call(PATCH, "/x", "PATCH", { tradingRights: "READ_ONLY" }, { id: f.acc.id })).status).toBe(200);
    expect((await call(PATCH, "/x", "PATCH", { tradingRights: "EVERYTHING" }, { id: f.acc.id })).status).toBe(400);
  });

  it("suspending an account ends its sessions", async () => {
    if (!dbReachable) return;
    const f = await fixture();
    as(await admin(f.brokerId));
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    expect((await call(PATCH, "/x", "PATCH", { status: "SUSPENDED" }, { id: f.acc.id })).status).toBe(200);
    expect(revokeAllAccountSessions).toHaveBeenCalledWith(f.acc.id);
  });
});

describe("credit add / remove (DB)", () => {
  it("a BROKER_ADMIN adds credit at once: credit moves, balance does not, CREDIT_IN row + audit", async () => {
    if (!dbReachable) return;
    const f = await fixture({ balance: "1000" });
    as(await admin(f.brokerId));
    const { POST } = await import("@/app/api/manage/accounts/[id]/credit/route");
    const r = await call(POST, "/x", "POST", { amount: "250", note: "welcome bonus" }, { id: f.acc.id });
    expect(r).toMatchObject({ status: 200, json: { pending: false, creditBefore: "0.00", creditAfter: "250.00" } });
    const acc = await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } });
    expect(acc.credit.toString()).toBe("250");
    expect(acc.balance.toString()).toBe("1000");
    const tx = await prisma.transaction.findFirstOrThrow({ where: { accountId: f.acc.id } });
    expect(tx).toMatchObject({ type: "CREDIT_IN", status: "COMPLETED" });
    expect(tx.balanceBefore!.toString()).toBe("1000");
    expect(tx.balanceAfter!.toString()).toBe("1000");
    expect(await prisma.auditLog.count({ where: { brokerId: f.brokerId, action: "CREDIT_ADDED" } })).toBe(1);
    expect((await call(POST, "/x", "POST", { amount: "10", note: "" }, { id: f.acc.id })).status).toBe(400);
    expect((await call(POST, "/x", "POST", { amount: "0", note: "x" }, { id: f.acc.id })).status).toBe(400);
  });

  it("a MANAGER's change is only a request; the requester cannot approve it; a second admin applies it exactly once", async () => {
    if (!dbReachable) return;
    const f = await fixture({ balance: "1000" });
    const mgr = await admin(f.brokerId, "MANAGER", ["ACCOUNT_FINANCE"]);
    as(mgr);
    const { POST } = await import("@/app/api/manage/accounts/[id]/credit/route");
    // a broker whose only other staff cannot approve (web5, main 2026-09-30): the request is refused when filed
    const refused = await call(POST, "/x", "POST", { amount: "300", note: "promo" }, { id: f.acc.id });
    expect(refused.status).toBe(400);
    expect(String(refused.json.error)).toContain("needs a broker admin");
    await admin(f.brokerId); // an eligible approver now exists
    const r = await call(POST, "/x", "POST", { amount: "300", note: "promo" }, { id: f.acc.id });
    expect(r).toMatchObject({ status: 202, json: { pending: true } });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).credit.toString()).toBe("0");
    const reqId = r.json.requestId as string;
    const { POST: approve } = await import("@/app/api/manage/balance-adjustment-requests/[id]/approve/route");
    expect((await call(approve, "/x", "POST", {}, { id: reqId })).status).not.toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).credit.toString()).toBe("0");
    // two different admins approve at the same moment: the credit moves once
    const a1 = await admin(f.brokerId);
    const a2 = await admin(f.brokerId);
    const { approveBalanceAdjustmentRequest } = await import("@/lib/balance-adjustment");
    const results = await Promise.allSettled([
      prisma.$transaction((tx) => approveBalanceAdjustmentRequest(tx, { requestId: reqId, brokerId: f.brokerId, adminId: a1.id, reviewNote: null })),
      prisma.$transaction((tx) => approveBalanceAdjustmentRequest(tx, { requestId: reqId, brokerId: f.brokerId, adminId: a2.id, reviewNote: null })),
    ]);
    expect(results.filter((x) => x.status === "fulfilled" && (x.value as { ok: boolean }).ok)).toHaveLength(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).credit.toString()).toBe("300");
    expect(await prisma.transaction.count({ where: { accountId: f.acc.id, type: "CREDIT_IN" } })).toBe(1);
    const actions = (await prisma.auditLog.findMany({ where: { brokerId: f.brokerId } })).map((x) => x.action);
    expect(actions).toEqual(expect.arrayContaining(["CREDIT_REQUESTED", "CREDIT_APPROVED", "CREDIT_ADDED"]));
  });

  it("a removal never takes credit below 0", async () => {
    if (!dbReachable) return;
    const f = await fixture({ balance: "1000", credit: "100" });
    as(await admin(f.brokerId));
    const { POST } = await import("@/app/api/manage/accounts/[id]/credit/route");
    const r = await call(POST, "/x", "POST", { amount: "-150", note: "remove" }, { id: f.acc.id });
    expect(r).toMatchObject({ status: 400, json: { code: "CREDIT_REFUSED" } });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).credit.toString()).toBe("100");
    const ok = await call(POST, "/x", "POST", { amount: "-100", note: "remove all" }, { id: f.acc.id });
    expect(ok.status).toBe(200);
    expect((await prisma.transaction.findFirstOrThrow({ where: { accountId: f.acc.id, type: "CREDIT_OUT" } })).amount.toString()).toBe("-100");
  });

  it("a removal that would put open positions at or below margin call is refused (owner decision 1)", async () => {
    if (!dbReachable) return;
    // 1 lot x contract 100 x price 100 / leverage 100 = 100 margin; equity = 50 balance + 100 credit = 150 -> 150 %
    const f = await fixture({ balance: "50", credit: "100" });
    await openPosition(f.brokerId, f.acc.id, f.symbolId, "1");
    as(await admin(f.brokerId));
    const { POST } = await import("@/app/api/manage/accounts/[id]/credit/route");
    const refused = await call(POST, "/x", "POST", { amount: "-60", note: "remove" }, { id: f.acc.id }); // 90 % <= 100 %
    expect(refused).toMatchObject({ status: 400, json: { code: "CREDIT_REFUSED" } });
    expect(String(refused.json.error)).toContain("margin");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: f.acc.id } })).credit.toString()).toBe("100");
    expect((await call(POST, "/x", "POST", { amount: "-40", note: "remove" }, { id: f.acc.id })).status).toBe(200); // 110 %
  });

  it("the pure removal rule", () => {
    expect(evaluateCreditRemoval({ creditAfter: D(-1), equityAfter: D(1000), usedMargin: D(0), marginCallLevel: D(100) })?.error).toBe("CREDIT_BELOW_ZERO");
    expect(evaluateCreditRemoval({ creditAfter: D(0), equityAfter: D(100), usedMargin: D(100), marginCallLevel: D(100) })?.error).toBe("INSUFFICIENT_FREE_MARGIN");
    expect(evaluateCreditRemoval({ creditAfter: D(0), equityAfter: D(101), usedMargin: D(100), marginCallLevel: D(100) })).toBeNull();
  });
});
