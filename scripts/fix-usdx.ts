// Corrective script for USDX (hotfix 2026-10-08, owner item 9): compares the live USDX rows with what a complete symbol needs
// (lib/symbol-completeness.ts) and with a template symbol of the same class, and plans the inserts / updates that close the gap.
//
//   dry run (default, READ ONLY transaction, prints the plan, writes nothing):
//     npx tsx scripts/fix-usdx.ts --broker=futurixglobal --name=USDX
//   write (one transaction, audited as SYMBOL_COMPLETED):
//     npx tsx scripts/fix-usdx.ts --broker=futurixglobal --name=USDX --apply --confirm-host=<db host>
//
// DATABASE_URL and DIRECT_URL must be in the process env; ./.env is never read, and no URL is ever printed (only the host).
// It only ever fills a field that the completeness check reports missing, from the template symbol's value; it never overwrites a
// value that is set, and it never edits the global Symbol row (other brokers may use it).
import { Prisma, PrismaClient } from "@prisma/client";
import { missingForSymbol } from "../lib/symbol-completeness";

class Refused extends Error {}

export function hostOf(url: string | undefined): string {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
}

export async function planFix(db: Prisma.TransactionClient, o: { broker: string; name: string; apply: boolean }) {
  const lines: string[] = [];
  const log = (s: string) => lines.push(s);
  const broker = await db.broker.findUnique({ where: { subdomain: o.broker }, select: { id: true, name: true, subdomain: true } });
  if (!broker) throw new Refused(`broker ${o.broker} does not exist`);
  const sym = await db.symbol.findUnique({ where: { name: o.name } });
  if (!sym) throw new Refused(`global symbol ${o.name} does not exist: use scripts/add-feed-symbol.ts`);
  const bs = await db.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId: broker.id, symbolId: sym.id } } });
  log(`broker  ${broker.name} (${broker.subdomain})   mode: ${o.apply ? "APPLY" : "DRY RUN (read only, nothing written)"}`);
  log(`symbol  ${sym.name} [${sym.category}, ${sym.baseCurrency}/${sym.quoteCurrency}, ${sym.digits} digits, contract size ${sym.contractSize.toString()}]`);
  if (!bs) {
    log(`row     ${broker.subdomain} has NO broker row for ${o.name}: nothing to complete here, create it with scripts/add-feed-symbol.ts`);
    return { lines, changes: 0 };
  }
  log(`row     enabled ${bs.enabled}, lots ${bs.minLot} to ${bs.maxLot} step ${bs.lotStep}, sides ${bs.tradingMode}, hedged margin ${bs.hedgedMarginPct}%, book ${bs.defaultBookType}`);

  const missing = missingForSymbol({ symbol: sym, brokerSymbol: bs });
  if (!missing.length) {
    const [sessions, groupRows, peerRows] = await Promise.all([
      db.tradingSession.count({ where: { brokerSymbolId: bs.id } }),
      db.groupSymbolConfig.count({ where: { symbolId: sym.id, group: { brokerId: broker.id } } }),
      db.groupSymbolConfig.count({ where: { symbol: { category: sym.category, id: { not: sym.id } }, group: { brokerId: broker.id } } }),
    ]);
    log(`check   COMPLETE: nothing is missing`);
    log(`info    trading-hours rows ${sessions} (none = the default week), group pricing rows ${groupRows} (the other ${sym.category} symbols of this broker have ${peerRows} in total): optional, not required`);
    log(`0 change(s) planned: USDX needs no data fix`);
    return { lines, changes: 0 };
  }
  log(`check   INCOMPLETE: ${missing.join("; ")}`);

  // fill ONLY what is missing, from a template symbol of the same class
  const peers = await db.brokerSymbol.findMany({
    where: { brokerId: broker.id, enabled: true, symbolId: { not: sym.id }, symbol: { category: sym.category } },
    include: { symbol: { select: { name: true } } },
    orderBy: { symbol: { name: "asc" } },
  });
  const t = peers[0];
  if (!t) throw new Refused(`no enabled ${sym.category} symbol to take a template from`);
  const data: Prisma.BrokerSymbolUpdateInput = {};
  const set = (cond: boolean, label: string, key: keyof Prisma.BrokerSymbolUpdateInput, value: unknown) => {
    if (cond) { (data as Record<string, unknown>)[key] = value; log(`PLAN    set ${label} = ${String(value)} (from ${t.symbol.name})`); }
  };
  set(missing.includes("Minimum lot is not set"), "minimum lot", "minLot", t.minLot);
  set(missing.includes("Lot step is not set"), "lot step", "lotStep", t.lotStep);
  set(missing.includes("Maximum lot is not set") || missing.includes("Maximum lot is below the minimum lot"), "maximum lot", "maxLot", t.maxLot);
  set(missing.includes("Hedged margin is not set"), "hedged margin", "hedgedMarginPct", t.hedgedMarginPct);
  set(missing.includes("Allowed sides are not set"), "allowed sides", "tradingMode", t.tradingMode);
  set(missing.includes("Book is not set"), "book", "defaultBookType", t.defaultBookType);
  const fixable = Object.keys(data).length;
  const global = missing.filter((m) => /digits|Contract size|currency|Asset class/.test(m));
  if (global.length) log(`NOTE    ${global.join("; ")}: these are on the shared global Symbol row, which this script never edits; fix them from the MT5 symbol specification`);
  if (fixable && o.apply) {
    await db.brokerSymbol.update({ where: { id: bs.id }, data });
    await db.auditLog.create({ data: { brokerId: broker.id, actorAdminId: null, action: "SYMBOL_COMPLETED", entityType: "BrokerSymbol", entityId: bs.id, newValue: { name: o.name, filled: Object.keys(data), template: t.symbol.name, script: "scripts/fix-usdx.ts" } as Prisma.InputJsonValue } });
    log(`WRITE   BrokerSymbol updated, AuditLog SYMBOL_COMPLETED`);
  }
  log(`${fixable} change(s) ${o.apply ? "applied" : "planned (dry run: nothing written)"}`);
  return { lines, changes: fixable };
}

function args(argv: string[]) {
  const get = (k: string) => argv.find((a) => a.startsWith(`--${k}=`))?.slice(k.length + 3);
  const unknown = argv.filter((a) => a !== "--apply" && !["broker", "name", "confirm-host"].some((k) => a.startsWith(`--${k}=`)));
  if (unknown.length) throw new Refused(`unknown argument(s): ${unknown.join(" ")}`);
  const broker = get("broker"), name = get("name");
  if (!broker || !name) throw new Refused("--broker= and --name= are required");
  return { broker: broker.toLowerCase(), name, apply: argv.includes("--apply"), confirm: get("confirm-host")?.toLowerCase() };
}

async function main() {
  const a = args(process.argv.slice(2));
  const url = process.env.DATABASE_URL, direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new Refused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new Refused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (a.apply && !local && a.confirm !== host) throw new Refused(`--apply on ${host} needs --confirm-host=${host}`);
  console.log(`database: ${host}${local ? " (local)" : ""}`);
  const prisma = new PrismaClient();
  try {
    const r = await prisma.$transaction(async (tx) => {
      if (!a.apply) await tx.$executeRawUnsafe("SET TRANSACTION READ ONLY");
      return planFix(tx, a);
    }, { timeout: 60_000, maxWait: 20_000 });
    for (const l of r.lines) console.log(l);
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1] && /fix-usdx\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Refused ? `REFUSED: ${e.message} (nothing written)` : e);
    process.exit(1);
  });
}
