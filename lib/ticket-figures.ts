// The order ticket's computed rows, as the native terminal shows them: the money value of one point at the ticket's
// volume, and the risk / reward / R:R strip under the BUY and SELL buttons. Pure so it can be tested in plain Node.
// `moneyPerPriceUnit` is what one whole price unit is worth at the ticket's volume in the account currency
// (contract size x volume x the quote-to-account rate); null when the conversion is not priced yet.

export function pointValue(moneyPerPriceUnit: number | null, digits: number): number | null {
  if (moneyPerPriceUnit == null || !isFinite(moneyPerPriceUnit)) return null;
  return moneyPerPriceUnit * Math.pow(10, -digits);
}

export type RiskReward = { risk: number; reward: number; ratio: number };

/** Risk to the stop and reward to the target from the current price; 0 for a level not set. ratio = reward / risk. */
export function riskReward(price: number, sl: number, tp: number, moneyPerPriceUnit: number | null): RiskReward {
  if (moneyPerPriceUnit == null || !isFinite(moneyPerPriceUnit) || !isFinite(price)) return { risk: 0, reward: 0, ratio: 0 };
  const risk = isFinite(sl) ? Math.abs(price - sl) * moneyPerPriceUnit : 0;
  const reward = isFinite(tp) ? Math.abs(tp - price) * moneyPerPriceUnit : 0;
  return { risk, reward, ratio: risk > 0 && reward > 0 ? reward / risk : 0 };
}
