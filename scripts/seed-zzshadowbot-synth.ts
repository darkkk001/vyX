// Synthetic symbols for the ISOLATED shadow-bot tenant "zzshadowbot" (owner-approved 2026-09-28). A sibling of
// scripts/seed-zzshadowbot.ts: run it AFTER that seed (it needs the tenant and its groups).
//
// What it seeds: five synthetic symbols whose prices come ONLY from the engine's /internal/synth-feed (own secret), so
// the shadow bot can drive stop-out / hedge-break / NBP / cascade / fan-in on demand. The engine treats them exactly
// like real symbols (fills, margin, stop-out, SL/TP, auto-hedge, coverage, mirror, NBP, the Rust shadow); only the
// price source differs. vJPY converts to USD at the REAL USDJPY (read-only).
//
// Hard guards (all before any write):
//   - the tenant is resolved ONLY by the hard-coded subdomain (same constant as the main seed); it must already exist;
//   - every name starts with the ONE reserved prefix (lib/synthetic-symbols.ts SYNTH_PREFIX, "v", case-sensitive) and
//     has the exact synthetic form "v" + upper-case letters / digits;
//   - it refuses if ANY other broker lists ANY v* symbol, or if a global Symbol differing only in case exists
//     (e.g. "VGOLD" next to "vGOLD");
//   - it is the ONLY script allowed to create global v* Symbol rows, and it never creates or edits any other Symbol.
// Isolation elsewhere: the engine's real ingest drops v* ticks; the backoffice Symbols API, the candle routes and feed
// health hide / refuse v* for every broker but zzshadowbot (lib/synthetic-symbols.ts).
//
// Usage (DATABASE_URL and DIRECT_URL must be set in the process env -- .env is never read):
//   npx tsx scripts/seed-zzshadowbot-synth.ts                                  dry run (READ ONLY transaction)
//   npx tsx scripts/seed-zzshadowbot-synth.ts --apply --confirm-host=<db host>
// Idempotent: upserted by natural key (Symbol name, [broker, symbol], [group, symbol]); a second run reports 0 changes.
import { Prisma, PrismaClient, type SymbolCategory } from "@prisma/client";
import { SUBDOMAIN, hostOf } from "./seed-zzshadowbot";
import { SYNTH_PREFIX, isSyntheticSymbol } from "../lib/synthetic-symbols";

const D = (v: number | string) => new Prisma.Decimal(v);

// ---- the approved plan, as data ----
// All CRYPTO: the web and the Rust shadow treat CRYPTO as open 24/7 (the weekend soak); the engine's candle writer
// treats the v* prefix as continuously traded (engine/market-data/src/gap_fill.rs).
export type SynthSymbol = { name: string; quoteCurrency: string; contractSize: number; digits: number; hedgedMarginPct: number; category: SymbolCategory };
export const SYNTH_SYMBOLS: SynthSymbol[] = [
  { name: "vGOLD", quoteCurrency: "USD", contractSize: 100, digits: 2, hedgedMarginPct: 0, category: "CRYPTO" },
  { name: "vEUR", quoteCurrency: "USD", contractSize: 100000, digits: 5, hedgedMarginPct: 50, category: "CRYPTO" },
  { name: "vGBP", quoteCurrency: "USD", contractSize: 100000, digits: 5, hedgedMarginPct: 100, category: "CRYPTO" },
  { name: "vJPY", quoteCurrency: "JPY", contractSize: 100000, digits: 3, hedgedMarginPct: 200, category: "CRYPTO" },
  { name: "vIDX", quoteCurrency: "USD", contractSize: 1, digits: 1, hedgedMarginPct: 200, category: "CRYPTO" },
];

// Per-group pricing on the tenant's existing groups (the main seed's shapes, so every risk path is reachable with
// controlled prices: markup / target spread / commission / swap, and SB Hedge NBP's negative-equity edge on vGOLD).
type Gsc = { symbol: string; spreadMarkup?: number; targetTotalSpreadPips?: number; commissionPerLot?: number; swapLong?: number; swapShort?: number };
export const SYNTH_GROUP_CONFIGS: Record<string, Gsc[]> = {
  "SB Standard": [
    { symbol: "vGOLD", spreadMarkup: 2.0, swapLong: -6.5, swapShort: 1.2 },
    { symbol: "vEUR", spreadMarkup: 1.0, swapLong: -0.8, swapShort: 0.2 },
    { symbol: "vGBP", spreadMarkup: 1.2 },
    { symbol: "vJPY", spreadMarkup: 1.0 },
    { symbol: "vIDX", spreadMarkup: 1.5 },
  ],
  "SB Pro": [
    { symbol: "vGOLD", targetTotalSpreadPips: 3.0, commissionPerLot: 7 },
    { symbol: "vEUR", targetTotalSpreadPips: 0.8, commissionPerLot: 7 },
    { symbol: "vGBP", commissionPerLot: 7 },
    { symbol: "vJPY", commissionPerLot: 7 },
    { symbol: "vIDX", commissionPerLot: 7 },
  ],
  "SB Dealing Desk": [
    { symbol: "vGOLD", spreadMarkup: 1.5, commissionPerLot: 3.5 },
    { symbol: "vEUR", spreadMarkup: 0.6, commissionPerLot: 3.5 },
    { symbol: "vGBP", commissionPerLot: 3.5 },
    { symbol: "vJPY", commissionPerLot: 3.5 },
    { symbol: "vIDX", commissionPerLot: 3.5 },
  ],
  "SB Hedge NBP": [{ symbol: "vGOLD", spreadMarkup: 60, commissionPerLot: 50, swapLong: -25, swapShort: -25 }],
};

const SYNTH_NAME = /^v[A-Z0-9]+$/;

// ---- engine ----

export class SynthSeedRefused extends Error {}
type Db = Prisma.TransactionClient;
export type SynthSeedResult = { lines: string[]; changes: number };

function same(a: unknown, b: unknown): boolean {
  if (a == null || b == null) return a == null && b == null;
  if (Prisma.Decimal.isDecimal(a) || Prisma.Decimal.isDecimal(b) || typeof a === "number" || typeof b === "number") {
    return new Prisma.Decimal(a as Prisma.Decimal.Value).equals(new Prisma.Decimal(b as Prisma.Decimal.Value));
  }
  return a === b;
}
const show = (v: unknown) => (v == null ? "null" : String(v));
function diff(have: Record<string, unknown>, want: Record<string, unknown>): string[] {
  return Object.keys(want).filter((k) => !same(have[k], want[k])).map((k) => `${k}: ${show(have[k])} -> ${show(want[k])}`);
}

/**
 * `opts.tenant` exists ONLY so the scratch-DB test can run beside the main seed's test (vitest runs files in parallel
 * and that test rebuilds zzshadowbot); the CLI below never passes it, so no argument can point this script at any
 * tenant but zzshadowbot.
 */
export async function seedSyntheticSymbols(db: Db, opts: { apply: boolean; tenant?: string }): Promise<SynthSeedResult> {
  const tenant = opts.tenant ?? SUBDOMAIN;
  const lines: string[] = [];
  let changes = 0;
  const log = (s: string) => lines.push(s);
  const change = async (label: string, fn: () => Promise<unknown>) => {
    changes++;
    log(label);
    if (opts.apply) await fn();
  };

  // ---- guards (all before any write) ----
  for (const s of SYNTH_SYMBOLS) {
    if (!isSyntheticSymbol(s.name) || !SYNTH_NAME.test(s.name)) throw new SynthSeedRefused(`${s.name} is not a synthetic name ("${SYNTH_PREFIX}" + A-Z / 0-9)`);
  }
  for (const [group, cfgs] of Object.entries(SYNTH_GROUP_CONFIGS)) {
    for (const c of cfgs) if (!SYNTH_SYMBOLS.some((s) => s.name === c.symbol)) throw new SynthSeedRefused(`${group} config names ${c.symbol}, not in the plan`);
  }
  const broker = await db.broker.findUnique({ where: { subdomain: tenant }, select: { id: true, subdomain: true } });
  if (!broker || broker.subdomain !== tenant) throw new SynthSeedRefused(`tenant ${tenant} does not exist: run scripts/seed-zzshadowbot.ts first`);
  // every v* symbol anywhere (Prisma startsWith is case-sensitive on Postgres: exactly the reserved lowercase prefix)
  const vSymbols = await db.symbol.findMany({ where: { name: { startsWith: SYNTH_PREFIX } }, include: { brokerSymbols: { select: { brokerId: true } } } });
  const foreign = vSymbols.flatMap((s) => s.brokerSymbols.filter((b) => b.brokerId !== broker.id).map(() => s.name));
  if (foreign.length) throw new SynthSeedRefused(`another broker lists synthetic symbol(s) ${[...new Set(foreign)].join(", ")} -- refusing`);
  // a real-looking twin that differs only in case ("VGOLD" next to "vGOLD") would make the case rule ambiguous
  const twins = await db.$queryRaw<{ name: string }[]>`SELECT name FROM "Symbol" WHERE lower(name) = ANY(${SYNTH_SYMBOLS.map((s) => s.name.toLowerCase())}) AND NOT (name = ANY(${SYNTH_SYMBOLS.map((s) => s.name)}))`;
  if (twins.length) throw new SynthSeedRefused(`global Symbol(s) ${twins.map((t) => t.name).join(", ")} differ from a synthetic name only in case -- refusing`);
  const groups = await db.group.findMany({ where: { brokerId: broker.id, name: { in: Object.keys(SYNTH_GROUP_CONFIGS) } }, select: { id: true, name: true } });
  const missingGroups = Object.keys(SYNTH_GROUP_CONFIGS).filter((g) => !groups.some((x) => x.name === g));
  if (missingGroups.length) throw new SynthSeedRefused(`group(s) ${missingGroups.join(", ")} missing on ${tenant}: run scripts/seed-zzshadowbot.ts first`);

  log(`tenant ${tenant}: exists (${broker.id})  mode: ${opts.apply ? "APPLY" : "DRY RUN"}  reserved prefix "${SYNTH_PREFIX}" (case-sensitive, leading)`);
  log(`guard  other brokers listing a v* symbol: none;  case-only twins of the synthetic names: none`);

  // ---- global Symbol rows (v* only) ----
  const symbolId = new Map<string, string>(vSymbols.map((s) => [s.name, s.id]));
  const NEW = "(new)";
  for (const s of SYNTH_SYMBOLS) {
    const want = { baseCurrency: s.name, quoteCurrency: s.quoteCurrency, digits: s.digits, contractSize: s.contractSize, category: s.category };
    const data = { ...want, contractSize: D(s.contractSize) };
    const row = vSymbols.find((r) => r.name === s.name);
    const label = `${s.name} [${s.category}, quote ${s.quoteCurrency}, contract ${s.contractSize}, ${s.digits} digits]`;
    if (!row) {
      symbolId.set(s.name, NEW);
      await change(`CREATE global symbol ${label}`, async () => {
        const created = await db.symbol.create({ data: { name: s.name, ...data } });
        symbolId.set(s.name, created.id);
      });
    } else {
      const d = diff(row as unknown as Record<string, unknown>, want);
      if (d.length) await change(`UPDATE global symbol ${s.name}: ${d.join("; ")}`, () => db.symbol.update({ where: { id: row.id }, data }));
      else log(`ok     global symbol ${label}`);
    }
  }
  for (const row of vSymbols.filter((r) => !SYNTH_SYMBOLS.some((s) => s.name === r.name))) log(`NOTE   extra synthetic symbol ${row.name} is not in the plan (left alone; disabled on ${tenant} below)`);

  // ---- the tenant's BrokerSymbol rows ----
  const bsRows = await db.brokerSymbol.findMany({ where: { brokerId: broker.id, symbol: { name: { startsWith: SYNTH_PREFIX } } }, include: { symbol: { select: { name: true } } } });
  for (const s of SYNTH_SYMBOLS) {
    const want = {
      enabled: true, tradingMode: "BOTH", hedgedMarginPct: s.hedgedMarginPct, spreadMarkup: 0, commissionPerLot: 0, swapLong: 0, swapShort: 0,
      minLot: 0.01, maxLot: 100, lotStep: 0.01, maxExposure: null, stopLevel: 0, defaultBookType: "B_BOOK",
    };
    const data = { ...want, hedgedMarginPct: D(s.hedgedMarginPct), spreadMarkup: D(0), commissionPerLot: D(0), swapLong: D(0), swapShort: D(0), minLot: D(0.01), maxLot: D(100), lotStep: D(0.01), tradingMode: "BOTH" as const, defaultBookType: "B_BOOK" as const };
    const row = bsRows.find((r) => r.symbol.name === s.name);
    if (!row) await change(`CREATE ${tenant} symbol ${s.name} (hedged margin ${s.hedgedMarginPct}%)`, () => db.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: symbolId.get(s.name)!, ...data } }));
    else {
      const d = diff(row as unknown as Record<string, unknown>, want);
      if (d.length) await change(`UPDATE ${tenant} symbol ${s.name}: ${d.join("; ")}`, () => db.brokerSymbol.update({ where: { id: row.id }, data }));
      else log(`ok     ${tenant} symbol ${s.name} (hedged margin ${s.hedgedMarginPct}%)`);
    }
  }
  for (const row of bsRows.filter((r) => r.enabled && !SYNTH_SYMBOLS.some((s) => s.name === r.symbol.name))) {
    await change(`DISABLE ${tenant} symbol ${row.symbol.name} (not in the plan)`, () => db.brokerSymbol.update({ where: { id: row.id }, data: { enabled: false } }));
  }

  // ---- per-group pricing ----
  const cfgRows = await db.groupSymbolConfig.findMany({
    where: { group: { brokerId: broker.id }, symbol: { name: { startsWith: SYNTH_PREFIX } } },
    include: { group: { select: { name: true } }, symbol: { select: { name: true } } },
  });
  for (const [groupName, cfgs] of Object.entries(SYNTH_GROUP_CONFIGS)) {
    const gid = groups.find((g) => g.name === groupName)!.id;
    for (const c of cfgs) {
      const want = {
        spreadMarkup: c.spreadMarkup ?? null, targetTotalSpreadPips: c.targetTotalSpreadPips ?? null, commissionPerLot: c.commissionPerLot ?? null,
        swapLong: c.swapLong ?? null, swapShort: c.swapShort ?? null,
      };
      const data = Object.fromEntries(Object.entries(want).map(([k, v]) => [k, v == null ? null : D(v)])) as Record<keyof typeof want, Prisma.Decimal | null>;
      const text = Object.entries(want).filter(([, v]) => v != null).map(([k, v]) => `${k} ${v}`).join(", ");
      const cfg = cfgRows.find((e) => e.group.name === groupName && e.symbol.name === c.symbol);
      if (!cfg) await change(`CREATE config ${groupName} / ${c.symbol}: ${text}`, () => db.groupSymbolConfig.create({ data: { groupId: gid, symbolId: symbolId.get(c.symbol)!, ...data } }));
      else {
        const d = diff(cfg as unknown as Record<string, unknown>, want);
        if (d.length) await change(`UPDATE config ${groupName} / ${c.symbol}: ${d.join("; ")}`, () => db.groupSymbolConfig.update({ where: { id: cfg.id }, data }));
        else log(`ok     config ${groupName} / ${c.symbol}: ${text}`);
      }
    }
  }
  for (const cfg of cfgRows.filter((e) => !(SYNTH_GROUP_CONFIGS[e.group.name] ?? []).some((c) => c.symbol === e.symbol.name))) {
    await change(`DELETE config ${cfg.group.name} / ${cfg.symbol.name} (not in the plan)`, () => db.groupSymbolConfig.delete({ where: { id: cfg.id } }));
  }

  if (changes > 0 && opts.apply) {
    await db.auditLog.create({
      data: { brokerId: broker.id, actorAdminId: null, action: "SHADOWBOT_SYNTH_SEED", entityType: "Broker", entityId: broker.id, newValue: { changes, symbols: SYNTH_SYMBOLS.map((s) => s.name) } },
    });
  }
  log(`${changes} change(s)${opts.apply ? " applied" : " planned (dry run: nothing written)"}`);
  return { lines, changes };
}

// ---- CLI (the same checks as scripts/seed-zzshadowbot.ts) ----

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const confirm = args.find((a) => a.startsWith("--confirm-host="))?.slice("--confirm-host=".length).toLowerCase();
  const unknown = args.filter((a) => a !== "--apply" && !a.startsWith("--confirm-host="));
  if (unknown.length) throw new SynthSeedRefused(`unknown argument(s): ${unknown.join(" ")}`);
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new SynthSeedRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new SynthSeedRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && confirm !== host) throw new SynthSeedRefused(`--apply on ${host} needs --confirm-host=${host}`);

  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return seedSyntheticSymbols(tx, { apply });
      },
      { timeout: 120_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /seed-zzshadowbot-synth\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof SynthSeedRefused ? `REFUSED: ${e.message}` : e);
    process.exitCode = 1;
  });
}
