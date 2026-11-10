import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Deposit and Withdraw method grid: everything comes from the broker's PaymentMethod rows. A listed method that is off is
// shown but gives away no receiving details and cannot be used; a broker's address reaches the client as a plain QR.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn(), requireAdminRole: (x: { role: string } | null, r: string[]) => x !== null && r.includes(x.role) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const ADDRESS = "0xe6e53bd4d1292313d66e849a8370ccf87c6976cf";
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let clientId = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("method-grid.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Mg ${s}`, subdomain: `mg-${s}` } })).id;
  clientId = (await prisma.client.create({ data: { brokerId, email: `mg-${s}@t.local`, passwordHash: "x", fullName: "Mg" } })).id;
  await prisma.paymentMethod.createMany({ data: [
    { brokerId, type: "NETELLER", enabled: false, listed: true, instructions: "secret" },
    { brokerId, type: "BANK_TRANSFER", enabled: false, listed: true, bankDetails: { iban: "PK00" } },
    { brokerId, type: "USDT_BEP20", enabled: true, walletAddress: ADDRESS, minAmount: 50, processingTime: "Same day" },
    { brokerId, type: "BTC", enabled: false, listed: false, walletAddress: "hidden" },
    { brokerId, type: "USDT_TRC20", enabled: false, listed: true, walletAddress: "Tsecret" },
  ] });
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

describe("the grid", () => {
  it("lists open and listed methods in the set order, never an unlisted one", async () => {
    if (!dbReachable) return;
    const { roomMethods } = await import("@/lib/room/funds");
    const m = await roomMethods(brokerId);
    expect(m.map((x) => [x.type, x.available])).toEqual([["USDT_BEP20", true], ["USDT_TRC20", false], ["BANK_TRANSFER", false], ["NETELLER", false]]);
    expect(m[0].label).toBe("Tether (USDT BEP20)");
  });
  it("a greyed method gives away no receiving details", async () => {
    if (!dbReachable) return;
    const { roomMethods } = await import("@/lib/room/funds");
    const off = (await roomMethods(brokerId)).filter((x) => !x.available);
    expect(JSON.stringify(off)).not.toMatch(/Tsecret|PK00|secret/);
    expect(off.every((x) => x.wallet === null && x.qr === null && x.bank === null && x.warning === null)).toBe(true);
  });
  it("the open method carries the broker's address, its QR and the network line", async () => {
    if (!dbReachable) return;
    const { roomMethods } = await import("@/lib/room/funds");
    const m = (await roomMethods(brokerId))[0];
    expect(m.wallet).toBe(ADDRESS);
    expect(m.qr).toMatch(/^data:image\/png;base64,/);
    expect(m.warning).toBe("Send USDT on BNB Smart Chain (BEP20) only. Other networks or tokens will be lost.");
  });
});

describe("what a client can do", () => {
  it("a deposit on a greyed method is refused", async () => {
    if (!dbReachable) return;
    const g = await prisma.group.create({ data: { brokerId, name: `g${s}`, leverage: 100 } });
    const a = await prisma.account.create({ data: { brokerId, clientId, accountNumber: `5${Date.now() % 1_000_000}`, email: `mg-${s}@t.local`, passwordHash: "x", fullName: "Mg", accountMode: "LIVE", groupId: g.id, leverage: 100, balance: 0 } });
    const off = await prisma.paymentMethod.findFirstOrThrow({ where: { brokerId, type: "NETELLER" } });
    const { createFundsRequest } = await import("@/lib/funds-request-create");
    const r = await createFundsRequest({ brokerId, accountId: a.id, type: "DEPOSIT", amount: "100", paymentMethodId: off.id });
    expect(r.ok).toBe(false);
  });
  const addPayout = async (body: object) => {
    const { roomApiSession } = await import("@/lib/room/context");
    vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
    const { POST } = await import("@/app/api/room/payout-methods/route");
    const r = await POST(new NextRequest("https://t.local/api/room/payout-methods", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.json() };
  };
  it("a client saves their own BEP20 address; a bad one and a closed method are refused", async () => {
    if (!dbReachable) return;
    expect((await addPayout({ type: "USDT_BEP20", address: "not-an-address" })).status).toBe(400);
    expect((await addPayout({ type: "USDT_TRC20", address: "TQ5NnXyXyXyXyXyXyXyXyXyXyXyXyXyXyX" })).body.error).toBe("Payouts to this method are not available right now.");
    expect((await addPayout({ type: "USDT_BEP20", address: "0x1111111111111111111111111111111111111111" })).status).toBe(201);
  });
});

describe("withdrawal terms", () => {
  it("a withdrawal uses its own limits, a deposit keeps the deposit limits", async () => {
    if (!dbReachable) return;
    const pm = await prisma.paymentMethod.findFirstOrThrow({ where: { brokerId, type: "USDT_BEP20" } });
    await prisma.paymentMethod.update({ where: { id: pm.id }, data: { minAmount: 50, maxAmount: 200, withdrawMinAmount: 10, withdrawMaxAmount: 1000, withdrawProcessingTime: "Instant-15 min" } });
    const a = await prisma.account.findFirstOrThrow({ where: { brokerId, clientId } });
    await prisma.account.update({ where: { id: a.id }, data: { balance: 5000 } });
    await prisma.clientKycRecord.upsert({ where: { clientId }, update: { status: "APPROVED" }, create: { clientId, status: "APPROVED", documentType: "passport", documentFrontUrl: "f", documentBackUrl: "b", annualIncome: "UNDER_25K", sourceOfFunds: "SALARY", tradingExperience: "NONE", employmentStatus: "EMPLOYED", riskTolerance: "LOW" } });
    const { createFundsRequest } = await import("@/lib/funds-request-create");
    const go = (type: "DEPOSIT" | "WITHDRAWAL", amount: string) => createFundsRequest({ brokerId, accountId: a.id, type, amount, paymentMethodId: pm.id, ...(type === "WITHDRAWAL" ? { destinationAddress: "0x1111111111111111111111111111111111111111" } : {}) });
    expect((await go("DEPOSIT", "300")).ok).toBe(false);
    expect((await go("DEPOSIT", "20")).ok).toBe(false);
    expect((await go("WITHDRAWAL", "300")).ok).toBe(true);
    expect((await go("WITHDRAWAL", "9")).ok).toBe(false);
    expect((await go("WITHDRAWAL", "1001")).ok).toBe(false);
    const { roomMethods } = await import("@/lib/room/funds");
    expect((await roomMethods(brokerId))[0].withdraw).toEqual({ min: "10.00", max: "1000.00", processing: "Instant-15 min" });
    await prisma.paymentMethod.update({ where: { id: pm.id }, data: { minAmount: 50, maxAmount: null, withdrawMinAmount: null, withdrawMaxAmount: null, withdrawProcessingTime: null } });
  });
});

describe("broker settings", () => {
  const patch = async (body: object) => {
    const { getAdminSession } = await import("@/lib/auth");
    const admin = await prisma.adminUser.upsert({ where: { email: `pm-${s}@t.local` }, create: { brokerId, email: `pm-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" }, update: {} });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, brokerId, role: "BROKER_ADMIN" } as never);
    const { PATCH } = await import("@/app/api/manage/payment-methods/route");
    return PATCH(new NextRequest("https://t.local/api/manage/payment-methods", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false, minAmount: "0", maxAmount: null, feePercent: "0", feeFixed: "0", instructions: null, walletAddress: null, ...body }) }));
  };
  it("a new type saves, and an older backoffice that sends no listed flag leaves it alone", async () => {
    if (!dbReachable) return;
    expect((await patch({ type: "JAZZCASH", listed: true })).status).toBe(200);
    expect((await patch({ type: "JAZZCASH" })).status).toBe(200);
    expect((await prisma.paymentMethod.findFirstOrThrow({ where: { brokerId, type: "JAZZCASH" } })).listed).toBe(true);
  });
});
