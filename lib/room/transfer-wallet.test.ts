import "dotenv/config";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";
import { transferItems, transferTargets, itemLabel, WALLET_KEY } from "@/components/room/transfer-items";
import type { RoomAccount } from "@/components/room/RoomData";

// Room Transfer (owner 2026-11-10, C-279 / 50005728: one live account, the To list was empty and the page asked for "a
// second live account"). The funding wallet is in From and To for every client with a live account, before it exists;
// the first transfer into it creates it. Against a real database: one live account, no wallet, 10 USD to the wallet and
// back; both balances and the top-bar money menu (/api/room/money) follow each step.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }) }));
vi.mock("@/lib/nats", async (importActual) => ({ ...(await importActual<typeof import("@/lib/nats")>()), publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let groupId = "";
let seq = 0;

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("transfer-wallet.test.ts: DB unreachable, skipping"); return; }
  brokerId = (await prisma.broker.create({ data: { name: `Tw ${s}`, subdomain: `tw-${s}` } })).id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", displayName: "Standard", leverage: 100, isClientSelectable: true, isDefault: true, category: "B_BOOK" } })).id;
});
afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });

async function client(mode: "LIVE" | "DEMO" = "LIVE") {
  const n = ++seq;
  const c = await prisma.client.create({ data: { brokerId, email: `tw-${n}-${s}@t.local`, passwordHash: "x", fullName: "Tw Test" } });
  const account = await prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `8${Date.now() % 1_000_000}${n}`, email: c.email, passwordHash: "x", fullName: "Tw Test", accountMode: mode, groupId, leverage: 100, balance: 100 } });
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId, name: "Tw" } } } as never);
  return { c, account };
}
async function transfer(fromId: string, toId: string, amount: string) {
  const { POST } = await import("@/app/api/room/transfer/route");
  const r = await POST(new NextRequest("https://t.local/api/room/transfer", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: randomUUID().replace(/-/g, ""), fromId, toId, amount }) }));
  return { status: r.status, body: await r.json() };
}
async function menu() {
  const { GET } = await import("@/app/api/room/money/route");
  return (await GET()).json() as Promise<{ wallet: { id: string | null; balance: string }; accounts: { id: string; balance: string }[] }>;
}
async function overview() {
  const { GET } = await import("@/app/api/room/overview/route");
  return (await GET()).json() as Promise<{ accounts: RoomAccount[]; wallet: RoomAccount | null; walletCurrency: string }>;
}
const bal = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id }, select: { balance: true } })).balance.toFixed(2);
const walletOf = (clientId: string) => prisma.account.findFirst({ where: { clientId, isWallet: true }, select: { id: true } });

describe("Transfer with one live account and no wallet yet", () => {
  it("the wallet is in both lists before it exists, 10 USD go to it (creating it) and come back; balances and the menu follow", async () => {
    if (!dbReachable) return;
    const { c, account } = await client();

    // the lists the page builds from the overview: From = the account and the wallet, To = the other one, never the same item
    const o = await overview();
    expect(o.wallet).toBeNull();
    const items = transferItems(o.accounts, o.wallet, o.walletCurrency);
    expect(items.map(itemLabel)).toEqual([`${account.accountNumber} · 100.00 USD`, "Funding wallet · 0.00 USD"]);
    expect(transferTargets(items, items[0]).map((i) => i.key)).toEqual([WALLET_KEY]);
    expect(transferTargets(items, items[1]).map((i) => i.key)).toEqual([account.id]);

    // account -> wallet: the first use creates it
    const out = await transfer(account.id, WALLET_KEY, "10");
    expect(out.status).toBe(201);
    const w = await walletOf(c.id);
    expect(w).not.toBeNull();
    expect([await bal(account.id), await bal(w!.id)]).toEqual(["90.00", "10.00"]);
    let m = await menu();
    expect(m.wallet).toMatchObject({ id: w!.id, balance: "10.00" });
    expect(m.accounts.find((a) => a.id === account.id)?.balance).toBe("90.00");
    const after = await overview();
    expect(transferItems(after.accounts, after.wallet, after.walletCurrency).map(itemLabel)).toEqual([`${account.accountNumber} · 90.00 USD`, "Funding wallet · 10.00 USD"]);

    // wallet -> account, by the "wallet" key as the page sends it
    const back = await transfer(WALLET_KEY, account.id, "10");
    expect(back.status).toBe(201);
    expect([await bal(account.id), await bal(w!.id)]).toEqual(["100.00", "0.00"]);
    m = await menu();
    expect(m.wallet.balance).toBe("0.00");
    expect(m.accounts.find((a) => a.id === account.id)?.balance).toBe("100.00");
    // still one wallet
    expect(await prisma.account.count({ where: { clientId: c.id, isWallet: true } })).toBe(1);
  });

  it("out of a wallet that does not exist yet: refused, nothing created; wallet to wallet refused", async () => {
    if (!dbReachable) return;
    const { c, account } = await client();
    expect(await transfer(WALLET_KEY, account.id, "10")).toEqual({ status: 400, body: { error: "Not enough balance on the source account." } });
    expect(await transfer(WALLET_KEY, WALLET_KEY, "10")).toEqual({ status: 400, body: { error: "Pick two different accounts." } });
    expect(await walletOf(c.id)).toBeNull();
    expect(await bal(account.id)).toBe("100.00");
  });

  it("a demo-only client: no wallet in the lists, the transfer to it is refused and creates nothing", async () => {
    if (!dbReachable) return;
    const { c, account } = await client("DEMO");
    const o = await overview();
    expect(transferItems(o.accounts, o.wallet, o.walletCurrency).some((i) => i.isWallet)).toBe(false);
    expect((await transfer(account.id, WALLET_KEY, "10")).status).toBe(400);
    expect(await walletOf(c.id)).toBeNull();
  });
});

describe("the Transfer page", () => {
  const page = readFileSync("app/(broker)/room/(shell)/transfer/page.tsx", "utf8");
  it("no 'second live account' message; the note only for a client with no live account", () => {
    expect(page).not.toMatch(/second .*account/);
    expect(page).toContain("data && !hasLive ?");
  });
  it("after a transfer the top-bar menu reloads at once (room:changed), not on the next socket event", () => {
    expect(page).toMatch(/dispatchEvent\(new CustomEvent\("room:changed"/);
  });
});
