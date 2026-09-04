// One-off QA fixture for manually testing the fix/p0-money-risk preview
// deployment in a real browser. Two DB writes, both against Nova Markets
// (a clean, low-stakes test broker -- not Futurix Global):
//
//   1. Broker.customDomain -- a Vercel preview URL (*.vercel.app) matches
//      neither middleware.ts's <subdomain>.<ROOT_DOMAIN> check nor a real
//      customDomain, so it 404s to /broker-not-found for every page.
//      Setting Nova Markets' customDomain to the preview's own hostname
//      makes that exact URL resolve to a real tenant.
//   2. BrokerSymbol(XAUUSD).spreadMarkup -- SLIPPAGE_EXCEEDED
//      (lib/risk.ts's checkSlippage) can't be reliably clicked into
//      existence against a genuinely live feed: the client always submits
//      the price it's currently displaying, which stays within a pip of
//      the server's own fill price under normal conditions. Inflating the
//      markup to 50 pips forces the server's fill price (ask + markup)
//      far enough from what the client saw to deterministically exceed
//      the default 5-pip tolerance on every Buy, no timing race needed.
//
// Usage:
//   npx tsx scripts/preview-test-setup.ts            -- apply the fixture
//   npx tsx scripts/preview-test-setup.ts --revert    -- restore originals
//
// Both values' *actual* originals (confirmed by a direct query before
// this script was written) are hardcoded below as the revert targets --
// this only ever toggles between exactly two known states, never guesses.
import { PrismaClient } from "@prisma/client";
import { assertNotProductionDatabase } from "./lib/assert-not-production.mjs";

// Deliberately NOT locked to the zzzqa test broker -- this fixture needs
// a broker that plausibly stands in for a real tenant's own custom-domain
// flow, which is Nova Markets' documented role (see module comment
// above: "a clean, low-stakes test broker -- not Futurix Global"). The
// hard lock here is assertNotProductionDatabase() below, same as every
// other script in this file's family -- never run against the DB that
// has the real Futurix Global broker in it.
const NOVA_MARKETS_ID = "cmsz4syr90003vcz4v9lom7ro";
const PREVIEW_HOST = "vyxterminal-git-fix-p0-money-risk-bigfishs-projects-260e2a83.vercel.app";

const ORIGINAL_CUSTOM_DOMAIN: string | null = null;
const ORIGINAL_XAU_SPREAD_MARKUP = 0;
const TEST_XAU_SPREAD_MARKUP = 50; // pips -- see module comment

async function main() {
  const revert = process.argv.includes("--revert");
  const prisma = new PrismaClient();
  await assertNotProductionDatabase(prisma);

  const broker = await prisma.broker.findUniqueOrThrow({
    where: { id: NOVA_MARKETS_ID },
    select: { name: true, customDomain: true },
  });
  const xau = await prisma.brokerSymbol.findFirstOrThrow({
    where: { brokerId: NOVA_MARKETS_ID, symbol: { name: "XAUUSD" } },
    select: { id: true, spreadMarkup: true },
  });

  console.log("BEFORE:");
  console.log(`  ${broker.name}.customDomain = ${JSON.stringify(broker.customDomain)}`);
  console.log(`  ${broker.name} XAUUSD.spreadMarkup = ${xau.spreadMarkup.toString()}`);

  const targetCustomDomain = revert ? ORIGINAL_CUSTOM_DOMAIN : PREVIEW_HOST;
  const targetSpreadMarkup = revert ? ORIGINAL_XAU_SPREAD_MARKUP : TEST_XAU_SPREAD_MARKUP;

  await prisma.broker.update({ where: { id: NOVA_MARKETS_ID }, data: { customDomain: targetCustomDomain } });
  await prisma.brokerSymbol.update({ where: { id: xau.id }, data: { spreadMarkup: targetSpreadMarkup } });

  console.log(revert ? "\nREVERTED:" : "\nAPPLIED:");
  console.log(`  ${broker.name}.customDomain = ${JSON.stringify(targetCustomDomain)}`);
  console.log(`  ${broker.name} XAUUSD.spreadMarkup = ${targetSpreadMarkup}`);

  await prisma.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
