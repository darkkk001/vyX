// Plain error messages (step 2 "foundations", owner rule 2026-10-06): brokers and traders never see infrastructure.
// No engine / gateway / NATS / Neon / database / Caddy / MT5 names, no timeouts or "ms" latencies, no HTTP codes, no
// endpoint paths, no internal ids, no raw exception text, no machine codes (LP_NOT_CONNECTED...). Every web surface a
// broker or trader reads (WebTrader toasts, manage pages, portal forms, notification bodies) turns an error into text
// through plainError() below; the raw text goes to the console / server log only.
//
// What it does, in order:
//   1. a known machine code (from body.code, or an error that IS a code) -> its sentence;
//   2. one of the 13 server strings from the infra-leak sweep (docs: batch-review, report section 4) -> its sentence;
//   3. any other text that carries an infrastructure marker -> the caller's fallback (a plain sentence);
//   4. anything else is an app-written sentence already meant for people: shown, first letter capitalised.
// Pure TypeScript (no server-only imports): used by client components and server code alike.

export type Audience = "client" | "staff";

export const GENERIC_ERROR = "Could not complete the request. Try again.";

export const PLAIN = {
  pricesUnavailable: "Live prices unavailable.",
  pricesInterrupted: "Live prices interrupted.",
  couldNotLoad: "Could not load. Try again.",
  noAnswer: "The server did not answer in time. Try again.",
  unreachable: "Could not reach the server. Check your connection.",
  tradingBrief: "Trading is briefly unavailable. Try again in a moment.",
  notProcessed: "Could not be processed.",
  emailNotSent: "The e-mail could not be sent. Try again later.",
} as const;

type Ctx = { text: string; body: Record<string, unknown> | null; audience: Audience };

function bodyStr(body: Record<string, unknown> | null, key: string): string | null {
  const v = body?.[key];
  return typeof v === "string" || typeof v === "number" ? String(v) : null;
}

/** "0.50" out of "The smallest trade allowed for this account is 0.50 lots." (or body.minVolume). */
function lotsIn(ctx: Ctx): string | null {
  return bodyStr(ctx.body, "minVolume") ?? bodyStr(ctx.body, "minLot") ?? ctx.text.match(/(\d+(?:\.\d+)?)\s*lots?/i)?.[1] ?? null;
}

/** Machine code -> sentence. A function gets the context (amounts, symbols, audience). */
const CODES: Record<string, string | ((c: Ctx) => string)> = {
  LP_NOT_CONNECTED: (c) =>
    c.audience === "staff" ? "Not filled: the liquidity provider is disconnected." : "Orders can't be placed on this account right now. Contact your broker.",
  SYSTEM_ACCOUNT: (c) => (c.audience === "staff" ? "This is the coverage account: client orders can't be placed on it." : "Orders can't be placed on this account."),
  INSUFFICIENT_MARGIN: (c) => {
    const req = bodyStr(c.body, "required");
    const avail = bodyStr(c.body, "available");
    return req && avail ? `Not enough free margin: this order needs ${req}, ${avail} is free.` : "Not enough free margin for this order.";
  },
  INSUFFICIENT_FREE_MARGIN: "Not enough free margin for this order.",
  INSUFFICIENT_BALANCE: (c) => {
    const req = bodyStr(c.body, "required");
    const bal = bodyStr(c.body, "balance");
    return req && bal ? `Not enough balance: this order needs ${req}, the balance is ${bal}.` : "Not enough balance for this order.";
  },
  NO_CONVERSION_RATE: "No conversion rate for this currency right now. Try again in a moment.",
  NO_LIVE_FEED: "No live price for this symbol right now. Try again shortly.",
  PRICE_STALE: "The price is out of date. Order not placed, try again.",
  SLIPPAGE_EXCEEDED: "The price moved. Order not placed.",
  MARKET_CLOSED: "The market is closed for this symbol.",
  BALANCE_BELOW_ZERO: "This would take the balance below zero.",
  // KYC_REQUIRED: no mapping on purpose; the server sentence ("KYC not verified") is shown as written (hotfix 2026-10-06)
  RATE_LIMITED: "Too many requests. Wait a moment and try again.",
  FORBIDDEN: "You don't have access to this.",
  UNAUTHORIZED: "Your session has ended. Sign in again.",
  CLOSE_PENDING: "A close for this position is already in progress.",
  // step 1 (2026-10-06): group minimum volume, and a group minimum that does not fit a symbol's volume grid
  GROUP_MIN_VOLUME: (c) => {
    const lots = lotsIn(c);
    if (c.audience === "staff") return lots ? `Below this group's minimum volume (${lots} lots).` : "Below this group's minimum volume.";
    return lots ? `The smallest trade allowed for this account is ${lots} lots.` : "This volume is below the smallest trade allowed for this account.";
  },
  MIN_VOLUME_STEP: (c) => {
    const syms = Array.isArray(c.body?.symbols) ? (c.body!.symbols as unknown[]).map(String).filter(Boolean) : [];
    return syms.length ? `This minimum does not fit the volume steps of ${syms.join(", ")}.` : "This minimum does not fit every symbol's volume steps.";
  },
};

/** Install refusals (BUILD_RETIRED, BUILD_UNKNOWN...): owner D4, no actor. */
const BUILD_TEXT: Record<string, string> = {
  BUILD_RETIRED: "This installation has been retired. Install the latest version.",
  BUILD_WRONG_TENANT: "This installation is not issued for this server.",
  BUILD_UNKNOWN: "This installation is not registered. Install an official build.",
  BUILD_MISSING: "This installation is not registered. Install an official build.",
};

/** The 13 server strings of the infra-leak sweep, matched on the raw text. Order matters: first match wins. */
const PATTERNS: [RegExp, string | ((c: Ctx) => string)][] = [
  // 1. lib/market-data-client.ts "timeout after 2000 ms"
  [/^timeout after \d+\s*ms/i, PLAIN.pricesUnavailable],
  // 9. lib/price-feed.ts "price feed not configured"
  [/price feed not configured/i, PLAIN.pricesUnavailable],
  // 7. ops-only price-source reasons (lib/market-data-client.ts, lib/live-price.ts)
  [/market data url|read secret not configured|malformed answer|engine unreadable|not on the vps price source|engine book gate/i, PLAIN.pricesUnavailable],
  // 6. price stream drops
  [/connection dropped after|server closed the stream/i, PLAIN.pricesInterrupted],
  // 8. app/api/trade/orders "trading is temporarily unavailable (the database is being updated)"
  [/trading is temporarily unavailable/i, PLAIN.tradingBrief],
  // 12. lib/email/adapter.ts "Resend send failed (502): ..."
  [/resend send failed/i, PLAIN.emailNotSent],
  // 3 + 13. lib/desktop-api.ts "request to /api/... failed (502)", endpoint paths
  [/^request to \S+ failed/i, PLAIN.couldNotLoad],
  // 4. "request timed out"
  [/request timed out|timed out|ETIMEDOUT/i, PLAIN.noAnswer],
  // 5. "network error: ...", browser fetch failures, socket errors
  [/^network error|failed to fetch|fetch failed|networkerror|load failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN/i, PLAIN.unreachable],
  // 2. "HTTP 502", "request failed (502)"
  [/^HTTP \d{3}|request failed \(\d{3}\)/i, PLAIN.couldNotLoad],
  // 10. dealing-desk-toggle "internal error" (and "internal server error")
  [/^internal (server )?error\.?$/i, PLAIN.notProcessed],
];

/** Anything carrying one of these is not shown: it is machine / infrastructure text. */
const INFRA =
  /\b(engine|nats|neon|caddy|gateway|prisma|postgres(ql)?|database|redis|vercel|mt5|upstream|endpoint|socket|stack|ECONN\w*|typeerror|referenceerror|syntaxerror|rangeerror|unexpected token|json|undefined|nan|localhost|constraint|invocation|deadlock)\b|`|\bDB\b|\b\d+\s?ms\b|\bHTTP\b|\([45]\d{2}\)|\/api\/|\bstatus code\b|\bP\d{4}\b|\bc[a-z0-9]{20,}\b|\bat \S+ \(\S+:\d+:\d+\)|[{}<>]|\binternal (server )?error\b/i;

const CODE_ONLY = /^[A-Z][A-Z0-9_]{2,}$/;
const CODE_PREFIX = /^([A-Z][A-Z0-9_]{2,}):\s*/;

/** True when the text is safe to show as it is (no machine code, no infrastructure marker). */
export function isPlainText(text: string): boolean {
  const t = text.trim();
  return t.length > 0 && !CODE_ONLY.test(t) && !CODE_PREFIX.test(t) && !INFRA.test(t);
}

function capitalise(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** Pulls the text, body and HTTP status out of whatever was thrown / returned. */
function extract(input: unknown): { text: string; body: Record<string, unknown> | null; status: number | null } {
  if (input == null) return { text: "", body: null, status: null };
  if (typeof input === "string") return { text: input, body: null, status: null };
  if (typeof input === "object") {
    const o = input as Record<string, unknown>;
    const status = typeof o.status === "number" ? o.status : null;
    // lib/desktop-api.ts ApiError: message + status + parsed body
    if (input instanceof Error) {
      const body = o.body && typeof o.body === "object" ? (o.body as Record<string, unknown>) : null;
      return { text: input.message ?? "", body, status };
    }
    // a parsed JSON error body { error, code, ... }
    if (typeof o.error === "string" || typeof o.code === "string") return { text: typeof o.error === "string" ? o.error : "", body: o, status };
    if (typeof o.message === "string") return { text: o.message, body: o, status };
  }
  return { text: String(input), body: null, status: null };
}

function byStatus(status: number | null): string | null {
  if (status === 401) return CODES.UNAUTHORIZED as string;
  if (status === 403) return CODES.FORBIDDEN as string;
  if (status === 429) return CODES.RATE_LIMITED as string;
  return null;
}

/**
 * The sentence to show for an error. `input` is anything: an ApiError / Error, a raw string, a parsed `{ error, code }`
 * body, or nothing. `fallback` is shown when the error carries nothing showable (default GENERIC_ERROR). The raw text
 * is logged (console) whenever it is not shown as it is.
 */
export function plainError(input: unknown, fallback: string = GENERIC_ERROR, opts?: { audience?: Audience }): string {
  const { text, body, status } = extract(input);
  const ctx: Ctx = { text: text ?? "", body, audience: opts?.audience ?? "client" };
  const out = resolve(ctx, status, fallback);
  if (text && out !== capitalise(text)) console.warn("[plain-error] shown as plain text:", JSON.stringify(out), "raw:", text, body ?? "");
  return out;
}

function resolve(ctx: Ctx, status: number | null, fallback: string): string {
  const raw = ctx.text.trim();
  // 1. machine codes: body.code, the whole text, or a "CODE: sentence" prefix
  const prefixed = raw.match(CODE_PREFIX)?.[1] ?? null;
  const code = bodyStr(ctx.body, "code") ?? (CODE_ONLY.test(raw) ? raw : null) ?? prefixed;
  if (code) {
    if (BUILD_TEXT[code]) return BUILD_TEXT[code];
    if (code.startsWith("BUILD_")) return BUILD_TEXT.BUILD_UNKNOWN;
    const known = CODES[code];
    if (known) return typeof known === "function" ? known(ctx) : known;
  }
  // a bare 401 / 403 / 429 (no sentence of its own): its own plain sentence
  const statusText = byStatus(status);
  if (statusText && (!raw || !isPlainText(raw) || /^(request|could not complete|could not load)/i.test(raw))) return statusText;
  // 2. the known server strings
  for (const [re, plain] of PATTERNS) if (re.test(raw)) return typeof plain === "function" ? plain(ctx) : plain;
  // a "CODE: sentence" with an unknown code: the sentence part, if it is plain
  const sentence = prefixed ? raw.slice(raw.indexOf(":") + 1).trim() : raw;
  // 3. machine / infrastructure text, or nothing at all
  if (!sentence || CODE_ONLY.test(sentence) || INFRA.test(sentence)) return byStatus(status) ?? fallback;
  // 4. an app-written sentence
  return capitalise(sentence);
}

/** For server routes: the plain sentence for a caught exception (the raw error goes to the server log). */
export function plainReason(err: unknown, fallback: string = PLAIN.notProcessed): string {
  return plainError(err instanceof Error || typeof err === "string" ? err : String(err), fallback, { audience: "staff" });
}

// ---- Order / close / modify / cancel paths (hotfix 2026-10-08) ----
// "Could not load. Try again." is the generic fallback for a failed READ. On a trade action it told the trader nothing
// (live: eleven refused orders, one sentence). Every trade action goes through tradeActionError() instead, which says one
// of exactly three things: prices are the problem, the server is the problem, or the order was refused and why.

export const TRADE_TEXT = {
  prices: "Prices unavailable, try again",
  server: "Server error, try again",
  rejectedPrefix: "Order rejected: ",
} as const;

const PRICE_CODES = new Set(["NO_LIVE_FEED", "PRICE_STALE", "NO_CONVERSION_RATE", "NO_PRICE", "PRICE_UNAVAILABLE"]);
const NETWORK_TEXT = /^network error|failed to fetch|fetch failed|networkerror|load failed|ECONN\w+|ENOTFOUND|EAI_AGAIN|timed out|ETIMEDOUT|request to \S+ failed|could not reach the server|did not answer in time|could not complete the request|could not load|trading is temporarily unavailable|trading is briefly unavailable/i;
const PRICE_TEXT = /no live feed|live prices? (are )?(unavailable|interrupted)|no live price|price (is )?(out of date|unavailable|stale)|prices? (is |are )?(stale|unavailable)|price feed/i;

/** Full detail of a failed trade request, for the console / log (never shown to the trader). */
export function tradeErrorDetail(input: unknown): { status: number | null; code: string | null; message: string; requestId: string | null } {
  const { text, body, status } = extract(input);
  const o = input && typeof input === "object" ? (input as Record<string, unknown>) : null;
  const reqId = bodyStr(body, "requestId") ?? bodyStr(body, "request_id") ?? (o ? bodyStr(o, "requestId") : null);
  return { status, code: bodyStr(body, "code") ?? (CODE_ONLY.test(text.trim()) ? text.trim() : null), message: text, requestId: reqId };
}

/**
 * The sentence for a failed order / close / partial close / close-by / modify / cancel. One of:
 *  - "Prices unavailable, try again": no or stale price;
 *  - "Order rejected: <reason>": a business refusal (margin, volume, trading rights, market closed, slippage...), the
 *    reason taken from the server's code or sentence through plainError();
 *  - "Server error, try again": a 5xx, a dropped connection, a timeout, or anything without a usable reason.
 * The status, code, raw message and request id go to the console.
 */
export function tradeActionError(input: unknown, opts?: { audience?: Audience }): string {
  const detail = tradeErrorDetail(input);
  const { status, code, message } = detail;
  const raw = message.trim();
  console.error("[trade-error]", JSON.stringify(detail));
  if ((code && PRICE_CODES.has(code)) || PRICE_TEXT.test(raw)) return TRADE_TEXT.prices;
  if (status === 401) return plainError(input, TRADE_TEXT.server, opts); // a signed-out session is not a refused order
  const refused = status !== null && status >= 400 && status < 500;
  if (!refused || NETWORK_TEXT.test(raw)) return TRADE_TEXT.server;
  const reason = plainError(input, "", opts).replace(/[.\s]+$/, "");
  if (!reason || /^(could not load|could not complete the request|could not be processed)/i.test(reason)) return TRADE_TEXT.server;
  return TRADE_TEXT.rejectedPrefix + reason;
}
