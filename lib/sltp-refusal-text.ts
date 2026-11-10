// Owner 2026-11-10: a refused SL / TP tells the client WHY instead of the generic "Invalid SL or TP". The rule is unchanged
// (lib/trading.ts validateSlTp); this only turns its refusal into one plain client sentence naming the price the level was checked
// against. The routes that judge a CLIENT's SL / TP attach that price as `sltpRef` to their refusal body; lib/client-reason.ts
// clientRefusal turns it into `error` / `message` (clientReason stays INVALID_SLTP). Any other INVALID_SLTP refusal keeps the
// generic sentence.

/** The price an SL / TP was checked against, as the client knows it: its value and how to name it ("your bid", "the entry price"). */
export type SlTpRef = { price: string; name: string };

const WRONG_SIDE = /^(SL|TP) must be (below|above) the reference price for a (BUY|SELL)$/;
const TOO_CLOSE = /^(SL|TP) must be at least ([0-9.]+) away from the current price$/;

const LEG = { SL: "Stop loss", TP: "Take profit" } as const;

/** The client sentence for a validateSlTp refusal, or null when the refusal is not one of its two shapes. */
export function slTpRefusalText(error: unknown, ref: SlTpRef | null | undefined): string | null {
  if (typeof error !== "string") return null;
  const at = ref && ref.name ? `${ref.name}${ref.price ? ` (${ref.price})` : ""}` : "the current price";
  const w = WRONG_SIDE.exec(error);
  if (w) return `${LEG[w[1] as "SL" | "TP"]} must be ${w[2]} ${at} for a ${w[3]}`;
  const d = TOO_CLOSE.exec(error);
  if (d) return `${LEG[d[1] as "SL" | "TP"]} must be at least ${d[2]} away from ${at}`;
  return null;
}

/** An open position's SL / TP is checked against the price it closes at: a BUY at the account's bid, a SELL at its ask. */
export const positionRef = (side: "BUY" | "SELL", price: string): SlTpRef => ({ price, name: side === "BUY" ? "your bid" : "your ask" });
/** An order's SL / TP is checked against its own entry price. */
export const orderRef = (price: string): SlTpRef => ({ price, name: "the entry price" });

/** Is this a value a refusal body may carry as sltpRef (both fields plain strings)? */
export function isSlTpRef(v: unknown): v is SlTpRef {
  return !!v && typeof v === "object" && typeof (v as SlTpRef).price === "string" && typeof (v as SlTpRef).name === "string";
}
