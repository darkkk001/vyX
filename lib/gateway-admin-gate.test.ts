import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

// Mandatory staff 2FA (Phase 2 batch 4): the gateway's admin event stream admits a broker staff session only while the
// admin is ACTIVE with 2FA enrolled -- same gate as the web API (lib/auth.ts getAdminSession).
const GW = path.resolve(import.meta.dirname, "..", "services", "api-gateway", "src");
describe("gateway admin stream gate", () => {
  it("getAdminSession checks adminMayStream for broker staff", () => {
    const auth = readFileSync(path.join(GW, "admin-auth.ts"), "utf8");
    expect(auth).toContain("if (session.brokerId && !(await adminMayStream(session.adminId))) return null;");
  });
  it("adminMayStream requires ACTIVE and twoFactorEnabled", () => {
    const db = readFileSync(path.join(GW, "db.ts"), "utf8");
    expect(db).toMatch(/row\.status === "ACTIVE" && row\.tfa === true/);
  });
});
