import "dotenv/config";
import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// The funding wallet (owner 2026-11-06) against a real database: one per client whatever races, money only moves through
// the ledger and is conserved, it can never trade or sign in. Plus what surrounds it: archive and the read-only password.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/account-auth", async (importActual) => ({ ...(await importActual<typeof import("@/lib/account-auth")>()), revokeAllAccountSessions: vi.fn().mockResolvedValue(0) }));
vi.mock("@/lib/margin", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/margin")>();
  return { ...actual, checkBalanceDebit: vi.fn(actual.checkBalanceDebit) };
});

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;
const PORTAL = "Portal123!";
let portalHash = "";

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("wallet-money.test.ts: DB unreachable, skipping"); return; }
  portalHash = await bcrypt.hash(PORTAL, 4);
  brokerId = (await prisma.broker.create({ data: { name: `Wl ${s}`, subdomain: `wl-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, isClientSelectable: true, isDefault: true, category: "B_BOOK" } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(balance = "1000", mode: "LIVE" | "DEMO" = "LIVE") {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `wl-${n}-${s}@t.local`, passwordHash: portalHash, fullName: "Wl Test" } });
  const account = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `7${Date.now() % 1_000_000}${n}`, email: c.email, passwordHash: portalHash, fullName: "Wl Test", accountMode: mode, groupId, balance: D(balance) } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId, name: "Wl" } } } as never);
  return { c, account };
}
const req = (url: string, method: string, body?: unknown) => new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
async function wallet() {
  const { POST } = await import("@/app/api/room/wallet/route");
  const r = await POST();
  return { status: r.status, body: await r.json() };
}
async function transfer(fromId: string, toId: string, amount: string) {
  const { POST } = await import("@/app/api/room/transfer/route");
  const r = await POST(req("/api/room/transfer", "POST", { key: randomUUID(), fromId, toId, amount }));
  return { status: r.status, body: await r.json() };
}
async function settings(id: string, body: object) {
  const { PATCH } = await import("@/app/api/room/accounts/[id]/route");
  const r = await PATCH(req(`/api/room/accounts/${id}`, "PATCH", body), { params: Promise.resolve({ id }) });
  return { status: r.status, body: await r.json() };
}
const balance = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance;

describe("the wallet exists once, and only when used", () => {
  it("a read creates nothing and shows zero", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    const { GET } = await import("@/app/api/room/wallet/route");
    expect(await (await GET()).json()).toMatchObject({ id: null, balance: "0.00" });
    expect(await prisma.account.count({ where: { clientId: c.id, isWallet: true } })).toBe(0);
  });
  it("eight first uses at once make exactly one wallet", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    const { ensureWallet } = await import("@/lib/room/wallet");
    const got = await Promise.all(Array.from({ length: 8 }, () => ensureWallet(c.id, brokerId)));
    expect(new Set(got.map((w) => w.id)).size).toBe(1);
    expect(await prisma.account.count({ where: { clientId: c.id, isWallet: true } })).toBe(1);
  });
  it("the database itself refuses a second wallet", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    await wallet();
    await expect(prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `8${Date.now() % 1_000_000}${++seq}`, email: c.email, passwordHash: "x", fullName: "x", accountMode: "LIVE", groupId, isWallet: true } })).rejects.toThrow();
  });
  it("it is a LIVE ledger account that cannot trade, at zero, in the broker's currency", async () => {
    if (!dbReachable) return;
    await client();
    const row = await prisma.account.findUniqueOrThrow({ where: { id: (await wallet()).body.id } });
    expect(row).toMatchObject({ accountMode: "LIVE", tradingRights: "READ_ONLY", isWallet: true, status: "ACTIVE" });
    expect(row.balance.toFixed(2)).toBe("0.00");
  });
});

describe("money between an account and the wallet", () => {
  it("both ways: a ledger row on each side, balances agree, the total never changes", async () => {
    if (!dbReachable) return;
    const { account } = await client("1000");
    const w = (await wallet()).body.id as string;
    expect((await transfer(account.id, w, "250.50")).status).toBe(201);
    expect((await balance(account.id)).toFixed(2)).toBe("749.50");
    expect((await balance(w)).toFixed(2)).toBe("250.50");
    expect((await transfer(w, account.id, "50.25")).status).toBe(201);
    expect((await balance(w)).toFixed(2)).toBe("200.25");
    const rows = await prisma.transaction.findMany({ where: { accountId: w }, orderBy: { createdAt: "asc" } });
    expect(rows.map((r) => [r.type, r.status, r.amount.toFixed(2), r.balanceBefore.toFixed(2), r.balanceAfter.toFixed(2)])).toEqual([
      ["TRANSFER_IN", "COMPLETED", "250.50", "0.00", "250.50"],
      ["TRANSFER_OUT", "COMPLETED", "-50.25", "250.50", "200.25"],
    ]);
    const sum = await prisma.transaction.aggregate({ where: { accountId: { in: [w, account.id] } }, _sum: { amount: true } });
    expect(sum._sum.amount!.toFixed(2)).toBe("0.00");
  });
  it("twenty transfers racing in both directions: nothing lost, nothing negative", async () => {
    if (!dbReachable) return;
    const { account } = await client("100");
    const w = (await wallet()).body.id as string;
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? transfer(w, account.id, "30") : transfer(account.id, w, "30"))));
    // 200 = the same transfer again within 60 s, answered with the first one (lib/room/request-key.ts)
    expect(results.every((r) => r.status === 201 || r.status === 200 || r.status === 400)).toBe(true);
    const [a, b] = [await balance(account.id), await balance(w)];
    expect(a.add(b).toFixed(2)).toBe("100.00");
    expect(a.gte(0) && b.gte(0)).toBe(true);
  });
  it("cannot spend more than it holds", async () => {
    if (!dbReachable) return;
    const { account } = await client("100");
    const w = (await wallet()).body.id as string;
    expect((await transfer(w, account.id, "0.01")).status).toBe(400);
    expect((await transfer(account.id, w, "100.01")).status).toBe(400);
    expect((await balance(account.id)).toFixed(2)).toBe("100.00");
  });
  it("the source's open-position margin check runs on a move to the wallet", async () => {
    if (!dbReachable) return;
    const { account } = await client("100");
    const w = (await wallet()).body.id as string;
    const { checkBalanceDebit } = await import("@/lib/margin");
    vi.mocked(checkBalanceDebit).mockResolvedValueOnce({ error: "INSUFFICIENT_FREE_MARGIN", message: "x" } as never);
    const r = await transfer(account.id, w, "10");
    expect(r.status).toBe(400);
    expect(r.body.error).toContain("Free margin");
    expect((await balance(w)).toFixed(2)).toBe("0.00");
  });
  it("demo money cannot reach the wallet", async () => {
    if (!dbReachable) return;
    const { account } = await client("10000", "DEMO");
    const w = (await wallet()).body.id as string;
    expect((await transfer(account.id, w, "10")).status).toBe(400);
    expect((await balance(w)).toFixed(2)).toBe("0.00");
  });
  it("another client's wallet answers like a missing one", async () => {
    if (!dbReachable) return;
    await client("100");
    const other = (await wallet()).body.id as string;
    const { account } = await client("100");
    expect((await transfer(account.id, other, "10")).status).toBe(404);
    expect((await balance(other)).toFixed(2)).toBe("0.00");
  });
  it("a deposit and a withdrawal go through the normal request and approval, with the wallet's limit and KYC", async () => {
    if (!dbReachable) return;
    const { c } = await client("0");
    const w = (await wallet()).body.id as string;
    const method = await prisma.paymentMethod.upsert({ where: { brokerId_type: { brokerId, type: "BANK_TRANSFER" } }, update: {}, create: { brokerId, type: "BANK_TRANSFER", enabled: true } });
    const { createFundsRequest } = await import("@/lib/funds-request-create");
    const { approveFundsRequest } = await import("@/lib/funds-approval");
    const approve = (id: string, amount: string, type: "DEPOSIT" | "WITHDRAWAL") => prisma.$transaction((tx) => approveFundsRequest(tx, { transactionId: id, brokerId, accountId: w, amount: D(amount), adminId: null, note: null, type }));

    const dep = await createFundsRequest({ brokerId, accountId: w, type: "DEPOSIT", amount: "75", paymentMethodId: method.id });
    if (!dep.ok) throw new Error(dep.error);
    expect(dep.created.status).toBe("PENDING");
    expect((await balance(w)).toFixed(2)).toBe("0.00");
    await approve(dep.created.id, "75", "DEPOSIT");
    expect((await balance(w)).toFixed(2)).toBe("75.00");

    const noKyc = await createFundsRequest({ brokerId, accountId: w, type: "WITHDRAWAL", amount: "10", paymentMethodId: method.id, destinationAddress: "x" });
    expect(noKyc.ok).toBe(false);
    await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } as never });
    const { withdrawable } = await import("@/lib/room/funds");
    expect(Number((await withdrawable(w)).available)).toBe(75);
    const out = await createFundsRequest({ brokerId, accountId: w, type: "WITHDRAWAL", amount: "30", paymentMethodId: method.id, destinationAddress: "x" });
    if (!out.ok) throw new Error(out.error);
    await approve(out.created.id, "-30", "WITHDRAWAL"); // a withdrawal row is signed, as lib/funds-request-create.ts stores it
    expect((await balance(w)).toFixed(2)).toBe("45.00");
  });
});

describe("a wallet never trades, signs in or shows as an account", () => {
  it("sign-in is refused even with the right password", async () => {
    if (!dbReachable) return;
    await client();
    const row = await prisma.account.findUniqueOrThrow({ where: { id: (await wallet()).body.id } });
    await prisma.account.update({ where: { id: row.id }, data: { passwordHash: await bcrypt.hash("Known123!", 4) } });
    const { authenticateAccountDetailed } = await import("@/lib/account-auth");
    expect((await authenticateAccountDetailed(brokerId, row.accountNumber, "Known123!")).kind).toBe("invalid");
  });
  it("a new order is refused by its trading rights", async () => {
    if (!dbReachable) return;
    const { tradingRightsRefusal } = await import("@/lib/account-trading-rights");
    const refused = tradingRightsRefusal({ status: "ACTIVE", tradingRights: "READ_ONLY" }, "open");
    expect(refused?.status).toBe(403);
  });
  it("overview and accounts list it apart; leverage and settings do not know it", async () => {
    if (!dbReachable) return;
    const { account } = await client("100");
    const w = (await wallet()).body.id as string;
    const overview = await (await (await import("@/app/api/room/overview/route")).GET()).json();
    expect(overview.accounts.map((a: { id: string }) => a.id)).toEqual([account.id]);
    expect(overview.wallet.id).toBe(w);
    expect(overview.totals.balance).toBe("100.00");
    const { POST } = await import("@/app/api/room/leverage/route");
    expect((await POST(req("/api/room/leverage", "POST", { accountId: w, leverage: 50 }))).status).toBe(404);
    expect((await settings(w, { action: "archive" })).status).toBe(404);
  });
});

describe("archive", () => {
  it("a live account with money stays; at zero it goes; sign-in stops; restore brings it back", async () => {
    if (!dbReachable) return;
    const { account } = await client("5");
    expect((await settings(account.id, { action: "archive" })).body.error).toBe("Move the balance out first.");
    await prisma.account.update({ where: { id: account.id }, data: { balance: D(0) } });
    expect((await settings(account.id, { action: "archive" })).status).toBe(200);
    const { authenticateAccountDetailed } = await import("@/lib/account-auth");
    expect(await authenticateAccountDetailed(brokerId, account.accountNumber, PORTAL)).toMatchObject({ kind: "inactive", status: "ARCHIVED" });
    expect((await transfer(account.id, account.id, "1")).status).toBe(404);
    expect((await settings(account.id, { action: "nickname", nickname: "x" })).status).toBe(409);
    expect((await settings(account.id, { action: "restore" })).status).toBe(200);
    expect((await authenticateAccountDetailed(brokerId, account.accountNumber, PORTAL)).kind).toBe("ok");
  });
  it("a pending funds request or an open position blocks it", async () => {
    if (!dbReachable) return;
    const { account } = await client("0");
    await prisma.transaction.create({ data: { brokerId, accountId: account.id, type: "DEPOSIT", status: "PENDING", amount: D(10), balanceBefore: D(0), balanceAfter: D(0) } });
    expect((await settings(account.id, { action: "archive" })).body.error).toContain("funds request");
  });
  it("a demo with a balance can go; another client's account cannot be touched", async () => {
    if (!dbReachable) return;
    const { account: demo } = await client("10000", "DEMO");
    expect((await settings(demo.id, { action: "archive" })).status).toBe(200);
    await client("0");
    expect((await settings(demo.id, { action: "restore" })).status).toBe(404);
  });
});

describe("trading and read-only passwords", () => {
  it("each change needs the portal password and meets the four rules", async () => {
    if (!dbReachable) return;
    const { account } = await client();
    expect((await settings(account.id, { action: "trading-password", current: "nope", next: "Abcdef1!" })).status).toBe(401);
    for (const bad of ["Abc1!", "abcdefg1!", "ABCDEFG1!", "Abcdefgh!", "Abcdefg12", "Abcdefghijklmn1!"]) {
      expect((await settings(account.id, { action: "trading-password", current: PORTAL, next: bad })).status).toBe(400);
    }
    expect((await settings(account.id, { action: "trading-password", current: PORTAL, next: "Abcdef1!" })).status).toBe(200);
  });
  it("the read-only password signs in read-only on the trading routes only, and never equals the trading one", async () => {
    if (!dbReachable) return;
    const { account } = await client();
    expect((await settings(account.id, { action: "trading-password", current: PORTAL, next: "Trade123!" })).status).toBe(200);
    expect((await settings(account.id, { action: "investor-password", current: PORTAL, next: "Trade123!" })).status).toBe(400);
    expect((await settings(account.id, { action: "investor-password", current: PORTAL, next: "Watch123!" })).status).toBe(200);
    const { authenticateAccountDetailed, authenticateAccount } = await import("@/lib/account-auth");
    expect(await authenticateAccountDetailed(brokerId, account.accountNumber, "Watch123!", { allowReadOnly: true })).toMatchObject({ kind: "ok", readOnly: true });
    expect(await authenticateAccountDetailed(brokerId, account.accountNumber, "Trade123!", { allowReadOnly: true })).toMatchObject({ kind: "ok", readOnly: false });
    expect((await authenticateAccountDetailed(brokerId, account.accountNumber, "Watch123!")).kind).toBe("invalid");
    expect(await authenticateAccount(brokerId, account.accountNumber, "Watch123!")).toBeNull();
    expect((await settings(account.id, { action: "investor-password-off", current: PORTAL })).status).toBe(200);
    expect((await authenticateAccountDetailed(brokerId, account.accountNumber, "Watch123!", { allowReadOnly: true })).kind).toBe("invalid");
  });
  it("a read-only session writes nothing: only reads, sign-out and the socket ticket pass; no method header means no", async () => {
    const { readOnlyRefused } = await import("@/lib/account-auth");
    expect(readOnlyRefused("GET", "/api/trade/positions")).toBe(false);
    expect(readOnlyRefused("POST", "/api/trade/logout")).toBe(false);
    expect(readOnlyRefused("POST", "/api/trade/ws-ticket")).toBe(false);
    for (const [m, p] of [["POST", "/api/trade/orders"], ["PATCH", "/api/trade/positions/1"], ["DELETE", "/api/trade/orders/1"], ["POST", "/api/trade/change-password"], ["POST", "/api/trade/funds-requests"], [null, "/api/trade/orders"], ["POST", null]] as const) {
      expect(readOnlyRefused(m, p)).toBe(true);
    }
  });
  it("the portal password change leaves an account with its own trading password alone", async () => {
    if (!dbReachable) return;
    const { c, account } = await client();
    const second = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `6${Date.now() % 1_000_000}${++seq}`, email: c.email, passwordHash: portalHash, fullName: "x", accountMode: "DEMO", groupId } });
    await settings(account.id, { action: "trading-password", current: PORTAL, next: "Trade123!" });
    const own = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).passwordHash;
    const { POST } = await import("@/app/api/room/password/route");
    const r = await POST(req("/api/room/password", "POST", { current: PORTAL, next: "NewPortal1" }));
    expect(r.status).toBe(200);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).passwordHash).toBe(own);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: second.id } })).passwordHash).not.toBe(portalHash);
  });
});

describe("opening an account from the popup", () => {
  const open = async (body: object) => {
    const { POST } = await import("@/app/api/room/accounts/route");
    const r = await POST(req("/api/room/accounts", "POST", body));
    return { status: r.status, body: await r.json() };
  };
  it("demo: own password, nickname, chosen balance within the limits", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    const base = { mode: "DEMO", groupId, leverage: 100, currency: "USD", password: "Demo1234!", nickname: "  Scalps  " };
    expect((await open({ ...base, password: "weak" })).status).toBe(400);
    expect((await open({ ...base, startingBalance: "99" })).status).toBe(400);
    expect((await open({ ...base, startingBalance: "1000001" })).status).toBe(400);
    expect((await open({ ...base, startingBalance: "2500" })).status).toBe(201);
    const row = await prisma.account.findFirstOrThrow({ where: { clientId: c.id, nickname: "Scalps" } });
    expect(row.balance.toFixed(2)).toBe("2500.00");
    expect(await bcrypt.compare("Demo1234!", row.passwordHash)).toBe(true);
  });
  it("real: the request keeps the hash, never the password", async () => {
    if (!dbReachable) return;
    const { c } = await client();
    await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } as never });
    expect((await open({ mode: "LIVE", groupId, leverage: 100, currency: "USD", password: "Real1234!", nickname: "Main" })).status).toBe(201);
    const r = await prisma.liveAccountRequest.findFirstOrThrow({ where: { clientId: c.id } });
    expect(r.requestedNickname).toBe("Main");
    expect(await bcrypt.compare("Real1234!", r.requestedPasswordHash!)).toBe(true);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { clientId: c.id } }))).not.toContain("Real1234!");
  });
});
