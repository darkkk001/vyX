import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getRedis } from "@/lib/redis";

// Step 3b item 5 (owner 2026-10-07): staff devices and IP addresses. Every staff sign-in (and one an IP allowlist refused) is recorded
// with the address (first hop of x-forwarded-for) and device; a broker admin reads them per staff member on Staff.
vi.mock("@/lib/auth", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));
vi.mock("@/lib/client-builds", () => ({ checkClientBuild: async () => ({ ok: true, buildId: null }), clientBuildErrorMessage: () => "", prefetchClientBuild: () => null }));
import { createSessionToken, getAdminSession } from "@/lib/auth";
import { KEEP_SIGN_INS, recordStaffSignIn } from "@/lib/staff-devices";

let ready = false;
const brokers: string[] = [];
beforeAll(async () => { try { await prisma.$queryRaw`SELECT 1`; await getRedis().ping(); ready = true; } catch { console.warn("s3b-devices.test.ts: DB or Redis unreachable, skipping"); } });
afterAll(async () => {
  if (!ready) return;
  await prisma.adminSignIn.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokers } } }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

async function world(data: Record<string, unknown> = {}) {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `Dev ${sfx}`, subdomain: `dev-${sfx}`, ...data } }); brokers.push(b.id);
  const mk = (role: "BROKER_ADMIN" | "MANAGER", extra: Record<string, unknown> = {}) => prisma.adminUser.create({ data: { brokerId: b.id, email: `dev-${randomUUID().slice(0, 8)}@test.local`, passwordHash: bcrypt.hashSync("Correct-Horse-9", 4), role, ...extra } });
  return { b, mk };
}

describe("sign-ins are recorded", () => {
  it("a password-only sign-in writes SIGNED_IN with the first-hop address and the device; an allowlist refusal writes IP_BLOCKED", async () => {
    if (!ready) return;
    const { b, mk } = await world({ staffIpAllowlist: ["203.0.113.7"] });
    const a = await mk("BROKER_ADMIN", { twoFactorEnabled: false });
    const { POST } = await import("@/app/api/manage/login/route");
    const call = (ip: string) => POST(new NextRequest("https://t.local/api/manage/login", { method: "POST", headers: { "content-type": "application/json", "x-broker-id": b.id, "x-forwarded-for": ip, "user-agent": "Mozilla/5.0 Test", "x-client-build": "fx-1.0.63" }, body: JSON.stringify({ email: a.email, password: "Correct-Horse-9" }) }));
    expect((await call("198.51.100.1, 10.0.0.1")).status).toBe(403);
    expect((await call("203.0.113.7, 10.0.0.1")).status).toBe(200);
    const rows = await prisma.adminSignIn.findMany({ where: { adminId: a.id }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.outcome, r.ip])).toEqual([["IP_BLOCKED", "198.51.100.1"], ["SIGNED_IN", "203.0.113.7"]]);
    expect(rows[1].userAgent).toContain("Mozilla/5.0 Test"); expect(rows[1].userAgent).toContain("VyxBuild/fx-1.0.63");
    expect(rows[1].brokerId).toBe(b.id);
  });
  it("the newest 200 per person are kept", async () => {
    if (!ready) return;
    const { b, mk } = await world(); const a = await mk("MANAGER");
    const old = Array.from({ length: KEEP_SIGN_INS + 5 }, (_, i) => ({ adminId: a.id, brokerId: b.id, ip: "1.1.1.1", userAgent: "x", outcome: "SIGNED_IN", createdAt: new Date(Date.now() - (i + 10) * 60_000) }));
    await prisma.adminSignIn.createMany({ data: old });
    await recordStaffSignIn({ adminId: a.id, brokerId: b.id, headers: new Headers({ "x-forwarded-for": "9.9.9.9" }), outcome: "SIGNED_IN" });
    expect(await prisma.adminSignIn.count({ where: { adminId: a.id } })).toBe(KEEP_SIGN_INS);
    expect((await prisma.adminSignIn.findFirstOrThrow({ where: { adminId: a.id }, orderBy: { createdAt: "desc" } })).ip).toBe("9.9.9.9");
  });
});

describe("GET /api/manage/admins/{id}/sign-ins", () => {
  it("a broker admin reads another staff member's devices now and recent sign-ins; managers are refused; another broker's staff is not found", async () => {
    if (!ready) return;
    const { b, mk } = await world(); const boss = await mk("BROKER_ADMIN"); const staff = await mk("MANAGER"); const other = await world(); const stranger = await other.mk("MANAGER");
    await createSessionToken({ adminId: staff.id, role: "MANAGER", brokerId: b.id }, false, { userAgent: "Mozilla/5.0 (Windows NT 10.0) VyxBuild/fx-1.0.63", ip: "203.0.113.50" });
    await recordStaffSignIn({ adminId: staff.id, brokerId: b.id, headers: new Headers({ "x-forwarded-for": "203.0.113.50", "user-agent": "Mozilla/5.0" }), outcome: "SIGNED_IN" });
    const { GET } = await import("@/app/api/manage/admins/[id]/sign-ins/route");
    const get = (id: string) => GET(new NextRequest("https://t.local/x"), { params: Promise.resolve({ id }) });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: boss.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
    const ok = await get(staff.id); expect(ok.status).toBe(200);
    const j = await ok.json();
    expect(j.devices).toHaveLength(1); expect(j.devices[0]).toMatchObject({ ip: "203.0.113.50" }); expect(j.devices[0].userAgent).toContain("VyxBuild/fx-1.0.63");
    expect(Object.keys(j.devices[0]).sort()).toEqual(["createdAt", "ip", "userAgent"]);          // no session identifier
    expect(j.signIns).toHaveLength(1); expect(j.signIns[0]).toMatchObject({ ip: "203.0.113.50", outcome: "SIGNED_IN" });
    expect((await get(stranger.id)).status).toBe(404);
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: staff.id, role: "MANAGER", brokerId: b.id } as never);
    expect((await get(staff.id)).status).toBe(403);
  });
});
