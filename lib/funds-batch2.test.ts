import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Audit 2026-09-24 Batch 2 (money, funds): withdrawals / transfers / debits keep open positions' margin; the
// per-broker withdrawal approval mode (owner decision D5); cross-client transfers refused; transfers + IB payouts
// behind the balance-adjustment maker-checker; the approve races; LIVE starting balance enforced on the server;
// LIMIT/STOP and queued MARKET orders margin-checked at placement.
// Real fixtures on the local scratch DB (committed, cleaned up), so the concurrency tests use real transactions.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

import { resolveFundsApprovalStep, approveFundsRequest, FundsRequestRaceError } from "@/lib/funds-approval";
import { evaluateBalanceDebit } from "@/lib/margin";
import { sameClient } from "@/lib/transfer";
import { requestBalanceAdjustment, approveBalanceAdjustmentRequest, BalanceRequestRaceError } from "@/lib/balance-adjustment";

const D = (v: string | number) => new Prisma.Decimal(v);

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("funds-batch2.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];

type Fx = { brokerId: string; groupId: string; symbolId: string; symbolName: string };
type Role = "BROKER_ADMIN" | "MANAGER";

// contract 100, price ~100, leverage 100: 1 lot = ~100 margin. Easy numbers.
async function broker(withdrawalApproval: "SINGLE" | "DUAL" = "DUAL"): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Funds B2 ${sfx}`, subdomain: `fb2-${sfx}`, withdrawalApproval } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `FB${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("99.90"), ask: D("100.10") } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `FB2-${sfx}`, dealingMode: "AUTO", isDefault: true, isClientSelectable: true } });
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbolName: sym.name };
}

async function admin(fx: Fx, role: Role, perms: string[] = []) {
  return prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `fb2-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms } });
}

async function account(fx: Fx, balance: number, email?: string) {
  const n = `9${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "3")}`;
  return prisma.account.create({
    data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: email ?? `c-${n}@test.local`, passwordHash: "x", fullName: "Funds B2 Client", accountMode: "LIVE", balance: D(balance) },
  });
}

async function openPosition(fx: Fx, accountId: string, lots: number) {
  const o = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(lots), requestedPrice: D("100.00"), idempotencyKey: `fb2:${randomUUID()}`, status: "FILLED", filledPrice: D("100.00"), filledAt: new Date() },
  });
  return prisma.position.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(lots), openPrice: D("100.00"), bookType: "B_BOOK" } });
}

async function withdrawal(fx: Fx, accountId: string, amount: number) {
  const acc = await prisma.account.findUniqueOrThrow({ where: { id: accountId } });
  return prisma.transaction.create({ data: { brokerId: fx.brokerId, accountId, type: "WITHDRAWAL", status: "PENDING", amount: D(-amount), balanceBefore: acc.balance, balanceAfter: acc.balance.sub(amount), note: "test withdrawal" } });
}

async function as(fx: Fx, a: { id: string; role: Role }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: fx.brokerId });
}

async function call<T extends (...args: never[]) => Promise<Response>>(handler: T, url: string, method: string, body: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://test.local${url}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await (handler as unknown as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json() };
}

const balanceOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).balance.toString();

afterAll(async () => {
  if (!dbReachable) return;
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.balanceAdjustmentRequest.deleteMany({ where });
    await prisma.ibRelationship.deleteMany({ where });
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.accountType.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

describe("pure rules", () => {
  it("withdrawal approval: SINGLE lets one BROKER_ADMIN complete; a MANAGER only marks; DUAL is unchanged", () => {
    const base = { type: "WITHDRAWAL" as const, actingAdminId: "a1" };
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: null, actingRole: "BROKER_ADMIN", withdrawalApproval: "SINGLE" })).toEqual({ step: "approve", single: true });
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: "a1", actingRole: "BROKER_ADMIN", withdrawalApproval: "SINGLE" })).toEqual({ step: "approve", single: true });
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: null, actingRole: "MANAGER", withdrawalApproval: "SINGLE" })).toEqual({ step: "mark" });
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: null, actingRole: "BROKER_ADMIN", withdrawalApproval: "DUAL" })).toEqual({ step: "mark" });
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: "a1", actingRole: "BROKER_ADMIN", withdrawalApproval: "DUAL" }).step).toBe("error");
    expect(resolveFundsApprovalStep({ ...base, markedByAdminId: "a2", actingRole: "BROKER_ADMIN", withdrawalApproval: "DUAL" })).toEqual({ step: "approve", single: false });
  });

  it("a debit: balance floor, then the margin-call line when positions are open", () => {
    expect(evaluateBalanceDebit({ balanceAfter: D(-1), equityAfter: D(-1), usedMargin: D(0), marginCallLevel: D(100) })?.error).toBe("BALANCE_BELOW_ZERO");
    expect(evaluateBalanceDebit({ balanceAfter: D(0), equityAfter: D(0), usedMargin: D(0), marginCallLevel: D(100) })).toBeNull();
    expect(evaluateBalanceDebit({ balanceAfter: D(400), equityAfter: D(400), usedMargin: D(500), marginCallLevel: D(100) })?.error).toBe("INSUFFICIENT_FREE_MARGIN");
    expect(evaluateBalanceDebit({ balanceAfter: D(500), equityAfter: D(500), usedMargin: D(500), marginCallLevel: D(100) })?.error).toBe("INSUFFICIENT_FREE_MARGIN"); // exactly on the line
    expect(evaluateBalanceDebit({ balanceAfter: D(650), equityAfter: D(650), usedMargin: D(500), marginCallLevel: D(100) })).toBeNull();
  });

  it("same client: portal client id when both have one, else the e-mail (case-insensitive)", () => {
    expect(sameClient({ clientId: "c1", email: "a@x" }, { clientId: "c1", email: "b@x" })).toBe(true);
    expect(sameClient({ clientId: "c1", email: "a@x" }, { clientId: "c2", email: "a@x" })).toBe(false);
    expect(sameClient({ clientId: null, email: "A@x.com " }, { clientId: "c9", email: "a@X.com" })).toBe(true);
    expect(sameClient({ clientId: null, email: "a@x" }, { clientId: null, email: "b@x" })).toBe(false);
  });
});

describe("withdrawals (funds-requests route)", () => {
  it("refuses a payout that would leave open positions under-margined; a smaller one completes (SINGLE, one BROKER_ADMIN)", async () => {
    if (!dbReachable) return;
    const fx = await broker("SINGLE");
    const ba = await admin(fx, "BROKER_ADMIN");
    const acc = await account(fx, 1000);
    await openPosition(fx, acc.id, 5); // ~500 margin, ~-50 floating -> equity ~950
    const big = await withdrawal(fx, acc.id, 600);
    const small = await withdrawal(fx, acc.id, 300);
    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const r1 = await call(PATCH, `/api/manage/funds-requests/${big.id}`, "PATCH", { action: "APPROVE" }, { id: big.id });
    expect(r1.status).toBe(409);
    expect(r1.json.error).toMatch(/margin/);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: big.id } })).status).toBe("PENDING");
    expect(await balanceOf(acc.id)).toBe("1000");
    const r2 = await call(PATCH, `/api/manage/funds-requests/${small.id}`, "PATCH", { action: "APPROVE" }, { id: small.id });
    expect(r2.status).toBe(200);
    expect(r2.json.status).toBe("COMPLETED");
    expect(await balanceOf(acc.id)).toBe("700");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: small.id, action: "FUNDS_REQUEST_APPROVED" } });
    expect((audit.newValue as Record<string, unknown>).approvalMode).toBe("SINGLE");
  });

  it("DUAL: a BROKER_ADMIN's approve only marks; SINGLE: a MANAGER's approve only marks", async () => {
    if (!dbReachable) return;
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const dual = await broker("DUAL");
    const ba = await admin(dual, "BROKER_ADMIN");
    const a1 = await account(dual, 1000);
    const w1 = await withdrawal(dual, a1.id, 100);
    await as(dual, { id: ba.id, role: "BROKER_ADMIN" });
    const r1 = await call(PATCH, `/api/manage/funds-requests/${w1.id}`, "PATCH", { action: "APPROVE" }, { id: w1.id });
    expect(r1.json.marked).toBe(true);
    expect(await balanceOf(a1.id)).toBe("1000");

    const single = await broker("SINGLE");
    const mgr = await admin(single, "MANAGER", ["FUNDS_APPROVAL"]);
    const a2 = await account(single, 1000);
    const w2 = await withdrawal(single, a2.id, 100);
    await as(single, { id: mgr.id, role: "MANAGER" });
    const r2 = await call(PATCH, `/api/manage/funds-requests/${w2.id}`, "PATCH", { action: "APPROVE" }, { id: w2.id });
    expect(r2.json.marked).toBe(true);
    expect(await balanceOf(a2.id)).toBe("1000");
  });

  it("two admins completing the same withdrawal at once: the money moves once, the other gets 'already reviewed'", async () => {
    if (!dbReachable) return;
    const fx = await broker("SINGLE");
    const ba1 = await admin(fx, "BROKER_ADMIN");
    const ba2 = await admin(fx, "BROKER_ADMIN");
    const acc = await account(fx, 1000);
    const w = await withdrawal(fx, acc.id, 100);
    const run = (adminId: string) =>
      prisma
        .$transaction((tx) => approveFundsRequest(tx, { transactionId: w.id, brokerId: fx.brokerId, accountId: acc.id, amount: D(-100), adminId, note: null, type: "WITHDRAWAL", approvalMode: "SINGLE" }))
        .then((r) => (r.ok ? "ok" : r.error), (e) => (e instanceof FundsRequestRaceError ? "raced" : Promise.reject(e)));
    const results = await Promise.all([run(ba1.id), run(ba2.id)]);
    expect(results.sort()).toEqual(["ok", "raced"]);
    expect(await balanceOf(acc.id)).toBe("900");
    expect(await prisma.auditLog.count({ where: { entityId: w.id, action: "FUNDS_REQUEST_APPROVED" } })).toBe(1);
  });
});

describe("debit adjustments", () => {
  it("never below 0, never below the open positions' margin; a debit that fits goes through", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const acc = await account(fx, 1000);
    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const { POST } = await import("@/app/api/manage/accounts/[id]/adjust-balance/route");
    const below0 = await call(POST, `/api/manage/accounts/${acc.id}/adjust-balance`, "POST", { amount: "-1500", note: "t" }, { id: acc.id });
    expect(below0.status).toBe(400);
    expect(below0.json.error).toMatch(/below 0/);
    await openPosition(fx, acc.id, 5);
    const margin = await call(POST, `/api/manage/accounts/${acc.id}/adjust-balance`, "POST", { amount: "-600", note: "t" }, { id: acc.id });
    expect(margin.status).toBe(400);
    expect(margin.json.error).toMatch(/margin/);
    expect(await balanceOf(acc.id)).toBe("1000");
    const ok = await call(POST, `/api/manage/accounts/${acc.id}/adjust-balance`, "POST", { amount: "-300", note: "t" }, { id: acc.id });
    expect(ok.status).toBe(200);
    expect(await balanceOf(acc.id)).toBe("700");
  });

  it("APR: two admins approving the same request at once apply it once", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const mgr = await admin(fx, "MANAGER", ["ACCOUNT_FINANCE"]);
    const ba1 = await admin(fx, "BROKER_ADMIN");
    const ba2 = await admin(fx, "BROKER_ADMIN");
    const acc = await account(fx, 1000);
    const req = await prisma.$transaction((tx) => requestBalanceAdjustment(tx, { brokerId: fx.brokerId, accountId: acc.id, amount: D(100), note: "t", adminId: mgr.id }));
    const run = (adminId: string) =>
      prisma
        .$transaction((tx) => approveBalanceAdjustmentRequest(tx, { requestId: req.id, brokerId: fx.brokerId, adminId, reviewNote: null }))
        .then((r) => (r.ok ? "ok" : r.error), (e) => (e instanceof BalanceRequestRaceError ? "raced" : Promise.reject(e)));
    const results = await Promise.all([run(ba1.id), run(ba2.id)]);
    expect(results.filter((r) => r === "ok")).toHaveLength(1);
    expect(await balanceOf(acc.id)).toBe("1100");
    expect(await prisma.transaction.count({ where: { accountId: acc.id, type: "ADJUSTMENT" } })).toBe(1);
  });
});

describe("transfers", () => {
  it("refuses different clients, refuses a source left under-margined, runs for the same client (BROKER_ADMIN)", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const a = await account(fx, 1000, "same@test.local");
    const b = await account(fx, 0, "SAME@test.local");
    const other = await account(fx, 0);
    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const { POST } = await import("@/app/api/manage/transfers/route");
    const cross = await call(POST, "/api/manage/transfers", "POST", { fromAccountId: a.id, toAccountId: other.id, amount: "10", note: "t" });
    expect(cross.status).toBe(400);
    expect(cross.json.error).toMatch(/same client/);
    await openPosition(fx, a.id, 5);
    const short = await call(POST, "/api/manage/transfers", "POST", { fromAccountId: a.id, toAccountId: b.id, amount: "600", note: "t" });
    expect(short.status).toBe(400);
    expect(short.json.error).toMatch(/margin/);
    const ok = await call(POST, "/api/manage/transfers", "POST", { fromAccountId: a.id, toAccountId: b.id, amount: "300", note: "t" });
    expect(ok.status).toBe(200);
    expect(await balanceOf(a.id)).toBe("700");
    expect(await balanceOf(b.id)).toBe("300");
  });

  it("a MANAGER's transfer is filed (202, nothing moves) and runs when a different admin approves it", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const mgr = await admin(fx, "MANAGER", ["INTERNAL_TRANSFERS"]);
    const ba = await admin(fx, "BROKER_ADMIN");
    const a = await account(fx, 1000, "m@test.local");
    const b = await account(fx, 0, "m@test.local");
    await as(fx, { id: mgr.id, role: "MANAGER" });
    const { POST } = await import("@/app/api/manage/transfers/route");
    const filed = await call(POST, "/api/manage/transfers", "POST", { fromAccountId: a.id, toAccountId: b.id, amount: "250", note: "t" });
    expect(filed.status).toBe(202);
    expect(await balanceOf(a.id)).toBe("1000");
    const req = await prisma.balanceAdjustmentRequest.findUniqueOrThrow({ where: { id: filed.json.requestId } });
    expect(req.kind).toBe("TRANSFER");
    expect(req.toAccountId).toBe(b.id);
    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const { POST: APPROVE } = await import("@/app/api/manage/balance-adjustment-requests/[id]/approve/route");
    const ap = await call(APPROVE, `/api/manage/balance-adjustment-requests/${req.id}/approve`, "POST", {}, { id: req.id });
    expect(ap.status).toBe(200);
    expect(await balanceOf(a.id)).toBe("750");
    expect(await balanceOf(b.id)).toBe("250");
    expect((await prisma.balanceAdjustmentRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe("APPROVED");
  });
});

describe("IB payouts", () => {
  it("a MANAGER's payout is filed (202); approval pays the commission recomputed then; BROKER_ADMIN pays directly", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const mgr = await admin(fx, "MANAGER", ["IB_PAYOUTS"]);
    const ba = await admin(fx, "BROKER_ADMIN");
    const ib = await account(fx, 0);
    const client = await account(fx, 1000);
    const pos = await openPosition(fx, client.id, 2);
    await prisma.position.update({ where: { id: pos.id }, data: { status: "CLOSED", closedAt: new Date(), closePrice: D("100.00") } });
    const rel = await prisma.ibRelationship.create({ data: { brokerId: fx.brokerId, ibAccountId: ib.id, clientAccountId: client.id, commissionType: "PER_LOT", commissionRate: D(5) } });
    await as(fx, { id: mgr.id, role: "MANAGER" });
    const { PATCH } = await import("@/app/api/manage/ib-relationships/[id]/route");
    const filed = await call(PATCH, `/api/manage/ib-relationships/${rel.id}`, "PATCH", { action: "PAY" }, { id: rel.id });
    expect(filed.status).toBe(202);
    expect(filed.json.amount).toBe("10");
    expect(await balanceOf(ib.id)).toBe("0");
    const dup = await call(PATCH, `/api/manage/ib-relationships/${rel.id}`, "PATCH", { action: "PAY" }, { id: rel.id });
    expect(dup.status).toBe(400); // one open payout request per partner
    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const { POST: APPROVE } = await import("@/app/api/manage/balance-adjustment-requests/[id]/approve/route");
    const ap = await call(APPROVE, `/api/manage/balance-adjustment-requests/${filed.json.requestId}/approve`, "POST", {}, { id: filed.json.requestId });
    expect(ap.status).toBe(200);
    expect(await balanceOf(ib.id)).toBe("10");
    const direct = await call(PATCH, `/api/manage/ib-relationships/${rel.id}`, "PATCH", { action: "PAY" }, { id: rel.id });
    expect(direct.status).toBe(400); // nothing pending any more
  });
});

describe("LIVE starting balance on account creation", () => {
  const body = (mode: "LIVE" | "DEMO", initialBalance: string) => ({
    fullName: "New Client", email: `new-${randomUUID().slice(0, 8)}@test.local`, password: "Password-123", accountMode: mode, initialBalance,
  });
  it("refused without the finance permission; a MANAGER's LIVE balance waits for approval; BROKER_ADMIN and DEMO fund directly", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const plain = await admin(fx, "MANAGER");
    const fin = await admin(fx, "MANAGER", ["ACCOUNT_FINANCE"]);
    const ba = await admin(fx, "BROKER_ADMIN");
    const { POST } = await import("@/app/api/manage/accounts/route");

    await as(fx, { id: plain.id, role: "MANAGER" });
    const refused = await call(POST, "/api/manage/accounts", "POST", body("LIVE", "500"));
    expect(refused.status).toBe(403);

    await as(fx, { id: fin.id, role: "MANAGER" });
    const pending = await call(POST, "/api/manage/accounts", "POST", body("LIVE", "500"));
    expect(pending.status).toBe(201);
    expect(pending.json.initialBalancePendingRequestId).toBeTruthy();
    expect(await balanceOf(pending.json.id)).toBe("0");
    const demo = await call(POST, "/api/manage/accounts", "POST", body("DEMO", "500"));
    expect(demo.status).toBe(201);
    expect(await balanceOf(demo.json.id)).toBe("500");

    await as(fx, { id: ba.id, role: "BROKER_ADMIN" });
    const direct = await call(POST, "/api/manage/accounts", "POST", body("LIVE", "500"));
    expect(direct.status).toBe(201);
    expect(await balanceOf(direct.json.id)).toBe("500");
  });
});

describe("LIMIT / STOP placement runs the margin gate", () => {
  it("an account that cannot margin the order is refused at placement; a funded one places it", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const poor = await account(fx, 50);
    const rich = await account(fx, 100000);
    const { getAccountSession } = await import("@/lib/account-auth");
    const { POST } = await import("@/app/api/trade/orders/route");
    const place = async (accountId: string) => {
      vi.mocked(getAccountSession).mockResolvedValue({ accountId, brokerId: fx.brokerId } as never);
      return call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "LIMIT", volume: "5", price: "95.00", idempotencyKey: `fb2:${randomUUID()}` });
    };
    const r1 = await place(poor.id);
    expect(r1.status).toBe(400);
    expect(["INSUFFICIENT_MARGIN", "INSUFFICIENT_BALANCE"]).toContain(r1.json.error);
    expect(await prisma.order.count({ where: { accountId: poor.id } })).toBe(0);
    const r2 = await place(rich.id);
    expect(r2.status).toBe(201);
  });
});
