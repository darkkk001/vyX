// Showcase data for the QoreTrader tenant's backoffice (owner request 2026-11-12): the backoffice brokers open to evaluate the product must
// not look empty. Everything here is SYNTHETIC: invented English names, @example.com addresses, no real client data, no LP / bridge data.
//
// What one --apply creates in the tenant with subdomain "qoretrader" (and nowhere else):
//   - ~100 Clients (source "seed-showcase") with one trading account each (numbers 46100001.., backdated 2023 -> now, varied currencies the
//     tenant already uses, most ACTIVE, a few SUSPENDED / CLOSED, a few flagged), client + account KYC records in mixed states,
//   - deposits / withdrawals 2023 -> now (COMPLETED, plus PENDING ones for the queues, a few REJECTED / CANCELLED), a few PENDING balance
//     adjustment requests for the approvals queue,
//   - closed trades on every enabled symbol of the tenant (Order + Position + IN / OUT Deal + TRADE_PNL ledger row, as lib/position-close.ts
//     books them), wins and losses, a few closed by SL / TP,
//   - a set of OPEN positions across the symbols: small lots, NO SL / TP, balances far above margin, B-book groups only, so nothing can trigger
//     (owner choice: "safe open positions"). The engine still sees them (exposure, swaps).
// Accounts cannot be signed in to (their password hash is not a bcrypt hash).
//
// Tag: a seed record is reachable from a Client of this broker with source "seed-showcase" AND an @example.com e-mail; its account numbers are
// in 46100001..46100999. --wipe deletes exactly those clients, their accounts and every row hanging off those accounts (including rows the engine
// added later, such as swaps), and nothing else.
//
// Safety: DATABASE_URL and DIRECT_URL must be set and name the same database (./.env is never read); DRY RUN by default (prints the counts it
// would create, writes nothing); --apply / --wipe need --confirm-host=<db host>; the broker is found only by the hard-coded subdomain and must not
// be a sandbox; --apply refuses if the seed already exists (wipe first) or if any non-seed account sits in the number range.
//
// Usage:
//   npx tsx scripts/seed-qoretrader-showcase.ts                                  dry run (counts)
//   npx tsx scripts/seed-qoretrader-showcase.ts --apply --confirm-host=<db host>  create
//   npx tsx scripts/seed-qoretrader-showcase.ts --wipe  --confirm-host=<db host>  remove exactly what the seed created
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";

export const SUBDOMAIN = "qoretrader";
export const SEED_SOURCE = "seed-showcase";
export const NUMBER_MIN = 46100001;
export const NUMBER_MAX = 46100999;
export const NOTE = "Showcase demo data";
const NO_LOGIN_HASH = "!seed-showcase-no-login";   // not a bcrypt hash: no password ever matches
const D = (v: number | string) => new Prisma.Decimal(v);
export class SeedRefused extends Error {}
type Db = Prisma.TransactionClient;

// ---- deterministic randomness (the same run every time) ----
function rng(seed: number) { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
type R = () => number;
const pick = <T>(r: R, a: readonly T[]) => a[Math.floor(r() * a.length)];
const between = (r: R, a: number, b: number) => a + (b - a) * r();
const logNormal = (r: R, median: number, spread: number) => median * Math.exp(spread * Math.sqrt(-2 * Math.log(Math.max(r(), 1e-9))) * Math.cos(2 * Math.PI * r()));
const round2 = (x: number) => Math.round(x * 100) / 100;

const FIRST = ["Oliver", "Amelia", "Harry", "Isla", "George", "Ava", "Noah", "Mia", "Jack", "Ivy", "Leo", "Grace", "Arthur", "Freya", "Oscar", "Lily", "Henry", "Florence",
  "Theo", "Poppy", "Archie", "Evie", "Alfie", "Ella", "Charlie", "Rosie", "Thomas", "Sophie", "James", "Alice", "William", "Phoebe", "Edward", "Harriet", "Samuel", "Imogen",
  "Daniel", "Matilda", "Joseph", "Eleanor", "Benjamin", "Clara", "Lucas", "Hannah", "Max", "Lucy", "Isaac", "Martha", "Toby", "Beatrice"] as const;
const LAST = ["Ashford", "Bramley", "Calloway", "Denholm", "Ellery", "Fairbrook", "Garrow", "Hollins", "Ingram", "Jessop", "Kirkland", "Lomax", "Marlow", "Northcott",
  "Oakley", "Pembury", "Quarrie", "Redfern", "Stanway", "Thorne", "Underhill", "Vance", "Whitlock", "Yardley", "Ainsley", "Blackwood", "Crowther", "Dunmore", "Eastwood",
  "Fenwick", "Galloway", "Hartley", "Ibbotson", "Kendrick", "Langley", "Merriman", "Netherby", "Orwell", "Prescott", "Rowntree", "Sherwood", "Tolland", "Wakefield"] as const;
const COUNTRIES = ["GB", "IE", "DE", "NL", "AE", "SG", "ZA", "AU", "CA", "NZ", "SE", "PL", "CY", "MT"] as const;
// a known price for symbols the database holds no live price for (rough recent levels; the history walks around it)
const FALLBACK_PRICE: Record<string, number> = { XAUUSD: 2600, XAGUSD: 30, EURUSD: 1.08, GBPUSD: 1.27, USDJPY: 150, USDCHF: 0.88, AUDUSD: 0.66, USDCAD: 1.36, NZDUSD: 0.6,
  EURGBP: 0.85, EURJPY: 162, GBPJPY: 190, BTCUSD: 70000, ETHUSD: 3500, US30: 42000, NAS100: 20000, SPX500: 5800, UK100: 8200, GER40: 19000, USOIL: 75, UKOIL: 79, XNGUSD: 2.5 };
const DAILY_VOL: Record<string, number> = { CRYPTO: 0.035, INDICES: 0.011, COMMODITIES: 0.014, METALS: 0.012, FOREX: 0.005, STOCKS: 0.018 };

export type SeedOptions = { mode: "dry" | "apply" | "wipe"; clients?: number; now?: Date };
export type SeedCounts = Record<string, number>;
export type SeedResult = { counts: SeedCounts; lines: string[] };

async function brokerOf(db: Db) {
  const b = await db.broker.findUnique({ where: { subdomain: SUBDOMAIN }, select: { id: true, name: true, isDemoSandbox: true, defaultAccountCurrency: true } });
  if (!b) throw new SeedRefused(`no broker with subdomain "${SUBDOMAIN}"`);
  if (b.isDemoSandbox) throw new SeedRefused(`broker "${SUBDOMAIN}" is a sandbox tenant: refused`);
  return b;
}

async function seedAccountIds(db: Db, brokerId: string) {
  const clients = await db.client.findMany({ where: { brokerId, source: SEED_SOURCE, email: { endsWith: "@example.com" } }, select: { id: true } });
  const clientIds = clients.map((c) => c.id);
  const accounts = clientIds.length ? await db.account.findMany({ where: { brokerId, clientId: { in: clientIds } }, select: { id: true, accountNumber: true } }) : [];
  const stray = accounts.filter((a) => { const n = Number(a.accountNumber); return !(n >= NUMBER_MIN && n <= NUMBER_MAX); });
  if (stray.length) throw new SeedRefused(`a seed client owns an account outside the seed range (${stray.map((a) => a.accountNumber).join(", ")}): refused`);
  return { clientIds, accountIds: accounts.map((a) => a.id) };
}

/** Removes exactly the seed: its clients, their accounts and every row on those accounts. */
export async function wipeShowcase(db: Db): Promise<SeedResult> {
  const b = await brokerOf(db);
  const { clientIds, accountIds } = await seedAccountIds(db, b.id);
  const counts: SeedCounts = {};
  const n = (k: string, v: number) => { counts[k] = (counts[k] ?? 0) + v; };
  if (accountIds.length) {
    const ids = Prisma.join(accountIds);
    const posIds = (await db.position.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })).map((p) => p.id);
    // every table with a column pointing at Account.id / Position.id / Client.id, found in the database's own catalogue (so a row the engine
    // or a later feature added on a seed account is removed too, and nothing else)
    const fks = await db.$queryRaw<{ tbl: string; col: string; ref: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col, c.confrelid::regclass::text AS ref
      FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid::regclass::text IN ('"Account"', '"Position"', '"Client"', '"Order"', '"Transaction"')`;
    const del = async (ref: string, idList: string[], skip: string[] = []) => {
      if (!idList.length) return;
      for (const f of fks.filter((x) => x.ref === ref && !skip.includes(x.tbl))) {
        const r = await db.$executeRawUnsafe(`DELETE FROM ${f.tbl} WHERE "${f.col}" = ANY($1::text[])`, idList);
        if (r) n(f.tbl.replace(/"/g, ""), r);
      }
    };
    // columns that carry a seed account / position / client id WITHOUT a foreign key (Deal, HedgeIntent, PostCloseEffect, RejectedOrder, ...):
    // found by name, their seed rows deleted first. AuditLog and Lead keep their history (a log line, a lead's conversion note).
    const loose = await db.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.table_name AS tbl, c.column_name AS col FROM information_schema.columns c
      WHERE c.table_schema = current_schema() AND c.column_name IN ('accountId', 'positionId', 'clientId') AND c.table_name NOT IN ('AuditLog', 'Lead', 'Account', 'Position', 'Client')
        AND NOT EXISTS (SELECT 1 FROM information_schema.key_column_usage k JOIN information_schema.table_constraints t ON t.constraint_name = k.constraint_name
          AND t.constraint_type = 'FOREIGN KEY' AND t.table_schema = k.table_schema WHERE k.table_schema = c.table_schema AND k.table_name = c.table_name AND k.column_name = c.column_name)`;
    for (const l of loose) {
      const list = l.col === "accountId" ? accountIds : l.col === "positionId" ? posIds : clientIds;
      if (!list.length) continue;
      const r = await db.$executeRawUnsafe(`DELETE FROM "${l.tbl}" WHERE "${l.col}" = ANY($1::text[])`, list);
      if (r) n(l.tbl, r);
    }
    // children first: deals / requests on positions, ledger rows, then positions and orders, then account rows
    await del('"Position"', posIds, ['"Order"']);
    const txIds = (await db.transaction.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })).map((t) => t.id);
    await del('"Transaction"', txIds);
    const orderIds = (await db.order.findMany({ where: { accountId: { in: accountIds } }, select: { id: true } })).map((o) => o.id);
    n("Position", await db.$executeRaw`DELETE FROM "Position" WHERE "accountId" IN (${ids})`);
    await del('"Order"', orderIds);
    await del('"Account"', accountIds, ['"Position"']);
    n("Account", await db.$executeRaw`DELETE FROM "Account" WHERE id IN (${ids})`);
  }
  if (clientIds.length) {
    const fks = await db.$queryRaw<{ tbl: string; col: string }[]>`
      SELECT c.conrelid::regclass::text AS tbl, a.attname AS col FROM pg_constraint c JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
      WHERE c.contype = 'f' AND c.confrelid::regclass::text = '"Client"'`;
    for (const f of fks) { const r = await db.$executeRawUnsafe(`DELETE FROM ${f.tbl} WHERE "${f.col}" = ANY($1::text[])`, clientIds); if (r) n(f.tbl.replace(/"/g, ""), r); }
    n("Client", await db.$executeRaw`DELETE FROM "Client" WHERE id IN (${Prisma.join(clientIds)})`);
  }
  // balance adjustment requests the seed raised (they hang off the accounts and went with them above; this catches none otherwise)
  return { counts, lines: Object.entries(counts).map(([k, v]) => `deleted ${k}: ${v}`) };
}

type Sym = { id: string; name: string; digits: number; cs: number; category: string; quote: string; minLot: number; lotStep: number; anchor: number };

export async function seedShowcase(db: Db, opts: SeedOptions): Promise<SeedResult> {
  if (opts.mode === "wipe") return wipeShowcase(db);
  const now = opts.now ?? new Date();
  const r = rng(20261112);
  const b = await brokerOf(db);
  const lines: string[] = [];

  // ---- refuse a second seed, and any foreign account in the range ----
  const existing = await seedAccountIds(db, b.id);
  if (existing.clientIds.length) throw new SeedRefused(`the seed already exists (${existing.clientIds.length} clients): run --wipe first`);
  const inRange = await db.account.findMany({ where: { accountNumber: { gte: String(NUMBER_MIN), lte: String(NUMBER_MAX) } }, select: { accountNumber: true } });
  const foreign = inRange.filter((a) => a.accountNumber.length === 8);
  if (foreign.length) throw new SeedRefused(`accounts already use the seed number range (${foreign.slice(0, 5).map((a) => a.accountNumber).join(", ")}): refused`);

  // ---- the tenant's own set-up: groups (B-book only: nothing may route to a provider), symbols, currencies, an admin ----
  const groups = await db.group.findMany({ where: { brokerId: b.id, category: "B_BOOK" }, select: { id: true, name: true, leverage: true, modeRestriction: true, isDefault: true } });
  const liveGroups = groups.filter((g) => g.modeRestriction !== "DEMO_ONLY");
  const demoGroups = groups.filter((g) => g.modeRestriction !== "LIVE_ONLY");
  if (!liveGroups.length) throw new SeedRefused("the tenant has no B-book group for live accounts: refused (the seed never uses A-book / dealing groups)");
  const bs = await db.brokerSymbol.findMany({ where: { brokerId: b.id, enabled: true }, select: { minLot: true, lotStep: true, symbol: { select: { id: true, name: true, digits: true, contractSize: true, category: true, quoteCurrency: true } } } });
  const prices = await db.livePrice.findMany({ where: { symbol: { in: bs.map((x) => x.symbol.name) } }, select: { symbol: true, bid: true } }).catch(() => []);
  const priceOf = new Map(prices.map((p) => [p.symbol, Number(p.bid)]));
  const syms: Sym[] = []; const skipped: string[] = [];
  for (const x of bs) {
    const anchor = priceOf.get(x.symbol.name) ?? FALLBACK_PRICE[x.symbol.name.replace(/[^A-Z0-9]/gi, "").toUpperCase()];
    if (!anchor || !(anchor > 0)) { skipped.push(x.symbol.name); continue; }
    syms.push({ id: x.symbol.id, name: x.symbol.name, digits: x.symbol.digits, cs: Number(x.symbol.contractSize), category: String(x.symbol.category), quote: x.symbol.quoteCurrency,
      minLot: Math.max(0.01, Number(x.minLot)), lotStep: Math.max(0.01, Number(x.lotStep)), anchor });
  }
  if (!syms.length) throw new SeedRefused("the tenant has no enabled symbol with a known price: refused");
  if (skipped.length) lines.push(`symbols without a price (no trades on them): ${skipped.join(", ")}`);
  const usedCur = await db.account.findMany({ where: { brokerId: b.id }, distinct: ["currency"], select: { currency: true } });
  const currencies = [...new Set([b.defaultAccountCurrency, ...usedCur.map((c) => c.currency)])];
  const admin = await db.adminUser.findFirst({ where: { brokerId: b.id, role: "BROKER_ADMIN", status: "ACTIVE" }, select: { id: true } });

  // quote -> account-currency rate from the anchors (USDJPY etc.), else 1 for the same currency; a pair with no rate is not traded in that account
  const anchorBy = new Map(syms.map((s) => [s.name.replace(/[^A-Z]/gi, "").toUpperCase(), s.anchor]));
  const rate = (quote: string, acc: string): number | null => {
    if (quote === acc) return 1;
    if (anchorBy.get(quote + acc)) return anchorBy.get(quote + acc)!;
    if (anchorBy.get(acc + quote)) return 1 / anchorBy.get(acc + quote)!;
    const viaUsd = (c: string) => (c === "USD" ? 1 : anchorBy.get(c + "USD") ?? (anchorBy.get("USD" + c) ? 1 / anchorBy.get("USD" + c)! : null));
    const q = viaUsd(quote), a = viaUsd(acc);
    return q && a ? q / a : null;
  };

  // ---- a price path per symbol: a daily random walk that ends at today's price ----
  const start = new Date(Date.UTC(2023, 0, 9));
  const days = Math.ceil((now.getTime() - start.getTime()) / 86400000) + 1;
  const path = new Map<string, number[]>();
  for (const s of syms) {
    const vol = DAILY_VOL[s.category] ?? 0.008; const pr = rng(s.name.split("").reduce((h, c) => h * 31 + c.charCodeAt(0), 7));
    const steps = Array.from({ length: days }, () => Math.sqrt(-2 * Math.log(Math.max(pr(), 1e-9))) * Math.cos(2 * Math.PI * pr()) * vol);
    const p = new Array<number>(days); p[days - 1] = s.anchor;
    for (let i = days - 2; i >= 0; i--) p[i] = p[i + 1] / Math.exp(steps[i + 1]);
    path.set(s.id, p);
  }
  const priceAt = (s: Sym, t: Date, jitter: number) => {
    const p = path.get(s.id)!; const x = Math.min(days - 1, Math.max(0, (t.getTime() - start.getTime()) / 86400000));
    const i = Math.floor(x); const base = p[i] + (p[Math.min(days - 1, i + 1)] - p[i]) * (x - i);
    return Number((base * (1 + jitter)).toFixed(s.digits));
  };

  // ---- build everything in memory, then write in batches ----
  const N = opts.clients ?? 100;
  const clientRows: Prisma.ClientCreateManyInput[] = []; const accountRows: Prisma.AccountCreateManyInput[] = [];
  const ckyc: Prisma.ClientKycRecordCreateManyInput[] = []; const akyc: Prisma.KycRecordCreateManyInput[] = [];
  const marks: Prisma.RiskAccountMarkCreateManyInput[] = []; const txs: Prisma.TransactionCreateManyInput[] = [];
  const orders: Prisma.OrderCreateManyInput[] = []; const positions: Prisma.PositionCreateManyInput[] = []; const deals: Prisma.DealCreateManyInput[] = [];
  const bars: Prisma.BalanceAdjustmentRequestCreateManyInput[] = [];
  const counts: SeedCounts = {};
  const inc = (k: string, v = 1) => { counts[k] = (counts[k] ?? 0) + v; };
  const usedEmails = new Set<string>();
  const openSyms = new Set<string>();
  let orderSeq = 0;

  const span = now.getTime() - start.getTime();
  for (let i = 0; i < N; i++) {
    // registrations lean recent (a growing broker): u^0.6 puts more of them in the later months
    // ... and about one in twelve in the last four weeks, so the dashboard's 7-day / 30-day "new clients" figures are not zero
    const created = i % 12 === 5 ? new Date(now.getTime() - between(r, 2, 28) * 86400000) : new Date(start.getTime() + span * Math.pow(r(), 0.6) * 0.97);
    const first = pick(r, FIRST), last = pick(r, LAST);
    let email = `${first}.${last}`.toLowerCase() + "@example.com"; let k = 2;
    while (usedEmails.has(email)) email = `${first}.${last}${k++}`.toLowerCase() + "@example.com";
    usedEmails.add(email);
    const clientId = randomUUID(); const accountId = randomUUID();
    const country = pick(r, COUNTRIES);
    const isDemo = demoGroups.length > 0 && r() < 0.12;
    const group = isDemo ? pick(r, demoGroups) : pick(r, liveGroups);
    const currency = currencies.length > 1 && r() < 0.3 ? pick(r, currencies) : b.defaultAccountCurrency;
    const roll = r();
    const status = roll < 0.06 ? "SUSPENDED" : roll < 0.09 ? "CLOSED" : "ACTIVE";
    const kycRoll = r();
    const kyc = kycRoll < 0.68 ? "APPROVED" : kycRoll < 0.84 ? "PENDING" : kycRoll < 0.93 ? "REJECTED" : null;
    const number = String(NUMBER_MIN + i);
    clientRows.push({ id: clientId, brokerId: b.id, email, passwordHash: NO_LOGIN_HASH, fullName: `${first} ${last}`, country, status: status === "SUSPENDED" ? "SUSPENDED" : "ACTIVE",
      emailVerifiedAt: created, source: SEED_SOURCE, createdAt: created, updatedAt: created, lastLoginAt: new Date(Math.min(now.getTime(), created.getTime() + r() * (now.getTime() - created.getTime()))) });
    inc("Client");
    if (kyc) {
      const reviewed = kyc === "PENDING" ? null : new Date(created.getTime() + between(r, 1, 6) * 86400000);
      const base = { status: kyc, documentType: pick(r, ["passport", "national_id", "driving_licence"]), documentFrontUrl: "https://example.com/seed/document-front.png",
        addressProofUrl: "https://example.com/seed/address-proof.png", rejectionReason: kyc === "REJECTED" ? pick(r, ["Document expired", "Address proof older than 3 months", "Photo unreadable"]) : null,
        reviewedAt: reviewed, createdAt: new Date(created.getTime() + 3600000), updatedAt: reviewed ?? created } as const;
      ckyc.push({ ...base, id: randomUUID(), clientId });
      if (!isDemo) akyc.push({ ...base, id: randomUUID(), accountId });
      inc(`KYC ${kyc}`);
    }

    // ---- money and trades, in time order, so every ledger row's before / after is right ----
    type Ev = { t: Date; kind: "dep" | "wd" | "trade"; open?: Date };
    const evs: Ev[] = [];
    const life = now.getTime() - created.getTime();
    const deps = isDemo ? 1 : 2 + Math.floor(r() * 7);
    for (let d = 0; d < deps; d++) evs.push({ t: new Date(created.getTime() + 3600000 * 2 + (d === 0 ? 0 : r() * life * 0.95)), kind: "dep" });
    const trades = status === "CLOSED" ? Math.floor(r() * 8) : Math.floor(logNormal(r, 22, 0.9));
    for (let tI = 0; tI < Math.min(trades, 160); tI++) {
      // a trade moves the balance when it CLOSES (its ledger row is dated then): it is ordered by its close time
      const o = new Date(created.getTime() + 86400000 + r() * (life - 2 * 86400000));
      evs.push({ t: new Date(Math.min(now.getTime() - 1800000, o.getTime() + logNormal(r, 6 * 3600000, 1.3))), kind: "trade", open: o });
    }
    const wds = isDemo ? 0 : Math.floor(r() * 4);
    for (let w = 0; w < wds; w++) evs.push({ t: new Date(created.getTime() + 7 * 86400000 + r() * life * 0.9), kind: "wd" });
    evs.sort((a, c) => a.t.getTime() - c.t.getTime());
    // strictly increasing times per account, so the ledger reads back in exactly this order
    for (let e = 1; e < evs.length; e++) if (evs[e].t.getTime() <= evs[e - 1].t.getTime()) evs[e].t = new Date(evs[e - 1].t.getTime() + 1000);
    let bal = 0;
    for (const ev of evs) {
      if (ev.t.getTime() >= now.getTime() - 3600000) continue;
      if (ev.kind === "dep") {
        const amt = round2(Math.min(250000, Math.max(100, isDemo ? 10000 : logNormal(r, 2500, 1.0))));
        txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: "DEPOSIT", status: "COMPLETED", amount: D(amt), balanceBefore: D(bal), balanceAfter: D(round2(bal + amt)),
          note: pick(r, ["Bank transfer", "Card", "USDT (TRC20)", "Wire"]), createdAt: ev.t, updatedAt: ev.t });
        bal = round2(bal + amt); inc("Deposit COMPLETED");
      } else if (ev.kind === "wd") {
        if (bal < 300) continue;
        const amt = round2(bal * between(r, 0.08, 0.4));
        txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: "WITHDRAWAL", status: "COMPLETED", amount: D(-amt), balanceBefore: D(bal), balanceAfter: D(round2(bal - amt)),
          note: pick(r, ["Bank transfer", "Card", "USDT (TRC20)"]), createdAt: ev.t, updatedAt: ev.t });
        bal = round2(bal - amt); inc("Withdrawal COMPLETED");
      } else {
        if (bal < 200) continue;
        const s = pick(r, syms); const fx = rate(s.quote, currency); if (!fx) continue;
        const closeT = ev.t; const openT = ev.open! < closeT ? ev.open! : new Date(closeT.getTime() - 60000);
        const buy = r() < 0.55;
        const open = priceAt(s, openT, between(r, -0.0015, 0.0015)); let close = priceAt(s, closeT, between(r, -0.002, 0.002));
        // lots: a loss of a typical move stays within ~4 % of the balance, never under the symbol's minimum
        const move = s.anchor * (DAILY_VOL[s.category] ?? 0.008);
        let vol = Math.max(s.minLot, Math.floor(((bal * 0.04) / Math.max(1e-9, move * s.cs * fx)) / s.lotStep) * s.lotStep);
        vol = Number(Math.min(vol, s.minLot * 200, 50).toFixed(2));
        let reason: "CLIENT" | "SL" | "TP" = "CLIENT"; let sl: number | null = null; let tp: number | null = null;
        const dir = buy ? 1 : -1;
        if (r() < 0.18) {   // a stop or a target set, and that is what closed it
          const hit = (close - open) * dir >= 0 ? "TP" : "SL";
          if (hit === "TP") tp = close; else sl = close; reason = hit;
        }
        let pnl = round2((close - open) * dir * s.cs * vol * fx);
        if (pnl < -bal * 0.5) { close = open; pnl = 0; reason = "CLIENT"; sl = null; tp = null; }   // never a loss that wipes the account
        const posId = randomUUID(); const orderId = randomUUID(); const txId = randomUUID();
        const src = pick(r, ["DESKTOP_NATIVE", "DESKTOP_NATIVE", "WEB", "MOBILE"] as const);
        orders.push({ id: orderId, brokerId: b.id, accountId, symbolId: s.id, side: buy ? "BUY" : "SELL", type: "MARKET", volume: D(vol), requestedPrice: D(open), status: "FILLED", filledPrice: D(open),
          filledAt: openT, idempotencyKey: `seed-showcase-${++orderSeq}`, source: src, requestedAt: openT, executedAt: openT, createdAt: openT, updatedAt: openT, slPrice: sl == null ? null : D(sl), tpPrice: tp == null ? null : D(tp) });
        positions.push({ id: posId, brokerId: b.id, accountId, symbolId: s.id, originOrderId: orderId, side: buy ? "BUY" : "SELL", volume: D(vol), initialVolume: D(vol), closedVolume: D(vol),
          openPrice: D(open), closePrice: D(close), realizedPnl: D(pnl), status: "CLOSED", bookType: "B_BOOK", groupCategoryAtOpen: "B_BOOK", openedAt: openT, closedAt: closeT,
          slPrice: sl == null ? null : D(sl), tpPrice: tp == null ? null : D(tp) });
        txs.push({ id: txId, brokerId: b.id, accountId, type: "TRADE_PNL", status: "COMPLETED", amount: D(pnl), balanceBefore: D(bal), balanceAfter: D(round2(bal + pnl)), referenceType: "Position",
          referenceId: posId, closeVolume: D(vol), closePrice: D(close), closeSwap: D(0), createdAt: closeT, updatedAt: closeT });
        deals.push({ brokerId: b.id, accountId, positionId: posId, orderId, symbolId: s.id, side: buy ? "BUY" : "SELL", entry: "IN", reason: "CLIENT", source: src, volume: D(vol), price: D(open), executedAt: openT, requestedAt: openT, requestedPrice: D(open), executionMode: "AUTO" });
        deals.push({ brokerId: b.id, accountId, positionId: posId, symbolId: s.id, side: buy ? "SELL" : "BUY", entry: "OUT", reason, source: reason === "CLIENT" ? src : null, volume: D(vol), price: D(close), profit: D(pnl), transactionId: txId, executedAt: closeT });
        bal = round2(bal + pnl); inc("Closed trades"); inc(pnl >= 0 ? "Closed wins" : "Closed losses");
      }
    }
    // a closed account was emptied first
    if (status === "CLOSED" && bal > 0) {
      const lastT = evs.filter((e) => e.t.getTime() < now.getTime() - 3600000).reduce((m, e) => Math.max(m, e.t.getTime()), created.getTime());
      const t = new Date(Math.min(now.getTime() - 3600000 + 1, lastT + between(r, 1, 30) * 86400000));   // after its last ledger row
      txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: "WITHDRAWAL", status: "COMPLETED", amount: D(-bal), balanceBefore: D(bal), balanceAfter: D(0), note: "Account closure", createdAt: t, updatedAt: t });
      bal = 0; inc("Withdrawal COMPLETED");
    }

    // ---- the queues: pending deposits / withdrawals (they do not move the balance until approved), a few refused ones ----
    if (!isDemo && status === "ACTIVE") {
      const q = r();
      const recent = () => new Date(now.getTime() - between(r, 0.1, 9) * 86400000);
      if (q < 0.14 && bal > 500) { const amt = round2(bal * between(r, 0.1, 0.5)); txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: "WITHDRAWAL", status: "PENDING", amount: D(-amt), balanceBefore: D(bal), balanceAfter: D(bal), note: pick(r, ["Bank transfer", "USDT (TRC20)"]), ...(() => { const t = recent(); return { createdAt: t, updatedAt: t }; })() }); inc("Withdrawal PENDING"); }
      else if (q < 0.26) { const amt = round2(logNormal(r, 1500, 0.8)); txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: "DEPOSIT", status: "PENDING", amount: D(amt), balanceBefore: D(bal), balanceAfter: D(bal), note: pick(r, ["Bank transfer", "Wire"]), ...(() => { const t = recent(); return { createdAt: t, updatedAt: t }; })() }); inc("Deposit PENDING"); }
      else if (q < 0.31) { const t = new Date(now.getTime() - between(r, 10, 300) * 86400000); txs.push({ id: randomUUID(), brokerId: b.id, accountId, type: r() < 0.5 ? "DEPOSIT" : "WITHDRAWAL", status: r() < 0.6 ? "REJECTED" : "CANCELLED", amount: D(round2(between(r, 200, 3000))), balanceBefore: D(bal), balanceAfter: D(bal), note: "Card", reviewNote: "Details did not match the account holder", createdAt: t, updatedAt: t }); inc("Funds REJECTED/CANCELLED"); }
      if (admin && r() < 0.06) { bars.push({ id: randomUUID(), brokerId: b.id, accountId, amount: D(round2(between(r, 25, 400))), note: `${NOTE}: goodwill adjustment for review`, kind: "ADJUSTMENT", status: "PENDING", requestedByAdminId: admin.id, createdAt: new Date(now.getTime() - between(r, 0.2, 5) * 86400000) }); inc("Balance requests PENDING"); }
    }

    // ---- open positions: small, no SL / TP, far from any margin limit ----
    if (status === "ACTIVE" && bal > 1000 && r() < 0.5) {
      const nOpen = 1 + Math.floor(r() * 3);
      for (let o = 0; o < nOpen; o++) {
        const s = syms.length > openSyms.size ? syms.find((x) => !openSyms.has(x.id)) ?? pick(r, syms) : pick(r, syms);
        const fx = rate(s.quote, currency); if (!fx) continue;
        const buy = r() < 0.55; const t = new Date(now.getTime() - between(r, 0.2, 9) * 86400000);
        const open = Number((s.anchor * (1 + between(r, -0.006, 0.006))).toFixed(s.digits));
        const lev = Math.max(1, group.leverage);
        let vol = s.minLot; while (vol + s.lotStep <= s.minLot * 5 && ((vol + s.lotStep) * s.cs * open * fx) / lev < bal * 0.05) vol = Number((vol + s.lotStep).toFixed(2));
        if ((vol * s.cs * open * fx) / lev > bal * 0.1) continue;   // even the minimum would use too much margin: skip
        const posId = randomUUID(); const orderId = randomUUID(); const src = pick(r, ["DESKTOP_NATIVE", "WEB", "MOBILE"] as const);
        orders.push({ id: orderId, brokerId: b.id, accountId, symbolId: s.id, side: buy ? "BUY" : "SELL", type: "MARKET", volume: D(vol), requestedPrice: D(open), status: "FILLED", filledPrice: D(open), filledAt: t,
          idempotencyKey: `seed-showcase-${++orderSeq}`, source: src, requestedAt: t, executedAt: t, createdAt: t, updatedAt: t });
        positions.push({ id: posId, brokerId: b.id, accountId, symbolId: s.id, originOrderId: orderId, side: buy ? "BUY" : "SELL", volume: D(vol), initialVolume: D(vol), openPrice: D(open), status: "OPEN",
          bookType: "B_BOOK", groupCategoryAtOpen: "B_BOOK", openedAt: t, lastSwapAt: now });
        deals.push({ brokerId: b.id, accountId, positionId: posId, orderId, symbolId: s.id, side: buy ? "BUY" : "SELL", entry: "IN", reason: "CLIENT", source: src, volume: D(vol), price: D(open), executedAt: t, requestedAt: t, requestedPrice: D(open), executionMode: "AUTO" });
        openSyms.add(s.id); inc("Open positions");
      }
    }

    if (r() < 0.06 && status !== "CLOSED") { marks.push({ id: randomUUID(), brokerId: b.id, accountId, flagged: true, note: `${NOTE}: unusual deposit pattern`, updatedByAdminId: admin?.id ?? null }); inc("Flagged accounts"); }
    accountRows.push({ id: accountId, brokerId: b.id, clientId, accountNumber: number, email, passwordHash: NO_LOGIN_HASH, mustChangePassword: true, fullName: `${first} ${last}`, accountMode: isDemo ? "DEMO" : "LIVE",
      currency, leverage: group.leverage, balance: D(bal), status, groupId: group.id, country, createdAt: created, updatedAt: now });
    inc(isDemo ? "Accounts DEMO" : "Accounts LIVE"); inc(`Accounts ${status}`);
  }
  // sign-ups that never opened a trading account (the Registrations tab lists exactly these), some not yet e-mail verified
  for (let j = 0; j < Math.max(4, Math.round(N * 0.12)); j++) {
    const first = pick(r, FIRST), last = pick(r, LAST);
    let email = `${first}.${last}`.toLowerCase() + "@example.com"; let k = 2;
    while (usedEmails.has(email)) email = `${first}.${last}${k++}`.toLowerCase() + "@example.com";
    usedEmails.add(email);
    const t = new Date(now.getTime() - between(r, 0.3, 60) * 86400000);
    clientRows.push({ id: randomUUID(), brokerId: b.id, email, passwordHash: NO_LOGIN_HASH, fullName: `${first} ${last}`, country: pick(r, COUNTRIES), status: "ACTIVE",
      emailVerifiedAt: r() < 0.55 ? new Date(t.getTime() + 900000) : null, source: SEED_SOURCE, createdAt: t, updatedAt: t });
    inc("Client"); inc("Registrations (no account yet)");
  }
  counts["Symbols traded"] = new Set(positions.map((p) => p.symbolId)).size; counts["Symbols with open positions"] = openSyms.size; counts["Tenant symbols"] = bs.length;
  counts["Deals"] = deals.length; counts["Ledger rows"] = txs.length;
  lines.push(...Object.entries(counts).map(([k, v]) => `${opts.mode === "apply" ? "created" : "would create"} ${k}: ${v}`));
  lines.push(`currencies: ${currencies.join(", ")} | groups: ${[...new Set(accountRows.map((a) => groups.find((g) => g.id === a.groupId)?.name))].join(", ")}${admin ? "" : " | no active BROKER_ADMIN: no balance requests"}`);
  if (opts.mode !== "apply") return { counts, lines };

  const chunk = async <T>(rows: T[], f: (x: T[]) => Promise<unknown>) => { for (let i = 0; i < rows.length; i += 1000) await f(rows.slice(i, i + 1000)); };
  await chunk(clientRows, (x) => db.client.createMany({ data: x }));
  await chunk(accountRows, (x) => db.account.createMany({ data: x }));
  await chunk(ckyc, (x) => db.clientKycRecord.createMany({ data: x }));
  await chunk(akyc, (x) => db.kycRecord.createMany({ data: x }));
  await chunk(marks, (x) => db.riskAccountMark.createMany({ data: x }));
  await chunk(orders, (x) => db.order.createMany({ data: x }));
  await chunk(positions, (x) => db.position.createMany({ data: x }));
  await chunk(txs, (x) => db.transaction.createMany({ data: x }));
  await chunk(deals, (x) => db.deal.createMany({ data: x }));
  await chunk(bars, (x) => db.balanceAdjustmentRequest.createMany({ data: x }));
  return { counts, lines };
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply"), wipe = args.includes("--wipe");
  if (apply && wipe) throw new SeedRefused("--apply and --wipe together: pick one");
  const url = process.env.DATABASE_URL, direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new SeedRefused("DATABASE_URL and DIRECT_URL must both be set in the environment (./.env is not read)");
  const host = (u: string) => { try { const x = new URL(u); return `${x.hostname}${x.pathname}`; } catch { return ""; } };
  if (host(url) !== host(direct)) throw new SeedRefused("DATABASE_URL and DIRECT_URL name different databases");
  const mode = apply ? "apply" : wipe ? "wipe" : "dry";
  if (mode !== "dry") {
    const c = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length) ?? "";
    if (!c || c !== new URL(url).hostname) throw new SeedRefused(`--${mode} needs --confirm-host=<the database host>`);
  }
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  try {
    if (mode === "dry") {
      // a READ ONLY transaction: the dry run cannot write
      const res = await prisma.$transaction(async (tx) => { await tx.$executeRaw`SET TRANSACTION READ ONLY`; return seedShowcase(tx, { mode: "dry" }); }, { timeout: 120000 });
      console.log(res.lines.join("\n")); console.log("DRY RUN: nothing written. Add --apply --confirm-host=<db host> to create, --wipe to remove.");
    } else {
      const res = await prisma.$transaction((tx) => seedShowcase(tx, { mode }), { timeout: 900000, maxWait: 60000 });
      console.log(res.lines.join("\n")); console.log(mode === "apply" ? "APPLIED" : "WIPED");
    }
  } finally { await prisma.$disconnect(); }
}
if (process.argv[1] && /seed-qoretrader-showcase\.ts$/.test(process.argv[1])) main().catch((e) => { console.error(e instanceof SeedRefused ? `REFUSED: ${e.message}` : e); process.exit(1); });
