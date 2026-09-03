import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { validateKycDecision, applyKycDecision } from "@/lib/kyc-decision";

// Phase 1 §4 (docs/ROADMAP.md's "KYC decision").

describe("validateKycDecision (pure)", () => {
  it("REJECT requires a non-empty rejectionReason", () => {
    expect(validateKycDecision({ action: "REJECT", rejectionReason: "" })).toMatch(/rejectionReason is required/);
    expect(validateKycDecision({ action: "REJECT", rejectionReason: "   " })).toMatch(/rejectionReason is required/);
  });

  it("REJECT with a real reason is valid", () => {
    expect(validateKycDecision({ action: "REJECT", rejectionReason: "document expired" })).toBeNull();
  });

  it("APPROVE never needs a reason", () => {
    expect(validateKycDecision({ action: "APPROVE", rejectionReason: "" })).toBeNull();
  });
});

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    dbReachable = false;
    console.warn("lib/kyc-decision.test.ts: DB unreachable, skipping");
  }
});

class RollbackSignal extends Error {}
async function withRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  try {
    await prisma.$transaction(async (tx) => {
      await fn(tx);
      throw new RollbackSignal();
    });
  } catch (err) {
    if (!(err instanceof RollbackSignal)) throw err;
  }
}

async function createFixture(tx: Prisma.TransactionClient) {
  const suffix = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await tx.broker.create({ data: { name: `KYC Decision Test ${suffix}`, subdomain: `kdtest-${suffix}` } });
  const admin = await tx.adminUser.create({ data: { brokerId: broker.id, email: `kd-admin-${suffix}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const account = await tx.account.create({
    data: {
      brokerId: broker.id,
      accountNumber: `3${suffix.slice(0, 7)}`,
      email: `kd-client-${suffix}@test.local`,
      passwordHash: "x",
      fullName: "KYC Decision Test",
      accountMode: "LIVE",
    },
  });
  const kyc = await tx.kycRecord.create({
    data: { accountId: account.id, status: "PENDING", documentType: "passport", documentFrontUrl: "https://example.test/front.jpg" },
  });
  return { brokerId: broker.id, accountId: account.id, adminId: admin.id, kycRecordId: kyc.id };
}

afterAll(async () => {
  await prisma.$disconnect();
});

describe("applyKycDecision (live DB, rolled back)", () => {
  it("APPROVE sets status APPROVED, stamps the reviewer, and writes a KYC_APPROVAL audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const result = await applyKycDecision(tx, { kycRecordId: fx.kycRecordId, brokerId: fx.brokerId, action: "APPROVE", rejectionReason: "", adminId: fx.adminId });

      expect(result.status).toBe("APPROVED");
      const record = await tx.kycRecord.findUniqueOrThrow({ where: { id: fx.kycRecordId } });
      expect(record.status).toBe("APPROVED");
      expect(record.reviewedByAdminId).toBe(fx.adminId);
      expect(record.reviewedAt).not.toBeNull();
      expect(record.rejectionReason).toBeNull();

      const audit = await tx.auditLog.findFirst({ where: { entityId: fx.kycRecordId, action: "KYC_APPROVAL" } });
      expect(audit).not.toBeNull();
    });
  });

  it("REJECT sets status REJECTED, stores the reason, and writes a KYC_REJECTION audit row", async () => {
    if (!dbReachable) return;
    await withRollback(async (tx) => {
      const fx = await createFixture(tx);
      const result = await applyKycDecision(tx, { kycRecordId: fx.kycRecordId, brokerId: fx.brokerId, action: "REJECT", rejectionReason: "document illegible", adminId: fx.adminId });

      expect(result.status).toBe("REJECTED");
      const record = await tx.kycRecord.findUniqueOrThrow({ where: { id: fx.kycRecordId } });
      expect(record.status).toBe("REJECTED");
      expect(record.rejectionReason).toBe("document illegible");

      const audit = await tx.auditLog.findFirst({ where: { entityId: fx.kycRecordId, action: "KYC_REJECTION" } });
      expect(audit).not.toBeNull();
      expect((audit!.newValue as { rejectionReason: string }).rejectionReason).toBe("document illegible");
    });
  });
});
