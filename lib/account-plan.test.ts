import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Account plan (owner 2026-10-23): the client sees Group.displayName as accountPlan ("Standard" by default); the
// group's own name ("Dealing", "Reverse"...) and its id never reach a client route.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/client-auth", () => ({ getClientSession: vi.fn() }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: string | number) => new Prisma.Decimal(v);
const SECRET_NAME = `Dealing-Secret-${randomUUID().slice(0, 6)}`;
let ready = false;
const brokers: string[] = [];
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "displayName" FROM "Group" LIMIT 1`;
    ready = true;
  } catch {
    console.warn("lib/account-plan.test.ts: DB (with Group.displayName) unreachable, skipping");
  }
});
afterAll(async () => {
  if (ready && brokers.length) {
    const where = { brokerId: { in: brokers } };
    for (const m of ["rejectedOrder", "deal", "transaction", "auditLog", "position", "order", "account", "client", "brokerSymbol", "group"] as const) {
      await (prisma[m] as unknown as { deleteMany: (a: unknown) => Promise<unknown> }).deleteMany({ where }).catch(() => {});
    }
    await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
  }
  await prisma.livePrice.deleteMany({ where: { symbol: { startsWith: "AP" } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { startsWith: "AP" } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

async function fixture(displayName?: string) {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `AP ${s}`, subdomain: `ap-${s}` } });
  brokers.push(broker.id);
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: SECRET_NAME, ...(displayName ? { displayName } : {}), dealingMode: "AUTO", isClientSelectable: true, category: "B_BOOK" } as never });
  const client = await prisma.client.create({ data: { brokerId: broker.id, email: `ap-${s}@test.local`, passwordHash: "x", fullName: "AP" } });
  const account = await prisma.account.create({ data: { brokerId: broker.id, groupId: group.id, clientId: client.id, accountNumber: `4${s.slice(0, 7)}`, email: `ap-${s}@test.local`, passwordHash: "x", fullName: "AP", accountMode: "LIVE", balance: D(1000) } });
  const { getAccountSession } = await import("@/lib/account-auth");
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: account.id, brokerId: broker.id });
  const { getClientSession } = await import("@/lib/client-auth");
  vi.mocked(getClientSession).mockResolvedValue({ clientId: client.id, brokerId: broker.id } as never);
  return { broker, group, account };
}
const text = async (r: Response) => JSON.stringify(await r.json());

describe("account plan, never the group (live DB)", () => {
  it("/api/trade/me: accountPlan = the group's display name; no groupName, no group id, no group name anywhere", async () => {
    if (!ready) return;
    const { group } = await fixture("Pro");
    const { GET } = await import("@/app/api/trade/me/route");
    const body = await (await GET()).json();
    expect(body.accountPlan).toBe("Pro");
    expect(body).not.toHaveProperty("groupName");
    expect(body).not.toHaveProperty("groupId");
    expect(JSON.stringify(body)).not.toContain(SECRET_NAME);
    expect(JSON.stringify(body)).not.toContain(group.id);
    // what the terminal reads is still there
    expect(body).toMatchObject({ marginCallLevel: expect.any(String), stopOutLevel: expect.any(String), tradingState: "open", tradingRestriction: "BOTH" });
  });

  it("a group created without one reads \"Standard\"", async () => {
    if (!ready) return;
    const { group } = await fixture();
    expect((await prisma.group.findUniqueOrThrow({ where: { id: group.id } })).displayName).toBe("Standard");
    const { GET } = await import("@/app/api/trade/me/route");
    expect((await (await GET()).json()).accountPlan).toBe("Standard");
  });

  it("portal group list: accountPlan instead of name; the group name never appears", async () => {
    if (!ready) return;
    await fixture("Pro");
    const { GET } = await import("@/app/api/portal/groups/route");
    const res = await GET(new Request("https://t.local/api/portal/groups?mode=LIVE"));
    const list = (await res.json()) as Record<string, unknown>[];
    expect(list.length).toBe(1);
    expect(list[0].accountPlan).toBe("Pro");
    expect(list[0]).not.toHaveProperty("name");
    expect(JSON.stringify(list)).not.toContain(SECRET_NAME);
  });

  it("history, positions, orders, deals and summary never carry the group's name or id", async () => {
    if (!ready) return;
    const { group } = await fixture("Pro");
    const routes: Array<[string, () => Promise<Response>]> = [
      ["positions", async () => (await import("@/app/api/trade/positions/route")).GET()],
      ["history", async () => (await import("@/app/api/trade/history/route")).GET(new NextRequest("https://t.local/api/trade/history"))],
      ["history closes", async () => (await import("@/app/api/trade/history/route")).GET(new NextRequest("https://t.local/api/trade/history?closes=1"))],
      ["orders", async () => (await import("@/app/api/trade/orders/route")).GET(new NextRequest("https://t.local/api/trade/orders?status=all"))],
      ["deals", async () => (await import("@/app/api/trade/deals/route")).GET(new NextRequest("https://t.local/api/trade/deals"))],
    ];
    for (const [label, call] of routes) {
      const t = await text(await call());
      expect(t, label).not.toContain(SECRET_NAME);
      expect(t, label).not.toContain(group.id);
    }
  });
});
