// Small formatting helpers shared by the Manager/Super Admin admin
// surfaces, and (step 2 "foundations", 2026-10-06) THE shared number
// formatter of the web app: manage tables, CSV exports, statements and
// WebTrader all go through the functions below. The rules are the owner's
// "Number rules" and "Empty and zero values" in
// docs/audit/2026-09-24/naming.md:
//   - never "-0.00": a value that rounds to zero is 0.00, with no sign;
//   - signed values carry "+" or "−" (U+2212, the real minus sign);
//   - colour: profit / loss / neutral (zero);
//   - volume always 2 decimals, prices in the symbol's own digits, money
//     2 decimals with thousands separators;
//   - whose view: backoffice/manager = broker view (commission and swap
//     revenue +, withdrawals −), terminal/WebTrader/client statement =
//     client view (commission and swap charges −);
//   - no dash placeholder ever: zero money is 0.00, a value that does not
//     exist is "" (an empty cell); margin level without positions is "".

// AdminUser has no `name` column, so avatar/pill initials are always
// derived from an email or a display string (broker name, etc.).
export function initialsFrom(text: string): string {
  const base = text.includes("@") ? text.split("@")[0] : text;
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length >= 2 ? [parts[0][0], parts[1][0]] : [base.slice(0, 2)];
  return letters.join("").toUpperCase().slice(0, 2);
}

/** U+2212 MINUS SIGN: every negative number on screen uses it, never the ASCII hyphen. */
export const MINUS = "−";

export type NumLike = number | string | { toString(): string } | null | undefined;

/** The number, or null when there is none (null, undefined, "", NaN, Infinity). Accepts Prisma Decimals. */
export function toNum(v: NumLike): number | null {
  if (v == null) return null;
  if (typeof v === "string" && v.trim() === "") return null;
  const n = typeof v === "number" ? v : Number(typeof v === "string" ? v : v.toString());
  return Number.isFinite(n) ? n : null;
}

/** Rounded to `decimals`, with negative zero (and anything that rounds to zero) folded into +0. */
export function roundClean(n: number, decimals: number): number {
  const f = 10 ** decimals;
  // EPSILON nudge so 1.005 rounds the way a person expects (1.01), not the binary way (1.00)
  const r = Math.round((Math.abs(n) * f) * (1 + Number.EPSILON)) / f;
  const signed = n < 0 ? -r : r;
  return signed === 0 ? 0 : signed;
}

// VYX-BASICS-AUDIT.md category 8 -- `new Intl.NumberFormat(...)` is a
// genuinely expensive constructor (locale data lookup + options
// parsing), so one instance per decimals count is built once and reused
// (measured live: a fresh one per cell produced 140ms+ long tasks on a
// 552-row Positions table). Table sizes only ever use a handful of
// distinct digit counts, so this cache never grows unbounded.
const numberFormatCache = new Map<string, Intl.NumberFormat>();
function getNumberFormat(decimals: number, grouping: boolean): Intl.NumberFormat {
  const key = `${decimals}:${grouping ? 1 : 0}`;
  let fmt = numberFormatCache.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouping });
    numberFormatCache.set(key, fmt);
  }
  return fmt;
}

/** Unsigned magnitude text: thousands separators (unless `grouping` is false), fixed decimals. */
function magnitude(n: number, decimals: number, grouping = true): string {
  return getNumberFormat(decimals, grouping).format(Math.abs(n));
}

/**
 * Plain number, fixed decimals, thousands separators: balances, exposure totals. Negative values get "−", zero
 * (including -0 and anything that rounds to zero) is unsigned. No value = "". Not "currency" style: Account.currency
 * is free text, so callers add the currency label themselves.
 */
export function formatNumber(value: NumLike, decimals = 2): string {
  const n = toNum(value);
  if (n == null) return "";
  const r = roundClean(n, decimals);
  return `${r < 0 ? MINUS : ""}${magnitude(r, decimals)}`;
}

/** Money: 2 decimals (or the field's own), thousands separators. Zero money is 0.00; no value is "". */
export function formatMoney(value: NumLike, decimals = 2): string {
  return formatNumber(value, decimals);
}

/** Signed amount: "+1,234.50", "−12.00", "0.00" (zero never carries a sign). No value = "". */
export function formatSigned(value: NumLike, decimals = 2): string {
  const n = toNum(value);
  if (n == null) return "";
  const r = roundClean(n, decimals);
  return `${r > 0 ? "+" : r < 0 ? MINUS : ""}${magnitude(r, decimals)}`;
}

export type Tone = "profit" | "loss" | "neutral";

/** profit / loss / neutral, judged on the value AS SHOWN (rounded), so a -0.001 is neutral like the 0.00 it shows. */
export function tone(value: NumLike, decimals = 2): Tone {
  const n = toNum(value);
  if (n == null) return "neutral";
  const r = roundClean(n, decimals);
  return r > 0 ? "profit" : r < 0 ? "loss" : "neutral";
}

/** Tailwind colour class per tone (manage pages; the `--buy` / `--sell` tokens are the app's green / red). */
export const TONE_CLASS: Record<Tone, string> = { profit: "text-[var(--buy)]", loss: "text-[var(--sell)]", neutral: "" };
/** CSS colour value per tone (inline styles in WebTrader). */
export const TONE_COLOR: Record<Tone, string> = { profit: "var(--buy)", loss: "var(--sell)", neutral: "var(--text-1)" };

/** Signed P/L text plus its colour class (manage tables). */
export function formatPnl(value: NumLike, decimals = 2): { text: string; toneClass: string; tone: Tone } {
  const t = tone(value, decimals);
  return { text: formatSigned(value, decimals), toneClass: TONE_CLASS[t], tone: t };
}

/** Volume in lots: always 2 decimals ("1.00", "0.50", "0.02"), never signed. No value = "". */
export function formatVolume(value: NumLike): string {
  const n = toNum(value);
  if (n == null) return "";
  return magnitude(roundClean(n, 2), 2);
}

/** A price in the symbol's own digits (XAUUSD 2, EURUSD 5, USDJPY 3), thousands separated. No price = "". */
export function formatPrice(value: NumLike, digits: number): string {
  return formatNumber(value, digits);
}

/**
 * Percent. `signed` (default true) for deltas; pass false for a quantity that is never negative (win rate, fill
 * rate). Zero never carries a sign; no value = "".
 */
export function formatPercent(value: NumLike, decimals = 0, signed = true): string {
  const text = signed ? formatSigned(value, decimals) : formatNumber(value, decimals);
  return text === "" ? "" : `${text}%`;
}

/**
 * Margin level (%). Without open positions (no used margin) it does not exist: "" (never "0%", which reads as a
 * stop-out). `level` may already be null/Infinity for that case.
 */
export function formatMarginLevel(level: NumLike, hasPositions = true, decimals = 0): string {
  if (!hasPositions) return "";
  const n = toNum(level);
  if (n == null) return "";
  return `${formatNumber(n, decimals)}%`;
}

// ---- whose view ----

/** Backoffice / manager pages show the broker's view; WebTrader, the terminal and client statements the client's. */
export type View = "broker" | "client";

/**
 * The amount as the given view sees it, from the value as STORED:
 *   - commission: stored as the positive charge the client paid (broker revenue) -> broker +, client −;
 *   - swap: stored client-signed (added to the client's balance) -> client as stored, broker the opposite;
 *   - profit: stored client-signed -> client as stored, broker the opposite (the broker's side);
 *   - deposit / withdrawal: a deposit is always +, a withdrawal always −, in both views.
 */
export function viewAmount(kind: "commission" | "swap" | "profit" | "deposit" | "withdrawal", stored: NumLike, view: View): number | null {
  const n = toNum(stored);
  if (n == null) return null;
  let v: number;
  switch (kind) {
    case "commission":
      v = view === "broker" ? n : -n;
      break;
    case "swap":
    case "profit":
      v = view === "client" ? n : -n;
      break;
    case "deposit":
      v = Math.abs(n);
      break;
    case "withdrawal":
      v = -Math.abs(n);
      break;
  }
  return v === 0 ? 0 : v;
}

// ---- CSV ----

/**
 * A number for a CSV cell. Same rules as the screen (never -0.00, fixed decimals, "" when there is no value) but kept
 * machine-readable so a spreadsheet can sum the column: ASCII "-" for negatives, no "+", no thousands separators.
 * (A "−" or "1,234.50" turns the cell into text in Excel / Sheets.) lib/csv.ts lets these through without the
 * formula-injection quote, since a plain number cannot be a formula.
 */
export function formatCsvNumber(value: NumLike, decimals = 2): string {
  const n = toNum(value);
  if (n == null) return "";
  const r = roundClean(n, decimals);
  return `${r < 0 ? "-" : ""}${magnitude(r, decimals, false)}`;
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
