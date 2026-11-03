import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { getMockLastSentTo } from "@/lib/email/adapter";
import { issueRegisterFormToken, REGISTER_FORM_MIN_MS, REGISTER_PER_IP_PER_HOUR, REGISTER_FORM_MAX_USES } from "@/lib/portal-register-guard";

// POST /api/portal/register anti-bot gate + friendlier re-signup (owner 2026-11-03):
// honeypot, page-issued form token with a minimum fill time, per-IP limit, and an unverified address that signs up
// again gets a fresh verification link (200, "check your email") instead of a 409.

let dbReachable = false;
const brokers: string[] = [];
beforeAll(async () => {
  delete process.env.RESEND_API_KEY; // every send goes through the mock adapter
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { dbReachable = false; }
});
afterAll(async () => {
  if (!dbReachable) return;
  await prisma.auditLog.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.client.deleteMany({ where: { brokerId: { in: brokers } } });
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } });
});

async function makeBroker(tag: string) {
  const s = randomUUID().slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `RG ${tag} ${s}`, subdomain: `rg-${tag}-${s}` } });
  brokers.push(b.id);
  return b;
}
const addr = (tag: string) => `rg-${tag}-${randomUUID().slice(0, 8)}@t.local`;
const ipOf = () => `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
// a token as if the page had been served `ageMs` ago
const tokenAged = (ageMs = REGISTER_FORM_MIN_MS + 2_000) => issueRegisterFormToken(Date.now() - ageMs);

async function register(brokerId: string, body: Record<string, unknown>, ip = ipOf()) {
  const { POST } = await import("@/app/api/portal/register/route");
  const res = await POST(new NextRequest("https://test.local/api/portal/register", {
    method: "POST",
    headers: { "content-type": "application/json", "x-broker-id": brokerId, "x-real-ip": ip },
    body: JSON.stringify(body),
  }));
  return { status: res.status, body: await res.json() };
}

describe("POST /api/portal/register: anti-bot", () => {
  it("a filled honeypot answers like a success but creates and sends nothing", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("hp");
    const email = addr("hp");
    const r = await register(broker.id, { email, password: "password123", fullName: "XkQpLmNwRt", website: "http://spam.example", formToken: await tokenAged() });
    expect(r.status).toBe(200);
    expect(r.body.email).toBe(email);
    expect(await prisma.client.count({ where: { brokerId: broker.id, email } })).toBe(0);
    expect(getMockLastSentTo(email)).toBeFalsy();
  });

  it("no form token (a script posting straight to the route) is refused with the reason", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("nt");
    const email = addr("nt");
    const r = await register(broker.id, { email, password: "password123", fullName: "Jane Trader" });
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("FORM_EXPIRED");
    expect(await prisma.client.count({ where: { brokerId: broker.id } })).toBe(0);
  });

  it("an unknown or forged token is refused", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ft");
    const r = await register(broker.id, { email: addr("ft"), password: "password123", fullName: "Jane Trader", formToken: "AAAAAAAAAAAAAAAAAAAAAAAA" });
    expect(r).toMatchObject({ status: 400, body: { code: "FORM_EXPIRED" } });
  });

  it("a token used faster than a person can fill the form is refused with the reason", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("tf");
    const r = await register(broker.id, { email: addr("tf"), password: "password123", fullName: "Jane Trader", formToken: await tokenAged(200) });
    expect(r).toMatchObject({ status: 400, body: { code: "TOO_FAST" } });
    expect(await prisma.client.count({ where: { brokerId: broker.id } })).toBe(0);
  });

  it("a person who fixes a typo can send again from the same page, up to the token's use budget", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ru");
    const formToken = await tokenAged();
    const ip = ipOf();
    const short = await register(broker.id, { email: addr("ru"), password: "short", fullName: "Jane Trader", formToken }, ip);
    expect(short.status).toBe(400);
    const ok = await register(broker.id, { email: addr("ru"), password: "password123", fullName: "Jane Trader", formToken }, ip);
    expect(ok.status).toBe(200);
    expect(await prisma.client.count({ where: { brokerId: broker.id } })).toBe(1);
    // (each from its own address, so the per-IP limit is not what refuses the last one)
    for (let i = 2; i < REGISTER_FORM_MAX_USES; i++) await register(broker.id, { email: "bad", password: "x", fullName: "", formToken });
    const over = await register(broker.id, { email: addr("ru"), password: "password123", fullName: "Jane Trader", formToken });
    expect(over).toMatchObject({ status: 400, body: { code: "FORM_EXPIRED" } });
  });

  it("a real sign-up with a valid token creates the client and sends the link", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ok");
    const email = addr("ok");
    const r = await register(broker.id, { email, password: "password123", fullName: "Jane Trader", website: "", formToken: await tokenAged() });
    expect(r.status).toBe(200);
    const c = await prisma.client.findUnique({ where: { brokerId_email: { brokerId: broker.id, email } } });
    expect(c?.emailVerifiedAt).toBeNull();
    expect(getMockLastSentTo(email)?.text).toMatch(/token=/);
  });

  it(`the same network is limited to ${REGISTER_PER_IP_PER_HOUR} sign-ups an hour`, async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("ip");
    const ip = ipOf();
    for (let i = 0; i < REGISTER_PER_IP_PER_HOUR; i++) {
      const r = await register(broker.id, { email: addr("ip"), password: "password123", fullName: "Jane Trader", formToken: await tokenAged() }, ip);
      expect(r.status).toBe(200);
    }
    const over = await register(broker.id, { email: addr("ip"), password: "password123", fullName: "Jane Trader", formToken: await tokenAged() }, ip);
    expect(over.status).toBe(429);
    const other = await register(broker.id, { email: addr("ip"), password: "password123", fullName: "Jane Trader", formToken: await tokenAged() });
    expect(other.status).toBe(200);
  });
});

describe("POST /api/portal/register: re-signup", () => {
  it("an unverified address that signs up again gets a fresh link (200), no second row, details unchanged, audited", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("rs");
    const email = addr("rs");
    const first = await prisma.client.create({ data: { brokerId: broker.id, email, passwordHash: "orig-hash", fullName: "Original Name", status: "ACTIVE" } });
    const r = await register(broker.id, { email: email.toUpperCase(), password: "password123", fullName: "Other Name", formToken: await tokenAged() });
    expect(r).toEqual({ status: 200, body: { email } });
    expect(getMockLastSentTo(email)?.text).toMatch(/token=/);
    const after = await prisma.client.findMany({ where: { brokerId: broker.id, email } });
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first.id, passwordHash: "orig-hash", fullName: "Original Name" });
    const audits = await prisma.auditLog.findMany({ where: { action: "CLIENT_VERIFICATION_RESENT", entityId: first.id } });
    expect(audits).toHaveLength(1);
    expect(audits[0].newValue).toMatchObject({ via: "register" });
  });

  it("a verified address still gets the 409 'try logging in'", async () => {
    if (!dbReachable) return;
    const broker = await makeBroker("vf");
    const email = addr("vf");
    await prisma.client.create({ data: { brokerId: broker.id, email, passwordHash: "x", fullName: "Done Verified", status: "ACTIVE", emailVerifiedAt: new Date() } });
    const r = await register(broker.id, { email, password: "password123", fullName: "Done Verified", formToken: await tokenAged() });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/try logging in/);
  });
});
