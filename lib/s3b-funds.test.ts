import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 3b item 8 (owner 2026-10-07): the Funds window. HISTORY: this account's deposits, withdrawals, adjustments, credit and transfers with
// per-type totals (an adjustment is its own type, never part of the deposit total). TRANSFER: the existing transfer route (two ledger rows
// and one audit row in one transaction; same client; overdraw, margin and cross-currency refused; a manager's waits for an admin).
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("s3b-funds.test.ts: DB unreachable, skipping"); } });
const brokers: string[] = []; const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.balanceAdjustmentRequest.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world() {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Funds ${sfx}`, subdomain: `funds-${sfx}` } }); brokers.push(b.id);
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `FG-${sfx}`, leverage: 100 } });
  const name = `FU${sfx.toUpperCase()}`; symbols.push(name);
  const sym = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(100) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: sym.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), tradingMode: "BOTH" } });
  await prisma.livePrice.create({ data: { symbol: name, bid: D("100"), ask: D("100.1"), tickAt: new Date() } });
  const mk = (role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT") => prisma.adminUser.create({ data: { brokerId: b.id, email: `fu-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role } });
  const email = `client-${sfx}@test.local`;
  const acc = (balance: number, opts: { email?: string; currency?: string } = {}) => {
    const n = `7${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "6")}`;
    return prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: opts.email ?? email, passwordHash: "x", fullName: "F Client", accountMode: "LIVE", currency: opts.currency ?? "USD", balance: D(balance), leverage: 100 } });
  };
  return { b, mk, acc, sym };
}
const as = (b: string, a: { id: string; role: string }) => vi.mocked(getAdminSession).mockResolvedValue({ adminId: a.id, role: a.role, brokerId: b } as never);
const req = (body?: unknown) => new NextRequest("https://t.local/x", { method: body ? "POST" : "GET", headers: { "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });
const ledger = (accountId: string, type: string, amount: string, status = "COMPLETED") => prisma.transaction.create({ data: { brokerId: brokers[brokers.length - 1], accountId, type: type as never, status: status as never, amount: D(amount), balanceBefore: D(0), balanceAfter: D(0) } });

describe("HISTORY: GET /api/manage/accounts/{id}/funds-history", () => {
  it("lists the fund types only, with per-type totals of the COMPLETED rows; an adjustment is not a deposit; SUPPORT reads; another broker's account is not found", async () => {
    if (!dbReachable) return;
    const w = await world(); const other = await world(); const boss = await w.mk("BROKER_ADMIN"); const support = await w.mk("SUPPORT");
    const a = await w.acc(1000); const foreign = await other.acc(1);
    await ledger(a.id, "DEPOSIT", "500"); await ledger(a.id, "DEPOSIT", "250"); await ledger(a.id, "DEPOSIT", "999", "PENDING");
    await ledger(a.id, "WITHDRAWAL", "-100"); await ledger(a.id, "ADJUSTMENT", "-30"); await ledger(a.id, "ADJUSTMENT", "80");
    await ledger(a.id, "CREDIT_IN", "200"); await ledger(a.id, "CREDIT_OUT", "-50"); await ledger(a.id, "TRANSFER_IN", "40"); await ledger(a.id, "TRANSFER_OUT", "-15");
    await ledger(a.id, "TRADE_PNL", "-9999"); await ledger(a.id, "COMMISSION", "-7");
    const { GET } = await import("@/app/api/manage/accounts/[id]/funds-history/route");
    const get = (id: string) => GET(req(), { params: Promise.resolve({ id }) });
    as(w.b.id, boss);
    const j = await (await get(a.id)).json();
    expect(j.rows.every((r: { type: string }) => !["TRADE_PNL", "COMMISSION"].includes(r.type))).toBe(true);
    expect(j.rows).toHaveLength(10);
    const total = (t: string) => j.totals.find((x: { type: string }) => x.type === t)?.amount;
    expect(total("DEPOSIT")).toBe("750.00");                        // the pending 999 is not counted
    expect(total("WITHDRAWAL")).toBe("-100.00");
    expect(total("ADJUSTMENT")).toBe("50.00");                      // its own total: -30 + 80, never added to the deposits
    expect(total("CREDIT_IN")).toBe("200.00"); expect(total("CREDIT_OUT")).toBe("-50.00");
    expect(total("TRANSFER_IN")).toBe("40.00"); expect(total("TRANSFER_OUT")).toBe("-15.00");
    expect(j.rows.find((r: { type: string; status: string }) => r.type === "DEPOSIT" && r.status === "PENDING").amount).toBe("999.00");
    expect((await get(foreign.id)).status).toBe(404);
    as(w.b.id, support); expect((await get(a.id)).status).toBe(200);
  });
});

describe("TRANSFER: POST /api/manage/transfers", () => {
  const post = async (body: unknown) => { const { POST } = await import("@/app/api/manage/transfers/route"); const r = await POST(req(body)); return { status: r.status, json: await r.json() }; };

  it("writes two ledger rows and one audit row, both balances move; a manager's request waits for an admin and moves nothing", async () => {
    if (!dbReachable) return;
    const w = await world(); const boss = await w.mk("BROKER_ADMIN"); const mgr = await w.mk("MANAGER");
    const from = await w.acc(1000); const to = await w.acc(50);
    as(w.b.id, boss);
    const r = await post({ fromAccountId: from.id, toAccountId: to.id, amount: "300", note: "move to the second account" });
    expect(r.status).toBe(200);
    const out = await prisma.transaction.findUniqueOrThrow({ where: { id: r.json.outTransactionId } }); const inn = await prisma.transaction.findUniqueOrThrow({ where: { id: r.json.inTransactionId } });
    expect([out.type, out.amount.toString(), out.balanceAfter.toString(), out.accountId]).toEqual(["TRANSFER_OUT", "-300", "700", from.id]);
    expect([inn.type, inn.amount.toString(), inn.balanceAfter.toString(), inn.accountId]).toEqual(["TRANSFER_IN", "300", "350", to.id]);
    expect(await prisma.transaction.count({ where: { brokerId: w.b.id, type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } } })).toBe(2);
    const audit = await prisma.auditLog.findMany({ where: { brokerId: w.b.id, action: "INTERNAL_TRANSFER" } });
    expect(audit).toHaveLength(1); expect(audit[0].actorAdminId).toBe(boss.id);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: from.id } })).balance.toString()).toBe("700");
    // a manager (with the transfer permission) files a request: nothing moves until a second admin approves it
    await prisma.adminUser.update({ where: { id: mgr.id }, data: { extraPermissions: ["INTERNAL_TRANSFERS"] as never } });
    as(w.b.id, mgr);
    const p = await post({ fromAccountId: from.id, toAccountId: to.id, amount: "100", note: "manager transfer" });
    expect(p.status).toBe(202); expect(p.json.pending).toBe(true);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: from.id } })).balance.toString()).toBe("700");
    expect(await prisma.transaction.count({ where: { brokerId: w.b.id, type: "TRANSFER_OUT" } })).toBe(1);
  });

  it("refuses an overdraw, a transfer that takes the margin from open positions, another currency, another client's account, the same account and a missing reason; nothing moves", async () => {
    if (!dbReachable) return;
    const w = await world(); const boss = await w.mk("BROKER_ADMIN"); as(w.b.id, boss);
    const from = await w.acc(1000); const to = await w.acc(0); const eur = await w.acc(0, { currency: "EUR" }); const stranger = await w.acc(0, { email: `other-${randomUUID().slice(0, 6)}@test.local` });
    const moved = async () => (await prisma.transaction.count({ where: { brokerId: w.b.id, type: { in: ["TRANSFER_OUT", "TRANSFER_IN"] } } })) + (await prisma.account.findUniqueOrThrow({ where: { id: from.id } })).balance.toNumber();
    const before = await moved();
    const note = "reason";
    const over = await post({ fromAccountId: from.id, toAccountId: to.id, amount: "1000.01", note });
    expect(over.status).toBe(400); expect(over.json.error).toMatch(/insufficient balance/);
    const cur = await post({ fromAccountId: from.id, toAccountId: eur.id, amount: "10", note });
    expect(cur.status).toBe(400); expect(cur.json.error).toMatch(/currency mismatch: USD account cannot transfer directly to a EUR account/);
    const other = await post({ fromAccountId: from.id, toAccountId: stranger.id, amount: "10", note });
    expect(other.status).toBe(400); expect(other.json.error).toMatch(/same client/);
    expect((await post({ fromAccountId: from.id, toAccountId: from.id, amount: "10", note })).status).toBe(400);
    expect((await post({ fromAccountId: from.id, toAccountId: to.id, amount: "10", note: "" })).status).toBe(400);
    // open positions keep their margin: 5 lots x 100 x 100 / 100 = 500 of margin; moving 600 would leave 400
    const o = await prisma.order.create({ data: { brokerId: w.b.id, accountId: from.id, symbolId: w.sym.id, side: "BUY", type: "MARKET", volume: D(5), requestedPrice: D(100), idempotencyKey: `fu:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
    await prisma.position.create({ data: { brokerId: w.b.id, accountId: from.id, symbolId: w.sym.id, originOrderId: o.id, side: "BUY", volume: D(5), openPrice: D(100), bookType: "B_BOOK", status: "OPEN" } });
    const margin = await post({ fromAccountId: from.id, toAccountId: to.id, amount: "600", note });
    expect(margin.status).toBe(400); expect(margin.json.error).toMatch(/transfer refused/);
    expect(await moved()).toBe(before);                                  // not one row, not one cent
    expect((await post({ fromAccountId: from.id, toAccountId: to.id, amount: "100", note })).status).toBe(200);     // what the margin leaves free can move
  });
});
