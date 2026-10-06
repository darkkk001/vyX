import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 8 (money / risk), ADVERSARIAL: each rule is attacked, not just exercised -- a withdrawal without KYC
// (filed, marked, approved through the route AND straight through the paying function), another admin cancelling a
// mark, a leverage apply that would stop accounts out, a coverage switch that would orphan hedge legs, lot-breaking
// partial closes, a manager setting leverage, an approver picking a hidden group, the internal secret reading another
// tenant, a manager editing type pricing. Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockResolvedValue({ usedMock: true }) }));
vi.mock("@/lib/live-account-credentials", () => ({ stashRevealedCredentials: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import { marginLevelAfterLeverage } from "@/lib/group-leverage-apply";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch8.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => vi.mocked(publishTradingEvent).mockClear());
const brokers: string[] = [];
const symbols: string[] = [];
const clients: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.liveAccountRequest.deleteMany({ where }).catch(() => {});
  await prisma.clientKycRecord.deleteMany({ where: { clientId: { in: clients } } }).catch(() => {});
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: clients } } }).catch(() => {});
  await prisma.accountType.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function broker(data: Partial<Prisma.BrokerCreateInput> = {}) {
  const b = await prisma.broker.create({ data: { name: `P2B8 ${randomUUID().slice(0, 8)}`, subdomain: `p2b8-${randomUUID().slice(0, 8)}`, ...data } });
  brokers.push(b.id);
  return b.id;
}
async function admin(brokerId: string, role: "BROKER_ADMIN" | "MANAGER" = "BROKER_ADMIN", perms: string[] = []) {
  const a = await prisma.adminUser.create({ data: { brokerId, email: `b8-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms as never } });
  return a;
}
function as(a: { id: string; role: string; brokerId: string | null }) {
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: a.brokerId } as never);
}
async function group(brokerId: string, data: Partial<Prisma.GroupUncheckedCreateInput> = {}) {
  return prisma.group.create({ data: { brokerId, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isClientSelectable: true, ...data } });
}
async function account(brokerId: string, groupId: string, data: Partial<Prisma.AccountUncheckedCreateInput> = {}) {
  const n = `8${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "8")}`;
  return prisma.account.create({ data: { groupId, brokerId, accountNumber: n, email: `b8-${n}@test.local`, passwordHash: "x", fullName: `B8 ${n}`, accountMode: "LIVE", balance: D(1000), leverage: 100, ...data } });
}
async function symbol(brokerId: string, opts: { minLot?: string; lotStep?: string } = {}) {
  const name = `B8${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  await prisma.brokerSymbol.create({ data: { brokerId, symbolId: s.id, minLot: D(opts.minLot ?? "0.01"), maxLot: D(100), lotStep: D(opts.lotStep ?? "0.01"), enabled: true } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.00"), tickAt: new Date() } });
  return s;
}
async function openPosition(brokerId: string, accountId: string, symbolId: string, volume = "1") {
  const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(volume), requestedPrice: D(100), idempotencyKey: `b8:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(volume), openPrice: D(100), status: "OPEN" } });
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>, headers: Record<string, string> = {}) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}
async function pendingWithdrawal(brokerId: string, accountId: string, amount = "100", note: string | null = "trader note") {
  return prisma.transaction.create({ data: { brokerId, accountId, type: "WITHDRAWAL", status: "PENDING", amount: D(`-${amount}`), balanceBefore: D(1000), balanceAfter: D(1000), note, destinationAddress: "addr" } });
}

describe("132: approved KYC gates withdrawals only", () => {
  it("a trader without approved KYC cannot file a withdrawal; a deposit needs no KYC; either KYC (account or portal client) opens it", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b);
    const pm = await prisma.paymentMethod.create({ data: { brokerId: b, type: "BANK_TRANSFER" } });
    const acc = await account(b, g.id);
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const w = { type: "WITHDRAWAL", amount: "10", paymentMethodId: pm.id, destinationAddress: "IBAN" };
    const refused = await call(POST, "/api/trade/funds-requests", "POST", w);
    expect(refused).toMatchObject({ status: 403, json: { code: "KYC_REQUIRED" } });
    expect(await prisma.transaction.count({ where: { accountId: acc.id } })).toBe(0);
    expect((await call(POST, "/x", "POST", { type: "DEPOSIT", amount: "10", paymentMethodId: pm.id })).status).toBe(201);
    // a PENDING in-app KYC is not approved
    await prisma.kycRecord.create({ data: { accountId: acc.id, status: "PENDING", documentType: "passport", documentFrontUrl: "x" } });
    expect((await call(POST, "/x", "POST", w)).status).toBe(403);
    await prisma.kycRecord.update({ where: { accountId: acc.id }, data: { status: "APPROVED" } });
    expect((await call(POST, "/x", "POST", w)).status).toBe(201);
    // portal client KYC alone also counts
    const c = await prisma.client.create({ data: { brokerId: b, email: `c8-${randomUUID().slice(0, 8)}@t.local`, passwordHash: "x", fullName: "C8" } });
    clients.push(c.id);
    await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } });
    const acc2 = await account(b, g.id, { clientId: c.id });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc2.id, brokerId: b } as never);
    expect((await call(POST, "/x", "POST", w)).status).toBe(201);
  });

  it("the paying function refuses a client withdrawal without approved KYC unless staff pay it as an audited override (owner 2026-10-06)", async () => {
    if (!dbReachable) return;
    const b = await broker({ withdrawalApproval: "SINGLE" });
    const g = await group(b);
    const acc = await account(b, g.id);
    const tx = await pendingWithdrawal(b, acc.id);
    const ba = await admin(b, "BROKER_ADMIN");
    as(ba);
    // bypassing the route: the paying function itself still refuses by default, money does not move
    const { approveFundsRequest } = await import("@/lib/funds-approval");
    const direct = await prisma.$transaction((t) => approveFundsRequest(t, { transactionId: tx.id, brokerId: b, accountId: acc.id, amount: tx.amount, adminId: ba.id, note: null, type: "WITHDRAWAL", approvalMode: "SINGLE" }));
    expect(direct).toMatchObject({ ok: false, code: "KYC_REQUIRED" });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).balance.toString()).toBe("1000");
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).status).toBe("PENDING");
    // staff on the route: paid, with the override audit row
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const paid = await call(PATCH, "/x", "PATCH", { action: "APPROVE", note: "sent" }, { id: tx.id });
    expect(paid.status).toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acc.id } })).balance.toString()).toBe("900");
    expect(await prisma.auditLog.count({ where: { brokerId: b, action: "FUNDS_REQUEST_PAID_WITHOUT_KYC", entityId: tx.id } })).toBe(1);
  });
});

describe("109 / 111 / 112 / 110: funds review", () => {
  it("111: only the admin who marked a withdrawal can cancel the mark", async () => {
    if (!dbReachable) return;
    const b = await broker({ withdrawalApproval: "DUAL" });
    const g = await group(b);
    const acc = await account(b, g.id);
    await prisma.kycRecord.create({ data: { accountId: acc.id, status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } });
    const tx = await pendingWithdrawal(b, acc.id);
    const a1 = await admin(b, "BROKER_ADMIN");
    const a2 = await admin(b, "BROKER_ADMIN");
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    as(a1);
    expect((await call(PATCH, "/x", "PATCH", { action: "APPROVE" }, { id: tx.id })).json).toMatchObject({ marked: true });
    as(a2);
    expect((await call(PATCH, "/x", "PATCH", { action: "CANCEL_MARK" }, { id: tx.id })).status).toBe(403);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).markedByAdminId).toBe(a1.id);
    as(a1);
    expect((await call(PATCH, "/x", "PATCH", { action: "CANCEL_MARK" }, { id: tx.id })).status).toBe(200);
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } })).markedByAdminId).toBeNull();
  });

  it("109 + 112: a reject keeps the trader's note (an empty admin note erases nothing), stores the admin note apart, and tells the trader", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b);
    const acc = await account(b, g.id);
    const a = await admin(b);
    as(a);
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const t1 = await pendingWithdrawal(b, acc.id, "50", "please send to my bank");
    expect((await call(PATCH, "/x", "PATCH", { action: "REJECT", note: "" }, { id: t1.id })).status).toBe(200);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: t1.id } })).toMatchObject({ status: "REJECTED", note: "please send to my bank", reviewNote: null });
    const t2 = await pendingWithdrawal(b, acc.id, "60", "second");
    vi.mocked(publishTradingEvent).mockClear();
    expect((await call(PATCH, "/x", "PATCH", { action: "REJECT", note: "name does not match" }, { id: t2.id })).status).toBe(200);
    expect(await prisma.transaction.findUniqueOrThrow({ where: { id: t2.id } })).toMatchObject({ note: "second", reviewNote: "name does not match" });
    expect(publishTradingEvent).toHaveBeenCalledWith("FundsRequestResolved", expect.objectContaining({ account_id: acc.id, outcome: "REJECTED", review_note: "name does not match", message: "Your withdrawal of 60 was rejected: name does not match" }));
    const n = await prisma.notification.findFirstOrThrow({ where: { entityId: t2.id, type: "FUNDS_REQUEST_REJECTED" } });
    expect(n.accountId).toBe(acc.id);
    // the trader-scoped notice never lands in the staff inbox (accountId set)
    const { GET: inbox } = await import("@/app/api/manage/notifications/route");
    const staff = await call(inbox, "/api/manage/notifications");
    expect(JSON.stringify(staff.json)).not.toContain(t2.id);
    // the trader's own list shows both notes
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b } as never);
    const { GET: mine } = await import("@/app/api/trade/funds-requests/route");
    const row = ((await call(mine, "/api/trade/funds-requests")).json as { id: string; note: string; reviewNote: string }[]).find((r) => r.id === t2.id);
    expect(row).toMatchObject({ note: "second", reviewNote: "name does not match" });
  });

  it("110: the deposit screen's KPIs count every request, not the latest 200 rows", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b);
    const acc = await account(b, g.id);
    await admin(b).then(as);
    const now = Date.now();
    await prisma.transaction.createMany({
      data: [
        ...Array.from({ length: 230 }, (_, i) => ({ brokerId: b, accountId: acc.id, type: "DEPOSIT" as const, status: "COMPLETED" as const, amount: D(10), balanceBefore: D(0), balanceAfter: D(10), createdAt: new Date(now - i * 60_000) })),
        ...Array.from({ length: 5 }, () => ({ brokerId: b, accountId: acc.id, type: "WITHDRAWAL" as const, status: "COMPLETED" as const, amount: D(-20), balanceBefore: D(0), balanceAfter: D(0) })),
        ...Array.from({ length: 3 }, () => ({ brokerId: b, accountId: acc.id, type: "WITHDRAWAL" as const, status: "REJECTED" as const, amount: D(-5), balanceBefore: D(0), balanceAfter: D(0) })),
        { brokerId: b, accountId: acc.id, type: "DEPOSIT" as const, status: "COMPLETED" as const, amount: D(999), balanceBefore: D(0), balanceAfter: D(0), createdAt: new Date(now - 40 * 86_400_000) },
        { brokerId: b, accountId: acc.id, type: "WITHDRAWAL" as const, status: "PENDING" as const, amount: D(-70), balanceBefore: D(0), balanceAfter: D(0) },
      ],
    });
    const { GET } = await import("@/app/api/manage/funds-requests/route");
    const res = await call(GET, "/api/manage/funds-requests");
    expect(res.json.rows.length).toBeLessThanOrEqual(200);
    expect(res.json.kpis).toEqual({
      pendingDeposits: { count: 0, amount: "0.00" },
      pendingWithdrawals: { count: 1, amount: "70.00" },
      markedWithdrawals: 0,
      deposits30d: { count: 230, amount: "2300.00" },
      withdrawals30d: { count: 5, amount: "100.00" },
      avgDeposit30d: "10.00",
      rejectedAllTime: 3,
    });
  });
});

describe("128 / 184: apply group leverage to existing accounts", () => {
  it("margin level scales with the leverage ratio", () => {
    expect(marginLevelAfterLeverage(150, 500, 100)).toBe(30);
    expect(marginLevelAfterLeverage(150, 100, 500)).toBe(750);
    expect(marginLevelAfterLeverage(null, 500, 100)).toBeNull();
  });

  it("preview flags the stop-out; apply leaves it out unless included; audits each account; refuses a stale preview and a manager", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b, { leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50) });
    const s = await symbol(b);
    const poor = await account(b, g.id, { leverage: 500, balance: D(30) }); // 1 lot x 100 x 100 / 500 = 20 used -> 150% -> 30% at 1:100
    const rich = await account(b, g.id, { leverage: 500, balance: D(1000) }); // 5000% -> 1000%
    const flat = await account(b, g.id, { leverage: 200 }); // no positions
    const same = await account(b, g.id, { leverage: 100 }); // already at the group's leverage: not listed
    await openPosition(b, poor.id, s.id);
    await openPosition(b, rich.id, s.id);
    const route = await import("@/app/api/manage/groups/[id]/apply-leverage/route");

    const mgr = await admin(b, "MANAGER");
    as(mgr);
    expect((await call(route.GET, "/x", "GET", undefined, { id: g.id })).status).toBe(403);
    expect((await call(route.POST, "/x", "POST", { expectedLeverage: 100 }, { id: g.id })).status).toBe(403);

    const ba = await admin(b, "BROKER_ADMIN");
    as(ba);
    const preview = await call(route.GET, "/x", "GET", undefined, { id: g.id });
    type Row = { accountNumber: string; marginLevel: number | null; marginLevelAfter: number | null };
    const byNo = Object.fromEntries((preview.json.rows as Row[]).map((r) => [r.accountNumber, r]));
    expect(Object.keys(byNo).sort()).toEqual([poor.accountNumber, rich.accountNumber, flat.accountNumber].sort());
    expect(byNo[poor.accountNumber]).toMatchObject({ leverage: 500, newLeverage: 100, belowStopOut: true, belowMarginCall: true });
    expect(byNo[poor.accountNumber].marginLevel).toBeCloseTo(150, 6);
    expect(byNo[poor.accountNumber].marginLevelAfter).toBeCloseTo(30, 6);
    expect(byNo[rich.accountNumber]).toMatchObject({ belowStopOut: false });
    expect(byNo[flat.accountNumber]).toMatchObject({ marginLevel: null, belowStopOut: false });

    // a preview confirmed against another leverage is refused
    expect((await call(route.POST, "/x", "POST", { expectedLeverage: 200 }, { id: g.id })).status).toBe(409);

    // a concurrent single-account edit wins over the apply
    await prisma.account.update({ where: { id: flat.id }, data: { leverage: 300 } });
    const applied = await call(route.POST, "/x", "POST", { expectedLeverage: 100 }, { id: g.id });
    expect(applied.status).toBe(200);
    // flat was re-read at apply time (now 1:300) and applied from that value: nothing stale is written
    expect([...applied.json.applied].sort()).toEqual([rich.accountNumber, flat.accountNumber].sort());
    expect(applied.json.changedMeanwhile).toEqual([]);
    expect(applied.json.skippedBelowStopOut).toEqual([poor.accountNumber]);
    const lev = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).leverage;
    expect([await lev(poor.id), await lev(rich.id), await lev(same.id)]).toEqual([500, 100, 100]);
    expect(await lev(flat.id)).toBe(100);
    expect(await prisma.auditLog.count({ where: { brokerId: b, action: "LEVERAGE_CHANGE", entityId: rich.id } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { brokerId: b, action: "GROUP_LEVERAGE_APPLIED", entityId: g.id } })).toBe(1);
    expect(publishTradingEvent).toHaveBeenCalledWith("AccountUpdated", expect.objectContaining({ account_id: rich.id }));

    // explicitly included: the stop-out account changes too
    const included = await call(route.POST, "/x", "POST", { expectedLeverage: 100, includeBelowStopOut: true }, { id: g.id });
    expect(included.json.applied).toEqual([poor.accountNumber]);
    expect(await lev(poor.id)).toBe(100);
  });
});

describe("187 / 293: coverage account on the server", () => {
  it("broker admin only; a coverage-group account only; refused while the current one holds open legs; audited", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const cov = await group(b, { category: "COVERAGE", groupType: "COVERAGE", isClientSelectable: false, name: "Dealer Coverage (system)" });
    const clientGroup = await group(b);
    const c1 = await account(b, cov.id);
    const c2 = await account(b, cov.id);
    const client = await account(b, clientGroup.id);
    const s = await symbol(b);
    await prisma.broker.update({ where: { id: b }, data: { coverageAccountId: c1.id } });
    const route = await import("@/app/api/manage/coverage/account/route");
    as(await admin(b, "MANAGER"));
    expect((await call(route.PUT, "/x", "PUT", { accountId: c2.id })).status).toBe(403);
    as(await admin(b, "BROKER_ADMIN"));
    expect((await call(route.PUT, "/x", "PUT", { accountId: client.id })).status).toBe(400);
    const leg = await openPosition(b, c1.id, s.id);
    const blocked = await call(route.PUT, "/x", "PUT", { accountId: c2.id });
    expect(blocked).toMatchObject({ status: 409, json: { code: "COVERAGE_HAS_OPEN_LEGS" } });
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b } })).coverageAccountId).toBe(c1.id);
    await prisma.position.update({ where: { id: leg.id }, data: { status: "CLOSED", closedAt: new Date(), closePrice: D(100) } });
    const ok = await call(route.PUT, "/x", "PUT", { accountId: c2.id });
    expect(ok).toMatchObject({ status: 200, json: { coverageAccountId: c2.id } });
    expect(await prisma.auditLog.count({ where: { brokerId: b, action: "COVERAGE_ACCOUNT_SET" } })).toBe(1);
  });
});

describe("121: admin partial close respects lot step and minimum", () => {
  it("refuses an off-step amount and a remainder under the minimum; a full close always works", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b);
    const s = await symbol(b, { minLot: "0.10", lotStep: "0.10" });
    const acc = await account(b, g.id);
    const p = await openPosition(b, acc.id, s.id, "1.0");
    as(await admin(b, "BROKER_ADMIN"));
    const { POST } = await import("@/app/api/manage/positions/[id]/close/route");
    expect((await call(POST, "/x", "POST", { volume: "0.15" }, { id: p.id })).status).toBe(400);
    expect((await call(POST, "/x", "POST", { volume: "0.95" }, { id: p.id })).status).toBe(400);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p.id } })).status).toBe("OPEN");
    const full = await call(POST, "/x", "POST", { volume: "1.0" }, { id: p.id });
    expect([200, 202]).toContain(full.status);
  });
});

describe("94 / 137: leverage and group choices on account creation", () => {
  it("94: a manager's custom leverage is refused out loud; the group's own value is fine", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const g = await group(b, { isDefault: true, leverage: 100 });
    as(await admin(b, "MANAGER"));
    const { POST } = await import("@/app/api/manage/accounts/route");
    const base = { fullName: "New Client", email: `n-${randomUUID().slice(0, 6)}@t.local`, password: "Passw0rd!x", accountMode: "DEMO", groupId: g.id };
    const refused = await call(POST, "/x", "POST", { ...base, leverage: 500 });
    expect(refused).toMatchObject({ status: 403, json: { code: "LEVERAGE_NEEDS_FINANCE" } });
    const fine = await call(POST, "/x", "POST", { ...base, email: `m-${randomUUID().slice(0, 6)}@t.local`, leverage: 100 });
    expect(fine.status).toBe(201);
  });

  it("137: the approver picks group / type / leverage; a hidden group or an unpermitted leverage changes nothing", async () => {
    if (!dbReachable) return;
    const b = await broker();
    await group(b, { isDefault: true, leverage: 100 });
    const pro = await group(b, { leverage: 200, name: "Pro" });
    const hidden = await group(b, { isClientSelectable: false, name: "Reverse" });
    const raw = await prisma.accountType.create({ data: { brokerId: b, name: "Raw", enabled: true } });
    const c = await prisma.client.create({ data: { brokerId: b, email: `l8-${randomUUID().slice(0, 8)}@t.local`, passwordHash: "x", fullName: "L8" } });
    clients.push(c.id);
    const req = await prisma.liveAccountRequest.create({ data: { brokerId: b, clientId: c.id } });
    const { PATCH } = await import("@/app/api/manage/live-account-requests/[id]/route");
    as(await admin(b, "MANAGER", ["KYC_REVIEW"]));
    expect((await call(PATCH, "/x", "PATCH", { action: "APPROVE", groupId: hidden.id }, { id: req.id })).status).toBe(400);
    const lev = await call(PATCH, "/x", "PATCH", { action: "APPROVE", groupId: pro.id, leverage: 1000 }, { id: req.id });
    expect(lev).toMatchObject({ status: 403, json: { code: "LEVERAGE_NEEDS_FINANCE" } });
    // the claim was released: the request is still reviewable and no account exists
    expect(await prisma.liveAccountRequest.findUniqueOrThrow({ where: { id: req.id } })).toMatchObject({ status: "PENDING", reviewedAt: null });
    expect(await prisma.account.count({ where: { clientId: c.id } })).toBe(0);
    const ok = await call(PATCH, "/x", "PATCH", { action: "APPROVE", groupId: pro.id, accountTypeId: raw.id }, { id: req.id });
    expect(ok.status).toBe(200);
    const acc = await prisma.account.findFirstOrThrow({ where: { clientId: c.id } });
    expect(acc).toMatchObject({ groupId: pro.id, leverage: 200, accountTypeId: null, accountMode: "LIVE" }); // D4: an approver-sent type is ignored
  });
});

describe("202 / 188 / 75", () => {
  it("202: the internal secret no longer reads another tenant's positions", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const acc = await account(b, (await group(b)).id);
    vi.mocked(getAdminSession).mockResolvedValue(null as never);
    const { GET } = await import("@/app/api/manage/accounts/[id]/positions/route");
    const res = await call(GET, "/x", "GET", undefined, { id: acc.accountNumber }, { "x-internal-secret": process.env.INTERNAL_SERVICE_SECRET || "any-internal-secret" });
    expect(res.status).toBe(403);
    // a staff session of ANOTHER broker gets nothing either
    as(await admin(await broker(), "BROKER_ADMIN"));
    expect((await call(GET, "/x", "GET", undefined, { id: acc.accountNumber })).status).toBe(404);
  });

  it("188: stop level is saved, validated, and kept when a client does not send it", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const s = await symbol(b);
    as(await admin(b, "BROKER_ADMIN"));
    const { PATCH, GET } = await import("@/app/api/manage/symbols/route");
    const cfg = { symbolId: s.id, spreadMarkup: "0", minLot: "0.01", maxLot: "100", lotStep: "0.01", swapLong: "0", swapShort: "0", enabled: true, commissionPerLot: "0", maxExposure: null, tradingMode: "BOTH" };
    expect((await call(PATCH, "/x", "PATCH", { ...cfg, stopLevel: -1 })).status).toBe(400);
    expect((await call(PATCH, "/x", "PATCH", { ...cfg, stopLevel: "2.5" })).status).toBe(400);
    expect((await call(PATCH, "/x", "PATCH", { ...cfg, stopLevel: 30 })).json.stopLevel).toBe(30);
    expect((await call(PATCH, "/x", "PATCH", cfg)).json.stopLevel).toBe(30);
    const row = ((await call(GET, "/x")).json as { symbolId: string; stopLevel: number }[]).find((r) => r.symbolId === s.id);
    expect(row?.stopLevel).toBe(30);
  });

  it("75 + D4: nobody can set a type's pricing any more (400), a manager can still rename it", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const t = await prisma.accountType.create({ data: { brokerId: b, name: "Std", isDefault: true, enabled: true } });
    const { PATCH } = await import("@/app/api/manage/account-types/[id]/route");
    as(await admin(b, "MANAGER"));
    const refused = await call(PATCH, "/x", "PATCH", { name: "Std", isDefault: true, spreadMarkup: "5" }, { id: t.id });
    expect(refused.status).toBe(400); // D4: account types no longer carry pricing
    expect((await prisma.accountType.findUniqueOrThrow({ where: { id: t.id } })).spreadMarkup).toBeNull();
    expect((await call(PATCH, "/x", "PATCH", { name: "Standard", isDefault: true }, { id: t.id })).status).toBe(200);
    as(await admin(b, "MANAGER", ["PRICING"]));
    expect((await call(PATCH, "/x", "PATCH", { name: "Standard", isDefault: true, spreadMarkup: "5" }, { id: t.id })).status).toBe(400); // even with PRICING
  });
});
