import type { OrderSide, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

// Step 3b item 2d (owner 2026-10-07): "Hedging allowed" (Broker.hedgingAllowed, default true = today's behaviour).
// When off, an OPEN that would put an account on both sides of one symbol is refused. Every open path calls this next
// to the account-status / trading-rights gates: client order and pending order, requote accept, dealer accept, desk
// flush, staff open, pending trigger, copy-rule open. Closing is never an open, so a close is never refused here.
// Not applied to the broker's own coverage account (its route, app/api/manage/coverage/orders, carries no client gates).
// Cutover gate: docs/RUST-CUTOVER-PLAN.md 6.1 (the engine must honour the same rule at every open it performs).
export const HEDGING_REFUSED_TEXT = "hedging is not allowed: close the opposite position on this symbol first";
export const HEDGING_NOT_ALLOWED = "HEDGING_NOT_ALLOWED";

export async function checkHedgingAllowed(
  db: Db,
  broker: { hedgingAllowed?: boolean | null },
  params: { accountId: string; symbolId: string; side: OrderSide }
): Promise<string | null> {
  if (broker.hedgingAllowed !== false) return null;
  const opposite = await db.position.findFirst({
    where: { accountId: params.accountId, symbolId: params.symbolId, status: "OPEN", side: params.side === "BUY" ? "SELL" : "BUY" },
    select: { id: true },
  });
  return opposite ? HEDGING_REFUSED_TEXT : null;
}
