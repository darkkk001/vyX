// Owner 2026-11-14: the PNL share card, the same on the web WebTrader and the native terminal (Vyx.Trader.App/Services/ShareCard.cs).
// - The hero is the move in POINTS (Option A, the default) or the MONEY result (Option B); a tap on the card switches it.
//   Under it: the other figure and the price-move %. The return on margin is never shown.
// - Gold counts 0.10 per point (XAU..., GOLD); every other symbol one point = its last price digit (10^-digits).
// - A swipe cycles the background artwork: the profit set on a winning trade, the loss set on a losing one. Only the background changes.
// - The last hero and the last artwork per set are remembered (this browser) for the next share.

export type ShareHero = "points" | "money";

export type ShareTrade = {
  symbol: string;
  isBuy: boolean;
  lots: number;
  entry: number;
  exit: number;
  digits: number;
  pnl: number;
  currency: string;
};

export const GOLD_POINT = 0.1;

export function isGold(symbol: string): boolean {
  const s = (symbol ?? "").trim().toUpperCase();
  return s.startsWith("XAU") || s.startsWith("GOLD");
}

/** One point as a price distance: 0.10 for gold, 10^-digits otherwise. */
export function pointSize(symbol: string, digits: number): number {
  return isGold(symbol) ? GOLD_POINT : Math.pow(10, -Math.max(0, digits));
}

/** The move in points, signed in the trade's favour. */
export function movePoints(t: ShareTrade): number {
  return ((t.exit - t.entry) / pointSize(t.symbol, t.digits)) * (t.isBuy ? 1 : -1);
}

const MINUS = "−";
function sign(v: number): string {
  return v >= 0 ? "+" : MINUS;
}
function grouped(v: number, decimals: number): string {
  return Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** "+2,380 pts" / "−178 pts". */
export function pointsText(t: ShareTrade): string {
  const p = Math.round(movePoints(t));
  return `${sign(p)}${grouped(p, 0)} pts`;
}

/** "+208.30 USD" / "−178.00 USD". */
export function amountText(t: ShareTrade): string {
  return `${sign(t.pnl)}${grouped(t.pnl, 2)} ${t.currency}`;
}

/** "+0.50%": the price move as a % of the entry, signed in the trade's favour (never the return on margin). */
export function movePctText(t: ShareTrade): string {
  const pct = t.entry !== 0 ? ((t.exit - t.entry) / t.entry) * 100 * (t.isBuy ? 1 : -1) : 0;
  return `${sign(pct)}${Math.abs(pct).toFixed(2)}%`;
}

/** The hero drawn: money needs the amount shown (PNL amount on); otherwise the points lead. */
export function shownHero(hero: ShareHero, showAmount: boolean): ShareHero {
  return hero === "money" && showAmount ? "money" : "points";
}

/** The big figure and the line under it. */
export function heroLines(t: ShareTrade, hero: ShareHero, showAmount: boolean): { hero: string; secondary: string } {
  if (shownHero(hero, showAmount) === "money") return { hero: amountText(t), secondary: `${pointsText(t)}  ·  ${movePctText(t)}` };
  return { hero: pointsText(t), secondary: showAmount ? `${amountText(t)}  ·  ${movePctText(t)}` : movePctText(t) };
}

export type ShareArtwork = { key: string; name: string; src: string | null };
export const CLASSIC = "classic";
// the profit set on a win, the loss set on a loss (the same sets as the native card)
export const PROFIT_ART: ShareArtwork[] = [
  { key: CLASSIC, name: "Classic", src: null },
  { key: "coin-laurel", name: "Gold coin · Laurel", src: "/share-art/coin-laurel.jpg" },
  { key: "coin-crown", name: "Gold coin · Crown", src: "/share-art/coin-crown.jpg" },
];
export const LOSS_ART: ShareArtwork[] = [
  { key: CLASSIC, name: "Classic", src: null },
  { key: "samurai-moonlit", name: "Samurai · Moonlit", src: "/share-art/samurai-moonlit.jpg" },
  { key: "samurai-redsun", name: "Samurai · Red sun", src: "/share-art/samurai-redsun.jpg" },
];

export function artSet(t: Pick<ShareTrade, "pnl">): ShareArtwork[] {
  return t.pnl >= 0 ? PROFIT_ART : LOSS_ART;
}

/** The key if it belongs to the trade's set, else Classic. */
export function artFor(t: Pick<ShareTrade, "pnl">, key: string | null | undefined): string {
  return artSet(t).some((a) => a.key === key) ? (key as string) : CLASSIC;
}

/** The artwork `steps` along the set from `key` (wraps; swipe left = +1, right = -1). */
export function nextArt(t: Pick<ShareTrade, "pnl">, key: string, steps: number): string {
  const set = artSet(t);
  const i = Math.max(0, set.findIndex((a) => a.key === key));
  return set[(((i + steps) % set.length) + set.length) % set.length].key;
}

// ---- the remembered preference (this browser) ----
export const PREF_KEYS = { hero: "wt.share.hero", artProfit: "wt.share.art.profit", artLoss: "wt.share.art.loss" } as const;

type Store = { getItem(k: string): string | null; setItem(k: string, v: string): void };
function store(): Store | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

export function loadPrefs(t: Pick<ShareTrade, "pnl">, s: Store | null = store()): { hero: ShareHero; art: string } {
  try {
    const hero = s?.getItem(PREF_KEYS.hero) === "money" ? "money" : "points";
    const art = artFor(t, s?.getItem(t.pnl >= 0 ? PREF_KEYS.artProfit : PREF_KEYS.artLoss));
    return { hero, art };
  } catch {
    return { hero: "points", art: CLASSIC };
  }
}

export function savePrefs(t: Pick<ShareTrade, "pnl">, hero: ShareHero, art: string, s: Store | null = store()): void {
  try {
    s?.setItem(PREF_KEYS.hero, hero);
    s?.setItem(t.pnl >= 0 ? PREF_KEYS.artProfit : PREF_KEYS.artLoss, art);
  } catch {
    /* a preference only */
  }
}

/** A drag at least this wide (CSS px) is a swipe; less is a tap. */
export const SWIPE_MIN = 48;
/** What a pointer gesture on the card does: a swipe (next / previous artwork), a tap in the middle (switch the hero) or nothing. */
export function gesture(dx: number, dy: number, x: number, y: number, w: number, h: number): "next" | "prev" | "toggle" | null {
  if (Math.abs(dx) >= SWIPE_MIN && Math.abs(dx) > Math.abs(dy) * 1.5) return dx < 0 ? "next" : "prev";
  if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && x > w * 0.12 && x < w * 0.88 && y > h * 0.12 && y < h * 0.88) return "toggle";
  return null;
}

/** The text a share page gets (and More › Copy text). */
export function summaryText(t: ShareTrade, brand: string, leverage: number): string {
  return `${t.symbol} ${t.isBuy ? "BUY" : "SELL"} ${t.lots.toFixed(2)} · Entry ${t.entry.toFixed(t.digits)} → ${t.exit.toFixed(t.digits)} · ${amountText(t)} · ${pointsText(t)} (${movePctText(t)}) · 1:${leverage} · ${brand}`;
}
