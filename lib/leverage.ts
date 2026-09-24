// One leverage rule for every route that accepts one (2026-09-25): groups (create / edit), accounts (create / edit)
// and the broker's default account leverage. Before this each route did Math.trunc(Number(x)) > 0 on its own: a
// "1,000,000" typed by an admin was NaN ("must be a positive integer", with no hint that the commas were the
// problem), 1.9 silently became 1, and anything above 2147483647 passed the check and then overflowed the Int column
// (a 500).
//
// Very high leverage is fine for the money math (lib/margin.ts requiredMarginFor is exact Decimal, never rounded, so
// margin stays > 0 and the stop-out still measures a real level). MAX_LEVERAGE is a technical ceiling well below the
// Int column's limit, not a product cap; a broker's own policy (e.g. leverage tiers by equity) would sit on top.
export const MAX_LEVERAGE = 1_000_000_000;
export const LEVERAGE_RULE = `a whole number from 1 to ${MAX_LEVERAGE} (1:500 or 1,000,000 are accepted too)`;

const WESTERN_GROUPING = /^\d{1,3}(,\d{3})+$/;     // 1,000,000
const INDIAN_GROUPING = /^\d{1,2}(,\d{2})*,\d{3}$/; // 10,00,000

/** A leverage from a number or text ("500", "1:500", "1,000,000", "10,00,000"); null when it is not a whole number
 *  from 1 to MAX_LEVERAGE. */
export function parseLeverage(raw: unknown): number | null {
  let n: number;
  if (typeof raw === "number") n = raw;
  else if (typeof raw === "string") {
    let s = raw.trim().replace(/^1\s*:\s*/, "").replace(/\s+/g, "");
    if (WESTERN_GROUPING.test(s) || INDIAN_GROUPING.test(s)) s = s.replace(/,/g, "");
    if (!/^\d+$/.test(s)) return null;
    n = Number(s);
  } else return null;
  return Number.isInteger(n) && n >= 1 && n <= MAX_LEVERAGE ? n : null;
}
