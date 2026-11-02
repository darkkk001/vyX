// Generates docs/contracts/open-chain-vector.json BY RUNNING THE WEB'S OWN OPEN PATH
// (lib/dealing.ts openPositionFromOrder -> chargeCommission -> writeOpenDealInTx) against a scratch
// database, and recording every row it wrote.
//
// WHY. The L2 cutover (docs: C:\vyx\handoff\l2-cutover-design.md) moves the ENGINE's order path onto
// the same book. "Mirrors the web" is a claim; this file is the measurement. The engine's own
// tests/order_book_prisma_db.rs asserts its chain against this file, so a divergence breaks on one
// side or the other instead of hiding -- the same direction as ask-markup-vectors.json, where the web
// is the oracle and the engine asserts against it.
//
// The vector is NORMALISED: ids, tickets and timestamps are dropped (they are per-row), decimals are
// compared as decimal.js strings, and what is left is the shape and the arithmetic -- which is
// exactly what the two paths have to agree about.
//
//   NODE_OPTIONS=--conditions=react-server (lets lib/* import "server-only", as gen-ask-markup-vectors.ts needs too)
//   DATABASE_URL=postgresql://postgres@127.0.0.1:5499/vyx_test \
//   DIRECT_URL=$DATABASE_URL \
//   npx tsx --tsconfig tsconfig.json scripts/contracts/gen-open-chain-vector.ts
//
// Scratch databases only: the host guard (scripts/lib/db-host-policy.mjs) refuses production, and
// this script deletes the fixture it created before exiting.
import { writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { PrismaClient, Prisma } from "@prisma/client";
import { testDbVerdict } from "../lib/db-host-policy.mjs";
import { openPositionFromOrder } from "../../lib/dealing";

const url = process.env.DATABASE_URL ?? "";
const verdict = testDbVerdict(url);
if (!verdict.ok) throw new Error(`refusing this database: ${verdict.why}`);

const prisma = new PrismaClient();
const D = (v: string) => new Prisma.Decimal(v);

// The one case, chosen to exercise everything that can differ: an A_BOOK group (so the stamp trigger
// has something to get wrong), a non-zero commission with trailing zeros in the rate (so the note's
// number formatting is pinned), and a 0.01 lot (the smallest real trade).
const CASE = {
  name: "a-book client market buy, 0.01 lots, 3.00/lot commission",
  category: "A_BOOK" as const,
  side: "BUY" as const,
  volume: "0.01",
  fillPrice: "4299.13",
  commissionPerLot: "3.00",
  openingBalance: "100000",
  digits: 2,
  contractSize: "1",
};

async function main() {
  const tag = randomUUID().replace(/-/g, "").slice(0, 10);
  const symbolName = `ZW${tag.slice(0, 6).toUpperCase()}`;

  const broker = await prisma.broker.create({ data: { name: `chain ${tag}`, subdomain: `chain-${tag}`, negativeBalanceProtection: true } });
  const group = await prisma.group.create({ data: { brokerId: broker.id, name: `CHAIN-${tag}`, category: CASE.category, marginCallLevel: D("100"), stopOutLevel: D("50") } });
  const account = await prisma.account.create({
    data: {
      brokerId: broker.id,
      groupId: group.id,
      accountNumber: `7${tag.slice(0, 7)}`,
      email: `chain-${tag}@test.local`,
      passwordHash: "x",
      fullName: "Open Chain Contract",
      accountMode: "LIVE",
      balance: D(CASE.openingBalance),
      credit: D("0"),
      leverage: 100,
    },
  });
  const symbol = await prisma.symbol.create({
    data: { name: symbolName, baseCurrency: "XAU", quoteCurrency: "USD", digits: CASE.digits, contractSize: D(CASE.contractSize), category: "METALS" },
  });

  // The order the engine's insert_order writes: PENDING, source API, its own id as the idempotency key.
  const order = await prisma.order.create({
    data: {
      brokerId: broker.id,
      accountId: account.id,
      symbolId: symbol.id,
      side: CASE.side,
      type: "MARKET",
      volume: D(CASE.volume),
      status: "PENDING",
      idempotencyKey: `engine:${tag}`,
      source: "API",
    },
  });

  // THE WEB'S OWN OPEN PATH, unmodified.
  const position = await prisma.$transaction(async (tx) =>
    openPositionFromOrder(tx, order, D(CASE.fillPrice), CASE.category === "A_BOOK" ? "A_BOOK" : "B_BOOK", D(CASE.commissionPerLot), { reason: "CLIENT" })
  );

  const [filledOrder, finalPosition, commissions, deals, finalAccount] = await Promise.all([
    prisma.order.findUniqueOrThrow({ where: { id: order.id } }),
    prisma.position.findUniqueOrThrow({ where: { id: position.id } }),
    prisma.transaction.findMany({ where: { referenceType: "Position", referenceId: position.id }, orderBy: { createdAt: "asc" } }),
    prisma.deal.findMany({ where: { positionId: position.id } }),
    prisma.account.findUniqueOrThrow({ where: { id: account.id } }),
  ]);

  const dec = (v: Prisma.Decimal | null) => (v === null ? null : v.toString());
  const out = {
    // Regenerate with the command at the top of this file after any change to the web's open path.
    generatedBy: "scripts/contracts/gen-open-chain-vector.ts",
    note: "the WEB's openPositionFromOrder chain, normalised; engine/order-management/tests/order_book_prisma_db.rs asserts the engine's chain against it",
    case: CASE,
    order: {
      status: filledOrder.status,
      filledPrice: dec(filledOrder.filledPrice),
      routing: filledOrder.routing,
      executionMode: filledOrder.executionMode,
      hasFilledAt: filledOrder.filledAt !== null,
      hasExecutedAt: filledOrder.executedAt !== null,
      rejectionReason: filledOrder.rejectionReason,
    },
    position: {
      status: finalPosition.status,
      side: finalPosition.side,
      volume: dec(finalPosition.volume),
      initialVolume: dec(finalPosition.initialVolume),
      openPrice: dec(finalPosition.openPrice),
      bookType: finalPosition.bookType,
      // the two trigger-filled columns: the stamp's VALUE, and that the ticket came from the order
      groupCategoryAtOpen: finalPosition.groupCategoryAtOpen,
      ticketEqualsOrderTicket: finalPosition.ticket === filledOrder.ticket,
      commission: dec(finalPosition.commission),
      swap: dec(finalPosition.swap),
      realizedPnl: dec(finalPosition.realizedPnl),
    },
    commissionTransactions: commissions.map((t) => ({
      type: t.type,
      status: t.status,
      amount: dec(t.amount),
      balanceBefore: dec(t.balanceBefore),
      balanceAfter: dec(t.balanceAfter),
      referenceType: t.referenceType,
      note: t.note,
    })),
    deals: deals.map((d) => ({
      entry: d.entry,
      reason: d.reason,
      side: d.side,
      source: d.source,
      volume: dec(d.volume),
      price: dec(d.price),
      commission: dec(d.commission),
      profit: dec(d.profit),
      swap: dec(d.swap),
      namesOneCommissionTransaction: d.transactionId !== null,
      executedAtEqualsPositionOpenedAt: d.executedAt.getTime() === finalPosition.openedAt.getTime(),
      orderIdEqualsOriginOrder: d.orderId === order.id,
    })),
    account: { balanceAfter: dec(finalAccount.balance) },
    // What the web leaves for QoreBridge. The engine must NOT write this table (design option (b)):
    // it queues a PostCloseEffect and the web's worker writes the intent, so this count is what the
    // engine's own chain plus that worker has to end up producing.
    hedgeIntents: await prisma.hedgeIntent.count({ where: { positionId: position.id } }),
  };

  const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "open-chain-vector.json");
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);

  // the fixture is scratch data; leave nothing behind
  await prisma.hedgeIntent.deleteMany({ where: { positionId: position.id } });
  await prisma.deal.deleteMany({ where: { positionId: position.id } });
  await prisma.transaction.deleteMany({ where: { accountId: account.id } });
  await prisma.position.deleteMany({ where: { brokerId: broker.id } });
  await prisma.order.deleteMany({ where: { brokerId: broker.id } });
  await prisma.account.deleteMany({ where: { brokerId: broker.id } });
  await prisma.group.deleteMany({ where: { brokerId: broker.id } });
  await prisma.broker.delete({ where: { id: broker.id } });
  await prisma.symbol.delete({ where: { id: symbol.id } });
}

main()
  .finally(() => prisma.$disconnect())
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
