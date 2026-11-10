import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// 2026-11-09 (queued 2026-11-06): the broker's own hedge (coverage) money is not client money. The deposits tiles / cards
// and the reports left it in; the dashboard, Book P/L, hedge book and risk exposure already left it out. Real routes,
// real DB: a broker with one client and one hedge account, money on both.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/permissions", async (orig) => ({ ...(await orig<typeof import("@/lib/permissions")>()), forbidUnlessPermissionOrSupportReader: vi.fn().mockResolvedValue(null) }));

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("client-accounts.test.ts: DB unreachable, skipping"); }
});
afterAll(async () => {
  if (!dbReachable || brokers.length === 0) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } });
  await prisma.transaction.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  await prisma.$disconnect();
}, 30000);

async function fixture(hedgeBy: "coverageAccountId" | "groupCategory") {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `CA ${sfx}`, subdomain: `ca-${sfx}` } });
  brokers.push(broker.id);
  const clients = await prisma.group.create({ data: { brokerId: broker.id, name: `CAC-${sfx}`, category: "B_BOOK" } });
  const hedgeGroup = await prisma.group.create({ data: { brokerId: broker.id, name: `CAH-${sfx}`, category: hedgeBy === "groupCategory" ? "COVERAGE" : "A_BOOK" } });
  const mk = (n: string, groupId: string) =>
    prisma.account.create({ data: { groupId, brokerId: broker.id, accountNumber: `${n}${sfx.slice(0, 7)}`, email: `ca-${n}-${sfx}@test.local`, passwordHash: "x", fullName: "CA", accountMode: "LIVE", balance: D(0), currency: "USD", createdAt: new Date(Date.now() - 86_400_000) } });
  const client = await mk("5", clients.id);
  const hedge = await mk("9", hedgeGroup.id);
  if (hedgeBy === "coverageAccountId") await prisma.broker.update({ where: { id: broker.id }, data: { coverageAccountId: hedge.id } });
  const money = (accountId: string, type: "DEPOSIT" | "WITHDRAWAL", amount: string, status: "COMPLETED" | "PENDING" | "REJECTED" = "COMPLETED") =>
    prisma.transaction.create({ data: { brokerId: broker.id, accountId, type, status, amount: D(amount), balanceBefore: D(0), balanceAfter: D(0), createdAt: new Date(Date.now() - 3_600_000), updatedAt: new Date(Date.now() - 3_600_000) } });
  await money(client.id, "DEPOSIT", "1000");
  await money(client.id, "WITHDRAWAL", "-200");
  await money(hedge.id, "DEPOSIT", "50000");          // the broker funding its hedge account: not client money
  await money(hedge.id, "WITHDRAWAL", "-7000");
  await money(hedge.id, "DEPOSIT", "300", "REJECTED");
  await money(hedge.id, "WITHDRAWAL", "-40", "PENDING"); // pending stays: it is staff work to do
  const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `ca-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: broker.id } as never);
  return { brokerId: broker.id, client: client.id, hedge: hedge.id };
}

describe("the hedge account is left out of the money figures (live DB)", () => {
  for (const hedgeBy of ["coverageAccountId", "groupCategory"] as const) {
    it(`deposits tiles, per-currency tiles and range cards count only client money (hedge by ${hedgeBy})`, async () => {
      if (!dbReachable) return;
      await fixture(hedgeBy);
      const { GET } = await import("@/app/api/manage/funds-requests/route");
      const res = await GET(new NextRequest("https://test.local/api/manage/funds-requests?range=30D"));
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.kpis.deposits30d).toEqual({ count: 1, amount: "1000.00" });
      expect(j.kpis.withdrawals30d).toEqual({ count: 1, amount: "200.00" });
      expect(j.kpis.rejectedAllTime).toBe(0);
      expect(j.kpis.pendingWithdrawals).toEqual({ count: 1, amount: "40.00" });   // still listed as work
      const usd = j.kpisByCurrency.find((r: { currency: string }) => r.currency === "USD");
      expect(usd.deposits30d).toEqual({ count: 1, amount: "1000.00" });
      expect(usd.pendingWithdrawals).toEqual({ count: 1, amount: "40.00" });
      expect(JSON.stringify(j.cards)).not.toContain("50000");
      expect(j.rows.length).toBe(6);   // the request list still shows every request, the hedge account's too
    });

    it(`the summary report's net deposits and new clients leave the hedge account out (hedge by ${hedgeBy})`, async () => {
      if (!dbReachable) return;
      await fixture(hedgeBy);
      const { GET } = await import("@/app/api/manage/reports/summary/route");
      const res = await GET(new Request("https://test.local/api/manage/reports/summary"));
      expect(res.status).toBe(200);
      const j = await res.json();
      expect(j.netDeposits).toBe(800);
      expect(j.newClients).toBe(1);
    });
  }

  it("the client and financial reports list no hedge account", async () => {
    if (!dbReachable) return;
    const fx = await fixture("coverageAccountId");
    const hedgeNo = (await prisma.account.findUniqueOrThrow({ where: { id: fx.hedge }, select: { accountNumber: true } })).accountNumber;
    const clientNo = (await prisma.account.findUniqueOrThrow({ where: { id: fx.client }, select: { accountNumber: true } })).accountNumber;
    for (const route of ["client", "financial"]) {
      const { GET } = await import(`@/app/api/manage/reports/${route}/route`);
      const res = await GET(new Request(`https://test.local/api/manage/reports/${route}`));
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain(clientNo);
      expect(body).not.toContain(hedgeNo);
    }
  });
});
