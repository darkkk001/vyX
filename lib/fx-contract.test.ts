import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeFxVectors, FX_VECTOR_INPUTS } from "@/lib/fx-contract";
import { conversionRateNum, fxLookupNum, marginInAccount, newOrderMarginInAccount, pnlInAccount, pointValueInAccount } from "@/lib/fx-client";
import { hedgedUsedMarginDisplay, type DisplayMarginLeg } from "@/lib/hedged-margin-display";
import { isWeeklyClosed, nextWeeklyReopen } from "@/lib/market-week";
import { isDefaultFxSessionClosed, computeNextSessionOpen } from "@/lib/risk";

// FX + weekly-close contract (2026-09-26, docs/contracts/fx-and-market-week.md). The same two vector files pin the
// terminal (tests/Vyx.Shared.Tests FxContractTests / MarketWeekContractTests, byte-identical copies) and the engine
// (gap_fill tests read market-week-vectors.json).
const ROOT = path.resolve(import.meta.dirname, "..");
const fxFile = JSON.parse(readFileSync(path.join(ROOT, "docs", "contracts", "fx-vectors.json"), "utf8"));
const weekFile = JSON.parse(readFileSync(path.join(ROOT, "docs", "contracts", "market-week-vectors.json"), "utf8"));
type Q = { bid: string; ask: string; ageMs: number };

const close = (actual: number | null, expected: string | null, what: string) => {
  if (expected == null) return expect(actual, what).toBeNull();
  expect(actual, what).not.toBeNull();
  const e = Number(expected);
  const tol = Math.max(fxFile.tolerance.money, Math.abs(e) * fxFile.tolerance.relative);
  expect(Math.abs(actual! - e), `${what}: ${actual} vs ${expected}`).toBeLessThanOrEqual(tol);
};
const lookupOf = (quotes: Record<string, Q>) =>
  fxLookupNum(
    Object.fromEntries(Object.entries(quotes).map(([s, q]) => [s, { bid: Number(q.bid), ask: Number(q.ask), tickAtMs: fxFile.nowMs - q.ageMs }])),
    fxFile.nowMs
  );

describe("FX contract: the server's own formulas reproduce docs/contracts/fx-vectors.json exactly", () => {
  it("regenerating the vectors from lib/fx + lib/margin + lib/trading gives the committed file", () => {
    const regenerated = JSON.parse(JSON.stringify(computeFxVectors(FX_VECTOR_INPUTS)));
    expect(regenerated).toEqual(fxFile);
  });
});

describe("FX contract: the web trader's client math (lib/fx-client.ts) reproduces every vector", () => {
  for (const c of fxFile.cases) {
    it(c.name, () => {
      const rate = conversionRateNum(c.symbol.quoteCurrency, c.accountCurrency, lookupOf(c.quotes));
      const cs = Number(c.symbol.contractSize);
      const [bid, ask, vol] = [Number(c.bid), Number(c.ask), Number(c.volume)];
      close(rate, c.expect.rate, "rate");
      close(pnlInAccount(c.side, Number(c.openPrice), bid, ask, cs, vol, rate), c.expect.pnl, "pnl");
      close(marginInAccount(c.side, bid, ask, cs, vol, c.leverage, rate), c.expect.margin, "margin");
      close(pointValueInAccount(vol, cs, c.symbol.digits, rate), c.expect.pointValue, "pointValue");
      close(newOrderMarginInAccount(vol, cs, c.side === "BUY" ? ask : bid, c.leverage, rate), c.expect.newOrderMargin, "newOrderMargin");
    });
  }
  for (const a of fxFile.accounts) {
    it(a.name, () => {
      const lookup = lookupOf(a.quotes);
      let equity = Number(a.balance) + Number(a.credit);
      let unpriced = 0;
      const legs: DisplayMarginLeg[] = [];
      for (const p of a.positions) {
        const rate = conversionRateNum(p.symbol.quoteCurrency, a.accountCurrency, lookup);
        const cs = Number(p.symbol.contractSize);
        const pnl = pnlInAccount(p.side, Number(p.openPrice), Number(p.bid), Number(p.ask), cs, Number(p.volume), rate);
        const margin = marginInAccount(p.side, Number(p.bid), Number(p.ask), cs, Number(p.volume), a.leverage, rate);
        if (pnl == null || margin == null) { unpriced++; continue; }
        equity += pnl;
        legs.push({ symbolKey: p.symbol.name, side: p.side, volume: Number(p.volume), margin, hedgedMarginPct: Number(p.hedgedMarginPct) });
      }
      const used = hedgedUsedMarginDisplay(legs);
      close(equity, a.expect.equity, "equity");
      close(used, a.expect.usedMargin, "usedMargin");
      close(equity - used, a.expect.freeMargin, "freeMargin");
      close(used > 0 ? (equity / used) * 100 : null, a.expect.marginLevel, "marginLevel");
      expect(unpriced).toBe(a.expect.unpricedPositions);
    });
  }
});

describe("weekly close / reopen: one rule (docs/contracts/market-week-vectors.json)", () => {
  for (const c of weekFile.cases as { utc: string; closed: boolean; why: string }[]) {
    it(`${c.utc} ${c.closed ? "closed" : "open"} -- ${c.why}`, () => {
      expect(isWeeklyClosed(new Date(c.utc))).toBe(c.closed);
      expect(isDefaultFxSessionClosed(new Date(c.utc))).toBe(c.closed); // the server's default session
    });
  }
  it("the next reopen is Sunday 21:00 UTC in summer and 22:00 UTC in winter (also what MARKET_CLOSED answers)", () => {
    expect(nextWeeklyReopen(new Date("2026-09-26T03:17:00Z")).toISOString()).toBe("2026-09-27T21:00:00.000Z");
    expect(nextWeeklyReopen(new Date("2026-10-31T12:00:00Z")).toISOString()).toBe("2026-11-01T22:00:00.000Z");
    expect(nextWeeklyReopen(new Date("2027-03-13T12:00:00Z")).toISOString()).toBe("2027-03-14T21:00:00.000Z");
    expect(computeNextSessionOpen([], new Date("2026-11-07T12:00:00Z")).toISOString()).toBe("2026-11-08T22:00:00.000Z");
  });
});
