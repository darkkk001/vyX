import "server-only";
import { Prisma } from "@prisma/client";

// Every balance write in this app is read-modify-write inside a transaction: read Account.balance, compute
// balanceAfter, write it, and record balanceBefore/balanceAfter on the Transaction row. Under Postgres'
// default READ COMMITTED a plain read lets two concurrent writers read the same balance, and the second
// write silently erases the first (2026-09-23: 10 concurrent closes of +1,000 each landed +3,000..+4,000
// while all ten TRADE_PNL rows were written). Reading through these helpers takes the row lock first, so a
// concurrent writer waits for the first to commit and then reads its result.

type Tx = Prisma.TransactionClient;

/** Locks one account's row for the rest of the transaction and returns its current balance. */
export async function lockAccountBalance(tx: Tx, accountId: string): Promise<Prisma.Decimal> {
  const rows = await tx.$queryRaw<{ balance: Prisma.Decimal }[]>`SELECT balance FROM "Account" WHERE id = ${accountId} FOR UPDATE`;
  if (rows.length === 0) throw new Error(`account ${accountId} not found`);
  return new Prisma.Decimal(rows[0].balance);
}

/** Locks several accounts in ONE fixed (id) order, so two transfers between the same pair in opposite
 *  directions cannot deadlock, and returns each balance. */
export async function lockAccountBalances(tx: Tx, accountIds: string[]): Promise<Map<string, Prisma.Decimal>> {
  const out = new Map<string, Prisma.Decimal>();
  for (const id of [...new Set(accountIds)].sort()) out.set(id, await lockAccountBalance(tx, id));
  return out;
}
