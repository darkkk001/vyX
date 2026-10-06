import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMockLastSentTo } from "@/lib/email/adapter";
import { maskEmail, STAFF_RESEND_PER_CLIENT_PER_HOUR } from "@/lib/email/verification-email";

// POST /api/manage/clients/{id}/resend-verification (owner 2026-10-05): staff resend of the client-portal
// verification e-mail. Same e-mail as portal register/resend; explicit refusal codes for staff; audited.
vi.mock("@/lib/auth", () => ({
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));

let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => {
  delete process.env.RESEND_API_KEY; // the mock adapter takes every send unless a test says otherwise
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.adminUser.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

async function makeBroker(tag: string, emailOn = true) {
  const s = randomUUID().slice(0, 8);
  const b = await prisma.broker.create({
    data: { name: `SR ${tag} ${s}`, subdomain: `sr-${tag}-${s}`, ...(emailOn ? { emailEnabled: true, emailFromAddress: "noreply@t.local" } : {}) },
  });
  brokers.push(b.id);
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `sr-admin-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  return { broker: b, adminId: admin.id };
}
const addr = (tag: string) => `sr-${tag}-${randomUUID().slice(0, 8)}@t.local`;
async function makeClient(brokerId: string, tag: string, extra: Record<string, unknown> = {}) {
  return prisma.client.create({ data: { brokerId, email: addr(tag), passwordHash: "x", fullName: `SR ${tag}`, status: "ACTIVE", ...extra } });
}

async function resend(session: { adminId: string; role: string; brokerId: string | null }, clientId: string) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue(session as never);
  const { POST } = await import("./route");
  const res = await POST(new NextRequest(`https://test.local/api/manage/clients/${clientId}/resend-verification`, { method: "POST" }), { params: Promise.resolve({ id: clientId }) });
  return { status: res.status, body: await res.json() };
}
const audits = (clientId: string) => prisma.auditLog.findMany({ where: { action: "STAFF_VERIFICATION_RESENT", entityId: clientId } });
const tokenIn = (text: string) => /token=([a-f0-9]{64})/.exec(text)?.[1] ?? null;

describe("POST /api/manage/clients/{id}/resend-verification", () => {
  it("sends the verification e-mail with a working link, answers the masked address, audits the admin", async () => {
    if (!dbReachable) return;
    const { broker, adminId } = await makeBroker("ok");
    const c = await makeClient(broker.id, "ok");
    const r = await resend({ adminId, role: "BROKER_ADMIN", brokerId: broker.id }, c.id);
    expect(r).toEqual({ status: 200, body: { sent: true, to: maskEmail(c.email) } });
    expect(r.body.to).not.toContain(c.email.split("@")[0]);
    const mail = getMockLastSentTo(c.email);
    expect(mail?.subject).toBe(`Verify your email for ${broker.name}`);
    const token = tokenIn(mail!.text);
    expect(token).not.toBeNull();
    const a = await audits(c.id);
    expect(a).toHaveLength(1);
    expect(a[0].actorAdminId).toBe(adminId);
    expect(JSON.stringify(a[0].newValue)).not.toContain(token!);
    const { GET } = await import("@/app/api/portal/verify-email/route");
    await GET(new NextRequest(`https://test.local/api/portal/verify-email?token=${token}`));
    expect((await prisma.client.findUniqueOrThrow({ where: { id: c.id } })).emailVerifiedAt).not.toBeNull();
  });

  it("a MANAGER may resend; SUPPORT and non-staff are refused and nothing is sent", async () => {
    if (!dbReachable) return;
    const { broker, adminId } = await makeBroker("roles");
    const c = await makeClient(broker.id, "roles");
    expect((await resend({ adminId, role: "SUPPORT", brokerId: broker.id }, c.id)).status).toBe(403);
    expect((await resend({ adminId, role: "SUPER_ADMIN", brokerId: null }, c.id)).status).toBe(403);
    expect(getMockLastSentTo(c.email)).toBeNull();
    expect(await audits(c.id)).toHaveLength(0);
    expect((await resend({ adminId, role: "MANAGER", brokerId: broker.id }, c.id)).status).toBe(200);
  });

  it("another broker's client is CLIENT_NOT_FOUND (404), never e-mailed", async () => {
    if (!dbReachable) return;
    const mine = await makeBroker("mine");
    const theirs = await makeBroker("theirs");
    const c = await makeClient(theirs.broker.id, "theirs");
    const r = await resend({ adminId: mine.adminId, role: "BROKER_ADMIN", brokerId: mine.broker.id }, c.id);
    expect(r).toEqual({ status: 404, body: { error: "client not found", code: "CLIENT_NOT_FOUND" } });
    expect((await resend({ adminId: mine.adminId, role: "BROKER_ADMIN", brokerId: mine.broker.id }, "cnosuchclient000000000000")).body.code).toBe("CLIENT_NOT_FOUND");
    expect(getMockLastSentTo(c.email)).toBeNull();
    expect(await audits(c.id)).toHaveLength(0);
  });

  it("refuses a verified client (ALREADY_VERIFIED), a suspended one (CLIENT_NOT_ACTIVE) and a broker with e-mail off (EMAIL_NOT_CONFIGURED)", async () => {
    if (!dbReachable) return;
    const { broker, adminId } = await makeBroker("refuse");
    const s = { adminId, role: "BROKER_ADMIN", brokerId: broker.id };
    const verified = await makeClient(broker.id, "verified", { emailVerifiedAt: new Date() });
    const suspended = await makeClient(broker.id, "suspended", { status: "SUSPENDED" });
    expect(await resend(s, verified.id)).toMatchObject({ status: 409, body: { code: "ALREADY_VERIFIED" } });
    expect(await resend(s, suspended.id)).toMatchObject({ status: 409, body: { code: "CLIENT_NOT_ACTIVE" } });
    const off = await makeBroker("off", false);
    const c = await makeClient(off.broker.id, "off");
    expect(await resend({ adminId: off.adminId, role: "BROKER_ADMIN", brokerId: off.broker.id }, c.id)).toMatchObject({ status: 409, body: { code: "EMAIL_NOT_CONFIGURED" } });
    for (const x of [verified, suspended, c]) {
      expect(getMockLastSentTo(x.email)).toBeNull();
      expect(await audits(x.id)).toHaveLength(0);
    }
  });

  it(`is limited to ${STAFF_RESEND_PER_CLIENT_PER_HOUR} per client per hour (RATE_LIMITED, 429)`, async () => {
    if (!dbReachable) return;
    const { broker, adminId } = await makeBroker("limit");
    const c = await makeClient(broker.id, "limit");
    const s = { adminId, role: "BROKER_ADMIN", brokerId: broker.id };
    for (let i = 0; i < STAFF_RESEND_PER_CLIENT_PER_HOUR; i++) expect((await resend(s, c.id)).status).toBe(200);
    expect(await resend(s, c.id)).toMatchObject({ status: 429, body: { code: "RATE_LIMITED" } });
    expect(await audits(c.id)).toHaveLength(STAFF_RESEND_PER_CLIENT_PER_HOUR);
  });

  it("a provider refusal is SEND_FAILED (502) with a plain message (the provider's text only in the log), not audited", async () => {
    if (!dbReachable) return;
    const { broker, adminId } = await makeBroker("fail");
    const c = await makeClient(broker.id, "fail");
    process.env.RESEND_API_KEY = "re_test_invalid";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"message":"domain is not verified"}', { status: 403 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const r = await resend({ adminId, role: "BROKER_ADMIN", brokerId: broker.id }, c.id);
      expect(r.status).toBe(502);
      expect(r.body.code).toBe("SEND_FAILED");
      expect(r.body.error).toBe("The e-mail could not be sent. Try again later.");
      expect(r.body.error).not.toMatch(/domain|Resend|403/);
      expect(errSpy.mock.calls.some((x) => String(x[0]).includes("[staff-resend-verification] email send failed"))).toBe(true);
      expect(await audits(c.id)).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      errSpy.mockRestore();
      delete process.env.RESEND_API_KEY;
    }
  });
});
