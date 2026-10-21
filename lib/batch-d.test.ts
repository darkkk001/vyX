import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Batch D (owner 2026-10-21), against the scratch database:
//   D-1  ticket search by prefix (GET /api/manage/search `tickets`) and the per-order execution capture (Order columns,
//        GET /api/manage/deals openExecution / closeExecution / execution);
//   D-2  DELETE = money reversed + invisible to the client; VOID = money reversed + visible as VOIDED; the summary's voided
//        and deletedTrades lines; pending requests server-side, one per trade; the delete record for BROKER_ADMIN only.
vi.mock("@/lib/account-auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/account-auth")>()),
  getAccountSession: vi.fn(),
}));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/nats")>();
  return { ...real, publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) };
});
vi.mock("@/lib/config-events", () => ({ withConfigEvent: (_scope: string, h: unknown) => h, publishConfigChanged: vi.fn() }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { publishTradingEvent } from "@/lib/nats";
import { closePositionInTx } from "@/lib/position-close";
import { chargeCommission } from "@/lib/group-pricing";
import { writeOpenDealInTx } from "@/lib/deals";
import { executeVoid } from "@/lib/position-actions";
import { summarizeAccount, type AccountSummary } from "@/lib/account-summary";
import { platformOf, clientIp, executionDetail } from "@/lib/order-execution";
import { rankTickets, ticketQuery, type TicketHit } from "@/lib/ticket-search";

const D = (v: string | number) => new Prisma.Decimal(v);
const H = 3_600_000;

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "hiddenForPositionId" FROM "Transaction" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("lib/batch-d.test.ts: DB unreachable or the Batch D migration is missing, skipping the database tests");
  }
});
afterAll(async () => {
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; managerId: string; managerEmail: string; accountId: string; accountNumber: string; groupId: string; symbolId: string; symbolName: string };

async function fixture(opts?: { balance?: number; credit?: number; dealing?: boolean }): Promise<Fx> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `BatchD ${suffix}`, subdomain: `bd-${suffix}`, dealingModeAt: null, dealingDeskAutoFillAt: null } });
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `bd-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const manager = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `bd-manager-${suffix}@test.local`, passwordHash: "x", role: "MANAGER" } });
  const symbol = await prisma.symbol.create({ data: { name: `BD${suffix.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbol.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol: symbol.name, bid: D("100.00"), ask: D("100.10"), tickAt: new Date() } });
  const group = await prisma.group.create({
    data: { brokerId: broker.id, name: `BDG-${suffix}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: opts?.dealing ? "DEALING" : "B_BOOK", dealingMode: "AUTO", isClientSelectable: true },
  });
  const account = await prisma.account.create({
    data: {
      groupId: group.id, brokerId: broker.id, accountNumber: `5${suffix.slice(0, 7)}`, email: `bd-client-${suffix}@test.local`, passwordHash: "x", fullName: "Batch D Client",
      accountMode: "LIVE", leverage: 100, balance: D(opts?.balance ?? 1000), credit: D(opts?.credit ?? 0),
    },
  });
  return { brokerId: broker.id, adminId: admin.id, managerId: manager.id, managerEmail: manager.email, accountId: account.id, accountNumber: account.accountNumber, groupId: group.id, symbolId: symbol.id, symbolName: symbol.name };
}

const asAdmin = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
const asManager = (fx: Fx) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.managerId, role: "MANAGER", brokerId: fx.brokerId } as never);
const asTrader = (fx: Fx) => vi.mocked(getAccountSession).mockResolvedValue({ accountId: fx.accountId, brokerId: fx.brokerId } as never);
async function call(handler: unknown, url: string, method = "GET", body?: unknown, params?: Record<string, string>, headers?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json", ...headers }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/// A trade through the real open / close paths: commission charged with its IN deal, the close through closePositionInTx
/// (TRADE_PNL + OUT deal; credit used and the write-off when the loss needs them), and optionally the daily swap the
/// rollover books (an account-level SWAP row, the position's share on Position.swap).
async function trade(fx: Fx, o: { open: string; close: string; volume?: string; commissionPerLot?: string; swap?: string; at?: Date }) {
  const at = o.at ?? new Date();
  const p = await prisma.$transaction(async (tx) => {
    const order = await tx.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(o.volume ?? "1"), requestedPrice: D(o.open), idempotencyKey: `bd:${randomUUID()}`, status: "FILLED", filledPrice: D(o.open), filledAt: at } });
    const pos = await tx.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, originOrderId: order.id, side: "BUY", volume: D(o.volume ?? "1"), openPrice: D(o.open), openedAt: at } });
    await chargeCommission(tx, { brokerId: fx.brokerId, accountId: fx.accountId, positionId: pos.id, commissionPerLot: D(o.commissionPerLot ?? "0"), volume: D(o.volume ?? "1") });
    await tx.transaction.updateMany({ where: { referenceType: "Position", referenceId: pos.id, type: "COMMISSION" }, data: { createdAt: at, updatedAt: at } });
    await writeOpenDealInTx(tx, { positionId: pos.id, reason: "CLIENT" });
    if (o.swap) {
      const acc = await tx.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true } });
      await tx.account.update({ where: { id: fx.accountId }, data: { balance: acc.balance.add(D(o.swap)) } });
      await tx.transaction.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, type: "SWAP", status: "COMPLETED", amount: D(o.swap), balanceBefore: acc.balance, balanceAfter: acc.balance.add(D(o.swap)), createdAt: at, updatedAt: at } });
      await tx.position.update({ where: { id: pos.id }, data: { swap: D(o.swap) } });
    }
    return pos;
  });
  const fresh = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
  const startedAt = new Date();
  await prisma.$transaction((tx) =>
    closePositionInTx(tx, {
      position: { id: fresh.id, accountId: fresh.accountId, brokerId: fresh.brokerId, side: fresh.side, openPrice: fresh.openPrice, volume: fresh.volume, symbol: { contractSize: D(1) } },
      closePrice: D(o.close), at, deal: { reason: "CLIENT" },
    })
  );
  await prisma.transaction.updateMany({ where: { referenceId: p.id, type: { in: ["CREDIT", "NEGATIVE_BALANCE_PROTECTION"] }, createdAt: { gte: startedAt } }, data: { createdAt: at, updatedAt: at } });
  return prisma.position.findUniqueOrThrow({ where: { id: p.id } });
}

const balance = async (fx: Fx) => prisma.account.findUniqueOrThrow({ where: { id: fx.accountId }, select: { balance: true, credit: true } });

async function deleteAsAdmin(fx: Fx, positionId: string, reason = "duplicate test entry") {
  asAdmin(fx);
  const { POST } = await import("@/app/api/manage/positions/[id]/delete/route");
  return call(POST, `/api/manage/positions/${positionId}/delete`, "POST", { reason }, { id: positionId });
}
async function voidAsAdmin(fx: Fx, positionId: string) {
  asAdmin(fx);
  const { POST } = await import("@/app/api/manage/positions/[id]/void/route");
  return call(POST, `/api/manage/positions/${positionId}/void`, "POST", {}, { id: positionId });
}

/// What the client sees, through the client routes.
async function clientView(fx: Fx) {
  asTrader(fx);
  const history = (await import("@/app/api/trade/history/route")).GET;
  const deals = (await import("@/app/api/trade/deals/route")).GET;
  const transactions = (await import("@/app/api/trade/transactions/route")).GET;
  const summary = (await import("@/app/api/trade/summary/route")).GET;
  const audit = (await import("@/app/api/trade/audit/route")).GET;
  const from = new Date(Date.now() - 200 * H).toISOString();
  return {
    history: (await call(history, "/api/trade/history")).json as { id: string; status: string }[],
    closes: (await call(history, "/api/trade/history?closes=1")).json as { id: string; status: string }[],
    deals: (await call(deals, "/api/trade/deals")).json as { positionTicket: number; status: string }[],
    transactions: (await call(transactions, "/api/trade/transactions")).json as { type: string; amount: string; note: string | null }[],
    summary: (await call(summary, `/api/trade/summary?from=${encodeURIComponent(from)}`)).json as AccountSummary,
    audit: (await call(audit, "/api/trade/audit")).json as { action?: string; type?: string }[],
  };
}

function identity(s: AccountSummary) {
  const n = (x: string) => D(x);
  const f = s.funds, t = s.trades, v = s.voided;
  return n(s.openingBalance).add(n(f.deposits)).sub(n(f.withdrawals)).add(n(f.creditUsed)).add(n(f.adjustments)).add(n(f.transfersIn)).sub(n(f.transfersOut))
    .add(n(f.nbp)).add(n(f.ibCommission)).add(n(t.grossPnl)).sub(n(t.commission)).sub(n(t.swap))
    .add(n(v.grossPnl)).sub(n(v.commission)).add(n(v.reversal)).add(n(f.deletedTrades));
}

// ------------------------------------------------------------------------------------------------ D-1 pure
describe("D-1 pure: ticket query, ranking, platform, IP, execution detail", () => {
  it("digits with or without #; letters, spaces inside and a single digit are not a ticket", () => {
    expect(ticketQuery("100003")).toBe("100003");
    expect(ticketQuery("#1000038")).toBe("1000038");
    expect(ticketQuery(" #12 ")).toBe("12");
    expect(ticketQuery("1")).toBeNull();
    expect(ticketQuery("12a")).toBeNull();
    expect(ticketQuery("EURUSD")).toBeNull();
  });
  it("exact first, then position / order / deal, then the newest ticket", () => {
    const h = (type: TicketHit["type"], ticket: number, exact: boolean) => ({ type, id: `${type}${ticket}`, ticket, exact }) as TicketHit;
    const ranked = rankTickets([h("deal", 1000039, false), h("order", 1000038, true), h("position", 1000031, false), h("position", 1000038, true), h("deal", 1000038, true)]);
    expect(ranked.map((r) => r.id)).toEqual(["position1000038", "order1000038", "deal1000038", "position1000031", "deal1000039"]);
  });
  it("platform from the native build id, the mobile and API headers; WebTrader otherwise; IP only from the trusted headers", () => {
    const hdr = (o: Record<string, string>) => ({ get: (k: string) => o[k.toLowerCase()] ?? null });
    expect(platformOf(hdr({ "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "futurixglobal-terminal-1.0.93-70ac7d4cc6e1" }))).toBe("Windows terminal 1.0.93");
    expect(platformOf(hdr({ "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "qoretrader-backoffice-1.0.89-5f11724026c6" }))).toBe("Windows backoffice 1.0.89");
    expect(platformOf(hdr({ "x-client-platform": "DESKTOP_NATIVE" }))).toBe("Windows terminal");
    expect(platformOf(hdr({ "x-client-platform": "MOBILE", "user-agent": "Dart/3.5 (dart:io)" }))).toBe("Mobile");
    expect(platformOf(hdr({ "x-client-platform": "MOBILE", "x-client-version": "1.2.0" }))).toBe("Mobile 1.2.0");
    expect(platformOf(hdr({ "x-client-platform": "API", "user-agent": "python-requests/2.31 extra" }))).toBe("API (python-requests/2.31)");
    expect(platformOf(hdr({ "user-agent": "Mozilla/5.0" }))).toBe("WebTrader");
    expect(clientIp(hdr({ "x-real-ip": "203.0.113.7", "x-forwarded-for": "6.6.6.6" }))).toBe("203.0.113.7");
    expect(clientIp(hdr({ "x-forwarded-for": "6.6.6.6" }))).toBeNull();   // client-controlled: never trusted
  });
  it("execution detail leaves out what the server does not have (an order from before the capture)", () => {
    const old = executionDetail({ ticket: 5, type: "MARKET", source: "WEB", status: "FILLED", requestedAt: null, executedAt: null, clientIp: null, platform: null, routing: null, executionMode: null, requestedPrice: null, filledPrice: D("1.23456"), rejectionReason: null }, 5);
    expect(old).toEqual({ orderTicket: 5, orderType: "MARKET", status: "FILLED", source: "WEB", filledPrice: "1.23456" });
  });
});

// ------------------------------------------------------------------------------------------------ D-1 database
describe("D-1: ticket search and execution capture", () => {
  it("search: a ticket prefix lists positions, orders and deals of this broker, the exact ticket first; # accepted", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const other = await fixture();
    const p = await trade(fx, { open: "100", close: "101" });
    await trade(other, { open: "100", close: "101" });
    const { GET } = await import("@/app/api/manage/search/route");
    asManager(fx);
    const exact = await call(GET, `/api/manage/search?q=${encodeURIComponent(`#${p.ticket}`)}`);
    expect(exact.status).toBe(200);
    const hits = exact.json.tickets as TicketHit[];
    expect(hits[0]).toMatchObject({ type: "position", id: p.id, ticket: p.ticket, exact: true, accountNumber: fx.accountNumber, symbol: fx.symbolName, side: "BUY", status: "CLOSED", deleted: false });
    expect(hits.find((h) => h.type === "order")).toMatchObject({ ticket: p.ticket, exact: true, positionId: p.id, status: "FILLED" });
    const prefix = String(p.ticket).slice(0, -1);
    const byPrefix = (await call(GET, `/api/manage/search?q=${prefix}`)).json.tickets as TicketHit[];
    expect(byPrefix.some((h) => h.id === p.id)).toBe(true);
    expect(byPrefix.every((h) => String(h.ticket).startsWith(prefix))).toBe(true);
    // the other broker's trade never shows, even by its exact ticket
    const theirs = await prisma.position.findFirstOrThrow({ where: { accountId: other.accountId } });
    expect(((await call(GET, `/api/manage/search?q=${theirs.ticket}`)).json.tickets as TicketHit[]).some((h) => h.accountId === other.accountId)).toBe(false);
    // deals are found by their own ticket
    const out = await prisma.deal.findFirstOrThrow({ where: { positionId: p.id, entry: "OUT" } });
    expect(((await call(GET, `/api/manage/search?q=${out.ticket}`)).json.tickets as TicketHit[])[0]).toMatchObject({ type: "deal", exact: true, entry: "OUT", positionId: p.id, status: "FILLED" });
  });

  it("a client market fill records requested / executed time, IP, platform, routing and AUTO; the backoffice reads it back", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 100000 });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    const before = Date.now();
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.10", price: "100.10", idempotencyKey: `bd:${randomUUID()}` }, undefined, {
      "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "futurixglobal-terminal-1.0.93-70ac7d4cc6e1", "x-real-ip": "203.0.113.7",
    });
    expect(r.status).toBe(201);
    const o = await prisma.order.findUniqueOrThrow({ where: { id: r.json.order.id } });
    expect([o.clientIp, o.platform, o.routing, o.executionMode, o.status]).toEqual(["203.0.113.7", "Windows terminal 1.0.93", "B_BOOK", "AUTO", "FILLED"]);
    expect(o.requestedAt!.getTime()).toBeGreaterThanOrEqual(before - 5);
    expect(o.executedAt!.getTime()).toBeGreaterThanOrEqual(o.requestedAt!.getTime());

    // close it so the Closed trades list has it; the open side's execution detail comes back with every captured field
    const p = await prisma.position.findFirstOrThrow({ where: { originOrderId: o.id } });
    const { POST: close } = await import("@/app/api/trade/positions/[id]/close/route");
    expect((await call(close, `/api/trade/positions/${p.id}/close`, "POST", { closePrice: "100.00", maxSlippagePips: "5" }, { id: p.id }, {
      "x-client-platform": "DESKTOP_NATIVE", "x-client-build": "futurixglobal-terminal-1.0.93-70ac7d4cc6e1", "x-real-ip": "203.0.113.9",
    })).status).toBe(200);
    asManager(fx);
    const { GET } = await import("@/app/api/manage/deals/route");
    const row = ((await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.id === p.id)!;
    expect(row.openExecution).toMatchObject({ orderTicket: o.ticket, platform: "Windows terminal 1.0.93", clientIp: "203.0.113.7", routing: "B_BOOK", executionMode: "AUTO", requestedPrice: "100.10", status: "FILLED" });
    expect(typeof (row.openExecution as { latencyMs: number }).latencyMs).toBe("number");
    // D-3: a direct close writes no order; its execution detail comes from the OUT deal, with the request side captured
    const outDeal = await prisma.deal.findFirstOrThrow({ where: { positionId: p.id, entry: "OUT" } });
    expect(row.closeExecution).toMatchObject({
      dealTicket: Number(outDeal.ticket), reason: "CLIENT", status: "FILLED", source: "DESKTOP_NATIVE", requestedPrice: "100.00", filledPrice: outDeal.price.toFixed(2),
      clientIp: "203.0.113.9", platform: "Windows terminal 1.0.93", routing: "B_BOOK", executionMode: "AUTO", executedAt: outDeal.executedAt.toISOString(),
    });
    expect((row.closeExecution as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0);
    const outRow = ((await call(GET, `/api/manage/deals?view=deals&accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.positionId === p.id && x.entry === "OUT")!;
    expect(outRow.execution).toMatchObject({ platform: "Windows terminal 1.0.93", requestedPrice: "100.00", executionMode: "AUTO" });
    const deal = ((await call(GET, `/api/manage/deals?view=deals&accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.positionId === p.id && x.entry === "IN")!;
    expect(deal.execution).toMatchObject({ orderTicket: o.ticket, platform: "Windows terminal 1.0.93" });
  });

  it("every close has a closeExecution: a close with no capture shows its fill and book only; bulk and staff closes are captured", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 100000 });
    const old = await trade(fx, { open: "100", close: "104" });   // written through closePositionInTx with no capture
    asManager(fx);
    const { GET } = await import("@/app/api/manage/deals/route");
    const rows = async () => (await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as Record<string, unknown>[];
    const oldOut = await prisma.deal.findFirstOrThrow({ where: { positionId: old.id, entry: "OUT" } });
    expect((await rows()).find((x) => x.id === old.id)!.closeExecution).toEqual({
      dealTicket: Number(oldOut.ticket), reason: "CLIENT", status: "FILLED", executedAt: oldOut.executedAt.toISOString(), filledPrice: "104.00", routing: "B_BOOK",
    });
    // a trader's bulk close and a staff close
    const open = async () => {
      asTrader(fx);
      const { POST } = await import("@/app/api/trade/orders/route");
      const r = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "BUY", type: "MARKET", volume: "0.10", price: "100.10", idempotencyKey: `bd:${randomUUID()}` });
      return prisma.position.findFirstOrThrow({ where: { originOrderId: r.json.order.id } });
    };
    const a = await open();
    asTrader(fx);
    const { POST: bulk } = await import("@/app/api/trade/positions/close-bulk/route");
    expect((await call(bulk, "/api/trade/positions/close-bulk", "POST", { scope: "ALL" }, undefined, { "x-client-platform": "MOBILE", "x-real-ip": "198.51.100.8" })).status).toBe(200);
    expect((await rows()).find((x) => x.id === a.id)!.closeExecution).toMatchObject({ reason: "BULK", platform: "Mobile", clientIp: "198.51.100.8", executionMode: "AUTO", routing: "B_BOOK" });
    const b = await open();
    asAdmin(fx);
    const { POST: adminClose } = await import("@/app/api/manage/positions/[id]/close/route");
    expect((await call(adminClose, `/api/manage/positions/${b.id}/close`, "POST", {}, { id: b.id })).status).toBe(200);
    asManager(fx);
    expect((await rows()).find((x) => x.id === b.id)!.closeExecution).toMatchObject({ reason: "ADMIN", platform: "Backoffice", executionMode: "DEALER" });
  });

  it("a dealer's reject records the outcome: REJECTED, DEALER, executedAt, the reason", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 100000, dealing: true });
    asTrader(fx);
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: fx.symbolName, side: "SELL", type: "MARKET", volume: "0.10", price: "100.00", idempotencyKey: `bd:${randomUUID()}` }, undefined, { "x-client-platform": "MOBILE", "x-real-ip": "198.51.100.4" });
    expect(r.status).toBe(201);
    const queued = await prisma.order.findUniqueOrThrow({ where: { id: r.json.order.id } });
    expect([queued.status, queued.platform, queued.clientIp, queued.executedAt, queued.executionMode]).toEqual(["PENDING", "Mobile", "198.51.100.4", null, null]);
    asAdmin(fx);
    const { PATCH } = await import("@/app/api/manage/dealing-queue/[id]/route");
    expect((await call(PATCH, `/api/manage/dealing-queue/${queued.id}`, "PATCH", { action: "REJECT", reason: "off-market request" }, { id: queued.id })).status).toBe(200);
    const done = await prisma.order.findUniqueOrThrow({ where: { id: queued.id } });
    expect([done.status, done.executionMode, done.rejectionReason]).toEqual(["REJECTED", "DEALER", "off-market request"]);
    expect(done.executedAt).not.toBeNull();
    expect(executionDetail(done, 2)).toMatchObject({ status: "REJECTED", rejectReason: "off-market request", executionMode: "DEALER", platform: "Mobile" });
  });
});

// ------------------------------------------------------------------------------------------------ D-2
describe("D-2: delete reverses and hides, void reverses and shows", () => {
  it("delete of a closed trade: P/L, commission and swap reversed, the trade VOIDED + deleted, its rows hidden; refusals", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const p = await trade(fx, { open: "100", close: "130", commissionPerLot: "2", swap: "-1.5" });   // -2 +30 -1.5
    expect((await balance(fx)).balance.toString()).toBe("1026.5");
    const r = await deleteAsAdmin(fx, p.id);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ status: "VOIDED", reversalAmount: "-26.5" });
    expect((await balance(fx)).balance.toString()).toBe("1000");   // exactly as before the trade
    const after = await prisma.position.findUniqueOrThrow({ where: { id: p.id } });
    expect([after.status, after.deleteReason, after.deletedByAdminId]).toEqual(["VOIDED", "duplicate test entry", fx.adminId]);
    const rows = await prisma.transaction.findMany({ where: { referenceType: "Position", referenceId: p.id }, select: { type: true, amount: true, hiddenForPositionId: true } });
    const hiddenTypes = rows.filter((x) => x.hiddenForPositionId === p.id).map((x) => `${x.type} ${x.amount}`).sort();
    expect(hiddenTypes).toEqual(["ADJUSTMENT -28", "COMMISSION -2", "TRADE_PNL 30"]);
    expect(rows.filter((x) => !x.hiddenForPositionId).map((x) => `${x.type} ${x.amount}`)).toEqual(["SWAP 1.5"]);   // the swap refund stays on the swap line
    expect(vi.mocked(publishTradingEvent)).toHaveBeenCalledWith("BalanceChanged", expect.objectContaining({ account_id: fx.accountId }));
    // refusals: deleted again, an open position, below zero, a closed account
    expect((await deleteAsAdmin(fx, p.id)).status).toBe(409);
    const open = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", volume: D(1), openPrice: D(100), originOrderId: (await prisma.order.create({ data: { brokerId: fx.brokerId, accountId: fx.accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), idempotencyKey: `bd:${randomUUID()}`, status: "FILLED" } })).id } });
    expect((await deleteAsAdmin(fx, open.id)).json.error).toBe("cannot delete an open position, void or close it first");
    const won = await trade(fx, { open: "100", close: "600" });   // +500, then withdrawn
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: D(100) } });
    const below = await deleteAsAdmin(fx, won.id);
    expect([below.status, String(below.json.error).startsWith("cannot reverse: the balance would go below zero")]).toEqual([409, true]);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: won.id } })).deletedAt).toBeNull();   // nothing written
    await prisma.account.update({ where: { id: fx.accountId }, data: { balance: D(1000), status: "CLOSED" } });
    expect((await deleteAsAdmin(fx, won.id)).json.error).toBe("account is closed");
  });

  it("delete of a loss that used credit: the credit comes back with the balance", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 100, credit: 300 });
    const p = await trade(fx, { open: "300", close: "50" });   // -250 against a 100 balance: credit covers the rest
    const mid = await balance(fx);
    expect(mid.credit.lt(300)).toBe(true);
    expect((await deleteAsAdmin(fx, p.id)).status).toBe(200);
    const end = await balance(fx);
    expect([end.balance.toString(), end.credit.toString()]).toEqual(["100", "300"]);
  });

  it("a deleted trade is gone from every client read (history, closes, deals, transactions, summary, audit); the backoffice keeps it behind show-deleted", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const keep = await trade(fx, { open: "100", close: "110" });
    const gone = await trade(fx, { open: "100", close: "150", commissionPerLot: "1", swap: "-2" });
    expect((await deleteAsAdmin(fx, gone.id, "test entry")).status).toBe(200);
    const v = await clientView(fx);
    expect(v.history.map((h) => h.id)).toEqual([keep.id]);
    expect(v.closes.map((h) => h.id)).toEqual([keep.id]);
    expect(v.deals.every((d) => d.positionTicket === keep.ticket)).toBe(true);
    expect(v.transactions.some((t) => t.type === "ADJUSTMENT")).toBe(false);   // the delete's reversal is hidden too
    expect(v.summary.trades.count).toBe(1);
    expect(v.summary.trades.grossPnl).toBe("10.00");
    expect(v.summary.trades.swap).toBe("0.00");   // charged 2, returned 2
    expect(v.summary.voided.count).toBe(0);
    expect(v.summary.funds.deletedTrades).toBe("0.00");
    expect(v.summary.funds.adjustments).toBe("0.00");
    expect(v.summary.reconciliation.ok).toBe(true);
    expect(JSON.stringify(v.audit)).not.toContain("POSITION_DELETED");
    expect(JSON.stringify(v.audit)).not.toContain("test entry");

    asManager(fx);
    const { GET } = await import("@/app/api/manage/deals/route");
    const plain = (await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as { id: string }[];
    expect(plain.map((x) => x.id)).toEqual([keep.id]);
    const all = (await call(GET, `/api/manage/deals?accountId=${fx.accountId}&deleted=1`)).json as Record<string, unknown>[];
    expect(all.find((x) => x.id === gone.id)).toMatchObject({ deleted: true, deleteReason: "test entry", status: "VOIDED" });
    expect(all.find((x) => x.id === keep.id)).toMatchObject({ deleted: false, pendingAction: null });
    const dealRows = (await call(GET, `/api/manage/deals?view=deals&accountId=${fx.accountId}&deleted=1`)).json as Record<string, unknown>[];
    expect(dealRows.filter((x) => x.positionId === gone.id).every((x) => x.deleted === true && x.voided === true)).toBe(true);
    const { GET: ledger } = await import("@/app/api/manage/accounts/[id]/funds-history/route");
    const lj = (await call(ledger, `/api/manage/accounts/${fx.accountId}/funds-history`, "GET", undefined, { id: fx.accountId })).json as { rows: { type: string; hiddenFromClient: boolean }[] };
    expect(lj.rows.filter((x) => x.type === "ADJUSTMENT").every((x) => x.hiddenFromClient)).toBe(true);
  });

  it("a voided trade stays visible: VOIDED in history and deals, the reversal names the ticket, the summary's voided line", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const p = await trade(fx, { open: "100", close: "120", commissionPerLot: "1" });
    expect((await voidAsAdmin(fx, p.id)).status).toBe(200);
    const v = await clientView(fx);
    expect(v.history.find((h) => h.id === p.id)?.status).toBe("VOIDED");
    expect(v.closes.find((h) => h.id === p.id)?.status).toBe("VOIDED");
    expect(v.deals.filter((d) => d.positionTicket === p.ticket).map((d) => d.status)).toEqual(["VOIDED", "VOIDED"]);
    expect(v.transactions.find((t) => t.type === "ADJUSTMENT")?.note).toBe(`Void of #${p.ticket}: reverses its result, commission and swap`);
    expect(v.summary.trades.count).toBe(0);
    expect(v.summary.trades.winRate).toBe("0.00");
    expect(v.summary.voided).toEqual({ count: 1, volumeLots: "1.00", grossPnl: "20.00", commission: "1.00", reversal: "-19.00", net: "0.00" });
    expect(v.summary.funds.adjustments).toBe("0.00");
    expect(identity(v.summary).toFixed(2)).toBe(v.summary.closingBalance);
  });

  it("delete after void: no second reversal, the swap refund moves to the swap line, the hidden rows net to zero", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const p = await trade(fx, { open: "100", close: "105", swap: "-3" });
    await prisma.$transaction((tx) => executeVoid(tx, { brokerId: fx.brokerId, positionId: p.id, adminId: fx.adminId }));
    const voidedBalance = (await balance(fx)).balance.toString();
    expect(voidedBalance).toBe("1000");
    const r = await deleteAsAdmin(fx, p.id);
    expect([r.status, r.json.reversalAmount]).toEqual([200, "0"]);
    expect((await balance(fx)).balance.toString()).toBe(voidedBalance);
    const hidden = await prisma.transaction.aggregate({ where: { hiddenForPositionId: p.id }, _sum: { amount: true } });
    expect(hidden._sum.amount?.toString()).toBe("0");
    const s = (await clientView(fx)).summary;
    expect([s.trades.count, s.trades.swap, s.funds.deletedTrades, s.reconciliation.ok]).toEqual([0, "0.00", "0.00", true]);
  });

  it("summary across ranges: a trade closed in an earlier range and deleted now reconciles in both", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const then = new Date(Date.now() - 48 * H);
    const p = await trade(fx, { open: "100", close: "140", commissionPerLot: "2", at: then });   // +40 -2 two days ago
    expect((await deleteAsAdmin(fx, p.id)).status).toBe(200);
    const early = await summarizeAccount(fx.accountId, { from: new Date(then.getTime() - H), to: new Date(then.getTime() + H) });
    const late = await summarizeAccount(fx.accountId, { from: new Date(then.getTime() + 2 * H), to: new Date() });
    expect([early.trades.count, early.funds.deletedTrades, early.reconciliation.ok]).toEqual([0, "38.00", true]);
    expect([late.trades.count, late.funds.deletedTrades, late.reconciliation.ok]).toEqual([0, "-38.00", true]);
    expect(late.closingBalance).toBe("1000.00");
  });
});

describe("D-2: pending requests and the delete record", () => {
  it("a manager's request is visible to every staff PC (server-side), VOID vs DELETE; a second request on the trade is refused", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const p = await trade(fx, { open: "100", close: "110" });
    asManager(fx);
    const { POST: voidPost } = await import("@/app/api/manage/positions/[id]/void/route");
    const { POST: deletePost } = await import("@/app/api/manage/positions/[id]/delete/route");
    const filed = await call(voidPost, `/api/manage/positions/${p.id}/void`, "POST", {}, { id: p.id });
    expect(filed.status).toBe(202);
    const { GET } = await import("@/app/api/manage/deals/route");
    const row = ((await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.id === p.id)!;
    expect(row.pendingAction).toMatchObject({ type: "VOID", requestId: filed.json.requestId, requestedBy: fx.managerEmail });
    // a second request, of either type, is refused; the database refuses a second PENDING row too
    const second = await call(deletePost, `/api/manage/positions/${p.id}/delete`, "POST", { reason: "dup" }, { id: p.id });
    expect([second.status, second.json.error]).toEqual([409, "a void request for this trade is already waiting for approval"]);
    expect((await call(voidPost, `/api/manage/positions/${p.id}/void`, "POST", {}, { id: p.id })).status).toBe(409);
    await expect(prisma.positionActionRequest.create({ data: { brokerId: fx.brokerId, positionId: p.id, actionType: "DELETE", requestedByAdminId: fx.adminId, reason: "race" } })).rejects.toThrow();
    // approved: nothing waits any more, and a new request may be filed
    asAdmin(fx);
    const { POST: approve } = await import("@/app/api/manage/position-action-requests/[id]/approve/route");
    expect((await call(approve, `/api/manage/position-action-requests/${filed.json.requestId}/approve`, "POST", {}, { id: filed.json.requestId })).status).toBe(200);
    asManager(fx);
    expect(((await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.id === p.id)!.pendingAction).toBeNull();
    const del = await call(deletePost, `/api/manage/positions/${p.id}/delete`, "POST", { reason: "duplicate" }, { id: p.id });
    expect(del.status).toBe(202);
    expect(((await call(GET, `/api/manage/deals?accountId=${fx.accountId}`)).json as Record<string, unknown>[]).find((x) => x.id === p.id)!.pendingAction).toMatchObject({ type: "DELETE" });
  });

  it("the delete record (POSITION_DELETED, a DELETE request / approval) is returned to BROKER_ADMIN only; a void's is not hidden", async () => {
    if (!dbReachable) return;
    const fx = await fixture({ balance: 1000 });
    const a = await trade(fx, { open: "100", close: "110" });
    const b = await trade(fx, { open: "100", close: "90" });
    asManager(fx);
    const { POST: deletePost } = await import("@/app/api/manage/positions/[id]/delete/route");
    const { POST: voidPost } = await import("@/app/api/manage/positions/[id]/void/route");
    const filed = await call(deletePost, `/api/manage/positions/${a.id}/delete`, "POST", { reason: "secret reason" }, { id: a.id });
    expect((await call(voidPost, `/api/manage/positions/${b.id}/void`, "POST", {}, { id: b.id })).status).toBe(202);
    asAdmin(fx);
    const { POST: approve } = await import("@/app/api/manage/position-action-requests/[id]/approve/route");
    expect((await call(approve, `/api/manage/position-action-requests/${filed.json.requestId}/approve`, "POST", {}, { id: filed.json.requestId })).status).toBe(200);

    const { GET } = await import("@/app/api/manage/audit/route");
    const seen = async () => (await call(GET, `/api/manage/audit?q=${encodeURIComponent("POSITION")}`)).json as { action: string; entityId: string; diffLines: unknown }[];
    asAdmin(fx);
    const admin = await seen();
    expect(admin.filter((x) => x.entityId === a.id).map((x) => x.action).sort()).toEqual(["POSITION_ACTION_APPROVED", "POSITION_ACTION_REQUESTED", "POSITION_DELETED"]);
    asManager(fx);
    const manager = await seen();
    expect(manager.filter((x) => x.entityId === a.id)).toEqual([]);
    expect(manager.filter((x) => x.entityId === b.id).map((x) => x.action)).toEqual(["POSITION_ACTION_REQUESTED"]);   // the void request stays visible
    // stored for everyone
    expect(await prisma.auditLog.count({ where: { entityId: a.id, action: "POSITION_DELETED" } })).toBe(1);
  });
});
