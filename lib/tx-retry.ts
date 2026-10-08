// Bounded retry for a database transaction that Postgres aborted for a concurrency reason: 40P01 (deadlock detected)
// or 40001 (serialization failure). An aborted transaction is rolled back completely, so running the whole closure
// again cannot leave a half-written order or position behind; orders are also unique by (accountId, idempotencyKey)
// and a position by its origin order, so a retry can never create a second one. Anything else is rethrown at once.

const RETRYABLE_CODES = new Set(["40P01", "40001"]);

/** True when the error is a Postgres deadlock / serialization failure, however Prisma wrapped it. */
export function isRetryableTxError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: unknown; message?: unknown; meta?: { code?: unknown; message?: unknown } };
  if (e.code === "P2034") return true; // Prisma: "write conflict or a deadlock"
  if (typeof e.meta?.code === "string" && RETRYABLE_CODES.has(e.meta.code)) return true;
  const text = `${typeof e.message === "string" ? e.message : ""} ${typeof e.meta?.message === "string" ? e.meta.message : ""}`;
  return /\b40P01\b|\b40001\b|deadlock detected/i.test(text);
}

export type TxRetryOptions = { retries?: number; baseDelayMs?: number; sleep?: (ms: number) => Promise<void> };

/** Runs `run` (normally a whole `prisma.$transaction(...)` call); on a deadlock / serialization failure waits a short
 *  jittered backoff and runs it again, at most `retries` more times (default 2). */
export async function withDeadlockRetry<T>(run: () => Promise<T>, opts: TxRetryOptions = {}): Promise<T> {
  const retries = opts.retries ?? 2;
  const base = opts.baseDelayMs ?? 25;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      if (attempt >= retries || !isRetryableTxError(err)) throw err;
      console.warn(`transaction retry ${attempt + 1}/${retries} after a deadlock or serialization failure`);
      await sleep(base * 2 ** attempt + Math.random() * base);
    }
  }
}
