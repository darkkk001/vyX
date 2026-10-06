import "dotenv/config";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Prisma, RoutingCategory } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Book P/L (owner 2026-10-06, lib/book-pnl.ts): -sum of client trading profit on positions opened in a Book or Dealing
// desk group, live non-internal accounts, never the hedge account / a COVERAGE group, never voided or deleted rows,
// commission and swap excluded, per account currency. Dashboard today and Reports for the same range give the same
// number. Real fixtures on the local scratch DB, own cleanup.
vi.mock("@/lib/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined), publishAlertConfig: vi.fn().mockResolvedValue(undefined) }));
import { getAdminSession } from "@/lib/auth";
import { bookPnlFloating, bookPnlRealized } from "@/lib/book-pnl";

const D = (v: string | number) => new Prisma.Decimal(v);
const HOUR = 3600_000;

let dbReachable = false;
beforeAll(async () => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    dbReachable = true;
  } catch {
    console.warn("book-pnl.test.ts: DB unreachable, skipping");
  }
});
const brokers: string[] = [];
const symbols: string[] = [];
afterAll(async () => {
  if (!dbReachable) return;
  const where = { brokerId: { in: brokers } };
  await prisma.broker.updateMany({ where: { id: { in: brokers } }, data: { coverageAccountId: null } }).catch(() => {});
  await prisma.auditLog.deleteMany({ where }).catch(() => {});
  await prisma.position.deleteMany({ where }).catch(() => {});
  await prisma.order.deleteMany({ where }).catch(() => {});
  await prisma.account.deleteMany({ where }).catch(() => {});
  await prisma.adminUser.deleteMany({ where }).catch(() => {});
  await prisma.brokerSymbol.deleteMany({ where }).catch(() => {});
  await prisma.group.deleteMany({ where }).catch(() => {});
  await prisma.broker.deleteMany({ where: { id: { in: brokers } } }).catch(() => {});
  await prisma.livePrice.deleteMany({ where: { symbol: { in: symbols } } }).catch(() => {});
  await prisma.symbol.deleteMany({ where: { name: { in: symbols } } }).catch(() => {});
  await prisma.$disconnect();
}, 60000);

type Fx = { brokerId: string; adminId: string; symbolId: string; symbolName: string; groups: Record<RoutingCategory, string> };
async function fixture(): Promise<Fx> {
  const sfx = randomUUID().replace(/-/g, "").slice(0, 10);
  const b = await prisma.broker.create({ data: { name: `BookPnl ${sfx}`, subdomain: `bpnl-${sfx}` } });
  brokers.push(b.id);
  const a = await prisma.adminUser.create({ data: { brokerId: b.id, email: `bp-${sfx}@test.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
  const name = `BP${sfx.toUpperCase()}`;
  symbols.push(name);
  const s = await prisma.symbol.create({ data: { name, baseCurrency: "TST", quoteCurrency: "USD", category: "CRYPTO", digits: 2, contractSize: D(1) } });
  await prisma.brokerSymbol.create({ data: { brokerId: b.id, symbolId: s.id, minLot: D("0.01"), maxLot: D(100), lotStep: D("0.01"), enabled: true } });
  // a client BUY opened at 100 is worth +10 a lot at bid 110; a SELL opened at 100 is worth -10.10 at ask 110.10
  await prisma.livePrice.create({ data: { symbol: name, bid: D("110.00"), ask: D("110.10"), tickAt: new Date() } });
  const groups = {} as Record<RoutingCategory, string>;
  for (const c of ["A_BOOK", "B_BOOK", "DEALING", "REVERSAL", "COVERAGE"] as RoutingCategory[]) {
    groups[c] = (await prisma.group.create({ data: { brokerId: b.id, name: `${c}-${sfx}`, category: c } })).id;
  }
  return { brokerId: b.id, adminId: a.id, symbolId: s.id, symbolName: name, groups };
}
async function account(fx: Fx, category: RoutingCategory, opts?: { mode?: "LIVE" | "DEMO"; internal?: boolean; currency?: string }) {
  const n = `3${randomUUID().replace(/\D/g, "").slice(0, 7).padEnd(7, "4")}`;
  return prisma.account.create({
    data: {
      groupId: fx.groups[category], brokerId: fx.brokerId, accountNumber: n, email: `bp-${n}-${randomUUID().slice(0, 4)}@test.local`, passwordHash: "x", fullName: `BP ${n}`,
      accountMode: opts?.mode ?? "LIVE", isInternal: opts?.internal ?? false, currency: opts?.currency ?? "USD", balance: D(100000), leverage: 100,
    },
  });
}
// Opens a position (the trigger stamps the account's group at this moment); closes it when `closed` is given.
async function pos(fx: Fx, accountId: string, closed?: { pnl: number; at?: Date; commission?: number; swap?: number }, extra?: { status?: "VOIDED"; deleted?: boolean; side?: "BUY" | "SELL" }) {
  const o = await prisma.order.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, side: "BUY", type: "MARKET", volume: D(1), requestedPrice: D(100), idempotencyKey: `bp:${randomUUID()}`, status: "FILLED", filledPrice: D(100), filledAt: new Date() } });
  const p = await prisma.position.create({ data: { brokerId: fx.brokerId, accountId, symbolId: fx.symbolId, originOrderId: o.id, side: extra?.side ?? "BUY", volume: D(1), openPrice: D(100), bookType: "B_BOOK" } });
  if (closed || extra?.status) {
    await prisma.position.update({
      where: { id: p.id },
      data: {
        status: extra?.status ?? "CLOSED", closePrice: D(100), closedAt: closed?.at ?? new Date(), realizedPnl: closed ? D(closed.pnl) : null,
        commission: D(closed?.commission ?? 0), swap: D(closed?.swap ?? 0), deletedAt: extra?.deleted ? new Date() : null,
      },
    });
  } else if (extra?.deleted) {
    await prisma.position.update({ where: { id: p.id }, data: { deletedAt: new Date() } });
  }
  return p;
}
const scope = async (fx: Fx) => ({ brokerId: fx.brokerId, coverageAccountId: (await prisma.broker.findUniqueOrThrow({ where: { id: fx.brokerId } })).coverageAccountId });
const since = () => new Date(Date.now() - HOUR);
const json = (rows: { currency: string; amount: Prisma.Decimal; count: number }[]) => rows.map((r) => ({ currency: r.currency, amount: r.amount.toFixed(2), count: r.count }));

describe("bookPnlRealized: what counts", () => {
  it("only B_BOOK and DEALING opens on live client accounts; every exclusion is left out", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id, { pnl: 30 });   // counts: -30
    await pos(fx, (await account(fx, "DEALING")).id, { pnl: -12 }); // counts: +12
    await pos(fx, (await account(fx, "REVERSAL")).id, { pnl: 1000 });
    await pos(fx, (await account(fx, "A_BOOK")).id, { pnl: 1000 });
    await pos(fx, (await account(fx, "COVERAGE")).id, { pnl: 1000 });
    await pos(fx, (await account(fx, "B_BOOK", { mode: "DEMO" })).id, { pnl: 1000 });
    await pos(fx, (await account(fx, "B_BOOK", { internal: true })).id, { pnl: 1000 });
    const bb = await account(fx, "B_BOOK");
    await pos(fx, bb.id, { pnl: 1000 }, { status: "VOIDED" });
    await pos(fx, bb.id, { pnl: 1000 }, { deleted: true });
    await pos(fx, bb.id, { pnl: 1000, at: new Date(Date.now() - 3 * HOUR) }); // before the range
    const routed = await pos(fx, bb.id, { pnl: 1000 }); // routed to the market itself (bookType A_BOOK) in a Book group
    await prisma.position.update({ where: { id: routed.id }, data: { bookType: "A_BOOK" } });
    const hedge = await account(fx, "B_BOOK");
    await prisma.broker.update({ where: { id: fx.brokerId }, data: { coverageAccountId: hedge.id } });
    await pos(fx, hedge.id, { pnl: 1000 }); // the broker's hedge account
    const moved = await account(fx, "B_BOOK");
    await pos(fx, moved.id, { pnl: 1000 });
    await prisma.account.update({ where: { id: moved.id }, data: { groupId: fx.groups.COVERAGE } }); // now in a COVERAGE group
    expect(json(await bookPnlRealized(prisma, await scope(fx), since()))).toEqual([{ currency: "USD", amount: "-18.00", count: 2 }]);
  });

  it("snapshot: a position opened in B_BOOK still counts after the account moves to REVERSAL; one opened in REVERSAL never does", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await account(fx, "B_BOOK");
    await pos(fx, a.id, { pnl: 40 });
    await prisma.account.update({ where: { id: a.id }, data: { groupId: fx.groups.REVERSAL } });
    const r = await account(fx, "REVERSAL");
    await pos(fx, r.id, { pnl: 500 });
    await prisma.account.update({ where: { id: r.id }, data: { groupId: fx.groups.B_BOOK } });
    expect(json(await bookPnlRealized(prisma, await scope(fx), since()))).toEqual([{ currency: "USD", amount: "-40.00", count: 1 }]);
  });

  it("a row with no stamp (opened before the column existed) falls back to the account's current group", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const a = await account(fx, "DEALING");
    const p = await pos(fx, a.id, { pnl: 7 });
    const r = await account(fx, "REVERSAL");
    const q = await pos(fx, r.id, { pnl: 9 });
    await prisma.position.updateMany({ where: { id: { in: [p.id, q.id] } }, data: { groupCategoryAtOpen: null } });
    expect(json(await bookPnlRealized(prisma, await scope(fx), since()))).toEqual([{ currency: "USD", amount: "-7.00", count: 1 }]);
  });

  it("commission and swap are not part of it", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id, { pnl: 20, commission: -5, swap: -3 });
    expect(json(await bookPnlRealized(prisma, await scope(fx), since()))).toEqual([{ currency: "USD", amount: "-20.00", count: 1 }]);
  });

  it("per currency, never summed across currencies; [from, to) honoured", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id, { pnl: 10 });
    await pos(fx, (await account(fx, "B_BOOK", { currency: "EUR" })).id, { pnl: -4 });
    await pos(fx, (await account(fx, "DEALING", { currency: "EUR" })).id, { pnl: 1 });
    expect(json(await bookPnlRealized(prisma, await scope(fx), since()))).toEqual([
      { currency: "EUR", amount: "3.00", count: 2 },
      { currency: "USD", amount: "-10.00", count: 1 },
    ]);
    expect(await bookPnlRealized(prisma, await scope(fx), since(), new Date(Date.now() - HOUR / 2))).toEqual([]);
  });
});

describe("bookPnlFloating", () => {
  it("open positions repriced like the margin pass (BUY at bid, SELL at ask), same exclusions", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id);                           // client +10 -> book -10
    await pos(fx, (await account(fx, "DEALING")).id, undefined, { side: "SELL" }); // client -10.10 -> book +10.10
    await pos(fx, (await account(fx, "REVERSAL")).id);
    await pos(fx, (await account(fx, "A_BOOK")).id);
    await pos(fx, (await account(fx, "B_BOOK", { mode: "DEMO" })).id);
    await pos(fx, (await account(fx, "B_BOOK")).id, undefined, { deleted: true });
    const f = await bookPnlFloating(prisma, await scope(fx));
    expect(json(f.byCurrency)).toEqual([{ currency: "USD", amount: "0.10", count: 2 }]);
    expect(f.unpriced).toBe(0);
  });
  it("a position with no fresh price is counted as unpriced, never valued at zero", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id);
    await prisma.livePrice.update({ where: { symbol: fx.symbolName }, data: { tickAt: new Date(Date.now() - 24 * HOUR) } });
    const f = await bookPnlFloating(prisma, await scope(fx));
    expect(f).toEqual({ byCurrency: [], unpriced: 1 });
  });
});

describe("Dashboard today == Reports for the same range", () => {
  it("the dashboard's figures (legacy fields, per currency, bookPnl) equal the summary's for from = the trading-day start", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    await pos(fx, (await account(fx, "B_BOOK")).id, { pnl: 25, commission: -2 });
    await pos(fx, (await account(fx, "DEALING", { currency: "EUR" })).id, { pnl: -8 });
    const rev = await account(fx, "B_BOOK");
    await pos(fx, rev.id, { pnl: 11 });
    await prisma.account.update({ where: { id: rev.id }, data: { groupId: fx.groups.REVERSAL } }); // still counted
    await pos(fx, (await account(fx, "REVERSAL")).id, { pnl: 999 });                            // never counted
    await pos(fx, (await account(fx, "B_BOOK")).id, { pnl: 555, at: new Date(Date.now() - 3 * 24 * HOUR) }); // an earlier day
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);

    const dash = await (await (await import("@/app/api/manage/dashboard/route")).GET()).json();
    const from = dash.bookPnl.from as string;
    const { GET } = await import("@/app/api/manage/reports/summary/route");
    const sum = await (await GET(new Request(`https://t.local/api/manage/reports/summary?from=${encodeURIComponent(from)}`))).json();

    const want = [{ currency: "EUR", amount: "8.00", count: 1 }, { currency: "USD", amount: "-36.00", count: 2 }];
    expect(dash.bookPnl.realized).toEqual(want);
    expect(sum.bookPnl.realized).toEqual(want);
    expect(sum.bookPnl.from).toBe(from);
    // the per-currency tiles and the legacy single numbers come from the same function
    const tile = (c: string) => dash.clients.byCurrency.find((r: { currency: string }) => r.currency === c).brokerBookClosedToday;
    expect(tile("USD")).toEqual({ count: 2, amount: "-36.00" });
    expect(tile("EUR")).toEqual({ count: 1, amount: "8.00" });
    expect(dash.brokerBookClosedTodayCount).toBe(3);
    expect(dash.brokerBookClosedToday).toBeCloseTo(-28);
  });
  it("reports summary refuses a bad range", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: fx.adminId, role: "BROKER_ADMIN", brokerId: fx.brokerId } as never);
    const { GET } = await import("@/app/api/manage/reports/summary/route");
    expect((await GET(new Request("https://t.local/x?from=nonsense"))).status).toBe(400);
    expect((await GET(new Request("https://t.local/x?from=2026-10-02&to=2026-10-01"))).status).toBe(400);
  });
});

describe("backfill script (scripts/backfill-position-group-category.ts)", () => {
  it("dry run writes nothing; apply fills only empty rows from the current group, writes one audit row, a re-run finds nothing", async () => {
    if (!dbReachable) return;
    const fx = await fixture();
    const bb = await account(fx, "B_BOOK");
    const rv = await account(fx, "REVERSAL");
    const p1 = await pos(fx, bb.id, { pnl: 1 });
    const p2 = await pos(fx, rv.id);
    const kept = await pos(fx, bb.id); // keeps its stamp even after the account moves
    await prisma.position.updateMany({ where: { id: { in: [p1.id, p2.id] } }, data: { groupCategoryAtOpen: null } });
    await prisma.account.update({ where: { id: bb.id }, data: { groupId: fx.groups.DEALING } });
    const { backfillGroupCategory, AUDIT_ACTION } = await import("@/scripts/backfill-position-group-category");
    // this file's own database copy: every NULL row in it is one of ours or a clone leftover, counts checked as >=
    const dry = await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return backfillGroupCategory(tx, { apply: false });
    });
    expect(dry.filled).toBe(0);
    expect(dry.byCategory.DEALING).toBeGreaterThanOrEqual(1);
    expect(dry.byCategory.REVERSAL).toBeGreaterThanOrEqual(1);
    expect((await prisma.position.findUniqueOrThrow({ where: { id: p1.id } })).groupCategoryAtOpen).toBeNull();
    const auditsBefore = await prisma.auditLog.count({ where: { action: AUDIT_ACTION } });

    const applied = await prisma.$transaction((tx) => backfillGroupCategory(tx, { apply: true }));
    expect(applied.filled).toBe(Object.values(dry.byCategory).reduce((t, n) => t + n, 0));
    const byId = new Map((await prisma.position.findMany({ where: { id: { in: [p1.id, p2.id, kept.id] } } })).map((p) => [p.id, p.groupCategoryAtOpen]));
    expect(byId.get(p1.id)).toBe("DEALING"); // the account's CURRENT group (approximate history)
    expect(byId.get(p2.id)).toBe("REVERSAL");
    expect(byId.get(kept.id)).toBe("B_BOOK");
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(auditsBefore + 1);

    const again = await prisma.$transaction((tx) => backfillGroupCategory(tx, { apply: true }));
    expect(again.filled).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: AUDIT_ACTION } })).toBe(auditsBefore + 1);
    await prisma.auditLog.deleteMany({ where: { action: AUDIT_ACTION } });
  });
});
