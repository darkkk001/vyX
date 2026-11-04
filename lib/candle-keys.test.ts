// Candle de-dup fix 5 (owner 2026-11-05): calendar rows collapse onto the engine's NY-close key (21:00 UTC in US summer
// time, 22:00 UTC otherwise; week = Sunday 00:00 server time; month = the 1st).
import { describe, expect, it } from "vitest";
import { collapseCalendarRows, correctCalendarKey, nyCloseOffsetMs, usSummerTime } from "@/lib/candle-keys";

const u = (iso: string) => Date.parse(iso);
const row = (iso: string, upd = "2026-11-01T00:00:00Z", close = 1) => ({ bucketStart: new Date(iso), updatedAt: new Date(upd), close });

describe("NY-close offset", () => {
  it("follows US summer time: 2nd Sunday of March 07:00 UTC to 1st Sunday of November 06:00 UTC", () => {
    expect(usSummerTime(u("2026-03-08T06:59:59Z"))).toBe(false);
    expect(usSummerTime(u("2026-03-08T07:00:00Z"))).toBe(true);
    expect(usSummerTime(u("2026-11-01T05:59:59Z"))).toBe(true);
    expect(usSummerTime(u("2026-11-01T06:00:00Z"))).toBe(false);
    expect([nyCloseOffsetMs(u("2026-07-01T00:00:00Z")), nyCloseOffsetMs(u("2026-01-15T00:00:00Z"))]).toEqual([3 * 3600_000, 2 * 3600_000]);
  });
});

describe("correctCalendarKey D1", () => {
  it("summer day: the 21:00, 22:00 and 00:00 copies all map to 21:00 UTC the evening before", () => {
    const want = u("2026-07-09T21:00:00Z");
    for (const k of ["2026-07-09T21:00:00Z", "2026-07-09T22:00:00Z", "2026-07-10T00:00:00Z"]) expect(correctCalendarKey("D1", u(k))).toBe(want);
  });
  it("winter day: the 21:00, 22:00 and 00:00 copies all map to 22:00 UTC the evening before", () => {
    const want = u("2026-11-09T22:00:00Z");
    for (const k of ["2026-11-09T21:00:00Z", "2026-11-09T22:00:00Z", "2026-11-10T00:00:00Z"]) expect(correctCalendarKey("D1", u(k))).toBe(want);
  });
  it("a winter day of 2025 stored at 21:00 (the old EA's summer offset) moves to 22:00", () => {
    expect(correctCalendarKey("D1", u("2025-01-14T21:00:00Z"))).toBe(u("2025-01-14T22:00:00Z"));
  });
  it("keeps distinct consecutive days apart", () => {
    expect(correctCalendarKey("D1", u("2026-07-10T21:00:00Z"))).toBe(u("2026-07-10T21:00:00Z"));
  });
});

describe("correctCalendarKey W1 / MN1", () => {
  it("week starts Sunday 00:00 server time at that Sunday's offset", () => {
    // Sunday 2026-07-05 00:00 server (UTC+3) = Saturday 2026-07-04 21:00 UTC
    for (const k of ["2026-07-04T21:00:00Z", "2026-07-04T22:00:00Z", "2026-07-05T00:00:00Z"]) expect(correctCalendarKey("W1", u(k))).toBe(u("2026-07-04T21:00:00Z"));
  });
  it("month starts on the 1st 00:00 server time at that day's offset", () => {
    for (const k of ["2026-01-31T21:00:00Z", "2026-01-31T22:00:00Z", "2026-02-01T00:00:00Z"]) expect(correctCalendarKey("MN1", u(k))).toBe(u("2026-01-31T22:00:00Z"));
  });
  it("other timeframes pass through", () => {
    expect(correctCalendarKey("H1", u("2026-07-10T13:00:00Z"))).toBe(u("2026-07-10T13:00:00Z"));
  });
});

describe("collapseCalendarRows", () => {
  it("three copies of one day become one row on the correct key, preferring the row already there", () => {
    const rows = [row("2026-11-09T21:00:00Z", "2026-11-09T23:00:00Z", 1), row("2026-11-09T22:00:00Z", "2026-11-01T00:00:00Z", 2), row("2026-11-10T00:00:00Z", "2026-11-11T00:00:00Z", 3)];
    const out = collapseCalendarRows("D1", rows);
    expect(out.map((r) => [r.bucketStart.toISOString(), r.close])).toEqual([["2026-11-09T22:00:00.000Z", 2]]);
  });
  it("a lone wrong-key row is shown on the correct key; order stays oldest first", () => {
    const out = collapseCalendarRows("D1", [row("2025-01-13T21:00:00Z"), row("2025-01-14T21:00:00Z")]);
    expect(out.map((r) => r.bucketStart.toISOString())).toEqual(["2025-01-13T22:00:00.000Z", "2025-01-14T22:00:00.000Z"]);
  });
  it("without a row on the key, the most recently updated copy wins", () => {
    const out = collapseCalendarRows("D1", [row("2026-11-09T21:00:00Z", "2026-11-02T00:00:00Z", 1), row("2026-11-10T00:00:00Z", "2026-11-03T00:00:00Z", 3)]);
    expect(out.map((r) => r.close)).toEqual([3]);
  });
  it("H1 rows are untouched", () => {
    const rows = [row("2026-11-09T21:00:00Z"), row("2026-11-09T22:00:00Z")];
    expect(collapseCalendarRows("H1", rows)).toBe(rows);
  });
});
