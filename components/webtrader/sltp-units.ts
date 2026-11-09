// The Price / Pips / Amount unit of a stop loss or take profit (owner 2026-11-04). Pure helpers, no React:
//  - Price is exactly what the ticket always did: the typed number is the level.
//  - Pips are a typed distance from the reference price (the price the order will fill at, the position's close side, or a pending
//    order's entry); the CLIENT turns them into a price here, the server only ever sees a price.
//  - Amount is money in the ACCOUNT currency: the position closes when its floating P/L reaches +TP or falls to -SL. The client never turns
//    an amount into a price; the server owns it (lib/amount-sltp.ts) and answers with a refusal the screen shows inline.

export type SlTpUnit = "price" | "pips" | "amount";
export const SLTP_UNITS: { key: SlTpUnit; label: string }[] = [
  { key: "price", label: "Price" },
  { key: "pips", label: "Pips" },
  { key: "amount", label: "Amount" },
];
/**
 * Owner 2026-11-09: setting an amount SL / TP from the screen is switched OFF. The engine does not enforce amount legs yet, so an amount set
 * now would never fire. Non-empty = off: the Amount option is shown disabled with this as its reason, a new or changed amount is refused with
 * it, an unchanged amount is left alone and an emptied one can still be removed. Price and pips are unchanged. Set to "" to switch it back on.
 */
export const AMOUNT_SETTING_OFF: string = "Amount stop loss / take profit is not available yet";
export const AMOUNT_MAX = 1_000_000_000;

/** One pip in price units, the server's rule (lib/group-pricing.ts pipSize): 10^-(digits-1), so 0.0001 on a 5-digit pair, 0.1 on a 2-digit metal. */
export function pipSizeOf(digits: number): number {
  return Math.pow(10, -Math.max(digits - 1, 0));
}

const PLAIN_POSITIVE = /^\d+(\.\d+)?$/;
/** A plain positive decimal (no sign, exponent, hex or separators) as a number, else null. */
export function plainPositive(raw: string): number | null {
  const s = raw.trim();
  if (!PLAIN_POSITIVE.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** The level `pips` away from `ref`: a stop loss sits on the losing side, a take profit on the winning side, whichever the side of the trade. */
export function pipsToPrice(o: { kind: "sl" | "tp"; side: "BUY" | "SELL"; ref: number; pips: number; digits: number }): number {
  const up = (o.kind === "tp") === (o.side === "BUY");
  const raw = o.ref + (up ? 1 : -1) * o.pips * pipSizeOf(o.digits);
  return Number(raw.toFixed(o.digits));
}

/** The text of a typed amount if it is usable, else why not. The server judges the rest (already reached, rate, authority). */
export function amountInputError(raw: string): string | null {
  const n = plainPositive(raw);
  if (n == null) return "Enter an amount above 0";
  if (n > AMOUNT_MAX) return "That amount is too large";
  return null;
}

export type LegWire = { price?: number | null; amount?: string | null };

/** What one leg of a NEW order sends. Empty = no leg (price null, exactly as before). Price and pips send a price, amount sends the amount and no price. */
export function legForOrder(o: { unit: SlTpUnit; raw: string; kind: "sl" | "tp"; side: "BUY" | "SELL"; ref: number; digits: number; amountOff?: string }): { ok: true; wire: LegWire } | { ok: false; error: string } {
  const raw = o.raw.trim();
  // switched off: an amount typed anyway is refused with the reason (`amountOff` is for tests; the screen uses AMOUNT_SETTING_OFF)
  if (o.unit === "amount" && raw !== "" && (o.amountOff ?? AMOUNT_SETTING_OFF) !== "") return { ok: false, error: o.amountOff ?? AMOUNT_SETTING_OFF };
  const label = o.kind === "sl" ? "Stop loss" : "Take profit";
  if (raw === "") return { ok: true, wire: { price: null } };
  if (o.unit === "price") {
    const n = parseFloat(raw);
    return Number.isNaN(n) ? { ok: false, error: `Enter a valid ${label.toLowerCase()} price` } : { ok: true, wire: { price: n } };
  }
  if (o.unit === "pips") {
    const pips = plainPositive(raw);
    if (pips == null) return { ok: false, error: `Enter ${label.toLowerCase()} pips above 0` };
    return { ok: true, wire: { price: pipsToPrice({ kind: o.kind, side: o.side, ref: o.ref, pips, digits: o.digits }) } };
  }
  const bad = amountInputError(raw);
  return bad ? { ok: false, error: bad } : { ok: true, wire: { amount: raw } };
}

/**
 * What one leg of an EXISTING position sends when edited. `existingAmount` is the leg's amount now (null = the leg is not an amount).
 * Price keeps the old behaviour (empty clears the price; a price replaces an amount on the server). Pips and amount leave a leg alone while
 * its field is empty, except an amount field that held an amount and was emptied: that clears it. `keepWhenEmpty` (the net modal, which starts
 * blank for positions that differ) leaves every empty field alone, as that modal always did.
 */
export function legForModify(o: {
  unit: SlTpUnit; raw: string; kind: "sl" | "tp"; side: "BUY" | "SELL"; ref: number; digits: number; existingAmount: string | null; keepWhenEmpty?: boolean; amountOff?: string;
}): { ok: true; wire: LegWire } | { ok: false; error: string } {
  const raw = o.raw.trim();
  if (raw === "") {
    if (o.keepWhenEmpty) return { ok: true, wire: {} };
    if (o.unit === "price") return { ok: true, wire: { price: null } };
    if (o.unit === "amount" && o.existingAmount != null) return { ok: true, wire: { amount: null } };
    return { ok: true, wire: {} };
  }
  // switched off: an amount left exactly as it was is no change, so the other leg can still be edited
  if (o.unit === "amount" && (o.amountOff ?? AMOUNT_SETTING_OFF) !== "" && o.existingAmount != null && Number(raw) === Number(o.existingAmount)) return { ok: true, wire: {} };
  return legForOrder(o);
}

/** Money for a table cell or a label, two decimals, thousands separated. */
export function formatAmount(value: string | number): string {
  const n = typeof value === "number" ? value : parseFloat(value);
  if (!Number.isFinite(n)) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** The server's own sentence for an amount refusal (lib/client-reason.ts keeps `amountCode` and `message`), else null. */
export function amountRefusalText(err: unknown): string | null {
  const body = (err as { body?: unknown } | null)?.body;
  if (!body || typeof body !== "object") return null;
  const b = body as { amountCode?: unknown; message?: unknown; error?: unknown };
  if (typeof b.amountCode !== "string") return null;
  if (typeof b.message === "string" && b.message) return b.message;
  return typeof b.error === "string" && b.error ? b.error : null;
}

/** A bulk answer row ({ ok:false, amountCode, message }) as the same sentence. */
export function amountRowText(row: { amountCode?: unknown; message?: unknown; error?: unknown }): string | null {
  return amountRefusalText({ body: row });
}
