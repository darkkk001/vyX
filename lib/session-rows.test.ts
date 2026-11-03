import { describe, expect, it } from "vitest";
import { sessionRows, utcClock } from "./session-rows";

describe("sessionRows", () => {
  it("shows open sessions as OPEN and the rest with their next open time and the wait", () => {
    const rows = sessionRows(new Date(Date.UTC(2026, 10, 3, 15, 38)));
    expect(rows.map((r) => [r.name, r.open])).toEqual([["Sydney", false], ["Tokyo", false], ["London", true], ["New York", true]]);
    expect(rows[0]).toMatchObject({ opensAt: "22:00", opensIn: "6H22M" });
    expect(rows[1]).toMatchObject({ opensAt: "00:00", opensIn: "8H22M" });
  });

  it("treats a session that wraps midnight as open on both sides of it", () => {
    expect(sessionRows(new Date(Date.UTC(2026, 10, 3, 23, 5)))[0].open).toBe(true);
    expect(sessionRows(new Date(Date.UTC(2026, 10, 4, 6, 59)))[0].open).toBe(true);
    expect(sessionRows(new Date(Date.UTC(2026, 10, 4, 7, 0)))[0].open).toBe(false);
  });

  it("formats the UTC clock with two digits", () => {
    expect(utcClock(new Date(Date.UTC(2026, 10, 3, 4, 7)))).toBe("04:07");
  });
});
