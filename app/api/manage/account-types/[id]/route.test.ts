import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("account-types [id] route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; adminId: string };
const createdBrokerIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Account Type Id Test ${suffix}`, subdomain: `attest2-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `at2-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  return { brokerId: broker.id, adminId: admin.id };
}

async function patch(fx: Fixture, id: string, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { PATCH } = await import("./route");
  const request = new NextRequest(`https://test.local/api/manage/account-types/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await PATCH(request, { params: Promise.resolve({ id }) });
  return { status: response.status, json: await response.json() };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.account.deleteMany({ where });
    await prisma.accountType.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.$disconnect();
}, 30000);

describe("PATCH /api/manage/account-types/[id] (live DB)", () => {
  it("updates name/description/pricingHint/sortOrder", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const type = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });

    const { status, json } = await patch(fx, type.id, { name: "Standard v2", description: "desc", pricingHint: "hint", sortOrder: 5, isDefault: true });
    expect(status).toBe(200);
    expect(json.name).toBe("Standard v2");
    expect(json.description).toBe("desc");
    expect(json.sortOrder).toBe(5);
  });

  it("setting isDefault: true un-sets whichever other type was the default", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const standard = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });
    const pro = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Pro", isDefault: false } });

    await patch(fx, pro.id, { name: "Pro", isDefault: true });

    const refreshedStandard = await prisma.accountType.findUniqueOrThrow({ where: { id: standard.id } });
    expect(refreshedStandard.isDefault).toBe(false);
  });

  it("rejects unsetting the ONLY default -- a broker always needs exactly one", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const onlyDefault = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });

    const { status, json } = await patch(fx, onlyDefault.id, { name: "Standard", isDefault: false });
    expect(status).toBe(400);
    expect(json.error).toMatch(/default/);

    const stillDefault = await prisma.accountType.findUniqueOrThrow({ where: { id: onlyDefault.id } });
    expect(stillDefault.isDefault).toBe(true);
  });

  it("unsetting default IS allowed once another type is already the default", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const standard = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });
    await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Pro", isDefault: false } });
    // Make Pro the default first (frees Standard to be un-defaulted).
    const pro = await prisma.accountType.findFirstOrThrow({ where: { brokerId: fx.brokerId, name: "Pro" } });
    await patch(fx, pro.id, { name: "Pro", isDefault: true });

    const { status } = await patch(fx, standard.id, { name: "Standard", isDefault: false });
    expect(status).toBe(200);
  });

  it("enabled can always be toggled, even for a type an existing account references", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const type = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });
    await prisma.account.create({
      data: {
        brokerId: fx.brokerId,
        accountNumber: `8${randomUUID().replace(/-/g, "").slice(0, 7)}`,
        email: `at-client-${randomUUID()}@test.local`,
        passwordHash: "x",
        fullName: "Account Type Test Client",
        accountMode: "DEMO",
        accountTypeId: type.id,
      },
    });

    const { status, json } = await patch(fx, type.id, { name: "Standard", isDefault: true, enabled: false });
    expect(status).toBe(200);
    expect(json.enabled).toBe(false);

    // The referencing account's accountTypeId is untouched -- disabling
    // only hides it from new assignment, never breaks an existing one.
    const account = await prisma.account.findFirstOrThrow({ where: { brokerId: fx.brokerId } });
    expect(account.accountTypeId).toBe(type.id);
  });

  it("404 for an id belonging to a different broker", async () => {
    if (!dbReachable) return;
    const fxA = await createFixture();
    const fxB = await createFixture();
    const typeOnA = await prisma.accountType.create({ data: { brokerId: fxA.brokerId, name: "Standard", isDefault: true } });

    const { status } = await patch(fxB, typeOnA.id, { name: "Hijacked" });
    expect(status).toBe(404);
  });

  it("duplicate name within the same broker returns 409", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Standard", isDefault: true } });
    const pro = await prisma.accountType.create({ data: { brokerId: fx.brokerId, name: "Pro" } });

    const { status } = await patch(fx, pro.id, { name: "Standard" });
    expect(status).toBe(409);
  });
});
