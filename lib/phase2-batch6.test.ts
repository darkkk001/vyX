import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Phase 2 batch 6 (item 10, web routes): audit completeness, the IB report permission, staff-only notifications, the
// pending-first KYC / live-account queues, the address-proof document, the approve-then-e-mail failure, the deals cap
// headers, the journal date, chart-settings validation, group-filtered symbols / watchlist, the last-watchlist-symbol
// guard and Super Admin's shadow comparison. Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h }));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockRejectedValue(new Error("resend 500")) }));
vi.mock("@/lib/live-account-credentials", () => ({ stashRevealedCredentials: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { validateChartSettings, DEFAULT_CHART_SETTINGS } from "@/lib/chart-settings";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("phase2-batch6.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
const clients: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.liveAccountRequest.deleteMany({ where }).catch(() => {});
  await prisma.clientKycRecord.deleteMany({ where: { clientId: { in: clients } } }).catch(() => {});
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.watchlistItem.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.positionActionRequest.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.updateMany({ where, data: { coveragePositionId: null } }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.client.deleteMany({ where: { id: { in: clients } } }).catch(() => {});
  await prisma.tradingSession.deleteMany({ where: { brokerSymbol: where } }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.groupSymbol.deleteMany({ where: { group: where } }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world(opts: { symbolCount?: number; restrict?: boolean } = {}) {
  const b = await prisma.broker.create({ data: { name: `P2B6 ${randomUUID().slice(0, 8)}`, subdomain: `p2b6-${randomUUID().slice(0, 8)}` } });
  brokers.push(b.id);
  const syms: { id: string; name: string; brokerSymbolId: string }[] = [];
  for (let i = 0; i < (opts.symbolCount ?? 1); i++) {
    const name = `B6${randomUUID().replace(/-/g, "").slice(0, 8).toUpperCase()}`;
    const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
    symbols.push(name);
    const bs = await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), enabled: true } });
    await prisma.livePrice.create({ data: { symbol: name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
    syms.push({ id: s.id, name, brokerSymbolId: bs.id });
  }
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${randomUUID().slice(0, 6)}`, leverage: 100, category: "B_BOOK", isDefault: true, restrictSymbols: opts.restrict ?? false } });
  const n = `6${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `b6-${n}@test.local`, passwordHash: "x", fullName: "B6", accountMode: "LIVE", balance: D(100000), leverage: 100 } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  return { brokerId: b.id, groupId: g.id, syms, accountId: acc.id, accountNumber: n };
}
type W = Awaited<ReturnType<typeof world>>;
async function adminAs(w: W, role: "BROKER_ADMIN" | "MANAGER", perms: string[] = []) {
  const a = await prisma.adminUser.create({ data: { brokerId: w.brokerId, email: `b6-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role, extraPermissions: perms as never } });
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role, brokerId: w.brokerId } as never);
  return a;
}
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, headers: res.headers, json: await res.json() };
}
async function closedPositions(w: W, count: number) {
  const now = Date.now();
  const orders = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(), brokerId: w.brokerId, accountId: w.accountId, symbolId: w.syms[0].id, side: "BUY" as const, type: "MARKET" as const,
    volume: D(1), requestedPrice: D(100), idempotencyKey: `b6:${randomUUID()}`, status: "FILLED" as const, filledPrice: D(100), filledAt: new Date(now - i * 1000),
  }));
  await prisma.order.createMany({ data: orders });
  await prisma.position.createMany({
    data: orders.map((o, i) => ({ brokerId: w.brokerId, accountId: w.accountId, symbolId: w.syms[0].id, originOrderId: o.id, side: "BUY" as const, volume: D(1), openPrice: D(100), status: "CLOSED" as const, closePrice: D(101), closedAt: new Date(now - i * 1000), realizedPnl: D(1) })),
  });
}

describe("audit (72, 76, 78, 104, 172)", () => {
  it("72: position action requests carry the position ticket", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await adminAs(w, "BROKER_ADMIN");
    await closedPositions(w, 1);
    const pos = await prisma.position.findFirstOrThrow({ where: { brokerId: w.brokerId } });
    await prisma.positionActionRequest.create({ data: { brokerId: w.brokerId, positionId: pos.id, actionType: "VOID", requestedByAdminId: a.id } });
    const { GET } = await import("@/app/api/manage/position-action-requests/route");
    const r = await call(GET, "/api/manage/position-action-requests");
    expect(r.status).toBe(200);
    expect(r.json[0].position.ticket).toBe(pos.ticket);
  });

  it("76 / 78: search matches actor e-mail, action and entity type; rows carry the raw action", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await adminAs(w, "BROKER_ADMIN");
    await prisma.auditLog.create({ data: { brokerId: w.brokerId, actorAdminId: a.id, action: "RISK_HALT_TOGGLED", entityType: "Broker", entityId: w.brokerId } });
    const { GET } = await import("@/app/api/manage/audit/route");
    for (const q of [a.email.toUpperCase(), "risk halt", "RISK_HALT", "broker"]) {
      const r = await call(GET, `/api/manage/audit?q=${encodeURIComponent(q)}`);
      expect(r.status, q).toBe(200);
      const rows = (Array.isArray(r.json) ? r.json : r.json.logs ?? r.json.rows) as { action: string }[];
      expect(rows.map((x) => x.action), q).toContain("RISK_HALT_TOGGLED");
    }
    const none = await call(GET, `/api/manage/audit?q=nothing-matches-${randomUUID().slice(0, 6)}`);
    expect((Array.isArray(none.json) ? none.json : none.json.logs ?? none.json.rows).length).toBe(0);
  });

  it("104: the desk-off flush audit names the admin who turned the desk off", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await adminAs(w, "BROKER_ADMIN");
    await prisma.broker.update({ where: { id: w.brokerId }, data: { dealingDeskAutoFillAt: null } });
    await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.syms[0].id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `b6:${randomUUID()}`, status: "PENDING" } });
    const { PATCH } = await import("@/app/api/manage/dealing-desk-toggle/route");
    const r = await call(PATCH, "/api/manage/dealing-desk-toggle", "PATCH", { dealerOn: false });
    expect(r.status).toBe(200);
    expect(r.json.flushed.map((f: { status: string }) => f.status)).toEqual(["filled"]);
    const flush = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: w.brokerId, action: { startsWith: "DEALING_DESK_AUTO_FLUSHED" } } });
    expect(flush.actorAdminId).toBe(a.id);
  });

  it("172: a trading-hours edit writes an audit row with the old and new windows", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await adminAs(w, "BROKER_ADMIN");
    const bs = w.syms[0].brokerSymbolId;
    await prisma.tradingSession.create({ data: { brokerSymbolId: bs, dayOfWeek: 1, openTime: "00:00", closeTime: "23:59" } });
    const { PUT } = await import("@/app/api/manage/symbols/[id]/sessions/route");
    const r = await call(PUT, `/api/manage/symbols/${bs}/sessions`, "PUT", { sessions: [{ dayOfWeek: 2, openTime: "08:00", closeTime: "17:00" }] }, { id: bs });
    expect(r.status).toBe(200);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: w.brokerId, action: "SYMBOL_SESSIONS_UPDATED" } });
    expect(row.actorAdminId).toBe(a.id);
    expect(row.entityId).toBe(bs);
    expect(row.oldValue).toMatchObject({ sessions: ["1 00:00-23:59"] });
    expect(row.newValue).toMatchObject({ sessions: ["2 08:00-17:00"] });
  });
});

describe("permissions (131 / 158)", () => {
  it("the IB report needs IB_PAYOUTS: MANAGER without it 403, with it 200, BROKER_ADMIN 200", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { GET } = await import("@/app/api/manage/reports/ib/route");
    const run = () => (GET as unknown as () => Promise<Response>)().then((r) => r.status);
    await adminAs(w, "MANAGER");
    expect(await run()).toBe(403);
    await adminAs(w, "MANAGER", ["IB_PAYOUTS"]);
    expect(await run()).toBe(200);
    await adminAs(w, "BROKER_ADMIN");
    expect(await run()).toBe(200);
  });
});

describe("staff notifications (145 / 146)", () => {
  it("the inbox, badge and mark-all-read see staff rows only; a trader copy is not staff's to mark", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await adminAs(w, "BROKER_ADMIN");
    await prisma.adminUser.update({ where: { id: a.id }, data: { twoFactorEnabled: true } }); // shell-info counts only past the 2FA gate
    const base = { brokerId: w.brokerId, type: "MARGIN_CALL", title: "Margin call", body: "b", entityType: "Account", entityId: w.accountId };
    const staff = await prisma.notification.create({ data: base });
    const trader = await prisma.notification.create({ data: { ...base, accountId: w.accountId } });
    await prisma.notification.create({ data: { ...base, type: "PRICE_ALERT_TRIGGERED", accountId: w.accountId } });
    const list = await import("@/app/api/manage/notifications/route");
    const r = await call(list.GET, "/api/manage/notifications");
    expect(r.json.map((n: { id: string }) => n.id)).toEqual([staff.id]);
    const shell = await import("@/app/api/manage/shell-info/route");
    expect((await call(shell.GET, "/api/manage/shell-info")).json.unreadNotifications).toBe(1);
    const one = await import("@/app/api/manage/notifications/[id]/route");
    expect((await call(one.PATCH, `/api/manage/notifications/${trader.id}`, "PATCH", {}, { id: trader.id })).status).toBe(404);
    expect((await call(list.PATCH, "/api/manage/notifications", "PATCH", { markAllRead: true })).status).toBe(200);
    // web3 (issues.md 324): marked read for THIS staff member (own NotificationRead row), never the shared readAt
    expect(await prisma.notificationRead.count({ where: { notificationId: staff.id, adminId: a.id } })).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: staff.id } })).readAt).toBeNull();
    expect(await prisma.notification.count({ where: { brokerId: w.brokerId, accountId: w.accountId, readAt: null } })).toBe(2);
  });
});

describe("queues list every pending row (135 / 138) and the address proof (134)", () => {
  it("an old PENDING record behind 200 newer reviewed ones is still listed, first", async () => {
    if (!dbReachable) return;
    const w = await world();
    await adminAs(w, "BROKER_ADMIN");
    const old = new Date(Date.now() - 86400_000 * 30);
    const pending = await prisma.kycRecord.create({ data: { accountId: w.accountId, documentType: "PASSPORT", documentFrontUrl: "x", status: "PENDING", createdAt: old, addressProofUrl: "y" } });
    // one KycRecord per account: 201 more accounts, each with a reviewed record newer than the pending one
    const extra = Array.from({ length: 201 }, () => ({ id: randomUUID(), groupId: w.groupId, brokerId: w.brokerId, accountNumber: `5${randomUUID().replace(/\D/g, "").slice(0, 8).padEnd(8, "5")}`, email: `b6k-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "K", accountMode: "LIVE" as const, balance: D(0), leverage: 100 }));
    await prisma.account.createMany({ data: extra });
    await prisma.kycRecord.createMany({ data: extra.map((a) => ({ accountId: a.id, documentType: "PASSPORT", documentFrontUrl: "x", status: "APPROVED" as const })) });
    const kyc = await import("@/app/api/manage/kyc-requests/route");
    const r = await call(kyc.GET, "/api/manage/kyc-requests");
    const rows = (Array.isArray(r.json) ? r.json : r.json.records) as { id: string; hasAddressProof: boolean }[];
    expect(rows[0].id).toBe(pending.id);
    expect(rows[0].hasAddressProof).toBe(true);
    expect(rows.length).toBe(201);

    const client = await prisma.client.create({ data: { brokerId: w.brokerId, email: `b6c-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "C" } });
    clients.push(client.id);
    const cPending = await prisma.clientKycRecord.create({ data: { clientId: client.id, documentType: "PASSPORT", documentFrontUrl: "x", status: "PENDING", createdAt: old } });
    // one ClientKycRecord per client: 201 more clients, each with a reviewed record
    const extraClients = Array.from({ length: 201 }, () => ({ id: randomUUID(), brokerId: w.brokerId, email: `b6x-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "X" }));
    await prisma.client.createMany({ data: extraClients });
    clients.push(...extraClients.map((c) => c.id));
    await prisma.clientKycRecord.createMany({ data: extraClients.map((c) => ({ clientId: c.id, documentType: "PASSPORT", documentFrontUrl: "x", status: "REJECTED" as const })) });
    const ckyc = await import("@/app/api/manage/client-kyc-requests/route");
    const cr = await call(ckyc.GET, "/api/manage/client-kyc-requests");
    const crows = (Array.isArray(cr.json) ? cr.json : cr.json.records) as { id: string }[];
    expect(crows[0].id).toBe(cPending.id);

    const larPending = await prisma.liveAccountRequest.create({ data: { brokerId: w.brokerId, clientId: client.id, status: "PENDING", createdAt: old } });
    await prisma.liveAccountRequest.createMany({ data: Array.from({ length: 201 }, () => ({ brokerId: w.brokerId, clientId: client.id, status: "REJECTED" as const })) });
    const lar = await import("@/app/api/manage/live-account-requests/route");
    const lr = await call(lar.GET, "/api/manage/live-account-requests");
    const lrows = (Array.isArray(lr.json) ? lr.json : lr.json.requests) as { id: string }[];
    expect(lrows[0].id).toBe(larPending.id);
    expect(lrows.length).toBe(201);

    const doc = await import("@/app/api/manage/kyc-requests/[id]/document/route");
    const prev = process.env.PRIVATE_READ_WRITE_TOKEN;
    delete process.env.PRIVATE_READ_WRITE_TOKEN;
    try {
      // side=address is accepted (was 400) and reaches the storage step
      const d = await call(doc.GET, `/api/manage/kyc-requests/${pending.id}/document?side=address`, "GET", undefined, { id: pending.id });
      expect(d.status).toBe(503);
      const none = await prisma.kycRecord.findFirstOrThrow({ where: { account: { brokerId: w.brokerId }, addressProofUrl: null } });
      expect((await call(doc.GET, `/api/manage/kyc-requests/${none.id}/document?side=address`, "GET", undefined, { id: none.id })).status).toBe(404);
      expect((await call(doc.GET, `/api/manage/kyc-requests/${none.id}/document?side=selfie`, "GET", undefined, { id: none.id })).status).toBe(400);
    } finally {
      if (prev !== undefined) process.env.PRIVATE_READ_WRITE_TOKEN = prev;
    }
  });

  it("136: approving still answers 200 (emailed: false) when the credentials e-mail throws", async () => {
    if (!dbReachable) return;
    const w = await world();
    await adminAs(w, "BROKER_ADMIN");
    const client = await prisma.client.create({ data: { brokerId: w.brokerId, email: `b6l-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", fullName: "L" } });
    clients.push(client.id);
    const req = await prisma.liveAccountRequest.create({ data: { brokerId: w.brokerId, clientId: client.id } });
    const { PATCH } = await import("@/app/api/manage/live-account-requests/[id]/route");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await call(PATCH, `/api/manage/live-account-requests/${req.id}`, "PATCH", { action: "APPROVE" }, { id: req.id });
    err.mockRestore();
    expect(r.status).toBe(200);
    expect(r.json.status).toBe("APPROVED");
    expect(r.json.emailed).toBe(false);
    expect(await prisma.account.count({ where: { clientId: client.id } })).toBe(1);
  });
});

describe("deals cap is visible (108 / 114)", () => {
  it("500 rows: not truncated; 501: truncated with the total", async () => {
    if (!dbReachable) return;
    const w = await world();
    await adminAs(w, "BROKER_ADMIN");
    const { GET } = await import("@/app/api/manage/deals/route");
    await closedPositions(w, 500);
    let r = await call(GET, "/api/manage/deals");
    expect(r.json).toHaveLength(500);
    expect(r.headers.get("x-truncated")).toBe("false");
    expect(r.headers.get("x-total-count")).toBeNull();
    await closedPositions(w, 1);
    r = await call(GET, "/api/manage/deals");
    expect(r.json).toHaveLength(500);
    expect(r.headers.get("x-truncated")).toBe("true");
    expect(r.headers.get("x-total-count")).toBe("501");
  }, 60000);
});

describe("trader routes (233, 254, 272, 234)", () => {
  it("233: journal rows carry the full instant", async () => {
    if (!dbReachable) return;
    const w = await world();
    const at = new Date("2026-09-20T13:14:15.000Z");
    await prisma.auditLog.create({ data: { brokerId: w.brokerId, action: "ORDER_FILLED", entityType: "Order", entityId: randomUUID(), createdAt: at, newValue: { accountNumber: w.accountNumber, symbol: "X", side: "BUY", volume: "1", status: "FILLED" } } });
    const { GET } = await import("@/app/api/trade/audit/route");
    const r = await call(GET, "/api/trade/audit");
    expect(r.json.length).toBeGreaterThan(0);
    expect(r.json[0].at).toBe(at.toISOString());
    expect(r.json[0].time).toBe("13:14:15");
  });

  it("254: only known keys stored, each type-checked, size capped", async () => {
    expect(validateChartSettings({ ...DEFAULT_CHART_SETTINGS, showAskLine: false, bogus: 1 })).toEqual({ ok: true, settings: { ...DEFAULT_CHART_SETTINGS, showAskLine: false } });
    expect(validateChartSettings({ showGrid: "yes" }).ok).toBe(false);
    expect(validateChartSettings({ theme: "blue" }).ok).toBe(false);
    expect(validateChartSettings({ timezone: "Asia/Karachi" }).ok).toBe(false);
    expect(validateChartSettings({ candleUpColor: "javascript:alert(1)" }).ok).toBe(false);
    expect(validateChartSettings({ candleUpColor: "#3CC98A" }).ok).toBe(true);
    expect(validateChartSettings([1]).ok).toBe(false);
    if (!dbReachable) return;
    const w = await world();
    const { PUT, GET } = await import("@/app/api/trade/chart-settings/route");
    const ok = await call(PUT, "/api/trade/chart-settings", "PUT", { showAskLine: false, soundError: true, junk: "x".repeat(100) });
    expect(ok.status).toBe(200);
    const stored = (await prisma.account.findUniqueOrThrow({ where: { id: w.accountId } })).chartSettings as Record<string, unknown>;
    expect(stored.showAskLine).toBe(false);
    expect(stored.soundError).toBe(true);
    expect(stored).not.toHaveProperty("junk");
    expect((await call(GET, "/api/trade/chart-settings")).json.settings.showAskLine).toBe(false);
    expect((await call(PUT, "/api/trade/chart-settings", "PUT", { showGrid: 1 })).status).toBe(400);
    expect((await call(PUT, "/api/trade/chart-settings", "PUT", "not json")).status).toBe(400);
    expect((await call(PUT, "/api/trade/chart-settings", "PUT", { junk: "x".repeat(9000) })).status).toBe(413);
  });

  it("272: a restricted group sees, seeds and adds only its allowed symbols", async () => {
    if (!dbReachable) return;
    const w = await world({ symbolCount: 3, restrict: true });
    await prisma.groupSymbol.create({ data: { groupId: w.groupId, symbolId: w.syms[1].id } });
    const sym = await import("@/app/api/trade/symbols/route");
    const r = await call(sym.GET, "/api/trade/symbols");
    expect(r.json.symbols.map((s: { id: string }) => s.id)).toEqual([w.syms[1].id]);
    const wl = await import("@/app/api/trade/watchlist/route");
    const seeded = await call(wl.GET, "/api/trade/watchlist");
    expect(seeded.json.symbols.map((s: { id: string }) => s.id)).toEqual([w.syms[1].id]);
    expect((await call(wl.POST, "/api/trade/watchlist", "POST", { symbolId: w.syms[0].id })).status).toBe(403);
    // unrestricted group: everything, as before
    await prisma.group.update({ where: { id: w.groupId }, data: { restrictSymbols: false } });
    expect((await call(sym.GET, "/api/trade/symbols")).json.symbols).toHaveLength(3);
    expect((await call(wl.POST, "/api/trade/watchlist", "POST", { symbolId: w.syms[0].id })).status).toBe(200);
  });

  it("272: a symbol the account still holds stays listed (tradable: false) so its position keeps its pricing", async () => {
    if (!dbReachable) return;
    const w = await world({ symbolCount: 3, restrict: true });
    await prisma.groupSymbol.create({ data: { groupId: w.groupId, symbolId: w.syms[1].id } });
    // an open position in syms[0], which the group does not allow (e.g. allowed list narrowed after the open)
    const order = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.syms[0].id, side: "BUY", type: "MARKET", volume: new Prisma.Decimal("0.1"), status: "FILLED", idempotencyKey: `b6-held-${Date.now()}` } });
    await prisma.position.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.syms[0].id, originOrderId: order.id, side: "BUY", volume: new Prisma.Decimal("0.1"), openPrice: new Prisma.Decimal("100") } });
    const sym = await import("@/app/api/trade/symbols/route");
    const rows = (await call(sym.GET, "/api/trade/symbols")).json.symbols as { id: string; tradable: boolean }[];
    expect(rows.map((s) => [s.id, s.tradable]).sort()).toEqual([[w.syms[0].id, false], [w.syms[1].id, true]].sort());
    // syms[2]: neither allowed nor held -> still hidden
    expect(rows.some((s) => s.id === w.syms[2].id)).toBe(false);
  });

  it("234: the last watchlist symbol cannot be removed; others can", async () => {
    if (!dbReachable) return;
    const w = await world({ symbolCount: 2 });
    await prisma.watchlistItem.createMany({ data: w.syms.map((s, i) => ({ accountId: w.accountId, symbolId: s.id, position: i })) });
    const { DELETE } = await import("@/app/api/trade/watchlist/[symbolId]/route");
    const first = await call(DELETE, `/api/trade/watchlist/${w.syms[0].id}`, "DELETE", undefined, { symbolId: w.syms[0].id });
    expect(first.status).toBe(200);
    const last = await call(DELETE, `/api/trade/watchlist/${w.syms[1].id}`, "DELETE", undefined, { symbolId: w.syms[1].id });
    expect(last.status).toBe(409);
    expect(last.json.error).toBe("LAST_WATCHLIST_SYMBOL");
    expect(await prisma.watchlistItem.count({ where: { accountId: w.accountId } })).toBe(1);
  });
});

describe("cleanup (209)", () => {
  it("Super Admin runs the shadow comparison for a named broker; a manager still gets its own", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { GET } = await import("@/app/api/manage/pricing-shadow-compare/route");
    const sub = (await prisma.broker.findUniqueOrThrow({ where: { id: w.brokerId } })).subdomain;
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "sa", role: "SUPER_ADMIN", brokerId: null } as never);
    expect((await call(GET, "/api/manage/pricing-shadow-compare")).status).toBe(400);
    expect((await call(GET, "/api/manage/pricing-shadow-compare?broker=no-such-broker-b6")).status).toBe(404);
    expect((await call(GET, `/api/manage/pricing-shadow-compare?broker=${sub}`)).status).toBe(200);
    expect((await call(GET, `/api/manage/pricing-shadow-compare?broker=${w.brokerId}`)).status).toBe(200);
    await adminAs(w, "MANAGER");
    expect((await call(GET, "/api/manage/pricing-shadow-compare")).status).toBe(200);
  });
});
