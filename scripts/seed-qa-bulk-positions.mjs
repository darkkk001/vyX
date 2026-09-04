// VYX-BASICS-AUDIT.md category 8 -- bulk-seeds synthetic OPEN positions
// under the isolated zzzqa QA broker's own account 9000001, for
// measuring Live Exposure table performance at 500+ rows. Tagged via a
// deterministic idempotencyKey prefix ("qa-bulk:") so it's trivially
// identifiable and removable -- see the DELETE variant invoked with
// `node scripts/seed-qa-bulk-positions.mjs delete`.
import { PrismaClient, Prisma } from "@prisma/client";
import { assertNotProductionDatabase } from "./lib/assert-not-production.mjs";
const prisma = new PrismaClient();
const D = (v) => new Prisma.Decimal(v);

const BROKER_ID = "cmtlvoyqw0000vcjosb8amv2m";
const BROKER_SUBDOMAIN = "zzzqa";
const ACCOUNT_NUMBER = "9000001";
const COUNT = 550;

async function main() {
  await assertNotProductionDatabase(prisma);

  const mode = process.argv[2] ?? "create";
  const account = await prisma.account.findUnique({ where: { accountNumber: ACCOUNT_NUMBER }, select: { id: true, brokerId: true, broker: { select: { subdomain: true } } } });
  if (!account || account.brokerId !== BROKER_ID) throw new Error("QA account not found or wrong broker");
  if (account.broker.subdomain !== BROKER_SUBDOMAIN) {
    throw new Error(`Refusing to proceed: account's broker subdomain "${account.broker.subdomain}" is not the whitelisted test broker "${BROKER_SUBDOMAIN}"`);
  }

  if (mode === "delete") {
    const orders = await prisma.order.findMany({ where: { accountId: account.id, idempotencyKey: { startsWith: "qa-bulk:" } }, select: { id: true } });
    const orderIds = orders.map((o) => o.id);
    const delPos = await prisma.position.deleteMany({ where: { originOrderId: { in: orderIds } } });
    const delOrd = await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    console.log(`deleted ${delPos.count} positions, ${delOrd.count} orders`);
    await prisma.$disconnect();
    return;
  }

  const symbols = await prisma.symbol.findMany({ where: { name: { in: ["EURUSD", "XAUUSD"] } }, select: { id: true, name: true } });
  if (symbols.length < 2) throw new Error("expected EURUSD+XAUUSD symbols to exist");

  let created = 0;
  for (let i = 0; i < COUNT; i++) {
    const symbol = symbols[i % symbols.length];
    const side = i % 2 === 0 ? "BUY" : "SELL";
    const price = symbol.name === "EURUSD" ? 1.08 + (i % 50) * 0.0001 : 2400 + (i % 50) * 0.5;
    const order = await prisma.order.create({
      data: {
        brokerId: BROKER_ID,
        accountId: account.id,
        symbolId: symbol.id,
        side,
        type: "MARKET",
        volume: D("0.01"),
        status: "FILLED",
        filledPrice: D(price.toFixed(symbol.name === "EURUSD" ? 5 : 2)),
        filledAt: new Date(),
        idempotencyKey: `qa-bulk:${i}`,
      },
    });
    await prisma.position.create({
      data: {
        brokerId: BROKER_ID,
        accountId: account.id,
        symbolId: symbol.id,
        originOrderId: order.id,
        side,
        volume: D("0.01"),
        openPrice: D(price.toFixed(symbol.name === "EURUSD" ? 5 : 2)),
        bookType: "B_BOOK",
      },
    });
    created++;
  }
  console.log(`created ${created} positions`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
