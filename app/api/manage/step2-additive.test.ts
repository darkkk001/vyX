import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Step 2 part A (owner 2026-09-30): the queued web changes are ADDITIVE -- every field the backoffice reads today keeps
// its shape, and the new ones carry the right values. Live local DB; one fixture broker with two currencies, a demo
// account, the broker's hedge (coverage) account and a COVERAGE-category group, so "clients only" is actually tested.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

const D = (v: string | number) => new Prisma.Decimal(v);
let ready = false;
let brokerId = "";
let adminId = "";
let symbolName = "";
const ids: Record<string, string> = {};

beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    ready = true;
  } catch {
    console.warn("step2-additive.test.ts: DB unreachable, skipping");
    return;
  }
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `S2A ${s}`, subdomain: `s2a-${s}` } });
  brokerId = broker.id;
  adminId = (await prisma.adminUser.create({ data: { brokerId, email: `s2a-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN", status: "ACTIVE" } })).id;
  const symbol = await prisma.symbol.create({ data: { name: `S2A${s.toUpperCase()}`, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  symbolName = symbol.name;
  const bs = await prisma.brokerSymbol.create({ data: { brokerId, symbolId: symbol.id, minLot: D(0.01), maxLot: D(100), lotStep: D(0.01) } });
  await prisma.tradingSession.createMany({ data: [1, 2, 3].map((d) => ({ brokerSymbolId: bs.id, dayOfWeek: d, openTime: "00:00", closeTime: "23:59" })) });
  const g = await prisma.group.create({ data: { brokerId, name: `G-${s}`, dealingMode: "AUTO" } });
  const cov = await prisma.group.create({ data: { brokerId, name: `COV-${s}`, dealingMode: "AUTO", category: "COVERAGE" } });
  let n = 0;
  const mk = async (key: string, extra: Partial<Prisma.AccountUncheckedCreateInput>) => {
    n += 1;
    const num = `6${s.slice(0, 5)}${n}`;
    ids[key] = (await prisma.account.create({ data: { brokerId, groupId: g.id, accountNumber: num, email: `${num}@t.local`, passwordHash: "x", fullName: key, accountMode: "LIVE", balance: D(1000), ...extra } })).id;
  };
  await mk("usd", { currency: "USD" });
  await mk("eur", { currency: "EUR" });
  await mk("demo", { accountMode: "DEMO", currency: "USD" });
  await mk("hedge", { currency: "USD" });
  await mk("covgroup", { currency: "USD", groupId: cov.id });
  await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: ids.hedge } });
  const tx = (accountId: string, type: "DEPOSIT" | "WITHDRAWAL", amount: string, status: "COMPLETED" | "PENDING") =>
    prisma.transaction.create({ data: { brokerId, accountId, type, status, amount: D(amount), balanceBefore: D(0), balanceAfter: D(0) } });
  await tx(ids.usd, "DEPOSIT", "100", "COMPLETED");
  await tx(ids.eur, "DEPOSIT", "40", "COMPLETED");
  await tx(ids.eur, "WITHDRAWAL", "-15", "PENDING");
  await tx(ids.demo, "DEPOSIT", "999", "COMPLETED"); // demo: never in client totals
  await tx(ids.hedge, "DEPOSIT", "5000", "COMPLETED"); // hedge account: never in client totals
  await tx(ids.covgroup, "DEPOSIT", "7000", "COMPLETED"); // COVERAGE group: never in client totals
  const order = await prisma.order.create({ data: { brokerId, accountId: ids.usd, symbolId: symbol.id, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `s2a:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  await prisma.position.create({ data: { brokerId, accountId: ids.usd, symbolId: symbol.id, originOrderId: order.id, side: "BUY", volume: D(1), openPrice: D(100) } });
  const client = await prisma.client.create({ data: { brokerId, email: `s2a-c-${s}@t.local`, passwordHash: "x", fullName: "Portal Pat" } });
  ids.client = client.id;
  await prisma.auditLog.createMany({
    data: [
      { brokerId, actorAdminId: adminId, action: "GROUP_CONFIG_UPDATED", entityType: "Group", entityId: g.id, newValue: { swapFree: false } },
      { brokerId, actorAdminId: null, action: "ACCOUNT_TYPE_UPDATED", entityType: "AccountType", entityId: "x", newValue: { swapFree: null, source: "owner-approved direct write 2026-09-30 (test)" } },
      { brokerId, actorAdminId: null, action: "CLIENT_PROFILE_UPDATED", entityType: "Client", entityId: client.id, newValue: { phone: "1" } },
      { brokerId, actorAdminId: null, action: "SWAP_ROLLOVER_RUN", entityType: "Broker", entityId: brokerId },
    ],
  });
  await prisma.transaction.create({ data: { brokerId, accountId: ids.eur, type: "TRANSFER_IN", status: "COMPLETED", amount: D(5), balanceBefore: D(0), balanceAfter: D(5) } });
  await prisma.mirrorRule.create({ data: { brokerId, sourceType: "ACCOUNT", sourceId: ids.usd, targetAccountId: ids.eur, direction: "REVERSE", multiplier: D(1), enabled: false, createdById: adminId } });
  await prisma.ibRelationship.create({ data: { brokerId, ibAccountId: ids.eur, clientAccountId: ids.usd, commissionType: "PER_LOT", commissionRate: D(1) } });
  await prisma.balanceAdjustmentRequest.create({ data: { brokerId, accountId: ids.eur, amount: D(3), note: "t", requestedByAdminId: adminId } });
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role: "BROKER_ADMIN", brokerId });
}, 60000);

afterAll(async () => {
  if (!ready) return;
  const where = { brokerId };
  await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: null } });
  await prisma.auditLog.deleteMany({ where });
  await prisma.balanceAdjustmentRequest.deleteMany({ where });
  await prisma.ibRelationship.deleteMany({ where });
  await prisma.mirrorRule.deleteMany({ where });
  await prisma.transaction.deleteMany({ where });
  await prisma.position.deleteMany({ where });
  await prisma.order.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.client.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.tradingSession.deleteMany({ where: { brokerSymbol: { brokerId } } });
  await prisma.brokerSymbol.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.delete({ where: { id: brokerId } });
  await prisma.symbol.deleteMany({ where: { name: symbolName } });
  await prisma.$disconnect();
}, 60000);

async function get(mod: string, query = "") {
  const m = await import(`./${mod}/route.ts`);
  const res: Response = await m.GET(new NextRequest(`https://t.local/api/manage/${mod}${query}`));
  expect(res.status).toBe(200);
  return res.json();
}

describe("step 2 A: additive fields on the manage reads", () => {
  it("dashboard: old fields unchanged in shape; clients block = live clients only, per currency", async () => {
    if (!ready) return;
    const d = await get("dashboard");
    expect(typeof d.depositsSum30d).toBe("number"); // old field kept
    expect(typeof d.activeTradeAccountCount).toBe("number");
    expect(d.clients.total).toBe(2); // usd + eur; not demo, not hedge, not the COVERAGE-group account
    expect(d.clients.activeAccounts).toBe(1);
    expect(d.clients.openPositions).toBe(1);
    const byCcy = Object.fromEntries(d.clients.byCurrency.map((r: { currency: string }) => [r.currency, r]));
    expect(Object.keys(byCcy).sort()).toEqual(["EUR", "USD"]);
    expect(byCcy.USD.deposits30d).toEqual({ count: 1, amount: "100.00" });
    expect(byCcy.EUR.deposits30d).toEqual({ count: 1, amount: "40.00" });
    expect(byCcy.EUR.pendingWithdrawals).toEqual({ count: 1, amount: "15.00" });
    expect(byCcy.USD.net7d).toEqual({ count: 1, amount: "100.00" });
    expect(d.activity.find((a: { actorKind: string }) => a.actorKind === "DIRECT")?.source).toContain("owner-approved");
  });

  it("funds-requests: rows carry currency; kpisByCurrency never sums across currencies; kpis kept", async () => {
    if (!ready) return;
    const f = await get("funds-requests");
    expect(f.kpis).toBeTruthy();
    expect(f.rows.find((r: { accountId: string }) => r.accountId === ids.eur).currency).toBe("EUR");
    const eur = f.kpisByCurrency.find((k: { currency: string }) => k.currency === "EUR");
    expect(eur.pendingWithdrawals).toEqual({ count: 1, amount: "15.00" });
    expect(eur.deposits30d).toEqual({ count: 1, amount: "40.00" });
  });

  it("accounts: createdAt added, currency kept", async () => {
    if (!ready) return;
    const rows = await get("accounts");
    const eur = rows.find((r: { id: string }) => r.id === ids.eur);
    expect(eur.currency).toBe("EUR");
    expect(Number.isNaN(Date.parse(eur.createdAt))).toBe(false);
  });

  it("symbols: sessionCount per symbol", async () => {
    if (!ready) return;
    const rows = await get("symbols");
    expect(rows.find((r: { symbolName: string }) => r.symbolName === symbolName).sessionCount).toBe(3);
  });

  it("audit: actorKind STAFF / DIRECT / CLIENT / SYSTEM + source; Client rows get a readable label", async () => {
    if (!ready) return;
    const rows = await get("audit");
    const by = (action: string) => rows.find((r: { action: string }) => r.action === action);
    expect(by("GROUP_CONFIG_UPDATED").actorKind).toBe("STAFF");
    expect(by("ACCOUNT_TYPE_UPDATED")).toMatchObject({ actorKind: "DIRECT", actorEmail: "system", source: "owner-approved direct write 2026-09-30 (test)" });
    expect(by("CLIENT_PROFILE_UPDATED")).toMatchObject({ actorKind: "CLIENT", entityLabel: "Client Portal Pat" });
    expect(by("SWAP_ROLLOVER_RUN")).toMatchObject({ actorKind: "SYSTEM", source: null });
  });

  it("transfers, mirror-rules, ib-relationships, balance-adjustment-requests carry the account currency", async () => {
    if (!ready) return;
    const t = await get("transfers");
    expect(t[0]).toMatchObject({ type: "TRANSFER_IN", currency: "EUR" });
    const m = await get("mirror-rules");
    expect(m.rows[0]).toMatchObject({ targetAccountId: ids.eur, targetCurrency: "EUR" });
    const ib = await get("ib-relationships");
    expect(ib[0]).toMatchObject({ ibAccountId: ids.eur, currency: "EUR", partnerSuspendedAt: null, partnerAccountStatus: "ACTIVE" });
    const br = await get("balance-adjustment-requests");
    expect(br[0]).toMatchObject({ currency: "EUR", account: { id: ids.eur, currency: "EUR" } });
  });
});
