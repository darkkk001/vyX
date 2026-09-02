import { describe, expect, it } from "vitest";
import { shouldForceAdminTwoFactorSetup } from "@/lib/auth";

// Phase 1 trust pack item 1 -- Broker.requireAdmin2fa's actual
// enforcement logic, extracted out of app/manage/(shell)/layout.tsx so
// this policy (a real security control) is asserted directly rather than
// only ever exercised by clicking through the app.

describe("shouldForceAdminTwoFactorSetup", () => {
  it("forces setup when the broker requires 2FA and the admin doesn't have it", () => {
    expect(shouldForceAdminTwoFactorSetup({ requireAdmin2fa: true }, { twoFactorEnabled: false })).toBe(true);
  });

  it("does not force setup once the admin already has 2FA enabled", () => {
    expect(shouldForceAdminTwoFactorSetup({ requireAdmin2fa: true }, { twoFactorEnabled: true })).toBe(false);
  });

  it("does not force setup when the broker's policy is off", () => {
    expect(shouldForceAdminTwoFactorSetup({ requireAdmin2fa: false }, { twoFactorEnabled: false })).toBe(false);
  });

  it("never forces setup for a null broker (e.g. Super Admin, brokerId null) or a failed admin lookup", () => {
    expect(shouldForceAdminTwoFactorSetup(null, { twoFactorEnabled: false })).toBe(false);
    expect(shouldForceAdminTwoFactorSetup({ requireAdmin2fa: true }, null)).toBe(false);
  });
});
