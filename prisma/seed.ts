import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const superAdminPassword = await bcrypt.hash("ChangeMe123!", 10);
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

  const brokerAdminPassword = await bcrypt.hash("ChangeMe123!", 10);
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

  const symbolDefs = [
    { name: "EURUSD", baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
    { name: "GBPUSD", baseCurrency: "GBP", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
    { name: "USDJPY", baseCurrency: "USD", quoteCurrency: "JPY", digits: 3, contractSize: "100000", category: "FOREX" },
    { name: "AUDUSD", baseCurrency: "AUD", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" },
    { name: "XAUUSD", baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: "100", category: "METALS" },
    { name: "XAGUSD", baseCurrency: "XAG", quoteCurrency: "USD", digits: 3, contractSize: "5000", category: "METALS" },
    { name: "BTCUSD", baseCurrency: "BTC", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "CRYPTO" },
    { name: "ETHUSD", baseCurrency: "ETH", quoteCurrency: "USD", digits: 2, contractSize: "1", category: "CRYPTO" },
    { name: "US30", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "INDICES" },
    { name: "NAS100", baseCurrency: "USD", quoteCurrency: "USD", digits: 1, contractSize: "1", category: "INDICES" },
  ] as const;

  const symbols = await Promise.all(
    symbolDefs.map((def) =>
      prisma.symbol.upsert({
        where: { name: def.name },
        update: {},
        create: def,
      })
    )
  );

  for (const broker of [acmeFx, novaMarkets]) {
    for (const symbol of symbols) {
      await prisma.brokerSymbol.upsert({
        where: { brokerId_symbolId: { brokerId: broker.id, symbolId: symbol.id } },
        update: {},
        create: {
          brokerId: broker.id,
          symbolId: symbol.id,
          spreadMarkup: 0,
          minLot: "0.01",
          maxLot: "100",
          lotStep: "0.01",
          swapLong: "-1.20",
          swapShort: "0.35",
          enabled: true,
        },
      });
    }
  }

  const demoPassword = await bcrypt.hash("Demo1234!", 10);
  await prisma.account.upsert({
    where: { accountNumber: "50001234" },
    update: {},
    create: {
      brokerId: acmeFx.id,
      accountNumber: "50001234",
      email: "demo@acmefx.com",
      passwordHash: demoPassword,
      fullName: "Demo Trader",
      accountType: "DEMO",
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
      accountNumber: "50005678",
      email: "demo@novamarkets.com",
      passwordHash: demoPassword,
      fullName: "Demo Trader",
      accountType: "DEMO",
      currency: "USD",
      leverage: 100,
      balance: 10000,
    },
  });

  console.log("Seeded:", { acmeFx: acmeFx.subdomain, novaMarkets: novaMarkets.subdomain });
  console.log("Super admin login: super@vyxtrader.com / ChangeMe123!");
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
