import { Prisma } from "@prisma/client";
import { computeRealizedPnl } from "@/lib/trading";

// Amount-based take profit / stop loss (owner 2026-11-04, native release). Beside the price SL / TP, a trader may set either leg as an
// AMOUNT in the account currency: the position closes when its floating P/L reaches +tpAmount, or falls to -slAmount, whatever the exact
// price. A leg is a price OR an amount, never both. The floating P/L is the same gross figure every SL / TP check and the terminal already
// use (lib/risk-monitor.ts measureAccount, lib/fx-client.ts pnlInAccount): (close - open) x contract size x lots x quote->account rate, no
// swap or commission. Amounts are stored to the cent (Decimal(18,2)).

export const AMOUNT_MAX = new Prisma.Decimal("1000000000");

export type AmountParse = { ok: true; value: Prisma.Decimal | null | undefined } | { ok: false; error: string };

/** One amount field from a request body: undefined = not sent (leave as is), null / "" = clear, else a positive finite number of at most
 *  1,000,000,000 rounded to the cent. Hostile input (NaN, Infinity, hex, exponents beyond the cap) is refused, never stored. */
export function parseAmount(raw: unknown, leg: "SL" | "TP"): AmountParse {
  if (raw === undefined) return { ok: true, value: undefined };
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
