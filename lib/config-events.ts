import "server-only";
import { invalidateAskRules } from "@/lib/ask-markup-cache";
import { publishTradingEvent } from "@/lib/nats";
import { getAdminSession } from "@/lib/auth";

// Batch 5 (real-time everywhere, docs/audit/2026-09-24/realtime-contract.md): every backoffice write that changes
// broker-wide configuration announces it, so every open terminal, backoffice and web trader re-reads it within ~1 s --
// no restart, no re-login. Best effort (the gateway call is bounded at 2 s and never fails the caller's write).

export type ConfigScope =
  | "symbols" // enable / disable, lots, trading mode, stop level, hedged margin %, max exposure
  | "pricing" // spread markup / target spread, commission, swap -- at any level
  | "sessions" // trading hours
  | "risk" // broker trading halt / close-only / limits / max slippage
  | "groups" // group halt / close-only / leverage / settings
  | "dealing" // desk mode / auto-hedge
  | "mirror"
  | "payments"
  | "permissions"
  | "settings"
  | "kyc";

export async function publishConfigChanged(brokerId: string, scope: ConfigScope, extra?: { symbol?: string; group_id?: string }): Promise<void> {
  await publishTradingEvent("ConfigChanged", { broker_id: brokerId, scope, ...(extra ?? {}) }).catch(() => {});
}

/**
 * Wrap a backoffice route handler: after a successful (2xx) write, publish ConfigChanged for the admin's broker.
 * One place, so no write path can forget it. `export const PATCH = withConfigEvent("symbols", patchHandler)`.
 */
export function withConfigEvent<A extends unknown[]>(scope: ConfigScope, handler: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const res = await handler(...args);
    if (res.status >= 200 && res.status < 300) {
      // lib/ask-markup-cache.ts holds the markup / commission / swap levels for up to ASK_RULE_TTL_MS, and the
      // margin monitor, risk monitor, stop-out, bulk close, book P/L and hedge book all value positions off it.
      // Its contract says a config edit lands at once "via invalidateAskRules() wherever the app handles
      // ConfigChanged" -- this is that place, and before this line nothing called it, so a markup edit could
      // take a full TTL to reach a stop-out decision. Cleared BEFORE the event is published, and in THIS
      // process only: another worker still picks the change up within the TTL (cache-aside, by design).
      invalidateAskRules();
      const session = await getAdminSession().catch(() => null);
      if (session?.brokerId) await publishConfigChanged(session.brokerId, scope);
    }
    return res;
  };
}
