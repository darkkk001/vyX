import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Room Deposit (owner 2026-11-12, QoreTrader test client: no live account, no KYC, so the page showed no methods and
// "Open a live account first"). Against a real database:
//  1. the method grid always has data, also with no live account and no wallet (GET /api/room/funds?account=wallet);
//  2. identity not verified: the server refuses the deposit request, to a live account or the wallet, and creates nothing;
//  3. the To list is the wallet, the live and the demo accounts (page source);
//  4. a demo account is topped up at once by the dashboard Top up route, capped at 100,000;
//  5. KYC approved and no live account: the first deposit request creates the wallet and goes to it.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let methodId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("deposit-kyc-wallet.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Dk ${s}`, subdomain: `dk-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, isClientSelectable: true, isDefault: true, category: "B_BOOK" } })).id;
  methodId = (await prisma.paymentMethod.create({ data: { brokerId, type: "USDT_BEP20", enabled: true, listed: true, minAmount: 10, maxAmount: 200000, walletAddress: "0xabc", processingTime: "Instant-15 min" } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(opts: { kyc?: "APPROVED" | "PENDING" | null; accounts?: ("LIVE" | "DEMO")[] }) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `dk-${n}-${s}@t.local`, passwordHash: "x", fullName: "Dk Test" } });
  if (opts.kyc) await prisma.clientKycRecord.create({ data: { clientId: c.id, status: opts.kyc, documentType: "passport", documentFrontUrl: "x" } });
  const accounts = [];
  for (const [i, mode] of (opts.accounts ?? []).entries()) {
    accounts.push(await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `7${Date.now() % 1_000_000}${n}${i}`, email: c.email, passwordHash: "x", fullName: "Dk Test", accountMode: mode, groupId, leverage: 100, balance: mode === "DEMO" ? 10_000 : 0 } }));
  }
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId, name: "Dk" } } } as never);
  return { c, accounts };
}
async function funds(account: string) {
  const { GET } = await import("@/app/api/room/funds/route");
  const r = await GET(new NextRequest(`https://t.local/api/room/funds?account=${account}`));
  return { status: r.status, body: await r.json() };
}
async function deposit(accountId: string, reference: string, amount = "50") {
  const { POST } = await import("@/app/api/room/deposit/route");
  const r = await POST(new NextRequest("https://t.local/api/room/deposit", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: randomUUID().replace(/-/g, ""), accountId, methodId, amount, reference }) }));
  return { status: r.status, body: await r.json() };
}
async function topUp(accountId: string, amount: string) {
  const { POST } = await import("@/app/api/room/accounts/[id]/top-up/route");
  const r = await POST(new NextRequest(`https://t.local/api/room/accounts/${accountId}/top-up`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: randomUUID().replace(/-/g, ""), amount }) }), { params: Promise.resolve({ id: accountId }) });
  return { status: r.status, body: await r.json() };
}
const walletOf = (clientId: string) => prisma.account.findFirst({ where: { clientId, isWallet: true }, select: { id: true, accountNumber: true, balance: true } });

describe("Deposit: no live account, identity not verified", () => {
  it("1. the wallet's methods and a payment reference load before the wallet exists, and the read creates nothing", async () => {
    if (!dbReachable) return;
    const { c } = await client({ kyc: null, accounts: ["DEMO"] });
    const f = await funds("wallet");
    expect(f.status).toBe(200);
    expect(f.body.account).toMatchObject({ id: "wallet", accountNumber: "WALLET", mode: "LIVE", currency: "USD" });
    expect(f.body.methods.map((m: { type: string }) => m.type)).toEqual(["USDT_BEP20"]);
    expect(f.body.reference).toMatch(/^DEP-WALLET-[2-9A-HJ-NP-Z]{4}$/);
    expect(f.body.kyc).toBe("NONE");
    expect(await walletOf(c.id)).toBeNull();
  });
  it("2. the deposit request is refused until KYC is approved, to the wallet or a live account, and no wallet is created", async () => {
    if (!dbReachable) return;
    const { c, accounts } = await client({ kyc: "PENDING", accounts: ["LIVE"] });
    const toWallet = await deposit("wallet", (await funds("wallet")).body.reference);
    expect(toWallet).toMatchObject({ status: 403, body: { code: "KYC_REQUIRED", error: "Verify your identity to deposit." } });
    expect(await walletOf(c.id)).toBeNull();
    const toLive = await deposit(accounts[0].id, (await funds(accounts[0].id)).body.reference);
    expect(toLive.status).toBe(403);
    expect(await prisma.transaction.count({ where: { account: { clientId: c.id }, type: "DEPOSIT" } })).toBe(0);
  });
});

describe("Deposit: KYC approved, no live account", () => {
  it("5. the first request creates the funding wallet and goes to it, keeping the reference the page showed", async () => {
    if (!dbReachable) return;
    const { c } = await client({ kyc: "APPROVED", accounts: ["DEMO"] });
    const ref = (await funds("wallet")).body.reference;
    const r = await deposit("wallet", ref);
    expect(r.status).toBe(201);
    expect(r.body.reference).toBe(ref);
    const w = await walletOf(c.id);
    expect(w).not.toBeNull();
    const tx = await prisma.transaction.findUniqueOrThrow({ where: { id: r.body.id }, select: { accountId: true, type: true, status: true, paymentReference: true } });
    expect(tx).toEqual({ accountId: w!.id, type: "DEPOSIT", status: "PENDING", paymentReference: ref });
    // the wallet exists now: the page reads it by its id and gets references with its number
    const f = await funds("wallet");
    expect(f.body.account.id).toBe(w!.id);
    expect(f.body.reference.startsWith(`DEP-${w!.accountNumber}-`)).toBe(true);
  });
});

describe("Deposit: a demo account", () => {
  it("4. topped up at once by the Top up route (no KYC, no approval), never past 100,000; the deposit request route stays live-only", async () => {
    if (!dbReachable) return;
    const { accounts } = await client({ kyc: null, accounts: ["DEMO"] });
    const demo = accounts[0];
    const r = await topUp(demo.id, "5000");
    expect(r.status).toBe(201);
    expect(r.body.balance).toBe("15000.00");
    expect((await topUp(demo.id, "90000")).status).toBeGreaterThanOrEqual(400);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: demo.id }, select: { balance: true } })).balance.toFixed(2)).toBe("15000.00");
    expect((await deposit(demo.id, "DEP-x-AAAA")).status).toBe(400);
  });
});

describe("Deposit page", () => {
  const page = readFileSync("app/(broker)/room/(shell)/deposit/page.tsx", "utf8");
  const grid = readFileSync("components/room/MethodGrid.tsx", "utf8");
  it("1, 3. the grid always shows; To account = the wallet (also before it exists), the live and the demo accounts; no 'Open a live account first'", () => {
    expect(page).not.toContain("Open a live account first");
    expect(page).toContain("return [wallet, ...data.accounts.filter((a) => a.mode === \"LIVE\").map(acct), ...data.accounts.filter((a) => a.mode === \"DEMO\").map(acct)];");
    expect(page).toContain("id: w?.id ?? WALLET_KEY");
    expect(page).toContain("locked={locked}");
  });
  it("2. identity not verified: every card locked with Verify now, the live form disabled; Withdraw the same", () => {
    expect(page).toContain('const locked = !isDemo && kycStatus !== "APPROVED";');
    expect(page).toContain("disabled={locked || !funds || !method");
    expect(grid).toContain("Verify your identity to {side}");
    expect(grid).toContain('<a className="r-method-verify" href="/room/verify">Verify now</a>');
    expect(readFileSync("app/(broker)/room/(shell)/withdraw/page.tsx", "utf8")).toContain('locked={kycStatus !== "APPROVED"}');
  });
  it("4. demo: no methods, receipt or reference; quick picks 1,000 / 5,000 / 10,000 and Top up through the dashboard route", () => {
    expect(page).toContain("const QUICK = [1_000, 5_000, 10_000];");
    expect(page).toContain("{isDemo ? null : (");
    expect(page).toContain("/api/room/accounts/${encodeURIComponent(account.id)}/top-up");
    expect(page).toContain("const DEMO_CAP = 100_000;");
  });
});

// Withdraw (owner 2026-11-12, same model as Deposit): From = the funding wallet (also before it exists) and the live
// accounts; the cards always show, locked until KYC is approved.
async function withdraw(accountId: string) {
  const { POST } = await import("@/app/api/room/withdraw/route");
  const r = await POST(new NextRequest("https://t.local/api/room/withdraw", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: randomUUID().replace(/-/g, ""), accountId, payoutMethodId: "none", amount: "10" }) }));
  return { status: r.status, body: await r.json() };
}
describe("Withdraw: no live account", () => {
  it("the wallet's payout methods load before it exists (nothing to withdraw), and a withdrawal from it is refused without creating it", async () => {
    if (!dbReachable) return;
    const { c } = await client({ kyc: null, accounts: ["DEMO"] });
    const f = await funds("wallet");
    expect(f.body.methods.length).toBe(1);
    expect(f.body.available).toBe("0.00");
    expect(f.body.kyc).toBe("NONE");
    expect(await withdraw("wallet")).toMatchObject({ status: 400, body: { error: "Not enough balance on the funding wallet." } });
    expect(await walletOf(c.id)).toBeNull();
  });
  it("page: From = the wallet and the live accounts, the cards locked until KYC is approved", () => {
    const w = readFileSync("app/(broker)/room/(shell)/withdraw/page.tsx", "utf8");
    expect(w).toContain("return [wallet, ...live.map((a) => ({ key: a.id, id: a.id, label: a.accountNumber, currency: a.currency, balance: a.figures.balance }))];");
    expect(w).toContain("id: w?.id ?? WALLET_KEY");
    expect(w).toContain('locked={kycStatus !== "APPROVED"}');
    expect(w).toContain("disabled={!funds || !payout || busy || funds.kyc !== \"APPROVED\"}");
  });
});
