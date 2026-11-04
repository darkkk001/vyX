// Generates docs/contracts/broker-day-vectors.json from the WEB's own broker-day functions
// (lib/trading-day.ts), so the engine can be pinned to the same instant.
//
// WHY. The daily-loss limit resets on the broker's trading day, and the two sides reach it from
// opposite ends: the ENGINE computes broker-local midnight from the live EA offset
// (market-data/src/lib.rs broker_day_start, which is also what buckets D1 candles), and the WEB reads
// the start of the latest D1 candle the engine wrote, falling back to a fixed 22:00 UTC. They must
// land on the same instant or an account's limit resets at two different times depending on which
// path checked it.
//
//   NODE_OPTIONS=--conditions=react-server \
//   npx tsx --tsconfig tsconfig.json scripts/contracts/gen-broker-day-vectors.ts
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fallbackDayStart, rollDayStart, tradingWeekStart } from "../../lib/trading-day";

// Instants either side of both candidate boundaries, in both seasons, and across a month end.
const INSTANTS = [
  "2026-07-01T20:59:00Z", "2026-07-01T21:00:00Z", "2026-07-01T21:59:00Z", "2026-07-01T22:00:00Z",
  "2026-07-02T00:00:00Z", "2026-07-02T12:00:00Z",
  "2026-11-02T20:59:00Z", "2026-11-02T21:00:00Z", "2026-11-02T21:59:00Z", "2026-11-02T22:00:00Z",
  "2026-11-03T03:30:00Z", "2026-11-30T23:30:00Z", "2026-12-01T00:30:00Z",
  "2026-03-08T07:00:00Z", "2026-11-01T06:00:00Z",
];

const out = {
  generatedBy: "scripts/contracts/gen-broker-day-vectors.ts",
  note: "the WEB's lib/trading-day.ts; engine/order-management/tests/broker_day_parity.rs pins market_data::bucket_start(D1) to it",
  // the web's fixed fallback: the latest 22:00 UTC at or before `now`. A GMT+2 broker server (winter)
  // has its local midnight at exactly that instant, so this is also the engine's answer at offset +2h.
  fallbackDayStart: INSTANTS.map((now) => ({ now, start: fallbackDayStart(new Date(now)).toISOString() })),
  // rolling a known day start (a D1 bucket) forward whole days, which is what the web does when the
  // new day's candle has not formed yet
  rollDayStart: [
    { knownStart: "2026-11-01T22:00:00Z", now: "2026-11-02T21:59:00Z" },
    { knownStart: "2026-11-01T22:00:00Z", now: "2026-11-02T22:00:00Z" },
    { knownStart: "2026-11-01T22:00:00Z", now: "2026-11-05T03:00:00Z" },
    { knownStart: "2026-11-05T22:00:00Z", now: "2026-11-05T21:00:00Z" },
  ].map((c) => ({ ...c, start: rollDayStart(new Date(c.knownStart), new Date(c.now)).toISOString() })),
  tradingWeekStart: ["2026-11-01T22:00:00Z", "2026-11-02T22:00:00Z", "2026-11-06T22:00:00Z", "2026-06-30T21:00:00Z"].map((dayStart) => ({
    dayStart,
    weekStart: tradingWeekStart(new Date(dayStart)).toISOString(),
  })),
};

const file = path.resolve(import.meta.dirname, "..", "..", "docs", "contracts", "broker-day-vectors.json");
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`wrote ${file}: ${out.fallbackDayStart.length} instants, ${out.rollDayStart.length} rolls, ${out.tradingWeekStart.length} weeks`);
