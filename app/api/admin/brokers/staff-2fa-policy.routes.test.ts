import "dotenv/config";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

// Per-broker staff two-step sign-in policy (Broker.requireAdmin2fa): the Super Admin PATCH, the staff disable route, shell-info,
// new brokers default to Required, the existing reset paths, and "no broker-side route writes the flag".
vi.mock("@/lib/auth", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  revokeAllAdminSessions: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => { await prisma.$disconnect(); });

const s = randomUUID().replace(/-/g, "").slice(0, 8);
async function broker(required: boolean) {
  const b = await prisma.broker.create({ data: { name: `P2fa ${required} ${s}`, subdomain: `p2fa-${required ? "req" : "opt"}-${s}-${randomUUID().slice(0, 4)}`, requireAdmin2fa: required } });
  const mk = async (role: "BROKER_ADMIN" | "MANAGER", twoFactorEnabled: boolean) =>
    prisma.adminUser.create({ data: { brokerId: b.id, email: `${role}-${randomUUID().slice(0, 8)}@test.local`, passwordHash: await bcrypt.hash("Passw0rd!", 4), role, twoFactorEnabled, twoFactorSecret: twoFactorEnabled ? "SECRET" : null } });
  return { b, mk };
}
async function superAdmin() {
  const sa = await prisma.adminUser.create({ data: { brokerId: null, email: `sa-${randomUUID().slice(0, 8)}@test.local`, passwordHash: "x", role: "SUPER_ADMIN" } });
  await as(sa.id, "SUPER_ADMIN", null);
  return sa;
}
async function as(adminId: string, role: string, brokerId: string | null) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, role, brokerId } as never);
}
const req = (url: string, body?: unknown) =>
  new NextRequest(`https://t.local${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("PATCH /api/admin/brokers/[id]/staff-2fa (Super Admin only)", () => {
  it("403 for a broker admin, nothing changes", async () => {
    if (!dbReachable) return;
    const { b, mk } = await broker(true);
    const a = await mk("BROKER_ADMIN", true);
    await as(a.id, "BROKER_ADMIN", b.id);
    const { PATCH } = await import("./[id]/staff-2fa/route");
    const res = await PATCH(req(`/api/admin/brokers/${b.id}/staff-2fa`, { required: false, confirmOptional: true }), ctx(b.id));
    expect(res.status).toBe(403);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b.id } })).requireAdmin2fa).toBe(true);
  });
  it("lowering needs the explicit confirm, raising does not; both audited; a no-op writes no audit row", async () => {
    if (!dbReachable) return;
    const { b } = await broker(true);
    const sa = await superAdmin();
    const { PATCH } = await import("./[id]/staff-2fa/route");
    const url = `/api/admin/brokers/${b.id}/staff-2fa`;
    expect((await PATCH(req(url, { required: false }), ctx(b.id))).status).toBe(400);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b.id } })).requireAdmin2fa).toBe(true);
    expect((await PATCH(req(url, { required: false, confirmOptional: true }), ctx(b.id))).status).toBe(200);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b.id } })).requireAdmin2fa).toBe(false);
    expect((await PATCH(req(url, { required: false, confirmOptional: true }), ctx(b.id))).status).toBe(200); // no-op
    expect((await PATCH(req(url, { required: true }), ctx(b.id))).status).toBe(200);
    expect((await prisma.broker.findUniqueOrThrow({ where: { id: b.id } })).requireAdmin2fa).toBe(true);
    const logs = await prisma.auditLog.findMany({ where: { brokerId: b.id, action: "BROKER_STAFF_2FA_POLICY_CHANGED" }, orderBy: { createdAt: "asc" } });
    expect(logs.map((l) => (l.newValue as { requireAdmin2fa: boolean }).requireAdmin2fa)).toEqual([false, true]);
    expect(logs[0].actorAdminId).toBe(sa.id);
    expect((await PATCH(req(url, { required: "no" }), ctx(b.id))).status).toBe(400);
    expect((await PATCH(req(url, { required: true }), ctx("missing"))).status).toBe(404);
  });
});

describe("POST /api/admin/two-factor/disable", () => {
  it("Required broker: 409 TWO_FACTOR_MANDATORY, 2FA stays on", async () => {
    if (!dbReachable) return;
    const { b, mk } = await broker(true);
    const a = await mk("MANAGER", true);
    await as(a.id, "MANAGER", b.id);
    const { POST } = await import("@/app/api/admin/two-factor/disable/route");
    const res = await POST(req("/api/admin/two-factor/disable", { password: "Passw0rd!" }));
    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("TWO_FACTOR_MANDATORY");
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: a.id } })).twoFactorEnabled).toBe(true);
  });
  it("Optional broker: needs the password, then turns 2FA off and audits it", async () => {
    if (!dbReachable) return;
    const { b, mk } = await broker(false);
    const a = await mk("MANAGER", true);
    await as(a.id, "MANAGER", b.id);
    const { POST } = await import("@/app/api/admin/two-factor/disable/route");
    expect((await POST(req("/api/admin/two-factor/disable", { password: "wrong" }))).status).toBe(401);
    expect((await POST(req("/api/admin/two-factor/disable", { password: "Passw0rd!" }))).status).toBe(200);
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { id: a.id } });
    expect(after.twoFactorEnabled).toBe(false);
    expect(after.twoFactorSecret).toBeNull();
    expect(await prisma.auditLog.count({ where: { entityId: a.id, action: "ADMIN_2FA_DISABLED" } })).toBe(1);
  });
  it("Super Admin is unaffected (can still disable)", async () => {
    if (!dbReachable) return;
    const sa = await prisma.adminUser.create({ data: { brokerId: null, email: `sa-${randomUUID().slice(0, 8)}@test.local`, passwordHash: await bcrypt.hash("Passw0rd!", 4), role: "SUPER_ADMIN", twoFactorEnabled: true, twoFactorSecret: "S" } });
    await as(sa.id, "SUPER_ADMIN", null);
    const { POST } = await import("@/app/api/admin/two-factor/disable/route");
    expect((await POST(req("/api/admin/two-factor/disable", { password: "Passw0rd!" }))).status).toBe(200);
  });
});

describe("GET /api/manage/shell-info", () => {
  it("reports the real flag; Optional + no 2FA is not a setup-only response", async () => {
    if (!dbReachable) return;
    const { GET } = await import("@/app/api/manage/shell-info/route");
    for (const required of [true, false]) {
      const { b, mk } = await broker(required);
      const a = await mk("BROKER_ADMIN", false);
      await as(a.id, "BROKER_ADMIN", b.id);
      const json = await (await GET()).json();
      expect(json.twoFactorRequired).toBe(required);
      expect(json.twoFactorSetupRequired).toBe(required);
      expect(Array.isArray(json.screens) && json.screens.length > 0).toBe(!required);
    }
  });
});

describe("new brokers", () => {
  it("POST /api/admin/brokers creates them Required, although the column default is false", async () => {
    if (!dbReachable) return;
    await superAdmin();
    const { POST } = await import("./route");
    const sub = `newb-${s}`;
    const res = await POST(req("/api/admin/brokers", { name: `New ${s}`, subdomain: sub, tier: "STANDARD" }));
    expect(res.status).toBeLessThan(300);
    expect((await prisma.broker.findUniqueOrThrow({ where: { subdomain: sub } })).requireAdmin2fa).toBe(true);
  });
});

describe("existing reset paths still work", () => {
  it("manage/admins/[id]/reset-2fa, admin/admins/[id]/reset-two-factor, manage/accounts/[id]/reset-2fa", async () => {
    if (!dbReachable) return;
    const { b, mk } = await broker(false); // an Optional broker: resets must work there too
    const boss = await mk("BROKER_ADMIN", true);
    const t1 = await mk("MANAGER", true);
    const t2 = await mk("MANAGER", true);
    await as(boss.id, "BROKER_ADMIN", b.id);
    const r1 = await (await import("@/app/api/manage/admins/[id]/reset-2fa/route")).POST(req("/x"), ctx(t1.id));
    expect(r1.status).toBe(200);
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: t1.id } })).twoFactorEnabled).toBe(false);
    const group = await prisma.group.create({ data: { brokerId: b.id, name: `G-${s}`, isDefault: true } });
    const acct = await prisma.account.create({ data: { groupId: group.id, brokerId: b.id, accountNumber: `6${s.slice(0, 7)}`, email: `c-${s}@test.local`, passwordHash: "x", fullName: "c", accountMode: "LIVE", twoFactorEnabled: true, twoFactorSecret: "S" } });
    const r3 = await (await import("@/app/api/manage/accounts/[id]/reset-2fa/route")).POST(req("/x"), ctx(acct.id));
    expect(r3.status).toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acct.id } })).twoFactorEnabled).toBe(false);
    await superAdmin();
    const r2 = await (await import("@/app/api/admin/admins/[id]/reset-two-factor/route")).POST(req("/x"), ctx(t2.id));
    expect(r2.status).toBe(200);
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: t2.id } })).twoFactorEnabled).toBe(false);
  });
});

describe("the broker side has no writer for the flag", () => {
  it("no file under app/api/manage or app/manage writes requireAdmin2fa", () => {
    const root = path.resolve(import.meta.dirname, "../../../..");
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir)) {
        const p = path.join(dir, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(e) && !/\.test\./.test(e)) {
          const src = readFileSync(p, "utf8").replace(/\/\/.*$/gm, "");
          if (!src.includes("requireAdmin2fa")) continue;
          // a read is a select; a write would sit in a broker update/create/upsert or assign a value other than the select's `true`
          if (/broker\.(update|updateMany|upsert|create)\b/.test(src) || /requireAdmin2fa\s*:(?!\s*true\s*[,}])/.test(src)) hits.push(path.relative(root, p));
        }
      }
    };
    walk(path.join(root, "app/api/manage"));
    walk(path.join(root, "app/manage"));
    expect(hits).toEqual([]);
  });
});
