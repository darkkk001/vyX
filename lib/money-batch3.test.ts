import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Audit 2026-09-24 Batch 3 (money): group change vs leverage permission; broker-wide open-lots limit leaves the
// broker's hedge legs out; an in-place reverse flips the hedge leg and the mirrored copy with it; dashboard money
// tiles (withdrawal sign, pending sum, broker-book closed since the trading day start: live, not voided, no hedge).
// Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

import { checkBrokerExposure } from "@/lib/risk";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("money-batch3.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbols: string[] = [];
type Fx = { brokerId: string; groupId: string; symbolId: string; symbolName: string };

async function broker(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Money B3 ${sfx}`, subdomain: `mb3-${sfx}` } });
  brokers.push(b.id);
  const sym = await prisma.symbol.create({ data: { name: `MB${sfx.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  symbols.push(sym.name);
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: sym.name, bid: D("99.90"), ask: D("100.10") } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `MB3-${sfx}`, leverage: 100, dealingMode: "AUTO" } });
  return { brokerId: b.id, groupId: g.id, symbolId: sym.id, symbolName: sym.name };
}
const admin = (fx: Fx, role: "BROKER_ADMIN" | "MANAGER", perms: string[] = []) =>
  prisma.adminUser.create({ data: { brokerId: fx.brokerId, email: `mb3-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms } });
async function account(fx: Fx, opts?: { groupId?: string; mode?: "LIVE" | "DEMO"; leverage?: number }) {
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
  return prisma.account.create({
    data: { groupId: opts?.groupId ?? fx.groupId, brokerId: fx.brokerId, accountNumber: n, email: `c-${n}@test.local`, passwordHash: "x", fullName: "B3 Client", accountMode: opts?.mode ?? "LIVE", balance: D(100000), leverage: opts?.leverage ?? 100 },
  });
}
async function position(fx: Fx, accountId: string, lots: number, extra?: Partial<{ side: "BUY" | "SELL"; status: "OPEN" | "CLOSED" | "VOIDED"; realizedPnl: number; closedAt: Date; bookType: "A_BOOK" | "B_BOOK" }>) {
  const o = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: extra?.side ?? "BUY", type: "MARKET", volume: D(lots), requestedPrice: D(100), idempotencyKey: `mb3:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() },
  });
  return prisma.position.create({
    data: {
      brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: extra?.side ?? "BUY", volume: D(lots), openPrice: D(100), bookType: extra?.bookType ?? "B_BOOK",
      status: extra?.status ?? "OPEN", realizedPnl: extra?.realizedPnl != null ? D(extra.realizedPnl) : null, closedAt: extra?.closedAt ?? null, closePrice: extra?.status && extra.status !== "OPEN" ? D(100) : null,
    },
  });
}
async function as(fx: Fx, a: { id: string; role: string }) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: fx.brokerId } as never);
}

afterAll(async () => {
  if (!dbReachable) return;
  if (brokers.length) {
    const where = { brokerId: { in: brokers } };
    await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } });
    await prisma.mirrorLink.deleteMany({ where: { rule: { brokerId: { in: brokers } } } }).catch(() => {});
    await prisma.mirrorRule.deleteMany({ where }).catch(() => {});
    await prisma.notification.deleteMany({ where }).catch(() => {});
    await prisma.auditLog.deleteMany({ where });
    await prisma.transaction.deleteMany({ where });
    await prisma.position.updateMany({ where, data: { coveragePositionId: null } });
    await prisma.position.deleteMany({ where });
    await prisma.order.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.brokerSymbol.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.group.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

describe("CHANGE GROUP vs leverage permission", () => {
  it("a MANAGER without finance rights cannot move an account into a group with different leverage; same leverage is fine", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const same = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `same-${randomUUID().slice(0, 6)}`, leverage: 100, isClientSelectable: true } });
    const higher = await prisma.group.create({ data: { brokerId: fx.brokerId, name: `hi-${randomUUID().slice(0, 6)}`, leverage: 500, isClientSelectable: true } });
    const acc = await account(fx);
    const mgr = await admin(fx, "MANAGER");
    const fin = await admin(fx, "MANAGER", ["ACCOUNT_FINANCE"]);
    const { PATCH } = await import("@/app/api/manage/accounts/[id]/route");
    const patch = async (groupId: string) => {
      const res = await PATCH(new NextRequest(`https://t.local/api/manage/accounts/${acc.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ groupId }) }), { params: Promise.resolve({ id: acc.id }) });
      return { status: res.status, json: await res.json() };
    };
    await as(fx, mgr);
    const refused = await patch(higher.id);
    expect(refused.status).toBe(403);
    expect(refused.json.code).toBe("GROUP_CHANGE_CHANGES_LEVERAGE");
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).leverage).toBe(100);
    expect((await patch(same.id)).status).toBe(200);
    await as(fx, fin);
    expect((await patch(higher.id)).status).toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).leverage).toBe(500);
  });
});

describe("broker-wide open-lots limit (D7)", () => {
  it("counts client positions only: the broker's hedge legs are left out", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const client = await account(fx);
    const cov = await account(fx);
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    await position(fx, client.id, 5);
    await position(fx, cov.id, 5, { bookType: "A_BOOK" });
    // 5 client lots + 5 new = 10 = limit: allowed (the 5 hedge lots used to push this over)
    expect(await checkBrokerExposure(prisma, fx.brokerId, D(5), D(10))).toBeNull();
    expect(await checkBrokerExposure(prisma, fx.brokerId, D(5.01), D(10))).toMatch(/lots/);
  });
});

describe("Reverse in place: followers flip with the position", () => {
  it("the hedge leg and the mirrored copy change side with it, each audited", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const client = await account(fx);
    const cov = await account(fx);
    const target = await account(fx);
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    const pos = await position(fx, client.id, 1, { side: "BUY" });
    const leg = await position(fx, cov.id, 1, { side: "BUY", bookType: "A_BOOK" });
    await prisma.position.update({ where: { id: pos.id }, data: { covered: true, coveragePositionId: leg.id } });
    const copy = await position(fx, target.id, 1, { side: "SELL" });
    const rule = await prisma.mirrorRule.create({ data: { brokerId: fx.brokerId, sourceType: "ACCOUNT", sourceId: client.id, targetAccountId: target.id, direction: "REVERSE", createdById: ba.id } });
    await prisma.mirrorLink.create({ data: { ruleId: rule.id, sourcePositionId: pos.id, targetPositionId: copy.id } });

    await as(fx, ba);
    const { POST } = await import("@/app/api/manage/positions/[id]/reverse/route");
    const res = await POST(new NextRequest(`https://t.local/api/manage/positions/${pos.id}/reverse`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode: "IN_PLACE" }) }), { params: Promise.resolve({ id: pos.id }) });
    expect(res.status).toBe(200);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).side).toBe("SELL");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: leg.id } })).side).toBe("SELL");
    expect((await prisma.position.findUniqueOrThrow({ where: { id: copy.id } })).side).toBe("BUY");
    expect(await prisma.auditLog.count({ where: { entityId: leg.id, action: "POSITION_COVERAGE_REVERSED_IN_PLACE" } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { entityId: copy.id, action: "MIRROR_REVERSED_IN_PLACE" } })).toBe(1);
  });
});

describe("dashboard money tiles", () => {
  it("withdrawals subtract, pending is a positive sum, and closed today is broker-book live client trades since 22:00 UTC", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const live = await account(fx);
    const demo = await account(fx, { mode: "DEMO" });
    const cov = await account(fx);
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    const tx = (type: "DEPOSIT" | "WITHDRAWAL", amount: number, status: "COMPLETED" | "PENDING") =>
      prisma.transaction.create({ data: { brokerId: fx.brokerId, accountId: live.id, type, status, amount: D(amount), balanceBefore: D(0), balanceAfter: D(0) } });
    await tx("DEPOSIT", 1000, "COMPLETED");
    await tx("WITHDRAWAL", -300, "COMPLETED");
    await tx("WITHDRAWAL", -250, "PENDING");

    const now = new Date();
    const dayStart = new Date(now); dayStart.setUTCHours(22, 0, 0, 0); if (dayStart > now) dayStart.setUTCDate(dayStart.getUTCDate() - 1);
    const inDay = new Date(Math.max(dayStart.getTime() + 60_000, now.getTime() - 60_000));
    const before = new Date(dayStart.getTime() - 60_000);
    await position(fx, live.id, 1, { status: "CLOSED", realizedPnl: -40, closedAt: inDay }); // client lost 40 -> broker +40
    await position(fx, live.id, 1, { status: "CLOSED", realizedPnl: 25, closedAt: inDay }); // client won 25 -> broker -25
    await position(fx, live.id, 1, { status: "CLOSED", realizedPnl: -999, closedAt: before }); // yesterday's trading day
    await position(fx, live.id, 1, { status: "VOIDED", realizedPnl: -999, closedAt: inDay }); // voided
    await position(fx, demo.id, 1, { status: "CLOSED", realizedPnl: -999, closedAt: inDay }); // demo
    await position(fx, cov.id, 1, { status: "CLOSED", realizedPnl: -999, closedAt: inDay }); // broker hedge leg
    await position(fx, live.id, 1, { status: "CLOSED", realizedPnl: -999, closedAt: inDay, bookType: "A_BOOK" }); // market book

    await as(fx, ba);
    const { GET } = await import("@/app/api/manage/dashboard/route");
    const res = await GET();
    const j = await res.json();
    expect(j.netDeposits7d).toBe(700);
    expect(j.pendingWithdrawalSum).toBe(250);
    const today = j.depositsWithdrawalsByDay[j.depositsWithdrawalsByDay.length - 1];
    expect(today.withdrawals).toBe(300);
    expect(j.brokerBookClosedToday).toBe(15);
    expect(j.brokerBookClosedTodayCount).toBe(2);
    expect(new Date(j.tradingDayStart).getUTCHours()).toBe(22);
  });
});

describe("positions list flags the broker's hedge legs", () => {
  it("isCoverageLeg on the coverage account's positions; accountMode on every row", async () => {
    if (!dbReachable) return;
    const fx = await broker();
    const ba = await admin(fx, "BROKER_ADMIN");
    const client = await account(fx, { mode: "DEMO" });
    const cov = await account(fx);
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: cov.id } });
    await position(fx, client.id, 1);
    await position(fx, cov.id, 1, { bookType: "A_BOOK" });
    await as(fx, ba);
    const { GET } = await import("@/app/api/manage/positions/route");
    const j = await (await GET()).json();
    const rows = j.rows as { accountId: string; isCoverageLeg: boolean; accountMode: string }[];
    expect(rows.find((r) => r.accountId === cov.id)?.isCoverageLeg).toBe(true);
    const c = rows.find((r) => r.accountId === client.id);
    expect(c?.isCoverageLeg).toBe(false);
    expect(c?.accountMode).toBe("DEMO");
  });
});
