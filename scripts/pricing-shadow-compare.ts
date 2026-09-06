// Phase 2 pricing engine, Stage 3 -- standalone runner for the read-only
// shadow comparison (lib/pricing-shadow-compare.ts). Unlike every other
// script in this directory, this one is MEANT to be pointed at production
// -- it's the whole point of Stage 3: see what the new resolver would
// change before Broker.pricingEngineEnabled is ever flipped for a real
// broker. Deliberately does NOT call assertNotProductionDatabase (that
// guard exists to stop test/seed WRITES from hitting prod; this script
// never writes anything).
//
// Usage: set DATABASE_URL/DIRECT_URL to whichever branch you want to
// check (prod: ep-flat-boat; dev: ep-old-night, the default from .env),
// then:
//   npx tsx scripts/pricing-shadow-compare.ts [brokerSubdomain]
// brokerSubdomain defaults to "futurixglobal".
import "dotenv/config";
import { PrismaClient } from "@prisma/client";
import { runShadowPricingComparison } from "@/lib/pricing-shadow-compare";

async function main() {
  const subdomain = process.argv[2] ?? "futurixglobal";
  const prisma = new PrismaClient();

  const broker = await prisma.broker.findFirst({ where: { subdomain } });
  if (!broker) {
    console.error(`No broker found with subdomain "${subdomain}"`);
    process.exit(1);
  }

  console.log(`Broker: ${broker.name} (${broker.subdomain}) -- pricingEngineEnabled=${broker.pricingEngineEnabled}`);
  console.log("Running shadow comparison (read-only, old group-only vs new full-resolution)...\n");

  const summary = await runShadowPricingComparison(prisma, broker.id);

  console.log(`Accounts checked:        ${summary.accountsChecked}`);
  console.log(`Symbols checked:         ${summary.symbolsChecked}`);
  console.log(`Comparisons run:         ${summary.comparisonsRun}`);
  console.log(`Accounts with any diff:  ${summary.accountsWithAnyDiff}`);
  console.log(`Diff rows:               ${summary.diffs.length}\n`);

  if (summary.diffs.length === 0) {
    console.log("No differences -- every account+symbol prices identically under the new resolver. Safe with respect to today's data.");
  } else {
    for (const row of summary.diffs) {
      const flag = row.hasOpenPosition ? " [OPEN POSITION]" : "";
      console.log(`Account ${row.accountNumber} (${row.accountId}) x ${row.symbolName}${flag}`);
      for (const f of row.fields) {
        console.log(`    ${f.field}: ${f.oldValue} -> ${f.newValue}`);
      }
      if (row.spreadInfo) {
        const base = row.spreadInfo.liveBaseSpreadPips ?? "no live tick";
        const warn = row.spreadInfo.warning ? ` [warning: ${row.spreadInfo.warning.reason}]` : "";
        console.log(`    spread mode: ${row.spreadInfo.mode}, live base spread: ${base}${warn}`);
      }
    }
  }

  await prisma.$disconnect();
  process.exit(summary.diffs.length > 0 ? 2 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
