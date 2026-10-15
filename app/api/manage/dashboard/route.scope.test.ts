import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Dashboard scope toggle (owner 2026-10-15): ?scope=live|demo|all. Default (no parameter) is live and keeps today's
// output; account counts follow the scope; new clients are always live + demo with the split; money stays live-only
// under live and demo and covers live + demo only under all.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
let brokerId = "";
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable || !brokerId) return;
  const where = { brokerId };
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.broker.update({ where: { id: brokerId }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.kycRecord.deleteMany({ where: { account: where } }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.delete({ where: { id: brokerId } }).catch(() => {});
}, 30000);

async function get(scope?: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: "x", role: "BROKER_ADMIN", brokerId } as never);
  const { GET } = await import("./route");
  const r = await GET(new Request(`https://t.local/api/manage/dashboard${scope === undefined ? "" : `?scope=${scope}`}`));
  expect(r.status).toBe(200);
  return r.json();
}
type Ccy = { currency: string; deposits30d: { amount: string }; pendingWithdrawals: { amount: string } };
const usd = (j: { clients: { byCurrency: Ccy[] } }) => j.clients.byCurrency.find((c) => c.currency === "USD")!;

describe("Dashboard scope", () => {
  it("default equals live; demo and all change counts; money stays live-only unless all", async () => {
    if (!dbReachable) return;
    const s = randomUUID().replace(/-/g, "").slice(0, 10);
    const broker = await prisma.broker.create({ data: { name: `DSC ${s}`, subdomain: `dsc-${s}`, dealingModeAt: null } });
    brokerId = broker.id;
    const group = await prisma.group.create({ data: { brokerId, name: `C-${s}`, dealingMode: "AUTO" } });
    const mk = (n: string, mode: "LIVE" | "DEMO", extra: object = {}) =>
      prisma.account.create({
        data: { brokerId, groupId: group.id, accountNumber: `6${s.slice(0, 6)}${n}`, email: `dsc-${n}-${s}@t.local`, passwordHash: "x", fullName: `DSC ${n}`, accountMode: mode, balance: D("1000"), ...extra },
      });
    const live1 = await mk("1", "LIVE");
    const live2 = await mk("2", "LIVE");
    const demo1 = await mk("3", "DEMO");
    const internal = await mk("4", "LIVE", { isInternal: true });
    const tx = (accountId: string, type: "DEPOSIT" | "WITHDRAWAL", status: "COMPLETED" | "PENDING", amount: string) =>
      prisma.transaction.create({ data: { brokerId, accountId, type, status, amount: D(amount), balanceBefore: D("0"), balanceAfter: D("0"), note: "scope test" } });
    await tx(live1.id, "DEPOSIT", "COMPLETED", "100");
    await tx(demo1.id, "DEPOSIT", "COMPLETED", "40");
    await tx(live1.id, "WITHDRAWAL", "PENDING", "-20");
    await tx(demo1.id, "WITHDRAWAL", "PENDING", "-5");
    await tx(internal.id, "DEPOSIT", "COMPLETED", "999");
    void live2;

    const def = await get();
    const live = await get("live");
    expect(def).toEqual(live);                     // default is exactly the live output
    expect(def.scope).toBe("live");
    expect((await get("bogus")).scope).toBe("live");

    // account counts follow the scope (client accounts: no internal account)
    const demo = await get("demo");
    const all = await get("all");
    expect([live.clients.total, demo.clients.total, all.clients.total]).toEqual([2, 1, 3]);
    expect([live.scope, demo.scope, all.scope]).toEqual(["live", "demo", "all"]);

    // new clients: every registered client whatever the scope, with the split
    for (const j of [live, demo, all]) expect(j.newClients).toEqual({ total: 3, live: 2, demo: 1 });

    // money: live-only under live and demo; live + demo under all
    expect(usd(live).deposits30d.amount).toBe("100.00");
    expect(usd(demo).deposits30d.amount).toBe("100.00");
    expect(usd(all).deposits30d.amount).toBe("140.00");
    expect(usd(live).pendingWithdrawals.amount).toBe("20.00");
    expect(usd(demo).pendingWithdrawals.amount).toBe("20.00");
    expect(usd(all).pendingWithdrawals.amount).toBe("25.00");
    expect([live.depositsSum30d, demo.depositsSum30d, all.depositsSum30d]).toEqual([100, 100, 140]);
    expect([live.netDeposits7d, demo.netDeposits7d, all.netDeposits7d]).toEqual([100, 100, 140]);
  });
});
