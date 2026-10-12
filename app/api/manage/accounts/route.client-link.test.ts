import { NextRequest } from "next/server";
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";

// Owner 2026-10-05: the backoffice offers "Resend verification e-mail" on an account's client-portal login, so
// GET /api/manage/accounts, /live-account-requests and /client-kyc-requests expose the client id and whether
// its e-mail is verified (additive fields; docs/contracts/staff-resend-verification.md).
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; } });
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.liveAccountRequest.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.clientKycRecord.deleteMany({ where: { client: { brokerId: { in: brokers } } } });
  await prisma.account.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.group.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

async function asAdmin(brokerId: string, adminId: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role: "BROKER_ADMIN", brokerId } as never);
}

describe("client link fields for the staff resend action", () => {
  it("accounts list: client {id, email, emailVerified} for a portal-linked account, null otherwise", async () => {
    if (!dbReachable) return;
    const s = randomUUID().slice(0, 8);
    const broker = await prisma.broker.create({ data: { name: `CL ${s}`, subdomain: `cl-${s}` } });
    brokers.push(broker.id);
    const admin = await prisma.adminUser.create({ data: { brokerId: broker.id, email: `cl-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    const unverified = await prisma.client.create({ data: { brokerId: broker.id, email: `u-${s}@t.local`, passwordHash: "x", fullName: "U" } });
    const verified = await prisma.client.create({ data: { brokerId: broker.id, email: `v-${s}@t.local`, passwordHash: "x", fullName: "V", emailVerifiedAt: new Date() } });
    const group = await prisma.group.create({ data: { brokerId: broker.id, name: `CL ${s}` } });
    const base = { brokerId: broker.id, groupId: group.id, passwordHash: "x", fullName: "A", balance: 0, accountMode: "DEMO" as const };
    const a1 = await prisma.account.create({ data: { ...base, accountNumber: `91${s.replace(/\D/g, "1").slice(0, 6)}1`, email: unverified.email, clientId: unverified.id } });
    const a2 = await prisma.account.create({ data: { ...base, accountNumber: `91${s.replace(/\D/g, "1").slice(0, 6)}2`, email: verified.email, clientId: verified.id } });
    const a3 = await prisma.account.create({ data: { ...base, accountNumber: `91${s.replace(/\D/g, "1").slice(0, 6)}3`, email: `none-${s}@t.local` } });
    await asAdmin(broker.id, admin.id);
    const { GET } = await import("./route");
    const rows = (await (await GET(new NextRequest("https://t.local/api/manage/accounts"))).json()) as Array<{ id: string; client: unknown }>;
    const byId = new Map(rows.map((r) => [r.id, r.client]));
    expect(byId.get(a1.id)).toEqual({ id: unverified.id, email: unverified.email, emailVerified: false });
    expect(byId.get(a2.id)).toEqual({ id: verified.id, email: verified.email, emailVerified: true });
    expect(byId.get(a3.id)).toBeNull();

    // live-account requests + client KYC records carry clientId + clientEmailVerified
    await prisma.liveAccountRequest.create({ data: { brokerId: broker.id, clientId: unverified.id } as never });
    await prisma.clientKycRecord.create({ data: { clientId: verified.id, documentType: "passport", documentFrontUrl: "data:," } as never });
    const lar = await (await (await import("@/app/api/manage/live-account-requests/route")).GET()).json();
    const larRows = (Array.isArray(lar) ? lar : lar.rows ?? lar.requests ?? []) as Array<{ clientId: string; clientEmailVerified: boolean }>;
    expect(larRows.find((r) => r.clientId === unverified.id)?.clientEmailVerified).toBe(false);
    const kyc = await (await (await import("@/app/api/manage/client-kyc-requests/route")).GET()).json();
    const kycRows = (Array.isArray(kyc) ? kyc : kyc.rows ?? kyc.records ?? []) as Array<{ clientId: string; clientEmailVerified: boolean }>;
    expect(kycRows.find((r) => r.clientId === verified.id)?.clientEmailVerified).toBe(true);
  });
});
