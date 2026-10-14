// Adds ONE platform symbol to one broker's symbol list (an enabled BrokerSymbol row), from the owner's shell.
//
//   npx tsx scripts/add-broker-symbol.ts <subdomain> <symbol>                                          dry run
//   npx tsx scripts/add-broker-symbol.ts <subdomain> <symbol> --apply --confirm-host ep-morning-glade   write
//
// - Same row the starter state creates (lib/starter-state.ts): { brokerId, symbolId, enabled: true }, every other column
//   at its schema default (no markup, lots 0.01-100, no swap/commission). The broker tunes it afterwards in Symbols.
// - Plus one AuditLog row, SYMBOL_CONFIG_UPDATED on that BrokerSymbol, like the Symbols screen writes (actor: none, the
//   owner's script).
// - Refused: a symbol not quoted in USD (PATCH /api/manage/symbols refuses to enable those: P/L in another currency is
//   not supported yet, docs/BACKEND-NEEDED.md), a symbol this broker may not see (synthetic / demo names), or a broker that
//   already has a row for it (enabled or not: this script never changes an existing row).
// - DRY RUN by default: shows the rows it would write, writes nothing. --apply needs --confirm-host <prefix of the database
//   host> (e.g. ep-morning-glade). DATABASE_URL and DIRECT_URL must be in the environment and name the same database;
//   ./.env is never read.
import { PrismaClient } from "@prisma/client";
import { symbolVisibility } from "../lib/synthetic-symbols";

class Refused extends Error {}

const hostOf = (url: string | undefined) => {
  try { return url ? new URL(url).hostname.toLowerCase() : ""; } catch { return ""; }
};

function parseArgs(argv: string[]) {
  const positional: string[] = [];
  let apply = false;
  let confirm: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") apply = true;
    else if (a === "--confirm-host") confirm = argv[++i];
    else if (a.startsWith("--confirm-host=")) confirm = a.slice("--confirm-host=".length);
    else if (a.startsWith("--")) throw new Refused(`unknown option: ${a}`);
    else positional.push(a);
  }
  if (positional.length !== 2) throw new Refused("usage: add-broker-symbol.ts <subdomain> <symbol> [--apply --confirm-host <db host prefix>]");
  return { subdomain: positional[0].trim().toLowerCase(), symbol: positional[1].trim(), apply, confirm: confirm?.trim().toLowerCase() };
}

async function main() {
  const { subdomain, symbol, apply, confirm } = parseArgs(process.argv.slice(2));

  const url = process.env.DATABASE_URL;
  const direct = process.env.DIRECT_URL;
  if (!url || !direct) throw new Refused("set DATABASE_URL and DIRECT_URL in the environment (./.env is never used)");
  const host = hostOf(url);
  const endpoint = (h: string) => h.replace("-pooler", "");
  if (endpoint(host) !== endpoint(hostOf(direct))) throw new Refused(`DATABASE_URL (${host}) and DIRECT_URL (${hostOf(direct)}) point at different databases`);
  const local = host === "localhost" || host === "127.0.0.1";
  if (apply && !local && (!confirm || !(endpoint(host) === confirm || endpoint(host).startsWith(`${confirm}-`) || endpoint(host).startsWith(`${confirm}.`)))) {
    throw new Refused(`--apply on ${host} needs --confirm-host with that host (or its first part, e.g. ${endpoint(host).split("-").slice(0, 3).join("-")})`);
  }

  console.log(`database: ${host}${local ? " (local)" : ""}  mode: ${apply ? "APPLY" : "DRY RUN"}`);
  const prisma = new PrismaClient();
  try {
    const broker = await prisma.broker.findUnique({ where: { subdomain }, select: { id: true, name: true, subdomain: true } });
    if (!broker) throw new Refused(`no broker with subdomain ${subdomain}`);
    const sym = await prisma.symbol.findFirst({ where: { name: { equals: symbol, mode: "insensitive" } }, select: { id: true, name: true, quoteCurrency: true, category: true, digits: true } });
    if (!sym) throw new Refused(`no platform symbol named ${symbol}`);
    if (!(await symbolVisibility(prisma, broker.id))(sym.name)) throw new Refused(`${sym.name} is not available to ${subdomain}`);
    if (sym.quoteCurrency !== "USD") throw new Refused(`${sym.name} is quoted in ${sym.quoteCurrency}: P/L in another currency than USD is not supported yet`);
    const existing = await prisma.brokerSymbol.findUnique({ where: { brokerId_symbolId: { brokerId: broker.id, symbolId: sym.id } }, select: { id: true, enabled: true } });
    if (existing) throw new Refused(`${subdomain} already has ${sym.name} (row ${existing.id}, ${existing.enabled ? "enabled" : "disabled"}); this script never changes an existing row`);

    const before = await prisma.brokerSymbol.count({ where: { brokerId: broker.id, enabled: true } });
    console.log(`broker: ${broker.subdomain} (${broker.name})  enabled symbols now: ${before}`);
    console.log(`symbol: ${sym.name}  ${sym.category}  quote ${sym.quoteCurrency}  digits ${sym.digits}`);
    console.log(`write 1: BrokerSymbol INSERT { brokerId: ${broker.id}, symbolId: ${sym.id}, enabled: true }, every other column at its schema default`);
    console.log(`write 2: AuditLog INSERT { brokerId: ${broker.id}, action: SYMBOL_CONFIG_UPDATED, entityType: BrokerSymbol, oldValue: null, newValue: { enabled: true, source: "scripts/add-broker-symbol.ts" } }`);
    console.log(`after: ${before + 1} enabled symbols; groups without a symbol restriction trade it at once`);

    if (!apply) {
      console.log("dry run: nothing written");
      return;
    }

    const row = await prisma.$transaction(async (tx) => {
      const created = await tx.brokerSymbol.create({ data: { brokerId: broker.id, symbolId: sym.id, enabled: true } });
      await tx.auditLog.create({
        data: {
          brokerId: broker.id,
          action: "SYMBOL_CONFIG_UPDATED",
          entityType: "BrokerSymbol",
          entityId: created.id,
          newValue: { enabled: true, source: "scripts/add-broker-symbol.ts" },
        },
      });
      return created;
    });
    const after = await prisma.brokerSymbol.count({ where: { brokerId: broker.id, enabled: true } });
    console.log(`applied: BrokerSymbol ${row.id} created; ${broker.subdomain} now has ${after} enabled symbols`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Refused ? `refused: ${e.message}` : e);
  process.exit(1);
});
