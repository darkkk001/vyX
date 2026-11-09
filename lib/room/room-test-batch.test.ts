import "dotenv/config";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// Futurix Room test feedback (owner 2026-11-05): Analytics and the Journal read the same trades, the sidebar shows the
// broker's name beside its logo, a staff deposit names its method, and a method saved in the backoffice reaches Deposit.
vi.mock("@/lib/room/context", async (importActual) => ({ ...(await importActual<typeof import("@/lib/room/context")>()), roomApiSession: vi.fn() }));
vi.mock("@/lib/auth", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/auth")>()),
  getAdminSession: vi.fn(),
  requireAdminRole: (session: { role: string } | null, roles: string[]) => session !== null && roles.includes(session.role),
}));
vi.mock("@/lib/nats", () => ({ publishTradingEvent: vi.fn().mockResolvedValue(undefined) }));

const D = (v: number | string) => new Prisma.Decimal(v);
const s = randomUUID().replace(/-/g, "").slice(0, 10);
let dbReachable = false;
let brokerId = "";
let clientId = "";
let groupId = "";
let symbolId = "";
let seq = 0;

async function account(accountMode: "LIVE" | "DEMO") {
  seq++;
  return prisma.account.create({ data: { brokerId, clientId, accountNumber: `7${Date.now() % 1_000_000}${seq}`, email: `room-${seq}-${s}@x.local`, passwordHash: "x", fullName: "Room", accountMode, groupId, leverage: 100, balance: D(1000) } });
}
async function closedTrade(accountId: string, pnl: number) {
  const o = await prisma.order.create({ data: { brokerId, accountId, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `room-${++seq}-${s}` } });
  const now = Date.now();
  return prisma.position.create({ data: { brokerId, accountId, symbolId, originOrderId: o.id, side: "BUY", volume: D(1), openPrice: D(100), status: "CLOSED", openedAt: new Date(now - 60_000), closedAt: new Date(now - 30_000), closePrice: D(101), realizedPnl: D(pnl) } });
}
async function signedIn() {
  const { roomApiSession } = await import("@/lib/room/context");
  vi.mocked(roomApiSession).mockResolvedValue({ session: { clientId, brokerId } } as never);
}
async function screens(query: string) {
  await signedIn();
  const { GET: analytics } = await import("@/app/api/room/analytics/route");
  const { GET: journal } = await import("@/app/api/room/journal/route");
  const a = await (await analytics(new NextRequest(`https://t.local/api/room/analytics?${query}`))).json();
  const j = await (await journal(new NextRequest(`https://t.local/api/room/journal?${query}`))).json();
  return { a, j };
}

beforeAll(async () => {
  try { await prisma.$queryRaw`SELECT 1`; dbReachable = true; } catch { console.warn("room-test-batch.test.ts: DB unreachable, skipping"); return; }
  const broker = await prisma.broker.create({ data: { name: `Room ${s}`, subdomain: `room-${s}` } });
  brokerId = broker.id;
  groupId = (await prisma.group.create({ data: { brokerId, name: "g", leverage: 100 } })).id;
  clientId = (await prisma.client.create({ data: { brokerId, email: `room-${s}@x.local`, passwordHash: "x", fullName: "Room" } })).id;
  symbolId = (await prisma.symbol.findFirstOrThrow({ select: { id: true } })).id;
});

afterAll(async () => {
  if (dbReachable) await prisma.$disconnect();
});

describe("Analytics and the Journal read the same trades", () => {
  it("a client who only traded on demo sees those trades on both, for All accounts and for the account itself", async () => {
    if (!dbReachable) return;
    await account("LIVE");
    const demo = await account("DEMO");
    await closedTrade(demo.id, 25);
    await closedTrade(demo.id, -10);
    for (const query of ["account=all&period=90d", `account=${demo.id}&period=90d`]) {
      const { a, j } = await screens(query);
      expect(a.tiles.trades).toBe(2);
      expect(j.total).toBe(2);
      expect(Number(a.tiles.net)).toBe(j.rows.reduce((n: number, r: { net: string }) => n + Number(r.net), 0));
    }
  });
});

describe("History method", () => {
  it("a deposit booked by staff reads Manual, a method deposit keeps its name", async () => {
    if (!dbReachable) return;
    const acc = await account("LIVE");
    const pm = await prisma.paymentMethod.create({ data: { brokerId, type: "BANK_TRANSFER" } });
    const tx = (data: Partial<Prisma.TransactionUncheckedCreateInput>) => prisma.transaction.create({ data: { brokerId, accountId: acc.id, type: "DEPOSIT", status: "COMPLETED", amount: D(100), balanceBefore: D(0), balanceAfter: D(100), ...data } });
    const staff = await tx({ pspAdapter: "STAFF" });
    const bank = await tx({ paymentMethodId: pm.id });
    const out = await tx({ type: "WITHDRAWAL", amount: D(-50), pspAdapter: "STAFF" });
    const { roomTransactions } = await import("@/lib/room/transactions");
    const { rows } = await roomTransactions({ accountIds: [acc.id] }, new Set([acc.accountNumber]), { skip: 0, take: 10 });
    const method = (id: string) => rows.find((r) => r.id === id)?.method;
    expect(method(staff.id)).toBe("Manual");
    expect(method(bank.id)).toBe("Local Bank Transfer");
    expect(method(out.id)).toBe("Manual");
    await prisma.transaction.deleteMany({ where: { accountId: acc.id } });
    await prisma.paymentMethod.delete({ where: { id: pm.id } });
  });
});

describe("Payment methods reach the Deposit page", () => {
  it("saved and enabled through the backoffice route it is listed with its details; turned off it is gone", async () => {
    if (!dbReachable) return;
    const admin = await prisma.adminUser.create({ data: { brokerId, email: `pm-${s}@t.local`, passwordHash: "x", role: "BROKER_ADMIN" } });
    const { getAdminSession } = await import("@/lib/auth");
    vi.mocked(getAdminSession).mockResolvedValue({ adminId: admin.id, brokerId, role: "BROKER_ADMIN" } as never);
    const { PATCH } = await import("@/app/api/manage/payment-methods/route");
    const { roomMethods } = await import("@/lib/room/funds");
    const save = (enabled: boolean) => PATCH(new NextRequest("https://t.local/api/manage/payment-methods", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "USDT_TRC20", enabled, minAmount: "50", maxAmount: null, feePercent: "0", feeFixed: "0", instructions: "Send TRC-20 only", walletAddress: "TAddr123" }) }));
    expect((await save(true)).status).toBe(200);
    const listed = await roomMethods(brokerId);
    expect(listed.map((m) => [m.type, m.min, m.wallet, m.instructions])).toEqual([["USDT_TRC20", "50.00", "TAddr123", "Send TRC-20 only"]]);
    expect((await save(false)).status).toBe(200);
    expect(await roomMethods(brokerId)).toEqual([]);
  });
});

describe("Sidebar brand", () => {
  it("the sidebar asks for the name beside the logo; login and onboarding do not", () => {
    const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
    expect(src("components/room/RoomSidebar.tsx")).toContain("logoUrl={logoUrl} showName");
    expect(src("components/room/RoomBrand.tsx")).toMatch(/showName \? <>\{logo\}<span className="r-wordmark">\{name\}<\/span><\/> : logo/);
    expect(src("components/room/Onboarding.tsx")).not.toContain("showName");
  });
});

describe("Analytics: previous period, breakdown and the chart series", () => {
  it("the previous window is the same length just before; all time has none", async () => {
    const { previousWindow } = await import("@/lib/room/analytics");
    const now = new Date("2026-11-05T12:00:00Z");
    const w = previousWindow("30d", now)!;
    expect(w.to.toISOString()).toBe("2026-10-06T12:00:00.000Z");
    expect(w.from.toISOString()).toBe("2026-09-06T12:00:00.000Z");
    expect(previousWindow("all", now)).toBeNull();
  });
  it("delta is against the size of the previous figure, and absent with nothing to compare", async () => {
    const { deltaPct } = await import("@/lib/room/analytics");
    expect(deltaPct(150, 100)).toBe(50);
    expect(deltaPct(-50, -100)).toBe(50);
    expect(deltaPct(50, -100)).toBe(150);
    expect(deltaPct(10, 0)).toBeNull();
    expect(deltaPct(null, 10)).toBeNull();
  });
  it("net reconciles with the breakdown, the daily series adds up, and the previous period drives the deltas", async () => {
    if (!dbReachable) return;
    const acc = await account("LIVE");
    const closed = async (ms: number, pnl: number, swap: number, commission: number) => {
      const o = await prisma.order.create({ data: { brokerId, accountId: acc.id, symbolId, side: "BUY", type: "MARKET", volume: D(1), status: "FILLED", idempotencyKey: `room-${++seq}-${s}` } });
      await prisma.position.create({ data: { brokerId, accountId: acc.id, symbolId, originOrderId: o.id, side: "BUY", volume: D(2), openPrice: D(100), status: "CLOSED", openedAt: new Date(ms - 60_000), closedAt: new Date(ms), closePrice: D(101), realizedPnl: D(pnl), swap: D(swap), commission: D(commission) } });
    };
    const now = Date.now();
    await closed(now - 86400e3, 100, -3, 7);
    await closed(now - 2 * 86400e3, -40, 1, 2);
    await closed(now - 40 * 86400e3, 20, 0, 0); // in the 30 days before this period
    const { a } = await screens(`account=${acc.id}&period=30d`);
    expect(a.breakdown).toMatchObject({ profit: "100.00", loss: "-40.00", cost: "11.00", unrealised: "0.00" });
    expect(Number(a.tiles.net)).toBeCloseTo(100 - 40 - 11, 2);
    expect(a.deltas.net).toBe(145);
    expect(a.deltas.trades).toBe(100);
    expect(a.daily.reduce((n: number, x: { net: string }) => n + Number(x.net), 0)).toBeCloseTo(49, 2);
    expect(a.daily.reduce((n: number, x: { trades: number }) => n + x.trades, 0)).toBe(2);
    expect(a.daily.reduce((n: number, x: { lots: string }) => n + Number(x.lots), 0)).toBe(4);
    const all = (await screens(`account=${acc.id}&period=all`)).a;
    expect(Object.values(all.deltas).every((v) => v === null)).toBe(true);
    expect(all.daily.reduce((n: number, x: { trades: number }) => n + x.trades, 0)).toBe(3);
  });
});

describe("Sidebar and header", () => {
  const src = (p: string) => fs.readFileSync(path.join(process.cwd(), p), "utf8");
  it("My Tier is on the Dashboard with no tab; an old link lands there", () => {
    expect(src("components/room/RoomSidebar.tsx")).not.toContain("/room/tier");
    expect(src("app/(broker)/room/(shell)/page.tsx")).toContain("<TierPanel />");
    expect(src("app/(broker)/room/(shell)/tier/page.tsx")).toContain('redirect("/room#tier")');
  });
  it("Refer & earn sits in the foot, outside the partner-only group; the theme switch writes the cookie RoomFrame reads", () => {
    const side = src("components/room/RoomSidebar.tsx");
    expect(side.indexOf('className="r-refer"')).toBeGreaterThan(side.indexOf('className="r-side-foot"'));
    expect(src("components/room/ThemeToggle.tsx")).toContain("room_theme=");
    expect(src("components/room/RoomFrame.tsx")).toContain('get("room_theme")');
  });
});

describe("My tier", () => {
  it("since is never before the client existed, however long the unbroken run", async () => {
    const { tierSince, reviewDates } = await import("@/lib/room/tier");
    const now = new Date("2026-11-05T12:00:00Z");
    const reviews = reviewDates(now, 12);
    const silver = reviews.map(() => ({ name: "Silver" }));
    expect(tierSince(reviews, silver, new Date("2026-10-20T09:00:00Z")).toISOString()).toBe("2026-10-20T09:00:00.000Z");
    expect(tierSince(reviews, silver, new Date("2020-01-01T00:00:00Z")).toISOString()).toBe("2025-11-01T00:00:00.000Z");
    const moved = reviews.map((_, i) => ({ name: i < 3 ? "Gold" : "Silver" }));
    expect(tierSince(reviews, moved, new Date("2020-01-01T00:00:00Z")).toISOString()).toBe("2026-09-01T00:00:00.000Z");
  });
  it("a client with demo only: joined date, and the room is told there is no live account", async () => {
    if (!dbReachable) return;
    const c = await prisma.client.create({ data: { brokerId, email: `tier-${s}@x.local`, passwordHash: "x", fullName: "T" } });
    const { clientTier } = await import("@/lib/room/tier");
    const r = await clientTier(brokerId, c.id);
    expect(r.hasLiveAccount).toBe(false);
    expect(new Date(r.since).getTime()).toBe(c.createdAt.getTime());
  });
  it("one strip under the greeting, nothing of the tier left at the foot of the Dashboard", () => {
    const page = fs.readFileSync(path.join(process.cwd(), "app/(broker)/room/(shell)/page.tsx"), "utf8");
    expect(page.match(/<TierPanel \/>/g)).toHaveLength(1);
    expect(page.indexOf("<TierPanel />")).toBeLessThan(page.indexOf('"r-grid-tiles"'));
  });
  // Room UI batch (owner 2026-11-06): plans moved from cards on Accounts to rows in the open-account popup, one per
  // line inside the popup's own width, so no plan card is left to stretch
  it("plans are rows in the open-account popup, not cards on Accounts", () => {
    const modal = fs.readFileSync(path.join(process.cwd(), "components/room/OpenAccountModal.tsx"), "utf8");
    expect(modal).toContain('role="radiogroup" aria-label="Plan"');
    expect(modal).toContain('className="r-plan-row"');
    expect(fs.readFileSync(path.join(process.cwd(), "app/(broker)/room/(shell)/accounts/page.tsx"), "utf8")).not.toContain("planSpreadFrom");
  });
});

describe("owner additions 2026-11-09", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("the leverage picker reads LEVERAGE and opens on the account's current leverage, which is always an option", () => {
    const d = read("components/room/AccountDrawer.tsx");
    expect(d).toContain('<Row label="Leverage">');
    expect(d).not.toContain("New leverage");
    expect(d).toContain("useState(lev?.current ?? account.leverage)");
    expect(d).toContain("if (lev) setLevNew(lev.current)");
    expect(d).toContain("new Set([lev.current, ...lev.options])");
  });
  it("recent transactions come split by mode from the server, live by default, with a Live / Demo toggle", () => {
    const r = read("app/api/room/overview/route.ts");
    expect(r).toContain('recentOf("LIVE"), recentOf("DEMO")');
    expect(r).toMatch(/recent: recentLive,\s+recentDemo,/);
    const page = read("app/(broker)/room/(shell)/page.tsx");
    expect(page).toContain('const [mode, setMode] = useState<"LIVE" | "DEMO">("LIVE");');
    expect(page).toContain("const recent = (mode === \"LIVE\" ? data?.recent : data?.recentDemo) ?? [];");
  });
  it("the top bar shows the funding wallet's real money, nothing account-specific; the strip sums live accounts only", () => {
    const head = read("components/room/RoomHeader.tsx");
    expect(head).toContain("<WalletBalance />");
    expect(head).not.toContain("AccountPicker");
    expect(read("components/room/UserMenu.tsx")).not.toContain("AccountPicker");
    const route = read("app/api/room/overview/route.ts");
    expect(route).toContain('const realFunds = { amount: wallet ? wallet.figures.balance : "0.00", currency: wallet?.currency ?? "USD" }');
    expect(route).toMatch(/live\.length === 0\s+\? \{ currency: "USD", balance: "0\.00", equity: "0\.00", freeMargin: "0\.00", floating: "0\.00" \}/);
    expect(route).toContain('const live = withFigures.filter((a) => a.mode === "LIVE")');
    expect(read("app/(broker)/room/(shell)/page.tsx")).toContain("const f = data?.totals ?? null;");
  });
});

describe("live updates reach a wallet-only client (E2E 2026-11-09)", () => {
  it("the Room opens an observer socket for the funding wallet too, and reopens when the wallet appears", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "components/room/RoomData.tsx"), "utf8");
    expect(src).toContain("...(data?.wallet ? [data.wallet.id] : [])");
    // the ticket route covers every own account, the wallet included (no isWallet filter)
    const route = fs.readFileSync(path.join(process.cwd(), "app/api/room/ws-ticket/route.ts"), "utf8");
    expect(route).not.toContain("isWallet");
  });
});

describe("payment method label (owner 2026-11-09)", () => {
  it("a method the broker switched off says Not available, never a country reason nobody checked", () => {
    const g = fs.readFileSync(path.join(process.cwd(), "components/room/MethodGrid.tsx"), "utf8");
    expect(g).toContain('<span className="r-method-chip">Not available</span>');
    expect(g).not.toContain("in your country");
  });
});

describe("account dropdowns (owner 2026-11-09)", () => {
  it("Transfer, Deposit and Withdraw list each account as number · balance currency, never the plan name", () => {
    for (const page of ["transfer", "deposit", "withdraw"]) {
      const src = fs.readFileSync(path.join(process.cwd(), `app/(broker)/room/(shell)/${page}/page.tsx`), "utf8");
      expect(src, page).toContain("`${a.accountNumber} · ${money(a.figures.balance)} ${a.currency}`");
      expect(src, page).not.toContain("a.plan");
    }
  });
});

describe("withdraw verification card (owner 2026-11-09)", () => {
  it("shows only while KYC is not approved, the only time it blocks a withdrawal", () => {
    const src = fs.readFileSync(path.join(process.cwd(), "app/(broker)/room/(shell)/withdraw/page.tsx"), "utf8");
    expect(src).toContain('const kycStatus = funds?.kyc ?? data?.kyc.status ?? "NONE";');
    expect(src).toMatch(/\{kycStatus !== "APPROVED" \? \(\s*<div className="r-card r-pad">\s*<div[^>]*>\s*<div className="r-label">Verification<\/div>/);
  });
});

describe("deposit / withdraw field width (owner 2026-11-09)", () => {
  it("account and amount are about 260 px side by side, full width stacked on a phone", () => {
    const css = fs.readFileSync(path.join(process.cwd(), "app/(broker)/room/room.css"), "utf8");
    expect(css).toContain(".r-field-fixed { flex: 0 1 260px; min-width: 0; }");
    expect(css).toContain("@media (max-width: 768px) { .r-field-fixed { flex: 1 1 100%; } }");
    for (const [page, ids] of [["deposit", ["acct", "amt"]], ["withdraw", ["wacct", "wamt"]]] as const) {
      const src = fs.readFileSync(path.join(process.cwd(), `app/(broker)/room/(shell)/${page}/page.tsx`), "utf8");
      for (const id of ids) expect(src, `${page} ${id}`).toMatch(new RegExp(`<div className="r-field r-field-fixed">\\s*<label htmlFor="${id}"`));
    }
  });
});

describe("final Futurix Room batch (owner 2026-11-09)", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("Transfer: From and To are the 260 px fields with the arrow between them", () => {
    const t = read("app/(broker)/room/(shell)/transfer/page.tsx");
    for (const id of ["tfrom", "tto"]) expect(t, id).toMatch(new RegExp(`<div className="r-field r-field-fixed">\\s*<label htmlFor="${id}"`));
    expect(t.indexOf('className="r-xfer-arrow"')).toBeGreaterThan(t.indexOf('htmlFor="tfrom"'));
    expect(t.indexOf('className="r-xfer-arrow"')).toBeLessThan(t.indexOf('htmlFor="tto"'));
    expect(read("app/(broker)/room/room.css")).toContain(".r-xfer-arrow svg { transform: rotate(90deg); }");
  });
  it("tier strip: volume against the next threshold, a full bar on the top tier, a plain card", () => {
    const p = read("components/room/TierPanel.tsx");
    const strip = p.slice(p.indexOf("export default function TierPanel"));
    expect(strip).not.toContain("Tier volume counts live accounts");
    expect(strip).not.toContain("You are on the top tier");
    expect(strip).toContain('{n1(d.lots90)} / {d.next.minLots.toLocaleString("en-US")} lots</span>');
    expect(strip).toContain('width: "100%", height: "100%", background: "var(--r-accent)"');
    expect(read("app/(broker)/room/room.css")).toMatch(/\.r-tier-strip \{[^}]*background: var\(--r-card\); border: 1px solid var\(--r-border\);/);
  });
  it("one Live / Demo toggle at My accounts drives the cards and Recent transactions; the strip stays live-only", () => {
    const page = read("app/(broker)/room/(shell)/page.tsx");
    expect(page.match(/className="r-mini-seg"/g)).toHaveLength(1);
    expect(page.indexOf('className="r-mini-seg"')).toBeGreaterThan(page.indexOf(">My accounts<"));
    expect(page.indexOf('className="r-mini-seg"')).toBeLessThan(page.indexOf(">Recent transactions<"));
    expect(page).toContain("const cards = (data?.accounts ?? []).filter((a) => a.mode === mode);");
    expect(page).toContain("{cards.map((a) => (");
    expect(page).toContain("const f = data?.totals ?? null;");
  });
  it("sidebar foot: Refer & earn and Collapse only; the client and KYC state live in the top-right menu", () => {
    const side = read("components/room/RoomSidebar.tsx");
    expect(side).not.toContain("KYC VERIFIED");
    expect(side).not.toContain('className="r-me"');
    expect(side).not.toContain("clientId");
    expect(side).toContain('className="r-refer"');
    expect(side).toContain('className="r-rail-btn"');
    const menu = read("components/room/UserMenu.tsx");
    expect(menu).toContain('const verified = data.kyc.status === "APPROVED";');
    expect(menu).toContain("{verified ? <VerifiedBadge /> : null}");
    expect(menu).toContain("{data.client.clientId}</div>");
    expect(menu).toContain('{verified ? null : <a href="/room/verify" className="r-verify-link">Verify identity</a>}');
    expect(menu).not.toMatch(/KYC verified/i);
  });
});

describe("tier popup and dashboard verification (owner 2026-11-09)", () => {
  const read = (f: string) => fs.readFileSync(path.join(process.cwd(), f), "utf8");
  it("the All tiers popup no longer says tier volume counts live accounts", () => {
    expect(read("components/room/TierPanel.tsx")).not.toContain("Tier volume counts live accounts");
  });
  it("the dashboard Verification card shows only while KYC is not approved; Trade on fills the column otherwise", () => {
    const page = read("app/(broker)/room/(shell)/page.tsx");
    expect(page).toMatch(/\{data && data\.kyc\.status !== "APPROVED" \? \(\s*<div className="r-card r-pad">\s*<div[^>]*>\s*<div className="r-label">Verification<\/div>/);
    expect(page).toContain('<div className="r-card r-pad" style={{ flex: 1 }}>');
  });
});
