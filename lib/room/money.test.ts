import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { summarizeMoney } from "@/lib/room/money";
import { moneyRows, pickedRow, shown, storeKey } from "@/components/room/money-menu";

// The top-bar money menu and the Funding wallet page (owner 2026-11-10): Overall = funding wallet + every LIVE trading
// account in USD, demo never counts; the rows; the pick and Hide balance; the partner wallet only for an IB.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));

const D = (v: Prisma.Decimal.Value) => new Prisma.Decimal(v);
const usdOnly = (from: string, to: string) => (from === to ? D(1) : null);
const acc = (id: string, balance: string, mode: "LIVE" | "DEMO", isWallet = false, currency = "USD") => ({ id, accountNumber: `5000${id}`, balance: D(balance), currency, mode, isWallet });

describe("Overall: the funding wallet + live trading accounts, never demo", () => {
  it("sums the wallet and the live accounts and leaves demo out", () => {
    const m = summarizeMoney({ accounts: [acc("1", "1000.50", "LIVE"), acc("2", "250", "LIVE"), acc("3", "99999", "DEMO"), acc("9", "300", "LIVE", true)], partner: null, walletCurrency: "USD" }, usdOnly);
    expect(m.overall).toBe("1550.50");
    expect(m.accounts.map((a) => a.accountNumber)).toEqual(["50001", "50002"]);
    expect(m.wallet).toMatchObject({ id: "9", balance: "300.00" });
    expect(m.partial).toBe(false);
  });
  it("no wallet yet: a 0.00 wallet line, nothing created", () => {
    const m = summarizeMoney({ accounts: [acc("1", "10", "LIVE")], partner: null, walletCurrency: "USD" }, usdOnly);
    expect(m.wallet).toEqual({ id: null, accountNumber: null, balance: "0.00", currency: "USD", usd: "0.00" });
    expect(m.overall).toBe("10.00");
  });
  it("another currency is converted by the server's rate; without a price Overall says partial", () => {
    const eur = (from: string, to: string) => (from === to ? D(1) : from === "EUR" && to === "USD" ? D("1.10") : null);
    expect(summarizeMoney({ accounts: [acc("1", "100", "LIVE", false, "EUR"), acc("2", "10", "LIVE")], partner: null, walletCurrency: "USD" }, eur).overall).toBe("120.00");
    const m = summarizeMoney({ accounts: [acc("1", "100", "LIVE", false, "GBP"), acc("2", "10", "LIVE")], partner: null, walletCurrency: "USD" }, usdOnly);
    expect(m).toMatchObject({ overall: "10.00", partial: true });
  });
  it("the partner wallet (unpaid commission) is listed but is not money on an account, so Overall leaves it out", () => {
    const m = summarizeMoney({ accounts: [acc("1", "10", "LIVE")], partner: { accountNumber: "50001", unpaid: D("42.5"), currency: "USD" }, walletCurrency: "USD" }, usdOnly);
    expect(m.partner).toMatchObject({ balance: "42.50" });
    expect(m.overall).toBe("10.00");
  });
});

describe("the menu's rows, the pick and Hide balance", () => {
  const m = summarizeMoney({ accounts: [acc("1", "10", "LIVE"), acc("9", "5", "LIVE", true)], partner: { accountNumber: "50001", unpaid: D(3), currency: "USD" }, walletCurrency: "USD" }, usdOnly);
  it("Overall, each live trading account, Funding wallet, Partner wallet", () => {
    expect(moneyRows(m).map((r) => r.label)).toEqual(["Overall", "Trading account", "Funding wallet", "Partner wallet"]);
    expect(moneyRows(m).map((r) => r.href)).toEqual(["/room/accounts", "/room/accounts#acct-50001", "/room/wallet", "/room/partner"]);
    expect(moneyRows({ ...m, partner: null }).map((r) => r.label)).not.toContain("Partner wallet");
  });
  it("the bar shows Overall by default, the pick while it exists, Overall again when it is gone", () => {
    expect(pickedRow(m, null)).toMatchObject({ key: "overall", amount: "15.00" });
    expect(pickedRow(m, "1")).toMatchObject({ label: "Trading account", amount: "10.00" });
    expect(pickedRow(m, "wallet")).toMatchObject({ amount: "5.00" });
    expect(pickedRow(m, "gone-account").key).toBe("overall");
  });
  it("Hide balance masks every figure as ****; the choices are kept per client", () => {
    expect(shown("1234.5", true, (s) => s)).toBe("****");
    expect(shown("1234.5", false, (s) => `#${s}`)).toBe("#1234.5");
    expect(storeKey("hide", "C-1")).not.toBe(storeKey("hide", "C-2"));
    expect(storeKey("pick", "C-1")).not.toBe(storeKey("hide", "C-1"));
  });
});

describe("GET /api/room/money (real database)", () => {
  const s = randomUUID().replace(/-/g, "").slice(0, 10);
  let dbReachable = false;
  let brokerId = "";
  let groupId = "";
  let seq = 0;
  beforeAll(async () => {
    try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { return; }
    brokerId = (await prisma.broker.create({ data: { name: `Money ${s}`, subdomain: `money-${s}` } })).id;
    groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  });
  afterAll(async () => { if (dbReachable) await prisma.$disconnect(); });
  async function client() {
    const c = await prisma.client.create({ data: { brokerId, email: `money-${++seq}-${s}@t.local`, passwordHash: "x", fullName: "Money" } });
    const mk = (mode: "LIVE" | "DEMO", balance: number, isWallet = false) =>
      prisma.account.create({ data: { brokerId, clientId: c.id, accountNumber: `4${Date.now() % 1_000_000}${++seq}`, email: c.email, passwordHash: "x", fullName: "Money", accountMode: mode, groupId, balance: D(balance), isWallet } });
    const { roomApiSession } = await import("@/lib/room/context");
    vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId: c.id, brokerId, broker: { id: brokerId, name: "M" } } } as never);
    return { c, mk };
  }
  const get = async () => { const { GET } = await import("@/app/api/room/money/route"); const r = await GET(); return { status: r.status, body: await r.json() }; };

  it("live accounts + wallet, demo left out, no partner wallet for a client who is no IB", async () => {
    if (!dbReachable) return;
    const { mk } = await client();
    await mk("LIVE", 1000); await mk("LIVE", 200.25); await mk("DEMO", 50_000); await mk("LIVE", 75, true);
    const { status, body } = await get();
    expect(status).toBe(200);
    expect(body).toMatchObject({ currency: "USD", overall: "1275.25", partial: false, partner: null });
    expect(body.accounts).toHaveLength(2);
    expect(body.wallet.balance).toBe("75.00");
  });
  it("a client with only demo accounts: 0.00 and an empty list (the wallet line still shows)", async () => {
    if (!dbReachable) return;
    const { mk } = await client();
    await mk("DEMO", 10_000);
    const { body } = await get();
    expect(body).toMatchObject({ overall: "0.00", accounts: [], wallet: { id: null, balance: "0.00" }, partner: null });
  });
  it("an IB gets the partner wallet", async () => {
    if (!dbReachable) return;
    const { c, mk } = await client();
    const ibAcc = await mk("LIVE", 10);
    const referred = await prisma.client.create({ data: { brokerId, email: `money-ref-${s}@t.local`, passwordHash: "x", fullName: "Ref" } });
    const refAcc = await prisma.account.create({ data: { brokerId, clientId: referred.id, accountNumber: `3${Date.now() % 1_000_000}${++seq}`, email: referred.email, passwordHash: "x", fullName: "Ref", accountMode: "LIVE", groupId } });
    await prisma.ibRelationship.create({ data: { brokerId, ibAccountId: ibAcc.id, clientAccountId: refAcc.id, commissionType: "PER_LOT", commissionRate: D(2) } });
    await prisma.client.update({ where: { id: c.id }, data: { partnerAccountId: ibAcc.id } });
    const { body } = await get();
    expect(body.partner).toMatchObject({ accountNumber: ibAcc.accountNumber, balance: "0.00" });
    expect(body.overall).toBe("10.00");
  });
});

describe("the page, the sidebar and the top bar", () => {
  const src = (p: string) => readFileSync(path.join(process.cwd(), p), "utf8");
  it("FUNDS has Funding wallet right after Transfer", () => {
    expect(src("components/room/RoomSidebar.tsx")).toMatch(/\{ href: "\/room\/transfer", label: "Transfer", icon: "transfer" \}, \{ href: "\/room\/wallet", label: "Funding wallet", icon: "wallet" \}/);
  });
  it("the top bar shows the wallet menu on desktop and phone", () => {
    const h = src("components/room/RoomHeader.tsx");
    expect(h).toMatch(/<WalletMenu compact \/>/);
    expect(h).toMatch(/\{picker && data \? <WalletMenu \/> : null\}/);
  });
  it("the menu: three actions, Hide balance, a copy icon by each account number, a check on the pick", () => {
    const w = src("components/room/WalletMenu.tsx");
    for (const t of ['href: "/room/deposit", label: "Deposit"', 'href: "/room/withdraw", label: "Withdraw"', 'href: "/room/transfer", label: "Transfer"', "Hide balance", "Copy account number", 'role="menuitemradio"']) expect(w).toContain(t);
    expect(w).toMatch(/useRoomEvent\(\(\) => \{ void load\(\); \}\)/);
  });
  it("the page: the info card, the wallet card with its three buttons on the wallet, How it works", () => {
    const p = src("app/(broker)/room/(shell)/wallet/page.tsx");
    for (const t of ["Keep funds separate. Transfer anytime.", "Funds stay out of trading risk", "No fees for storing funds", "Move money to any account in seconds", "Store your funds", "Make instant transfers", "Manage your profits", "How it works"]) expect(p).toContain(t);
    expect(p).toContain("go((id) => `/room/deposit?account=${id}`)");
    expect(p).toContain("go((id) => `/room/withdraw?account=${id}`)");
    expect(p).toContain("go((id) => `/room/transfer?from=${id}`)");
    expect(p).not.toMatch(/Add currency/i);
  });
});
