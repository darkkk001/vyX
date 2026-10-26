import { describe, expect, it } from "vitest";
import { parseDashRange, rangeJson } from "@/lib/dash-range";

const dayStart = new Date("2026-10-26T21:00:00Z"); // Tuesday 2026-10-27's trading day (EDT, NY 17:00)
const sp = (q: string) => new URLSearchParams(q);
const iso = (r: ReturnType<typeof parseDashRange>) => ("error" in r ? r : rangeJson(r));

describe("parseDashRange", () => {
  it("TODAY starts at today's trading day; nD counts whole trading days including today", () => {
    expect(iso(parseDashRange(sp("range=today"), dayStart, "30D"))).toEqual({ key: "TODAY", from: "2026-10-26T21:00:00.000Z", to: null });
    expect(iso(parseDashRange(sp("range=7D"), dayStart, "30D"))).toEqual({ key: "7D", from: "2026-10-20T21:00:00.000Z", to: null });
    expect(iso(parseDashRange(sp("range=1Y"), dayStart, "30D"))).toMatchObject({ key: "1Y", from: "2025-10-27T21:00:00.000Z" });
  });

  it("the Dealing chips' aliases: 1D = TODAY, 1M = 30D", () => {
    expect(iso(parseDashRange(sp("range=1D"), dayStart, "30D"))).toMatchObject({ key: "TODAY", from: "2026-10-26T21:00:00.000Z" });
    expect(iso(parseDashRange(sp("range=1m"), dayStart, "7D"))).toMatchObject({ key: "30D" });
    expect(iso(parseDashRange(sp("range=5D"), dayStart, "7D"))).toMatchObject({ key: "5D", from: "2026-10-22T21:00:00.000Z" });
  });

  it("no parameter is the caller's default", () => {
    expect(iso(parseDashRange(sp(""), dayStart, "30D"))).toEqual({ key: "30D", from: "2026-09-27T21:00:00.000Z", to: null });
  });

  it("from / to is CUSTOM, half-open, to optional", () => {
    expect(iso(parseDashRange(sp("from=2026-10-01&to=2026-10-08"), dayStart, "30D"))).toEqual({ key: "CUSTOM", from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z" });
    expect(iso(parseDashRange(sp("from=2026-10-01T21:00:00Z"), dayStart, "30D"))).toEqual({ key: "CUSTOM", from: "2026-10-01T21:00:00.000Z", to: null });
  });

  it("bad input is a one-line error", () => {
    expect(parseDashRange(sp("range=2W"), dayStart, "30D")).toEqual({ error: "range must be one of TODAY, 3D, 5D, 7D, 30D, 90D, 1Y" });
    expect(parseDashRange(sp("to=2026-10-08"), dayStart, "30D")).toEqual({ error: "from is required with to" });
    expect(parseDashRange(sp("from=2026-10-08&to=2026-10-01"), dayStart, "30D")).toEqual({ error: "to must be later than from" });
    expect(parseDashRange(sp("from=yesterday"), dayStart, "30D")).toHaveProperty("error");
  });
});
