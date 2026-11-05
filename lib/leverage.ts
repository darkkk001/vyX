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

// ---- B1: an account's leverage never exceeds its group's (owner 2026-11-06) ----
// ONE helper for every write path that sets an account's leverage: staff PATCH accounts/[id], account creation
// (lib/account-provisioning.ts: staff, portal, Room, live-account approval, hedge account), group change, group
// apply-leverage, Trader's Room / CRM leverage requests, the trader's own change (POST /api/trade/leverage) and the demo
// sign-up. A value above the maximum is refused with 400 LEVERAGE_ABOVE_GROUP_MAX, never clamped silently.
export const LEVERAGE_ABOVE_GROUP_MAX = "LEVERAGE_ABOVE_GROUP_MAX";

export function leverageAboveGroupMessage(leverage: number, groupMax: number): string {
  return `leverage 1:${leverage} is above the group's maximum 1:${groupMax}`;
}

/** null = within the group's maximum; otherwise the refusal ({ error, code }, HTTP 400). */
export function checkLeverageWithinGroup(leverage: number, groupMax: number | null | undefined): { error: string; code: typeof LEVERAGE_ABOVE_GROUP_MAX } | null {
  if (groupMax == null) return null; // an account without a group has no ceiling to hold (Account.groupId is NOT NULL, so this is defensive)
  if (leverage <= groupMax) return null;
  return { error: leverageAboveGroupMessage(leverage, groupMax), code: LEVERAGE_ABOVE_GROUP_MAX };
}

/** Thrown by non-route code (provisioning, the Room change) so the route can turn it into the same 400. */
export class LeverageAboveGroupMaxError extends Error {
  readonly code = LEVERAGE_ABOVE_GROUP_MAX;
  constructor(leverage: number, groupMax: number) {
    super(leverageAboveGroupMessage(leverage, groupMax));
    this.name = "LeverageAboveGroupMaxError";
  }
}

/** Throws LeverageAboveGroupMaxError when `leverage` is above `groupMax`. */
export function assertLeverageWithinGroup(leverage: number, groupMax: number | null | undefined): void {
  if (checkLeverageWithinGroup(leverage, groupMax)) throw new LeverageAboveGroupMaxError(leverage, groupMax as number);
}

// ---- B2: the trader's own change (owner 2026-11-06) ----
// The steps a trader may pick on a flexible-leverage group: this ladder, cut at the group's maximum (the maximum itself is
// always offered, so a 1:300 group shows 1:300 on top). The terminal draws its list from GET /api/trade/leverage, never
// from its own copy.
export const LEVERAGE_STEPS = [1, 2, 5, 10, 20, 25, 30, 50, 100, 200, 300, 400, 500, 1000, 2000, 3000] as const;

export function allowedLeverageSteps(groupMax: number): number[] {
  const steps = LEVERAGE_STEPS.filter((s) => s <= groupMax) as number[];
  if (!steps.includes(groupMax) && groupMax >= 1) steps.push(groupMax);
  return steps.sort((a, b) => a - b);
}

export const FLEXIBLE_LEVERAGE_OFF = "FLEXIBLE_LEVERAGE_OFF";
export const MIN_TRADES_NOT_MET = "MIN_TRADES_NOT_MET";
export const LEVERAGE_INVALID = "LEVERAGE_INVALID";
export const LEVERAGE_MARGIN = "LEVERAGE_MARGIN";

export const FLEXIBLE_LEVERAGE_OFF_TEXT = "Leverage changes are not available on this account.";
export function minTradesText(done: number, needed: number): string {
  return `${done} of ${needed} trades done`;
}
export function leverageMarginText(to: number): string {
  return `open positions need more margin at 1:${to}`;
}
