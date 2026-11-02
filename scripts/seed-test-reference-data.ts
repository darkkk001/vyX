// The platform reference rows a freshly migrated TEST database lacks: the global Symbol rows of the platform-default
// set (lib/starter-state.ts STARTER_SYMBOLS). Production and every long-lived dev database have them (each broker's
// provisioning creates any that are missing), and many DB-backed tests read them by name ("XAUUSD", "EURUSD") instead
// of provisioning a broker first. Without them a database built only by deploy/replay-migrations.sh (CI) fails those
// tests with "No record was found". Brokers, groups and accounts are NOT created here: each test makes its own.
//
// Local test databases only (scripts/lib/db-host-policy.mjs); idempotent.
// Usage: npx tsx scripts/seed-test-reference-data.ts
import { PrismaClient } from "@prisma/client";
import { STARTER_SYMBOLS } from "../lib/starter-state";
import { dbHostOf, testDbVerdict } from "./lib/db-host-policy.mjs";

async function main() {
  const url = process.env.DATABASE_URL;
  const host = dbHostOf(url);
  if (!testDbVerdict(url).ok || !["localhost", "127.0.0.1"].includes(host)) {
    throw new Error(`seed-test-reference-data: refusing database host '${host}' (local test databases only)`);
  }
  const prisma = new PrismaClient();
  try {
    let created = 0;
    for (const def of STARTER_SYMBOLS) {
      const before = await prisma.symbol.findUnique({ where: { name: def.name }, select: { id: true } });
      if (before) continue;
      await prisma.symbol.create({ data: { ...def } });
      created++;
    }
    console.log(`seed-test-reference-data: ${created} symbol(s) created, ${STARTER_SYMBOLS.length - created} already present`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
