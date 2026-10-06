import "server-only";
import { prisma } from "@/lib/prisma";
import { evaluateAccountsRisk } from "@/lib/risk-monitor";
import { drainPostCloseBackstop } from "@/lib/post-close";
import { evaluatePendingTriggers } from "@/lib/pending-trigger";

/**
 * The full margin-monitor pass: every account holding an open position, every resting order, and the post-close backstop.
 * One body for the 5-minute cron (app/api/internal/margin-monitor) and the 1-minute engine-down fallback
 * (app/api/internal/risk-fallback); each does its own gating before it calls this. The risk owner prefilter is inside
 * evaluateAccountsRisk (lib/risk-owner.ts), so a RUST-owned account is skipped unless the engine's heartbeat is stale.
 */
export async function runFullMarginPass() {
  // Rust cutover Stage 3 backstop: post-close outbox rows the engine's dispatcher has not finished within 2
  // minutes (engine down, or the route unreachable from the VPS) run here. One indexed query when there are none.
  const outbox = await drainPostCloseBackstop().catch((err) => {
    console.error("margin-monitor: post-close backstop failed", err);
    return { ran: 0, failed: 0 };
  });

  // every resting LIMIT / STOP order (Batch 4: server-side trigger; the engine's 60 s pass and this cron are the floor
  // under the tick hook) -- before the no-open-positions bail-out, since a pending order needs no open position
  const pending = await evaluatePendingTriggers().catch((err) => {
    console.error("margin-monitor: pending trigger sweep failed", err);
    return null;
  });

  // Cheapest possible check first, index-backed: if nothing is open anywhere on the platform, there is nothing to
  // protect this minute -- bail out immediately rather than even fetching the distinct account list.
  const openCount = await prisma.position.count({ where: { status: "OPEN" } });
  if (openCount === 0) {
    return { accountsEvaluated: 0, errors: 0, outbox, pending };
  }

  const openAccounts = await prisma.position.findMany({
    where: { status: "OPEN" },
    select: { accountId: true },
    distinct: ["accountId"],
  });

  // one shared read per batch of accounts, not one per account (lib/risk-monitor.ts evaluateAccountsRisk)
  const errors = await evaluateAccountsRisk(openAccounts.map((a) => a.accountId), "margin-monitor: evaluation failed for account");

  return { accountsEvaluated: openAccounts.length, errors, outbox, pending };
}
