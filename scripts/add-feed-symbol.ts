// Add ONE symbol that is already on the price feed to the platform for ONE broker (owner 2026-10-05: USDX for Futurix).
// Stop-gap until the backoffice "Add / remove symbol" flow exists (docs/RUST-CUTOVER-PLAN.md, post-cutover features):
// no API route can create a global Symbol row, so this script does it.
//
// What it writes (one transaction, nothing else):
//   1. the global Symbol row, if it does not exist (name, category, base/quote currency, digits, contract size);
//   2. the broker's BrokerSymbol row, enabled, markup 0, commission 0, swaps 0, lots 0.01 / 100 / 0.01, both sides,
//      stop level 0, and the hedged margin % and default book type most of the broker's enabled symbols already use;
//   3. one AuditLog row (FEED_SYMBOL_ADDED) on apply.
// It creates NO trading sessions (the default FX week applies: Fri 17:00 to Sun 17:00 New York, no daily break for
// non-metals), NO group pricing overrides and NO group allow-list rows. Groups that restrict symbols are listed so the
// owner can add the symbol there from GRP "Allowed symbols…" if wanted.
//
// Hard guards (all before any write):
//   - the broker is resolved by its exact subdomain and must exist;
//   - the name must be upper case A-Z / 0-9 / "." (the feed name, exactly as the EA sends it; prices match it
//     case-sensitively), never the reserved synthetic "v" prefix;
//   - refuses if a global Symbol differing only in case exists, or if the Symbol exists with a DIFFERENT spec (it never
//     edits an existing global Symbol: other brokers may use it);
//   - refuses an existing BrokerSymbol row for this broker (manage that one in SYM instead);
//   - quote currency must be USD (the same rule as enabling a symbol in SYM);
//   - --contract-size and --digits are required: take them from the MT5 symbol specification, never a guess.
//
// Usage (DATABASE_URL and DIRECT_URL must be set in the process env; .env is never read):
//   npx tsx scripts/add-feed-symbol.ts --broker=futurixglobal --name=USDX --category=INDICES --base=USD --quote=USD \
//     --digits=3 --contract-size=<MT5 spec>                                        dry run (READ ONLY transaction)
//   ... the same ... --apply --confirm-host=<db host>                              write
// After applying: press Save once on the symbol's row in SYM (or toggle any field and back) so open terminals and the
// engine get the ConfigChanged event at once; otherwise they pick it up at their next refresh / sign-in.
import { Prisma, PrismaClient, type SymbolCategory } from "@prisma/client";

const CATEGORIES = ["FOREX", "METALS", "INDICES", "CRYPTO", "COMMODITIES", "STOCKS"] as const;
const NAME = /^[A-Z0-9][A-Z0-9.]{1,19}$/;

class AddSymbolRefused extends Error {}

type Opts = { broker: string; name: string; category: SymbolCategory; base: string; quote: string; digits: number; contractSize: number; apply: boolean };

export function hostOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function mode<T>(values: T[]): T | undefined {
  const counts = new Map<string, { v: T; n: number }>();
  for (const v of values) {
    const k = String(v);
    counts.set(k, { v, n: (counts.get(k)?.n ?? 0) + 1 });
  }
  return [...counts.values()].sort((a, b) => b.n - a.n)[0]?.v;
}

export async function addFeedSymbol(db: Prisma.TransactionClient, o: Opts) {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  let changes = 0;
  const change = async (label: string, fn: () => Promise<unknown>) => {
    changes++;
    log(`${o.apply ? "WRITE " : "PLAN  "} ${label}`);
    if (o.apply) await fn();
  };

  // ---- guards ----
  if (!NAME.test(o.name) || o.name.startsWith("v")) throw new AddSymbolRefused(`"${o.name}" is not an upper-case feed name (A-Z, 0-9, ".")`);
  if (o.quote !== "USD") throw new AddSymbolRefused(`quote currency ${o.quote}: only USD-quoted symbols can be enabled (same rule as SYM)`);
  if (!Number.isInteger(o.digits) || o.digits < 0 || o.digits > 8) throw new AddSymbolRefused(`--digits=${o.digits} is not 0..8`);
  if (!(o.contractSize > 0)) throw new AddSymbolRefused(`--contract-size=${o.contractSize} must be > 0`);

  const broker = await db.broker.findUnique({ where: { subdomain: o.broker }, select: { id: true, name: true, subdomain: true } });
  if (!broker || broker.subdomain !== o.broker) throw new AddSymbolRefused(`broker ${o.broker} does not exist`);
  log(`broker  ${broker.name} (${broker.subdomain}, ${broker.id})   mode: ${o.apply ? "APPLY" : "DRY RUN (read only, nothing written)"}`);

  const twins = await db.$queryRaw<{ name: string }[]>`SELECT name FROM "Symbol" WHERE lower(name) = ${o.name.toLowerCase()} AND name <> ${o.name}`;
  if (twins.length) throw new AddSymbolRefused(`global Symbol ${twins.map((t) => t.name).join(", ")} differs from ${o.name} only in case`);

  const want = { baseCurrency: o.base, quoteCurrency: o.quote, digits: o.digits, contractSize: o.contractSize, category: o.category };
  const spec = `${o.name} [${o.category}, ${o.base}/${o.quote}, ${o.digits} digits (point ${(10 ** -o.digits).toFixed(o.digits)}), contract size ${o.contractSize}]`;
  const existing = await db.symbol.findUnique({ where: { name: o.name } });
  let symbolId = existing?.id ?? "(new)";
  if (existing) {
    const diffs = Object.entries(want).filter(([k, v]) => String((existing as Record<string, unknown>)[k]) !== String(v)).map(([k, v]) => `${k} ${String((existing as Record<string, unknown>)[k])} -> ${v}`);
    if (diffs.length) throw new AddSymbolRefused(`global Symbol ${o.name} already exists with a different spec (${diffs.join("; ")}): not editing a shared row`);
    log(`ok      global symbol ${spec} already exists (${existing.id})`);
  } else {
    await change(`CREATE global symbol ${spec}`, async () => {
      const row = await db.symbol.create({ data: { name: o.name, ...want, contractSize: new Prisma.Decimal(o.contractSize) } });
      symbolId = row.id;
    });
  }

  if (existing) {
    const bs = await db.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId: broker.id, symbolId: existing.id } }, select: { id: true, enabled: true } });
    if (bs) throw new AddSymbolRefused(`${broker.subdomain} already has ${o.name} (enabled=${bs.enabled}): manage it in SYM`);
  }

  // defaults the broker already uses on its enabled symbols
  const peers = await db.brokerSymbol.findMany({ where: { brokerId: broker.id, enabled: true }, select: { hedgedMarginPct: true, defaultBookType: true, symbol: { select: { category: true } } } });
  const sameClass = peers.filter((p) => p.symbol.category === o.category);
  const basis = sameClass.length ? sameClass : peers;
  const hedged = mode(basis.map((p) => p.hedgedMarginPct.toString())) ?? "200";
  const book = mode(basis.map((p) => p.defaultBookType)) ?? "B_BOOK";
  log(`basis   ${peers.length} enabled ${broker.subdomain} symbols (${sameClass.length} ${o.category}): hedged margin ${hedged}% and default book ${book} taken from ${sameClass.length ? o.category : "all enabled"} symbols`);

  const bsData = {
    enabled: true, tradingMode: "BOTH" as const, spreadMarkup: new Prisma.Decimal(0), commissionPerLot: new Prisma.Decimal(0),
    swapLong: new Prisma.Decimal(0), swapShort: new Prisma.Decimal(0), minLot: new Prisma.Decimal("0.01"), maxLot: new Prisma.Decimal(100),
    lotStep: new Prisma.Decimal("0.01"), maxExposure: null, stopLevel: 0, hedgedMarginPct: new Prisma.Decimal(hedged), defaultBookType: book,
  };
  await change(
    `CREATE ${broker.subdomain} symbol ${o.name}: enabled, both sides, markup 0, commission 0, swap 0 / 0, lots 0.01 to 100 step 0.01, stop level 0, hedged margin ${hedged}%, book ${book}`,
    () => db.brokerSymbol.create({ data: { brokerId: broker.id, symbolId, ...bsData } })
  );

  log(`hours   no sessions created: default FX week (closed Fri 17:00 to Sun 17:00 New York), no daily break; edit in SYM "Trading hours…" if USDX has one`);
  const restricted = await db.group.findMany({ where: { brokerId: broker.id, restrictSymbols: true }, select: { name: true } });
  log(restricted.length
    ? `groups  ${restricted.length} group(s) restrict symbols and will NOT see ${o.name} until added in GRP "Allowed symbols…": ${restricted.map((g) => g.name).join(", ")}`
    : `groups  no group restricts symbols: every ${broker.subdomain} group sees ${o.name} once enabled`);

  if (changes > 0 && o.apply) {
    await db.auditLog.create({
      data: { brokerId: broker.id, actorAdminId: null, action: "FEED_SYMBOL_ADDED", entityType: "Symbol", entityId: symbolId, newValue: { name: o.name, ...want, hedgedMarginPct: hedged, defaultBookType: book, script: "scripts/add-feed-symbol.ts" } },
    });
    log(`WRITE  AuditLog FEED_SYMBOL_ADDED`);
  }
  log(`${changes} change(s) ${o.apply ? "applied" : "planned (dry run: nothing written)"}`);
  return { lines, changes };
}

function parseArgs(argv: string[]) {
  const known = ["broker", "name", "category", "base", "quote", "digits", "contract-size", "confirm-host"];
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const unknown = argv.filter((a) => a !== "--apply" && !known.some((k) => a.startsWith(`--${k}=`)));
  if (unknown.length) throw new AddSymbolRefused(`unknown argument(s): ${unknown.join(" ")}`);
  for (const k of ["broker", "name", "category", "base", "quote", "digits", "contract-size"]) if (!get(k)) throw new AddSymbolRefused(`--${k}= is required`);
  const category = get("category")!.toUpperCase();
  if (!(CATEGORIES as readonly string[]).includes(category)) throw new AddSymbolRefused(`--category must be one of ${CATEGORIES.join(", ")}`);
  return {
    broker: get("broker")!.toLowerCase(), name: get("name")!, category: category as SymbolCategory, base: get("base")!.toUpperCase(), quote: get("quote")!.toUpperCase(),
    digits: Number(get("digits")), contractSize: Number(get("contract-size")), apply: argv.includes("--apply"), confirm: get("confirm-host")?.toLowerCase(),
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new AddSymbolRefused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new AddSymbolRefused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (a.apply && !local && a.confirm !== host) throw new AddSymbolRefused(`--apply on ${host} needs --confirm-host=${host}`);
  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        if (!a.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
        return addFeedSymbol(tx, a);
      },
      { timeout: 60_000, maxWait: 20_000 }
    );
    for (const l of result.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /add-feed-symbol\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof AddSymbolRefused ? `REFUSED: ${e.message} (nothing written)` : e);
    process.exit(1);
  });
}
