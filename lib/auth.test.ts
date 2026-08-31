import crypto from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  shouldForceAdminTwoFactorSetup,
  createSessionToken,
  verifySessionToken,
  revokeAdminSession,
  listAdminSessions,
  revokeAdminSessionById,
  revokeAllAdminSessions,
} from "@/lib/auth";
import { getRedis } from "@/lib/redis";

// A random id per test run, not a fixed "test-admin-N" string --
// revokeAdminSession (by design, see its own comment) doesn't clean up
// the sessionId/metadata/index entries a session leaves behind, only the
// main session key, so a fixed id would accumulate stale-but-not-yet-
// expired index entries across repeated test runs against the same
// Redis and make listAdminSessions's counts flaky (caught for real: a
// hardcoded id here produced a 3rd phantom session on the second run).
function testAdminId(): string {
  return `vitest-admin-${crypto.randomUUID()}`;
}

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

// Phase 1 trust pack §2 -- the actual replacement of a self-verifying
// JWT with a Redis-backed opaque session (docs/authentication.md §2's
// same rewrite, now applied to AdminUser). These need a real Redis --
// skip cleanly rather than fail the suite when one isn't reachable, same
// convention lib/margin.test.ts's Neon-gated test uses for a live DB.
// This ran for real against a local Redis before this commit.
describe("admin session lifecycle (Redis-backed)", () => {
  async function redisReachable(): Promise<boolean> {
    try {
      await getRedis().ping();
      return true;
    } catch {
      return false;
    }
  }

  it("a freshly created session verifies, and revoking it makes verification fail", async () => {
    if (!(await redisReachable())) {
      console.warn("skipping: Redis not reachable");
      return;
    }

    const adminId = testAdminId();
    const token = await createSessionToken({ adminId, role: "MANAGER", brokerId: "test-broker-1" }, false, {
      userAgent: "vitest",
      ip: "127.0.0.1",
    });

    const session = await verifySessionToken(token);
    expect(session?.adminId).toBe(adminId);
    expect(session?.role).toBe("MANAGER");
    expect(session?.sessionId).toBeTruthy();

    await revokeAdminSession(token);
    expect(await verifySessionToken(token)).toBeNull();
  });

  it("an old-format (non-Redis) token never verifies -- the JWT-to-opaque migration path", async () => {
    if (!(await redisReachable())) {
      console.warn("skipping: Redis not reachable");
      return;
    }
    // A real JWT from the previous scheme (or literally anything that
    // isn't a token this app itself issued) has no matching Redis key --
    // verifySessionToken can only ever return null for it, which is
    // exactly "old JWT cookies are rejected, log in once" from the brief.
    const fakeOldJwt = "eyJhbGciOiJIUzI1NiJ9.eyJhZG1pbklkIjoieCJ9.fake-signature-not-a-real-session";
    expect(await verifySessionToken(fakeOldJwt)).toBeNull();
  });

  it("listAdminSessions lists every live session and marks the current one, revokeAdminSessionById removes exactly one", async () => {
    if (!(await redisReachable())) {
      console.warn("skipping: Redis not reachable");
      return;
    }

    const adminId = testAdminId();
    const tokenA = await createSessionToken({ adminId, role: "BROKER_ADMIN", brokerId: "test-broker-1" }, false, {
      userAgent: "device-A",
      ip: "1.1.1.1",
    });
    const tokenB = await createSessionToken({ adminId, role: "BROKER_ADMIN", brokerId: "test-broker-1" }, false, {
      userAgent: "device-B",
      ip: "2.2.2.2",
    });
    const sessionA = await verifySessionToken(tokenA);
    const sessionB = await verifySessionToken(tokenB);

    const listed = await listAdminSessions(adminId, sessionA!.sessionId);
    expect(listed).toHaveLength(2);
    expect(listed.find((s) => s.sessionId === sessionA!.sessionId)?.current).toBe(true);
    expect(listed.find((s) => s.sessionId === sessionB!.sessionId)?.current).toBe(false);

    const revoked = await revokeAdminSessionById(adminId, sessionB!.sessionId!);
    expect(revoked).toBe(true);
    expect(await verifySessionToken(tokenB)).toBeNull();
    expect(await verifySessionToken(tokenA)).not.toBeNull(); // sessionA untouched

    // Cleanup -- don't leave test data in a shared Redis.
    await revokeAdminSession(tokenA);
  });

  it("revokeAdminSessionById refuses to revoke a different admin's session", async () => {
    if (!(await redisReachable())) {
      console.warn("skipping: Redis not reachable");
      return;
    }

    const token = await createSessionToken({ adminId: testAdminId(), role: "MANAGER", brokerId: "test-broker-1" }, false, {
      userAgent: "device",
      ip: "3.3.3.3",
    });
    const session = await verifySessionToken(token);

    const revokedByWrongAdmin = await revokeAdminSessionById("someone-else", session!.sessionId!);
    expect(revokedByWrongAdmin).toBe(false);
    expect(await verifySessionToken(token)).not.toBeNull(); // untouched

    await revokeAdminSession(token); // cleanup
  });

  it("revokeAllAdminSessions -- disabling an admin closes every one of their sessions at once", async () => {
    if (!(await redisReachable())) {
      console.warn("skipping: Redis not reachable");
      return;
    }

    const adminId = testAdminId();
    const tokenA = await createSessionToken({ adminId, role: "MANAGER", brokerId: "test-broker-1" }, false, { userAgent: "A", ip: "1.1.1.1" });
    const tokenB = await createSessionToken({ adminId, role: "MANAGER", brokerId: "test-broker-1" }, false, { userAgent: "B", ip: "2.2.2.2" });

    const revokedCount = await revokeAllAdminSessions(adminId);
    expect(revokedCount).toBe(2);
    expect(await verifySessionToken(tokenA)).toBeNull();
    expect(await verifySessionToken(tokenB)).toBeNull();
    expect(await listAdminSessions(adminId, undefined)).toHaveLength(0);
  });
});
