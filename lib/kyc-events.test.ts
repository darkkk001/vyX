import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { notifyKycDecision } from "./kyc-events";

const published = vi.hoisted(() => [] as string[]);
vi.mock("@/lib/room/events", () => ({
  publishRoomChanged: async (_b: string, ids: string[]) => { published.push(...ids); },
}));

const broker = "kycevt0";
const account = (id: string, clientId: string, accountNumber: string, accountMode: "LIVE" | "DEMO", status: "ACTIVE" | "CLOSED" = "ACTIVE") => ({
  id, brokerId: broker, clientId, accountNumber, accountMode, status, email: `${id}@test.local`, fullName: id, passwordHash: "x", groupId: "kycevtg",
});

async function clean() {
  await prisma.notification.deleteMany({ where: { brokerId: broker } });
  await prisma.account.deleteMany({ where: { brokerId: broker } });
  await prisma.client.deleteMany({ where: { brokerId: broker } });
  await prisma.group.deleteMany({ where: { brokerId: broker } });
  await prisma.broker.deleteMany({ where: { id: broker } });
}

beforeAll(async () => {
  await clean();
  await prisma.broker.create({ data: { id: broker, name: "KYC Events", subdomain: "kycevt" } });
  await prisma.group.create({ data: { id: "kycevtg", brokerId: broker, name: "Standard" } });
  for (const id of ["cl-many", "cl-none"]) {
    await prisma.client.create({ data: { id, brokerId: broker, email: `${id}@test.local`, passwordHash: "x", fullName: id } });
  }
  await prisma.account.create({ data: account("a-closed", "cl-many", "92000001", "LIVE", "CLOSED") });
  await prisma.account.create({ data: account("a-demo", "cl-many", "92000002", "DEMO") });
  await prisma.account.create({ data: account("a-live", "cl-many", "92000003", "LIVE") });
});
afterAll(clean);
beforeEach(async () => {
  published.length = 0;
  await prisma.notification.deleteMany({ where: { brokerId: broker } });
});

describe("notifyKycDecision", () => {
  const rows = () => prisma.notification.findMany({ where: { brokerId: broker } });

  it("puts a client-level decision on the open LIVE account, once, then fires the room event", async () => {
    await notifyKycDecision({ brokerId: broker, clientId: "cl-many", entityType: "ClientKycRecord", entityId: "k1", action: "APPROVE", rejectionReason: "" });
    const r = await rows();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ accountId: "a-live", type: "KYC_APPROVED", title: "Your KYC was approved", body: "Your KYC was approved", entityType: "ClientKycRecord", entityId: "k1" });
    expect(published).toEqual(["a-live"]);
  });

  it("tells the client why on a rejection", async () => {
    await notifyKycDecision({ brokerId: broker, accountId: "a-demo", entityType: "KycRecord", entityId: "k2", action: "REJECT", rejectionReason: "Document expired" });
    expect((await rows())[0]).toMatchObject({ accountId: "a-demo", type: "KYC_REJECTED", body: "Your KYC was rejected: Document expired" });
  });

  it("writes nothing for a client with no account", async () => {
    await notifyKycDecision({ brokerId: broker, clientId: "cl-none", entityType: "ClientKycRecord", entityId: "k3", action: "APPROVE", rejectionReason: "" });
    expect(await rows()).toHaveLength(0);
    expect(published).toEqual([]);
  });

  it("never fails the caller", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(notifyKycDecision({ brokerId: broker, accountId: "no-such-account", entityType: "KycRecord", entityId: "k4", action: "APPROVE", rejectionReason: "" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
