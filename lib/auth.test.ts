import { describe, expect, it } from "vitest";
import { shouldForceAdminTwoFactorSetup } from "@/lib/auth";

// Phase 1 trust pack item 1, revised by Phase 2 batch 4 (owner decision
// 2026-09-26): staff 2FA is MANDATORY at every broker, so the web manage
// shell forces setup for any admin without 2FA -- Broker.requireAdmin2fa no
// longer decides it.

describe("shouldForceAdminTwoFactorSetup", () => {
  it("forces setup for an admin without 2FA", () => {
    expect(shouldForceAdminTwoFactorSetup({ twoFactorEnabled: false })).toBe(true);
  });

  it("does not force setup once the admin has 2FA enabled", () => {
    expect(shouldForceAdminTwoFactorSetup({ twoFactorEnabled: true })).toBe(false);
  });

  it("never forces setup for a failed admin lookup", () => {
    expect(shouldForceAdminTwoFactorSetup(null)).toBe(false);
  });
});
