import "dotenv/config";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 2 (owner 2026-10-07): session timeout, audit log retention (min 365 days), auto-approve withdrawals up
// to X (default off; client requests keep the KYC rule), hedging allowed (every open path).
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockResolvedValue({ usedMock: true }) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession, sessionExpired } from "@/lib/auth";
import { parseNewSettings } from "@/lib/broker-settings";
import { purgeExpiredAuditLogs } from "@/lib/audit-retention";
import { checkHedgingAllowed } from "@/lib/hedging";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-settings.test.ts: DB unreachable, skipping"); }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world(data: Partial<Prisma.BrokerUncheckedCreateInput> = {}, kyc = true) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `S3b Set ${sfx}`, subdomain: `s3bs-${sfx}`, withdrawalApproval: "SINGLE", ...data } });
  brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `S3S-${sfx}`, leverage: 100 } });
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  const acc = await prisma.account.create({
    data: {
      groupId: g.id, brokerId: b.id, accountNumber: n, email: `s3s-${n}@test.local`, passwordHash: "x", fullName: `S3S ${n}`, accountMode: "LIVE", balance: D(1000), leverage: 100,
      ...(kyc ? { kycRecord: { create: { status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } } } : {}),
    },
  });
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `s3s-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const mgr = await prisma.adminUser.create({ data: { brokerId: b.id, email: `s3s-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "MANAGER" } });
  const pm = await prisma.paymentMethod.create({ data: { brokerId: b.id, type: "BANK_TRANSFER" } });
  return { brokerId: b.id, groupId: g.id, accountId: acc.id, adminId: admin.id, mgrId: mgr.id, pmId: pm.id };
}
type W = Awaited<ReturnType<typeof world>>;
const asAdmin = (w: W, role: "BROKER_ADMIN" | "MANAGER" = "BROKER_ADMIN") =>
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: role === "MANAGER" ? w.mgrId : w.adminId, role, brokerId: w.brokerId } as never);
async function call(handler: unknown, method: string, body?: unknown) {
  const req = new NextRequest("https://t.local/x", { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest) => Promise<Response>)(req);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

describe("parseNewSettings", () => {
  it("audit retention: never under 365 days, null keeps everything", () => {
    expect(parseNewSettings({ auditRetentionDays: 364 })).toMatchObject({ ok: false });
    expect(parseNewSettings({ auditRetentionDays: 365 })).toEqual({ ok: true, data: { auditRetentionDays: 365 } });
    expect(parseNewSettings({ auditRetentionDays: null })).toEqual({ ok: true, data: { auditRetentionDays: null } });
    expect(parseNewSettings({ auditRetentionDays: "abc" })).toMatchObject({ ok: false });
  });
  it("session timeout 5 minutes to 30 days, or off", () => {
    expect(parseNewSettings({ sessionTimeoutMinutes: 4 })).toMatchObject({ ok: false });
    expect(parseNewSettings({ sessionTimeoutMinutes: 43201 })).toMatchObject({ ok: false });
    expect(parseNewSettings({ sessionTimeoutMinutes: 30 })).toEqual({ ok: true, data: { sessionTimeoutMinutes: 30 } });
    expect(parseNewSettings({ sessionTimeoutMinutes: null })).toEqual({ ok: true, data: { sessionTimeoutMinutes: null } });
  });
  it("auto-approve: positive, 2 decimals, 0 or null = off", () => {
    expect(parseNewSettings({ autoApproveWithdrawalMax: "-5" })).toMatchObject({ ok: false });
    expect(parseNewSettings({ autoApproveWithdrawalMax: "1.234" })).toMatchObject({ ok: false });
    expect(parseNewSettings({ autoApproveWithdrawalMax: "nope" })).toMatchObject({ ok: false });
    const ok = parseNewSettings({ autoApproveWithdrawalMax: "500" });
    expect(ok.ok && ok.data.autoApproveWithdrawalMax?.toString()).toBe("500");
    expect(parseNewSettings({ autoApproveWithdrawalMax: 0 })).toEqual({ ok: true, data: { autoApproveWithdrawalMax: null } });
  });
  it("hedging must be a boolean; absent keys are left alone", () => {
    expect(parseNewSettings({ hedgingAllowed: "no" })).toMatchObject({ ok: false });
    expect(parseNewSettings({ hedgingAllowed: false })).toEqual({ ok: true, data: { hedgingAllowed: false } });
    expect(parseNewSettings({})).toEqual({ ok: true, data: {} });
  });
});

describe("session timeout (counted from sign-in)", () => {
  it("expires only past the limit; no limit or unknown sign-in time never expires", () => {
    const now = 10_000_000;
    expect(sessionExpired(now - 29 * 60_000, 30, now)).toBe(false);
    expect(sessionExpired(now - 31 * 60_000, 30, now)).toBe(true);
    expect(sessionExpired(now - 99 * 3_600_000, null, now)).toBe(false);
    expect(sessionExpired(undefined, 30, now)).toBe(false);
  });
});

describe("settings route", () => {
  it("BROKER_ADMIN saves the four settings, audited with old and new; GET returns them; a MANAGER is refused", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { GET, PATCH } = await import("@/app/api/manage/settings/route");
    asAdmin(w, "MANAGER");
    expect((await call(PATCH, "PATCH", { hedgingAllowed: false })).status).toBe(403);
    asAdmin(w);
    const bad = await call(PATCH, "PATCH", { auditRetentionDays: 100 });
    expect(bad.status).toBe(400);
    const r = await call(PATCH, "PATCH", { sessionTimeoutMinutes: 45, auditRetentionDays: 400, autoApproveWithdrawalMax: "250.50", hedgingAllowed: false });
    expect(r.status).toBe(200);
    const g = await call(GET, "GET");
    expect(g.json).toMatchObject({ sessionTimeoutMinutes: 45, auditRetentionDays: 400, autoApproveWithdrawalMax: "250.5", hedgingAllowed: false });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: w.brokerId, action: "BROKER_SETTINGS_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect((audit.oldValue as Record<string, unknown>).hedgingAllowed).toBe(true);
    expect((audit.newValue as Record<string, unknown>).hedgingAllowed).toBe(false);
    expect((audit.newValue as Record<string, unknown>).auditRetentionDays).toBe(400);
    // off again
    const off = await call(PATCH, "PATCH", { sessionTimeoutMinutes: null, autoApproveWithdrawalMax: null });
    expect(off.json).toMatchObject({ sessionTimeoutMinutes: null, autoApproveWithdrawalMax: null });
  });
});

describe("audit log retention", () => {
  it("deletes only this broker's rows older than its days, keeps newer rows and brokers with no setting, writes one purge row", async () => {
    if (!dbReachable) return;
    const a = await world({ auditRetentionDays: 400 });
    const b = await world({}); // no setting
    const old = new Date(Date.now() - 500 * 86_400_000), recent = new Date(Date.now() - 100 * 86_400_000);
    for (const w of [a, b]) {
      await prisma.auditLog.create({ data: { brokerId: w.brokerId, action: "X_OLD", entityType: "T", entityId: "1", createdAt: old } });
      await prisma.auditLog.create({ data: { brokerId: w.brokerId, action: "X_RECENT", entityType: "T", entityId: "1", createdAt: recent } });
    }
    await purgeExpiredAuditLogs(prisma);
    const left = async (w: W) => (await prisma.auditLog.findMany({ where: { brokerId: w.brokerId }, select: { action: true } })).map((r) => r.action).sort();
    expect(await left(a)).toEqual(["AUDIT_LOG_PURGED", "X_RECENT"]);
    expect(await left(b)).toEqual(["X_OLD", "X_RECENT"]);
    const p = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: a.brokerId, action: "AUDIT_LOG_PURGED" } });
    expect((p.newValue as { deleted: number }).deleted).toBe(1);
  });
  it("a bad row under 365 days never purges anything", async () => {
    if (!dbReachable) return;
    const w = await world({ auditRetentionDays: 30 });
    await prisma.auditLog.create({ data: { brokerId: w.brokerId, action: "X_OLD", entityType: "T", entityId: "1", createdAt: new Date(Date.now() - 100 * 86_400_000) } });
    await purgeExpiredAuditLogs(prisma);
    expect(await prisma.auditLog.count({ where: { brokerId: w.brokerId, action: "X_OLD" } })).toBe(1);
  });
});

describe("auto-approve withdrawals up to X", () => {
  const withdraw = async (w: W, amount: string) => {
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: w.accountId, brokerId: w.brokerId } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    return call(POST, "POST", { type: "WITHDRAWAL", amount, paymentMethodId: w.pmId, destinationAddress: "iban 123" });
  };
  const bal = async (w: W) => (await prisma.account.findUniqueOrThrow({ where: { id: w.accountId } })).balance.toFixed(2);

  it("default off: a client withdrawal waits for staff", async () => {
    if (!dbReachable) return;
    const w = await world();
    const r = await withdraw(w, "50");
    expect(r).toMatchObject({ status: 201, json: { status: "PENDING" } });
    expect(await bal(w)).toBe("1000.00");
  });
  it("at or under the limit completes at once with its own audit row; over the limit waits", async () => {
    if (!dbReachable) return;
    const w = await world({ autoApproveWithdrawalMax: D(200) });
    const exact = await withdraw(w, "200");
    expect(exact.json.status).toBe("COMPLETED");
    expect(await bal(w)).toBe("800.00");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: w.brokerId, action: "FUNDS_REQUEST_AUTO_APPROVED" } });
    expect(audit.actorAdminId).toBeNull();
    expect((audit.newValue as { approvalMode: string; autoApproveLimit: string }).approvalMode).toBe("AUTO");
    expect((audit.newValue as { autoApproveLimit: string }).autoApproveLimit).toBe("200");
    const over = await withdraw(w, "200.01");
    expect(over.json.status).toBe("PENDING");
    expect(await bal(w)).toBe("800.00");
  });
  it("a client without approved KYC is refused even under the limit (KYC not verified)", async () => {
    if (!dbReachable) return;
    const w = await world({ autoApproveWithdrawalMax: D(500) }, false);
    const r = await withdraw(w, "10");
    expect(r.status).toBe(403);
    expect(r.json.error).toBe("KYC not verified");
    expect(await bal(w)).toBe("1000.00");
  });
  it("a deposit is never auto-approved", async () => {
    if (!dbReachable) return;
    const w = await world({ autoApproveWithdrawalMax: D(500) });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: w.accountId, brokerId: w.brokerId } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const r = await call(POST, "POST", { type: "DEPOSIT", amount: "10", paymentMethodId: w.pmId });
    expect(r.json.status).toBe("PENDING");
  });
  it("staff recording a withdrawal ignores the limit and never blocks on KYC", async () => {
    if (!dbReachable) return;
    const w = await world({ autoApproveWithdrawalMax: D(5), withdrawalApproval: "DUAL" }, false);
    await prisma.adminUser.create({ data: { brokerId: w.brokerId, email: `s3s-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    asAdmin(w);
    const { POST } = await import("@/app/api/manage/accounts/[id]/funds/route");
    const req = new NextRequest("https://t.local/x", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "WITHDRAWAL", amount: "100", paymentMethodId: "MANUAL", note: "paid", idempotencyKey: randomUUID() }) });
    const res = await POST(req, { params: Promise.resolve({ id: w.accountId }) });
    expect(res.status).toBe(202);   // recorded Waiting for a second admin, no KYC refusal, not auto-approved
    expect((await res.json()).code).not.toBe("KYC_REQUIRED");
    expect(await bal(w)).toBe("1000.00");
  });
});

describe("hedging allowed", () => {
  async function pos(w: W, symbolId: string, side: "BUY" | "SELL", status: "OPEN" | "CLOSED" = "OPEN") {
    const o = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId, side, type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `s3h:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    return prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId, originOrderId: o.id, side, volume: D(1), openPrice: D(100), bookType: "B_BOOK", status, closePrice: status === "CLOSED" ? D(100) : null, closedAt: status === "CLOSED" ? new Date() : null } });
  }
  async function sym() {
    const s = await prisma.symbol.create({ data: { name: `HG${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
    symbols.push(s.name);
    return s.id;
  }
  it("off: the opposite side on the same symbol is refused; same side, another symbol and a closed opposite are fine", async () => {
    if (!dbReachable) return;
    const w = await world({ hedgingAllowed: false });
    const [s1, s2] = [await sym(), await sym()];
    await pos(w, s1, "BUY");
    await pos(w, s2, "SELL", "CLOSED");
    const broker = { hedgingAllowed: false };
    expect(await checkHedgingAllowed(prisma, broker, { accountId: w.accountId, symbolId: s1, side: "SELL" })).toMatch(/hedging is not allowed/);
    expect(await checkHedgingAllowed(prisma, broker, { accountId: w.accountId, symbolId: s1, side: "BUY" })).toBeNull();
    expect(await checkHedgingAllowed(prisma, broker, { accountId: w.accountId, symbolId: s2, side: "BUY" })).toBeNull();
    expect(await checkHedgingAllowed(prisma, broker, { accountId: w.accountId, symbolId: s2, side: "SELL" })).toBeNull();
  });
  it("on (default): never refuses", async () => {
    if (!dbReachable) return;
    const w = await world();
    const s1 = await sym(); await pos(w, s1, "BUY");
    expect(await checkHedgingAllowed(prisma, { hedgingAllowed: true }, { accountId: w.accountId, symbolId: s1, side: "SELL" })).toBeNull();
  });
  it("every open path calls the gate", () => {
    const files = [
      "app/api/trade/orders/route.ts", "app/api/trade/orders/[id]/requote-response/route.ts", "app/api/manage/dealing-queue/[id]/route.ts",
      "app/api/manage/dealing-desk-toggle/route.ts", "app/api/manage/positions/route.ts", "lib/pending-trigger.ts", "lib/mirror.ts",
    ];
    for (const f of files) expect(fs.readFileSync(f, "utf8"), f).toContain("checkHedgingAllowed(");
  });
});
