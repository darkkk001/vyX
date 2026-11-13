import { Prisma } from "@prisma/client";
import { computeRealizedPnl } from "@/lib/trading";
import { riskOwnerOf } from "@/lib/risk-authority";

// Amount-based take profit / stop loss (owner 2026-11-04, native release). Beside the price SL / TP, a trader may set either leg as an
// AMOUNT in the account currency: the position closes when its floating P/L reaches +tpAmount, or falls to -slAmount, whatever the exact
// price. A leg is a price OR an amount, never both. The floating P/L is the same gross figure every SL / TP check and the terminal already
// use (lib/risk-monitor.ts measureAccount, lib/fx-client.ts pnlInAccount): (close - open) x contract size x lots x quote->account rate, no
// swap or commission. Amounts are stored to the cent (Decimal(18,2)).

export const AMOUNT_MAX = new Prisma.Decimal("1000000000");

export type AmountParse = { ok: true; value: Prisma.Decimal | null | undefined } | { ok: false; error: string };

/** One amount field from a request body: undefined = not sent (leave as is), null / "" = clear, else a positive finite number of at most
 *  1,000,000,000 rounded to the cent. Hostile input (NaN, Infinity, hex, exponents beyond the cap) is refused, never stored. */
export function parseAmount(raw: unknown, leg: "SL" | "TP", opts: { emptyRefused?: boolean } = {}): AmountParse {
  if (raw === undefined) return { ok: true, value: undefined };
  // 2026-11-10 (amount SL / TP re-enable): on the client arming route an empty string is refused, not read as "remove":
  // a terminal that sent "" would show the leg as set while nothing was armed. null is the one way to remove an amount.
  if (raw === "" && opts.emptyRefused) return { ok: false, error: `${leg} amount is empty: send a number above 0, or null to remove it` };
  if (raw === null || raw === "") return { ok: true, value: null };
  if (typeof raw !== "number" && typeof raw !== "string") return { ok: false, error: `${leg} amount must be a number` };
  const s = String(raw).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return { ok: false, error: `${leg} amount must be a positive number` };
  const d = new Prisma.Decimal(s).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (!d.isFinite() || d.lte(0)) return { ok: false, error: `${leg} amount must be above 0` };
  if (d.gt(AMOUNT_MAX)) return { ok: false, error: `${leg} amount is too large` };
  return { ok: true, value: d };
}

/** A leg set both ways in one request is refused: one unit per leg. */
export function bothUnitsError(price: unknown, amount: unknown, leg: "SL" | "TP"): string | null {
  const set = (v: unknown) => v !== undefined && v !== null && v !== "";
  return set(price) && set(amount) ? `${leg}: set a price or an amount, not both` : null;
}

export type AmountPosition = {
  side: "BUY" | "SELL";
  openPrice: Prisma.Decimal;
  volume: Prisma.Decimal;
  contractSize: Prisma.Decimal;
  slAmount: Prisma.Decimal | null;
  tpAmount: Prisma.Decimal | null;
};

/** The floating P/L in the account currency at a close price (gross, like every SL / TP check). */
export function floatingPnlAt(p: Pick<AmountPosition, "side" | "openPrice" | "volume" | "contractSize">, closePrice: Prisma.Decimal, fxRate: Prisma.Decimal): Prisma.Decimal {
  return computeRealizedPnl({ side: p.side, openPrice: p.openPrice, closePrice, volume: p.volume, contractSize: p.contractSize }).mul(fxRate);
}

/** Which amount leg the floating P/L has reached (SL first, like the price check): P/L <= -slAmount, or P/L >= +tpAmount. */
export function amountTrigger(p: AmountPosition, closePrice: Prisma.Decimal, fxRate: Prisma.Decimal): "stop_loss" | "take_profit" | null {
  if (p.slAmount == null && p.tpAmount == null) return null;
  const pnl = floatingPnlAt(p, closePrice, fxRate);
  if (p.slAmount != null && pnl.lte(p.slAmount.neg())) return "stop_loss";
  if (p.tpAmount != null && pnl.gte(p.tpAmount)) return "take_profit";
  return null;
}

/** Refuse an amount the position has already reached at the current close-side price (it would close at once): the amount counterpart of
 *  validateSlTp's wrong-side check. For a new market order this is the opening P/L, i.e. the spread cost: an SL amount inside it is refused. */
export function amountsReachedError(p: AmountPosition, closePrice: Prisma.Decimal, fxRate: Prisma.Decimal, currency: string): string | null {
  const pnl = floatingPnlAt(p, closePrice, fxRate);
  const fmt = (d: Prisma.Decimal) => `${d.toFixed(2)} ${currency}`;
  if (p.slAmount != null && pnl.lte(p.slAmount.neg())) return `SL amount ${fmt(p.slAmount)} is already reached (P/L ${fmt(pnl)}): it would close at once`;
  if (p.tpAmount != null && pnl.gte(p.tpAmount)) return `TP amount ${fmt(p.tpAmount)} is already reached (P/L ${fmt(pnl)}): it would close at once`;
  return null;
}

// ---- request handling shared by every write route ----

/** The refusal an amount write gets while the engine does not watch amounts yet (RUST-authority accounts). */
export const AMOUNT_NOT_AVAILABLE_CODE = "AMOUNT_SLTP_NOT_AVAILABLE";
export const AMOUNT_NOT_AVAILABLE_TEXT = "Amount take profit / stop loss is not available for this account yet";
export const AMOUNT_NO_RATE_TEXT = "No exchange rate to your account currency right now, try again";

/** The refusal codes an amount write can get. A client refusal keeps its clientReason (INVALID_SLTP) and ALSO carries amountCode + a plain
 *  message (lib/client-reason.ts), so the terminal / WebTrader can show the exact reason inline. */
export type AmountCode = "AMOUNT_SLTP_NOT_AVAILABLE" | "AMOUNT_INVALID" | "AMOUNT_BOTH_UNITS" | "AMOUNT_ALREADY_REACHED" | "AMOUNT_INSIDE_SPREAD" | "NO_CONVERSION_RATE";

/** A route's 400 body for an amount refusal. */
export function amountRefusalBody(code: AmountCode, text: string): { error: string; amountCode: AmountCode; amountMessage: string } {
  return { error: text, amountCode: code, amountMessage: text };
}

/** True when this account's risk is owned by the Rust engine and the engine's amount monitor is not switched on yet
 *  (ENGINE_AMOUNT_SLTP=1 lifts it once the engine part ships): an amount stored there would be watched by nothing.
 *  Uses the static owner (lib/risk-authority.ts), not the engine's liveness: a stored amount must stay watched after the engine returns. */
export function amountRefusedForAuthority(
  broker: { riskAuthority?: string | null; riskAuthorityDemoOnly?: boolean | null; engineLiveAllowlistOn?: boolean | null } | null | undefined,
  accountMode: string | null | undefined,
  env: Record<string, string | undefined> = process.env,
  accountEngineLive?: boolean | null,
): boolean {
  if (env.ENGINE_AMOUNT_SLTP === "1") return false;
  // Engine live allowlist (DORMANT, docs/ENGINE-LIVE-ALLOWLIST.md): an allowlisted LIVE account (flag on + entry on) is engine-owned, so it is
  // judged against the engine like a DEMO account. Flag off / no entry = exactly the previous rule (fail-closed in riskOwnerOf).
  return riskOwnerOf(broker, accountMode, accountEngineLive) === "RUST";
}

export type AmountLegs = { slAmount: Prisma.Decimal | null | undefined; tpAmount: Prisma.Decimal | null | undefined };

/** slAmount / tpAmount from a request body, with the one-unit-per-leg rule against the same body's slPrice / tpPrice.
 *  undefined = not sent (leave), null = clear, Decimal = set. */
export function parseAmountLegs(body: { slPrice?: unknown; tpPrice?: unknown; slAmount?: unknown; tpAmount?: unknown } | null | undefined, opts: { emptyRefused?: boolean } = {}): ({ ok: true } & AmountLegs) | { ok: false; code: AmountCode; error: string } {
  const both = bothUnitsError(body?.slPrice, body?.slAmount, "SL") ?? bothUnitsError(body?.tpPrice, body?.tpAmount, "TP");
  if (both) return { ok: false, code: "AMOUNT_BOTH_UNITS", error: both };
  const sl = parseAmount(body?.slAmount, "SL", opts);
  if (!sl.ok) return { ok: false, code: "AMOUNT_INVALID", error: sl.error };
  const tp = parseAmount(body?.tpAmount, "TP", opts);
  if (!tp.ok) return { ok: false, code: "AMOUNT_INVALID", error: tp.error };
  return { ok: true, slAmount: sl.value, tpAmount: tp.value };
}

/** The four levels of a position as an audit row records them (null = not set). */
export function sltpAuditLevels(p: { slPrice: Prisma.Decimal | null; tpPrice: Prisma.Decimal | null; slAmount: Prisma.Decimal | null; tpAmount: Prisma.Decimal | null }) {
  return { slPrice: p.slPrice?.toString() ?? null, tpPrice: p.tpPrice?.toString() ?? null, slAmount: p.slAmount?.toString() ?? null, tpAmount: p.tpAmount?.toString() ?? null };
}

/** True when a request sets (not clears) an amount: the only thing the RUST-authority refusal and the reached / FX checks apply to. */
export function setsAnAmount(legs: AmountLegs): boolean {
  return legs.slAmount != null || legs.tpAmount != null;
}

/** One leg of a modify: setting one unit clears the other (a leg is a price OR an amount); clearing a unit clears only that unit, so an
 *  older client that sends slPrice:null for a leg it knows nothing about never wipes an amount. undefined = leave. */
export function legWrite(price: string | null | undefined, amount: Prisma.Decimal | null | undefined): { price: string | null | undefined; amount: Prisma.Decimal | null | undefined } {
  if (price != null) return { price, amount: null };
  if (amount != null) return { price: null, amount };
  return { price, amount };
}
