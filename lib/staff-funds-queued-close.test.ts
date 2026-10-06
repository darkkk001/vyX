import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner decisions 2026-10-06 (web fix, real fixtures on the local test DB):
//   1. a dealer accepting a queued CLOSE on a suspended / closed account executes it (the account can still close);
//      a queued OPEN stays refused. The desk-off flush does the same.
//   2. staff may mark / pay a CLIENT-filed withdrawal without approved KYC, as an audited override; the client's own
//      withdrawal request stays refused with "KYC not verified".
//   3. a staff WITHDRAWAL is allowed on a SUSPENDED or CLOSED account; a staff DEPOSIT stays refused; the balance guard
//      still refuses an overdraw.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
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
    console.warn("staff-funds-queued-close.test.ts: DB unreachable, skipping");
  }
});

const brokers: string[] = [];
const symbolNames: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { closePendingOrderId: null } }).catch(() => {});
  await prisma.order.updateMany({ where, data: { closesPositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbolNames } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbolNames } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function call(handler: unknown, method: string, body: unknown, params?: Record<string, string>) {
  const req = new NextRequest("https://t.local/x", { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
function asAdmin(brokerId: string, adminId: string) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role: "BROKER_ADMIN", brokerId } as never);
}
const balanceOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance.toFixed(2);

// ---------------------------------------------------------------- dealing desk fixtures
type DeskFx = { brokerId: string; adminId: string; accountId: string; symbolId: string; symbolName: string };

async function deskFixture(): Promise<DeskFx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  // the dealer desk is ON (dealingDeskAutoFillAt null); a DEALING group queues while it is on
  const broker = await prisma.broker.create({ data: { name: `SFQ ${suffix}`, subdomain: `sfq-${suffix}`, dealingDeskAutoFillAt: null } });
  brokers.push(broker.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `sfq-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `SFQ${suffix.toUpperCase()}`;
  symbolNames.push(name);
  const symbol = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `SFQ-${suffix}`, groupType: "DEALING", category: "DEALING" } });
  const account = await prisma.account.create({
    data: { groupId: group.id, brokerId: broker.id, accountNumber: `6${suffix.replace(/\D/g, "").padEnd(7, "6").slice(0, 7)}`, email: `sfq-c-${suffix}@test.local`, passwordHash: "x", fullName: "SFQ Client", accountMode: "LIVE", balance: D(10000) },
  });
  return { brokerId: broker.id, adminId: admin.id, accountId: account.id, symbolId: symbol.id, symbolName: name };
}

async function openPosition(fx: DeskFx) {
  const order = await prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(90), idempotencyKey: `sfq-open:${randomUUID()}`, status: "FILLED", filledPrice: D(90), filledAt: new Date() },
  });
  return prisma.position.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(90) },
  });
}

async function refreshPrice(fx: DeskFx, bid = "100.00", ask = "100.10") {
  await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
}

// the client's own close on the dealer-managed account: queued (202), the position locked
async function queueClose(fx: DeskFx, positionId: string): Promise<string> {
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
  const { POST } = await import("@/app/api/trade/positions/[id]/close/route");
  const r = await call(POST, "POST", { closePrice: "100.00" }, { id: positionId });
  expect(r.status).toBe(202);
  return r.json.order.id as string;
}

async function queuedOpen(fx: DeskFx) {
  return prisma.order.create({
    data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D("100.10"), idempotencyKey: `sfq-q:${randomUUID()}`, status: "PENDING" },
  });
}

async function dealerAccept(fx: DeskFx, orderId: string) {
  asAdmin(fx.brokerId, fx.adminId);
  const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
  return call(PATCH, "PATCH", { action: "ACCEPT" }, { id: orderId });
}

async function deskOff(fx: DeskFx) {
  asAdmin(fx.brokerId, fx.adminId);
  const { PATCH } = await import("@/app/api/manage/dealing-desk-toggle/route");
  const r = await call(PATCH, "PATCH", { dealerOn: false });
  expect(r.status).toBe(200);
  return r.json.flushed as { orderId: string; status: string; reason?: string }[];
}

describe("queued orders on a suspended account (owner rule 2026-09-29: it can close, it opens nothing)", () => {
  it("dealer ACCEPT of a queued CLOSE on a SUSPENDED account executes it", async () => {
    if (!dbReachable) return;
    const fx = await deskFixture();
    const pos = await openPosition(fx);
    await refreshPrice(fx);
    const orderId = await queueClose(fx, pos.id);
    await prisma.account.update({ where: { id: fx.accountId }, data: { status: "SUSPENDED" } });
    const r = await dealerAccept(fx, orderId);
    expect(r).toMatchObject({ status: 200, json: { status: "FILLED", closed: true } });
    const p = await prisma.position.findUniqueOrThrow({ where: { id: pos.id } });
    expect(p.status).toBe("CLOSED");
    expect(p.realizedPnl?.toString()).toBe("10");
    expect(await balanceOf(fx.accountId)).toBe("10010.00");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "DEALING_CLOSE_ACCEPTED" } })).toBe(1);
  });

  it("dealer ACCEPT of a queued OPEN on a SUSPENDED account is still refused, nothing opens", async () => {
    if (!dbReachable) return;
    const fx = await deskFixture();
    await refreshPrice(fx);
    const order = await queuedOpen(fx);
    await prisma.account.update({ where: { id: fx.accountId }, data: { status: "SUSPENDED" } });
    const r = await dealerAccept(fx, order.id);
    expect(r).toMatchObject({ status: 400, json: { error: "this account is suspended" } });
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: fx.accountId } })).toBe(0);
  });

  it("desk-off flush executes a queued CLOSE on a SUSPENDED account and leaves a queued OPEN in the queue", async () => {
    if (!dbReachable) return;
    const fx = await deskFixture();
    const pos = await openPosition(fx);
    await refreshPrice(fx);
    const closeId = await queueClose(fx, pos.id);
    const open = await queuedOpen(fx);
    await prisma.account.update({ where: { id: fx.accountId }, data: { status: "SUSPENDED" } });
    await refreshPrice(fx, "102.00", "102.10");
    const flushed = await deskOff(fx);
    expect(flushed.find((f) => f.orderId === closeId)?.status).toBe("filled");
    expect(flushed.find((f) => f.orderId === open.id)).toMatchObject({ status: "skipped", reason: "this account is suspended" });
    expect((await prisma.position.findUniqueOrThrow({ where: { id: pos.id } })).status).toBe("CLOSED");
    expect((await prisma.order.findUniqueOrThrow({ where: { id: open.id } })).status).toBe("PENDING");
    expect(await prisma.position.count({ where: { accountId: fx.accountId, status: "OPEN" } })).toBe(0);
  });
});

// ---------------------------------------------------------------- funds fixtures
async function fundsFixture(opts: { approval?: "SINGLE" | "DUAL"; kyc?: boolean; status?: "ACTIVE" | "SUSPENDED" | "CLOSED" } = {}) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `SFF ${suffix}`, subdomain: `sff-${suffix}`, withdrawalApproval: opts.approval ?? "SINGLE" } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `SFF-${suffix}`, leverage: 100 } });
  const n = `5${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "5")}`;
  const acc = await prisma.account.create({
    data: {
      groupId: g.id,
      brokerId: b.id,
      accountNumber: n,
      email: `sff-${n}@test.local`,
      passwordHash: "x",
      fullName: `SFF ${n}`,
      accountMode: "LIVE",
      balance: D(1000),
      leverage: 100,
      status: opts.status ?? "ACTIVE",
      ...(opts.kyc ? { kycRecord: { create: { status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } } } : {}),
    },
  });
  const mkAdmin = async () =>
    (await prisma.adminUser.create({ data: { brokerId: b.id, email: `sff-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
  const pm = await prisma.paymentMethod.create({ data: { brokerId: b.id, type: "BANK_TRANSFER" } });
  return { brokerId: b.id, accountId: acc.id, accountNumber: n, adminA: await mkAdmin(), adminB: await mkAdmin(), pmId: pm.id };
}
const staffFunds = (type: "DEPOSIT" | "WITHDRAWAL", amount = "10") => ({ type, amount, paymentMethodId: "MANUAL", note: "staff entry", idempotencyKey: randomUUID() });
// a client request filed while KYC was approved (or before the rule), KYC since gone
const clientWithdrawalRow = (brokerId: string, accountId: string, amount = "100") =>
  prisma.transaction.create({ data: { brokerId, accountId, type: "WITHDRAWAL", status: "PENDING", amount: D(`-${amount}`), balanceBefore: D(1000), balanceAfter: D(1000), note: "client note", destinationAddress: "addr" } });

describe("staff pays a client-filed withdrawal without approved KYC (audited override, owner 2026-10-06)", () => {
  it("SINGLE: staff pays it; a FUNDS_REQUEST_PAID_WITHOUT_KYC audit row records actor, request, account, amount", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "SINGLE", kyc: false });
    const req = await clientWithdrawalRow(fx.brokerId, fx.accountId, "100");
    asAdmin(fx.brokerId, fx.adminA);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const r = await call(PATCH, "PATCH", { action: "APPROVE", note: "paid" }, { id: req.id });
    expect(r).toMatchObject({ status: 200, json: { status: "COMPLETED", balanceAfter: "900" } });
    expect(await balanceOf(fx.accountId)).toBe("900.00");
    const rows = await prisma.auditLog.findMany({ where: { brokerId: fx.brokerId, action: "FUNDS_REQUEST_PAID_WITHOUT_KYC" } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorAdminId: fx.adminA, entityType: "Transaction", entityId: req.id });
    expect(rows[0].newValue).toMatchObject({ override: "paid without approved KYC", transactionId: req.id, accountId: fx.accountId, accountNumber: fx.accountNumber, amount: "-100", kycApproved: false });
  });

  it("DUAL: the mark is allowed and says so, the second admin pays it with the override row", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "DUAL", kyc: false });
    const req = await clientWithdrawalRow(fx.brokerId, fx.accountId, "40");
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    asAdmin(fx.brokerId, fx.adminA);
    expect(await call(PATCH, "PATCH", { action: "APPROVE" }, { id: req.id })).toMatchObject({ status: 200, json: { marked: true } });
    const mark = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: fx.brokerId, action: "FUNDS_REQUEST_MARKED_FOR_APPROVAL" } });
    expect(mark.newValue).toMatchObject({ kycApproved: false, override: "marked without approved KYC" });
    asAdmin(fx.brokerId, fx.adminB);
    expect(await call(PATCH, "PATCH", { action: "APPROVE" }, { id: req.id })).toMatchObject({ status: 200, json: { status: "COMPLETED" } });
    expect(await balanceOf(fx.accountId)).toBe("960.00");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "FUNDS_REQUEST_PAID_WITHOUT_KYC", actorAdminId: fx.adminB } })).toBe(1);
  });

  it("with approved KYC the payout writes no override row", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "SINGLE", kyc: true });
    const req = await clientWithdrawalRow(fx.brokerId, fx.accountId, "10");
    asAdmin(fx.brokerId, fx.adminA);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    expect((await call(PATCH, "PATCH", { action: "APPROVE" }, { id: req.id })).status).toBe(200);
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "FUNDS_REQUEST_PAID_WITHOUT_KYC" } })).toBe(0);
  });

  it("the client's own withdrawal request without KYC is still refused with 'KYC not verified'", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ kyc: false });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const r = await call(POST, "POST", { type: "WITHDRAWAL", amount: "10", paymentMethodId: fx.pmId, destinationAddress: "IBAN" });
    expect(r).toMatchObject({ status: 403, json: { error: "KYC not verified", code: "KYC_REQUIRED" } });
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
  });
});

describe("staff withdraw on a suspended / closed account (payout), staff deposit refused (owner 2026-10-06)", () => {
  it("staff withdrawal on a SUSPENDED account completes at once (SINGLE)", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "SINGLE", status: "SUSPENDED" });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffFunds("WITHDRAWAL", "250"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 200, json: { status: "COMPLETED", balanceAfter: "750.00" } });
    expect(await balanceOf(fx.accountId)).toBe("750.00");
    expect(await prisma.auditLog.count({ where: { brokerId: fx.brokerId, action: "FUNDS_STAFF_RECORDED" } })).toBe(1);
  });

  it("staff withdrawal on a CLOSED account (DUAL): recorded, then a second admin completes it on the funds-requests path", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "DUAL", status: "CLOSED" });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffFunds("WITHDRAWAL", "1000"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 202, json: { status: "PENDING", step: "APPROVED_BY_FIRST_ADMIN" } });
    asAdmin(fx.brokerId, fx.adminB);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    expect(await call(PATCH, "PATCH", { action: "APPROVE" }, { id: r.json.transactionId })).toMatchObject({ status: 200, json: { status: "COMPLETED" } });
    expect(await balanceOf(fx.accountId)).toBe("0.00");
  });

  it("staff deposit on a SUSPENDED account is refused with ACCOUNT_NOT_ACTIVE, nothing written", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ status: "SUSPENDED" });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffFunds("DEPOSIT", "10"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 409, json: { code: "ACCOUNT_NOT_ACTIVE" } });
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
    expect(await balanceOf(fx.accountId)).toBe("1000.00");
  });

  it("the balance guard still refuses an overdraw on a CLOSED account", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "SINGLE", status: "CLOSED" });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffFunds("WITHDRAWAL", "1000.01"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 409, json: { code: "INSUFFICIENT_BALANCE" } });
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
    expect(await balanceOf(fx.accountId)).toBe("1000.00");
  });

  it("the balance guard refuses an overdraw when it would be filed Waiting (DUAL) on a SUSPENDED account", async () => {
    if (!dbReachable) return;
    const fx = await fundsFixture({ approval: "DUAL", status: "SUSPENDED" });
    asAdmin(fx.brokerId, fx.adminA);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const r = await call(POST, "POST", staffFunds("WITHDRAWAL", "1500"), { id: fx.accountId });
    expect(r).toMatchObject({ status: 409, json: { code: "INSUFFICIENT_BALANCE" } });
    expect(await prisma.transaction.count({ where: { accountId: fx.accountId } })).toBe(0);
  });
});
