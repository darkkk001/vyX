import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// CRM security batch (owner 2026-11-13): "kisi aur client ki ID daal ke data na mile". Client A1 is signed in; every
// request names something that belongs to client A2 (same broker) or B1 (another broker). Each one must come back
// refused or empty, and nothing of theirs may change. Real database; the session and the rate limits are stubbed.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/client-auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/client-auth")>()), getClientSession: vi.fn() }));
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }),
  isLockedOut: vi.fn().mockResolvedValue(false), recordFailure: vi.fn().mockResolvedValue(1), clearFailures: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
type Who = { brokerId: string; clientId: string; live: string; demo: string; deposit: string; ticket: string; payout: string; kyc: string };
const W: Record<"a1" | "a2" | "b1", Who> = {} as never;
let n = 0;

async function broker(tag: string) {
  const b = await prisma.broker.create({ data: { name: `Id ${tag} ${s}`, subdomain: `id${tag}-${s}`, crmEnabled: true } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: "g", displayName: "Standard", leverage: 100, isClientSelectable: true, isDefault: true, category: "B_BOOK" } });
  return { brokerId: b.id, groupId: g.id };
}
async function who(brokerId: string, groupId: string): Promise<Who> {
  const k = ++n;
  const c = await prisma.client.create({ data: { brokerId, email: `id-${k}-${s}@t.local`, passwordHash: "x", fullName: `Id ${k}` } });
  const acc = (mode: "LIVE" | "DEMO", i: number) => prisma.account.create({ data: { brokerId, clientId: c.id, groupId, accountNumber: `6${Date.now() % 1_000_000}${k}${i}`, email: c.email, passwordHash: "x", fullName: c.fullName, accountMode: mode, leverage: 100, balance: 500 } });
  const live = await acc("LIVE", 1);
  const demo = await acc("DEMO", 2);
  const deposit = await prisma.transaction.create({ data: { brokerId, accountId: live.id, type: "DEPOSIT", status: "PENDING", amount: 100, balanceBefore: 500, balanceAfter: 500 } as never });
  const ticket = await prisma.supportTicket.create({ data: { brokerId, clientId: c.id, subject: `secret subject ${k}` } });
  const payout = await prisma.clientPayoutMethod.create({ data: { brokerId, clientId: c.id, type: "USDT_BEP20", holderName: c.fullName, details: { address: "0xdead" } } as never });
  const kyc = await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "PENDING", documentType: "passport", documentFrontUrl: "https://x.private.blob.vercel-storage.com/kyc/front" } });
  return { brokerId, clientId: c.id, live: live.id, demo: demo.id, deposit: deposit.id, ticket: ticket.id, payout: payout.id, kyc: kyc.id };
}

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("security-idor.test.ts: DB unreachable, skipping"); return; }
  const A = await broker("a");
  const B = await broker("b");
  W.a1 = await who(A.brokerId, A.groupId);
  W.a2 = await who(A.brokerId, A.groupId);
  W.b1 = await who(B.brokerId, B.groupId);
  // signed in as A1 everywhere
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: W.a1.clientId, brokerId: W.a1.brokerId, broker: { id: W.a1.brokerId, name: "Id", subdomain: "ida" } } } as never);
  const { getClientSession } = await import("@/lib/client-auth");
  vi.mocked(getClientSession).mockResolvedValue({ clientId: W.a1.clientId, brokerId: W.a1.brokerId } as never);
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

const req = (url: string, method = "GET", body?: unknown) =>
  new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const p = (id: string) => ({ params: Promise.resolve({ id }) });
const others = () => [W.a2, W.b1];

describe("another client's id gets nothing (signed in as A1)", () => {
  it("account settings and demo top-up", async () => {
    if (!dbReachable) return;
    const { PATCH } = await import("@/app/api/room/accounts/[id]/route");
    const { POST: topUp } = await import("@/app/api/room/accounts/[id]/top-up/route");
    for (const o of others()) {
      expect((await PATCH(req(`/api/room/accounts/${o.live}`, "PATCH", { nickname: "pwned" }), p(o.live))).status).toBe(404);
      expect((await topUp(req(`/api/room/accounts/${o.demo}/top-up`, "POST", { key: randomUUID(), amount: 1000 }), p(o.demo))).status).toBe(404);
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: o.demo } })).balance)).toBe(500);
    }
  });

  it("a deposit request's details", async () => {
    if (!dbReachable) return;
    const { GET } = await import("@/app/api/room/deposit/route");
    for (const o of others()) {
      const r = await GET(req(`/api/room/deposit?id=${o.deposit}`));
      expect(r.status).toBe(404);
    }
  });

  it("transactions history filtered to their account", async () => {
    if (!dbReachable) return;
    const { GET } = await import("@/app/api/room/history/route");
    for (const o of others()) {
      const body = await (await GET(req(`/api/room/history?account=${o.live}`))).json();
      expect(body.rows).toEqual([]);
      expect(JSON.stringify(body)).not.toContain(o.deposit);
    }
  });

  it("support ticket: read and reply", async () => {
    if (!dbReachable) return;
    const { GET, POST } = await import("@/app/api/room/support/[id]/route");
    for (const o of others()) {
      const g = await GET(req(`/api/room/support/${o.ticket}`), p(o.ticket));
      expect(g.status).toBe(404);
      expect(await g.text()).not.toContain("secret subject");
      expect((await POST(req(`/api/room/support/${o.ticket}`, "POST", { body: "hi" }), p(o.ticket))).status).toBe(404);
      expect(await prisma.supportTicketMessage.count({ where: { ticketId: o.ticket } })).toBe(0);
    }
  });

  it("payout method: remove, and withdraw to it", async () => {
    if (!dbReachable) return;
    const { DELETE } = await import("@/app/api/room/payout-methods/route");
    const { POST: withdraw } = await import("@/app/api/room/withdraw/route");
    for (const o of others()) {
      expect((await DELETE(req(`/api/room/payout-methods?id=${o.payout}`, "DELETE"))).status).toBe(404);
      expect((await prisma.clientPayoutMethod.findUniqueOrThrow({ where: { id: o.payout } })).removedAt).toBeNull();
      // their account as the source
      const r = await withdraw(req("/api/room/withdraw", "POST", { key: randomUUID(), accountId: o.live, amount: "10", payoutMethodId: o.payout }));
      expect(r.status).toBe(404);
    }
    expect(await prisma.transaction.count({ where: { accountId: { in: others().map((o) => o.live) }, type: "WITHDRAWAL" } })).toBe(0);
  });

  it("transfer from or into their account", async () => {
    if (!dbReachable) return;
    const { POST } = await import("@/app/api/room/transfer/route");
    for (const o of others()) {
      const from = await POST(req("/api/room/transfer", "POST", { key: randomUUID(), fromId: o.live, toId: W.a1.live, amount: "10" }));
      const into = await POST(req("/api/room/transfer", "POST", { key: randomUUID(), fromId: W.a1.live, toId: o.live, amount: "10" }));
      expect(from.status).toBeGreaterThanOrEqual(400);
      expect(into.status).toBeGreaterThanOrEqual(400);
      expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: o.live } })).balance)).toBe(500);
    }
    expect(Number((await prisma.account.findUniqueOrThrow({ where: { id: W.a1.live } })).balance)).toBe(500);
  });

  it("opening WebTrader on their account", async () => {
    if (!dbReachable) return;
    const { GET } = await import("@/app/api/portal/webtrader-sso/route");
    for (const o of others()) {
      const r = await GET(req(`/api/portal/webtrader-sso?accountId=${o.live}`));
      expect(r.headers.get("location")).toContain("error=invalid_account");
    }
  });

  it("the accounts list shows only A1's own", async () => {
    if (!dbReachable) return;
    const { GET } = await import("@/app/api/portal/accounts/route");
    const text = await (await GET(req("/api/portal/accounts"))).text();
    expect(text).toContain(W.a1.live);
    for (const o of others()) expect(text).not.toContain(o.live);
  });

  it("staff of broker B cannot open broker A's KYC document", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: "x", role: "BROKER_ADMIN", brokerId: W.b1.brokerId } as never);
    const { GET } = await import("@/app/api/manage/client-kyc-requests/[id]/document/route");
    const r = await GET(req(`/api/manage/client-kyc-requests/${W.a2.kyc}/document?side=front`), p(W.a2.kyc));
    expect(r.status).toBe(404);
  });
});
