import { describe, expect, it } from "vitest";
import type { SymbolCategory } from "@prisma/client";
import { checkTradingSession, type SessionRow } from "@/lib/risk";
import { resolveTradingWindows, windowsCover } from "@/lib/bridge-sessions";

// The windows served to QoreBridge must say "open" exactly when the platform does (lib/risk.ts checkTradingSession),
// minute by minute, for every kind of symbol, in winter, in summer and across both US daylight-time switches.

const MIN = 60_000;

function weekStart(now: Date): number {
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - now.getUTCDay() * 1440 * MIN;
}

function agreesAllWeek(rows: SessionRow[], category: SymbolCategory, name: string, now: Date) {
  const { sessions } = resolveTradingWindows(rows, category, name, now);
  const start = weekStart(now);
  const wrong: string[] = [];
  for (let m = 0; m < 7 * 1440; m++) {
    const t = new Date(start + m * MIN);
    if (windowsCover(sessions, t) !== (checkTradingSession(rows, t, category, name) === null)) wrong.push(t.toISOString());
  }
  expect(wrong.slice(0, 5), `${category} ${name} week of ${now.toISOString()}`).toEqual([]);
}

const WINTER = new Date("2026-11-11T12:00:00Z"); // Wednesday, US standard time: New York 17:00 = 22:00 UTC
const SUMMER = new Date("2026-07-15T12:00:00Z"); // Wednesday, US daylight time: 21:00 UTC
const SPRING_SWITCH = new Date("2026-03-10T12:00:00Z"); // week of Sun 2026-03-08 (daylight time starts that Sunday)
const AUTUMN_SWITCH = new Date("2026-11-03T12:00:00Z"); // week of Sun 2026-11-01 (standard time starts that Sunday)

describe("resolveTradingWindows: the platform default rule", () => {
  const symbols: [SymbolCategory, string][] = [
    ["FOREX", "EURUSD"],
    ["METALS", "XAUUSD"],
    ["COMMODITIES", "SpotCrude"],
    ["COMMODITIES", "SpotBrent"],
    ["INDICES", "US30"],
    ["CRYPTO", "BTCUSD"],
  ];
  for (const now of [WINTER, SUMMER, SPRING_SWITCH, AUTUMN_SWITCH]) {
    for (const [category, name] of symbols) {
      it(`${name} agrees with checkTradingSession every minute, week of ${now.toISOString().slice(0, 10)}`, () => {
        agreesAllWeek([], category, name, now);
      });
    }
  }

  it("serves FX, gold and crypto as readable windows (winter)", () => {
    expect(resolveTradingWindows([], "FOREX", "EURUSD", WINTER)).toEqual({
      sessionsSource: "default",
      sessions: [
        { dayOfWeek: 0, openUtc: "22:00", closeUtc: "24:00" },
        { dayOfWeek: 1, openUtc: "00:00", closeUtc: "24:00" },
        { dayOfWeek: 2, openUtc: "00:00", closeUtc: "24:00" },
        { dayOfWeek: 3, openUtc: "00:00", closeUtc: "24:00" },
        { dayOfWeek: 4, openUtc: "00:00", closeUtc: "24:00" },
        { dayOfWeek: 5, openUtc: "00:00", closeUtc: "22:00" },
      ],
    });
    // gold: the same week minus the daily 22:00-23:00 UTC break, and Sunday opens after it
    expect(resolveTradingWindows([], "METALS", "XAUUSD", WINTER).sessions).toEqual([
      { dayOfWeek: 0, openUtc: "23:00", closeUtc: "24:00" },
      { dayOfWeek: 1, openUtc: "00:00", closeUtc: "22:00" },
      { dayOfWeek: 1, openUtc: "23:00", closeUtc: "24:00" },
      { dayOfWeek: 2, openUtc: "00:00", closeUtc: "22:00" },
      { dayOfWeek: 2, openUtc: "23:00", closeUtc: "24:00" },
      { dayOfWeek: 3, openUtc: "00:00", closeUtc: "22:00" },
      { dayOfWeek: 3, openUtc: "23:00", closeUtc: "24:00" },
      { dayOfWeek: 4, openUtc: "00:00", closeUtc: "22:00" },
      { dayOfWeek: 4, openUtc: "23:00", closeUtc: "24:00" },
      { dayOfWeek: 5, openUtc: "00:00", closeUtc: "22:00" },
    ]);
    // crypto: never closed
    expect(resolveTradingWindows([], "CRYPTO", "BTCUSD", WINTER).sessions).toEqual(
      [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, openUtc: "00:00", closeUtc: "24:00" }))
    );
  });

  it("moves with US daylight time (summer: New York 17:00 = 21:00 UTC)", () => {
    const fx = resolveTradingWindows([], "FOREX", "EURUSD", SUMMER).sessions;
    expect(fx[0]).toEqual({ dayOfWeek: 0, openUtc: "21:00", closeUtc: "24:00" });
    expect(fx[fx.length - 1]).toEqual({ dayOfWeek: 5, openUtc: "00:00", closeUtc: "21:00" });
  });
});

describe("resolveTradingWindows: a broker's own TradingSession rows", () => {
  const rows: SessionRow[] = [
    { dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" },
    { dayOfWeek: 1, openTime: "16:00", closeTime: "18:30" }, // overlaps: merged
    { dayOfWeek: 2, openTime: "22:00", closeTime: "02:00" }, // crosses midnight: split
    { dayOfWeek: 6, openTime: "10:00", closeTime: "24:00" },
    { dayOfWeek: 6, openTime: "20:00", closeTime: "03:00" }, // Saturday into Sunday
    { dayOfWeek: 3, openTime: "09:00", closeTime: "09:00" }, // open = close: never open
    { dayOfWeek: 4, openTime: "09:00", closeTime: "12:00", kind: "QUOTE" }, // quote window: not trading
  ];

  it("are served as same-day windows", () => {
    expect(resolveTradingWindows(rows, "FOREX", "EURUSD", WINTER)).toEqual({
      sessionsSource: "configured",
      sessions: [
        { dayOfWeek: 0, openUtc: "00:00", closeUtc: "03:00" },
        { dayOfWeek: 1, openUtc: "08:00", closeUtc: "18:30" },
        { dayOfWeek: 2, openUtc: "22:00", closeUtc: "24:00" },
        { dayOfWeek: 3, openUtc: "00:00", closeUtc: "02:00" },
        { dayOfWeek: 6, openUtc: "10:00", closeUtc: "24:00" },
      ],
    });
  });

  it("agree with checkTradingSession every minute", () => {
    agreesAllWeek(rows, "FOREX", "EURUSD", WINTER);
    agreesAllWeek(rows, "METALS", "XAUUSD", SUMMER); // configured rows win over the daily break, as on the platform
  });

  it("only QUOTE rows = no trading rows = the default rule", () => {
    const quoteOnly: SessionRow[] = [{ dayOfWeek: 1, openTime: "00:00", closeTime: "24:00", kind: "QUOTE" }];
    expect(resolveTradingWindows(quoteOnly, "FOREX", "EURUSD", WINTER).sessionsSource).toBe("default");
    agreesAllWeek(quoteOnly, "FOREX", "EURUSD", WINTER);
  });

  it("never close crypto (as on the platform)", () => {
    const r = resolveTradingWindows(rows, "CRYPTO", "BTCUSD", WINTER);
    expect(r.sessionsSource).toBe("default");
    agreesAllWeek(rows, "CRYPTO", "BTCUSD", WINTER);
  });
});
