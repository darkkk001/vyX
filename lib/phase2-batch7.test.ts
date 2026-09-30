import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 7 (web side): the client portal profile (edit rules + KYC lock + audit), password change, lead audit
// rows, the funds-request live event, the audit list's date range + keyset paging, the deals open time and the
// coverage-account flag. Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/client-auth", () => ({ getClientSession: vi.fn(), revokeAllClientSessions: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 4 }) }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { getClientSession, revokeAllClientSessions } from "@/lib/client-auth";
import { publishTradingEvent } from "@/lib/nats";
import { resolveProfileUpdate, identityLocked, IDENTITY_LOCKED_MESSAGE } from "@/lib/client-profile";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch7.test.ts: DB unreachable, skipping");
  }
});
beforeEach(() => vi.mocked(publishTradingEvent).mockClear());
const brokers: string[] = [];
const clients: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.paymentMethod.deleteMany({ where }).catch(() => {});
  await prisma.lead.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.clientKycRecord.deleteMany({ where: { clientId: { in: clients } } }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: clients } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function broker() {
  const b = await prisma.broker.create({ data: { name: `P2B7 ${randomUUID().slice(0, 8)}`, subdomain: `p2b7-${randomUUID().slice(0, 8)}` } });
  brokers.push(b.id);
  return b.id;
}
async function admin(brokerId: string, role: "BROKER_ADMIN" | "MANAGER" = "BROKER_ADMIN") {
  const a = await prisma.adminUser.create({ data: { brokerId, email: `b7-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role } });
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role, brokerId } as never);
  return a;
}
async function account(brokerId: string) {
  const g = await prisma.group.create({ data: { brokerId, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isDefault: true } });
  const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "7")}`;
  return prisma.account.create({ data: { groupId: g.id, brokerId, accountNumber: n, email: `b7-${n}@test.local`, passwordHash: "x", fullName: "B7", accountMode: "LIVE", balance: D(1000), leverage: 100 } });
}
async function portalClient(brokerId: string, kyc: "PENDING" | "APPROVED" | "REJECTED" | null, password = "old-password-1") {
  const c = await prisma.client.create({
    data: { brokerId, email: `c7-${randomUUID().slice(0, 8)}@test.local`, passwordHash: await bcrypt.hash(password, 4), fullName: "Before Name", country: "PK", phone: "+92 300 0000000", dateOfBirth: new Date("1990-05-17T00:00:00Z") },
  });
  clients.push(c.id);
  if (kyc) await prisma.clientKycRecord.create({ data: { clientId: c.id, status: kyc, documentType: "passport", documentFrontUrl: "x" } });
  vi.mocked(getClientSession).mockResolvedValue({ clientId: c.id, brokerId, sessionId: "s-current" } as never);
  return c;
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, headers: res.headers, json: await res.json() };
}

describe("profile rules (lib/client-profile.ts)", () => {
  const current = { fullName: "Ali Khan", phone: null, country: "PK", dateOfBirth: new Date("1990-05-17T00:00:00Z") };
  it("identity is locked while KYC is PENDING or APPROVED, open when not submitted or REJECTED", () => {
    expect([identityLocked("PENDING"), identityLocked("APPROVED"), identityLocked("REJECTED"), identityLocked(null)]).toEqual([true, true, false, false]);
  });
  it("a locked client can still change the phone, and may resend unchanged identity fields", () => {
    const r = resolveProfileUpdate({ fullName: "Ali  Khan ", country: "PK", dateOfBirth: "1990-05-17", phone: "+92 300 1234567" }, current, "APPROVED");
    expect(r).toEqual({ ok: true, data: { phone: "+92 300 1234567" }, changes: [{ field: "phone", from: null, to: "+92 300 1234567" }] });
  });
  it("a locked client changing name, country or date of birth gets 409 with the support message", () => {
    for (const body of [{ fullName: "Other" }, { country: "AE" }, { dateOfBirth: "1991-01-01" }, { dateOfBirth: "" }]) {
      expect(resolveProfileUpdate(body, current, "PENDING")).toEqual({ ok: false, status: 409, error: IDENTITY_LOCKED_MESSAGE });
    }
  });
  it("validation: bad dates, future dates, bad phone, empty name, empty body", () => {
    expect(resolveProfileUpdate({ dateOfBirth: "1990-02-30" }, current, null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveProfileUpdate({ dateOfBirth: "2999-01-01" }, current, null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveProfileUpdate({ dateOfBirth: "17/05/1990" }, current, null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveProfileUpdate({ phone: "call me" }, current, null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveProfileUpdate({ fullName: "   " }, current, null)).toMatchObject({ ok: false, status: 400 });
    expect(resolveProfileUpdate({}, current, null)).toMatchObject({ ok: false, status: 400, error: "no fields to update" });
    expect(resolveProfileUpdate({ status: "SUSPENDED" }, current, null)).toMatchObject({ ok: false, status: 400 });
  });
});

describe("PATCH /api/portal/me", () => {
  it("unlocked: applies whitelisted fields only, writes one audit row with old and new values", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const c = await portalClient(b, null);
    const { PATCH } = await import("@/app/api/portal/me/route");
    const res = await call(PATCH, "/api/portal/me", "PATCH", { fullName: "After Name", dateOfBirth: "1988-01-02", status: "SUSPENDED", emailVerifiedAt: new Date().toISOString(), brokerId: "x", passwordHash: "y", email: "evil@x.y" });
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({ fullName: "After Name", dateOfBirth: "1988-01-02", identityLocked: false, kycStatus: null });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect([after.fullName, after.status, after.email, after.passwordHash, after.emailVerifiedAt]).toEqual(["After Name", "ACTIVE", c.email, c.passwordHash, null]);
    const audits = await prisma.auditLog.findMany({ where: { entityType: "Client", entityId: c.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ action: "CLIENT_PROFILE_UPDATED", actorAdminId: null, brokerId: b, oldValue: { fullName: "Before Name", dateOfBirth: "1990-05-17" } });
    expect(audits[0].newValue).toMatchObject({ fullName: "After Name", dateOfBirth: "1988-01-02", changedBy: "client" });
  });
  it("locked after KYC submission: identity change refused (409, nothing written); phone change allowed and audited", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const c = await portalClient(b, "PENDING");
    const { PATCH } = await import("@/app/api/portal/me/route");
    const refused = await call(PATCH, "/api/portal/me", "PATCH", { fullName: "Sneaky Rename", phone: "+1 555 0100" });
    expect(refused.status).toBe(409);
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).phone).toBe("+92 300 0000000");
    expect(await prisma.auditLog.count({ where: { entityId: c.id } })).toBe(0);
    const ok = await call(PATCH, "/api/portal/me", "PATCH", { phone: "+1 555 0100" });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ phone: "+1 555 0100", fullName: "Before Name", identityLocked: true, kycStatus: "PENDING" });
    expect(await prisma.auditLog.count({ where: { entityId: c.id, action: "CLIENT_PROFILE_UPDATED" } })).toBe(1);
  });
  it("a no-op save writes no audit row", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const c = await portalClient(b, "APPROVED");
    const { PATCH } = await import("@/app/api/portal/me/route");
    const res = await call(PATCH, "/api/portal/me", "PATCH", { fullName: "Before Name", phone: "+92 300 0000000", country: "PK", dateOfBirth: "1990-05-17" });
    expect(res.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { entityId: c.id } })).toBe(0);
  });
});

describe("POST /api/portal/change-password", () => {
  it("wrong current password is a 400 (not 401), the same password is refused, a real change audits and signs out other sessions", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const c = await portalClient(b, null, "old-password-1");
    const { POST } = await import("@/app/api/portal/change-password/route");
    expect((await call(POST, "/x", "POST", { currentPassword: "wrong", newPassword: "new-password-2" })).status).toBe(400);
    expect((await call(POST, "/x", "POST", { currentPassword: "old-password-1", newPassword: "old-password-1" })).json.error).toMatch(/different/);
    expect((await call(POST, "/x", "POST", { currentPassword: "old-password-1", newPassword: "short" })).status).toBe(400);
    expect((await call(POST, "/x", "POST", { currentPassword: "old-password-1", newPassword: "x".repeat(73) })).status).toBe(400);
    vi.mocked(revokeAllClientSessions).mockClear();
    const ok = await call(POST, "/x", "POST", { currentPassword: "old-password-1", newPassword: "new-password-2" });
    expect(ok).toMatchObject({ status: 200, json: { ok: true } });
    const after = await prisma.client.findUniqueOrThrow({ where: { id: c.id } });
    expect(await bcrypt.compare("new-password-2", after.passwordHash)).toBe(true);
    expect(revokeAllClientSessions).toHaveBeenCalledWith(c.id, "s-current");
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { entityId: c.id, action: "CLIENT_PASSWORD_CHANGED" } });
    expect(JSON.stringify(audit)).not.toMatch(/new-password-2|old-password-1|\$2[aby]\$/);
  });
});

describe("leads audit (286)", () => {
  it("create, update and convert each write an audit row with the actor", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const a = await admin(b, "MANAGER");
    const acc = await account(b);
    const { POST } = await import("@/app/api/manage/leads/route");
    const created = await call(POST, "/api/manage/leads", "POST", { fullName: "Lead One", email: "lead1@t.local", source: "web" });
    expect(created.status).toBe(201);
    const { PATCH } = await import("@/app/api/manage/leads/[id]/route");
    expect((await call(PATCH, "/x", "PATCH", { status: "CONTACTED", notes: "called once" }, { id: created.json.id })).status).toBe(200);
    expect((await call(PATCH, "/x", "PATCH", { notes: "n".repeat(2001) }, { id: created.json.id })).status).toBe(400);
    expect((await call(PATCH, "/x", "PATCH", { status: "CONVERTED", convertedAccountId: acc.id }, { id: created.json.id })).status).toBe(200);
    const rows = await prisma.auditLog.findMany({ where: { entityType: "Lead", entityId: created.json.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => r.action)).toEqual(["LEAD_CREATED", "LEAD_UPDATED", "LEAD_CONVERTED"]);
    expect(rows.every((r) => r.actorAdminId === a.id)).toBe(true);
    expect(rows[1]).toMatchObject({ oldValue: { status: "NEW", notes: null }, newValue: { status: "CONTACTED", notes: "called once" } });
    expect(rows[2]).toMatchObject({ newValue: { status: "CONVERTED", convertedAccountId: acc.id } });
  });
});

describe("funds request live event (298)", () => {
  it("filing and reviewing a request publish FundsRequestChanged (backoffice-only subject)", async () => {
    if (!dbReachable) return;
    const b = await broker();
    await admin(b, "BROKER_ADMIN");
    const acc = await account(b);
    const pm = await prisma.paymentMethod.create({ data: { brokerId: b, type: "BANK_TRANSFER" } });
    vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b } as never);
    const { POST } = await import("@/app/api/trade/funds-requests/route");
    const filed = await call(POST, "/api/trade/funds-requests", "POST", { type: "DEPOSIT", amount: "50", paymentMethodId: pm.id });
    expect(filed.status).toBe(201);
    expect(publishTradingEvent).toHaveBeenCalledWith("FundsRequestChanged", { broker_id: b, account_id: acc.id, transaction_id: filed.json.id, change: "created" });
    const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
    const rejected = await call(PATCH, "/x", "PATCH", { action: "REJECT", note: "no receipt" }, { id: filed.json.id });
    expect(rejected.status).toBe(200);
    expect(publishTradingEvent).toHaveBeenCalledWith("FundsRequestChanged", expect.objectContaining({ transaction_id: filed.json.id, change: "rejected" }));
  });
  it("the subject is dealing.funds_request: the admin stream subscribes dealing.>, the trader stream does not", async () => {
    const { readFileSync } = await import("node:fs");
    const nats = readFileSync("lib/nats.ts", "utf8");
    expect(nats).toMatch(/FundsRequestChanged: "dealing\.funds_request"/);
    const ws = readFileSync("services/api-gateway/src/ws.ts", "utf8");
    const traderSubs = ws.slice(ws.indexOf("attachTradingEventStream"), ws.indexOf("attachAdminEventStream")).match(/nc\.subscribe\("[^"]+"\)/g) ?? [];
    expect(traderSubs.join()).not.toContain("dealing.>");
    expect(ws.slice(ws.indexOf("export async function attachAdminEventStream"))).toContain('nc.subscribe("dealing.>")');
  });
});

describe("audit list date range + keyset paging (79)", () => {
  it("pages through rows that share a millisecond without skipping or repeating, and honours from / to", async () => {
    if (!dbReachable) return;
    const b = await broker();
    const a = await admin(b, "BROKER_ADMIN");
    const t = new Date("2026-03-10T12:00:00.000Z");
    const rows = Array.from({ length: 205 }, (_, i) => ({ brokerId: b, actorAdminId: a.id, action: "B7_TEST", entityType: "Account", entityId: `e${i}`, createdAt: i < 150 ? t : new Date(t.getTime() - (i - 149) * 1000) }));
    await prisma.auditLog.createMany({ data: rows });
    await prisma.auditLog.create({ data: { brokerId: b, actorAdminId: a.id, action: "B7_OLD", entityType: "Account", entityId: "old", createdAt: new Date("2026-01-01T00:00:00Z") } });
    const { GET } = await import("@/app/api/manage/audit/route");
    const p1 = await call(GET, "/api/manage/audit?from=2026-03-01&to=2026-03-10");
    expect(p1.status).toBe(200);
    expect(p1.json).toHaveLength(200);
    expect(p1.headers.get("x-truncated")).toBe("true");
    const last = p1.json[p1.json.length - 1];
    const p2 = await call(GET, `/api/manage/audit?from=2026-03-01&to=2026-03-10&before=${encodeURIComponent(last.createdAt)}&beforeId=${last.id}`);
    expect(p2.json).toHaveLength(5);
    expect(p2.headers.get("x-truncated")).toBe("false");
    const ids = [...p1.json, ...p2.json].map((r: { id: string }) => r.id);
    expect(new Set(ids).size).toBe(205);
    expect(ids).not.toContain("old");
    expect(p1.json[0]).toHaveProperty("createdAt");
  });
});

describe("deals open time (284) and the coverage flag (91)", () => {
  it("a closed deal carries openedAt; the accounts list marks the broker's coverage account", async () => {
    if (!dbReachable) return;
    const b = await broker();
    await admin(b, "BROKER_ADMIN");
    const acc = await account(b);
    const cov = await account(b);
    await prisma.broker.update({ where: { id: b }, data: { coverageAccountId: cov.id } });
    const name = `B7${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    symbols.push(name);
    const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    const o = await prisma.order.create({ data: { brokerId: b, accountId: acc.id, symbolId: s.id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `b7:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    await prisma.position.create({ data: { brokerId: b, accountId: acc.id, symbolId: s.id, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "CLOSED", closePrice: D(101), openedAt: new Date("2026-03-01T08:00:00Z"), closedAt: new Date("2026-03-01T09:00:00Z"), realizedPnl: D(1) } });
    const { GET: deals } = await import("@/app/api/manage/deals/route");
    const d = await call(deals, `/api/manage/deals?accountId=${acc.id}`);
    expect(d.json[0]).toMatchObject({ openedAt: "2026-03-01 08:00:00", closedAt: "2026-03-01 09:00:00" });
    const { GET: accounts } = await import("@/app/api/manage/accounts/route");
    const list = await call(accounts, "/api/manage/accounts");
    const flags = Object.fromEntries(list.json.map((r: { id: string; isCoverage: boolean }) => [r.id, r.isCoverage]));
    expect(flags).toEqual({ [acc.id]: false, [cov.id]: true });
  });
});

describe("follow-ups the backoffice needs (306, 93, 82, 74)", () => {
  async function openPosition(brokerId: string, accountId: string) {
    const name = `B7${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    symbols.push(name);
    const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    await prisma.brokerSymbol.create({ data: { brokerId, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), enabled: true } });
    const o = await prisma.order.create({ data: { brokerId, accountId, symbolId: s.id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `b7:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    return prisma.position.create({ data: { brokerId, accountId, symbolId: s.id, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "OPEN" } });
  }

  it("306: a MANAGER's reverse request carries the typed reason (trimmed, capped at 500)", async () => {
    if (!dbReachable) return;
    const b = await broker();
    // web5 (issues.md 71): a broker admin exists to approve it, else the request is refused at filing
    await prisma.adminUser.create({ data: { brokerId: b, email: `b7-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    await admin(b, "MANAGER");
    const acc = await account(b);
    const p = await openPosition(b, acc.id);
    const { POST } = await import("@/app/api/manage/positions/[id]/reverse/route");
    const res = await call(POST, "/x", "POST", { reason: `  client asked by phone ${"x".repeat(600)}` }, { id: p.id });
    expect(res.status).toBe(202);
    const req = await prisma.positionActionRequest.findUniqueOrThrow({ where: { id: res.json.requestId } });
    expect(req.reason?.startsWith("client asked by phone")).toBe(true);
    expect(req.reason).toHaveLength(500);
    await prisma.positionActionRequest.deleteMany({ where: { brokerId: b } });
  });

  it("93: positions?accountId= returns only that account's open positions", async () => {
    if (!dbReachable) return;
    const b = await broker();
    await admin(b, "BROKER_ADMIN");
    const a1 = await account(b);
    const a2 = await account(b);
    const p1 = await openPosition(b, a1.id);
    const p2 = await openPosition(b, a2.id);
    const { GET } = await import("@/app/api/manage/positions/route");
    const all = await call(GET, "/api/manage/positions");
    const one = await call(GET, `/api/manage/positions?accountId=${a1.id}`);
    const ids = (r: { json: unknown }) => {
      const j = r.json as { rows: { id: string }[] };
      return j.rows.map((x) => x.id).sort();
    };
    expect(ids(all)).toEqual([p1.id, p2.id].sort());
    expect(ids(one)).toEqual([p1.id]);
  });

  it("82: settings report negative balance protection; 74: account types report the pricing engine in a header", async () => {
    if (!dbReachable) return;
    const b = await broker();
    await admin(b, "BROKER_ADMIN");
    await prisma.broker.update({ where: { id: b }, data: { negativeBalanceProtection: false, pricingEngineEnabled: true } });
    const { GET: settings } = await import("@/app/api/manage/settings/route");
    expect((await call(settings, "/api/manage/settings")).json.negativeBalanceProtection).toBe(false);
    const { GET: types } = await import("@/app/api/manage/account-types/route");
    const t = await call(types, "/api/manage/account-types");
    expect(t.status).toBe(200);
    expect(t.headers.get("x-pricing-engine-enabled")).toBe("true");
    expect(Array.isArray(t.json)).toBe(true);
  });
});
