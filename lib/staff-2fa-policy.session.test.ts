import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// The real getAdminSession / manage login against the per-broker staff 2FA policy (Broker.requireAdmin2fa). Only the request
// plumbing (cookies, headers, redirect) is faked; the session lives in the local Redis, the rows in the scratch database.
const hdr = { token: "", brokerId: "", path: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (n: string) => (n === "vyx_admin_session" || n.length > 0 ? { value: hdr.token } : undefined) }),
  headers: async () => new Headers({ "x-broker-id": hdr.brokerId, "x-pathname": hdr.path }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => { await prisma.$disconnect(); });

async function staff(required: boolean, twoFactorEnabled: boolean) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Sess ${sfx}`, subdomain: `sess-${sfx}`, requireAdmin2fa: required } });
  const a = await prisma.adminUser.create({
    data: { brokerId: b.id, email: `m-${sfx}@test.local`, passwordHash: await bcrypt.hash("Passw0rd!", 4), role: "MANAGER", twoFactorEnabled, twoFactorSecret: twoFactorEnabled ? "S" : null },
  });
  return { b, a };
}
async function session(a: { id: string; brokerId: string | null; role: "MANAGER" | "SUPER_ADMIN" | "BROKER_ADMIN" | "SUPPORT" }, path: string) {
  const { createSessionToken } = await import("@/lib/auth");
  hdr.token = await createSessionToken({ adminId: a.id, role: a.role, brokerId: a.brokerId });
  hdr.brokerId = a.brokerId ?? "";
  hdr.path = path;
}

describe("getAdminSession", () => {
  it("Required broker, no 2FA: enrolment-only (other API paths are redirected to the 403 route)", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const { a } = await staff(true, false);
    await session(a, "/api/admin/two-factor/setup");
    expect((await getAdminSession())?.twoFactorSetupRequired).toBe(true);
    await session(a, "/api/manage/accounts");
    await expect(getAdminSession()).rejects.toThrow(/REDIRECT:\/api\/manage\/two-factor-required/);
  });
  it("Optional broker, no 2FA: a full session, never forced to enrol", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const { a } = await staff(false, false);
    await session(a, "/api/manage/accounts");
    const s = await getAdminSession();
    expect(s?.adminId).toBe(a.id);
    expect(s?.twoFactorSetupRequired).toBeUndefined();
  });
  it("Optional broker, 2FA enrolled: still a normal session", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const { a } = await staff(false, true);
    await session(a, "/api/manage/accounts");
    expect((await getAdminSession())?.adminId).toBe(a.id);
  });
  it("Super Admin without 2FA keeps today's rule (enrolment endpoints only), whatever any broker says", async () => {
    if (!dbReachable) return;
    const { getAdminSession } = await import("@/lib/auth");
    const sa = await prisma.adminUser.create({ data: { brokerId: null, email: `sa-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "SUPER_ADMIN" } });
    await session({ id: sa.id, brokerId: null, role: "SUPER_ADMIN" }, "/api/admin/brokers");
    expect(await getAdminSession()).toBeNull();
  });
});

describe("shouldForceAdminTwoFactorSetup / staffTwoFactorRequired", () => {
  it("fails closed: only an explicit false makes it Optional", async () => {
    const { shouldForceAdminTwoFactorSetup, staffTwoFactorRequired } = await import("@/lib/auth");
    expect(staffTwoFactorRequired({ requireAdmin2fa: false })).toBe(false);
    expect(staffTwoFactorRequired({ requireAdmin2fa: true })).toBe(true);
    expect(staffTwoFactorRequired(null)).toBe(true);
    expect(shouldForceAdminTwoFactorSetup({ twoFactorEnabled: false }, { requireAdmin2fa: false })).toBe(false);
    expect(shouldForceAdminTwoFactorSetup({ twoFactorEnabled: false }, { requireAdmin2fa: true })).toBe(true);
    expect(shouldForceAdminTwoFactorSetup({ twoFactorEnabled: true }, { requireAdmin2fa: true })).toBe(false);
  });
});

describe("POST /api/manage/login", () => {
  const login = async (brokerId: string, subdomain: string, email: string) => {
    const { POST } = await import("@/app/api/manage/login/route");
    const res = await POST(
      new NextRequest("https://t.local/api/manage/login", {
        method: "POST",
        headers: { "content-type": "application/json", "x-broker-id": brokerId, "x-broker-slug": subdomain },
        body: JSON.stringify({ email, password: "Passw0rd!" }),
      }),
    );
    return { json: await res.json(), cookie: res.headers.get("set-cookie") };
  };
  it("Required: enrolment-only session; Optional: full session; enrolled: the code challenge either way", async () => {
    if (!dbReachable) return;
    const req = await staff(true, false);
    const opt = await staff(false, false);
    const optEnrolled = await staff(false, true);
    const r = await login(req.b.id, req.b.subdomain, req.a.email);
    expect(r.json.twoFactorSetupRequired).toBe(true);
    expect(r.json.code).toBe("TWO_FACTOR_SETUP_REQUIRED");
    expect(r.cookie).toBeTruthy();
    const o = await login(opt.b.id, opt.b.subdomain, opt.a.email);
    expect(o.json.twoFactorSetupRequired).toBe(false);
    expect(o.json.code).toBeUndefined();
    expect(o.cookie).toBeTruthy();
    const e = await login(optEnrolled.b.id, optEnrolled.b.subdomain, optEnrolled.a.email);
    expect(e.json.requiresTwoFactor).toBe(true);
    expect(e.cookie).toBeNull();
  });
});
