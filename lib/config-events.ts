import "server-only";
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
      const session = await getAdminSession().catch(() => null);
      if (session?.brokerId) await publishConfigChanged(session.brokerId, scope);
    }
    return res;
  };
}
