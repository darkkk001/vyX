import { describe, expect, it } from "vitest";
import { generateBackupCodes, hashBackupCode, verifyBackupCode, generateTotpSecret, verifyTotp } from "@/lib/totp";

// Phase 1 trust pack item 1 -- backup codes are new (neither trader nor
// Super Admin 2FA had them before this), so these pin down the exact
// properties the rest of the feature (app/api/admin/two-factor/confirm's
// issuance, lib/totp.ts's verifyAdminTwoFactorCode's consumption) relies
// on: 6 codes, unique, hash correctly, and match regardless of the
// formatting a human might retype them with.

describe("generateBackupCodes", () => {
  it("generates 6 codes by default, each in XXXX-XXXX shape", () => {
    const codes = generateBackupCodes();
    expect(codes).toHaveLength(6);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("never produces visually-ambiguous characters (0/O, 1/I/L)", () => {
    const codes = generateBackupCodes(50);
    const joined = codes.join("");
    expect(joined).not.toMatch(/[01ILO]/);
  });

  it("generates the requested count and all-unique codes", () => {
    const codes = generateBackupCodes(20);
    expect(codes).toHaveLength(20);
    expect(new Set(codes).size).toBe(20);
  });
});

describe("verifyTotp rejects an obviously wrong code (unchanged by this section, but never directly tested before)", () => {
  it("rejects a code that doesn't match the secret", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "000000")).toBe(false);
  });

  it("rejects malformed input (not 6 digits) without throwing", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
  });
});

describe("hashBackupCode / verifyBackupCode", () => {
  it("verifies the exact code that was hashed", async () => {
    const code = generateBackupCodes(1)[0];
    const hash = await hashBackupCode(code);
    expect(await verifyBackupCode(code, hash)).toBe(true);
  });

  it("rejects a wrong code", async () => {
    const hash = await hashBackupCode("ABCD-EFGH");
    expect(await verifyBackupCode("WXYZ-2345", hash)).toBe(false);
  });

  it("matches regardless of case or the cosmetic dash (a human retyping it from a printout)", async () => {
    const hash = await hashBackupCode("ABCD-EFGH");
    expect(await verifyBackupCode("abcdefgh", hash)).toBe(true);
    expect(await verifyBackupCode("abcd-efgh", hash)).toBe(true);
    expect(await verifyBackupCode("ABCDEFGH", hash)).toBe(true);
  });
});
