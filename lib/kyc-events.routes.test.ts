import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// A real KYC decision through both staff routes: the decision commits exactly as before, the client gets one
// notification, and a failed notification never touches the decision.
const flags = vi.hoisted(() => ({ failNotify: false, adminId: "kycrt-admin", brokerId: "kycrt0" }));
vi.mock("@/lib/auth", () => ({ getAdminSession: async () => ({ adminId: flags.adminId, brokerId: flags.brokerId, role: "BROKER_ADMIN" }) }));
vi.mock("@/lib/permissions", () => ({ forbidUnlessBrokerAdminOrPermission: async () => false }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: async () => {} }));
vi.mock("@/lib/notifications", async (original) => {
  const real = await original<typeof import("@/lib/notifications")>();
  return { ...real, createNotification: (...a: Parameters<typeof real.createNotification>) => (flags.failNotify ? Promise.reject(new Error("boom")) : real.createNotification(...a)) };
});

const broker = flags.brokerId;
const call = async (path: "kyc-requests" | "client-kyc-requests", id: string, body: unknown) => {
  const { PATCH } = path === "kyc-requests" ? await import("@/app/api/manage/kyc-requests/[id]/route") : await import("@/app/api/manage/client-kyc-requests/[id]/route");
  const req = new NextRequest(`https://t.local/api/manage/${path}/${id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } });
  return PATCH(req, { params: Promise.resolve({ id }) });
};

async function clean() {
  await prisma.auditLog.deleteMany({ where: { brokerId: broker } });
  await prisma.notification.deleteMany({ where: { brokerId: broker } });
  await prisma.kycRecord.deleteMany({ where: { account: { brokerId: broker } } });
  await prisma.clientKycRecord.deleteMany({ where: { client: { brokerId: broker } } });
  await prisma.account.deleteMany({ where: { brokerId: broker } });
  await prisma.client.deleteMany({ where: { brokerId: broker } });
  await prisma.group.deleteMany({ where: { brokerId: broker } });
  await prisma.adminUser.deleteMany({ where: { id: flags.adminId } });
  await prisma.broker.deleteMany({ where: { id: broker } });
}

beforeAll(async () => {
  await clean();
  await prisma.broker.create({ data: { id: broker, name: "KYC Routes", subdomain: "kycrt" } });
  await prisma.adminUser.create({ data: { id: flags.adminId, brokerId: broker, email: "kycrt@test.local", passwordHash: "x", role: "BROKER_ADMIN" } });
  await prisma.group.create({ data: { id: "kycrtg", brokerId: broker, name: "Standard" } });
  await prisma.client.create({ data: { id: "kycrt-c", brokerId: broker, email: "kycrt-c@test.local", passwordHash: "x", fullName: "C" } });
  await prisma.account.create({ data: { id: "kycrt-a", brokerId: broker, clientId: "kycrt-c", accountNumber: "93000001", accountMode: "LIVE", email: "a@test.local", fullName: "A", passwordHash: "x", groupId: "kycrtg" } });
});
afterAll(clean);
beforeEach(async () => {
  flags.failNotify = false;
  await prisma.notification.deleteMany({ where: { brokerId: broker } });
  await prisma.kycRecord.deleteMany({ where: { accountId: "kycrt-a" } });
  await prisma.clientKycRecord.deleteMany({ where: { clientId: "kycrt-c" } });
  await prisma.kycRecord.create({ data: { id: "kycrt-k", accountId: "kycrt-a", documentType: "passport", documentFrontUrl: "x" } });
  await prisma.clientKycRecord.create({ data: { id: "kycrt-ck", clientId: "kycrt-c", documentType: "passport", documentFrontUrl: "x" } });
});

describe("KYC decision routes notify the client", () => {
  const rows = () => prisma.notification.findMany({ where: { brokerId: broker } });

  it("account-level approval: decided, one row on that account", async () => {
    const res = await call("kyc-requests", "kycrt-k", { action: "APPROVE" });
    expect(res.status).toBe(200);
    expect((await prisma.kycRecord.findUnique({ where: { id: "kycrt-k" } }))?.status).toBe("APPROVED");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ accountId: "kycrt-a", type: "KYC_APPROVED" });
  });

  it("client-level rejection: decided, the reason reaches the client", async () => {
    const res = await call("client-kyc-requests", "kycrt-ck", { action: "REJECT", rejectionReason: "Document expired" });
    expect(res.status).toBe(200);
    expect((await prisma.clientKycRecord.findUnique({ where: { id: "kycrt-ck" } }))?.status).toBe("REJECTED");
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ accountId: "kycrt-a", type: "KYC_REJECTED", body: "Your KYC was rejected: Document expired" });
  });

  it("a refused request writes no notification", async () => {
    const res = await call("client-kyc-requests", "kycrt-ck", { action: "REJECT", rejectionReason: "" });
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("a failed notification leaves the decision committed", async () => {
    flags.failNotify = true;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("client-kyc-requests", "kycrt-ck", { action: "APPROVE" });
    spy.mockRestore();
    expect(res.status).toBe(200);
    expect((await prisma.clientKycRecord.findUnique({ where: { id: "kycrt-ck" } }))?.status).toBe("APPROVED");
    expect(await rows()).toHaveLength(0);
  });
});
