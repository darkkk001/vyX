import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Duplicate money requests from the Trader's Room (owner 2026-11-09: two 500 USD WAITING deposits, DEP-50005728-Q6HG and
// DEP-50005728-3TP9, from repeated clicks). Against a real database: the same form key twice, or in parallel, creates
// exactly one row; a different key for the same request within 60 s returns the first one; a failed attempt frees
// its key. Deposit, Withdraw and Transfer.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let bankId = "";
let seq = 0;
const key = () => randomUUID().replace(/-/g, "");
const REF = (n: string, tail: string) => `DEP-${n}-${tail}`;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("funds-once.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Once ${s}`, subdomain: `once-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  bankId = (await prisma.paymentMethod.create({ data: { brokerId, type: "BANK_TRANSFER", enabled: true } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(balance = 1000) {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `once-${n}-${s}@t.local`, passwordHash: "x", fullName: "Once Test" } });
  await prisma.clientKycRecord.create({ data: { clientId: c.id, status: "APPROVED", documentType: "passport", documentFrontUrl: "x" } });
  const mk = (i: number) => prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `6${Date.now() % 1_000_000}${n}${i}`, email: c.email, passwordHash: "x", fullName: "Once Test", accountMode: "LIVE", groupId, leverage: 100, balance } });
  const [a, b] = [await mk(1), await mk(2)];
  const payout = await prisma.clientPayoutMethod.create({ data: { brokerId, clientId: c.id, type: "BANK_TRANSFER", holderName: "Once Test", details: { bank: "B", account: "PK36SCBL0000001123456702", swift: "SCBLPKKA" } } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId } } } as never);
  return { c, a, b, payout };
}
const post = (url: string, body: unknown) => new NextRequest(`https://t.local${url}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
async function call(route: "deposit" | "withdraw" | "transfer", body: object) {
  const mod = route === "deposit" ? await import("@/app/api/room/deposit/route") : route === "withdraw" ? await import("@/app/api/room/withdraw/route") : await import("@/app/api/room/transfer/route");
  const r = await mod.POST(post(`/api/room/${route}`, body));
  return { status: r.status, body: await r.json() };
}
const rows = (accountId: string, type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER_OUT") => prisma.transaction.count({ where: { accountId, type } });

describe("deposit", () => {
  it("a double click (the same key twice) creates one request; the second answer is the first one", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const body = { key: key(), accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, "Q6HG") };
    const first = await call("deposit", body);
    const second = await call("deposit", body);
    expect(first.status).toBe(201);
    expect(second).toEqual({ status: 200, body: { ...first.body, duplicate: true } });
    expect(await rows(a.id, "DEPOSIT")).toBe(1);
  });
  it("two parallel POSTs with the same key create exactly one row", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const body = { key: key(), accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, "3TP9") };
    const got = await Promise.all(Array.from({ length: 6 }, () => call("deposit", body)));
    expect(await rows(a.id, "DEPOSIT")).toBe(1);
    expect(new Set(got.map((g) => g.body.id)).size).toBe(1);
    expect(got.filter((g) => g.status === 201)).toHaveLength(1);
  });
  it("a second form (new key, new reference) with the same amount and method within 60 s returns the first reference", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const first = await call("deposit", { key: key(), accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, "AAAA") });
    const again = await call("deposit", { key: key(), accountId: a.id, methodId: bankId, amount: "500.00", reference: REF(a.accountNumber, "BBBB") });
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, reference: REF(a.accountNumber, "AAAA"), duplicate: true } });
    expect(await rows(a.id, "DEPOSIT")).toBe(1);
    // a different amount is a different request
    expect((await call("deposit", { key: key(), accountId: a.id, methodId: bankId, amount: "250", reference: REF(a.accountNumber, "CCCC") })).status).toBe(201);
    expect(await rows(a.id, "DEPOSIT")).toBe(2);
  });
  it("parallel forms with different keys for the same deposit still create one row", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const tails = ["DDDD", "EEEE", "FFFF", "GGGG"];
    await Promise.all(tails.map((t) => call("deposit", { key: key(), accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, t) })));
    expect(await rows(a.id, "DEPOSIT")).toBe(1);
  });
  it("a refused attempt frees its key: the corrected form goes through with the same key", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    const k = key();
    expect((await call("deposit", { key: k, accountId: a.id, methodId: bankId, amount: "", reference: REF(a.accountNumber, "HHHH") })).body.error).toBe("Enter an amount.");
    expect((await call("deposit", { key: k, accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, "HHHH") })).status).toBe(201);
    expect(await rows(a.id, "DEPOSIT")).toBe(1);
  });
  it("no key: refused, nothing created", async () => {
    if (!dbReachable) return;
    const { a } = await client();
    expect(await call("deposit", { accountId: a.id, methodId: bankId, amount: "500", reference: REF(a.accountNumber, "JJJJ") })).toEqual({ status: 400, body: { error: "Reload the page and try again." } });
    expect(await rows(a.id, "DEPOSIT")).toBe(0);
  });
});

describe("withdraw", () => {
  it("a double click and parallel POSTs with the same key create exactly one request", async () => {
    if (!dbReachable) return;
    const { a, payout } = await client();
    const body = { key: key(), accountId: a.id, payoutMethodId: payout.id, amount: "100" };
    const got = await Promise.all(Array.from({ length: 6 }, () => call("withdraw", body)));
    const again = await call("withdraw", body);
    expect(await rows(a.id, "WITHDRAWAL")).toBe(1);
    expect(new Set([...got, again].map((g) => g.body.id)).size).toBe(1);
    expect(again.body.duplicate).toBe(true);
  });
  it("the same withdrawal from a new form within 60 s returns the first one", async () => {
    if (!dbReachable) return;
    const { a, payout } = await client();
    const first = await call("withdraw", { key: key(), accountId: a.id, payoutMethodId: payout.id, amount: "100" });
    const again = await call("withdraw", { key: key(), accountId: a.id, payoutMethodId: payout.id, amount: "100" });
    expect(again).toMatchObject({ status: 200, body: { id: first.body.id, duplicate: true } });
    expect(await rows(a.id, "WITHDRAWAL")).toBe(1);
  });
});

describe("transfer (instant money)", () => {
  it("a double click and parallel POSTs with the same key move the money once", async () => {
    if (!dbReachable) return;
    const { a, b } = await client(1000);
    const body = { key: key(), fromId: a.id, toId: b.id, amount: "300" };
    const got = await Promise.all(Array.from({ length: 6 }, () => call("transfer", body)));
    const again = await call("transfer", body);
    expect(await rows(a.id, "TRANSFER_OUT")).toBe(1);
    expect(new Set([...got, again].map((g) => g.body.id)).size).toBe(1);
    const bal = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance.toFixed(2);
    expect([await bal(a.id), await bal(b.id)]).toEqual(["700.00", "1300.00"]);
  });
  it("the same transfer from new forms within 60 s, even in parallel, moves the money once", async () => {
    if (!dbReachable) return;
    const { a, b } = await client(1000);
    await Promise.all(Array.from({ length: 4 }, () => call("transfer", { key: key(), fromId: a.id, toId: b.id, amount: "300" })));
    expect(await rows(a.id, "TRANSFER_OUT")).toBe(1);
  });
});
