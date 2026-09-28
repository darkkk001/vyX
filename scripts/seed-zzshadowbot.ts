// Seed for the ISOLATED shadow-bot test tenant "zzshadowbot" (owner-approved plan, 2026-09-26).
//
// Stands up a broker whose only purpose is to feed the Rust shadow engine (Stage 5 soak) realistic variety on its
// risk paths -- stop-out, hedged margin, coverage (auto-hedge), mirror (group + account rule, kill-switch) and the
// negative-equity edge of a fully hedged account. It never touches another tenant:
//   - the broker is resolved ONLY by the hard-coded subdomain below; no argument can point it anywhere else, and every
//     read and write is scoped to that broker's id;
//   - it refuses to run if any of its account numbers, or its admin e-mail, already belongs to another broker;
//   - the global Symbol table is read, never written (the symbols must already exist);
//   - account numbers are 4999xxxx: BELOW the live maximum, so lib/account-provisioning.ts allocateAccountNumber
//     (MAX + 1, platform-wide) never hands out a number after them and real tenants' numbering is unaffected.
//
// Usage (DATABASE_URL and DIRECT_URL must be set in the process env -- .env is never read):
//   npx tsx scripts/seed-zzshadowbot.ts                   dry run: prints every create/update/unchanged, writes nothing
//   npx tsx scripts/seed-zzshadowbot.ts --apply --confirm-host=<db host>
//   ... --reset-trading   also wipes this tenant's positions, orders, ledger, mirror links, notifications and audit
//                         rows, clears mirror kill-switch state and puts every balance back to its seed value
//                         (for a re-seed after a soak-clock reset)
// --confirm-host is required for --apply on any non-local database and must equal the DATABASE_URL host.
// SHADOWBOT_PASSWORD (env) is the trader password of every seeded account; needed when an account is created, and
// when set on a re-run, a drifted hash is put back.
//
// Idempotent: everything is upserted by its natural key (subdomain, admin e-mail, [broker, symbol], [broker, group
// name], [group, symbol], account number, [source, target] of a mirror rule), so a second run reports 0 changes.
// Balances are trading state: set when an account is created or with --reset-trading, never on a plain re-run.
//
// Negative-equity edge (owner request): account 49990013 in "SB Hedge NBP". XAUUSD hedged margin is 0 %, so a fully
// hedged XAUUSD pair uses NO margin -> margin level is null (infinite) -> lib/risk-monitor.ts never stops it out,
// whatever the equity. The markup is ask-only (lib/group-pricing.ts applySpreadMarkup), so the bot opens SELL 1.00
// first (bid, no markup) and BUY 1.00 second (+60 pips = +6.00 per oz = -600 per lot at once): at gold ~4300 that is
// balance 600 - 2 x 50 commission = 500, floating -630 - 30 at a 0.30 raw spread -> equity -160 with used margin 0
// (scripts/seed-zzshadowbot.test.ts walks it with the app's own pricing/margin functions). It
// stays open and negative (swap -25/-25 per lot per day keeps draining it); closing it drives the balance negative
// and Broker.negativeBalanceProtection (ON) writes the excess off (lib/position-close.ts).
import { Prisma, PrismaClient, type AccountMode, type GroupModeRestriction, type GroupTier, type GroupType, type RoutingCategory, type MirrorFillPriceMode } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { isSyntheticSymbol } from "../lib/synthetic-symbols";

export const SUBDOMAIN = "zzshadowbot";
export const BROKER_NAME = "ZZ Shadow Bot (test)";
export const ADMIN_EMAIL = "seed@zzshadowbot.local";
export const COVERAGE_GROUP_NAME = "Dealer Coverage (system)"; // lib/coverage.ts's own name, found by category anyway
const D = (v: number | string) => new Prisma.Decimal(v);

// ---- the approved plan, as data ----

// BrokerSymbol per symbol: only hedgedMarginPct varies; every other field is its schema default (Futurix's shape).
export const SYMBOLS: { name: string; hedgedMarginPct: number }[] = [
  { name: "XAUUSD", hedgedMarginPct: 0 }, // fully hedged pair = 0 margin (the negative-equity edge)
  { name: "EURUSD", hedgedMarginPct: 50 },
  { name: "GBPUSD", hedgedMarginPct: 100 },
  { name: "XAGUSD", hedgedMarginPct: 200 },
  { name: "US30", hedgedMarginPct: 200 },
  { name: "BTCUSD", hedgedMarginPct: 50 }, // crypto trades at weekends
  { name: "ETHUSD", hedgedMarginPct: 200 },
];

type Gsc = { symbol: string; spreadMarkup?: number; targetTotalSpreadPips?: number; commissionPerLot?: number; swapLong?: number; swapShort?: number };
type GroupSpec = {
  name: string; category: RoutingCategory; modeRestriction: GroupModeRestriction; tier: GroupTier; leverage: number;
  marginCallLevel: number; stopOutLevel: number; isDefault: boolean; isClientSelectable: boolean; swapFree: boolean | null; configs: Gsc[];
};
const commissionOnly = (c: number, names: string[]): Gsc[] => names.map((symbol) => ({ symbol, commissionPerLot: c }));

export const GROUPS: GroupSpec[] = [
  {
    name: "SB Standard", category: "B_BOOK", modeRestriction: "ANY", tier: "STANDARD", leverage: 100, marginCallLevel: 100, stopOutLevel: 50,
    isDefault: true, isClientSelectable: true, swapFree: null,
    configs: [
      { symbol: "XAUUSD", spreadMarkup: 2.0, swapLong: -6.5, swapShort: 1.2 },
      { symbol: "EURUSD", spreadMarkup: 1.0, swapLong: -0.8, swapShort: 0.2 },
      { symbol: "GBPUSD", spreadMarkup: 1.2 },
      { symbol: "XAGUSD", spreadMarkup: 1.5 },
      { symbol: "US30", spreadMarkup: 1.5 },
      { symbol: "BTCUSD", spreadMarkup: 5.0, swapLong: -15, swapShort: -15 },
    ],
  },
  {
    name: "SB Pro", category: "B_BOOK", modeRestriction: "ANY", tier: "PRO", leverage: 500, marginCallLevel: 100, stopOutLevel: 30,
    isDefault: false, isClientSelectable: true, swapFree: null,
    configs: [
      { symbol: "XAUUSD", targetTotalSpreadPips: 3.0, commissionPerLot: 7, swapLong: -4.0, swapShort: 0.5 },
      { symbol: "EURUSD", targetTotalSpreadPips: 0.8, commissionPerLot: 7 },
      { symbol: "GBPUSD", spreadMarkup: 0.5, commissionPerLot: 7 },
      ...commissionOnly(7, ["XAGUSD", "US30", "BTCUSD", "ETHUSD"]),
    ],
  },
  {
    // desk OFF (Broker.dealingDeskAutoFillAt set) + "Always send to dealer" off = auto-fill; auto-hedge covers it
    name: "SB Dealing Desk", category: "DEALING", modeRestriction: "ANY", tier: "STANDARD", leverage: 200, marginCallLevel: 120, stopOutLevel: 80,
    isDefault: false, isClientSelectable: true, swapFree: null,
    configs: [
      { symbol: "XAUUSD", spreadMarkup: 1.5, commissionPerLot: 3.5 },
      { symbol: "EURUSD", spreadMarkup: 0.6, commissionPerLot: 3.5 },
      ...commissionOnly(3.5, ["GBPUSD", "XAGUSD", "US30", "BTCUSD", "ETHUSD"]),
    ],
  },
  {
    name: "SB Reversal", category: "REVERSAL", modeRestriction: "ANY", tier: "STANDARD", leverage: 100, marginCallLevel: 100, stopOutLevel: 50,
    isDefault: false, isClientSelectable: false, swapFree: true, configs: [],
  },
  {
    name: "SB Mirror Master", category: "B_BOOK", modeRestriction: "ANY", tier: "STANDARD", leverage: 1000, marginCallLevel: 100, stopOutLevel: 20,
    isDefault: false, isClientSelectable: false, swapFree: null, configs: [],
  },
  {
    name: "SB Hedge NBP", category: "B_BOOK", modeRestriction: "ANY", tier: "STANDARD", leverage: 1000, marginCallLevel: 100, stopOutLevel: 20,
    isDefault: false, isClientSelectable: false, swapFree: null,
    configs: [{ symbol: "XAUUSD", spreadMarkup: 60, commissionPerLot: 50, swapLong: -25, swapShort: -25 }],
  },
  {
    name: COVERAGE_GROUP_NAME, category: "COVERAGE", modeRestriction: "LIVE_ONLY", tier: "STANDARD", leverage: 500, marginCallLevel: 100, stopOutLevel: 20,
    isDefault: false, isClientSelectable: false, swapFree: null, configs: [],
  },
];

type AccountSpec = { number: string; group: string; currency: string; balance: number; leverage: number; purpose: string };
export const ACCOUNTS: AccountSpec[] = [
  { number: "49990001", group: "SB Standard", currency: "USD", balance: 10000, leverage: 100, purpose: "baseline, fan-in closes" },
  { number: "49990002", group: "SB Standard", currency: "USD", balance: 2000, leverage: 200, purpose: "own leverage above the group's" },
  { number: "49990003", group: "SB Standard", currency: "EUR", balance: 5000, leverage: 100, purpose: "FX path (EUR account, USD quotes)" },
  { number: "49990004", group: "SB Standard", currency: "USD", balance: 1000, leverage: 50, purpose: "hedged pairs, stop-out candidate" },
  { number: "49990005", group: "SB Pro", currency: "USD", balance: 25000, leverage: 500, purpose: "target spread + commission" },
  { number: "49990006", group: "SB Pro", currency: "USD", balance: 3000, leverage: 300, purpose: "source of the account mirror rule" },
  { number: "49990007", group: "SB Dealing Desk", currency: "USD", balance: 5000, leverage: 200, purpose: "auto-hedge -> coverage" },
  { number: "49990008", group: "SB Dealing Desk", currency: "USD", balance: 800, leverage: 100, purpose: "stop-out candidate at 80%" },
  { number: "49990009", group: "SB Reversal", currency: "USD", balance: 10000, leverage: 100, purpose: "group mirror source" },
  { number: "49990010", group: "SB Reversal", currency: "USD", balance: 2500, leverage: 100, purpose: "group mirror source" },
  { number: "49990011", group: "SB Mirror Master", currency: "USD", balance: 100000, leverage: 1000, purpose: "group mirror target" },
  { number: "49990012", group: "SB Mirror Master", currency: "USD", balance: 50000, leverage: 1000, purpose: "account mirror target" },
  { number: "49990013", group: "SB Hedge NBP", currency: "USD", balance: 600, leverage: 1000, purpose: "fully hedged XAUUSD -> negative equity, never stopped out" },
  { number: "49990099", group: COVERAGE_GROUP_NAME, currency: "USD", balance: 1000000, leverage: 500, purpose: "the broker's coverage account" },
];
export const COVERAGE_ACCOUNT = "49990099";

type MirrorSpec = { key: string; sourceType: "GROUP" | "ACCOUNT"; source: string; target: string; multiplier: number; fillPriceMode: MirrorFillPriceMode; maxOpenLots: number | null; maxDailyLoss: number | null };
export const MIRRORS: MirrorSpec[] = [
  { key: "group rule", sourceType: "GROUP", source: "SB Reversal", target: "49990011", multiplier: 1, fillPriceMode: "SOURCE_PRICE", maxOpenLots: null, maxDailyLoss: null },
  { key: "account rule", sourceType: "ACCOUNT", source: "49990006", target: "49990012", multiplier: 0.5, fillPriceMode: "MARKET", maxOpenLots: 5, maxDailyLoss: 2000 },
];

// ---- engine ----

export class SeedRefused extends Error {}
type Db = Prisma.TransactionClient;
export type SeedOptions = { apply: boolean; resetTrading: boolean; passwordHash?: string | null; password?: string | null };
export type SeedResult = { lines: string[]; changes: number; brokerId: string | null };

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b) || typeof a === "number" || typeof b === "number") {
    return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(new Prisma.Decimal(b as Prisma.Decimal.Value));
  }
  return a === b;
}
const show = (v: unknown) => (v == null ? "null" : v instanceof Date ? v.toISOString() : String(v));

/** The fields of `want` that differ from `have`, as "field: old -> new". */
function diff(have: Record<string, unknown>, want: Record<string, unknown>): string[] {
  return Object.keys(want).filter((k) => !same(have[k], want[k])).map((k) => `${k}: ${show(have[k])} -> ${show(want[k])}`);
}

// the pre-Stage-1 shadow column, derived exactly like lib/group-routing.ts legacyGroupTypeFor
function legacyGroupType(category: RoutingCategory, mode: GroupModeRestriction): GroupType {
  if (category === "COVERAGE") return "COVERAGE";
  if (mode === "DEMO_ONLY") return "DEMO";
  if (category === "A_BOOK") return "LP";
  return "DEALING";
}

export async function seedShadowBot(db: Db, opts: SeedOptions): Promise<SeedResult> {
  const lines: string[] = [];
  let changes = 0;
  const log = (s: string) => lines.push(s);
  const change = async (label: string, fn: () => Promise<unknown>) => {
    changes++;
    log(label);
    if (opts.apply) await fn();
  };
  const NEW = "(new)";

  // ---- guards (all before any write) ----
  const broker = await db.broker.findUnique({ where: { subdomain: SUBDOMAIN } });
  if (broker && broker.subdomain !== SUBDOMAIN) throw new SeedRefused("broker lookup returned a different subdomain");
  const sameName = await db.broker.findFirst({ where: { name: BROKER_NAME, subdomain: { not: SUBDOMAIN } }, select: { subdomain: true } });
  if (sameName) throw new SeedRefused(`a broker named "${BROKER_NAME}" already exists under subdomain ${sameName.subdomain}`);
  const numbers = ACCOUNTS.map((a) => a.number);
  const foreignAccounts = await db.account.findMany({
    where: { accountNumber: { in: numbers }, ...(broker ? { brokerId: { not: broker.id } } : {}) },
    select: { accountNumber: true, brokerId: true },
  });
  if (foreignAccounts.length > 0) {
    throw new SeedRefused(`account number(s) ${foreignAccounts.map((a) => a.accountNumber).join(", ")} already belong to another broker -- refusing`);
  }
  const admin = await db.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
  if (admin && admin.brokerId !== broker?.id) throw new SeedRefused(`${ADMIN_EMAIL} already exists outside ${SUBDOMAIN} -- refusing`);
  const symbolRows = await db.symbol.findMany({ where: { name: { in: SYMBOLS.map((s) => s.name) } }, select: { id: true, name: true } });
  const symbolId = new Map(symbolRows.map((s) => [s.name, s.id]));
  const missing = SYMBOLS.filter((s) => !symbolId.has(s.name)).map((s) => s.name);
  if (missing.length) throw new SeedRefused(`global Symbol row(s) missing: ${missing.join(", ")} (this script never creates symbols)`);
  const existingAccounts = await db.account.findMany({ where: { accountNumber: { in: numbers } } });
  if (opts.apply && !opts.passwordHash && existingAccounts.length < ACCOUNTS.length) {
    throw new SeedRefused("SHADOWBOT_PASSWORD must be set: at least one account is created by this run");
  }

  log(`tenant ${SUBDOMAIN}: ${broker ? `exists (${broker.id})` : "absent"}  mode: ${opts.apply ? "APPLY" : "DRY RUN"}${opts.resetTrading ? " + RESET TRADING" : ""}`);

  // ---- broker ----
  const brokerWant = {
    name: BROKER_NAME, status: "ACTIVE", pricingEngineEnabled: true, negativeBalanceProtection: true,
    tradingHaltedAt: null, closeOnlyAt: null, dealingModeAt: null, smartDealerAcceptPct: null, smartDealerRejectPct: null,
    defaultMaxSlippagePips: null, totalExposureLimit: null, maxOpenPositionsPerAccount: null, emailEnabled: false, ssoSecret: null,
  };
  let brokerId: string;
  if (!broker) {
    brokerId = NEW;
    await change(`CREATE broker ${SUBDOMAIN} "${BROKER_NAME}" ACTIVE, pricing engine on, desk OFF (auto-fill), auto-hedge ON, NBP on`, async () => {
      const now = new Date();
      const b = await db.broker.create({ data: { subdomain: SUBDOMAIN, ...brokerWant, status: "ACTIVE", dealingDeskAutoFillAt: now, autoHedgeAt: now } });
      brokerId = b.id;
    });
  } else {
    brokerId = broker.id;
    const d = diff(broker as unknown as Record<string, unknown>, brokerWant);
    if (!broker.dealingDeskAutoFillAt) d.push("dealingDeskAutoFillAt: null -> now (desk OFF)");
    if (!broker.autoHedgeAt) d.push("autoHedgeAt: null -> now (auto-hedge ON)");
    if (d.length) {
      await change(`UPDATE broker ${SUBDOMAIN}: ${d.join("; ")}`, () =>
        db.broker.update({
          where: { id: broker.id },
          data: { ...brokerWant, status: "ACTIVE", dealingDeskAutoFillAt: broker.dealingDeskAutoFillAt ?? new Date(), autoHedgeAt: broker.autoHedgeAt ?? new Date() },
        })
      );
    } else log(`ok     broker ${SUBDOMAIN}`);
  }
  const bid = () => brokerId; // resolved after the create when applying

  // ---- reset trading (before the config, so balances are re-seeded below) ----
  if (opts.resetTrading && broker) {
    const where = { brokerId: broker.id };
    const counts = {
      mirrorLinks: await db.mirrorLink.count({ where: { rule: where } }),
      positionActionRequests: await db.positionActionRequest.count({ where }),
      postCloseEffects: await db.postCloseEffect.count({ where }),
      balanceAdjustmentRequests: await db.balanceAdjustmentRequest.count({ where }),
      positions: await db.position.count({ where }),
      orders: await db.order.count({ where }),
      transactions: await db.transaction.count({ where }),
      notifications: await db.notification.count({ where }),
      priceAlerts: await db.priceAlert.count({ where }),
      loginEvents: await db.loginEvent.count({ where }),
      // the seed scripts' own records (SHADOWBOT_SEED, SHADOWBOT_SYNTH_SEED, ...) are kept: the tenant's setup history
      auditLogs: await db.auditLog.count({ where: { ...where, NOT: { action: { startsWith: "SHADOWBOT_" } } } }),
    };
    const total = Object.values(counts).reduce((s, n) => s + n, 0);
    if (total === 0) log("ok     reset trading: nothing to delete");
    else {
      await change(`DELETE (reset trading, ${SUBDOMAIN} only): ${Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(", ")}`, async () => {
        await db.mirrorLink.deleteMany({ where: { rule: where } });
        await db.positionActionRequest.deleteMany({ where });
        await db.postCloseEffect.deleteMany({ where });
        await db.balanceAdjustmentRequest.deleteMany({ where });
        await db.position.updateMany({ where, data: { coveragePositionId: null, closePendingOrderId: null } });
        await db.order.updateMany({ where, data: { closesPositionId: null } });
        await db.position.deleteMany({ where });
        await db.order.deleteMany({ where });
        await db.transaction.deleteMany({ where });
        await db.notification.deleteMany({ where });
        await db.priceAlert.deleteMany({ where });
        await db.loginEvent.deleteMany({ where });
        await db.auditLog.deleteMany({ where: { ...where, NOT: { action: { startsWith: "SHADOWBOT_" } } } });
      });
    }
  }

  // ---- seed admin (DISABLED: owns the mirror rules, never signs in) ----
  let adminId = admin?.id ?? NEW;
  if (!admin) {
    await change(`CREATE admin ${ADMIN_EMAIL} BROKER_ADMIN, DISABLED (random password, cannot sign in)`, async () => {
      const a = await db.adminUser.create({
        data: { brokerId: bid(), email: ADMIN_EMAIL, passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 10), role: "BROKER_ADMIN", status: "DISABLED" },
      });
      adminId = a.id;
    });
  } else {
    const d = diff(admin as unknown as Record<string, unknown>, { role: "BROKER_ADMIN", status: "DISABLED", twoFactorEnabled: false });
    if (d.length) await change(`UPDATE admin ${ADMIN_EMAIL}: ${d.join("; ")}`, () => db.adminUser.update({ where: { id: admin.id }, data: { role: "BROKER_ADMIN", status: "DISABLED", twoFactorEnabled: false } }));
    else log(`ok     admin ${ADMIN_EMAIL} (DISABLED)`);
  }

  // ---- broker symbols ----
  const bsRows = broker ? await db.brokerSymbol.findMany({ where: { brokerId: broker.id }, include: { symbol: { select: { name: true } } } }) : [];
  for (const s of SYMBOLS) {
    const want = {
      enabled: true, tradingMode: "BOTH", hedgedMarginPct: s.hedgedMarginPct, spreadMarkup: 0, commissionPerLot: 0, swapLong: 0, swapShort: 0,
      minLot: 0.01, maxLot: 100, lotStep: 0.01, maxExposure: null, stopLevel: 0, defaultBookType: "B_BOOK",
    };
    const data = { ...want, hedgedMarginPct: D(s.hedgedMarginPct), spreadMarkup: D(0), commissionPerLot: D(0), swapLong: D(0), swapShort: D(0), minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" as const, defaultBookType: "B_BOOK" as const };
    const row = bsRows.find((r) => r.symbol.name === s.name);
    if (!row) await change(`CREATE symbol ${s.name} (hedged margin ${s.hedgedMarginPct}%)`, () => db.brokerSymbol.create({ data: { brokerId: bid(), symbolId: symbolId.get(s.name)!, ...data } }));
    else {
      const d = diff(row as unknown as Record<string, unknown>, want);
      if (d.length) await change(`UPDATE symbol ${s.name}: ${d.join("; ")}`, () => db.brokerSymbol.update({ where: { id: row.id }, data }));
      else log(`ok     symbol ${s.name} (hedged margin ${s.hedgedMarginPct}%)`);
    }
  }
  // synthetic symbols (v*) belong to scripts/seed-zzshadowbot-synth.ts: never disabled here
  for (const row of bsRows.filter((r) => r.enabled && !isSyntheticSymbol(r.symbol.name) && !SYMBOLS.some((s) => s.name === r.symbol.name))) {
    await change(`DISABLE symbol ${row.symbol.name} (not in the plan)`, () => db.brokerSymbol.update({ where: { id: row.id }, data: { enabled: false } }));
  }

  // ---- groups + per-symbol config ----
  const groupRows = broker ? await db.group.findMany({ where: { brokerId: broker.id }, include: { symbolConfigs: { include: { symbol: { select: { name: true } } } } } }) : [];
  const groupId = new Map<string, string>(groupRows.map((g) => [g.name, g.id]));
  for (const g of GROUPS) {
    const want = {
      leverage: g.leverage, marginCallLevel: g.marginCallLevel, stopOutLevel: g.stopOutLevel, isDefault: g.isDefault, category: g.category,
      modeRestriction: g.modeRestriction, groupType: legacyGroupType(g.category, g.modeRestriction), isClientSelectable: g.isClientSelectable,
      forceDealingMode: false, dealingMode: "INHERIT", tier: g.tier, swapFree: g.swapFree, restrictSymbols: false, tradingRestriction: "BOTH",
      tradingHaltedAt: null, closeOnlyAt: null, maxLotSize: null,
    };
    const data = { ...want, marginCallLevel: D(g.marginCallLevel), stopOutLevel: D(g.stopOutLevel), dealingMode: "INHERIT" as const, tradingRestriction: "BOTH" as const };
    const row = groupRows.find((r) => r.name === g.name);
    const label = `${g.name} [${g.category}, 1:${g.leverage}, MC ${g.marginCallLevel}/SO ${g.stopOutLevel}]`;
    if (!row) {
      groupId.set(g.name, NEW);
      await change(`CREATE group ${label}`, async () => {
        const created = await db.group.create({ data: { brokerId: bid(), name: g.name, ...data } });
        groupId.set(g.name, created.id);
      });
    } else {
      const d = diff(row as unknown as Record<string, unknown>, want);
      if (d.length) await change(`UPDATE group ${g.name}: ${d.join("; ")}`, () => db.group.update({ where: { id: row.id }, data }));
      else log(`ok     group ${label}`);
    }
    const existing = row?.symbolConfigs ?? [];
    for (const c of g.configs) {
      const want = {
        spreadMarkup: c.spreadMarkup ?? null, targetTotalSpreadPips: c.targetTotalSpreadPips ?? null, commissionPerLot: c.commissionPerLot ?? null,
        swapLong: c.swapLong ?? null, swapShort: c.swapShort ?? null,
      };
      const data = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v == null ? null : D(v)])) as Record<keyof typeof want, Prisma.Decimal | null>;
      const text = Object.entries(want).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(", ");
      const cfg = existing.find((e) => e.symbol.name === c.symbol);
      if (!cfg) await change(`CREATE config ${g.name} / ${c.symbol}: ${text}`, () => db.groupSymbolConfig.create({ data: { groupId: groupId.get(g.name)!, symbolId: symbolId.get(c.symbol)!, ...data } }));
      else {
        const d = diff(cfg as unknown as Record<string, unknown>, want);
        if (d.length) await change(`UPDATE config ${g.name} / ${c.symbol}: ${d.join("; ")}`, () => db.groupSymbolConfig.update({ where: { id: cfg.id }, data }));
        else log(`ok     config ${g.name} / ${c.symbol}: ${text}`);
      }
    }
    // synthetic symbols' configs (v*) belong to scripts/seed-zzshadowbot-synth.ts: never deleted here
    for (const cfg of existing.filter((e) => !isSyntheticSymbol(e.symbol.name) && !g.configs.some((c) => c.symbol === e.symbol.name))) {
      await change(`DELETE config ${g.name} / ${cfg.symbol.name} (not in the plan)`, () => db.groupSymbolConfig.delete({ where: { id: cfg.id } }));
    }
  }
  for (const row of groupRows.filter((r) => !GROUPS.some((g) => g.name === r.name))) log(`NOTE   extra group "${row.name}" is not in the plan (left alone)`);

  // ---- accounts ----
  const passwordFor = async (hash: string) => (opts.password ? !(await bcrypt.compare(opts.password, hash)) : false);
  const accountId = new Map<string, string>(existingAccounts.map((a) => [a.accountNumber, a.id]));
  for (const a of ACCOUNTS) {
    const row = existingAccounts.find((r) => r.accountNumber === a.number);
    const want = {
      groupId: groupId.get(a.group)!, currency: a.currency, leverage: a.leverage, accountMode: "LIVE", status: "ACTIVE",
      fullName: `Shadow Bot ${a.number}`, email: `sb.${a.number}@zzshadowbot.local`, swapFree: null, maxDailyLoss: null, accountTypeId: null, clientId: null,
    };
    const data = { ...want, accountMode: "LIVE" as AccountMode, status: "ACTIVE" as const };
    const label = `${a.number} ${a.group} ${a.currency} ${a.balance} 1:${a.leverage} (${a.purpose})`;
    if (!row) {
      accountId.set(a.number, NEW);
      await change(`CREATE account ${label}`, async () => {
        const created = await db.account.create({ data: { brokerId: bid(), accountNumber: a.number, passwordHash: opts.passwordHash!, ...data, groupId: groupId.get(a.group)!, balance: D(a.balance) } });
        accountId.set(a.number, created.id);
        await db.transaction.create({
          data: { brokerId: bid(), accountId: created.id, type: "ADJUSTMENT", status: "COMPLETED", amount: D(a.balance), balanceBefore: D(0), balanceAfter: D(a.balance), note: "Initial balance (zzshadowbot seed)" },
        });
      });
      continue;
    }
    const d = diff(row as unknown as Record<string, unknown>, want);
    if (row.currency !== a.currency && !opts.resetTrading) {
      throw new SeedRefused(`account ${a.number} currency is ${row.currency}, the plan says ${a.currency}: changing it under open history needs --reset-trading`);
    }
    if (await passwordFor(row.passwordHash)) d.push("password: (drifted) -> SHADOWBOT_PASSWORD");
    if (opts.resetTrading) {
      const bal = { balance: D(a.balance), credit: D(0), marginCallNotifiedAt: null };
      const bd = diff(row as unknown as Record<string, unknown>, bal);
      await change(`RESET account ${a.number}: balance -> ${a.balance}${bd.length ? ` (${bd.join("; ")})` : ""}, fresh initial-balance ledger row${d.length ? `; ${d.join("; ")}` : ""}`, async () => {
        await db.account.update({ where: { id: row.id }, data: { ...data, ...bal, ...(opts.password && (await passwordFor(row.passwordHash)) ? { passwordHash: opts.passwordHash! } : {}) } });
        await db.transaction.create({
          data: { brokerId: row.brokerId, accountId: row.id, type: "ADJUSTMENT", status: "COMPLETED", amount: D(a.balance), balanceBefore: D(0), balanceAfter: D(a.balance), note: "Initial balance (zzshadowbot seed, reset)" },
        });
      });
    } else if (d.length) {
      await change(`UPDATE account ${a.number}: ${d.join("; ")}`, async () =>
        db.account.update({ where: { id: row.id }, data: { ...data, ...(opts.password && (await passwordFor(row.passwordHash)) ? { passwordHash: opts.passwordHash! } : {}) } })
      );
    } else log(`ok     account ${label.replace(` ${a.balance} `, ` (balance ${row.balance.toFixed(2)}) `)}`);
  }
  const extraAccounts = broker ? await db.account.findMany({ where: { brokerId: broker.id, accountNumber: { notIn: numbers } }, select: { accountNumber: true } }) : [];
  for (const x of extraAccounts) log(`NOTE   extra account ${x.accountNumber} is not in the plan (left alone)`);
  const extraAccountSymbolConfigs = broker ? await db.accountSymbolConfig.count({ where: { account: { brokerId: broker.id } } }) : 0;
  if (extraAccountSymbolConfigs) await change(`DELETE ${extraAccountSymbolConfigs} per-account pricing override(s) (not in the plan)`, () => db.accountSymbolConfig.deleteMany({ where: { account: { brokerId: bid() } } }));

  // ---- coverage pointer ----
  const covId = accountId.get(COVERAGE_ACCOUNT)!;
  if (broker?.coverageAccountId && broker.coverageAccountId === covId) log(`ok     coverage account = ${COVERAGE_ACCOUNT}`);
  else await change(`SET coverage account = ${COVERAGE_ACCOUNT}${broker?.coverageAccountId ? ` (was ${broker.coverageAccountId})` : ""}`, () => db.broker.update({ where: { id: bid() }, data: { coverageAccountId: accountId.get(COVERAGE_ACCOUNT)! } }));

  // ---- mirror rules ----
  const ruleRows = broker ? await db.mirrorRule.findMany({ where: { brokerId: broker.id } }) : [];
  const matched = new Set<string>();
  for (const m of MIRRORS) {
    const sourceId = m.sourceType === "GROUP" ? groupId.get(m.source)! : accountId.get(m.source)!;
    const targetId = accountId.get(m.target)!;
    const want = { direction: "REVERSE", multiplier: m.multiplier, fillPriceMode: m.fillPriceMode, symbolFilter: null, maxOpenLots: m.maxOpenLots, maxDailyLoss: m.maxDailyLoss };
    const data = { ...want, direction: "REVERSE" as const, multiplier: D(m.multiplier), maxOpenLots: m.maxOpenLots == null ? null : D(m.maxOpenLots), maxDailyLoss: m.maxDailyLoss == null ? null : D(m.maxDailyLoss) };
    const runtime = { enabled: true, killedAt: null, failureCount: 0 };
    const label = `${m.key}: ${m.sourceType} ${m.source} -> ${m.target}, REVERSE x${m.multiplier}, ${m.fillPriceMode}, max lots ${show(m.maxOpenLots)}, max daily loss ${show(m.maxDailyLoss)}`;
    const row = ruleRows.find((r) => r.sourceType === m.sourceType && r.sourceId === sourceId && r.targetAccountId === targetId);
    if (!row) {
      await change(`CREATE mirror ${label}`, () =>
        db.mirrorRule.create({ data: { brokerId: bid(), sourceType: m.sourceType, sourceId: m.sourceType === "GROUP" ? groupId.get(m.source)! : accountId.get(m.source)!, targetAccountId: accountId.get(m.target)!, createdById: adminId, ...data, ...runtime } })
      );
      continue;
    }
    matched.add(row.id);
    const d = diff(row as unknown as Record<string, unknown>, want);
    const rd = diff(row as unknown as Record<string, unknown>, runtime);
    if (rd.length && !opts.resetTrading) log(`NOTE   mirror ${m.key} runtime state ${rd.join("; ")} (kill-switch state is trading state: --reset-trading clears it)`);
    const all = opts.resetTrading ? [...d, ...rd] : d;
    if (all.length) await change(`UPDATE mirror ${m.key}: ${all.join("; ")}`, () => db.mirrorRule.update({ where: { id: row.id }, data: opts.resetTrading ? { ...data, ...runtime } : data }));
    else log(`ok     mirror ${label}`);
  }
  for (const r of ruleRows.filter((r) => !matched.has(r.id) && r.enabled)) {
    await change(`DISABLE mirror rule ${r.id} (${r.sourceType} ${r.sourceId} -> ${r.targetAccountId}, not in the plan)`, () => db.mirrorRule.update({ where: { id: r.id }, data: { enabled: false } }));
  }

  if (changes > 0 && opts.apply) {
    await db.auditLog.create({
      data: { brokerId: bid(), actorAdminId: null, action: "SHADOWBOT_SEED", entityType: "Broker", entityId: bid(), newValue: { changes, resetTrading: opts.resetTrading } },
    });
  }
  log(`${changes} change(s)${opts.apply ? " applied" : " planned (dry run: nothing written)"}`);
  return { lines, changes, brokerId: brokerId === NEW ? null : brokerId };
}

// ---- CLI ----

export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

async function main() {
  const args = process.argv.slice(2);
  const known = ["--apply", "--reset-trading"];
  const apply = args.includes("--apply");
  const resetTrading = args.includes("--reset-trading");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => !known.includes(a) && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new SeedRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  // Prisma would silently fall back to ./.env (a dead database) -- both must be explicit and agree on the endpoint
  if (!url || !direct) throw new SeedRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new SeedRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new SeedRefused(`--apply on ${host} needs --confirm-host=${host}`);
  const password = process.env.SHADOWBOT_PASSWORD || null;
  if (password && password.length < 8) throw new SeedRefused("SHADOWBOT_PASSWORD must be at least 8 characters");
  const passwordHash = password ? await bcrypt.hash(password, 10) : null;

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return seedShadowBot(tx, { apply, resetTrading, password, passwordHash });
      },
      { timeout: 180_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /seed-zzshadowbot\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof SeedRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
