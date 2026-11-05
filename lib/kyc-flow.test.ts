import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// KYC end to end (owner 2026-11-06): the decision reaches the client as a bell row and an e-mail, with or without an
// account, and a client's row never shows up in the staff bell. Deposits and withdrawals e-mail too.
const sent = vi.hoisted(() => [] as { to: string; subject: string; text: string }[]);
vi.mock("@/lib/email/adapter", () => ({ sendBrokerEmail: async (_b: unknown, m: { to: string; subject: string; text: string }) => { sent.push(m); return { usedMock: true }; } }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let adminId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("kyc-flow.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Kyc ${s}`, subdomain: `kyc-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  adminId = (await prisma.adminUser.create({ data: { brokerId, email: `a-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } })).id;
});
beforeEach(() => { sent.length = 0; });
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client() {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `k-${n}-${s}@t.local`, passwordHash: "x", fullName: "K" } });
  const rec = await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "PENDING", documentType: "passport", documentFrontUrl: "f", documentBackUrl: "b", annualIncome: "UNDER_25K", sourceOfFunds: "SALARY", tradingExperience: "NONE", employmentStatus: "EMPLOYED", riskTolerance: "LOW" } });
  return { c, rec };
}
const account = (clientId: string, email: string, accountMode: "LIVE" | "DEMO" = "LIVE") => prisma.account.create({ data: { brokerId, clientId, accountNumber: `6${Date.now() % 1_000_000}${++seq}`, email, passwordHash: "x", fullName: "K", accountMode, groupId, leverage: 100, balance: 100 } });
async function decide(id: string, body: object) {
  const { getAdminSession } = await import("@/lib/auth");
  vi.mocked(getAdminSession).mockResolvedValue({ adminId, brokerId, role: "BROKER_ADMIN" } as never);
  const { PATCH } = await import("@/app/api/manage/client-kyc-requests/[id]/route");
  return PATCH(new NextRequest(`https://t.local/api/manage/client-kyc-requests/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });
}
async function bell(clientId: string) {
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
  const { GET } = await import("@/app/api/room/notifications/route");
  return (await GET()).json();
}

describe("a KYC decision reaches the client", () => {
  it("with no account yet: bell row on the client, and the approval e-mail", async () => {
    if (!dbReachable) return;
    const { c, rec } = await client();
    expect((await decide(rec.id, { action: "APPROVE" })).status).toBe(200);
    expect((await prisma.clientKycRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("APPROVED");
    const b = await bell(c.id);
    expect(JSON.stringify(b)).toContain("Your KYC was approved");
    expect(sent.map((m) => [m.to, m.subject])).toEqual([[c.email, "Your verification is approved"]]);
  });
  it("with an account: the row sits on the account and the bell still shows it", async () => {
    if (!dbReachable) return;
    const { c, rec } = await client();
    const a = await account(c.id, c.email);
    await decide(rec.id, { action: "APPROVE" });
    expect(await prisma.notification.count({ where: { accountId: a.id, type: "KYC_APPROVED" } })).toBe(1);
    expect(JSON.stringify(await bell(c.id))).toContain("Your KYC was approved");
  });
  it("a rejection carries the reason in the bell and the e-mail", async () => {
    if (!dbReachable) return;
    const { c, rec } = await client();
    await decide(rec.id, { action: "REJECT", rejectionReason: "Photo is blurred" });
    expect(JSON.stringify(await bell(c.id))).toContain("Photo is blurred");
    expect(sent[0].subject).toBe("Your verification needs attention");
    expect(sent[0].text).toContain("Photo is blurred");
  });
  it("another client's bell shows none of it, and neither does the staff bell", async () => {
    if (!dbReachable) return;
    const { rec } = await client();
    const other = await client();
    await decide(rec.id, { action: "APPROVE" });
    expect(JSON.stringify(await bell(other.c.id))).not.toContain("approved");
    const { unreadStaffNotificationsFor } = await import("@/lib/notification-read");
    const staff = await prisma.notification.findMany({ where: unreadStaffNotificationsFor(brokerId, adminId) });
    expect(staff.filter((n) => n.type.startsWith("KYC_"))).toEqual([]);
  });
  it("a mail outage does not undo or fail the decision", async () => {
    if (!dbReachable) return;
    const adapter = await import("@/lib/email/adapter");
    const spy = vi.spyOn(adapter, "sendBrokerEmail").mockRejectedValueOnce(new Error("mail down"));
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    const { rec } = await client();
    expect((await decide(rec.id, { action: "APPROVE" })).status).toBe(200);
    expect((await prisma.clientKycRecord.findUniqueOrThrow({ where: { id: rec.id } })).status).toBe("APPROVED");
    spy.mockRestore();
    quiet.mockRestore();
  });
});

describe("deposit and withdrawal outcomes e-mail the client", () => {
  const resolve = async (accountId: string, kind: "DEPOSIT" | "WITHDRAWAL", outcome: "APPROVED" | "REJECTED", reviewNote: string | null = null) => {
    const { notifyFundsRequestResolved } = await import("@/lib/funds-events");
    await notifyFundsRequestResolved({ brokerId, accountId, transactionId: "t", kind, outcome, amount: "150.00", reviewNote });
  };
  it("approved and rejected, with amount, currency and reason", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    const a = await account(c.id, c.email);
    await resolve(a.id, "DEPOSIT", "APPROVED");
    await resolve(a.id, "WITHDRAWAL", "REJECTED", "Name does not match");
    expect(sent.map((m) => m.subject)).toEqual(["Your deposit of 150.00 USD was approved", "Your withdrawal of 150.00 USD was rejected"]);
    expect(sent[1].text).toContain("Name does not match");
    expect(sent[0].to).toBe(c.email);
  });
  it("a demo account gets none", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    const a = await account(c.id, c.email, "DEMO");
    await resolve(a.id, "DEPOSIT", "APPROVED");
    expect(sent).toEqual([]);
  });
});
