import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMockLastSentTo } from "@/lib/email/adapter";
import { renderVerificationEmail, RESEND_PER_EMAIL_PER_HOUR, RESEND_PER_IP_PER_HOUR } from "@/lib/email/verification-email";

// POST /api/portal/resend-verification (owner 2026-10-05): constant answer,
// sends only to an ACTIVE unverified client of this broker, identical e-mail
// to registration, audited, rate-limited per address and per IP.

let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => {
  delete process.env.RESEND_API_KEY; // every send goes through the mock adapter unless a test says otherwise
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

async function makeBroker(tag: string, extra: Record<string, unknown> = {}) {
  const s = randomUUID().slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `RV ${tag} ${s}`, subdomain: `rv-${tag}-${s}`, ...extra } });
  brokers.push(b.id);
  return b;
}
const addr = (tag: string) => `rv-${tag}-${randomUUID().slice(0, 8)}@t.local`;
const ipOf = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;

async function resend(brokerId: string, email: unknown, ip = ipOf()) {
  const { POST } = await import("@/app/api/portal/resend-verification/route");
  const res = await POST(new NextRequest("https://test.local/api/portal/resend-verification", {
    method: "POST",
    headers: { "content-type": "application/json", "x-broker-id": brokerId, "x-forwarded-for": ip },
    body: JSON.stringify({ email }),
  }));
  return { status: res.status, body: await res.json() };
}
const tokenIn = (text: string) => /token=([a-f0-9]{64})/.exec(text)?.[1] ?? null;
const audits = (clientId: string) => prisma.auditLog.findMany({ where: { action: "CLIENT_VERIFICATION_RESENT", entityId: clientId } });

describe("POST /api/portal/resend-verification", () => {
  it("sends a fresh working link to an ACTIVE unverified client, once, audited without the token", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ok");
    const email = addr("ok");
    const client = await prisma.client.create({ data: { brokerId: broker.id, email, passwordHash: "x", fullName: "Un Verified", status: "ACTIVE" } });

    const r = await resend(broker.id, email.toUpperCase()); // case-insensitive like register
    expect(r).toEqual({ status: 200, body: { ok: true } });

    const mail = getMockLastSentTo(email);
    expect(mail?.subject).toBe(`Verify your email for ${broker.name}`);
    const token = tokenIn(mail!.text);
    expect(token).not.toBeNull();

    const a = await audits(client.id);
    expect(a).toHaveLength(1);
    expect(JSON.stringify(a[0].newValue)).not.toContain(token!);

    const { GET } = await import("@/app/api/portal/verify-email/route");
    const v = await GET(new NextRequest(`https://test.local/api/portal/verify-email?token=${token}`));
    expect(v.headers.get("location")).toContain("verify=success");
    expect((await prisma.client.findUniqueOrThrow({ where: { id: client.id } })).emailVerifiedAt).not.toBeNull();
  });

  it("answers exactly the same and sends nothing for an unknown, verified or suspended address", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("none");
    const unknown = addr("unknown");
    const verified = addr("verified");
    const suspended = addr("suspended");
    const v = await prisma.client.create({ data: { brokerId: broker.id, email: verified, passwordHash: "x", fullName: "V", status: "ACTIVE", emailVerifiedAt: new Date() } });
    const s = await prisma.client.create({ data: { brokerId: broker.id, email: suspended, passwordHash: "x", fullName: "S", status: "SUSPENDED" } });
    for (const e of [unknown, verified, suspended]) {
      expect(await resend(broker.id, e)).toEqual({ status: 200, body: { ok: true } });
      expect(getMockLastSentTo(e)).toBeNull();
    }
    expect(await audits(v.id)).toHaveLength(0);
    expect(await audits(s.id)).toHaveLength(0);
  });

  it("never sends to another broker's client", async () => {
    if (!dbReachable) return;
    const mine = await makeBroker("mine");
    const theirs = await makeBroker("theirs");
    const email = addr("other");
    const c = await prisma.client.create({ data: { brokerId: theirs.id, email, passwordHash: "x", fullName: "Other", status: "ACTIVE" } });
    expect(await resend(mine.id, email)).toEqual({ status: 200, body: { ok: true } });
    expect(getMockLastSentTo(email)).toBeNull();
    expect(await audits(c.id)).toHaveLength(0);
  });

  it(`limits each address to ${RESEND_PER_EMAIL_PER_HOUR} per hour`, async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("lim");
    const email = addr("lim");
    for (let i = 0; i < RESEND_PER_EMAIL_PER_HOUR; i++) expect((await resend(broker.id, email)).status).toBe(200);
    const over = await resend(broker.id, email);
    expect(over.status).toBe(429);
    expect(over.body.error).toBe("too many attempts, try again later");
  });

  it(`limits each IP to ${RESEND_PER_IP_PER_HOUR} per hour across addresses`, async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ip");
    const ip = ipOf();
    for (let i = 0; i < RESEND_PER_IP_PER_HOUR; i++) expect((await resend(broker.id, addr(`ip${i}`), ip)).status).toBe(200);
    expect((await resend(broker.id, addr("ipover"), ip)).status).toBe(429);
  });

  it("refuses a malformed body with 400 and no send", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("bad");
    expect((await resend(broker.id, "not-an-email")).status).toBe(400);
    expect((await resend(broker.id, 42)).status).toBe(400);
  });

  it("sends the identical e-mail registration sends (subject, text and html, apart from the token)", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("same", { logoUrl: "https://cdn.t.local/logo.png", primaryColor: "#123456", supportEmail: "help@t.local" });
    const email = addr("same");
    const { POST: register } = await import("@/app/api/portal/register/route");
    const reg = await register(new NextRequest("https://test.local/api/portal/register", {
      method: "POST", headers: { "content-type": "application/json", "x-broker-id": broker.id },
      body: JSON.stringify({ email, password: "password123", fullName: "Same Template" }),
    }));
    expect(reg.status).toBe(200);
    const first = getMockLastSentTo(email)!;
    expect((await resend(broker.id, email)).status).toBe(200);
    const second = getMockLastSentTo(email)!;
    const strip = (s: string) => s.replace(/token=[a-f0-9]{64}/g, "token=T");
    expect(second.subject).toBe(first.subject);
    expect(strip(second.text)).toBe(strip(first.text));
    expect(strip(second.html)).toBe(strip(first.html));
    expect(tokenIn(second.text)).not.toBe(tokenIn(first.text)); // a fresh token each time
    // and both equal the shared renderer's output
    const expected = renderVerificationEmail({ name: broker.name, logoUrl: "https://cdn.t.local/logo.png", primaryColor: "#123456", supportEmail: "help@t.local" }, "URL");
    expect(second.subject).toBe(expected.subject);
    expect(strip(second.text).replace(/https?:\/\/\S*token=T/g, "URL")).toBe(expected.text);
  });

  it("still answers 200 and writes no audit row when the provider refuses the send", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("fail", { emailEnabled: true, emailFromAddress: "noreply@t.local" });
    const email = addr("fail");
    const c = await prisma.client.create({ data: { brokerId: broker.id, email, passwordHash: "x", fullName: "F", status: "ACTIVE" } });
    process.env.RESEND_API_KEY = "re_test_invalid";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response('{"message":"domain is not verified"}', { status: 403 }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await resend(broker.id, email)).toEqual({ status: 200, body: { ok: true } });
      expect(errSpy.mock.calls.some((c) => String(c[0]).includes("[resend-verification] email send failed"))).toBe(true);
      expect(await audits(c.id)).toHaveLength(0);
    } finally {
      fetchSpy.mockRestore();
      errSpy.mockRestore();
      delete process.env.RESEND_API_KEY;
    }
  });
});
