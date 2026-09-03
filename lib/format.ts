// Small formatting helpers shared by the Manager/Super Admin admin
// surfaces.

// AdminUser has no `name` column, so avatar/pill initials are always
// derived from an email or a display string (broker name, etc.).
export function initialsFrom(text: string): string {
  const base = text.includes("@") ? text.split("@")[0] : text;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0][0], parts[1][0]] : [base.slice(0, 2)];
  return letters.join("").toUpperCase().slice(0, 2);
}

// VYX-BASICS-AUDIT.md category 5 -- before this, every backoffice page
// hand-rolled its own `.toFixed(n)` (no thousands separators anywhere:
// "50000.00" not "50,000.00") or its own ad-hoc date slice, each
// slightly different. These don't invent a new convention -- they
// codify whichever one already dominated (see each function's own
// comment) so migrating a page to these is a like-for-like swap, not a
// visible behavior change.

const num = (v: number | string): number => (typeof v === "number" ? v : Number(v));

// A symbol's own digit count (EURUSD=5, XAUUSD=2, USDJPY=3, ...) is
// already threaded through every price-bearing row (`row.digits`) --
// this just centralizes the `.toFixed(digits)` call and thousands-
// separates the integer part, which no existing price display did.
export function formatPrice(value: number | string, digits: number): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(num(value));
}

// Plain thousands-separated number, fixed decimals -- balances,
// volumes, exposure totals. Not "currency" style (Intl's currency
// formatter demands a real ISO 4217 code; Account.currency is a free-
// text field that isn't reliably one) -- callers that need a currency
// label prefix/suffix it themselves, same as WalletsManager.tsx
// already does ("Total balance: {formatNumber(...)}").
export function formatNumber(value: number | string, decimals = 2): string {
  return new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(num(value));
}

// P/L convention already used consistently everywhere it appears
// (`--buy`/`--sell` tokens, explicit +/- sign) -- this just pairs the
// formatted string with the class so callers stop re-deriving the same
// `value >= 0 ? buy : sell` conditional at every call site.
export function formatPnl(value: number | string, decimals = 2): { text: string; toneClass: string } {
  const n = num(value);
  const sign = n >= 0 ? "+" : "";
  return { text: `${sign}${formatNumber(n, decimals)}`, toneClass: n >= 0 ? "text-[var(--buy)]" : "text-[var(--sell)]" };
}

// `signed` defaults true (win-loss velocity, margin-level deltas) --
// pass false for a quantity that's never negative (win rate, fill
// rate) so it doesn't grow a meaningless "+".
export function formatPercent(value: number | string, decimals = 0, signed = true): string {
  const n = num(value);
  const sign = signed && n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(decimals)}%`;
}

// Standardizes on the exact shape ~11 backoffice pages already
// hand-rolled independently (`createdAt.replace("T", " ").slice(0, 19)`
// -- "YYYY-MM-DD HH:MM:SS") since that was already the dominant de
// facto convention, not a new one -- but every one of those omitted
// what timezone that actually is. Prisma DateTime values serialize to
// ISO 8601 UTC, so the truncated string LOOKED like local time while
// actually being UTC -- ambiguous for exactly the audience (dealers,
// compliance) who need to trust a timestamp on an audit trail. Adding
// the explicit " UTC" label is the fix; the format itself is
// unchanged, so every existing display keeps its current shape.
export function formatDateTime(value: string | Date): string {
  const iso = typeof value === "string" ? value : value.toISOString();
  return `${iso.replace("T", " ").slice(0, 19)} UTC`;
}
