import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// 2FA around money leaving (owner 2026-11-05): a client with 2FA on needs the code to add a payout method; a broker may
// require 2FA for withdrawing at all. Off by default: 2FA stays the client's own choice.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/totp", async (importActual) => ({ ...(await importActual<typeof import("@/lib/totp")>()), verifyTotp: (_s: string, c: string) => c === "123456" }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("two-factor-money.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Tf ${s}`, subdomain: `tf-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  await prisma.paymentMethod.create({ data: { brokerId, type: "BANK_TRANSFER", enabled: true } });
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(twoFactor: boolean) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `tf-${n}-${s}@t.local`, passwordHash: "x", fullName: "Tf", twoFactorEnabled: twoFactor, twoFactorSecret: twoFactor ? "SECRET" : null } });
  const account = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `9${Date.now() % 1_000_000}${n}`, email: c.email, passwordHash: "x", fullName: "Tf", accountMode: "LIVE", groupId, leverage: 100, balance: 100 } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId } } } as never);
  return { c, account };
}
const post = (url: string, body: unknown) => new NextRequest(`https://t.local${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const WALLET = { type: "BANK_TRANSFER", bank: "Test Bank", account: "PK36SCBL0000001123456702" };
async function addMethod(extra: object = {}) {
  const { POST } = await import("@/app/api/room/payout-methods/route");
  const r = await POST(post("/api/room/payout-methods", { ...WALLET, ...extra }));
  return { status: r.status, body: await r.json() };
}
async function withdraw(accountId: string, extra: object = {}) {
  const { POST } = await import("@/app/api/room/withdraw/route");
  const r = await POST(post("/api/room/withdraw", { key: randomUUID(), accountId, amount: "10", ...extra }));
  return { status: r.status, body: await r.json() };
}

describe("adding a payout method", () => {
  it("with 2FA on: no code and a wrong code add nothing, the right code adds it", async () => {
    if (!dbReachable) return;
    const { c } = await client(true);
    expect((await addMethod()).body.code).toBe("TWO_FACTOR_REQUIRED");
    expect((await addMethod({ code: "000000" })).body.code).toBe("TWO_FACTOR_INVALID");
    expect(await prisma.clientPayoutMethod.count({ where: { clientId: c.id } })).toBe(0);
    expect((await addMethod({ code: "123 456" })).status).toBe(201);
    expect(await prisma.clientPayoutMethod.count({ where: { clientId: c.id } })).toBe(1);
  });
  it("with 2FA off nothing changes", async () => {
    if (!dbReachable) return;
    await client(false);
    expect((await addMethod()).status).toBe(201);
  });
});

describe("require 2FA for withdrawals (per broker)", () => {
  const setBroker = (requireWithdrawal2fa: boolean) => prisma.broker.update({ where: { id: brokerId }, data: { requireWithdrawal2fa } });
  it("is off by default: a client without 2FA is not stopped by it", async () => {
    if (!dbReachable) return;
    const { account } = await client(false);
    expect((await withdraw(account.id)).body.code).toBeUndefined();
  });
  it("on: a client without 2FA is refused with the reason, and nothing is booked", async () => {
    if (!dbReachable) return;
    await setBroker(true);
    const { account } = await client(false);
    expect(await withdraw(account.id)).toEqual({ status: 403, body: { error: "Your broker requires 2FA for withdrawals. Turn it on in Profile.", code: "TWO_FACTOR_SETUP_REQUIRED" } });
    expect(await prisma.transaction.count({ where: { accountId: account.id } })).toBe(0);
    await setBroker(false);
  });
  it("on: a client with 2FA goes on to the usual code step", async () => {
    if (!dbReachable) return;
    await setBroker(true);
    const { account } = await client(true);
    expect((await withdraw(account.id)).body.code).toBe("TWO_FACTOR_REQUIRED");
    expect((await withdraw(account.id, { code: "123456" })).body.code).toBeUndefined();
    await setBroker(false);
  });
});
