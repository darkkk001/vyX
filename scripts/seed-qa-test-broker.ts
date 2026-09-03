import { PrismaClient, Prisma } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

// Dedicated, obviously-named, fully isolated test broker for live
// UI/UX click-testing (VYX-BASICS-AUDIT.md categories 3-8) against the
// real Neon DB local dev points at. "zzzqa" subdomain sorts to the
// bottom of any admin picker and is unambiguous in every table --
// never confusable with Futurix or any other real tenant. Idempotent
// (every write is an upsert) so re-running this to reset state between
// audit passes is safe. Never touches any other broker's data.
const D = (v: string) => new Prisma.Decimal(v);

async function main() {
  const broker = await prisma.broker.upsert({
    where: { subdomain: "zzzqa" },
    update: {},
    create: {
      name: "ZZZ QA Test Broker (not real)",
      subdomain: "zzzqa",
      tier: "STANDARD",
    },
  });

  const password = await bcrypt.hash("QaTest123!", 10);
  await prisma.adminUser.upsert({
    where: { email: "qa-manager@zzzqa.test" },
    update: { passwordHash: password },
    create: { email: "qa-manager@zzzqa.test", passwordHash: password, role: "MANAGER", brokerId: broker.id },
  });
  await prisma.adminUser.upsert({
    where: { email: "qa-broker-admin@zzzqa.test" },
    update: { passwordHash: password },
    create: { email: "qa-broker-admin@zzzqa.test", passwordHash: password, role: "BROKER_ADMIN", brokerId: broker.id },
  });

  // A couple of symbols + live prices so tables aren't empty -- reuses
  // the real Symbol rows if this DB already has EURUSD/XAUUSD seeded
  // (upsert by name), only creates BrokerSymbol + LivePrice under this
  // test broker.
  const symbolDefs = [
    { name: "EURUSD", baseCurrency: "EUR", quoteCurrency: "USD", digits: 5, contractSize: "100000", category: "FOREX" as const, bid: "1.08450", ask: "1.08465" },
    { name: "XAUUSD", baseCurrency: "XAU", quoteCurrency: "USD", digits: 2, contractSize: "100", category: "METALS" as const, bid: "2415.20", ask: "2415.55" },
  ];
  const brokerSymbols: { id: string; symbolId: string; name: string; digits: number; contractSize: string }[] = [];
  for (const s of symbolDefs) {
    const symbol = await prisma.symbol.upsert({
      where: { name: s.name },
      update: {},
      create: { name: s.name, baseCurrency: s.baseCurrency, quoteCurrency: s.quoteCurrency, digits: s.digits, contractSize: D(s.contractSize), category: s.category },
    });
    const brokerSymbol = await prisma.brokerSymbol.upsert({
      where: { brokerId_symbolId: { brokerId: broker.id, symbolId: symbol.id } },
      update: {},
      create: { brokerId: broker.id, symbolId: symbol.id, minLot: D("0.01"), maxLot: D("100"), lotStep: D("0.01"), tradingMode: "BOTH" },
    });
    await prisma.livePrice.upsert({
      where: { symbol: s.name },
      update: { bid: D(s.bid), ask: D(s.ask), tickAt: new Date() },
      create: { symbol: s.name, bid: D(s.bid), ask: D(s.ask), tickAt: new Date() },
    });
    brokerSymbols.push({ id: brokerSymbol.id, symbolId: symbol.id, name: s.name, digits: s.digits, contractSize: s.contractSize });
  }

  // Two demo trading accounts with a few open positions each, so
  // Live Exposure/Deals/Accounts tables have real rows to sort, resize,
  // right-click, and multi-select during the audit.
  const accountPassword = await bcrypt.hash("QaTest123!", 10);
  const accountDefs = [
    { accountNumber: "9000001", email: "qa-client-1@zzzqa.test", fullName: "QA Test Client One" },
    { accountNumber: "9000002", email: "qa-client-2@zzzqa.test", fullName: "QA Test Client Two" },
  ];
  const accounts = [];
  for (const a of accountDefs) {
    const account = await prisma.account.upsert({
      where: { accountNumber: a.accountNumber },
      update: {},
      create: {
        brokerId: broker.id,
        accountNumber: a.accountNumber,
        email: a.email,
        passwordHash: accountPassword,
        fullName: a.fullName,
        accountType: "DEMO",
        balance: D("50000"),
      },
    });
    accounts.push(account);
  }

  // Open positions -- only created if this account doesn't already have
  // any (idempotent without needing a natural key on Position).
  const eur = brokerSymbols.find((s) => s.name === "EURUSD")!;
  const xau = brokerSymbols.find((s) => s.name === "XAUUSD")!;
  const positionSeeds = [
    { account: accounts[0], symbol: eur, side: "BUY" as const, volume: "0.50", openPrice: "1.08200" },
    { account: accounts[0], symbol: xau, side: "SELL" as const, volume: "0.10", openPrice: "2420.00" },
    { account: accounts[1], symbol: xau, side: "BUY" as const, volume: "0.25", openPrice: "2410.00" },
  ];
  for (const p of positionSeeds) {
    const existing = await prisma.position.findFirst({ where: { accountId: p.account.id, symbolId: p.symbol.symbolId, status: "OPEN" } });
    if (existing) continue;
    // Position.originOrderId is a required 1:1 FK -- every position
    // traces back to the order that opened it, no exceptions, so the
    // seed needs a filled Order row first, not just the Position itself.
    const order = await prisma.order.create({
      data: {
        brokerId: broker.id,
        accountId: p.account.id,
        symbolId: p.symbol.symbolId,
        side: p.side,
        type: "MARKET",
        volume: D(p.volume),
        status: "FILLED",
        filledPrice: D(p.openPrice),
        filledAt: new Date(),
        idempotencyKey: `qa-seed:${p.account.id}:${p.symbol.symbolId}`,
      },
    });
    await prisma.position.create({
      data: {
        brokerId: broker.id,
        accountId: p.account.id,
        symbolId: p.symbol.symbolId,
        originOrderId: order.id,
        side: p.side,
        volume: D(p.volume),
        openPrice: D(p.openPrice),
        bookType: "B_BOOK",
      },
    });
  }

  console.log("QA test broker ready:");
  console.log("  Manager login:      qa-manager@zzzqa.test / QaTest123!  ->  https://zzzqa.vyxtrader.com/manage/login (or local dev host header)");
  console.log("  Broker Admin login: qa-broker-admin@zzzqa.test / QaTest123!");
  console.log(`  Broker id: ${broker.id}, subdomain: zzzqa`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
