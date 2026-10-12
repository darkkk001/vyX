import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 1 (owner 2026-10-07): void a CLOSED trade. MANAGER files a request, BROKER_ADMIN executes or approves;
// refused when the balance would go below 0 or the account is CLOSED (SUSPENDED allowed); an audited ADJUSTMENT reversal.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

import { closePositionInTx } from "@/lib/position-close";
import { executeVoid, PositionActionError } from "@/lib/position-actions";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("s3b-void-closed.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];
type Fx = { brokerId: string; groupId: string; symbolId: string; symbolName: string };

async function world(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `S3b Void ${sfx}`, subdomain: `s3bv-${sfx}` } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `SV${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `SV-${sfx}`, leverage: 100, dealingMode: "AUTO" } });
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbolName: sym.name };
}
const admin = (fx: Fx, role: "BROKER_ADMIN" | "MANAGER", perms: string[] = []) =>
  prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `s3bv-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms as never } });
async function account(fx: Fx, balance: number, extra: { credit?: number; status?: "ACTIVE" | "SUSPENDED" | "CLOSED" } = {}) {
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
  return prisma.account.create({
    data: { groupId: fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: `c-${n}@test.local`, passwordHash: "x", fullName: "V Client", accountMode: "LIVE", balance: D(balance), credit: D(extra.credit ?? 0), status: extra.status ?? "ACTIVE", leverage: 100 },
  });
}
/** An OPEN 1-lot BUY at 100 (contract size 100: a close at 110 is +1000). */
async function openPos(fx: Fx, accountId: string, extra: { swap?: number } = {}) {
  const o = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `s3bv:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() },
  });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), bookType: "B_BOOK", status: "OPEN", swap: D(extra.swap ?? 0) },
  });
}
/** Closes it through the real close path (TRADE_PNL, credit used, write-off) at `price`, after an optional commission row. */
async function close(fx: Fx, posId: string, price: number, commission = 0) {
  const p = await prisma.position.findUniqueOrThrow({ where: { id: posId }, include: { symbol: true } });
  await prisma.$transaction(async (tx) => {
    if (commission) {
      const acc = await tx.account.findUniqueOrThrow({ where: { id: p.accountId } });
      await tx.account.update({ where: { id: p.accountId }, data: { balance: acc.balance.sub(commission) } });
      await tx.transaction.create({ data: { brokerId: fx.brokerId, accountId: p.accountId, type: "COMMISSION", status: "COMPLETED", amount: D(-commission), balanceBefore: acc.balance, balanceAfter: acc.balance.sub(commission), referenceType: "Position", referenceId: p.id } });
    }
    await closePositionInTx(tx, { position: p, closePrice: price });
  });
}
const acc = (id: string) => prisma.account.findUniqueOrThrow({ where: { id } });
const run = (fx: Fx, adminId: string, positionId: string) => prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId, adminId }));
async function as(fx: Fx, a: { id: string; role: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: fx.brokerId } as never);
}
async function call(handler: unknown, url: string, method = "POST", body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.positionActionRequest.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  if (symbols.length) await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
});

describe("void a closed trade: the ledger reversal", () => {
  it("a winning trade with commission and swap: balance goes back to before the trade, one audited ADJUSTMENT, position VOIDED", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 10000);
    const p = await openPos(fx, ac.id, { swap: -3 });
    // the rollover job books swap on the balance with no per-position reference
    await prisma.account.update({ where: { id: ac.id }, data: { balance: D(9997) } });
    await close(fx, p.id, 110, 7); // +1000 pnl, -7 commission -> 9997 - 7 + 1000 = 10990
    expect((await acc(ac.id)).balance.toString()).toBe("10990");
    const r = await run(fx, a.id, p.id);
    expect(r.position.status).toBe("VOIDED");
    expect(r.reversalAmount.toString()).toBe("-990");   // -(1000 - 7) - (-3)
    expect((await acc(ac.id)).balance.toString()).toBe("10000");
    const adj = await prisma.transaction.findMany({ where: { accountId: ac.id, type: "ADJUSTMENT" } });
    expect(adj).toHaveLength(1);
    expect(adj[0].amount.toString()).toBe("-990"); expect(adj[0].referenceId).toBe(p.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "CLOSED_TRADE_VOID" } });
    expect(audit.actorAdminId).toBe(a.id); expect(audit.entityId).toBe(p.id);
    expect((audit.oldValue as { status: string }).status).toBe("CLOSED");
    expect((audit.newValue as { balanceAfter: string }).balanceAfter).toBe("10000");
  });

  it("a losing trade with a negative-balance write-off: the balance is restored to before the trade", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id);
    await close(fx, p.id, 97); // -300: raw -200, write-off 200, balance 0
    expect((await acc(ac.id)).balance.toString()).toBe("0");
    await run(fx, a.id, p.id);
    expect((await acc(ac.id)).balance.toString()).toBe("100");
  });

  it("a loss paid partly from credit: balance and credit are both restored", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100, { credit: 50 });
    const p = await openPos(fx, ac.id);
    await close(fx, p.id, 98.8); // -120: raw -20, credit used 20
    const mid = await acc(ac.id);
    expect(mid.balance.toString()).toBe("0"); expect(mid.credit.toString()).toBe("30");
    await run(fx, a.id, p.id);
    const end = await acc(ac.id);
    expect(end.balance.toString()).toBe("100"); expect(end.credit.toString()).toBe("50");
  });
});

describe("void a closed trade: refusals", () => {
  it("refuses when the balance would go below zero, and changes nothing", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id);
    await close(fx, p.id, 110); // +1000 -> 1100
    await prisma.account.update({ where: { id: ac.id }, data: { balance: D(400) } }); // 700 was withdrawn
    await expect(run(fx, a.id, p.id)).rejects.toThrow(/below zero/);
    expect((await acc(ac.id)).balance.toString()).toBe("400");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("CLOSED");
    expect(await prisma.transaction.count({ where: { accountId: ac.id, type: "ADJUSTMENT" } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "CLOSED_TRADE_VOID" } })).toBe(0);
    // exactly zero is allowed
    await prisma.account.update({ where: { id: ac.id }, data: { balance: D(1000) } });
    await run(fx, a.id, p.id);
    expect((await acc(ac.id)).balance.toString()).toBe("0");
  });

  it("refuses a CLOSED account; a SUSPENDED account is allowed", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN");
    const closed = await account(fx, 100); const pc = await openPos(fx, closed.id); await close(fx, pc.id, 101);
    await prisma.account.update({ where: { id: closed.id }, data: { status: "CLOSED" } });
    await expect(run(fx, a.id, pc.id)).rejects.toThrow(/account is closed/);
    const susp = await account(fx, 100); const ps = await openPos(fx, susp.id); await close(fx, ps.id, 101);
    await prisma.account.update({ where: { id: susp.id }, data: { status: "SUSPENDED" } });
    await run(fx, a.id, ps.id);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: ps.id } })).status).toBe("VOIDED");
  });

  it("a trade is voided once: the second void is refused and moves no money", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id); await close(fx, p.id, 101);
    await run(fx, a.id, p.id);
    const after = (await acc(ac.id)).balance.toString();
    await expect(run(fx, a.id, p.id)).rejects.toThrow(PositionActionError);
    expect((await acc(ac.id)).balance.toString()).toBe(after);
    expect(await prisma.transaction.count({ where: { accountId: ac.id, type: "ADJUSTMENT" } })).toBe(1);
  });

  it("two concurrent voids of one closed trade reverse it exactly once", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id); await close(fx, p.id, 110); // 1100
    const res = await Promise.allSettled([run(fx, a.id, p.id), run(fx, a.id, p.id)]);
    expect(res.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await acc(ac.id)).balance.toString()).toBe("100");
  });

  it("the open void still works (no P/L to reverse, status VOIDED)", async () => {
    if (!dbReachable) return;
    const fx = await world(); const a = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id);
    const r = await run(fx, a.id, p.id);
    expect(r.position.status).toBe("VOIDED");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "MANUAL_POSITION_VOID" } })).toBe(1);
  });
});

describe("void a closed trade: who may void", () => {
  it("BROKER_ADMIN executes at once; a MANAGER files a request that moves no money until a different BROKER_ADMIN approves", async () => {
    if (!dbReachable) return;
    const fx = await world(); const ba = await admin(fx, "BROKER_ADMIN"); const ba2 = await admin(fx, "BROKER_ADMIN"); const mgr = await admin(fx, "MANAGER", ["ACCOUNT_FINANCE"]);
    const ac = await account(fx, 100);
    const p1 = await openPos(fx, ac.id); await close(fx, p1.id, 110); // 1100
    const p2 = await openPos(fx, ac.id); await close(fx, p2.id, 110); // 2100
    const { POST } = await import("@/app/api/manage/positions/[id]/void/route");

    await as(fx, mgr);
    const req = await call(POST, `/api/manage/positions/${p1.id}/void`, "POST", undefined, { id: p1.id });
    expect(req.status).toBe(202);
    expect((await acc(ac.id)).balance.toString()).toBe("2100");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe("CLOSED");

    await as(fx, ba);
    const direct = await call(POST, `/api/manage/positions/${p2.id}/void`, "POST", undefined, { id: p2.id });
    expect(direct.status).toBe(200);
    expect(direct.json.status).toBe("VOIDED"); expect(direct.json.reversalAmount).toBe("-1000");
    expect((await acc(ac.id)).balance.toString()).toBe("1100");

    // the requester cannot approve their own request; a different admin can
    const { POST: approve } = await import("@/app/api/manage/position-action-requests/[id]/approve/route");
    await as(fx, mgr);
    expect((await call(approve, `/x`, "POST", {}, { id: req.json.requestId })).status).toBe(409);
    await as(fx, ba2);
    const ok = await call(approve, `/x`, "POST", {}, { id: req.json.requestId });
    expect(ok.status).toBe(200);
    expect((await acc(ac.id)).balance.toString()).toBe("100");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).status).toBe("VOIDED");
  });

  it("the route answers 409 with the reason when the balance would go negative", async () => {
    if (!dbReachable) return;
    const fx = await world(); const ba = await admin(fx, "BROKER_ADMIN"); const ac = await account(fx, 100);
    const p = await openPos(fx, ac.id); await close(fx, p.id, 110);
    await prisma.account.update({ where: { id: ac.id }, data: { balance: D(5) } });
    await as(fx, ba);
    const { POST } = await import("@/app/api/manage/positions/[id]/void/route");
    const r = await call(POST, `/x`, "POST", undefined, { id: p.id });
    expect(r.status).toBe(409);
    expect(r.json.error).toMatch(/below zero/);
  });
});
