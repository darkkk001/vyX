import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Staking, money first: the amount leaves free margin, the ledger keeps the terms it was opened on, the payout happens once
// even if run twice at the same moment, and it happens even after the broker switched the feature off.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/auth")>()), getAdminSession: vi.fn() }));

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("staking.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `St ${s}`, subdomain: `st-${s}`, stakingEnabled: true } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(opts: { kyc?: "APPROVED" | "PENDING" | null; balance?: number; mode?: "LIVE" | "DEMO" } = {}) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `s-${n}-${s}@t.local`, passwordHash: "x", fullName: "S" } });
  if (opts.kyc !== null) await prisma.clientKycRecord.create({ data: { clientId: c.id, status: opts.kyc ?? "APPROVED", documentType: "passport", documentFrontUrl: "f", documentBackUrl: "b", annualIncome: "UNDER_25K", sourceOfFunds: "SALARY", tradingExperience: "NONE", employmentStatus: "EMPLOYED", riskTolerance: "LOW" } });
  const a = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `4${Date.now() % 1_000_000}${n}`, email: c.email, passwordHash: "x", fullName: "S", accountMode: opts.mode ?? "LIVE", groupId, leverage: 100, balance: D(opts.balance ?? 5000) } });
  return { c, a };
}
async function post(clientId: string, body: object) {
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
  const { POST } = await import("@/app/api/room/staking/route");
  const r = await POST(new NextRequest("https://t.local/api/room/staking", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
  return { status: r.status, body: await r.json() };
}
async function view(clientId: string) {
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
  const { GET } = await import("@/app/api/room/staking/route");
  const r = await GET();
  return { status: r.status, body: await r.json() };
}
const balance = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).balance.toFixed(2);
const ended = (id: string) => prisma.stake.update({ where: { id }, data: { endAt: new Date(Date.now() - 1000) } });

describe("opening a stake", () => {
  it("moves the amount out, keeps the terms, and the return is 10% of it", async () => {
    if (!dbReachable) return;
    const { c, a } = await client();
    const r = await post(c.id, { accountId: a.id, amount: "1000" });
    expect(r.status).toBe(201);
    expect(await balance(a.id)).toBe("4000.00");
    const st = await prisma.stake.findUniqueOrThrow({ where: { id: r.body.id } });
    expect([st.amount.toFixed(2), st.returnAmount.toFixed(2), st.ratePct.toString(), st.cycleDays, st.status]).toEqual(["1000.00", "100.00", "10", 14, "ACTIVE"]);
    expect(st.endAt.getTime() - st.startAt.getTime()).toBe(14 * 86400e3);
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: st.openTransactionId } });
    expect([t.type, t.amount.toFixed(2), t.balanceBefore.toFixed(2), t.balanceAfter.toFixed(2)]).toEqual(["STAKE_OUT", "-1000.00", "5000.00", "4000.00"]);
  });
  it("refuses below the minimum, above free margin, without approved KYC, on a demo and on another client's account", async () => {
    if (!dbReachable) return;
    const { c, a } = await client({ balance: 2000 });
    expect((await post(c.id, { accountId: a.id, amount: "999.99" })).body.error).toContain("minimum");
    expect((await post(c.id, { accountId: a.id, amount: "2000.01" })).body.error).toContain("free margin");
    const pending = await client({ kyc: "PENDING" });
    expect((await post(pending.c.id, { accountId: pending.a.id, amount: "1000" })).status).toBe(403);
    const none = await client({ kyc: null });
    expect((await post(none.c.id, { accountId: none.a.id, amount: "1000" })).body.error).toBe("Available after verification.");
    const demo = await client({ mode: "DEMO" });
    expect((await post(demo.c.id, { accountId: demo.a.id, amount: "1000" })).status).toBe(400);
    expect((await post(c.id, { accountId: demo.a.id, amount: "1000" })).status).toBe(404);
    expect(await balance(a.id)).toBe("2000.00");
  });
  it("two stakes at once cannot spend the same money", async () => {
    if (!dbReachable) return;
    const { c, a } = await client({ balance: 1500 });
    const { openStake } = await import("@/lib/room/staking");
    const r = await Promise.allSettled([1, 2].map(() => openStake({ brokerId, clientId: c.id, accountId: a.id, amount: D(1000) })));
    expect(r.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(await balance(a.id)).toBe("500.00");
  });
  it("a change of the plan leaves a running stake alone", async () => {
    if (!dbReachable) return;
    const { c, a } = await client();
    const r = await post(c.id, { accountId: a.id, amount: "1000" });
    await prisma.broker.update({ where: { id: brokerId }, data: { stakingRatePct: D(2), stakingCycleDays: 30 } });
    const later = await post(c.id, { accountId: a.id, amount: "1000" });
    const [one, two] = await Promise.all([r.body.id, later.body.id].map((id) => prisma.stake.findUniqueOrThrow({ where: { id } })));
    expect([one.returnAmount.toFixed(2), one.cycleDays]).toEqual(["100.00", 14]);
    expect([two.returnAmount.toFixed(2), two.cycleDays]).toEqual(["20.00", 30]);
    await prisma.broker.update({ where: { id: brokerId }, data: { stakingRatePct: D(10), stakingCycleDays: 14 } });
  });
});

describe("the payout", () => {
  it("nothing is paid early; at the end principal and return come back as one Staking return, shown in History", async () => {
    if (!dbReachable) return;
    const { payDueStakes } = await import("@/lib/room/staking");
    const { c, a } = await client();
    const r = await post(c.id, { accountId: a.id, amount: "2000" });
    await payDueStakes();
    expect(await balance(a.id)).toBe("3000.00");
    await ended(r.body.id);
    await payDueStakes();
    expect(await balance(a.id)).toBe("5200.00");
    const st = await prisma.stake.findUniqueOrThrow({ where: { id: r.body.id } });
    expect(st.status).toBe("PAID");
    const t = await prisma.transaction.findUniqueOrThrow({ where: { id: st.payoutTransactionId! } });
    expect([t.type, t.amount.toFixed(2), t.note]).toEqual(["STAKING_RETURN", "2200.00", "Staking return"]);
    const { roomTransactions } = await import("@/lib/room/transactions");
    const { rows } = await roomTransactions({ accountIds: [a.id] }, new Set([a.accountNumber]), { skip: 0, take: 10 });
    expect(rows.map((x) => [x.type, x.method, x.amount]).sort()).toEqual([["Staking", "Stake", "-2000.00"], ["Staking", "Staking return", "2200.00"]]);
    expect(await prisma.notification.count({ where: { accountId: a.id, type: "STAKING_RETURN" } })).toBe(1);
    const v = await view(c.id);
    expect([v.body.active.length, v.body.history.length]).toEqual([0, 1]);
  });
  it("run twice at the same moment, it pays once", async () => {
    if (!dbReachable) return;
    const { payDueStakes } = await import("@/lib/room/staking");
    const { c, a } = await client();
    const r = await post(c.id, { accountId: a.id, amount: "1000" });
    await ended(r.body.id);
    await Promise.all([payDueStakes(), payDueStakes(), payDueStakes()]);
    expect(await balance(a.id)).toBe("5100.00");
    expect(await prisma.transaction.count({ where: { accountId: a.id, type: "STAKING_RETURN" } })).toBe(1);
  });
  it("a broker that switched the feature off still pays what is running", async () => {
    if (!dbReachable) return;
    const { payDueStakes } = await import("@/lib/room/staking");
    const { c, a } = await client();
    const r = await post(c.id, { accountId: a.id, amount: "1000" });
    await prisma.broker.update({ where: { id: brokerId }, data: { stakingEnabled: false } });
    expect((await post(c.id, { accountId: a.id, amount: "1000" })).status).toBe(404);
    expect((await view(c.id)).status).toBe(404);
    await ended(r.body.id);
    await payDueStakes();
    expect(await balance(a.id)).toBe("5100.00");
    await prisma.broker.update({ where: { id: brokerId }, data: { stakingEnabled: true } });
  });
});

describe("the backoffice view", () => {
  it("shows total staked, stakes per client, upcoming payouts and the settings; another broker sees none of it", async () => {
    if (!dbReachable) return;
    const { c, a } = await client();
    await post(c.id, { accountId: a.id, amount: "1500" });
    const admin = await prisma.adminUser.create({ data: { brokerId, email: `st-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, brokerId, role: "BROKER_ADMIN" } as never);
    const { GET } = await import("@/app/api/manage/staking/route");
    const v = await (await GET()).json();
    expect(v.settings).toMatchObject({ enabled: true, minAmount: "1000.00", cycleDays: 14, ratePct: "10" });
    expect(v.clients.find((x: { clientId: string }) => x.clientId === c.id)).toMatchObject({ stakes: 1, staked: "1500.00" });
    expect(v.upcoming.some((u: { account: string; returnAmount: string }) => u.account === a.accountNumber && u.returnAmount === "150.00")).toBe(true);
    expect(Number(v.totals[0].staked)).toBeGreaterThanOrEqual(1500);
    const other = await prisma.broker.create({ data: { name: `O2 ${s}`, subdomain: `o2-${s}` } });
    const admin2 = await prisma.adminUser.create({ data: { brokerId: other.id, email: `st2-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin2.id, brokerId: other.id, role: "BROKER_ADMIN" } as never);
    expect((await (await GET()).json()).clients).toEqual([]);
  });
});

describe("flag and wording", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("every new broker starts with it off", async () => {
    if (!dbReachable) return;
    const b = await prisma.broker.create({ data: { name: `Off ${s}`, subdomain: `off-${s}` } });
    expect([b.stakingEnabled, b.stakingMinAmount.toFixed(2), b.stakingCycleDays, b.stakingRatePct.toString()]).toEqual([false, "1000.00", 14, "10"]);
  });
  it("carries the broker line and never says guaranteed", () => {
    const page = src("app/(broker)/room/(shell)/staking/page.tsx");
    expect(page).toContain("Rate set by your broker, may change for new stakes");
    expect(page).toContain("Available after verification");
    expect(page.toLowerCase()).not.toContain("guarantee");
  });
});
