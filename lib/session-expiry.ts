// A client's polls and the session behind them (owner 2026-10-26: an expired demo WebTrader tab kept polling
// /api/trade/orders and /positions every 4 s, every answer a 401). The first 401 on any poll expires the session ONCE:
// the caller shows its login screen, and every poll that checks `expired()` sends nothing more. Any other error is
// a blip: the poll keeps its fallback and tries again next time.

export type SessionExpiry = {
  /** True once a 401 was seen: polls return early instead of sending. */
  expired: () => boolean;
  /** Marks the session gone and runs `onExpire`, the first time only. */
  expire: () => void;
  /** A `.catch` for a poll: on a 401 it expires the session; either way it resolves to `fallback`. */
  onPollError: <T>(fallback: T) => (err: unknown) => T;
};

export const isUnauthorized = (err: unknown): boolean =>
  typeof err === "object" && err !== null && (err as { status?: unknown }).status === 401;

export function createSessionExpiry(onExpire: () => void): SessionExpiry {
  let gone = false;
  const expire = () => {
    if (gone) return;
    gone = true;
    onExpire();
  };
  return {
    expired: () => gone,
    expire,
    onPollError: <T,>(fallback: T) => (err: unknown): T => {
      if (isUnauthorized(err)) expire();
      return fallback;
    },
  };
}
