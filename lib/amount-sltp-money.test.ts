import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { NextRequest } from "next/server";
import { prisma } from "@/lib/prisma";

// Amount-based ($) TP / SL (owner 2026-11-04), ADVERSARIAL, on the local scratch DB: both units, hostile input, an amount already
// reached, the FX conversion path, a pending fill that copies the amounts, a modify clearing an amount, a close at the trigger with the
// exact P/L, a SELL and a BUY in each direction, the RUST-authority refusal and the staff routes. Real fixtures, own cleanup.
vi.mock("@/lib/account-auth", () => ({ getAccountSession: vi.fn() }));
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAccountSession } from "@/lib/account-auth";
import { getAdminSession } from "@/lib/auth";
import { evaluateAccountRisk } from "@/lib/risk-monitor";
import { triggerPendingOrder } from "@/lib/pending-trigger";

const D = (v: string | number) => new Prisma.Decimal(v);
let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT "slAmount" FROM "Position" LIMIT 1`;
    dbReachable = true;
  } catch {
    console.warn("amount-sltp-money.test.ts: DB unreachable or the amount migration is missing, skipping");
  }
});
beforeEach(() => {
  delete process.env.ENGINE_AMOUNT_SLTP;
});

const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } }).catch(() => {});
  await prisma.order.updateMany({ where, data: { closesPositionId: null } }).catch(() => {});
  await prisma.postCloseEffect.deleteMany({ where }).catch(() => {});
  await prisma.deal.deleteMany({ where }).catch(() => {});
  await prisma.notification.deleteMany({ where }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.transaction.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: [...symbols, "USDJPY"] } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

type W = { brokerId: string; groupId: string; accountId: string; symbolId: string; symbol: string; adminId: string };

/** A world: broker (WEB authority, instant B-book), a CRYPTO symbol (continuous session) quoted `quote`, bid / ask `bid` / `ask`, contract size `cs`. */
async function world(o: { quote?: string; cs?: number; bid?: string; ask?: string; mode?: "LIVE" | "DEMO"; balance?: number } = {}): Promise<W> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 8);
  const b = await prisma.broker.create({ data: { name: `AMT ${sfx}`, subdomain: `amt-${sfx}`, dealingDeskAutoFillAt: new Date() } });
  brokers.push(b.id);
  const symbol = `ZA${sfx.toUpperCase()}`;
  symbols.push(symbol);
  const s = await prisma.symbol.create({ data: { name: symbol, baseCurrency: "TST", quoteCurrency: o.quote ?? "USD", category: "CRYPTO", digits: 2, contractSize: D(o.cs ?? 100) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D(0.01), maxLot: D(1000), lotStep: D(0.01), tradingMode: "BOTH", enabled: true } });
  await prisma.livePrice.create({ data: { symbol, bid: D(o.bid ?? "99.90"), ask: D(o.ask ?? "100.10"), tickAt: new Date() } });
  const g = await prisma.group.create({ data: { brokerId: b.id, name: `G-${sfx}`, leverage: 100, marginCallLevel: D(100), stopOutLevel: D(50), category: "B_BOOK", isClientSelectable: true } });
  const n = `8${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "8")}`;
  const acc = await prisma.account.create({ data: { groupId: g.id, brokerId: b.id, accountNumber: n, email: `amt-${n}@test.local`, passwordHash: "x", fullName: "Amt", accountMode: o.mode ?? "LIVE", balance: D(o.balance ?? 1_000_000), leverage: 100 } });
  const admin = await prisma.adminUser.create({ data: { brokerId: b.id, email: `amt-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  vi.mocked(getAccountSession).mockResolvedValue({ accountId: acc.id, brokerId: b.id } as never);
  vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, role: "BROKER_ADMIN", brokerId: b.id } as never);
  return { brokerId: b.id, groupId: g.id, accountId: acc.id, symbolId: s.id, symbol, adminId: admin.id };
}
const price = (w: W, bid: string, ask = bid) => prisma.livePrice.update({ where: { symbol: w.symbol }, data: { bid: D(bid), ask: D(ask), tickAt: new Date() } });
const asTrader = (w: W) => vi.mocked(getAccountSession).mockResolvedValue({ accountId: w.accountId, brokerId: w.brokerId } as never);

async function open(w: W, side: "BUY" | "SELL", openPrice: string, extra: { slAmount?: string; tpAmount?: string; slPrice?: string; lots?: string } = {}) {
  const lots = extra.lots ?? "1";
  const order = await prisma.order.create({ data: { brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, side, type: "MARKET", volume: D(lots), requestedPrice: D(openPrice), idempotencyKey: `amt:${randomUUID()}`, status: "FILLED", filledPrice: D(openPrice), filledAt: new Date() } });
  return prisma.position.create({
    data: {
      brokerId: w.brokerId, accountId: w.accountId, symbolId: w.symbolId, originOrderId: order.id, side, volume: D(lots), openPrice: D(openPrice),
      slAmount: extra.slAmount ? D(extra.slAmount) : null, tpAmount: extra.tpAmount ? D(extra.tpAmount) : null, slPrice: extra.slPrice ? D(extra.slPrice) : null, bookType: "B_BOOK",
    },
  });
}
async function call(handler: unknown, url: string, method: string, body?: unknown, params?: Record<string, string>) {
  const req = new NextRequest(`https://t.local${url}`, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const res = await (handler as (r: NextRequest, c?: unknown) => Promise<Response>)(req, params ? { params: Promise.resolve(params) } : undefined);
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}
const modify = async (positionId: string, body: unknown) => {
  const { PATCH } = await import("@/app/api/trade/positions/[id]/route");
  return call(PATCH, `/api/trade/positions/${positionId}`, "PATCH", body, { id: positionId });
};
const row = (id: string) => prisma.position.findUniqueOrThrow({ where: { id } });

describe("trader modify: both units, hostile input, already reached, clearing", () => {
  it("sets an SL amount and a TP amount (stored to the cent, the price legs cleared) and returns them", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100", { slPrice: "90" });
    const r = await modify(p.id, { slAmount: "50.005", tpAmount: 800 });
    expect(r.status).toBe(200);
    const after = await row(p.id);
    expect(after.slAmount?.toFixed(2)).toBe("50.01");
    expect(after.tpAmount?.toFixed(2)).toBe("800.00");
    expect(after.slPrice).toBeNull(); // the amount replaced the price on that leg
    expect(r.json.slAmount).toBe("50.01");
    expect(r.json.tpAmount).toBe("800");
  });

  it("a leg set as a price AND an amount in one request is refused (both legs), nothing is written", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100");
    for (const body of [{ slPrice: "90", slAmount: "50" }, { tpPrice: "120", tpAmount: "50" }]) {
      const r = await modify(p.id, body);
      expect(r.status).toBe(400);
      expect(r.json.amountCode).toBe("AMOUNT_BOTH_UNITS");
      expect(r.json.clientReason).toBe("INVALID_SLTP");
    }
    const after = await row(p.id);
    expect([after.slAmount, after.tpAmount, after.slPrice, after.tpPrice]).toEqual([null, null, null, null]);
  });

  it("hostile amounts are refused and never stored: NaN, Infinity, negative, zero, hex, exponent, huge, an object, a list, an empty-ish string", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100");
    const hostile: unknown[] = ["NaN", "Infinity", "-5", "-0.01", "0", "0.00", "0.004", "0x10", "1e3", "5e-1", "1,000", "--1", "2000000000", "1000000000.01", 1e21, -1, { $gt: 0 }, [5], true, "abc"];
    for (const v of hostile) {
      for (const field of ["slAmount", "tpAmount"]) {
        const r = await modify(p.id, { [field]: v });
        expect(r.status, `${field}=${JSON.stringify(v)}`).toBe(400);
        expect(r.json.amountCode, `${field}=${JSON.stringify(v)}`).toBe("AMOUNT_INVALID");
      }
    }
    const after = await row(p.id);
    expect([after.slAmount, after.tpAmount]).toEqual([null, null]);
    // the limits themselves: 1,000,000,000.00 passes the parser, 0.01 is the smallest amount
    const ok = await modify(p.id, { tpAmount: "1000000000", slAmount: "0.01" });
    expect(ok.status).toBe(400); // 0.01 is inside the 10.00 spread loss already: the reached rule, not the parser
    expect(ok.json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    const big = await modify(p.id, { tpAmount: "1000000000" });
    expect(big.status).toBe(200);
    expect((await row(p.id)).tpAmount?.toFixed(2)).toBe("1000000000.00");
  });

  it("BUY: an SL amount the position already stands at is refused, one cent above is accepted (exact boundary); same for TP", async () => {
    if (!dbReachable) return;
    const w = await world(); // BUY closes at the bid 99.90; open 100, 1 lot x 100 = -10.00 now
    const loss = await open(w, "BUY", "100");
    const atEdge = await modify(loss.id, { slAmount: "10" });
    expect(atEdge.status).toBe(400);
    expect(atEdge.json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect(String(atEdge.json.message)).toMatch(/^SL amount 10\.00 USD is already reached \(P\/L -10\.00 USD\)/);
    expect((await modify(loss.id, { slAmount: "10.01" })).status).toBe(200);
    // TP: open 90 -> +990.00 now
    const win = await open(w, "BUY", "90");
    const tpEdge = await modify(win.id, { tpAmount: "990" });
    expect(tpEdge.status).toBe(400);
    expect(tpEdge.json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect(String(tpEdge.json.message)).toMatch(/^TP amount 990\.00 USD is already reached/);
    expect((await modify(win.id, { tpAmount: "990.01" })).status).toBe(200);
  });

  it("SELL: closes at the ask 100.10; open 100 is -10.00, open 110 is +990.00; the same boundaries", async () => {
    if (!dbReachable) return;
    const w = await world();
    const loss = await open(w, "SELL", "100");
    expect((await modify(loss.id, { slAmount: "10" })).json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect((await modify(loss.id, { slAmount: "10.01" })).status).toBe(200);
    const win = await open(w, "SELL", "110");
    expect((await modify(win.id, { tpAmount: "990" })).json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect((await modify(win.id, { tpAmount: "990.01" })).status).toBe(200);
    // the wrong direction is never "reached": a TP amount on a losing position, an SL amount on a winning one
    const l2 = await open(w, "SELL", "100");
    expect((await modify(l2.id, { tpAmount: "1" })).status).toBe(200);
    const w2 = await open(w, "SELL", "110");
    expect((await modify(w2.id, { slAmount: "1" })).status).toBe(200);
  });

  it("only the amount a request SETS is judged: changing the TP price leaves an older SL amount alone", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100", { slAmount: "5" }); // already past -5 (P/L -10): it will close on the next monitor pass, not refuse an edit
    const r = await modify(p.id, { tpPrice: "130" });
    expect(r.status).toBe(200);
    expect((await row(p.id)).slAmount?.toFixed(2)).toBe("5.00");
  });

  it("clearing: null clears only that unit; a price clears the amount; an amount clears the price; an older client's slPrice:null leaves an amount", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100");
    await modify(p.id, { slAmount: "100", tpAmount: "500" });
    // an older client that knows nothing of amounts sends slPrice:null for an unset price
    expect((await modify(p.id, { slPrice: null })).status).toBe(200);
    expect((await row(p.id)).slAmount?.toFixed(2)).toBe("100.00");
    // clearing the amount
    expect((await modify(p.id, { slAmount: null })).status).toBe(200);
    const cleared = await row(p.id);
    expect(cleared.slAmount).toBeNull();
    expect(cleared.tpAmount?.toFixed(2)).toBe("500.00");
    // a price on the TP leg replaces its amount
    expect((await modify(p.id, { tpPrice: "130" })).status).toBe(200);
    const priced = await row(p.id);
    expect(priced.tpAmount).toBeNull();
    expect(priced.tpPrice?.toString()).toBe("130");
    // an amount on the TP leg replaces its price
    expect((await modify(p.id, { tpAmount: "700" })).status).toBe(200);
    const swapped = await row(p.id);
    expect(swapped.tpPrice).toBeNull();
    expect(swapped.tpAmount?.toFixed(2)).toBe("700.00");
  });

  it("price and pips legs behave exactly as before (no amount fields: untouched, the wrong-side rule still refuses)", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100", { slAmount: "300" });
    const ok = await modify(p.id, { slPrice: "90" });
    expect(ok.status).toBe(200);
    expect((await row(p.id)).slAmount).toBeNull(); // a price on the SL leg replaced the amount
    const wrong = await modify(p.id, { slPrice: "150" }); // above the market for a BUY
    expect(wrong.status).toBe(400);
    expect(wrong.json.amountCode).toBeUndefined();
  });
});

describe("FX conversion path", () => {
  it("a JPY-quoted symbol on a USD account converts through USDJPY: -100 JPY at 125 is -0.80 USD, refused at 0.80, accepted at 0.81", async () => {
    if (!dbReachable) return;
    await prisma.livePrice.upsert({ where: { symbol: "USDJPY" }, update: { bid: D(125), ask: D(125), tickAt: new Date() }, create: { symbol: "USDJPY", bid: D(125), ask: D(125), tickAt: new Date() } });
    const w = await world({ quote: "JPY", cs: 1000, bid: "149.90", ask: "150.10" });
    const p = await open(w, "BUY", "150"); // (149.90 - 150) x 1000 = -100 JPY = -0.80 USD
    const edge = await modify(p.id, { slAmount: "0.80" });
    expect(edge.status).toBe(400);
    expect(edge.json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect(String(edge.json.message)).toContain("P/L -0.80 USD");
    expect((await modify(p.id, { slAmount: "0.81" })).status).toBe(200);
  });

  it("no rate to the account currency: NO_CONVERSION_RATE, nothing stored", async () => {
    if (!dbReachable) return;
    const w = await world({ quote: "XQZ" });
    const p = await open(w, "BUY", "100");
    const r = await modify(p.id, { tpAmount: "500" });
    expect(r.status).toBe(400);
    expect(r.json.amountCode).toBe("NO_CONVERSION_RATE");
    expect((await row(p.id)).tpAmount).toBeNull();
  });
});

describe("RUST authority: amounts are refused until the engine watches them", () => {
  it("a RUST broker refuses an amount on a DEMO account (demo-only scope) and on every account when demo-only is off; a WEB-owned live account is accepted", async () => {
    if (!dbReachable) return;
    const w = await world({ mode: "DEMO" });
    await prisma.broker.update({ where: { id: w.brokerId }, data: { riskAuthority: "RUST", riskAuthorityDemoOnly: true } });
    const p = await open(w, "BUY", "100");
    const refused = await modify(p.id, { tpAmount: "500" });
    expect(refused.status).toBe(400);
    expect(refused.json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
    expect(refused.json.message).toBe("Amount take profit / stop loss is not available for this account yet");
    expect((await row(p.id)).tpAmount).toBeNull();
    // clearing an amount and a price edit still work on that account
    expect((await modify(p.id, { tpPrice: "130" })).status).toBe(200);
    expect((await modify(p.id, { tpAmount: null })).status).toBe(200);
    // the same broker's LIVE account is WEB-owned while demo-only is on
    const live = await world({ mode: "LIVE" });
    await prisma.broker.update({ where: { id: live.brokerId }, data: { riskAuthority: "RUST", riskAuthorityDemoOnly: true } });
    const lp = await open(live, "BUY", "100");
    expect((await modify(lp.id, { tpAmount: "500" })).status).toBe(200);
    // demo-only off: the live account is RUST-owned too
    await prisma.broker.update({ where: { id: live.brokerId }, data: { riskAuthorityDemoOnly: false } });
    const lp2 = await open(live, "BUY", "100");
    expect((await modify(lp2.id, { tpAmount: "500" })).json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
  });

  it("ENGINE_AMOUNT_SLTP=1 lifts the refusal", async () => {
    if (!dbReachable) return;
    const w = await world({ mode: "DEMO" });
    await prisma.broker.update({ where: { id: w.brokerId }, data: { riskAuthority: "RUST" } });
    const p = await open(w, "BUY", "100");
    expect((await modify(p.id, { tpAmount: "500" })).status).toBe(400);
    process.env.ENGINE_AMOUNT_SLTP = "1";
    expect((await modify(p.id, { tpAmount: "500" })).status).toBe(200);
  });

  it("a placed order carrying an amount is refused on a RUST account too, and nothing is created", async () => {
    if (!dbReachable) return;
    const w = await world({ mode: "DEMO" });
    await prisma.broker.update({ where: { id: w.brokerId }, data: { riskAuthority: "RUST" } });
    const { POST } = await import("@/app/api/trade/orders/route");
    const r = await call(POST, "/api/trade/orders", "POST", { symbol: w.symbol, side: "BUY", type: "MARKET", volume: "1", price: "100.10", slAmount: "500", idempotencyKey: randomUUID() });
    expect(r.status).toBe(400);
    expect(r.json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
    expect(await prisma.order.count({ where: { accountId: w.accountId } })).toBe(0);
  });
});

describe("order placement", () => {
  const place = async (w: W, body: Record<string, unknown>) => {
    const { POST } = await import("@/app/api/trade/orders/route");
    return call(POST, "/api/trade/orders", "POST", { symbol: w.symbol, side: "BUY", type: "MARKET", volume: "1", price: "100.10", idempotencyKey: randomUUID(), ...body });
  };

  it("a MARKET order with amounts fills and the position carries them (the response too)", async () => {
    if (!dbReachable) return;
    const w = await world();
    const r = await place(w, { slAmount: "500", tpAmount: "1500.5" });
    expect(r.status).toBe(201);
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: w.accountId } });
    expect(pos.slAmount?.toFixed(2)).toBe("500.00");
    expect(pos.tpAmount?.toFixed(2)).toBe("1500.50");
    expect(pos.slPrice).toBeNull();
    const order = await prisma.order.findFirstOrThrow({ where: { accountId: w.accountId } });
    expect(order.slAmount?.toFixed(2)).toBe("500.00");
    expect((r.json.position as Record<string, unknown>).slAmount).toBe("500");
  });

  it("an SL amount inside the spread cost is refused: spread 0.20 x 100 x 1 lot = 20.00 -> 20.00 refused, 20.01 accepted", async () => {
    if (!dbReachable) return;
    const w = await world();
    const edge = await place(w, { slAmount: "20" });
    expect(edge.status).toBe(400);
    expect(edge.json.amountCode).toBe("AMOUNT_INSIDE_SPREAD");
    expect(String(edge.json.message)).toContain("spread cost (20.00 USD)");
    expect(await prisma.order.count({ where: { accountId: w.accountId } })).toBe(0);
    expect((await place(w, { slAmount: "20.01" })).status).toBe(201);
  });

  it("both units, hostile input, no rate: refused before any row exists", async () => {
    if (!dbReachable) return;
    const w = await world();
    expect((await place(w, { slPrice: "90", slAmount: "100" })).json.amountCode).toBe("AMOUNT_BOTH_UNITS");
    expect((await place(w, { tpPrice: "120", tpAmount: "100" })).json.amountCode).toBe("AMOUNT_BOTH_UNITS");
    for (const v of ["NaN", "-1", "0", "1e9", "0x1", "99999999999"]) expect((await place(w, { tpAmount: v })).json.amountCode, v).toBe("AMOUNT_INVALID");
    const noRate = await world({ quote: "XQZ" });
    expect((await place(noRate, { tpAmount: "100" })).json.amountCode).toBe("NO_CONVERSION_RATE");
    expect(await prisma.order.count({ where: { brokerId: { in: [w.brokerId, noRate.brokerId] } } })).toBe(0);
  });

  it("a resting LIMIT with amounts stores them on the order; the server trigger copies them onto the position", async () => {
    if (!dbReachable) return;
    const w = await world();
    const r = await place(w, { type: "LIMIT", price: "99.00", side: "BUY", slAmount: "300", tpAmount: "900" });
    expect(r.status).toBe(201);
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: w.accountId, status: "PENDING" } });
    expect([o.slAmount?.toFixed(2), o.tpAmount?.toFixed(2)]).toEqual(["300.00", "900.00"]);
    await price(w, "98.90", "99.00"); // the ask reached the entry
    const t = await triggerPendingOrder(o.id, "99.00", "server");
    expect(t.kind).toBe("filled");
    const pos = await prisma.position.findFirstOrThrow({ where: { originOrderId: o.id } });
    expect([pos.slAmount?.toFixed(2), pos.tpAmount?.toFixed(2)]).toEqual(["300.00", "900.00"]);
  });

  it("the pending-order edit route: set, replace by a price, clear; refuses both units and hostile input", async () => {
    if (!dbReachable) return;
    const w = await world();
    await place(w, { type: "LIMIT", price: "99.00", side: "BUY" });
    const o = await prisma.order.findFirstOrThrow({ where: { accountId: w.accountId, status: "PENDING" } });
    const { PATCH } = await import("@/app/api/trade/orders/[id]/route");
    const edit = (body: unknown) => call(PATCH, `/api/trade/orders/${o.id}`, "PATCH", body, { id: o.id });
    expect((await edit({ slAmount: "250" })).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).slAmount?.toFixed(2)).toBe("250.00");
    expect((await edit({ slPrice: "90" })).status).toBe(200);
    const priced = await prisma.order.findUniqueOrThrow({ where: { id: o.id } });
    expect([priced.slAmount, priced.slPrice?.toString()]).toEqual([null, "90"]);
    expect((await edit({ tpAmount: "400", tpPrice: "120" })).json.amountCode).toBe("AMOUNT_BOTH_UNITS");
    expect((await edit({ tpAmount: "-4" })).json.amountCode).toBe("AMOUNT_INVALID");
    expect((await edit({ tpAmount: "400" })).status).toBe(200);
    expect((await edit({ tpAmount: null })).status).toBe(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: o.id } })).tpAmount).toBeNull();
  });
});

describe("WEB-authority monitor: a close at the trigger with the exact P/L", () => {
  const closedNote = async (positionId: string) => (await prisma.transaction.findFirst({ where: { referenceType: "Position", referenceId: positionId, type: "TRADE_PNL" } }))?.note ?? null;

  it("BUY SL: closes at exactly -slAmount, not a cent before; note says SL amount; P/L is the exact figure", async () => {
    if (!dbReachable) return;
    const w = await world({ bid: "100", ask: "100" });
    const p = await open(w, "BUY", "100", { slAmount: "1000" });
    await price(w, "90.01");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([]);
    await price(w, "90");
    const r = await evaluateAccountRisk(w.accountId);
    expect(r.slTpClosed).toEqual([p.id]);
    const closed = await row(p.id);
    expect(closed.status).toBe("CLOSED");
    expect(closed.realizedPnl?.toFixed(2)).toBe("-1000.00");
    expect(await closedNote(p.id)).toBe("Stop loss amount hit (automatic)");
  });

  it("BUY TP: closes at exactly +tpAmount; note says TP amount", async () => {
    if (!dbReachable) return;
    const w = await world({ bid: "100", ask: "100" });
    const p = await open(w, "BUY", "100", { tpAmount: "1000" });
    await price(w, "109.99");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([]);
    await price(w, "110");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([p.id]);
    expect((await row(p.id)).realizedPnl?.toFixed(2)).toBe("1000.00");
    expect(await closedNote(p.id)).toBe("Take profit amount hit (automatic)");
  });

  it("SELL SL (the price rises to the ask) and SELL TP (it falls), exact", async () => {
    if (!dbReachable) return;
    const w = await world({ bid: "100", ask: "100" });
    const sl = await open(w, "SELL", "100", { slAmount: "1000" });
    await price(w, "109.99");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([]);
    await price(w, "110");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([sl.id]);
    expect((await row(sl.id)).realizedPnl?.toFixed(2)).toBe("-1000.00");
    const tp = await open(w, "SELL", "110", { tpAmount: "2000" });
    await price(w, "90.01");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([]);
    await price(w, "90");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([tp.id]);
    expect((await row(tp.id)).realizedPnl?.toFixed(2)).toBe("2000.00");
  });

  it("SL is checked first; a price SL still closes with the old note; a position with neither leg is never touched", async () => {
    if (!dbReachable) return;
    const w = await world({ bid: "100", ask: "100" });
    const both = await open(w, "BUY", "100", { slAmount: "500", tpAmount: "500" });
    const plain = await open(w, "BUY", "100");
    const priced = await open(w, "BUY", "100", { slPrice: "95" });
    await price(w, "94"); // P/L -600: the SL amount (and the price SL) are hit; the TP amount is not
    const r = await evaluateAccountRisk(w.accountId);
    expect(new Set(r.slTpClosed)).toEqual(new Set([both.id, priced.id]));
    expect(await closedNote(both.id)).toBe("Stop loss amount hit (automatic)");
    expect(await closedNote(priced.id)).toBe("Stop loss hit (automatic)");
    expect((await row(plain.id)).status).toBe("OPEN");
  });

  it("the FX path: a JPY position closes at exactly -slAmount USD through USDJPY", async () => {
    if (!dbReachable) return;
    await prisma.livePrice.upsert({ where: { symbol: "USDJPY" }, update: { bid: D(125), ask: D(125), tickAt: new Date() }, create: { symbol: "USDJPY", bid: D(125), ask: D(125), tickAt: new Date() } });
    const w = await world({ quote: "JPY", cs: 1000, bid: "150", ask: "150" });
    const p = await open(w, "BUY", "150", { slAmount: "8" }); // -8 USD = -1000 JPY = 1.00 lower on 1000 units
    await price(w, "149.01");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([]);
    await price(w, "149");
    expect((await evaluateAccountRisk(w.accountId)).slTpClosed).toEqual([p.id]);
    expect((await row(p.id)).realizedPnl?.toFixed(2)).toBe("-8.00");
  });
});

describe("modify-bulk with an { amount } spec", () => {
  it("sets amounts on several positions, judges each on its own, refuses both-units / hostile / RUST for the request", async () => {
    if (!dbReachable) return;
    const w = await world();
    const a = await open(w, "BUY", "100");
    const winner = await open(w, "BUY", "90"); // +990 now
    const { POST } = await import("@/app/api/trade/positions/modify-bulk/route");
    const bulk = (body: unknown) => call(POST, "/api/trade/positions/modify-bulk", "POST", body);
    const r = await bulk({ positionIds: [a.id, winner.id], tp: { amount: "990" }, sl: { amount: "200" } });
    expect(r.status).toBe(200);
    const results = r.json.results as Array<Record<string, unknown>>;
    expect(results.find((x) => x.positionId === a.id)).toMatchObject({ ok: true, slAmount: "200", tpAmount: "990" });
    expect(results.find((x) => x.positionId === winner.id)).toMatchObject({ ok: false, amountCode: "AMOUNT_ALREADY_REACHED" });
    expect((await row(a.id)).tpAmount?.toFixed(2)).toBe("990.00");
    expect((await row(winner.id)).tpAmount).toBeNull();
    expect((await bulk({ positionIds: [a.id], sl: { amount: "10", price: "90" } })).json.amountCode).toBe("AMOUNT_INVALID");
    expect((await bulk({ positionIds: [a.id], sl: { amount: "-3" } })).json.amountCode).toBe("AMOUNT_INVALID");
    // a price spec replaces the amount on that leg; clear removes the leg
    expect((await bulk({ positionIds: [a.id], sl: { price: "90" } })).status).toBe(200);
    expect((await row(a.id)).slAmount).toBeNull();
    expect((await bulk({ positionIds: [a.id], tp: { clear: true } })).status).toBe(200);
    expect((await row(a.id)).tpAmount).toBeNull();
    await prisma.broker.update({ where: { id: w.brokerId }, data: { riskAuthority: "RUST", riskAuthorityDemoOnly: false } });
    const refused = await bulk({ positionIds: [a.id], tp: { amount: "500" } });
    expect(refused.status).toBe(400);
    expect(refused.json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
  });
});

describe("staff routes", () => {
  it("staff modify: sets, replaces and clears amounts, refuses reached / both units / hostile / RUST, audits old and new", async () => {
    if (!dbReachable) return;
    const w = await world();
    const p = await open(w, "BUY", "100", { slPrice: "90" });
    const { PATCH } = await import("@/app/api/manage/positions/[id]/route");
    const edit = (body: Record<string, unknown>) => call(PATCH, `/api/manage/positions/${p.id}`, "PATCH", { reason: "test", ...body }, { id: p.id });
    const set = await edit({ slAmount: "300", tpAmount: "900" });
    expect(set.status).toBe(200);
    expect([set.json.slAmount, set.json.tpAmount, set.json.slPrice]).toEqual(["300", "900", null]);
    expect((await edit({ slAmount: "10" })).json.amountCode).toBe("AMOUNT_ALREADY_REACHED");
    expect((await edit({ slAmount: "5", slPrice: "90" })).json.amountCode).toBe("AMOUNT_BOTH_UNITS");
    expect((await edit({ tpAmount: "1e3" })).json.amountCode).toBe("AMOUNT_INVALID");
    const priced = await edit({ tpPrice: "130" });
    expect([priced.json.tpAmount, priced.json.tpPrice, priced.json.slAmount]).toEqual([null, "130", "300"]);
    const cleared = await edit({ slAmount: null });
    expect(cleared.json.slAmount).toBeNull();
    const audit = await prisma.auditLog.findMany({ where: { entityId: p.id, action: "POSITION_SLTP_MODIFIED" }, orderBy: { createdAt: "asc" } });
    expect((audit[0].oldValue as Record<string, unknown>).slAmount).toBeNull();
    expect((audit[0].newValue as Record<string, unknown>).slAmount).toBe("300");
    await prisma.broker.update({ where: { id: w.brokerId }, data: { riskAuthority: "RUST", riskAuthorityDemoOnly: false } });
    expect((await edit({ tpAmount: "500" })).json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
  });

  it("staff market open and pending order carry amounts; manual position refuses them", async () => {
    if (!dbReachable) return;
    const w = await world();
    const { POST } = await import("@/app/api/manage/positions/route");
    const spread = await call(POST, "/api/manage/positions", "POST", { accountId: w.accountId, symbolId: w.symbolId, side: "BUY", volume: "1", slAmount: "20" });
    expect(spread.json.amountCode).toBe("AMOUNT_INSIDE_SPREAD");
    const ok = await call(POST, "/api/manage/positions", "POST", { accountId: w.accountId, symbolId: w.symbolId, side: "BUY", volume: "1", slAmount: "20.01", tpAmount: "700" });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    const pos = await prisma.position.findFirstOrThrow({ where: { accountId: w.accountId } });
    expect([pos.slAmount?.toFixed(2), pos.tpAmount?.toFixed(2)]).toEqual(["20.01", "700.00"]);
    const { POST: PEND } = await import("@/app/api/manage/accounts/[id]/orders/route");
    const pend = await call(PEND, `/api/manage/accounts/${w.accountId}/orders`, "POST", { symbolId: w.symbolId, side: "BUY", type: "LIMIT", volume: "1", price: "95", slAmount: "100" }, { id: w.accountId });
    expect(pend.status, JSON.stringify(pend.json)).toBe(201);
    expect((await prisma.order.findFirstOrThrow({ where: { accountId: w.accountId, status: "PENDING" } })).slAmount?.toFixed(2)).toBe("100.00");
    const { POST: MAN } = await import("@/app/api/manage/accounts/[id]/manual-positions/route");
    const man = await call(MAN, `/api/manage/accounts/${w.accountId}/manual-positions`, "POST", { symbolId: w.symbolId, side: "BUY", volume: "1", openPrice: "100", reason: "t", slAmount: "100" }, { id: w.accountId });
    expect(man.status).toBe(400);
    expect(man.json.amountCode).toBe("AMOUNT_SLTP_NOT_AVAILABLE");
  });
});

describe("readers", () => {
  it("the client allow-lists carry slAmount / tpAmount", async () => {
    const { toClientShape } = await import("@/lib/client-execution");
    const position = toClientShape({ id: "p", bookType: "B_BOOK", openPrice: D(1), slAmount: D("12.5"), tpAmount: null, brokerId: "secret" } as never) as Record<string, unknown>;
    expect(position.slAmount).toEqual(D("12.5"));
    expect("tpAmount" in position).toBe(true);
    expect(position.brokerId).toBeUndefined();
    const order = toClientShape({ id: "o", idempotencyKey: "k", type: "LIMIT", slAmount: D("3"), tpAmount: D("4"), brokerId: "secret" } as never) as Record<string, unknown>;
    expect([order.slAmount, order.tpAmount]).toEqual([D("3"), D("4")]);
    expect(order.brokerId).toBeUndefined();
  });
});
