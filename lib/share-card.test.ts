import { describe, expect, it } from "vitest";
import { amountText, artFor, gesture, heroLines, loadPrefs, movePctText, nextArt, pointSize, pointsText, savePrefs, shownHero, type ShareTrade } from "./share-card";

const gold = (isBuy: boolean): ShareTrade => ({ symbol: "XAUUSD", isBuy, lots: 1, entry: 4118.64, exit: 3880.61, digits: 2, pnl: isBuy ? -23803 : 23803, currency: "USD" });
const profit: ShareTrade = { symbol: "XAUUSD", isBuy: true, lots: 0.1, entry: 4162.87, exit: 4183.7, digits: 2, pnl: 208.3, currency: "USD" };
const loss: ShareTrade = { symbol: "EURUSD", isBuy: false, lots: 1, entry: 1.12118, exit: 1.12296, digits: 5, pnl: -178, currency: "USD" };

describe("share card (owner 2026-11-14)", () => {
  it("gold counts 0.10 per point; other symbols keep their last digit", () => {
    expect(pointSize("XAUUSD", 2)).toBe(0.1);
    expect(pointSize("XAUUSD.r", 2)).toBe(0.1);
    expect(pointSize("EURUSD", 5)).toBeCloseTo(0.00001, 12);
    expect(pointSize("XAGUSD", 3)).toBeCloseTo(0.001, 12);
    expect(pointSize("US30", 1)).toBeCloseTo(0.1, 12);
    expect(pointsText(gold(false))).toBe("+2,380 pts");
    expect(pointsText(gold(true))).toBe("−2,380 pts");
  });

  it("points hero by default: the amount and the price move % under it; never the margin return", () => {
    expect(heroLines(profit, "points", true)).toEqual({ hero: "+208 pts", secondary: "+208.30 USD  ·  +0.50%" });
    expect(heroLines(loss, "money", true)).toEqual({ hero: "−178.00 USD", secondary: "−178 pts  ·  −0.16%" });
    expect(heroLines(profit, "points", false)).toEqual({ hero: "+208 pts", secondary: "+0.50%" });
    expect(shownHero("money", false)).toBe("points");
    expect(amountText(profit)).toBe("+208.30 USD");
    expect(movePctText(loss)).toBe("−0.16%");
  });

  it("the swipe cycles the result's own artwork set", () => {
    expect(nextArt(profit, "classic", 1)).toBe("coin-laurel");
    expect(nextArt(profit, "coin-crown", 1)).toBe("classic");
    expect(nextArt(profit, "classic", -1)).toBe("coin-crown");
    expect(nextArt(loss, "classic", 1)).toBe("samurai-moonlit");
    expect(artFor(loss, "coin-crown")).toBe("classic");   // a profit artwork never shows on a loss
  });

  it("taps and swipes", () => {
    expect(gesture(-80, 4, 100, 100, 600, 315)).toBe("next");
    expect(gesture(80, -4, 100, 100, 600, 315)).toBe("prev");
    expect(gesture(2, 1, 300, 150, 600, 315)).toBe("toggle");
    expect(gesture(2, 1, 590, 10, 600, 315)).toBeNull();   // the corner (the close button)
    expect(gesture(20, 40, 300, 150, 600, 315)).toBeNull();
  });

  it("remembers the last hero and the last artwork per set", () => {
    const m = new Map<string, string>();
    const s = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadPrefs(profit, s)).toEqual({ hero: "points", art: "classic" });
    savePrefs(profit, "money", "coin-crown", s);
    savePrefs(loss, "money", "samurai-redsun", s);
    expect(loadPrefs(profit, s)).toEqual({ hero: "money", art: "coin-crown" });
    expect(loadPrefs(loss, s)).toEqual({ hero: "money", art: "samurai-redsun" });
  });
});
