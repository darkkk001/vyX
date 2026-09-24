import "server-only";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { cancelPendingClose } from "@/lib/queued-close";
import { emitPositionClosedActivity, type CloseReason } from "@/lib/dealer-activity";
import { publishTradingEvent, withTradingEventBuffer, type BufferedTradingEvent } from "@/lib/nats";
import { createNotification } from "@/lib/notifications";
import * as mirror from "@/lib/mirror";
import * as coverage from "@/lib/coverage";

// Rust cutover Stage 3 (docs/RUST-CUTOVER-PLAN.md §Stage 3): what the web does after an AUTOMATIC close, for the
// closes the engine's monitor makes. The engine writes a PostCloseEffect row in the same transaction as the close
// (engine/order-management/src/book.rs enqueue_post_close) and its dispatcher (outbox.rs) POSTs the row's id to
// /api/internal/post-close, which calls runPostClose. The web's own closes keep running the same effects inline
// (lib/risk-monitor.ts); this is the same sequence, made retry-safe:
//
// - every step commits its writes together with its name appended to "doneSteps"; a step already listed is
//   skipped, so a retry after a 500 or a crash never repeats a write (the append is also the row lock that makes
//   two concurrent runners queue up behind each other on the same step);
// - trading events a step raises are stored in "pendingEvents" in that same transaction and published by the
//   last step, after every write committed (at-least-once: a crash before the row is marked DONE re-publishes);
// - failures never throw out of here: the result says "retry" / "error" and the CALLER (the engine dispatcher, or
//   drainPostCloseBackstop below) records the attempt and its backoff with recordPostCloseFailure.

export type PostCloseStatus = "done" | "gone" | "busy" | "retry" | "error";
export type PostCloseResult = { status: PostCloseStatus; error?: string };

/** Test-only hook: called at every step boundary ("before:<step>" / "after:<step>"). Throwing an Error there
 *  is a failed run; throwing a PostCloseCrash leaves the lease held, like a process that died mid-run. */
export type PostCloseFault = (point: string) => void;
export class PostCloseCrash extends Error {}

const LEASE_SECONDS = 60;
// after the Nth failed run the next try waits BACKOFF_SECONDS[N-1], then every 30 min; same table as
// engine/order-management/src/outbox.rs backoff_seconds
const BACKOFF_SECONDS = [2, 10, 30, 120, 600];
const BACKOFF_LATER_SECONDS = 1800;
export const MAX_ATTEMPTS = 50;
export const MAX_AGE_HOURS = 24;
// an auto-hedged leg with no live price is retried this many runs before COVERAGE_CLOSE_FAILED goes out
// (2 s + 10 s + 30 s of backoff, plus the dispatcher's sweep: about a minute)
const NO_PRICE_RETRIES = 3;

export function backoffSeconds(attempts: number): number {
  return BACKOFF_SECONDS[attempts - 1] ?? BACKOFF_LATER_SECONDS;
}

type Row = {
  id: string;
  kind: string;
  brokerId: string;
  accountId: string;
  positionId: string | null;
  reason: string | null;
  payload: Prisma.JsonValue;
  attempts: number;
};

type ClosePayload = { closedLots: string; sourceVolumeBeforeClose: string; closePrice: string; realizedPnl: string; marginLevel?: string; stopOutLevel?: string };
type MarginCallPayload = { marginLevel: string; marginCallLevel: string };

const D = (v: string) => new Prisma.Decimal(v);

async function runStep(id: string, step: string, work: (tx: Prisma.TransactionClient) => Promise<void>): Promise<void> {
  await prisma.$transaction(
    async (tx) => {
      const claimed = await tx.$executeRaw`
        UPDATE "PostCloseEffect" SET "doneSteps" = array_append("doneSteps", ${step})
        WHERE id = ${id} AND status = 'PENDING' AND NOT (${step} = ANY("doneSteps"))`;
      if (claimed === 0) return; // done by an earlier run (or the row is no longer pending)
      const events: BufferedTradingEvent[] = [];
      await withTradingEventBuffer(events, () => work(tx));
      if (events.length > 0) {
        await tx.$executeRaw`
          UPDATE "PostCloseEffect" SET "pendingEvents" = "pendingEvents" || ${JSON.stringify(events)}::jsonb WHERE id = ${id}`;
      }
    },
    { timeout: 20000, maxWait: 10000 }
  );
}

function closeSteps(row: Row): { name: string; work: (tx: Prisma.TransactionClient) => Promise<void> }[] {
  const p = row.payload as ClosePayload;
  const positionId = row.positionId!;
  const reason = row.reason as "stop_loss" | "take_profit" | "stop_out";
  const closedLots = D(p.closedLots);
  const sourceVolumeBeforeClose = D(p.sourceVolumeBeforeClose);
  const closePrice = D(p.closePrice);
  const stopOut = reason === "stop_out";
  // the engine only closes in full today; a partial row (future) keeps its queued close, as the web's paths do
  const partial = closedLots.lt(sourceVolumeBeforeClose);
  const steps: { name: string; work: (tx: Prisma.TransactionClient) => Promise<void> }[] = [
    {
      name: "cancel_pending_close",
      work: async (tx) => {
        const why = stopOut ? "position closed by stop-out" : reason === "stop_loss" ? "position closed by stop loss" : "position closed by take profit";
        if (!partial) await cancelPendingClose(tx, positionId, why);
      },
    },
    {
      name: "mirror",
      work: (tx) => mirror.onClose(tx, { positionId, brokerId: row.brokerId, closedLots, sourceVolumeBeforeClose, closePrice }, { rethrow: true }),
    },
  ];
  if (stopOut) {
    steps.push({
      name: "notify_stop_out",
      work: async (tx) => {
        const pos = await tx.position.findUniqueOrThrow({
          where: { id: positionId },
          select: { ticket: true, side: true, symbol: { select: { name: true } }, account: { select: { accountNumber: true } } },
        });
        await coverage.notifyStopOut(tx, {
          brokerId: row.brokerId,
          accountId: row.accountId,
          accountNumber: pos.account.accountNumber,
          positionId,
          ticket: pos.ticket,
          symbol: pos.symbol.name,
          side: pos.side,
          volume: closedLots.toString(),
          marginLevel: p.marginLevel!,
          stopOutLevel: D(p.stopOutLevel!).toString(),
        });
      },
    });
  }
  steps.push(
    {
      name: "coverage",
      work: (tx) =>
        coverage.onClose(
          tx,
          { positionId, brokerId: row.brokerId, closedLots, sourceVolumeBeforeClose, reason: stopOut ? "stop_out" : "sl_tp", marginLevel: stopOut ? p.marginLevel : undefined },
          { retryWithoutPrice: row.attempts < NO_PRICE_RETRIES }
        ),
    },
    {
      name: "activity",
      work: async (tx) => {
        const closeReason: CloseReason = stopOut ? "STOP_OUT" : reason === "stop_loss" ? "STOP_LOSS" : "TAKE_PROFIT";
        await publishTradingEvent("PositionClosed", { position_id: positionId, account_id: row.accountId, broker_id: row.brokerId, reason });
        await emitPositionClosedActivity(tx, { positionId, closePrice, closeVolume: closedLots, partial, realizedPnl: D(p.realizedPnl), closeReason, origin: "risk_monitor_engine" });
      },
    }
  );
  return steps;
}

function marginCallSteps(row: Row): { name: string; work: (tx: Prisma.TransactionClient) => Promise<void> }[] {
  const p = row.payload as MarginCallPayload;
  return [
    {
      name: "notify_margin_call",
      work: async (tx) => {
        const account = await tx.account.findUniqueOrThrow({ where: { id: row.accountId }, select: { accountNumber: true } });
        // the same two rows lib/risk-monitor.ts pass 3 writes: the trader's copy and the staff copy
        const body = `Account ${account.accountNumber}'s margin level is ${p.marginLevel}%, at or below the ${D(p.marginCallLevel).toString()}% margin-call level. Deposit funds or close positions to avoid stop-out.`;
        await createNotification(tx, { brokerId: row.brokerId, type: "MARGIN_CALL", title: "Margin call", body, entityType: "Account", entityId: row.accountId, accountId: row.accountId });
        await createNotification(tx, { brokerId: row.brokerId, type: "MARGIN_CALL", title: "Margin call", body, entityType: "Account", entityId: row.accountId });
      },
    },
  ];
}

/** Harness-only: called with each phase's wall time (Stage 4.6 measurement, scripts/parity/post-close-server.ts). */
export type PostCloseTiming = (phase: string, ms: number) => void;
let harnessTiming: PostCloseTiming | undefined;
/** Harness-only: time every run in this process (the route calls runPostClose without options). */
export function setPostCloseTiming(fn: PostCloseTiming | undefined) {
  harnessTiming = fn;
}
let harnessFault: ((rowId: string, point: string) => void) | undefined;
/** Harness-only: inject failures into every run in this process (Stage 4.6 fault gate); a throw is a failed run. */
export function setPostCloseFault(fn: ((rowId: string, point: string) => void) | undefined) {
  harnessFault = fn;
}

/** Runs one outbox row to completion, or as far as it gets. Never throws (except the test-only PostCloseCrash).
 *  opts.ignoreLease is test-only too: two runners on one row at once, to prove the step markers alone keep every
 *  write exactly-once even if the lease ever failed. opts.timing is harness-only (per-phase wall time). */
export async function runPostClose(id: string, opts?: { fault?: PostCloseFault; ignoreLease?: boolean; timing?: PostCloseTiming }): Promise<PostCloseResult> {
  const ignoreLease = opts?.ignoreLease === true;
  const timing = opts?.timing ?? harnessTiming;
  let t = performance.now();
  const lap = (phase: string) => {
    if (!timing) return;
    const now = performance.now();
    timing(phase, now - t);
    t = now;
  };
  const claimed = await prisma.$queryRaw<Row[]>`
    UPDATE "PostCloseEffect" SET "leaseUntil" = now() + (${LEASE_SECONDS}::int * interval '1 second')
    WHERE id = ${id} AND status = 'PENDING' AND (${ignoreLease} OR "leaseUntil" IS NULL OR "leaseUntil" < now())
    RETURNING id, kind, "brokerId", "accountId", "positionId", reason, payload, attempts`;
  if (claimed.length === 0) {
    const row = await prisma.postCloseEffect.findUnique({ where: { id }, select: { status: true } });
    return { status: !row || row.status !== "PENDING" ? "gone" : "busy" };
  }
  const row = claimed[0];
  const fault = opts?.fault ?? (harnessFault ? (point: string) => harnessFault!(row.id, point) : () => {});
  lap("lease");

  try {
    const steps = row.kind === "MARGIN_CALL" ? marginCallSteps(row) : row.kind === "POSITION_CLOSED" ? closeSteps(row) : null;
    if (!steps) throw new Error(`unknown PostCloseEffect kind ${row.kind}`);
    for (const step of steps) {
      fault(`before:${step.name}`);
      await runStep(row.id, step.name, step.work);
      lap(`step:${step.name}`);
      fault(`after:${step.name}`);
    }

    // last step: every write has committed, now the events (read back from the row: a previous run's too)
    fault("before:publish");
    const fresh = await prisma.postCloseEffect.findUniqueOrThrow({ where: { id: row.id }, select: { pendingEvents: true } });
    lap("read_events");
    // Stage 4.6: all of a row's events at once (publishTradingEvent never throws); still at-least-once, and DONE is
    // still written only after every one of them went out
    await Promise.all(((fresh.pendingEvents ?? []) as unknown as BufferedTradingEvent[]).map((e) => publishTradingEvent(e.type, e.payload)));
    lap("publish");
    await prisma.$executeRaw`
      UPDATE "PostCloseEffect" SET status = 'DONE', "doneAt" = now(), "leaseUntil" = NULL, "lastError" = NULL
      WHERE id = ${row.id} AND status = 'PENDING'`;
    lap("done");
    return { status: "done" };
  } catch (err) {
    if (err instanceof PostCloseCrash) throw err; // test-only: the lease stays held, as after a real crash
    const message = err instanceof Error ? err.message : String(err);
    await prisma.$executeRaw`UPDATE "PostCloseEffect" SET "leaseUntil" = NULL, "lastError" = ${message.slice(0, 2000)} WHERE id = ${row.id}`.catch(() => {});
    return { status: err instanceof coverage.CoverageRetryLater ? "retry" : "error", error: message };
  }
}

export type PostCloseBatchResult = { id: string; status: PostCloseStatus | "not_attempted"; error?: string };

/** Stage 4.6: runs rows IN THE ORDER GIVEN (the engine dispatcher sends one conflict group: rows that touch the same
 *  accounts, in source-close order) and stops at the first row that is not finished -- retry / error / busy -- so a
 *  later row never overtakes an earlier one on the same account. The rest come back `not_attempted` (no attempt is
 *  counted for them; the dispatcher sends them again). Each row is still claimed and run exactly as runPostClose
 *  does alone: its own lease, its own step markers. */
export async function runPostCloseBatch(ids: string[]): Promise<PostCloseBatchResult[]> {
  const results: PostCloseBatchResult[] = [];
  let stopped = false;
  for (const id of ids) {
    if (stopped) {
      results.push({ id, status: "not_attempted" });
      continue;
    }
    const r = await runPostClose(id);
    results.push({ id, ...r });
    if (r.status !== "done" && r.status !== "gone") stopped = true;
  }
  return results;
}

/** One failed run (or a dispatcher that could not reach the route): count it and schedule the next try, or give
 *  the row up as DEAD after MAX_ATTEMPTS / MAX_AGE_HOURS with exactly one OUTBOX_DEAD notification to the broker's
 *  staff. The same rule as engine/order-management/src/outbox.rs record_failure. */
export async function recordPostCloseFailure(id: string, error: string): Promise<"retry" | "dead" | "gone"> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ attempts: number; old: boolean; brokerId: string; accountId: string; positionId: string | null; kind: string; doneSteps: string[] }[]>`
      UPDATE "PostCloseEffect" SET attempts = attempts + 1, "lastError" = ${error.slice(0, 2000)}
      WHERE id = ${id} AND status = 'PENDING'
      RETURNING attempts, "createdAt" < now() - (${MAX_AGE_HOURS}::int * interval '1 hour') AS old, "brokerId", "accountId", "positionId", kind, "doneSteps"`;
    if (rows.length === 0) return "gone";
    const r = rows[0];
    if (r.attempts < MAX_ATTEMPTS && !r.old) {
      await tx.$executeRaw`UPDATE "PostCloseEffect" SET "nextAttemptAt" = now() + (${backoffSeconds(r.attempts)}::int * interval '1 second') WHERE id = ${id}`;
      return "retry";
    }
    await tx.$executeRaw`UPDATE "PostCloseEffect" SET status = 'DEAD', "leaseUntil" = NULL WHERE id = ${id}`;
    await createNotification(tx, outboxDeadNotification({ ...r, id, error }));
    return "dead";
  });
}

export function outboxDeadNotification(r: { id: string; brokerId: string; accountId: string; positionId: string | null; kind: string; attempts: number; doneSteps: string[]; error: string }) {
  const what = r.kind === "MARGIN_CALL" ? `the margin-call notice for account ${r.accountId}` : `the follow-up of automatic close ${r.positionId}`;
  return {
    brokerId: r.brokerId,
    type: "OUTBOX_DEAD",
    title: "Post-close follow-up gave up",
    body: `The platform stopped retrying ${what} after ${r.attempts} attempts. Done: ${r.doneSteps.length ? r.doneSteps.join(", ") : "nothing"}. Last error: ${r.error.slice(0, 300)}. Check mirror, coverage and the dealing queue for this position by hand (PostCloseEffect ${r.id}).`,
    entityType: r.positionId ? "Position" : "Account",
    entityId: r.positionId ?? r.accountId,
  };
}

/** Backstop for when the engine's dispatcher is down: runs rows that have waited over 2 minutes. Called by the
 *  margin-monitor cron; one indexed query when there is nothing to do. */
export async function drainPostCloseBackstop(limit = 10): Promise<{ ran: number; failed: number }> {
  const due = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM "PostCloseEffect"
    WHERE status = 'PENDING' AND "nextAttemptAt" <= now() AND "createdAt" < now() - interval '2 minutes'
    ORDER BY seq LIMIT ${limit}`;
  let failed = 0;
  for (const { id } of due) {
    const result = await runPostClose(id);
    if (result.status === "retry" || result.status === "error") {
      failed++;
      await recordPostCloseFailure(id, result.error ?? result.status).catch((err) => console.error("recordPostCloseFailure failed", id, err));
    }
    // Stage 4.6: in insertion order, and stop at the first row that did not finish -- a later row may touch the same
    // account and must not overtake it (the backstop does not group, so it stops outright; the next run resumes)
    if (result.status !== "done" && result.status !== "gone") break;
  }
  return { ran: due.length, failed };
}
