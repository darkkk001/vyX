import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Same "no injectable tx client, real fixtures + own cleanup" shape as
// app/api/manage/dealing-queue/[id]/route.test.ts -- this route reads
// its session via next/headers, which only works inside a real Next.js
// request lifecycle.
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
    console.warn("account-types route.test.ts: DB unreachable, skipping");
  }
});

type Fixture = { brokerId: string; adminId: string };
const createdBrokerIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Account Type Test ${suffix}`, subdomain: `attest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `at-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  return { brokerId: broker.id, adminId: admin.id };
}

async function get(fx: Fixture) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { GET } = await import("./route");
  const response = await GET();
  return { status: response.status, json: await response.json() };
}

async function post(fx: Fixture, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/manage/account-types", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
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

describe("GET/POST /api/manage/account-types (live DB)", () => {
  it("forbidden without a MANAGER or BROKER_ADMIN session", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue(null);
    const { GET } = await import("./route");
    const response = await GET();
    expect(response.status).toBe(403);
  });

  it("POST creates a type; GET returns it for that broker only", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const { status, json } = await post(fx, { name: "Standard", description: "Balanced", pricingHint: "Spread-only", sortOrder: 0, isDefault: true });
    expect(status).toBe(201);
    expect(json.name).toBe("Standard");
    expect(json.isDefault).toBe(true);
    expect(json.enabled).toBe(true);

    const { json: list } = await get(fx);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Standard");
  });

  it("a second POST with isDefault: true un-sets the previous default -- never two at once", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await post(fx, { name: "Standard", isDefault: true });
    await post(fx, { name: "Pro", isDefault: true });

    const { json: list } = await get(fx);
    const defaults = list.filter((t: { isDefault: boolean }) => t.isDefault);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].name).toBe("Pro");
  });

  it("POST with a duplicate name for the same broker returns 409, not a 500", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    await post(fx, { name: "Standard" });
    const { status, json } = await post(fx, { name: "Standard" });
    expect(status).toBe(409);
    expect(json.error).toMatch(/already exists/);
  });

  it("POST with no name is rejected", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const { status } = await post(fx, {});
    expect(status).toBe(400);
  });
});
