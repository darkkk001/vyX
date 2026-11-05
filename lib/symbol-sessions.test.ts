import { describe, expect, it } from "vitest";
import { SESSION_PRESETS, hoursSummary, validateSessions, zoneOffsetMinutes } from "@/lib/symbol-sessions";
import { sessionCovers, checkTradingSession, tradeSessions } from "@/lib/risk";

const ok = (raw: unknown[]) => {
  const r = validateSessions(raw);
  expect(r.rowErrors).toEqual([]);
  return r.rows;
};

describe("validateSessions", () => {
  it("kind defaults to TRADE and QUOTE is kept", () => {
    expect(ok([{ dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }])[0].kind).toBe("TRADE");
    expect(ok([{ kind: "QUOTE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }])[0].kind).toBe("QUOTE");
  });

  it("refuses an unknown kind, a bad day and bad times with the row index", () => {
    const r = validateSessions([
      { kind: "OTHER", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" },
      { dayOfWeek: 7, openTime: "08:00", closeTime: "17:00" },
      { dayOfWeek: 1, openTime: "8:00", closeTime: "17:00" },
      { dayOfWeek: 1, openTime: "24:00", closeTime: "17:00" },
      { dayOfWeek: 1, openTime: "08:00", closeTime: "25:00" },
      { dayOfWeek: 1, openTime: "10:00", closeTime: "10:00" },
      { dayOfWeek: 2, openTime: "08:00", closeTime: "24:00" },
    ]);
    expect(r.rowErrors.map((e) => e.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.rowErrors.every((e) => e.reason.length > 0)).toBe(true);
  });

  it("refuses sessions that is not an array", () => {
    expect(validateSessions("x").rowErrors).toHaveLength(1);
  });

  it("refuses an overlap on the same day and kind, names the later row, allows touching ends and other kinds", () => {
    const r = validateSessions([
      { dayOfWeek: 1, openTime: "08:00", closeTime: "12:00" },
      { dayOfWeek: 1, openTime: "11:00", closeTime: "14:00" },
    ]);
    expect(r.rowErrors).toEqual([{ index: 1, reason: expect.stringContaining("overlaps row 0") }]);
    expect(
      validateSessions([
        { dayOfWeek: 1, openTime: "08:00", closeTime: "12:00" },
        { dayOfWeek: 1, openTime: "12:00", closeTime: "14:00" },
        { kind: "QUOTE", dayOfWeek: 1, openTime: "09:00", closeTime: "13:00" },
      ]).rowErrors,
    ).toEqual([]);
  });

  it("stores a window that crosses midnight as two rows", () => {
    const rows = ok([{ dayOfWeek: 1, openTime: "22:00", closeTime: "02:00" }]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => `${r.dayOfWeek} ${r.openTime}-${r.closeTime}`).sort()).toEqual(["1 22:00-24:00", "2 00:00-02:00"]);
  });

  it("wraps Saturday into Sunday and treats a close at 00:00 as ending at midnight", () => {
    expect(ok([{ dayOfWeek: 6, openTime: "23:00", closeTime: "01:00" }]).map((r) => `${r.dayOfWeek} ${r.openTime}-${r.closeTime}`).sort()).toEqual(["0 00:00-01:00", "6 23:00-24:00"]);
    expect(ok([{ dayOfWeek: 1, openTime: "22:00", closeTime: "00:00" }]).map((r) => `${r.dayOfWeek} ${r.openTime}-${r.closeTime}`)).toEqual(["1 22:00-24:00"]);
  });

  it("a split window clashing with another window on the next day is an overlap", () => {
    const r = validateSessions([
      { dayOfWeek: 1, openTime: "22:00", closeTime: "02:00" },
      { dayOfWeek: 2, openTime: "01:00", closeTime: "05:00" },
    ]);
    expect(r.rowErrors).toHaveLength(1);
    expect(r.rowErrors[0].index).toBe(1);
  });

  it("the stored split rows cover exactly the minutes the single crossing window covers", () => {
    const rows = ok([{ dayOfWeek: 5, openTime: "22:00", closeTime: "02:00" }]);
    for (const [day, min, want] of [[5, 21 * 60 + 59, false], [5, 22 * 60, true], [6, 60, true], [6, 120, false]] as const) {
      expect(rows.some((r) => sessionCovers(r, day, min))).toBe(want);
    }
  });
});

describe("QUOTE rows never decide trading", () => {
  const sat = new Date("2026-11-07T12:00:00Z"); // Saturday: the default week is closed
  it("tradeSessions drops QUOTE rows, keeps rows without a kind", () => {
    expect(tradeSessions([{ kind: "QUOTE" }, { kind: "TRADE" }, {}])).toHaveLength(2);
  });
  it("a symbol with only QUOTE rows still follows the default week", () => {
    const quoteOnly = [{ kind: "QUOTE", dayOfWeek: 6, openTime: "00:00", closeTime: "24:00" }];
    expect(checkTradingSession(quoteOnly, sat, "FOREX", "EURUSD")).toBe("MARKET_CLOSED");
    const trade = [{ kind: "TRADE", dayOfWeek: 6, openTime: "00:00", closeTime: "24:00" }];
    expect(checkTradingSession(trade, sat, "FOREX", "EURUSD")).toBeNull();
  });
});

describe("SESSION_PRESETS", () => {
  it("has FX week, 24/7, Metals, Indices, Crypto with id, name and valid session rows", () => {
    expect(SESSION_PRESETS.map((p) => p.name)).toEqual(["FX week", "24/7", "Metals", "Indices", "Crypto"]);
    expect(new Set(SESSION_PRESETS.map((p) => p.id)).size).toBe(5);
    for (const p of SESSION_PRESETS) {
      expect(Object.keys(p).sort()).toEqual(["id", "name", "sessions"]);
      expect(p.sessions.length).toBeGreaterThan(0);
      const v = validateSessions(p.sessions);
      expect(v.rowErrors, p.name).toEqual([]);
      expect(v.rows).toHaveLength(p.sessions.length);
      for (const s of p.sessions) expect(Object.keys(s).sort()).toEqual(["closeTime", "dayOfWeek", "kind", "openTime"]);
    }
  });
  it("24/7 covers every minute of the week; the FX week is closed on Saturday", () => {
    const all = SESSION_PRESETS.find((p) => p.id === "24-7")!.sessions;
    expect(all).toHaveLength(7);
    const fx = SESSION_PRESETS.find((p) => p.id === "fx-week")!.sessions;
    expect(fx.some((s) => s.dayOfWeek === 6)).toBe(false);
  });
});

describe("hoursSummary", () => {
  const now = new Date("2026-11-04T12:00:00Z"); // New York on standard time (UTC-5)
  const week = (windows: [string, string][], days = [1, 2, 3, 4, 5]) => days.flatMap((d) => windows.map(([o, c]) => ({ kind: "TRADE", dayOfWeek: d, openTime: o, closeTime: c })));

  it("the Metals preset reads with its daily break at 17-18 in New York", () => {
    const metals = SESSION_PRESETS.find((p) => p.id === "metals")!.sessions;
    expect(hoursSummary(metals, { category: "METALS", timeZone: "America/New_York", now })).toBe("Mon-Thu 24h · break 17-18; Fri until 17:00; Sun from 18:00 NY");
  });

  it("shows UTC when the broker has no zone", () => {
    expect(hoursSummary(week([["00:00", "22:00"], ["23:00", "24:00"]]), { category: "METALS", now })).toBe("Mon-Fri 24h · break 22-23 UTC");
    expect(hoursSummary(week([["08:00", "17:00"]]), { category: "FOREX", timeZone: null, now })).toBe("Mon-Fri 08:00-17:00 UTC");
  });

  it("the FX preset reads as a week from Sunday evening to Friday evening", () => {
    const fx = SESSION_PRESETS.find((p) => p.id === "fx-week")!.sessions;
    expect(hoursSummary(fx, { category: "FOREX", timeZone: "America/New_York", now })).toBe("Mon-Thu 24h; Fri until 17:00; Sun from 17:00 NY");
  });

  it("24/7 and the default week; never an empty or dash value", () => {
    expect(hoursSummary(SESSION_PRESETS.find((p) => p.id === "24-7")!.sessions, { category: "CRYPTO", now })).toBe("24/7");
    expect(hoursSummary([], { category: "CRYPTO", now })).toBe("24/7");
    expect(hoursSummary([], { category: "FOREX", now })).toBe("Sun 17:00 - Fri 17:00 NY");
    expect(hoursSummary([], { category: "METALS", now })).toBe("Sun 17:00 - Fri 17:00 NY · break 17-18 NY");
    for (const s of [hoursSummary([], { category: "STOCKS", now }), hoursSummary([{ dayOfWeek: 1, openTime: "08:00", closeTime: "09:00", kind: "QUOTE" }], { category: "FOREX", now })]) {
      expect(s.length).toBeGreaterThan(0);
      expect(s).not.toMatch(/—/);
    }
  });

  it("a window shifted across midnight by the zone lands on the right days", () => {
    // Mon 22:00-24:00 UTC is Tue 00:00-02:00 in UTC+2
    expect(hoursSummary([{ dayOfWeek: 1, openTime: "22:00", closeTime: "24:00" }], { category: "FOREX", timeZone: "Europe/Athens", now })).toBe("Tue until 02:00 Athens");
  });

  it("QUOTE rows add a quotes part", () => {
    const rows = [...week([["00:00", "24:00"]]), { kind: "QUOTE", dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }];
    expect(hoursSummary(rows, { category: "FOREX", now })).toBe("Mon-Fri 24h UTC · quotes Mon 08:00-17:00");
  });
});

describe("zoneOffsetMinutes", () => {
  it("is 0 for UTC / unknown and follows daylight saving", () => {
    expect(zoneOffsetMinutes(null, new Date())).toBe(0);
    expect(zoneOffsetMinutes("Not/AZone", new Date())).toBe(0);
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-11-04T12:00:00Z"))).toBe(-300);
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-07-01T12:00:00Z"))).toBe(-240);
  });
});
