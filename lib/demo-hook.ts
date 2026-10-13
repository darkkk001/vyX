import "server-only";
import { demoSubdomain } from "@/lib/demo-policy";
import { isDemoBrokerId, readDemoState, writeDemoState } from "@/lib/demo";
import { sweepDemoAccountLocked } from "@/lib/demo-sweep";
import { prisma } from "@/lib/prisma";

// The one hook that makes the demo's risk lazy. lib/account-auth.ts getAccountSession() calls it for every authenticated
// request; for any tenant but the demo it returns at once (no environment variable = one string compare, no I/O).
//
// For a guest of the demo tenant it (1) checks the guest still exists (a deleted guest's session is refused), and (2) replays
// the price path since the account's cursor when the account may hold positions or resting orders (cursor "w" = 1), so
// every read and every order that follows sees the stop losses, take profits, stop-outs and pending fills the path has
// produced up to this instant. Cost for a guest with nothing open: one Redis GET.

const MIN_GAP_MS = 250; // one grid tick: a second request inside the same tick has nothing new to replay

export async function demoSessionHook(session: { accountId: string; brokerId: string }): Promise<boolean> {
  if (!demoSubdomain()) return true;
  if (!(await isDemoBrokerId(session.brokerId))) return true;
  try {
    const now = Date.now();
    const state = await readDemoState(session.accountId);
    if (!state) {
      // no cursor: new key, a flushed Redis, or a deleted guest
      const row = await prisma.account.findUnique({ where: { id: session.accountId }, select: { id: true, brokerId: true } });
      if (!row || row.brokerId !== session.brokerId) return false;
      await writeDemoState(session.accountId, { t: 0, w: 1 });
      await sweepDemoAccountLocked(session.accountId, now);
      return true;
    }
    if (state.w === 1 && now - state.t >= MIN_GAP_MS) await sweepDemoAccountLocked(session.accountId, now);
    return true;
  } catch (err) {
    // a failing replay must never take the demo down: the cron replays the account later
    console.error("demo-hook: replay failed", session.accountId, err);
    return true;
  }
}
