import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// The reset gap (security review 2026-11-05): a forgot-password reset changed the portal password only, so the old
// password still opened every trading account that shared it, and open WebTrader sessions carried on.
vi.mock("@/lib/client-auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/client-auth")>()),
  consumePasswordResetToken: vi.fn(),
  revokeAllClientSessions: vi.fn().mockResolvedValue(0),
  getClientSession: vi.fn(),
}));
vi.mock("@/lib/account-auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/account-auth")>()), revokeAllAccountSessions: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));

const OLD = "Old-password-1", NEW = "New-password-2", OWN = "Own-trading-3";
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("client-password.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Pw ${s}`, subdomain: `pw-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
});
beforeEach(() => vi.clearAllMocks());
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function fixture() {
  const n = ++seq;
  const hash = await bcrypt.hash(OLD, 4);
  const client = await prisma.client.create({ data: { brokerId, email: `pw-${n}-${s}@t.local`, passwordHash: hash, fullName: "Pw", emailVerifiedAt: new Date() } });
  const account = (passwordHash: string, i: number) => prisma.account.create({ data: { brokerId, clientId: client.id, accountNumber: `8${Date.now() % 1_000_000}${n}${i}`, email: client.email, passwordHash, fullName: "Pw", accountMode: "LIVE", groupId, leverage: 100, balance: 0 } });
  const shared = await account(hash, 1);
  const separate = await account(await bcrypt.hash(OWN, 4), 2);
  return { client, shared, separate };
}
const hashOf = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).passwordHash;
async function reset(clientId: string) {
  const { consumePasswordResetToken } = await import("@/lib/client-auth");
  vi.mocked(consumePasswordResetToken).mockResolvedValue(clientId);
  const { POST } = await import("@/app/api/portal/reset-password/route");
  return POST(new NextRequest("https://t.local/api/portal/reset-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "t", password: NEW }) }));
}

describe("forgot-password reset", () => {
  it("the old password no longer opens the shared account, and the new one does", async () => {
    if (!dbReachable) return;
    const { client, shared } = await fixture();
    expect((await reset(client.id)).status).toBe(200);
    const hash = await hashOf(shared.id);
    expect(await bcrypt.compare(OLD, hash)).toBe(false);
    expect(await bcrypt.compare(NEW, hash)).toBe(true);
  });
  it("an account with its own separate password keeps it", async () => {
    if (!dbReachable) return;
    const { client, separate } = await fixture();
    await reset(client.id);
    expect(await bcrypt.compare(OWN, await hashOf(separate.id))).toBe(true);
  });
  it("ends the client's sessions and those of every own account, WebTrader included", async () => {
    if (!dbReachable) return;
    const { client, shared, separate } = await fixture();
    await reset(client.id);
    const { revokeAllClientSessions } = await import("@/lib/client-auth");
    const { revokeAllAccountSessions } = await import("@/lib/account-auth");
    expect(vi.mocked(revokeAllClientSessions).mock.calls).toEqual([[client.id, undefined]]);
    expect(vi.mocked(revokeAllAccountSessions).mock.calls.map((c) => c[0]).sort()).toEqual([shared.id, separate.id].sort());
  });
  it("leaves an audit row without any secret, and still proves an unverified e-mail", async () => {
    if (!dbReachable) return;
    const { client } = await fixture();
    await prisma.client.update({ where: { id: client.id }, data: { emailVerifiedAt: null } });
    await reset(client.id);
    const row = await prisma.auditLog.findFirstOrThrow({ where: { clientId: client.id, action: "CLIENT_PASSWORD_RESET" } });
    expect(row.newValue).toEqual({ via: "reset-link", accountsMoved: 1, accountsKeptOwnPassword: 1 });
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).emailVerifiedAt).not.toBeNull();
  });
  it("another client's accounts are untouched", async () => {
    if (!dbReachable) return;
    const a = await fixture();
    const b = await fixture();
    await reset(a.client.id);
    expect(await bcrypt.compare(OLD, await hashOf(b.shared.id))).toBe(true);
  });
});

describe("portal Change password", () => {
  it("moves the shared account too, ends the other sessions and keeps the one that made the change", async () => {
    if (!dbReachable) return;
    const { client, shared } = await fixture();
    const { getClientSession, revokeAllClientSessions } = await import("@/lib/client-auth");
    vi.mocked(getClientSession).mockResolvedValue({ clientId: client.id, brokerId, sessionId: "this-one" });
    const { POST } = await import("@/app/api/portal/change-password/route");
    const res = await POST(new NextRequest("https://t.local/api/portal/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: OLD, newPassword: NEW }) }));
    expect(res.status).toBe(200);
    expect(await bcrypt.compare(OLD, await hashOf(shared.id))).toBe(false);
    expect(vi.mocked(revokeAllClientSessions).mock.calls).toEqual([[client.id, "this-one"]]);
  });
});
