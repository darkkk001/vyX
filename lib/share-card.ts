// WebTrader share card (owner 2026-11-14, design C:\vyx\handoff\share-card-prototype.html): the numbers and the line.
// Pure functions, safe for the browser; the terminal follows the same rules (handoff note terminal-share-card.md).

export type ShareSide = "BUY" | "SELL";
export type CandleTf = "M1" | "M5" | "M15" | "H1" | "H4" | "D1";

const MINUS = "\u2212";
const sign = (profit: boolean) => (profit ? "+" : MINUS);

// The owner's rule (2026-11-14, the same in the terminal so the two never drift):
//   pips = (exit - entry) * (BUY ? 1 : -1) / the symbol's pip size; the pip size comes from the symbol's own settings by
//   the platform's one pip rule (lib/group-pricing.ts pipSize, the engine's pip_size): 10 x the symbol's point, i.e.
//   10^-(digits - 1): gold (2 digits) 0.10, forex (5) 0.0001, JPY pairs (3) 0.01, 1-digit indices / BTCUSD 1.0.
//   gold 3888.13 -> 3895.19 = 70.6 pips, 4100 -> 4170 = 700 pips; one decimal, shown only when there is one.
//   move % = (exit - entry) / entry * 100 * side, 2 decimals; never a return on margin; minus = U+2212.

/** 1 pip in price units for a symbol with this many digits (the same rule as lib/group-pricing.ts pipSize). */
export const pipSizeOf = (digits: number) => 10 ** -Math.max(digits - 1, 0);

/** The price move in pips, signed by the trade's side: XAUUSD BUY 3888.13 -> 3895.19 = +70.6. */
export function movePips(entry: number, current: number, digits: number, side: ShareSide): number {
  return Number((((current - entry) * (side === "BUY" ? 1 : -1)) / pipSizeOf(digits)).toFixed(1));
}

/** The price move in percent of the entry price (not of the margin), signed by the side, 2 decimals. */
export function movePercent(entry: number, current: number, side: ShareSide): number {
  return entry > 0 ? (((current - entry) / entry) * 100 * (side === "BUY" ? 1 : -1)) : 0;
}

const CCY: Record<string, string> = { USD: "$", EUR: "\u20ac", GBP: "\u00a3", JPY: "\u00a5" };
/** "+$7.06", "−$9.70"; another currency without a sign of its own: "+7.06 AED". */
export function moneyText(pnl: number, currency: string): string {
  const abs = Math.abs(pnl).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const s = sign(pnl >= 0);
  return CCY[currency] ? `${s}${CCY[currency]}${abs}` : `${s}${abs} ${currency}`;
}

/** "+70.6 pips", "+700 pips", "−3.5 pips" */
export function pipsText(pips: number): string {
  return `${sign(pips >= 0)}${Math.abs(pips).toLocaleString("en-US", { maximumFractionDigits: 1 })} pips`;
}
/** "+0.18%" */
export function percentText(pct: number): string {
  return `${sign(pct >= 0)}${Math.abs(pct).toFixed(2)}%`;
}

/** The hero and the line under it. view "money" = USD first (the default), "pips" after a tap; PnL off = no money
 *  anywhere: pips big, the move % under it. */
export function heroLines(p: { pnl: number; currency: string; pips: number; pct: number; showPnl: boolean; view: "money" | "pips" }): { big: string; sub: string } {
  const pts = pipsText(p.pips), pct = percentText(p.pct);
  if (!p.showPnl) return { big: pts, sub: pct };
  const money = moneyText(p.pnl, p.currency);
  return p.view === "money" ? { big: money, sub: `${pts} \u00b7 ${pct}` } : { big: pts, sub: `${money} \u00b7 ${pct}` };
}

/** A timeframe that gives the trade's life enough bars for a smooth line (about 10-200). */
export function lineTimeframe(openedAtMs: number, nowMs: number): CandleTf {
  const h = Math.max(0, nowMs - openedAtMs) / 3_600_000;
  if (h <= 3) return "M1";
  if (h <= 12) return "M5";
  if (h <= 48) return "M15";
  if (h <= 24 * 8) return "H1";
  if (h <= 24 * 40) return "H4";
  return "D1";
}
const TF_MS: Record<CandleTf, number> = { M1: 60_000, M5: 300_000, M15: 900_000, H1: 3_600_000, H4: 14_400_000, D1: 86_400_000 };

/**
 * The trade's own prices, from the entry to now: the closes of the bars since the open, the entry first and the
 * current price last, at most `max` points (evenly picked). A SELL's line is drawn upside down, so the line always
 * follows the trade's result: up in profit, down in loss.
 */
export function tradeSeries(p: { side: ShareSide; entry: number; current: number; openedAtMs: number; tf: CandleTf; candles: { bucketStart: string; close: string }[]; max?: number }): number[] {
  const from = p.openedAtMs - TF_MS[p.tf];
  const closes = p.candles.filter((c) => Date.parse(c.bucketStart) >= from).map((c) => Number(c.close)).filter((v) => Number.isFinite(v) && v > 0);
  let prices = [p.entry, ...closes, p.current];
  const max = p.max ?? 24;
  if (prices.length > max) {
    const step = (prices.length - 1) / (max - 1);
    prices = Array.from({ length: max }, (_, i) => prices[Math.round(i * step)]);
  }
  return prices.map((v) => (p.side === "BUY" ? v : -v));
}

/** Values -> points in the card's 351 x 220 line box (y 30..190, like the prototype). */
export function linePoints(values: number[]): [number, number][] {
  const v = values.length >= 2 ? values : [values[0] ?? 0, values[0] ?? 0];
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo;
  return v.map((x, i) => [Math.round((i / (v.length - 1)) * 350 * 10) / 10, Math.round((span > 0 ? 190 - ((x - lo) / span) * 160 : 110) * 10) / 10]);
}

/** The prototype's smooth curve (Catmull-Rom as cubic Béziers) through the points. */
export function smoothPath(P: [number, number][]): string {
  let d = `M${P[0][0]},${P[0][1]}`;
  for (let i = 0; i < P.length - 1; i++) {
    const p0 = P[i - 1] || P[i], p1 = P[i], p2 = P[i + 1], p3 = P[i + 2] || p2;
    const r = (n: number) => Math.round(n * 100) / 100;
    d += ` C${r(p1[0] + (p2[0] - p0[0]) / 6)},${r(p1[1] + (p2[1] - p0[1]) / 6)} ${r(p2[0] - (p3[0] - p1[0]) / 6)},${r(p2[1] - (p3[1] - p1[1]) / 6)} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/** "••••5728" */
export const maskedAccount = (n: string) => `\u2022\u2022\u2022\u2022${n.slice(-4)}`;

export type ShareMe = {
  type: "bitmoji" | "preset" | "none"; preset: string | null; imageUrl: string | null;
  referralCode: string | null; registerUrl: string | null; qr: string | null;
  nameTag?: string | null; // the account's nickname, else the client's name
  presets: { profit: { name: string }[]; loss: { name: string }[] };
};
export type Slide = { kind: "bitmoji"; url: string } | { kind: "preset"; name: string };

/** The card's slides: the client's Bitmoji first (when connected), then the mood's preset list. */
export function shareSlides(me: ShareMe | null, loss: boolean, fallback: { profit: string[]; loss: string[] }): Slide[] {
  const names = me ? (loss ? me.presets.loss : me.presets.profit).map((p) => p.name) : loss ? fallback.loss : fallback.profit;
  const list: Slide[] = names.map((name) => ({ kind: "preset", name }));
  return me?.type === "bitmoji" && me.imageUrl ? [{ kind: "bitmoji", url: me.imageUrl }, ...list] : list;
}
/** Where the card opens: profit on the client's own avatar (Bitmoji, else the chosen preset), loss on bear. */
export function shareStart(slides: Slide[], me: ShareMe | null, loss: boolean): number {
  const at = (name: string | null | undefined) => slides.findIndex((s) => s.kind === "preset" && s.name === name);
  if (loss) return Math.max(0, at("bear"));
  if (slides[0]?.kind === "bitmoji") return 0;
  return Math.max(0, at(me?.preset));
}


// The card's buttons (owner 2026-11-14): the text and the link a share carries.
/** "My trade on QoreTrader" */
export const shareText = (brokerName: string) => `My trade on ${brokerName}`;
/** The client's referral register link; a client without a code: the broker's register page. */
export const shareLink = (me: { registerUrl: string | null } | null, origin: string) => me?.registerUrl || `${origin}/register`;
/** Desktop share pages: Telegram and X with the text and the link. */
export const telegramShareUrl = (text: string, link: string) => `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text)}`;
export const xShareUrl = (text: string, link: string) => `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(link)}`;
/** "qoretrader-xauusd-trade.png" */
export const shareFileName = (brokerName: string, symbol: string) => `${brokerName}-${symbol}-trade.png`.toLowerCase().replace(/[^a-z0-9.-]+/g, "-");
