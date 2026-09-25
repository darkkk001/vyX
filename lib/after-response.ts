import "server-only";
import { after } from "next/server";

// Latency fix 1 (2026-09-26, docs/audit/2026-09-24/latency-breakdown.md): work the trader's response does not depend on
// (mirror copies, auto-hedge, dealer-activity feed, hotkey / STM audit rows, the order-ack latency sample) starts now
// but no longer holds the response. On Vercel `after` keeps the function alive until it settles (waitUntil).
//
// Outside a request scope (vitest calling a handler directly) `after` throws; the task is then awaited inline, so tests
// see exactly the old sequential behaviour. A bench can opt into the production behaviour with detachForBench(true).
let detached = false;
const pending = new Set<Promise<unknown>>();

export function detachForBench(on: boolean): void {
  detached = on;
}
/** Bench / test helper: wait for every task started by runAfterResponse while detached. */
export async function settleAfterResponse(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** `awaitWithoutScope: false` = never wait for it outside a request either (a fire-and-forget sample). */
export async function runAfterResponse(label: string, task: () => Promise<unknown>, opts?: { awaitWithoutScope?: boolean }): Promise<void> {
  const p = task().catch((err) => console.error(`after-response ${label} failed`, err));
  if (detached) {
    pending.add(p);
    void p.finally(() => pending.delete(p));
    return;
  }
  try {
    after(p);
  } catch {
    if (opts?.awaitWithoutScope !== false) await p; // no request scope (unit tests): keep the old inline order
  }
}
