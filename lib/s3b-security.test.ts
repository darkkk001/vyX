import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { getURLFromRedirectError } from "next/dist/client/components/redirect";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// Step 3b item 3 (owner 2026-10-07): the staff password change interval and the staff IP allowlist. The client address is the first
// hop of x-forwarded-for. Real DB + Redis sessions; only the request context (cookies / headers) is driven by `ctx`.
const ctx = { token: "", path: "", brokerId: "", ip: "" };
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "vyx_admin_session" && ctx.token ? { name, value: ctx.token } : undefined) }),
  headers: async () => new Headers({ "x-pathname": ctx.path, "x-broker-id": ctx.brokerId, ...(ctx.ip ? { "x-forwarded-for": ctx.ip } : {}) }),
}));
vi.mock("@/lib/client-builds", () => ({ checkClientBuild: async () => ({ ok: true, buildId: null }), clientBuildErrorMessage: () => "", prefetchClientBuild: () => null }));
vi.mock("@/lib/cookie-domain", () => ({ cookieScopeDomain: async () => undefined }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: async () => {} }));

import { createSessionToken, getAdminSession, PASSWORD_CHANGE_REQUIRED_PATH } from "@/lib/auth";
import { checkAllowlistSave, clientIpFromHeaders, ipAllowed, parseAllowEntry, passwordExpired } from "@/lib/ip-allowlist";

let ready = false;
const brokers: string[] = []; const admins: string[] = [];
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; await getRedis().ping(); ready = true; } catch { console.warn("s3b-security.test.ts: DB or Redis unreachable, skipping"); }
});
afterAll(async () => {
  if (!ready) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { id: { in: admins } } }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world(data: Record<string, unknown> = {}) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `S3b Sec ${sfx}`, subdomain: `s3bsec-${sfx}`, ...data } }); brokers.push(b.id);
  return b;
}
async function admin(brokerId: string | null, role: "BROKER_ADMIN" | "MANAGER" | "SUPER_ADMIN" = "BROKER_ADMIN", extra: Record<string, unknown> = {}) {
  const a = await prisma.adminUser.create({ data: { brokerId, email: `s3sec-${randomUUID().slice(0, 8)}@test.local`, passwordHash: await bcrypt.hash("Correct-Horse-9", 4), role, twoFactorEnabled: true, twoFactorSecret: "JBSWY3DPEHPK3PXP", ...extra } }); admins.push(a.id);
  return a;
}
const as = (token: string, path: string, brokerId: string | null, ip = "") => { ctx.token = token; ctx.path = path; ctx.brokerId = brokerId ?? ""; ctx.ip = ip; };
const tokenFor = (a: { id: string; role: never; brokerId: string | null }) => createSessionToken({ adminId: a.id, role: a.role, brokerId: a.brokerId }, false, { userAgent: "vitest", ip: "1.1.1.1" });

describe("ip allowlist (pure)", () => {
  it("first hop of x-forwarded-for, one helper", () => {
    expect(clientIpFromHeaders(new Headers({ "x-forwarded-for": "203.0.113.7, 10.0.0.1, 10.0.0.2" }))).toBe("203.0.113.7");
    expect(clientIpFromHeaders(new Headers())).toBe("");
  });
  it("addresses, ranges and exact IPv6; an empty list allows all; no address is refused by a list", () => {
    const list = ["203.0.113.7", "198.51.100.0/24", "2001:db8::1"];
    expect(ipAllowed("203.0.113.7", list)).toBe(true);
    expect(ipAllowed("203.0.113.8", list)).toBe(false);
    expect(ipAllowed("198.51.100.200", list)).toBe(true);
    expect(ipAllowed("198.51.101.1", list)).toBe(false);
    expect(ipAllowed("2001:db8::1", list)).toBe(true);
    expect(ipAllowed("2001:db8::2", list)).toBe(false);
    expect(ipAllowed("", list)).toBe(false);
    expect(ipAllowed("9.9.9.9", [])).toBe(true);
  });
  it("entries: ranges no wider than /8, nonsense refused", () => {
    expect(parseAllowEntry("10.0.0.0/7")).toBeNull();
    expect(parseAllowEntry("10.0.0.0/8")).not.toBeNull();
    expect(parseAllowEntry("999.1.1.1")).toBeNull();
    expect(parseAllowEntry("hello")).toBeNull();
  });
  it("a saved list must contain the address it is saved from", () => {
    expect(checkAllowlistSave(["203.0.113.7"], "203.0.113.7")).toEqual({ ok: true, entries: ["203.0.113.7"] });
    expect(checkAllowlistSave(["203.0.113.7"], "198.51.100.1")).toMatchObject({ ok: false, code: "IP_LOCKOUT" });
    expect(checkAllowlistSave(["203.0.113.7"], "")).toMatchObject({ ok: false, code: "IP_LOCKOUT" });
    expect(checkAllowlistSave([], "")).toEqual({ ok: true, entries: [] });          // off
    expect(checkAllowlistSave(["nonsense"], "1.1.1.1")).toMatchObject({ ok: false });
    expect(checkAllowlistSave("x", "1.1.1.1")).toMatchObject({ ok: false });
  });
  it("password age: changed date, else created date; no interval = never", () => {
    const now = new Date("2026-10-07T00:00:00Z");
    const d = (days: number) => new Date(now.getTime() - days * 86_400_000);
    expect(passwordExpired(d(10), d(400), 30, now)).toBe(false);
    expect(passwordExpired(d(31), d(400), 30, now)).toBe(true);
    expect(passwordExpired(null, d(40), 30, now)).toBe(true);
    expect(passwordExpired(null, d(5), 30, now)).toBe(false);
    expect(passwordExpired(d(900), d(900), null, now)).toBe(false);
  });
});

describe("the allowlist is enforced on every staff request and at sign-in", () => {
  it("a request from an address off the list gets no session; on the list, or with an empty list, it does; Super Admin is never limited", async () => {
    if (!ready) return;
    const b = await world({ staffIpAllowlist: ["203.0.113.0/24"] });
    const a = await admin(b.id); const tok = await tokenFor(a as never);
    as(tok, "/api/manage/positions", b.id, "203.0.113.50, 10.1.1.1");
    expect((await getAdminSession())?.adminId).toBe(a.id);
    as(tok, "/api/manage/positions", b.id, "198.51.100.9");
    expect(await getAdminSession()).toBeNull();
    as(tok, "/api/manage/positions", b.id, "");
    expect(await getAdminSession()).toBeNull();
    await prisma.broker.update({ where: { id: b.id }, data: { staffIpAllowlist: [] } });
    as(tok, "/api/manage/positions", b.id, "198.51.100.9");
    expect((await getAdminSession())?.adminId).toBe(a.id);
    const sa = await admin(null, "SUPER_ADMIN"); const stok = await tokenFor(sa as never);
    as(stok, "/api/admin/brokers", null, "198.51.100.9");
    expect((await getAdminSession())?.adminId).toBe(sa.id);
  });

  it("sign-in from an address off the list is refused with IP_NOT_ALLOWED (after the password), from the list it works", async () => {
    if (!ready) return;
    const b = await world({ staffIpAllowlist: ["203.0.113.7"] });
    const a = await admin(b.id, "BROKER_ADMIN", { twoFactorEnabled: false, twoFactorSecret: null });
    const { POST } = await import("@/app/api/manage/login/route");
    const call = (ip: string, password = "Correct-Horse-9") => POST(new NextRequest("https://t.local/api/manage/login", { method: "POST", headers: { "content-type": "application/json", "x-broker-id": b.id, "x-forwarded-for": ip }, body: JSON.stringify({ email: a.email, password }) }));
    const off = await call("198.51.100.1");
    expect(off.status).toBe(403); expect((await off.json()).code).toBe("IP_NOT_ALLOWED");
    expect((await call("198.51.100.1", "wrong-password")).status).toBe(401);      // a wrong password still says nothing about the list
    expect((await call("203.0.113.7")).status).toBe(200);
  });
});

describe("password change interval", () => {
  it("an expired password confines the session to changing it; changing it frees the session; an admin reset sends it back", async () => {
    if (!ready) return;
    const b = await world({ passwordMaxAgeDays: 30 });
    const old = new Date(Date.now() - 60 * 86_400_000);
    const a = await admin(b.id, "BROKER_ADMIN", { createdAt: old });
    const tok = await tokenFor(a as never);
    // data call: redirected to the 403 route
    as(tok, "/api/manage/positions", b.id);
    let url = "";
    try { await getAdminSession(); } catch (e) { if (!isRedirectError(e)) throw e; url = getURLFromRedirectError(e) ?? ""; }
    expect(url).toBe(PASSWORD_CHANGE_REQUIRED_PATH);
    const refusal = await (await import("@/app/api/manage/password-change-required/route")).GET();
    expect(refusal.status).toBe(403); expect((await refusal.json()).code).toBe("PASSWORD_CHANGE_REQUIRED");
    // the few allowed paths work and say so
    for (const p of ["/api/admin/change-password", "/api/manage/shell-info", "/api/admin/logout"]) {
      as(tok, p, b.id);
      expect((await getAdminSession())?.passwordChangeRequired, p).toBe(true);
    }
    // changing it through the real route stamps passwordChangedAt and frees the session
    const { POST } = await import("@/app/api/admin/change-password/route");
    as(tok, "/api/admin/change-password", b.id);
    const res = await POST(new NextRequest("https://t.local/api/admin/change-password", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ currentPassword: "Correct-Horse-9", newPassword: "A-New-Passw0rd" }) }));
    expect(res.status).toBe(200);
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: a.id } })).passwordChangedAt).not.toBeNull();
    as(tok, "/api/manage/positions", b.id);
    const after = await getAdminSession();
    expect(after?.adminId).toBe(a.id); expect(after?.passwordChangeRequired).toBeUndefined();
    // an admin's reset (temporary password) sends passwordChangedAt back to null: the next sign-in must change it
    await prisma.adminUser.update({ where: { id: a.id }, data: { passwordChangedAt: null } });
    as(tok, "/api/manage/positions", b.id);
    await expect(getAdminSession()).rejects.toSatisfy((e: unknown) => isRedirectError(e));
  });

  it("no interval set: nothing is ever confined", async () => {
    if (!ready) return;
    const b = await world();
    const a = await admin(b.id, "BROKER_ADMIN", { createdAt: new Date(Date.now() - 900 * 86_400_000) });
    as(await tokenFor(a as never), "/api/manage/positions", b.id);
    expect((await getAdminSession())?.passwordChangeRequired).toBeUndefined();
  });

  it("the reset routes null the date (source guard)", async () => {
    const fs = await import("node:fs");
    for (const f of ["app/api/admin/admins/[id]/reset-password/route.ts", "app/api/manage/admins/[id]/reset-password/route.ts"]) expect(fs.readFileSync(f, "utf8"), f).toContain("passwordChangedAt: null");
  });
});

describe("settings route", () => {
  it("saves the interval and the allowlist (audited), refuses a list without the saver's own address, and GET returns them", async () => {
    if (!ready) return;
    const b = await world();
    const a = await admin(b.id);
    const tok = await tokenFor(a as never);
    as(tok, "/api/manage/settings", b.id, "203.0.113.7");
    const { GET, PATCH } = await import("@/app/api/manage/settings/route");
    const patch = (body: unknown, ip = "203.0.113.7") => PATCH(new NextRequest("https://t.local/api/manage/settings", { method: "PATCH", headers: { "content-type": "application/json", "x-forwarded-for": ip }, body: JSON.stringify(body) }));
    expect((await patch({ passwordMaxAgeDays: 3 })).status).toBe(400);
    expect((await patch({ staffIpAllowlist: ["198.51.100.1"] })).status).toBe(400);                 // not the saver's address
    const lock = await patch({ staffIpAllowlist: ["198.51.100.1"] });
    expect((await lock.json()).code).toBe("IP_LOCKOUT");
    const ok = await patch({ passwordMaxAgeDays: 90, staffIpAllowlist: ["203.0.113.0/24", "198.51.100.1"] });
    expect(ok.status).toBe(200);
    const g = await (await GET()).json();
    expect(g.passwordMaxAgeDays).toBe(90); expect(g.staffIpAllowlist).toEqual(["203.0.113.0/24", "198.51.100.1"]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { brokerId: b.id, action: "BROKER_SETTINGS_UPDATED" }, orderBy: { createdAt: "desc" } });
    expect((audit.oldValue as Record<string, unknown>).staffIpAllowlist).toEqual([]);
    expect((audit.newValue as Record<string, unknown>).passwordMaxAgeDays).toBe(90);
    // off again
    expect((await patch({ passwordMaxAgeDays: null, staffIpAllowlist: [] })).status).toBe(200);
    expect((await (await GET()).json()).staffIpAllowlist).toEqual([]);
  });
});
