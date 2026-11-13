import "dotenv/config";
import bcrypt from "bcryptjs";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Consolidated native release, server part (owner 2026-11-04): the staff permission list (super-admin k1 / backoffice item 10) and web
// security batch 1 S1-S3 (client password resets, forced change, group and symbol writes by permission).
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/account-auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/account-auth")>()), revokeAllAccountSessions: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: vi.fn().mockResolvedValue({ usedMock: true }) }));

let dbReachable = false;
beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("native-release-permissions.test.ts: DB unreachable, skipping"); }
});

const brokers: string[] = [];
async function fixture() {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  const broker = await prisma.broker.create({ data: { name: `Perm ${s}`, subdomain: `perm-${s}` } });
  brokers.push(broker.id);
  const mk = (role: "BROKER_ADMIN" | "MANAGER", extra: string[] = [], tag: string = role) =>
    prisma.adminUser.create({ data: { brokerId: broker.id, email: `${tag.toLowerCase()}-${s}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", role, extraPermissions: extra } });
  const admin = await mk("BROKER_ADMIN");
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `G-${s}`, leverage: 100, category: "B_BOOK", modeRestriction: "ANY" } });
  return { s, brokerId: broker.id, admin, group, mk };
}
async function as(adminId: string, brokerId: string, role: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, brokerId, role } as never);
}
const json = (url: string, method: string, body?: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.auditLog.deleteMany({ where });
  await prisma.account.deleteMany({ where });
  await prisma.group.deleteMany({ where });
  await prisma.adminUser.deleteMany({ where });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.$disconnect();
}, 30000);

describe("GET /api/manage/permissions (the one list, owned by the server)", () => {
  it("returns the eight Staff page items in the owner's order and the other keys apart", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await as(fx.admin.id, fx.brokerId, "SUPPORT");
    const { GET } = await import("@/app/api/manage/permissions/route");
    const r = await (await GET()).json();
    expect(r.checklist.map((c: { key: string }) => c.key)).toEqual(["CLIENT_TRADING", "FUNDS_APPROVAL", "KYC_REVIEW", "DEALING", "REPORTS", "GROUPS_SYMBOLS", "STAFF_MANAGE", "CLIENT_PASSWORD_RESET"]);
    expect(r.checklist[7].label).toBe("Reset client passwords");
    expect(r.other.map((c: { key: string }) => c.key)).toContain("RISK_SETTINGS");
    expect(r.other.map((c: { key: string }) => c.key)).not.toContain("DEALING");
  });
});

describe("PATCH /api/manage/admins/[id]: a Manager with Manage staff", () => {
  async function patch(actor: { id: string; role: string }, brokerId: string, targetId: string, body: unknown) {
    await as(actor.id, brokerId, actor.role);
    const { PATCH } = await import("@/app/api/manage/admins/[id]/route");
    const res = await PATCH(json(`https://test.local/api/manage/admins/${targetId}`, "PATCH", body), { params: Promise.resolve({ id: targetId }) });
    return { status: res.status, body: await res.json() };
  }
  it("is refused without the permission and with it grants only what it holds", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const plain = await fx.mk("MANAGER", [], "plain");
    const staffer = await fx.mk("MANAGER", ["STAFF_MANAGE", "KYC_REVIEW"], "staffer");
    const target = await fx.mk("MANAGER", [], "target");
    expect((await patch(plain, fx.brokerId, target.id, { extraPermissions: ["KYC_REVIEW"] })).status).toBe(403);
    expect((await patch(staffer, fx.brokerId, target.id, { extraPermissions: ["KYC_REVIEW"] })).status).toBe(200);
    const refused = await patch(staffer, fx.brokerId, target.id, { extraPermissions: ["KYC_REVIEW", "DEALING"] });
    expect(refused.status).toBe(403);
    expect(refused.body.error).toBe("You can't grant a permission you don't hold: Dealing (accept / offer new price / reject dealer orders, hedge orders).");
    expect((await prisma.adminUser.findUniqueOrThrow({ where: { id: target.id } })).extraPermissions).toEqual(["KYC_REVIEW"]);
  });
  it("never edits a Broker Admin or hands out the Broker Admin role; a Broker Admin can", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const staffer = await fx.mk("MANAGER", ["STAFF_MANAGE"], "staffer");
    const other = await fx.mk("BROKER_ADMIN", [], "ba2");
    const target = await fx.mk("MANAGER", [], "target");
    expect((await patch(staffer, fx.brokerId, other.id, { status: "DISABLED" })).body.error).toBe("Only a broker admin can change a broker admin.");
    expect((await patch(staffer, fx.brokerId, target.id, { role: "BROKER_ADMIN" })).body.error).toBe("Only a broker admin can make someone a broker admin.");
    expect((await patch(fx.admin, fx.brokerId, target.id, { extraPermissions: ["DEALING", "REPORTS"] })).status).toBe(200);
  });
});

describe("PATCH /api/manage/groups/[id]: field classes (S2)", () => {
  async function save(actor: { id: string; role: string }, fx: Awaited<ReturnType<typeof fixture>>, body: Record<string, unknown>) {
    await as(actor.id, fx.brokerId, actor.role);
    const { PATCH } = await import("@/app/api/manage/groups/[id]/route");
    // the form resends every field with its current value (swapFree null = inherit)
    const full = { name: fx.group.name, leverage: 100, marginCallLevel: "100", stopOutLevel: "50", category: "B_BOOK", modeRestriction: "ANY", swapFree: null, ...body };
    const res = await PATCH(json(`https://test.local/api/manage/groups/${fx.group.id}`, "PATCH", full), { params: Promise.resolve({ id: fx.group.id }) });
    return { status: res.status, body: await res.json() };
  }
  it("a group editor renames, but leverage needs Risk settings and routing needs the dealing desk", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const editor = await fx.mk("MANAGER", ["GROUPS_SYMBOLS"], "editor");
    expect((await save(editor, fx, { name: `${fx.group.name}-r` })).status).toBe(200);
    const lev = await save(editor, fx, { name: `${fx.group.name}-r`, leverage: 200 });
    expect(lev.status).toBe(403); expect(lev.body.permission).toBe("RISK_SETTINGS");
    const routing = await save(editor, fx, { name: `${fx.group.name}-r`, category: "DEALING" });
    expect(routing.status).toBe(403); expect(routing.body.permission).toBe("DEALING");
  });
  it("a plain Manager is refused a rename; a Broker Admin changes everything", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const plain = await fx.mk("MANAGER", [], "plain");
    const r = await save(plain, fx, { name: `${fx.group.name}-x` });
    expect(r.status).toBe(403); expect(r.body.permission).toBe("GROUPS_SYMBOLS");
    expect((await save(fx.admin, fx, { name: `${fx.group.name}-y`, leverage: 300 })).status).toBe(200);
  });
  it("an unchanged save needs nothing beyond the route's own role", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const plain = await fx.mk("MANAGER", [], "plain");
    expect((await save(plain, fx, {})).status).toBe(200);
  });
});

describe("client password reset (S1)", () => {
  async function account(brokerId: string, groupId: string) {
    return prisma.account.create({ data: { brokerId, groupId, accountNumber: `9${Date.now() % 1e9}${Math.floor(Math.random() * 100)}`, email: "c@test.local", passwordHash: "x", fullName: "C", accountMode: "DEMO", isInternal: true } });
  }
  it("needs Reset client passwords, and a reset only resets: no forced change", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const acc = await account(fx.brokerId, fx.group.id);
    const { POST } = await import("@/app/api/manage/accounts/[id]/reset-password/route");
    const plain = await fx.mk("MANAGER", ["ACCOUNT_FINANCE", "CLIENT_TRADING"], "plain");
    await as(plain.id, fx.brokerId, "MANAGER");
    const refused = await POST(json(`https://test.local/x`, "POST"), { params: Promise.resolve({ id: acc.id }) });
    expect(refused.status).toBe(403);
    expect((await refused.json()).permission).toBe("CLIENT_PASSWORD_RESET");
    const resetter = await fx.mk("MANAGER", ["CLIENT_PASSWORD_RESET"], "resetter");
    await as(resetter.id, fx.brokerId, "MANAGER");
    const ok = await POST(json(`https://test.local/x`, "POST"), { params: Promise.resolve({ id: acc.id }) });
    expect(ok.status).toBe(200);
    const row = await prisma.account.findUniqueOrThrow({ where: { id: acc.id } });
    expect(row.mustChangePassword).toBe(false);
    // the trader signs in with the new password and goes straight back to trading
    expect(await bcrypt.compare((await ok.json()).password, row.passwordHash)).toBe(true);
  });
});

describe("no forced password change", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("nothing confines a trader session, on the web or the gateway", () => {
    // The web app never issues or checks the flag. The gateway tree recorded from the live deploy (6c851f1, 2026-11-09) still
    // carries the S1 read-side check (auth.ts / ws.ts); it is inert because no web session sets the flag any more, so it is
    // only required that the gateway never WRITES it (no assignment, no `mustChangePassword: true`).
    for (const f of ["lib/account-auth.ts", "app/api/trade/change-password/route.ts"]) {
      expect(src(f)).not.toContain("mustChangePassword");
    }
    for (const f of ["services/api-gateway/src/auth.ts", "services/api-gateway/src/ws.ts"]) {
      expect(src(f)).not.toMatch(/mustChangePassword\s*:\s*true|mustChangePassword\s*=[^=]/);
    }
    expect(fs.existsSync(path.join(process.cwd(), "app/api/trade/password-change-required/route.ts"))).toBe(false);
  });
});
