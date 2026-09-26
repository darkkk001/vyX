import type { AdminRole } from "@prisma/client";
import { randomUUID, createHmac } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";
import { assertNotProductionDatabase } from "@/scripts/lib/assert-not-production.mjs";

// Phase 2 batch 4 (backoffice sign-in and roles) -- the server contract, end to
// end against the scratch DB + a local Redis (REDIS_URL must point at a
// throwaway db, e.g. redis://127.0.0.1:6379/9). Everything real (login route,
// Redis sessions, getAdminSession, 2FA setup/confirm, staff routes) except the
// request context: next/headers is driven by `ctx` below (cookie token +
// x-pathname + x-broker-id, what middleware.ts would set), the build registry
// check always passes, and NATS publishing is a no-op (never reach a real bus).

const ctx = { token: "", path: "", brokerId: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name === "vyx_admin_session" && ctx.token ? { name, value: ctx.token } : undefined),
  }),
  headers: async () => new Headers({ "x-pathname": ctx.path, "x-broker-id": ctx.brokerId }),
}));
vi.mock("@/lib/client-builds", () => ({
  checkClientBuild: async () => ({ ok: true, buildId: null }),
  clientBuildErrorMessage: () => "",
  prefetchClientBuild: () => null,
}));
vi.mock("@/lib/cookie-domain", () => ({ cookieScopeDomain: async () => undefined }));
vi.mock("@/lib/nats", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/nats")>();
  return { ...actual, publishTradingEvent: async () => {} };
});

import {
  createSessionToken,
  getAdminSession,
  listAdminSessions,
  verifySessionToken,
  TWO_FACTOR_SETUP_REQUIRED,
  TWO_FACTOR_SETUP_REQUIRED_PATH,
} from "@/lib/auth";

// ---- RFC 6238 code for a base32 secret (the authenticator app's side) ----
function base32Decode(input: string): Buffer {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of input.toUpperCase().replace(/[^A-Z2-7]/g, "")) {
    value = (value << 5) | A.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}
function totp(secret: string): string {
  const counter = Math.floor(Date.now() / 1000 / 30);
  const buf = Buffer.alloc(8); buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0); buf.writeUInt32BE(counter % 2 ** 32, 4);
  const h = createHmac("sha1", base32Decode(secret)).update(buf).digest();
  const o = h[h.length - 1] & 0x0f;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, "0");
}

let ready = false;
let brokerId = "";
let otherBrokerId = "";
const createdBrokerIds: string[] = [];
const createdAdminIds: string[] = [];
const PASSWORD = "Correct-Horse-9";

async function makeAdmin(role: "BROKER_ADMIN" | "MANAGER" | "SUPPORT" | "SUPER_ADMIN", opts: { twoFactor?: boolean; broker?: string | null; perms?: string[] } = {}) {
  const suffix = randomUUID().slice(0, 8);
  const a = await prisma.adminUser.create({
    data: {
      brokerId: opts.broker === undefined ? brokerId : opts.broker,
      email: `b4-${role.toLowerCase()}-${suffix}@test.local`,
      passwordHash: await bcrypt.hash(PASSWORD, 4),
      role,
      status: "ACTIVE",
      extraPermissions: opts.perms ?? [],
      twoFactorEnabled: !!opts.twoFactor,
      twoFactorSecret: opts.twoFactor ? "JBSWY3DPEHPK3PXP" : null,
    },
  });
  createdAdminIds.push(a.id);
  return a;
}
async function sessionFor(admin: { id: string; role: AdminRole; brokerId: string | null }) {
  return createSessionToken({ adminId: admin.id, role: admin.role, brokerId: admin.brokerId }, false, { userAgent: "vitest", ip: "127.0.0.1" });
}
function as(token: string, path: string, broker: string | null = brokerId) {
  ctx.token = token; ctx.path = path; ctx.brokerId = broker ?? "";
}
function req(url: string, method = "GET", body?: unknown, extraHeaders: Record<string, string> = {}) {
  return new NextRequest(`https://test.local${url}`, {
    method,
    headers: { "content-type": "application/json", "x-broker-id": ctx.brokerId, ...extraHeaders },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}
const P = (id: string) => ({ params: Promise.resolve({ id }) });
async function thrownRedirect(fn: () => Promise<unknown>): Promise<string | null> {
  try { await fn(); return null; } catch (e) { return isRedirectError(e) ? getURLFromRedirectError(e) : `THREW ${String(e)}`; }
}

beforeAll(async () => {
  if (!process.env.REDIS_URL || !/127\.0\.0\.1|localhost/.test(process.env.REDIS_URL)) {
    console.warn("staff-auth-batch4.test.ts: REDIS_URL is not a local Redis, skipping");
    return;
  }
  try { await prisma.$queryRaw`SELECT 1`; await getRedis().ping(); } catch { console.warn("staff-auth-batch4.test.ts: DB or Redis unreachable, skipping"); return; }
  await assertNotProductionDatabase(prisma);
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `B4 Auth ${s}`, subdomain: `b4auth-${s}` } });
  const o = await prisma.broker.create({ data: { name: `B4 Other ${s}`, subdomain: `b4other-${s}` } });
  brokerId = b.id; otherBrokerId = o.id; createdBrokerIds.push(b.id, o.id);
  ready = true;
}, 30000);

afterAll(async () => {
  if (!ready) return;
  await prisma.adminBackupCode.deleteMany({ where: { adminId: { in: createdAdminIds } } });
  await prisma.auditLog.deleteMany({ where: { OR: [{ brokerId: { in: createdBrokerIds } }, { actorAdminId: { in: createdAdminIds } }] } });
  await prisma.notification.deleteMany({ where: { brokerId: { in: createdBrokerIds } } });
  await prisma.adminUser.deleteMany({ where: { id: { in: createdAdminIds } } });
  await prisma.broker.deleteMany({ where: { id: { in: createdBrokerIds } } });
  await prisma.$disconnect();
}, 30000);

describe("mandatory staff 2FA: enrolment-only sessions", () => {
  it("a staff member without 2FA signs in to an ENROLMENT-ONLY session (login says so)", async () => {
    if (!ready) return;
    const m = await makeAdmin("MANAGER");
    as("", "/api/manage/login");
    const { POST } = await import("@/app/api/manage/login/route");
    const res = await POST(req("/api/manage/login", "POST", { email: m.email, password: PASSWORD }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.twoFactorSetupRequired).toBe(true);
    expect(body.code).toBe(TWO_FACTOR_SETUP_REQUIRED);
    const token = res.cookies.get("vyx_admin_session")?.value ?? "";
    expect(token.length).toBeGreaterThan(10);

    // any other API path: refused centrally -> redirected to the 403 { code } route
    for (const path of ["/api/manage/accounts", "/api/manage/positions", "/api/manage/admins", "/api/admin/sessions/abc", "/api/manage/theme"]) {
      as(token, path);
      expect(await thrownRedirect(() => getAdminSession())).toBe(TWO_FACTOR_SETUP_REQUIRED_PATH);
    }
    // a real data route never runs its body
    as(token, "/api/manage/accounts");
    const accounts = await import("@/app/api/manage/accounts/route");
    expect(await thrownRedirect(() => accounts.GET())).toBe(TWO_FACTOR_SETUP_REQUIRED_PATH);
    // ... and the route it lands on answers 403 with the code, for every method
    const refusal = await import("@/app/api/manage/two-factor-required/route");
    for (const h of [refusal.GET, refusal.POST, refusal.PATCH, refusal.PUT, refusal.DELETE]) {
      const r = await h();
      expect(r.status).toBe(403);
      expect((await r.json()).code).toBe(TWO_FACTOR_SETUP_REQUIRED);
    }
    // the enrolment allowlist + web pages get the session, flagged
    for (const path of ["/api/admin/two-factor/setup", "/api/admin/two-factor/confirm", "/api/admin/two-factor/status", "/api/admin/sessions", "/api/admin/logout", "/api/manage/shell-info", "/manage/security"]) {
      as(token, path);
      const s = await getAdminSession();
      expect(s?.adminId).toBe(m.id);
      expect(s?.twoFactorSetupRequired).toBe(true);
    }
    // no x-pathname at all (request that skipped middleware) fails closed
    as(token, "");
    expect(await getAdminSession()).toBeNull();

    // shell-info is minimal: identity + twoFactorSetupRequired, no screens
    as(token, "/api/manage/shell-info");
    const shell = await (await import("@/app/api/manage/shell-info/route")).GET();
    const si = await shell.json();
    expect(shell.status).toBe(200);
    expect(si).toMatchObject({ twoFactorSetupRequired: true, code: TWO_FACTOR_SETUP_REQUIRED, screens: [], role: "MANAGER", adminEmail: m.email, twoFactorEnabled: false });

    // enrol: setup -> confirm with a real TOTP code -> the SAME session becomes full
    as(token, "/api/admin/two-factor/setup");
    const setup = await (await import("@/app/api/admin/two-factor/setup/route")).POST(req("/api/admin/two-factor/setup", "POST", {}));
    expect(setup.status).toBe(200);
    const { secret, uri } = await setup.json();
    expect(uri).toContain("otpauth://totp/");
    as(token, "/api/admin/two-factor/confirm");
    const wrong = await (await import("@/app/api/admin/two-factor/confirm/route")).POST(req("/api/admin/two-factor/confirm", "POST", { code: "000000" === totp(secret) ? "111111" : "000000" }));
    expect(wrong.status).toBe(401);
    const confirm = await (await import("@/app/api/admin/two-factor/confirm/route")).POST(req("/api/admin/two-factor/confirm", "POST", { code: totp(secret) }));
    expect(confirm.status).toBe(200);
    expect((await confirm.json()).backupCodes).toHaveLength(6);

    as(token, "/api/manage/accounts");
    const full = await getAdminSession();
    expect(full?.adminId).toBe(m.id);
    expect(full?.twoFactorSetupRequired).toBeUndefined();
    const acc = await accounts.GET();
    expect(acc.status).toBe(200);
    as(token, "/api/manage/shell-info");
    const si2 = await (await (await import("@/app/api/manage/shell-info/route")).GET()).json();
    expect(si2.twoFactorSetupRequired).toBe(false);
    expect(si2.screens).toContain("DASH");

    // next sign-in: the TOTP challenge, and the verified session is listed (indexed) for "your sessions"
    as("", "/api/manage/login");
    const again = await (await import("@/app/api/manage/login/route")).POST(req("/api/manage/login", "POST", { email: m.email, password: PASSWORD }));
    const a2 = await again.json();
    expect(a2.requiresTwoFactor).toBe(true);
    const verify = await (await import("@/app/api/manage/login/verify-2fa/route")).POST(req("/api/manage/login/verify-2fa", "POST", { pendingToken: a2.pendingToken, code: totp(secret) }));
    expect(verify.status).toBe(200);
    const vToken = verify.cookies.get("vyx_admin_session")?.value ?? "";
    const vPayload = await verifySessionToken(vToken);
    const listed = await listAdminSessions(m.id, vPayload?.sessionId);
    expect(listed.some((s) => s.current)).toBe(true);
  });

  it("staff cannot turn 2FA off (mandatory); the super admin resets it, revoking every session (audited)", async () => {
    if (!ready) return;
    const staff = await makeAdmin("BROKER_ADMIN", { twoFactor: true });
    const t1 = await sessionFor(staff);
    as(t1, "/api/admin/two-factor/disable");
    const dis = await (await import("@/app/api/admin/two-factor/disable/route")).POST(req("/api/admin/two-factor/disable", "POST", { password: PASSWORD }));
    expect(dis.status).toBe(409);
    expect((await dis.json()).code).toBe("TWO_FACTOR_MANDATORY");

    const sa = await makeAdmin("SUPER_ADMIN", { twoFactor: true, broker: null });
    const saToken = await sessionFor(sa);
    const reset = await import("@/app/api/admin/admins/[id]/reset-two-factor/route");
    // a staff member can't call it
    as(t1, `/api/admin/admins/${staff.id}/reset-two-factor`);
    expect((await reset.POST(req("/x", "POST"), P(staff.id))).status).toBe(403);
    // the super admin can
    as(saToken, `/api/admin/admins/${staff.id}/reset-two-factor`, null);
    const r = await reset.POST(req("/x", "POST"), P(staff.id));
    expect(r.status).toBe(200);
    expect((await r.json()).revokedSessions).toBeGreaterThanOrEqual(1);
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { id: staff.id } });
    expect(after.twoFactorEnabled).toBe(false);
    expect(after.twoFactorSecret).toBeNull();
    expect(await verifySessionToken(t1)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "ADMIN_2FA_RESET_BY_SUPER_ADMIN", entityId: staff.id } })).toBe(1);
    // a super admin can't be "reset" through it
    expect((await reset.POST(req("/x", "POST"), P(sa.id))).status).toBe(404);
  });
});

describe("SUPPORT is read-only; the menu follows role + permissions", () => {
  it("shell-info screens per role (real sessions)", async () => {
    if (!ready) return;
    const shellInfo = (await import("@/app/api/manage/shell-info/route")).GET;
    const cases: [Awaited<ReturnType<typeof makeAdmin>>, (screens: string[]) => void][] = [
      [await makeAdmin("SUPPORT", { twoFactor: true }), (s) => expect(s).toEqual(["NTF", "DLS", "CLI", "KYC", "DEP", "SEC"])],
      [await makeAdmin("MANAGER", { twoFactor: true }), (s) => { expect(s).not.toContain("USR"); expect(s).not.toContain("CFG"); expect(s).not.toContain("IB"); expect(s).not.toContain("DEP"); expect(s).not.toContain("LP"); expect(s).toContain("DEAL"); }],
      [await makeAdmin("MANAGER", { twoFactor: true, perms: ["IB_PAYOUTS", "FUNDS_APPROVAL", "EMERGENCY_CONTROLS"] }), (s) => { expect(s).toEqual(expect.arrayContaining(["IB", "DEP", "EMG", "RISK"])); expect(s).not.toContain("USR"); }],
      [await makeAdmin("BROKER_ADMIN", { twoFactor: true }), (s) => expect(s).toEqual(expect.arrayContaining(["USR", "CFG", "LP", "ROUTE", "RPT-LP", "PSP"]))],
    ];
    for (const [admin, check] of cases) {
      as(await sessionFor(admin), "/api/manage/shell-info");
      const res = await shellInfo();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.twoFactorSetupRequired).toBe(false);
      expect(body.readOnly).toBe(admin.role === "SUPPORT");
      check(body.screens);
    }
  });

  it("SUPPORT reads clients / KYC / notifications / trade history / funds, and is refused on writes (real session)", async () => {
    if (!ready) return;
    const sup = await makeAdmin("SUPPORT", { twoFactor: true });
    const token = await sessionFor(sup);
    const reads: [string, () => Promise<Response>][] = [
      ["/api/manage/accounts", async () => (await import("@/app/api/manage/accounts/route")).GET()],
      ["/api/manage/kyc-requests", async () => (await import("@/app/api/manage/kyc-requests/route")).GET()],
      ["/api/manage/client-kyc-requests", async () => (await import("@/app/api/manage/client-kyc-requests/route")).GET()],
      ["/api/manage/notifications", async () => (await import("@/app/api/manage/notifications/route")).GET()],
      ["/api/manage/deals", async () => (await import("@/app/api/manage/deals/route")).GET(req("/api/manage/deals"))],
      ["/api/manage/funds-requests", async () => (await import("@/app/api/manage/funds-requests/route")).GET()],
    ];
    for (const [path, call] of reads) {
      as(token, path);
      expect([path, (await call()).status]).toEqual([path, 200]);
    }
    const writes: [string, () => Promise<Response>][] = [
      ["/api/manage/notifications", async () => (await import("@/app/api/manage/notifications/route")).PATCH(req("/x", "PATCH", { markAllRead: true }))],
      ["/api/manage/kyc-requests/x", async () => (await import("@/app/api/manage/kyc-requests/[id]/route")).PATCH(req("/x", "PATCH", { status: "APPROVED" }), P("x"))],
      ["/api/manage/funds-requests/x", async () => (await import("@/app/api/manage/funds-requests/[id]/route")).PATCH(req("/x", "PATCH", { action: "APPROVE" }), P("x"))],
      ["/api/manage/accounts", async () => (await import("@/app/api/manage/accounts/route")).POST(req("/x", "POST", {}))],
      ["/api/manage/admins", async () => (await import("@/app/api/manage/admins/route")).GET()],
      ["/api/manage/settings", async () => (await import("@/app/api/manage/settings/route")).GET()],
    ];
    for (const [path, call] of writes) {
      as(token, path);
      expect([path, (await call()).status]).toEqual([path, 403]);
    }
  });
});

describe("broker-side staff management (BROKER_ADMIN)", () => {
  it("role change: guards, sessions revoked, delegations dropped, audited", async () => {
    if (!ready) return;
    const ba = await makeAdmin("BROKER_ADMIN", { twoFactor: true });
    const mgr = await makeAdmin("MANAGER", { twoFactor: true, perms: ["IB_PAYOUTS"] });
    const otherBa = await makeAdmin("BROKER_ADMIN", { twoFactor: true });
    const foreign = await makeAdmin("MANAGER", { twoFactor: true, broker: otherBrokerId });
    const sa = await makeAdmin("SUPER_ADMIN", { twoFactor: true, broker: null });
    const baToken = await sessionFor(ba);
    const mgrToken = await sessionFor(mgr);
    const { PATCH } = await import("@/app/api/manage/admins/[id]/route");
    const patch = async (id: string, body: unknown) => { as(baToken, `/api/manage/admins/${id}`); return PATCH(req("/x", "PATCH", body), P(id)); };

    expect((await patch(ba.id, { role: "MANAGER" })).status).toBe(400); // not your own
    expect((await patch(mgr.id, { role: "SUPER_ADMIN" })).status).toBe(400); // never to SUPER_ADMIN
    expect((await patch(sa.id, { role: "MANAGER" })).status).toBe(404); // never from SUPER_ADMIN
    expect((await patch(foreign.id, { role: "SUPPORT" })).status).toBe(404); // other broker
    // a MANAGER can't change roles at all
    as(mgrToken, `/api/manage/admins/${otherBa.id}`);
    expect((await PATCH(req("/x", "PATCH", { role: "SUPPORT" }), P(otherBa.id))).status).toBe(403);

    const ok = await patch(mgr.id, { role: "SUPPORT" });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ role: "SUPPORT", extraPermissions: [] });
    expect(await verifySessionToken(mgrToken)).toBeNull(); // their sessions end now
    expect(await prisma.auditLog.count({ where: { action: "ADMIN_ROLE_CHANGED", entityId: mgr.id } })).toBe(1);
    // demoting another broker admin is fine while this one stays
    expect((await patch(otherBa.id, { role: "MANAGER" })).status).toBe(200);
  });

  it("password reset: one-time temporary password, sessions revoked, audited, request notification handled", async () => {
    if (!ready) return;
    const ba = await makeAdmin("BROKER_ADMIN", { twoFactor: true });
    const sup = await makeAdmin("SUPPORT", { twoFactor: true });
    const foreign = await makeAdmin("MANAGER", { twoFactor: true, broker: otherBrokerId });
    const baToken = await sessionFor(ba);
    const supToken = await sessionFor(sup);

    // SUPPORT files a forgot-password request -> a notification that names the action
    const forgot = await import("@/app/api/admin/forgot-password/route");
    const f = await forgot.POST(req("/api/admin/forgot-password", "POST", { email: sup.email, note: "lost it" }));
    expect(f.status).toBe(200);
    const n = await prisma.notification.findFirstOrThrow({ where: { brokerId, type: "ADMIN_PASSWORD_RESET_REQUESTED", entityId: sup.id } });
    expect(n.body).toContain("RESET PASSWORD");
    await forgot.POST(req("/x", "POST", { email: sup.email }));
    await forgot.POST(req("/x", "POST", { email: sup.email }));
    expect((await forgot.POST(req("/x", "POST", { email: sup.email }))).status).toBe(429); // throttled is said, not faked

    const { POST } = await import("@/app/api/manage/admins/[id]/reset-password/route");
    as(baToken, `/api/manage/admins/${ba.id}/reset-password`);
    expect((await POST(req("/x", "POST"), P(ba.id))).status).toBe(400); // not your own
    expect((await POST(req("/x", "POST"), P(foreign.id))).status).toBe(404);
    as(supToken, `/api/manage/admins/${ba.id}/reset-password`);
    expect((await POST(req("/x", "POST"), P(ba.id))).status).toBe(403); // not for SUPPORT

    as(baToken, `/api/manage/admins/${sup.id}/reset-password`);
    const res = await POST(req("/x", "POST"), P(sup.id));
    expect(res.status).toBe(200);
    const { password, revokedSessions } = await res.json();
    expect(typeof password).toBe("string");
    expect(password.length).toBeGreaterThanOrEqual(12);
    expect(revokedSessions).toBeGreaterThanOrEqual(1);
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { id: sup.id } });
    expect(await bcrypt.compare(password, after.passwordHash)).toBe(true);
    expect(await bcrypt.compare(PASSWORD, after.passwordHash)).toBe(false);
    expect(await verifySessionToken(supToken)).toBeNull();
    expect(await prisma.auditLog.count({ where: { action: "ADMIN_PASSWORD_RESET_BY_BROKER_ADMIN", entityId: sup.id } })).toBe(1);
    expect((await prisma.notification.findUniqueOrThrow({ where: { id: n.id } })).readAt).not.toBeNull();

    // the staff member then replaces it themselves; their other sessions end
    const s1 = await sessionFor(sup);
    const s2 = await sessionFor(sup);
    as(s1, "/api/admin/change-password");
    const cp = await (await import("@/app/api/admin/change-password/route")).POST(req("/x", "POST", { currentPassword: password, newPassword: "Brand-New-Pass-7" }));
    expect(cp.status).toBe(200);
    expect(await verifySessionToken(s1)).not.toBeNull();
    expect(await verifySessionToken(s2)).toBeNull();
  });
});

describe("sign-out revokes the server session", () => {
  it("POST /api/admin/logout deletes the Redis session and its device-list entry", async () => {
    if (!ready) return;
    const m = await makeAdmin("MANAGER", { twoFactor: true });
    const token = await sessionFor(m);
    const payload = await verifySessionToken(token);
    expect((await listAdminSessions(m.id, undefined)).map((s) => s.sessionId)).toContain(payload?.sessionId);
    as(token, "/api/admin/logout");
    const res = await (await import("@/app/api/admin/logout/route")).POST();
    expect(res.status).toBe(200);
    expect(await verifySessionToken(token)).toBeNull();
    expect((await listAdminSessions(m.id, undefined)).map((s) => s.sessionId)).not.toContain(payload?.sessionId);
    as(token, "/api/manage/accounts");
    expect(await getAdminSession()).toBeNull();
  });
});
