// Refusal reasons, two of them (owner 2026-10-23). `reason` is the internal code with full detail: it goes to the
// RejectedOrder trace and the backoffice FEED. `clientReason` is what a client is told, exactly one of the eleven below (owner: 9, then TOO_MANY_REQUESTS and CLOSE_PENDING).
// The order, close and modify routes answer a refusal with clientReason (+ a plain sentence) only; the internal text
// never reaches a client (clientRefusal / withClientRefusals below, test: lib/client-reason.test.ts).

export const CLIENT_REASONS = [
  "MARKET_CLOSED",
  "OFF_QUOTES",
  "NOT_ENOUGH_MARGIN",
  "INVALID_PRICE",
  "INVALID_VOLUME",
  "INVALID_SLTP",
  "SYMBOL_NOT_AVAILABLE",
  "TRADING_DISABLED",
  "TOO_MANY_REQUESTS",
  "CLOSE_PENDING",
  "REJECTED",
] as const;
export type ClientReason = (typeof CLIENT_REASONS)[number];

/** The sentence a client shows. Installed terminals that predate clientReason show `error`, so it is plain words too. */
export const CLIENT_REASON_TEXT: Record<ClientReason, string> = {
  // exactly the terminal's wording (T-19, agreed 2026-10-23)
  MARKET_CLOSED: "Market closed",
  OFF_QUOTES: "Off quotes - try again",
  NOT_ENOUGH_MARGIN: "Not enough margin",
  INVALID_PRICE: "Invalid price",
  INVALID_VOLUME: "Invalid volume",
  INVALID_SLTP: "Invalid SL or TP",
  SYMBOL_NOT_AVAILABLE: "Symbol not available",
  TRADING_DISABLED: "Trading disabled",
  TOO_MANY_REQUESTS: "Too many requests - wait a moment",
  CLOSE_PENDING: "Close already with the dealer",
  REJECTED: "Order rejected",
};

type Internal = { error?: unknown; code?: unknown; reason?: unknown };
const str = (v: unknown) => (typeof v === "string" ? v : "");

/** The client reason for an internal refusal. MARKET_CLOSED only for a schedule close (a market that is open by its
 *  schedule but not quoting is OFF_QUOTES); a price that is missing, stale or not quoting, or an LP / feed that is
 *  down, is OFF_QUOTES; anything not recognised is REJECTED. */
export function clientReasonFor(internal: Internal): ClientReason {
  if (str(internal.code) === "ORDER_RATE_LIMITED") return "TOO_MANY_REQUESTS";
  if (str(internal.error) === "CLOSE_PENDING") return "CLOSE_PENDING";
  const error = str(internal.error);
  const code = str(internal.code);
  const sub = str(internal.reason);
  const all = `${error} ${code} ${sub}`;
  const has = (re: RegExp) => re.test(all);

  if (has(/\b(NOT_QUOTING|PRICE_STALE|NO_LIVE_FEED|LP_NOT_CONNECTED|FEED_DOWN|PRICE_SOURCE)\b/) || has(/no live price|live price|feed (is )?down|not quoting/i)) {
    return "OFF_QUOTES";
  }
  if (error === "MARKET_CLOSED" || code === "MARKET_CLOSED") return "MARKET_CLOSED";
  if (has(/\b(INSUFFICIENT_MARGIN|INSUFFICIENT_BALANCE|NO_CONVERSION_RATE)\b/) || has(/margin/i)) return "NOT_ENOUGH_MARGIN";
  if (has(/\b(TRADING_RIGHTS|TRADING_HALTED|CLOSE_ONLY|READ_ONLY|DEMO_B_BOOK_ONLY|SYSTEM_ACCOUNT)\b/) || has(/halted|read.only|close.only|account is not active|account is closed|suspended|trading (is )?disabled|not allowed|BUY_ONLY|SELL_ONLY|only (buy|sell)/i)) {
    return "TRADING_DISABLED";
  }
  if (has(/symbol (not|no longer) (available|enabled)|not available for this broker|SYMBOL_NOT/i)) return "SYMBOL_NOT_AVAILABLE";
  if (has(/\b(SL|TP)\b|stop loss|take profit|stops? level|sl \/ tp|break-even/i)) return "INVALID_SLTP";
  if (has(/\b(INVALID_VOLUME|GROUP_MIN_VOLUME|MIN_VOLUME_STEP)\b/) || has(/volume|\blots?\b|partial close amount/i)) return "INVALID_VOLUME";
  if (has(/\b(SLIPPAGE_EXCEEDED|PRICE_CHANGED)\b/) || has(/price/i)) return "INVALID_PRICE";
  return "REJECTED";
}

// What a refusal answer may keep besides clientReason: the client's own numbers and when to try again. Never the
// internal code, sub-reason, symbol-level feed timing or anything else the route attached.
// `rejected` / `pending` are states a pending-order fill answers with (the order is now rejected / still pending).
const SAFE_EXTRAS = ["nextOpenAt", "retryAfterSeconds", "orderId", "required", "available", "balance", "serverPrice", "rejected", "pending"] as const;

/** A refusal answer cut to what a client may see. CLOSE_PENDING is a state the client acts on (the close awaiting the
 *  dealer, with its order id), not a reason: it keeps its code. */
export function clientRefusal(internal: Record<string, unknown>): Record<string, unknown> {
  // owner 2026-10-23: 11 codes; CLOSE_PENDING keeps its state code + the order id, TOO_MANY_REQUESTS keeps retryAfterSeconds
  if (internal.error === "CLOSE_PENDING") return { error: "CLOSE_PENDING", clientReason: "CLOSE_PENDING" satisfies ClientReason, message: CLIENT_REASON_TEXT.CLOSE_PENDING, orderId: internal.orderId };
  const clientReason = clientReasonFor(internal);
  // the rate limit's own sentence is already plain and says when to try again
  const message = CLIENT_REASON_TEXT[clientReason];
  const out: Record<string, unknown> = {
    // MARKET_CLOSED keeps its code: installed terminals turn it (+ nextOpenAt) into "Market closed, opens ..."
    error: clientReason === "MARKET_CLOSED" ? "MARKET_CLOSED" : message,
    clientReason,
    message,
  };
  for (const k of SAFE_EXTRAS) {
    if (internal[k] === undefined) continue;
    if (k === "nextOpenAt" && clientReason !== "MARKET_CLOSED") continue;
    out[k] = internal[k];
  }
  return out;
}

const REFUSAL_STATUSES = new Set([400, 403, 409, 422, 429]);
// a bulk row keeps its own identity (positionId, symbol...) but never the internal detail
const INTERNAL_KEYS = new Set(["reason", "code", "detail", "lastTickAt", "tradingRights", "nextOpenAt"]);
const withoutInternal = (r: Record<string, unknown>) => Object.fromEntries(Object.entries(r).filter(([k]) => !INTERNAL_KEYS.has(k)));

/** Applies clientRefusal to a route's answer: a refusal body, and every refused row of a bulk answer ({ results: [{
 *  ok: false, error }] }). Anything else passes through untouched. */
export async function withClientRefusals(res: Response): Promise<Response> {
  const isRefusal = REFUSAL_STATUSES.has(res.status);
  if (!isRefusal && res.status !== 200) return res;
  if (!(res.headers.get("content-type") ?? "").includes("application/json")) return res;
  const body = await res.clone().json().catch(() => undefined);
  if (!body || typeof body !== "object") return res;
  let next: unknown = body;
  if (isRefusal && typeof (body as Record<string, unknown>).error === "string") {
    next = clientRefusal(body as Record<string, unknown>);
  } else if (res.status === 200 && Array.isArray((body as Record<string, unknown>).results)) {
    next = {
      ...(body as Record<string, unknown>),
      results: ((body as Record<string, unknown>).results as Record<string, unknown>[]).map((r) =>
        r && r.ok === false && typeof r.error === "string" ? { ...withoutInternal(r), ...clientRefusal(r), ok: false } : r
      ),
    };
  } else {
    return res;
  }
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(next), { status: res.status, headers });
}
