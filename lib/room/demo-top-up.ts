import "server-only";
import { Prisma } from "@prisma/client";
import { lockAccountBalance } from "@/lib/account-lock";

// Demo top-up from the Trader's Room (owner 2026-11-09/10): a demo account's balance goes up at once, no approval, never
// above 100,000 in the account currency. Demo only: the caller passes the account's mode and this refuses anything else,
// so live money can never be created here. Booked as one COMPLETED ADJUSTMENT row (how demo money is booked, like the
// opening balance), under the account's row lock.
export const DEMO_TOP_UP_CAP = new Prisma.Decimal(100_000);
export const DEMO_TOP_UP_NOTE = "Demo top-up";

export class DemoTopUpError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export async function demoTopUp(
  tx: Prisma.TransactionClient,
  p: { brokerId: string; accountId: string; accountMode: string; currency: string; amount: Prisma.Decimal }
): Promise<{ transactionId: string; balance: Prisma.Decimal }> {
  if (p.accountMode !== "DEMO") throw new DemoTopUpError("Top up is for demo accounts only.", 403);
  if (!p.amount.isFinite() || !p.amount.gt(0) || p.amount.decimalPlaces() > 2) throw new DemoTopUpError("Enter an amount.");
  const before = await lockAccountBalance(tx, p.accountId);
  const room = DEMO_TOP_UP_CAP.sub(before);
  if (room.lte(0)) throw new DemoTopUpError(`This demo account already holds the most it can (${fmt(DEMO_TOP_UP_CAP)} ${p.currency}).`);
  if (p.amount.gt(room)) throw new DemoTopUpError(`Up to ${fmt(room)} ${p.currency}: a demo balance stays at or under ${fmt(DEMO_TOP_UP_CAP)} ${p.currency}.`);
  const after = before.add(p.amount);
  await tx.account.update({ where: { id: p.accountId }, data: { balance: after } });
  const row = await tx.transaction.create({
    data: { brokerId: p.brokerId, accountId: p.accountId, type: "ADJUSTMENT", status: "COMPLETED", amount: p.amount, balanceBefore: before, balanceAfter: after, note: DEMO_TOP_UP_NOTE },
  });
  return { transactionId: row.id, balance: after };
}

const fmt = (d: Prisma.Decimal) => Number(d.toFixed(2)).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
