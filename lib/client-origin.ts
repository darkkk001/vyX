import { AsyncLocalStorage } from "node:async_hooks";

// Order sounds by origin (owner 2026-11-13, option C).
//
// Every trading client (one native terminal process, one WebTrader tab) makes a random id when it starts and sends it on each trade request
// in the `x-client-instance` header. A trader route enters that id for the rest of the request (enterClientOrigin), and publishTradingEvent
// stamps it on every event the request publishes, also the ones published after the response (runAfterResponse starts its task inside the
// request's async context) and the ones buffered for the post-close outbox. A client plays a trade sound only for an event whose
// `origin_client_id` is its own (or from its own request's answer); every other device signed into the account stays silent.
//
// The events no device caused (an SL / TP hit, a stop-out, a pending order triggering or expiring, a dealer requote / fill) carry the id the
// rows stored when a client set them: Position.slTpClientInstance, Position.openClientInstance, Order.clientInstance. Null = silent.

export const CLIENT_ORIGIN_HEADER = "x-client-instance";
export const CLIENT_ORIGIN_FIELD = "origin_client_id";

const store = new AsyncLocalStorage<string>();

/** The header's id when it is a plausible client id (8 to 64 of [A-Za-z0-9_-]); anything else is ignored (no origin, silent). */
export function parseClientOrigin(value: string | null | undefined): string | null {
  const v = (value ?? "").trim();
  return /^[A-Za-z0-9_-]{8,64}$/.test(v) ? v : null;
}

/** Enter the request's client id for the rest of this request's async chain (call first thing in a trader route). Returns it. */
export function enterClientOrigin(headers: Headers): string | null {
  const id = parseClientOrigin(headers.get(CLIENT_ORIGIN_HEADER));
  store.enterWith(id ?? "");
  return id;
}

/** The client id of the request in progress, or null (a cron, a staff route, the price hook, a request without the header). */
export function currentClientOrigin(): string | null {
  const v = store.getStore();
  return v ? v : null;
}

/** Run `fn` with `id` as the current client id (tests, and code that publishes for a row it read the id from). */
export function withClientOrigin<T>(id: string | null, fn: () => T): T {
  return store.run(id ?? "", fn);
}

/** The event payload with the origin field: an explicit one wins, else the current request's, else none (silent everywhere). */
export function stampOrigin<P extends Record<string, unknown>>(payload: P): P {
  if (Object.prototype.hasOwnProperty.call(payload, CLIENT_ORIGIN_FIELD)) return payload;
  const id = currentClientOrigin();
  return id ? { ...payload, [CLIENT_ORIGIN_FIELD]: id } : payload;
}
