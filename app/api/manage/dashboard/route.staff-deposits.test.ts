import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner 2026-10-05: the Dashboard's deposits-vs-withdrawals chart and the older top-level totals (depositsSum30d,
// netDeposits7d) count exactly the accounts the per-currency tiles (clients.byCurrency) count: LIVE, not a COVERAGE
// group, not the broker hedge account. Staff-recorded entries (POST /api/manage/accounts/[id]/funds) count like a
// client's once COMPLETED; a manager's entry waiting for a second admin counts nowhere; ADJUSTMENT never counts.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mirror", () => ({ onClose: vi.fn().mockResolvedValue(undefined), onFillPosition: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable || brokers.length === 0) return;
  const where = { brokerId: { in: brokers } };
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
}, 30000);

type Persona = { adminId: string; role: "BROKER_ADMIN" | "MANAGER"; brokerId: string };
async function as(p: Persona) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(p as never);
}
const req = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

async function setup() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `DSD ${s}`, subdomain: `dsd-${s}`, dealingModeAt: null, withdrawalApproval: "SINGLE" } });
  brokers.push(broker.id);
  const clientGroup = await prisma.group.create({ data: { brokerId: broker.id, name: `C-${s}`, dealingMode: "AUTO" } });
  const coverGroup = await prisma.group.create({ data: { brokerId: broker.id, name: `H-${s}`, dealingMode: "AUTO", category: "COVERAGE" } });
  const mk = (n: string, mode: "LIVE" | "DEMO", groupId: string) =>
    prisma.account.create({
      data: {
        brokerId: broker.id, groupId, accountNumber: `7${s.slice(0, 6)}${n}`, email: `dsd-${n}-${s}@t.local`, passwordHash: "x", fullName: `DSD ${n}`,
        accountMode: mode, balance: D("1000"), kycRecord: { create: { status: "APPROVED", documentType: "passport", documentFrontUrl: "test" } },
      },
    });
  const live = await mk("1", "LIVE", clientGroup.id);
  const demo = await mk("2", "DEMO", clientGroup.id);
  const hedge = await mk("3", "LIVE", coverGroup.id);
  const sysAcct = await mk("4", "LIVE", clientGroup.id);
  await prisma.broker.update({ where: { id: broker.id }, data: { coverageAccountId: sysAcct.id } });
  const mkAdmin = async (role: "BROKER_ADMIN" | "MANAGER", extra: string[] = []) =>
    (await prisma.adminUser.create({ data: { brokerId: broker.id, email: `dsd-${role}-${randomUUID().slice(0, 6)}@t.local`, passwordHash: "x", role, status: "ACTIVE", extraPermissions: extra } })).id;
  return {
    brokerId: broker.id, live, demo, hedge, sysAcct,
    adminA: { adminId: await mkAdmin("BROKER_ADMIN"), role: "BROKER_ADMIN" as const, brokerId: broker.id },
    adminB: { adminId: await mkAdmin("BROKER_ADMIN"), role: "BROKER_ADMIN" as const, brokerId: broker.id },
    mgr: { adminId: await mkAdmin("MANAGER", ["FUNDS_APPROVAL"]), role: "MANAGER" as const, brokerId: broker.id },
  };
}

async function record(p: Persona, accountId: string, amount: string) {
  await as(p);
  const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
  const body = { type: "DEPOSIT", amount, paymentMethodId: "MANUAL", note: "bank wire received", idempotencyKey: randomUUID() };
  const r = await POST(req(`https://t.local/api/manage/accounts/${accountId}/funds`, "POST", body), { params: Promise.resolve({ id: accountId }) });
  return { status: r.status, json: await r.json() };
}
async function dashboard(p: Persona) {
  await as(p);
  const { GET } = await import("./route");
  const r = await GET();
  expect(r.status).toBe(200);
  const j = await r.json();
  const usd = (j.clients.byCurrency as Array<{ currency: string; deposits30d: { count: number; amount: string }; net7d: { count: number; amount: string } }>).find((c) => c.currency === "USD");
  const chartDeposits = (j.depositsWithdrawalsByDay as Array<{ deposits: number }>).reduce((a, d) => a + d.deposits, 0);
  return {
    tileDeposits30d: Number(usd?.deposits30d.amount ?? 0),
    tileNet7d: Number(usd?.net7d.amount ?? 0),
    depositsSum30d: j.depositsSum30d as number,
    netDeposits7d: j.netDeposits7d as number,
    chartDeposits,
  };
}

describe("Dashboard money figures: one account set for tiles, chart and totals", () => {
  it("staff deposit on a live client counts everywhere; demo, COVERAGE-group, hedge-account, pending and ADJUSTMENT count nowhere", async () => {
    if (!dbReachable) return;
    const fx = await setup();
    const zero = { tileDeposits30d: 0, tileNet7d: 0, depositsSum30d: 0, netDeposits7d: 0, chartDeposits: 0 };
    expect(await dashboard(fx.adminA)).toEqual(zero);

    // 1. a staff DEPOSIT (BROKER_ADMIN: completes at once) on a live client account: tiles AND chart AND totals
    const live = await record(fx.adminA, fx.live.id, "250.00");
    expect(live.status).toBe(200);
    const row = await prisma.transaction.findUniqueOrThrow({ where: { id: live.json.transactionId } });
    expect(row.type).toBe("DEPOSIT");
    expect(row.status).toBe("COMPLETED");
    expect(row.pspAdapter).toBe("STAFF");
    expect(row.createdByAdminId).toBe(fx.adminA.adminId);
    const after1 = { tileDeposits30d: 250, tileNet7d: 250, depositsSum30d: 250, netDeposits7d: 250, chartDeposits: 250 };
    expect(await dashboard(fx.adminA)).toEqual(after1);

    // 2. staff deposits on a DEMO account, an account in a COVERAGE group and the broker hedge account: neither
    for (const a of [fx.demo, fx.hedge, fx.sysAcct]) expect((await record(fx.adminA, a.id, "100.00")).status).toBe(200);
    expect(await dashboard(fx.adminA)).toEqual(after1);

    // 3. a MANAGER's staff deposit waits for a second admin: counts nowhere until approved, then everywhere
    const pending = await record(fx.mgr, fx.live.id, "40.00");
    expect(pending.status).toBe(202);
    expect(await dashboard(fx.adminA)).toEqual(after1);
    await as(fx.adminB);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const ok = await PATCH(req(`https://t.local/api/manage/funds-requests/${pending.json.transactionId}`, "PATCH", { action: "APPROVE" }), { params: Promise.resolve({ id: pending.json.transactionId }) });
    expect(ok.status).toBe(200);
    const after3 = { tileDeposits30d: 290, tileNet7d: 290, depositsSum30d: 290, netDeposits7d: 290, chartDeposits: 290 };
    expect(await dashboard(fx.adminA)).toEqual(after3);

    // 4. an ADJUSTMENT ("Add funds") on the live client never counts as a deposit
    await prisma.transaction.create({
      data: { brokerId: fx.brokerId, accountId: fx.live.id, type: "ADJUSTMENT", status: "COMPLETED", amount: D("500"), balanceBefore: D("0"), balanceAfter: D("500"), note: "add funds", createdByAdminId: fx.adminA.adminId },
    });
    expect(await dashboard(fx.adminA)).toEqual(after3);
  });
});
