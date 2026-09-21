import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import { provisionStarterState } from "../lib/starter-state";
import crypto from "node:crypto";
import { assertNotProductionDatabase } from "../scripts/lib/assert-not-production.mjs";

const prisma = new PrismaClient();

// Local/demo seed only (assertNotProductionDatabase guards this against the
// real DB): every seeded password is randomly generated per run and printed
// once at the end -- never a constant checked into the repo (2026-09-15
// super-admin audit, item 2; the old hardcoded "ChangeMe123!" was publicly
// readable here and still worked on the seeded super-admin account).
function randomPassword(): string {
  return crypto.randomBytes(12).toString("base64url") + "aA1!";
}

// Not locked to a single "zzzqa"-style test broker -- this seed's actual
// job is provisioning the fixed demo tenants (AcmeFX, Nova Markets)
// documented in CLAUDE.md's "Demo credentials" section, so it legitimately
// needs to create more than one named broker. The hard lock is
// assertNotProductionDatabase() below: refuse outright if this DATABASE_URL
// resolves to the DB holding the real Futurix Global broker.
async function main() {
  await assertNotProductionDatabase(prisma);

  const superAdminPlain = randomPassword();
  const superAdminPassword = await bcrypt.hash(superAdminPlain, 10);
  await prisma.adminUser.upsert({
    where: { email: "super@vyxtrader.com" },
    update: {},
    create: {
      email: "super@vyxtrader.com",
      passwordHash: superAdminPassword,
      role: "SUPER_ADMIN",
      brokerId: null,
    },
  });

  const acmeFx = await prisma.broker.upsert({
    where: { subdomain: "acmefx" },
    update: {},
    create: {
      name: "AcmeFX",
      subdomain: "acmefx",
      tier: "STANDARD",
      logoUrl: "https://placehold.co/160x40?text=AcmeFX",
      primaryColor: null, // Standard tier: no custom brand color, default vyX theme
    },
  });

  const novaMarkets = await prisma.broker.upsert({
    where: { subdomain: "novamarkets" },
    update: {},
    create: {
      name: "Nova Markets",
      subdomain: "novamarkets",
      tier: "WHITE_LABEL",
      logoUrl: "https://placehold.co/160x40?text=Nova+Markets",
      primaryColor: "#7c3aed",
    },
  });

  // Starter groups + the 16-symbol platform-default set, through the SAME
  // function POST /api/admin/brokers uses. Previously the seed created groups
  // and symbols by hand while the real provisioning API created neither, so
  // the two drifted; lib/starter-state.ts is now the single definition.
  for (const broker of [acmeFx, novaMarkets]) {
    await provisionStarterState(prisma, broker.id);
  }

  // The Standard group is what the demo accounts below are opened in.
  const acmeFxGroup = await prisma.group.findUniqueOrThrow({
    where: { brokerId_name: { brokerId: acmeFx.id, name: "Standard" } },
  });
  const novaMarketsGroup = await prisma.group.findUniqueOrThrow({
    where: { brokerId_name: { brokerId: novaMarkets.id, name: "Standard" } },
  });

  const brokerAdminPlain = randomPassword();
  const brokerAdminPassword = await bcrypt.hash(brokerAdminPlain, 10);
  await prisma.adminUser.upsert({
    where: { email: "admin@acmefx.com" },
    update: {},
    create: {
      email: "admin@acmefx.com",
      passwordHash: brokerAdminPassword,
      role: "BROKER_ADMIN",
      brokerId: acmeFx.id,
    },
  });
  await prisma.adminUser.upsert({
    where: { email: "admin@novamarkets.com" },
    update: {},
    create: {
      email: "admin@novamarkets.com",
      passwordHash: brokerAdminPassword,
      role: "BROKER_ADMIN",
      brokerId: novaMarkets.id,
    },
  });

  // Manager (dealing desk) demo login -- app/manage/*, see
  // app/manage/symbols/page.tsx.
  const managerPlain = randomPassword();
  const managerPassword = await bcrypt.hash(managerPlain, 10);
  await prisma.adminUser.upsert({
    where: { email: "manager@acmefx.com" },
    update: {},
    create: {
      email: "manager@acmefx.com",
      passwordHash: managerPassword,
      role: "MANAGER",
      brokerId: acmeFx.id,
    },
  });

  // Symbols and BrokerSymbol rows are provisioned by provisionStarterState
  // above -- the curated 16-symbol set both production brokers actually run.
  // The hand-written 10-symbol list that used to live here included USDJPY,
  // which no broker enables because the feed does not carry it.

  const demoPassword = await bcrypt.hash("Demo1234!", 10);
  await prisma.account.upsert({
    where: { accountNumber: "50001234" },
    update: {},
    create: {
      brokerId: acmeFx.id,
      groupId: acmeFxGroup.id,
      accountNumber: "50001234",
      email: "demo@acmefx.com",
      passwordHash: demoPassword,
      fullName: "Demo Trader",
      accountMode: "DEMO",
      currency: "USD",
      leverage: 100,
      balance: 10000,
    },
  });
  await prisma.account.upsert({
    where: { accountNumber: "50005678" },
    update: {},
    create: {
      brokerId: novaMarkets.id,
      groupId: novaMarketsGroup.id,
      accountNumber: "50005678",
      email: "demo@novamarkets.com",
      passwordHash: demoPassword,
      fullName: "Demo Trader",
      accountMode: "DEMO",
      currency: "USD",
      leverage: 100,
      balance: 10000,
    },
  });

  console.log("Seeded:", { acmeFx: acmeFx.subdomain, novaMarkets: novaMarkets.subdomain });
  console.log("One-time seeded passwords (this run only; not stored in the repo):");
  console.log(`Super admin login: super@vyxtrader.com / ${superAdminPlain}`);
  console.log(`Broker admin logins: admin@acmefx.com, admin@novamarkets.com / ${brokerAdminPlain}`);
  console.log(`Manager login (acmefx.<domain>/manage/login): manager@acmefx.com / ${managerPlain}`);
  console.log("Demo trading logins: 50001234 / Demo1234! (AcmeFX), 50005678 / Demo1234! (Nova Markets)");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
