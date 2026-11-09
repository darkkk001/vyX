import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Owner 2026-11-10, against a real database:
// - Deposit: after a request, the same client sends no other deposit with the same method for 5 minutes (server-side,
//   also for parallel sends); the confirmation card's state follows the broker's approve / reject, and the decision
//   publishes the room event the page listens on (~1 s live path).
// - Demo top-up: instant, demo only (a live account is refused on the server), never above 100,000, once per form key.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let bankId = "";
let usdtId = "";
let adminId = "";
let seq = 0;
const key = () => randomUUID().replace(/-/g, "");
const tail = () => Array.from({ length: 4 }, () => "ABCDEFGHJKMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 31)]).join("");

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("deposit-live-topup.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Dl ${s}`, subdomain: `dl-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  bankId = (await prisma.paymentMethod.create({ data: { brokerId, type: "BANK_TRANSFER", enabled: true } })).id;
  usdtId = (await prisma.paymentMethod.create({ data: { brokerId, type: "USDT_TRC20", enabled: true } })).id;
  adminId = (await prisma.adminUser.create({ data: { brokerId, email: `dl-admin-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role: "BROKER_ADMIN", brokerId } as never);
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(mode: "LIVE" | "DEMO" = "LIVE", balance = 0) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `dl-${n}-${s}@t.local`, passwordHash: "x", fullName: "Dl Test" } });
  const a = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `5${Date.now() % 1_000_000}${n}`, email: c.email, passwordHash: "x", fullName: "Dl Test", accountMode: mode, groupId, leverage: 100, balance } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId } } } as never);
  return { c, a };
}
const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function deposit(a: { id: string; accountNumber: string }, amount: string, methodId = bankId) {
  const { POST } = await import("@/app/api/room/deposit/route");
  const r = await POST(req("/api/room/deposit", "POST", { key: key(), accountId: a.id, methodId, amount, reference: `DEP-${a.accountNumber}-${tail()}` }));
  return { status: r.status, body: await r.json() };
}
async function view(id?: string) {
  const { GET } = await import("@/app/api/room/deposit/route");
  const r = await GET(req(`/api/room/deposit${id ? `?id=${id}` : ""}`, "GET"));
  return { status: r.status, body: await r.json() };
}
async function decide(id: string, action: "APPROVE" | "REJECT", note?: string) {
  const { PATCH } = await import("@/app/api/manage/funds-requests/[id]/route");
  const r = await PATCH(req(`/api/manage/funds-requests/${id}`, "PATCH", { action, ...(note ? { note } : {}) }), { params: Promise.resolve({ id }) });
  return { status: r.status, body: await r.json() };
}
async function topUp(accountId: string, amount: string, k = key()) {
  const { POST } = await import("@/app/api/room/accounts/[id]/top-up/route");
  const r = await POST(req(`/api/room/accounts/${accountId}/top-up`, "POST", { key: k, amount }), { params: Promise.resolve({ id: accountId }) });
  return { status: r.status, body: await r.json() };
}
const deposits = (accountId: string) => prisma.transaction.count({ where: { accountId, type: "DEPOSIT" } });
const balanceOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance.toFixed(2);

describe("deposit: 5 minutes per method (server)", () => {
  it("a second deposit with the same method within 5 minutes is refused with the time left; another method is not", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    expect((await deposit(a, "500")).status).toBe(201);
    const second = await deposit(a, "250");
    expect(second.status).toBe(429);
    expect(second.body.code).toBe("DEPOSIT_COOLDOWN");
    expect(second.body.error).toMatch(/^Next request with this method in [45]:\d\d\.$/);
    expect(new Date(second.body.until).getTime() - Date.now()).toBeGreaterThan(290_000);
    expect((await deposit(a, "250", usdtId)).status).toBe(201);
    expect(await deposits(a.id)).toBe(2);
    // the page gets the same countdown
    expect(Object.keys((await view()).body.cooldowns).sort()).toEqual([bankId, usdtId].sort());
  });
  it("parallel deposits with different amounts and the same method: exactly one is created", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const got = await Promise.all(["100", "200", "300", "400"].map((x) => deposit(a, x)));
    expect(await deposits(a.id)).toBe(1);
    expect(got.filter((g) => g.status === 201)).toHaveLength(1);
    expect(got.filter((g) => g.status === 429)).toHaveLength(3);
  });
  it("after 5 minutes the method is free again", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const first = await deposit(a, "500");
    await prisma.transaction.update({ where: { id: first.body.id }, data: { createdAt: new Date(Date.now() - 301_000) } });
    expect((await deposit(a, "250")).status).toBe(201);
  });
});

describe("deposit confirmation follows the broker's decision live", () => {
  it("waiting, then approved: the room event goes out and the card shows the amount and the new balance", async () => {
    if (!dbReachable) return;
    const { a } = await client("LIVE", 100);
    const sent = await deposit(a, "500");
    expect((await view(sent.body.id)).body).toMatchObject({ id: sent.body.id, state: "PENDING", amount: "500.00", balance: null });
    // back on the page while still pending: the card comes back
    expect((await view()).body.pending).toMatchObject({ id: sent.body.id, state: "PENDING" });
    const { publishTradingEvent } = await import("@/lib/nats");
    vi.mocked(publishTradingEvent).mockClear();
    expect((await decide(sent.body.id, "APPROVE")).status).toBe(200);
    // the Room's socket hears this for the account (RoomData -> room:changed -> the page re-reads the request)
    expect(vi.mocked(publishTradingEvent).mock.calls.some(([t, p]) => t === "RoomChanged" && (p as unknown as { account_id: string }).account_id === a.id)).toBe(true);
    expect((await view(sent.body.id)).body).toMatchObject({ state: "APPROVED", amount: "500.00", balance: "600.00", reason: null });
    expect((await view()).body.pending).toBeNull();
  });
  it("rejected: the card shows the broker's reason", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const sent = await deposit(a, "500");
    const { publishTradingEvent } = await import("@/lib/nats");
    vi.mocked(publishTradingEvent).mockClear();
    expect((await decide(sent.body.id, "REJECT", "Payment not received")).status).toBe(200);
    expect(vi.mocked(publishTradingEvent).mock.calls.some(([t, p]) => t === "RoomChanged" && (p as unknown as { account_id: string }).account_id === a.id)).toBe(true);
    expect((await view(sent.body.id)).body).toMatchObject({ state: "REJECTED", reason: "Payment not received", balance: null });
  });
  it("another client's request is not visible", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const sent = await deposit(a, "500");
    await client();
    expect((await view(sent.body.id)).status).toBe(404);
  });
});

describe("demo top-up", () => {
  it("instant on a demo account: balance up, one completed row, no approval", async () => {
    if (!dbReachable) return;
    const { a } = await client("DEMO", 10_000);
    const r = await topUp(a.id, "5000");
    expect(r).toMatchObject({ status: 201, body: { balance: "15000.00", amount: "5000.00" } });
    expect(await balanceOf(a.id)).toBe("15000.00");
    expect(await prisma.transaction.count({ where: { accountId: a.id, type: "ADJUSTMENT", status: "COMPLETED", note: "Demo top-up" } })).toBe(1);
  });
  it("a live account is refused on the server and nothing moves", async () => {
    if (!dbReachable) return;
    const { a } = await client("LIVE", 100);
    expect(await topUp(a.id, "5000")).toEqual({ status: 403, body: { error: "Top up is for demo accounts only." } });
    expect(await balanceOf(a.id)).toBe("100.00");
    expect(await prisma.transaction.count({ where: { accountId: a.id } })).toBe(0);
  });
  it("never above 100,000: over the cap is refused, up to it is fine, then nothing more", async () => {
    if (!dbReachable) return;
    const { a } = await client("DEMO", 95_000);
    expect((await topUp(a.id, "10000")).status).toBe(400);
    expect(await balanceOf(a.id)).toBe("95000.00");
    expect((await topUp(a.id, "5000")).body.balance).toBe("100000.00");
    expect((await topUp(a.id, "0.01")).status).toBe(400);
  });
  it("parallel top-ups racing at the cap: the balance never passes 100,000", async () => {
    if (!dbReachable) return;
    const { a } = await client("DEMO", 90_000);
    const got = await Promise.all(Array.from({ length: 4 }, () => topUp(a.id, "5000")));
    expect(got.filter((g) => g.status === 201)).toHaveLength(2);
    expect(await balanceOf(a.id)).toBe("100000.00");
  });
  it("a double click (same key) tops up once", async () => {
    if (!dbReachable) return;
    const { a } = await client("DEMO", 10_000);
    const k = key();
    const got = await Promise.all([topUp(a.id, "1000", k), topUp(a.id, "1000", k), topUp(a.id, "1000", k)]);
    expect(await balanceOf(a.id)).toBe("11000.00");
    expect(new Set(got.map((g) => g.body.id)).size).toBe(1);
  });
});
