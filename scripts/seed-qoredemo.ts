// Seed for the public QoreTrader demo tenant (owner-approved plan 2026-10-12): demo.qoretrader.com, WebTrader with simulated prices.
//
// What it creates (all idempotent, nothing is ever deleted):
//   - the Broker "QoreTrader Demo" (subdomain qoredemo, customDomain demo.qoretrader.com, ACTIVE, no e-mail, no SSO, no dealer
//     desk, no auto-hedge, negative-balance protection on, 20 open positions per account, USD),
//   - one DISABLED admin (random password nobody knows; it only exists so the tenant has an owner row),
//   - ONE group "Demo" (B_BOOK, DEMO_ONLY, the default group, 1:100, margin call 100 / stop-out 50),
//   - the seven global Symbol rows qXAUUSD qEURUSD qGBPUSD qUSDJPY qBTCUSD qUS30 qNAS100 (lib/demo-prices.ts),
//   - one BrokerSymbol per symbol for the demo broker ONLY (B_BOOK, zero spread markup / commission / swap) with trading hours
//     Monday..Sunday 00:00-24:00 (the simulated market never closes).
// No accounts are created: guests are made by POST /api/demo/guest, numbers 48000000-48999999.
//
// Safety, in the order it checks (everything before the first write):
//   - the broker is found ONLY by the hard-coded subdomain; it refuses if the custom domain or the name already belongs to
//     another broker, if a q-symbol exists with a different definition, if a real symbol (XAUUSD ...) disagrees with the
//     demo's digits / contract size, and if any account in the guest range belongs to somebody else (or exists before the
//     demo broker does);
//   - DRY RUN by default (a READ ONLY transaction: it cannot write); --apply --confirm-host=<db host> is needed to write;
//   - DATABASE_URL and DIRECT_URL must be in the environment and name the same database; ./.env is never read.
//
// Usage:
//   npx tsx scripts/seed-qoredemo.ts                              dry run: prints every create / update / unchanged
//   npx tsx scripts/seed-qoredemo.ts --apply --confirm-host=<db host>
// After applying: set DEMO_BROKER_SUBDOMAIN=qoredemo in the Vercel project (and add demo.qoretrader.com to it).
import { Prisma, PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { DEMO_SYMBOLS } from "../lib/demo-prices";
import { DEMO_LOGO_URL, DEMO_PRIMARY } from "../lib/demo-brand";
import { GUEST_NUMBER_MAX, GUEST_NUMBER_MIN } from "../lib/demo-policy";

export const SUBDOMAIN = "qoredemo";
export const CUSTOM_DOMAIN = "demo.qoretrader.com";
export const BROKER_NAME = "QoreTrader Demo";
export const ADMIN_EMAIL = "seed@qoredemo.local";
export const GROUP_NAME = "Demo";
export const GROUP = { leverage: 100, marginCallLevel: 100, stopOutLevel: 50 };
const D = (v: number | string) => new Prisma.Decimal(v);

export class SeedRefused extends Error {}
type Db = Prisma.TransactionClient;
export type SeedOptions = { apply: boolean };
export type SeedResult = { lines: string[]; changes: number; brokerId: string | null };

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b) || typeof a === "number" || typeof b === "number") {
    return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(new Prisma.Decimal(b as Prisma.Decimal.Value));
  }
  return a === b;
}
const show = (v: unknown) => (v == null ? "null" : v instanceof Date ? v.toISOString() : String(v));
function diff(have: Record<string, unknown>, want: Record<string, unknown>): string[] {
  return Object.keys(want).filter((k) => !same(have[k], want[k])).map((k) => `${k}: ${show(have[k])} -> ${show(want[k])}`);
}

const DAYS = [0, 1, 2, 3, 4, 5, 6];

export async function seedQoreDemo(db: Db, opts: SeedOptions): Promise<SeedResult> {
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
  const domainOwner = await db.broker.findUnique({ where: { customDomain: CUSTOM_DOMAIN }, select: { subdomain: true } });
  if (domainOwner && domainOwner.subdomain !== SUBDOMAIN) throw new SeedRefused(`${CUSTOM_DOMAIN} already belongs to the broker ${domainOwner.subdomain}`);
  const sameName = await db.broker.findFirst({ where: { name: BROKER_NAME, subdomain: { not: SUBDOMAIN } }, select: { subdomain: true } });
  if (sameName) throw new SeedRefused(`a broker named "${BROKER_NAME}" already exists under subdomain ${sameName.subdomain}`);

  const qRows = await db.symbol.findMany({ where: { name: { in: DEMO_SYMBOLS.map((d) => d.name) } } });
  for (const d of DEMO_SYMBOLS) {
    const row = qRows.find((r) => r.name === d.name);
    if (!row) continue;
    const bad = diff(row as unknown as Record<string, unknown>, { baseCurrency: d.baseCurrency, quoteCurrency: d.quoteCurrency, digits: d.digits, contractSize: d.contractSize, category: d.category });
    if (bad.length) throw new SeedRefused(`symbol ${d.name} exists with a different definition (${bad.join("; ")}) -- refusing to touch it`);
  }
  const realRows = await db.symbol.findMany({ where: { name: { in: DEMO_SYMBOLS.map((d) => d.display) } }, select: { name: true, digits: true, contractSize: true } });
  for (const d of DEMO_SYMBOLS) {
    const real = realRows.find((r) => r.name === d.display);
    if (real && (real.digits !== d.digits || !real.contractSize.equals(d.contractSize))) {
      throw new SeedRefused(`the real symbol ${d.display} has digits ${real.digits} / contract size ${real.contractSize}, the demo has ${d.digits} / ${d.contractSize}: fix lib/demo-prices.ts first`);
    }
  }
  const rangeAccounts = await db.$queryRaw<{ accountNumber: string; brokerId: string }[]>`
    SELECT "accountNumber", "brokerId" FROM "Account" WHERE "accountNumber" ~ '^48[0-9]{6}$' LIMIT 20
  `;
  const foreign = rangeAccounts.filter((a) => !broker || a.brokerId !== broker.id);
  if (foreign.length > 0) {
    throw new SeedRefused(`account number(s) ${foreign.map((a) => a.accountNumber).join(", ")} inside the guest range ${GUEST_NUMBER_MIN}-${GUEST_NUMBER_MAX} do not belong to the demo broker -- refusing`);
  }
  const admin = await db.adminUser.findUnique({ where: { email: ADMIN_EMAIL } });
  if (admin && admin.brokerId !== broker?.id) throw new SeedRefused(`${ADMIN_EMAIL} already exists outside ${SUBDOMAIN} -- refusing`);

  log(`tenant ${SUBDOMAIN}: ${broker ? `exists (${broker.id})` : "absent"}  mode: ${opts.apply ? "APPLY" : "DRY RUN"}`);
  log(`guards ok: domain free, name free, ${DEMO_SYMBOLS.length} q-symbols consistent, real symbols agree (${realRows.length} found), guest range clean (${rangeAccounts.length} guest account(s) of this tenant)`);

  // ---- broker ----
  const brokerWant = {
    name: BROKER_NAME, customDomain: CUSTOM_DOMAIN, tier: "STANDARD", status: "ACTIVE", executionEngine: "LEGACY",
    emailEnabled: false, ssoSecret: null, autoHedgeAt: null, dealingDeskAutoFillAt: null, dealingModeAt: null, smartDealerAcceptPct: null, smartDealerRejectPct: null,
    negativeBalanceProtection: true, maxOpenPositionsPerAccount: 20, defaultAccountCurrency: "USD", defaultAccountLeverage: GROUP.leverage,
    logoUrl: DEMO_LOGO_URL, primaryColor: DEMO_PRIMARY, supportEmail: null, tradingHaltedAt: null, closeOnlyAt: null, totalExposureLimit: null,
    hedgingAllowed: true, pricingEngineEnabled: false, requireAdmin2fa: false,
  };
  let brokerId: string;
  if (!broker) {
    brokerId = NEW;
    await change(`CREATE broker ${SUBDOMAIN} "${BROKER_NAME}" ${CUSTOM_DOMAIN} ACTIVE, 20 open positions per account, NBP on, no e-mail / SSO / dealer desk / auto-hedge, logo ${DEMO_LOGO_URL}, primary ${DEMO_PRIMARY}`, async () => {
      const b = await db.broker.create({ data: { ...(brokerWant as Omit<Prisma.BrokerUncheckedCreateInput, "subdomain">), subdomain: SUBDOMAIN } });
      brokerId = b.id;
    });
  } else {
    brokerId = broker.id;
    const d = diff(broker as unknown as Record<string, unknown>, brokerWant);
    if (d.length) await change(`UPDATE broker ${SUBDOMAIN}: ${d.join("; ")}`, () => db.broker.update({ where: { id: broker.id }, data: brokerWant as Prisma.BrokerUncheckedUpdateInput }));
    else log(`ok     broker ${SUBDOMAIN}`);
  }
  const bid = () => brokerId; // resolved after the create when applying

  // ---- disabled admin ----
  if (!admin) {
    await change(`CREATE admin ${ADMIN_EMAIL} BROKER_ADMIN, DISABLED (random password, cannot sign in)`, async () => {
      await db.adminUser.create({ data: { brokerId: bid(), email: ADMIN_EMAIL, passwordHash: await bcrypt.hash(randomBytes(24).toString("hex"), 10), role: "BROKER_ADMIN", status: "DISABLED" } });
    });
  } else {
    const d = diff(admin as unknown as Record<string, unknown>, { role: "BROKER_ADMIN", status: "DISABLED", twoFactorEnabled: false });
    if (d.length) await change(`UPDATE admin ${ADMIN_EMAIL}: ${d.join("; ")}`, () => db.adminUser.update({ where: { id: admin.id }, data: { role: "BROKER_ADMIN", status: "DISABLED", twoFactorEnabled: false } }));
    else log(`ok     admin ${ADMIN_EMAIL} (DISABLED)`);
  }

  // ---- the one group ----
  const groupWant = {
    leverage: GROUP.leverage, marginCallLevel: GROUP.marginCallLevel, stopOutLevel: GROUP.stopOutLevel, isDefault: true, category: "B_BOOK", modeRestriction: "DEMO_ONLY", groupType: "DEMO",
    isClientSelectable: false, forceDealingMode: false, dealingMode: "INHERIT", tier: "STANDARD", swapFree: true, restrictSymbols: false, tradingRestriction: "BOTH", tradingHaltedAt: null, closeOnlyAt: null, maxLotSize: null, minLotSize: null,
  };
  const groupData = { ...groupWant, marginCallLevel: D(GROUP.marginCallLevel), stopOutLevel: D(GROUP.stopOutLevel), category: "B_BOOK" as const, modeRestriction: "DEMO_ONLY" as const, groupType: "DEMO" as const, dealingMode: "INHERIT" as const, tradingRestriction: "BOTH" as const, tier: "STANDARD" as const };
  const groupRows = broker ? await db.group.findMany({ where: { brokerId: broker.id } }) : [];
  const group = groupRows.find((g) => g.name === GROUP_NAME);
  const label = `${GROUP_NAME} [B_BOOK, DEMO_ONLY, default, 1:${GROUP.leverage}, MC ${GROUP.marginCallLevel} / SO ${GROUP.stopOutLevel}]`;
  if (!group) await change(`CREATE group ${label}`, () => db.group.create({ data: { brokerId: bid(), name: GROUP_NAME, ...groupData } }));
  else {
    const d = diff(group as unknown as Record<string, unknown>, groupWant);
    if (d.length) await change(`UPDATE group ${label}: ${d.join("; ")}`, () => db.group.update({ where: { id: group.id }, data: groupData }));
    else log(`ok     group ${label}`);
  }
  for (const other of groupRows.filter((g) => g.name !== GROUP_NAME && g.isDefault)) {
    await change(`UNSET default on group ${other.name} (the demo has one group)`, () => db.group.update({ where: { id: other.id }, data: { isDefault: false } }));
  }

  // ---- symbols (global table) ----
  const symbolId = new Map<string, string>(qRows.map((r) => [r.name, r.id]));
  for (const d of DEMO_SYMBOLS) {
    const full = { name: d.name, baseCurrency: d.baseCurrency, quoteCurrency: d.quoteCurrency, digits: d.digits, contractSize: d.contractSize, category: d.category };
    const fields = Object.entries(full).map(([k, v]) => `${k}=${v}`).join(", ");
    const row = qRows.find((r) => r.name === d.name);
    if (!row) {
      symbolId.set(d.name, NEW);
      await change(`CREATE symbol (global) ${fields}  [displayed as ${d.display}, base level ${d.base}, spread ${d.spreadPts} points]`, async () => {
        const created = await db.symbol.create({ data: { name: d.name, baseCurrency: d.baseCurrency, quoteCurrency: d.quoteCurrency, digits: d.digits, contractSize: D(d.contractSize), category: d.category } });
        symbolId.set(d.name, created.id);
      });
    } else log(`ok     symbol ${fields}`);
  }

  // ---- broker symbols + trading hours ----
  const bsRows = broker ? await db.brokerSymbol.findMany({ where: { brokerId: broker.id }, include: { symbol: { select: { name: true } }, tradingSessions: true } }) : [];
  for (const d of DEMO_SYMBOLS) {
    const want = {
      enabled: true, tradingMode: "BOTH", spreadMarkup: 0, commissionPerLot: 0, swapLong: 0, swapShort: 0, minLot: 0.01, maxLot: 100, lotStep: 0.01,
      maxExposure: null, stopLevel: 0, defaultBookType: "B_BOOK", hedgedMarginPct: 200,
    };
    const data = {
      ...want, spreadMarkup: D(0), commissionPerLot: D(0), swapLong: D(0), swapShort: D(0), minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), hedgedMarginPct: D(200),
      tradingMode: "BOTH" as const, defaultBookType: "B_BOOK" as const,
    };
    const row = bsRows.find((r) => r.symbol.name === d.name);
    let brokerSymbolId = row?.id ?? NEW;
    if (!row) {
      await change(`CREATE broker symbol ${d.name} (B_BOOK, markup 0, commission 0, swaps 0, lots 0.01-100 step 0.01)`, async () => {
        const created = await db.brokerSymbol.create({ data: { brokerId: bid(), symbolId: symbolId.get(d.name)!, ...data } });
        brokerSymbolId = created.id;
      });
    } else {
      const dd = diff(row as unknown as Record<string, unknown>, want);
      if (dd.length) await change(`UPDATE broker symbol ${d.name}: ${dd.join("; ")}`, () => db.brokerSymbol.update({ where: { id: row.id }, data }));
      else log(`ok     broker symbol ${d.name}`);
    }
    const have = new Set((row?.tradingSessions ?? []).map((s) => `${s.dayOfWeek}|${s.openTime}|${s.closeTime}`));
    const wantSessions = DAYS.map((day) => `${day}|00:00|24:00`);
    const missing = wantSessions.filter((x) => !have.has(x));
    const extra = (row?.tradingSessions ?? []).filter((s) => !wantSessions.includes(`${s.dayOfWeek}|${s.openTime}|${s.closeTime}`));
    if (missing.length || extra.length) {
      await change(`SET trading hours ${d.name}: Mon..Sun 00:00-24:00 (${missing.length} to add, ${extra.length} to remove)`, async () => {
        if (extra.length) await db.tradingSession.deleteMany({ where: { id: { in: extra.map((e) => e.id) } } });
        for (const x of missing) {
          const [day, openTime, closeTime] = x.split("|");
          await db.tradingSession.create({ data: { brokerSymbolId, dayOfWeek: Number(day), openTime, closeTime } });
        }
      });
    } else if (row) log(`ok     trading hours ${d.name}`);
  }
  // a q-symbol of the demo broker that is not in the plan is switched off (never deleted)
  for (const row of bsRows.filter((r) => r.enabled && !DEMO_SYMBOLS.some((d) => d.name === r.symbol.name))) {
    await change(`DISABLE broker symbol ${row.symbol.name} (not in the demo's plan)`, () => db.brokerSymbol.update({ where: { id: row.id }, data: { enabled: false } }));
  }

  if (changes > 0 && opts.apply) {
    await db.auditLog.create({ data: { brokerId: bid(), actorAdminId: null, action: "QOREDEMO_SEED", entityType: "Broker", entityId: bid(), newValue: { changes } } });
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
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new SeedRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new SeedRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new SeedRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new SeedRefused(`--apply on ${host} needs --confirm-host=${host}`);

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return seedQoreDemo(tx, { apply });
      },
      { timeout: 180_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /seed-qoredemo\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof SeedRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
