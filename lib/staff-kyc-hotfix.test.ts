import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner 2026-10-06 hotfix: staff deposit/withdraw is the broker's own decision, so the staff routes NEVER block on KYC
// (recorded at once, or recorded Waiting and completed by a second admin). The KYC rule applies only to the client's
// own withdrawal request, refused with exactly "KYC not verified". Real fixtures on the local test DB.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/mirror", () => ({ onClose: vi.fn().mockResolvedValue(undefined), onFillPosition: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockResolvedValue({ usedMock: true }) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("staff-kyc-hotfix.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function setup(opts: { approval?: "SINGLE" | "DUAL"; kyc?: boolean } = {}) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `SK ${suffix}`, subdomain: `sk-${suffix}`, withdrawalApproval: opts.approval ?? "SINGLE" } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `SK-${suffix}`, leverage: 100 } });
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  const acc = await prisma.account.create({
    data: {
      groupId: g.id,
      brokerId: b.id,
      accountNumber: n,
      email: `sk-${n}@test.local`,
      passwordHash: "x",
      fullName: `SK ${n}`,
      accountMode: "LIVE",
      balance: D(1000),
      leverage: 100,
      ...(opts.kyc ? { kycRecord: { create: { status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } } } : {}),
    },
  });
  const mkAdmin = async () =>
    (await prisma.adminUser.create({ data: { brokerId: b.id, email: `sk-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
  const pm = await prisma.paymentMethod.create({ data: { brokerId: b.id, type: "BANK_TRANSFER" } });
  return { brokerId: b.id, accountId: acc.id, adminA: await mkAdmin(), adminB: await mkAdmin(), pmId: pm.id };
}
function asAdmin(brokerId: string, adminId: string) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role: "BROKER_ADMIN", brokerId } as never);
}
async function call(handler: unknown, method: string, body: unknown, params?: Record<string, string>) {
  const req = new NextRequest("https://t.local/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
const staffWithdrawal = (amount = "10") => ({ type: "WITHDRAWAL", amount, paymentMethodId: "MANUAL", note: "paid out by bank", idempotencyKey: randomUUID() });
const balanceOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance.toFixed(2);

describe("staff deposit/withdraw never blocks on KYC (owner 2026-10-06)", () => {
  it("staff withdrawal for a client WITHOUT approved KYC completes at once (SINGLE broker admin)", async () => {
    if (!dbReachable) return;
    const fx = await setup({ approval: "SINGLE", kyc: false });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffWithdrawal("10"), { id: fx.accountId });
    expect(r.json.code).not.toBe("KYC_REQUIRED");
    expect(r).toMatchObject({ status: 200, json: { status: "COMPLETED", balanceAfter: "990.00" } });
    expect(await balanceOf(fx.accountId)).toBe("990.00");
  });

  it("staff withdrawal WITHOUT approved KYC recorded Waiting (DUAL) is completed by a second admin, no KYC refusal", async () => {
    if (!dbReachable) return;
    const fx = await setup({ approval: "DUAL", kyc: false });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffWithdrawal("25"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 202, json: { status: "PENDING", step: "APPROVED_BY_FIRST_ADMIN" } });
    asAdmin(fx.brokerId, fx.adminB);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const done = await call(PATCH, "PATCH", { action: "APPROVE" }, { id: r.json.transactionId });
    expect(done.json.code).not.toBe("KYC_REQUIRED");
    expect(done).toMatchObject({ status: 200, json: { status: "COMPLETED" } });
    expect(await balanceOf(fx.accountId)).toBe("975.00");
  });
});

describe("the client's own withdrawal request keeps the KYC rule", () => {
  it("a client withdrawal request WITHOUT approved KYC is refused with exactly 'KYC not verified', nothing written", async () => {
    if (!dbReachable) return;
    const fx = await setup({ kyc: false });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const r = await call(POST, "POST", { type: "WITHDRAWAL", amount: "10", paymentMethodId: fx.pmId, destinationAddress: "IBAN" });
    expect(r).toMatchObject({ status: 403, json: { error: "KYC not verified", code: "KYC_REQUIRED" } });
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
  });

  it("a client withdrawal request WITH approved KYC passes the KYC gate and is filed", async () => {
    if (!dbReachable) return;
    const fx = await setup({ kyc: true });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const r = await call(POST, "POST", { type: "WITHDRAWAL", amount: "10", paymentMethodId: fx.pmId, destinationAddress: "IBAN" });
    expect(r.status).toBe(201);
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId, type: "WITHDRAWAL", status: "PENDING" } })).toBe(1);
  });
});
