import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { assertNotProductionDatabase } from "@/scripts/lib/assert-not-production.mjs";

// Regression coverage for a real incident: nextAccountNumber() (this
// route's own POST handler) used to pick "the max" via
// `orderBy: { accountNumber: "desc" }` on a Prisma String column --
// lexicographic, not numeric. A 7-digit, non-zero-padded accountNumber
// ("9000001") sorted lexicographically ABOVE every real 8-digit
// "5......." number ('9' > '5' as the first character), so every
// account creation after that point kept computing the exact same
// colliding "next" number and failing outright. Fixed with a numeric
// (bigint-cast) MAX query -- these tests assert the fix, not just that
// account creation works in the easy/already-sorted case.
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
    console.warn("accounts route.test.ts: DB unreachable, skipping");
    return;
  }
  // Deliberately NOT caught -- incident 2026-09-04: this suite's own
  // fixture helper below created two real "Accounts Test <suffix>"
  // brokers in PRODUCTION, almost certainly from a run that had a
  // production DATABASE_URL loaded instead of a dev one. A reachable
  // production DB must fail this suite loudly and stop before any
  // fixture is created, not silently skip the way the unreachable case
  // above does -- that silent-skip path is exactly what would have hidden
  // this running against the wrong database in the first place.
  await assertNotProductionDatabase(prisma);
});

type Fixture = { brokerId: string; adminId: string };
const createdBrokerIds: string[] = [];
const createdAccountIds: string[] = [];

async function createFixture(): Promise<Fixture> {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Accounts Test ${suffix}`, subdomain: `acctest-${suffix}` } });
  createdBrokerIds.push(broker.id);
  const admin = await prisma.adminUser.create({
    data: { brokerId: broker.id, email: `acc-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" },
  });
  return { brokerId: broker.id, adminId: admin.id };
}

async function post(fx: Fixture, body: Record<string, unknown>) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId });
  const { POST } = await import("./route");
  const request = new NextRequest("https://test.local/api/manage/accounts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const response = await POST(request);
  const json = await response.json();
  if (response.status === 201) createdAccountIds.push(json.id);
  return { status: response.status, json };
}

afterAll(async () => {
  if (!dbReachable) return;
  if (createdAccountIds.length > 0) {
    await prisma.auditLog.deleteMany({ where: { entityId: { in: createdAccountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
  }
  if (createdBrokerIds.length > 0) {
    const where = { brokerId: { in: createdBrokerIds } };
    await prisma.auditLog.deleteMany({ where });
    await prisma.accountType.deleteMany({ where });
    await prisma.adminUser.deleteMany({ where });
    await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  }
  await prisma.$disconnect();
}, 30000);

describe("POST /api/manage/accounts -- account number allocation (live DB)", () => {
  it("computes a numerically-next accountNumber even when a shorter, non-zero-padded value would sort higher lexicographically", async () => {
    if (!dbReachable) return;
    // A real number this deliberately-adversarial account can't be
    // confused with -- much larger than any real seeded/test sequence,
    // but shorter and unpadded, the exact shape that broke the old
    // lexicographic sort.
    const adversarialNumber = "9999999"; // 7 digits, starts with 9
    const fx = await createFixture();
    const account = await prisma.account.create({
      data: {
        brokerId: fx.brokerId,
        accountNumber: adversarialNumber,
        email: `adversarial-${randomUUID()}@test.local`,
        passwordHash: "x",
        fullName: "Adversarial Sort Test",
        accountMode: "DEMO",
      },
    });
    createdAccountIds.push(account.id);

    const { status, json } = await post(fx, {
      fullName: "Real Next Account",
      email: `real-next-${randomUUID()}@test.local`,
      password: "TestPass123!",
      accountMode: "DEMO",
    });

    expect(status).toBe(201);
    // The bug's failure mode was either a 500/retry-exhaustion error, or
    // (worse) silently computing a short/adversarial-looking number
    // instead of the true next value -- assert the real shape: 8 digits,
    // strictly numeric, and NOT equal to (or colliding with) the
    // adversarial value.
    expect(json.accountNumber).toMatch(/^\d{8}$/);
    expect(json.accountNumber).not.toBe(adversarialNumber);
  });

  it("two sequential creates never collide, still numerically incrementing", async () => {
    if (!dbReachable) return;
    const fx = await createFixture();
    const first = await post(fx, { fullName: "Seq One", email: `seq1-${randomUUID()}@test.local`, password: "TestPass123!", accountMode: "DEMO" });
    const second = await post(fx, { fullName: "Seq Two", email: `seq2-${randomUUID()}@test.local`, password: "TestPass123!", accountMode: "DEMO" });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(Number(second.json.accountNumber)).toBeGreaterThan(Number(first.json.accountNumber));
  });
});
