import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// CRM security batch (owner 2026-11-13): headers, DevTools keys, receipt bytes, the authenticator-code lockout, the
// human check on every sign-in form, staff sign-in limits, and Super Admin sign-in for Super Admins only.
const store = new Map<string, string>();
const fake = {
  get: async (k: string) => store.get(k) ?? null,
  set: async (k: string, v: string) => { store.set(k, v); return "OK"; },
  del: async (...ks: string[]) => { for (const k of ks) store.delete(k); return ks.length; },
  incr: async (k: string) => { const n = Number(store.get(k) ?? 0) + 1; store.set(k, String(n)); return n; },
  expire: async () => 1, sadd: async () => 1,
};
vi.mock("@/lib/redis", () => ({ getRedis: () => fake }));
vi.mock("next/headers", () => ({ headers: async () => ({ get: () => null }), cookies: async () => ({ get: () => undefined }) }));

const read = (p: string) => readFileSync(p, "utf8");
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { /* route cases skip */ } });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

describe("security headers", () => {
  it("CSP, HSTS, frame, nosniff, referrer and permissions on every response; Turnstile, gateway and images allowed", async () => {
    const cfg = (await import("@/next.config")).default;
    const rules = await cfg.headers!();
    expect(rules[0].source).toBe("/:path*");
    const h = Object.fromEntries(rules[0].headers.map((x) => [x.key, x.value]));
    for (const k of ["Content-Security-Policy", "Strict-Transport-Security", "X-Frame-Options", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) expect(h[k]).toBeTruthy();
    const csp = h["Content-Security-Policy"];
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("img-src 'self' data: blob: https:"); // Bitmoji (Snap CDN) and broker logos
    expect(csp).toContain("wss://*.vyxtrader.com");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(h["X-Content-Type-Options"]).toBe("nosniff");
    expect(read("next.config.ts")).toContain("productionBrowserSourceMaps: false");
  });
});

describe("DevTools keys", () => {
  it("F12, Ctrl/Cmd+Shift+I/J/C and Ctrl/Cmd+U are blocked; copy and paste are not", async () => {
    const { blockedKey } = await import("@/components/security/DevToolsGuard");
    const k = (key: string, o: Partial<{ ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
      blockedKey({ key, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...o });
    expect(k("F12")).toBe(true);
    for (const c of ["I", "J", "C"]) { expect(k(c, { ctrlKey: true, shiftKey: true })).toBe(true); expect(k(c.toLowerCase(), { metaKey: true, altKey: true })).toBe(true); }
    expect(k("u", { ctrlKey: true })).toBe(true);
    expect(k("c", { ctrlKey: true })).toBe(false);
    expect(k("v", { ctrlKey: true })).toBe(false);
    expect(k("x", { ctrlKey: true })).toBe(false);
    expect(k("a", { ctrlKey: true })).toBe(false);
    const g = read("components/security/DevToolsGuard.tsx");
    expect(g).toContain('if (process.env.NODE_ENV !== "production") return;');
    expect(g).toContain("if (t?.closest?.(EDITABLE)) return;"); // text fields keep their menu
    expect(read("components/room/RoomFrame.tsx")).toContain("<DevToolsGuard />");
    expect(read("app/(super-admin)/layout.tsx")).toContain("<DevToolsGuard />");
  });
});

describe("deposit receipts", () => {
  it("the bytes must be the type the file claims", async () => {
    const { receiptBytesMatch } = await import("@/lib/kyc-upload");
    const url = (type: string, bytes: number[]) => `data:${type};base64,${Buffer.from([...bytes, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]).toString("base64")}`;
    const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(receiptBytesMatch(url("image/png", png))).toBe(true);
    expect(receiptBytesMatch(url("image/jpeg", [0xff, 0xd8, 0xff]))).toBe(true);
    expect(receiptBytesMatch(url("application/pdf", [...Buffer.from("%PDF-1.7")]))).toBe(true);
    expect(receiptBytesMatch(url("image/webp", [...Buffer.from("RIFF"), 0, 0, 0, 0, ...Buffer.from("WEBP")]))).toBe(true);
    expect(receiptBytesMatch(url("image/png", [...Buffer.from("<html><script>")]))).toBe(false);
    expect(receiptBytesMatch(url("application/pdf", png))).toBe(false);
    expect(read("app/api/room/deposit/route.ts")).toContain("!receiptBytesMatch(body.receipt)");
  });
});

describe("authenticator code after sign-in", () => {
  it("5 wrong codes lock withdrawals, payout addresses and 2FA changes for 15 minutes", async () => {
    store.clear();
    const { checkClientCode } = await import("@/lib/room/limits");
    const { generateTotpSecret } = await import("@/lib/totp");
    const secret = generateTotpSecret();
    for (let i = 0; i < 5; i++) expect(await checkClientCode("c1", secret, "000000")).toBe("wrong");
    expect(await checkClientCode("c1", secret, "000000")).toBe("locked");
    for (const f of ["app/api/room/withdraw/route.ts", "app/api/room/payout-methods/route.ts", "app/api/room/two-factor/route.ts"]) {
      const src = read(f);
      expect(src).toContain("checkClientCode(session.clientId");
      expect(src).not.toMatch(/verifyTotp\(/);
    }
  });
});

describe("human check and limits on every sign-in form", () => {
  it("login (every time), register, forgot, reset and resend verify the token on the server; Google does not", () => {
    for (const f of ["app/api/portal/login/route.ts", "app/api/portal/forgot-password/route.ts", "app/api/portal/reset-password/route.ts", "app/api/portal/resend-verification/route.ts"]) {
      expect(read(f)).toContain("await humanCheckRefusal(brokerId, body?.turnstileToken, clientIp(request.headers))");
    }
    expect(read("app/api/portal/login/route.ts")).not.toContain("HUMAN_CHECK_AFTER_FAILURES");
    expect(read("app/api/portal/register/route.ts")).toContain("verifyHumanCheck(body?.turnstileToken");
    for (const f of ["app/api/auth/google/start/route.ts", "app/api/auth/google/callback/route.ts"]) expect(read(f)).not.toContain("humanCheck");
    // the forms send it
    expect(read("app/(broker)/room/login/LoginForm.tsx")).toContain("const turnstileToken = await human.take();");
    expect(read("app/(broker)/room/forgot-password/RoomForgotForm.tsx")).toContain("const turnstileToken = await human.take();");
    expect(read("app/(broker)/portal/reset-password/ResetPasswordForm.tsx")).toContain("const turnstileToken = await human.take();");
  });
  it("per-IP limits beside the per-account ones", () => {
    expect(read("app/api/portal/forgot-password/route.ts")).toContain("portal-forgot-password-ip:");
    expect(read("app/api/portal/reset-password/route.ts")).toContain("portal-reset-password-ip:");
    expect(read("app/api/portal/register/route.ts")).toContain("portal-register-ip-min:");
    expect(read("app/api/portal/register/route.ts")).not.toContain("checkRateLimit(`portal-register:${brokerId}`");
    expect(read("app/api/portal/resend-verification/route.ts")).not.toContain("x-forwarded-for");
    expect(read("app/api/portal/kyc/route.ts")).toContain("portal-kyc-upload:");
    for (const [f, a] of [["deposit", "room-deposit"], ["withdraw", "room-withdraw"], ["transfer", "room-transfer"], ["support", "room-ticket-new"], ["support/[id]", "room-ticket-reply"]]) {
      expect(read(`app/api/room/${f}/route.ts`)).toContain(`ipAllowed(request.headers, session.brokerId, "${a}"`);
    }
    expect(read("app/api/manage/login/route.ts")).toContain("manage-login-ip:");
    expect(read("app/api/manage/login/route.ts")).toContain("isLockedOut(failures, STAFF_LOGIN_FAILURES)");
  });
  it("a suspended client's session stops working (status checked, cached a minute)", () => {
    expect(read("lib/client-auth.ts")).toContain("if (!(await clientIsActive(session.clientId))) return null;");
  });
});

describe("Super Admin sign-in", () => {
  it("only a Super Admin gets in; broker staff with the right password are refused like a wrong password", async () => {
    if (!dbReachable) return;
    store.clear();
    const hash = await bcrypt.hash("Right-pass-1", 4);
    const staff = await prisma.broker.create({ data: { name: `Sa ${s}`, subdomain: `sa-${s}` } });
    await prisma.adminUser.create({ data: { email: `ba-${s}@t.local`, passwordHash: hash, role: "BROKER_ADMIN", brokerId: staff.id } as never });
    await prisma.adminUser.create({ data: { email: `sa-${s}@t.local`, passwordHash: hash, role: "SUPER_ADMIN", brokerId: null } as never });
    const { POST } = await import("@/app/api/admin/login/route");
    const login = (email: string) => POST(new NextRequest("https://admin.t.local/api/admin/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "Right-pass-1" }) }));
    const ba = await login(`ba-${s}@t.local`);
    expect(ba.status).toBe(401);
    expect(await ba.json()).toEqual({ error: "invalid credentials" });
    expect(ba.cookies.get("vyx_admin_session")).toBeUndefined();
    const sa = await login(`sa-${s}@t.local`);
    expect(sa.status).toBe(200);
  });
});
