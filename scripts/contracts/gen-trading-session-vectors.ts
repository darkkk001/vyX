// Generates docs/contracts/trading-session-vectors.json BY CALLING THE WEB'S OWN
// lib/risk.ts checkTradingSession (and its helpers) over a matrix of instants, categories, symbols and
// session configurations.
//
// WHY. `checkTradingSession` is the one gate the L2 entry point could not port blind: outside trading
// hours the web refuses with MARKET_CLOSED and the engine would fill. The engine HAS a port
// (engine/order-management/src/session.rs) but its equivalence was never established, and reading the
// two side by side showed the daily-break half had drifted. So: oracle first, then fix the port
// against it — engine/order-management/tests/trading_session_parity.rs.
//
// The matrix covers all four rules checkTradingSession composes:
//   1. CRYPTO is always open (isContinuouslyTraded)
//   2. the weekly close, Friday 17:00 -> Sunday 17:00 New York (already pinned by
//      market-week-vectors.json; included again here so this file is self-contained)
//   3. the daily settlement break: METALS and SpotCrude 1 h, SpotBrent 3 h, from the NY-17:00 anchor,
//      Sunday..Thursday
//   4. admin-configured TradingSession rows, which WIN over all of the above
//
//   NODE_OPTIONS=--conditions=react-server \
//   npx tsx --tsconfig tsconfig.json scripts/contracts/gen-trading-session-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { SymbolCategory } from "@prisma/client";
import { checkTradingSession, dailyBreakHours, hasDailyBreak, isInDailyBreak, isDefaultFxSessionClosed } from "../../lib/risk";
import { usEasternIsDst, nyCloseHourUtc } from "../../lib/market-week";

type Session = { dayOfWeek: number; openTime: string; closeTime: string };
type Case = {
  utc: string;
  category: SymbolCategory;
  symbol: string | null;
  sessions: Session[];
  why: string;
  closed: boolean;
};

const cases: Case[] = [];
const add = (utc: string, category: SymbolCategory, symbol: string | null, sessions: Session[], why: string) => {
  const now = new Date(utc);
  cases.push({ utc, category, symbol, sessions, why, closed: checkTradingSession(sessions, now, category, symbol) === "MARKET_CLOSED" });
};

// ── 1. CRYPTO is always open, at every instant that closes everything else ──
for (const utc of ["2026-07-04T12:00:00Z", "2026-07-05T12:00:00Z", "2026-07-03T21:30:00Z", "2026-11-07T12:00:00Z", "2026-07-06T20:00:00Z"]) {
  add(utc, "CRYPTO", "BTCUSD", [], "crypto is never closed");
  // and even with a configured session that does not cover this instant
  add(utc, "CRYPTO", "BTCUSD", [{ dayOfWeek: 1, openTime: "08:00", closeTime: "09:00" }], "crypto ignores configured sessions too");
}

// ── 2. the weekly close, both seasons, around the anchor ──
// 2026: US DST runs 2026-03-08 07:00Z .. 2026-11-01 06:00Z. July = EDT (anchor 21:00Z), Nov 7 = EST (22:00Z).
const weekly: [string, string][] = [
  // summer: Friday 2026-07-03, Sunday 2026-07-05
  ["2026-07-03T20:59:00Z", "summer Friday one minute before the 21:00Z close"],
  ["2026-07-03T21:00:00Z", "summer Friday at the close"],
  ["2026-07-04T12:00:00Z", "Saturday"],
  ["2026-07-05T20:59:00Z", "summer Sunday one minute before the 21:00Z reopen"],
  ["2026-07-05T21:00:00Z", "summer Sunday at the reopen"],
  ["2026-07-01T12:00:00Z", "a summer Wednesday midday"],
  // winter: Friday 2026-11-06, Sunday 2026-11-08
  ["2026-11-06T21:59:00Z", "winter Friday one minute before the 22:00Z close"],
  ["2026-11-06T22:00:00Z", "winter Friday at the close"],
  ["2026-11-07T12:00:00Z", "winter Saturday"],
  ["2026-11-08T21:59:00Z", "winter Sunday one minute before the 22:00Z reopen"],
  ["2026-11-08T22:00:00Z", "winter Sunday at the reopen"],
  // the DST changeover weekends themselves
  ["2026-03-08T07:00:00Z", "the instant US DST begins (a Sunday)"],
  ["2026-11-01T06:00:00Z", "the instant US DST ends (a Sunday)"],
];
for (const [utc, why] of weekly) {
  add(utc, "FOREX", "EURUSD", [], why);
  add(utc, "INDICES", "US30", [], why + " (indices: weekly rule, no break)");
}

// ── 3. the daily settlement break ──
// METALS / SpotCrude: 1 h from the anchor. SpotBrent: 3 h. Sunday..Thursday.
// Summer anchor 21:00Z; the 2026-06-29 week is Mon..Thu, 2026-07-05 is the Sunday.
const breakDays: [string, string][] = [
  ["2026-06-29", "Monday"],
  ["2026-06-30", "Tuesday"],
  ["2026-07-01", "Wednesday"],
  ["2026-07-02", "Thursday"],
  ["2026-07-03", "Friday (the weekly close takes over)"],
  ["2026-07-05", "Sunday (the break applies: the week opens at the anchor PLUS the break)"],
];
for (const [date, dayName] of breakDays) {
  for (const [hhmm, when] of [
    ["20:59", "one minute before the anchor"],
    ["21:00", "at the anchor"],
    ["21:30", "half an hour in"],
    ["21:59", "one minute before a 1 h break ends"],
    ["22:00", "one hour in (a 1 h break has ended)"],
    ["23:30", "two and a half hours in (still inside Brent's 3 h)"],
  ] as [string, string][]) {
    const utc = `${date}T${hhmm}:00Z`;
    add(utc, "METALS", "XAUUSD", [], `metals, ${dayName}, ${when}`);
    add(utc, "COMMODITIES", "SpotBrent", [], `SpotBrent (3 h), ${dayName}, ${when}`);
    add(utc, "COMMODITIES", "SpotCrude", [], `SpotCrude (1 h), ${dayName}, ${when}`);
  }
}
// Brent's break crosses midnight UTC in winter (22:00 -> 01:00)
for (const [utc, why] of [
  ["2026-11-03T22:30:00Z", "winter: SpotBrent inside the break, before midnight"],
  ["2026-11-04T00:30:00Z", "winter: SpotBrent inside the break, after midnight"],
  ["2026-11-04T01:00:00Z", "winter: SpotBrent exactly 3 h after the anchor"],
] as [string, string][]) {
  add(utc, "COMMODITIES", "SpotBrent", [], why);
  add(utc, "METALS", "XAUUSD", [], why.replace("SpotBrent", "metals") + " (1 h break: long over)");
}

// ── 4. configured TradingSession rows WIN over every default above ──
const monday = "2026-06-29"; // a Monday
const sessionSets: [Session[], string][] = [
  [[{ dayOfWeek: 1, openTime: "08:00", closeTime: "17:00" }], "Mon 08:00-17:00, same day"],
  [[{ dayOfWeek: 1, openTime: "22:00", closeTime: "02:00" }], "Mon 22:00-02:00, crosses midnight"],
  [[{ dayOfWeek: 1, openTime: "00:00", closeTime: "24:00" }], "Mon all day (close 24:00)"],
  [
    [
      { dayOfWeek: 1, openTime: "08:00", closeTime: "12:00" },
      { dayOfWeek: 1, openTime: "13:00", closeTime: "17:00" },
    ],
    "Mon two windows with a lunch gap",
  ],
  [[{ dayOfWeek: 1, openTime: "bad", closeTime: "17:00" }], "a malformed row: never open"],
  [[{ dayOfWeek: 2, openTime: "08:00", closeTime: "17:00" }], "configured for TUESDAY only"],
];
for (const [sessions, why] of sessionSets) {
  for (const hhmm of ["07:59", "08:00", "11:59", "12:00", "12:30", "16:59", "17:00", "21:30", "22:00", "23:59"]) {
    add(`${monday}T${hhmm}:00Z`, "FOREX", "EURUSD", sessions, `${why} @ Mon ${hhmm}`);
  }
  // the next day, for the cross-midnight tail
  for (const hhmm of ["01:59", "02:00"]) {
    add(`2026-06-30T${hhmm}:00Z`, "FOREX", "EURUSD", sessions, `${why} @ Tue ${hhmm}`);
  }
  // and a configured METALS symbol during its would-be break: configuration wins, break included
  add(`${monday}T21:30:00Z`, "METALS", "XAUUSD", sessions, `${why} @ Mon 21:30 (metals: configuration beats the break)`);
}

// ── the helpers themselves, so a port can be checked piece by piece ──
const helpers = {
  usEasternIsDst: ["2026-03-08T06:59:00Z", "2026-03-08T07:00:00Z", "2026-07-01T12:00:00Z", "2026-11-01T05:59:00Z", "2026-11-01T06:00:00Z", "2026-12-15T12:00:00Z"].map(
    (utc) => ({ utc, value: usEasternIsDst(new Date(utc)) })
  ),
  nyCloseHourUtc: ["2026-07-01T12:00:00Z", "2026-11-15T12:00:00Z"].map((utc) => ({ utc, value: nyCloseHourUtc(new Date(utc)) })),
  dailyBreakHours: (
    [
      ["METALS", "XAUUSD"],
      ["METALS", null],
      ["COMMODITIES", "SpotBrent"],
      ["COMMODITIES", "spotbrent-cash"],
      ["COMMODITIES", "SpotCrude"],
      ["COMMODITIES", null],
      ["FOREX", "EURUSD"],
      ["CRYPTO", "BTCUSD"],
      ["INDICES", "US30"],
      ["STOCKS", "AAPL"],
    ] as [SymbolCategory, string | null][]
  ).map(([category, symbol]) => ({ category, symbol, hours: dailyBreakHours(category, symbol), hasBreak: hasDailyBreak(category, symbol) })),
  isInDailyBreak: [
    { utc: "2026-06-29T21:30:00Z", category: "METALS" as SymbolCategory, symbol: "XAUUSD" },
    { utc: "2026-07-05T21:30:00Z", category: "METALS" as SymbolCategory, symbol: "XAUUSD" },
    { utc: "2026-07-03T21:30:00Z", category: "METALS" as SymbolCategory, symbol: "XAUUSD" },
    { utc: "2026-06-29T23:30:00Z", category: "COMMODITIES" as SymbolCategory, symbol: "SpotBrent" },
    { utc: "2026-06-29T23:30:00Z", category: "COMMODITIES" as SymbolCategory, symbol: "SpotCrude" },
  ].map((c) => ({ ...c, inBreak: isInDailyBreak(new Date(c.utc), c.category, c.symbol) })),
  isDefaultFxSessionClosed: weekly.map(([utc]) => ({ utc, closed: isDefaultFxSessionClosed(new Date(utc)) })),
};

const out = {
  generatedBy: "scripts/contracts/gen-trading-session-vectors.ts",
  note: "the WEB's own lib/risk.ts checkTradingSession and helpers; engine/order-management/tests/trading_session_parity.rs asserts the engine's port against it",
  helpers,
  cases,
};
const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "trading-session-vectors.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}: ${cases.length} cases (${cases.filter((c) => c.closed).length} closed, ${cases.filter((c) => !c.closed).length} open)`);
