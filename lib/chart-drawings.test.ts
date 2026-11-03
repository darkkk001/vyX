import { describe, expect, it } from "vitest";
import {
  anchorsFromChartPoints,
  argbToCss,
  cssToArgb,
  drawingToChartPoints,
  KIND_TO_OVERLAY,
  kindOfOverlay,
  legacyToDrawings,
  normalizeDrawing,
  parseDrawingsDoc,
  symbolDrawings,
  withSymbolDrawings,
} from "./chart-drawings";

const spec = { Id: "3f9c1a2b7d4e", Kind: "TrendLine", T1: 1793001600000, Y1: 4012.5, T2: 1793016000000, Y2: 4019.9, Color: 4293292846, Width: 1.5, Style: "Dashed", Opacity: 1, ExtendLeft: false, ExtendRight: true, Locked: false, Hidden: false };

describe("chart-drawings file format", () => {
  it("reads the spec's example drawing as it is", () => {
    const d = normalizeDrawing(spec)!;
    expect(d).toMatchObject({ Id: "3f9c1a2b7d4e", Kind: "TrendLine", T1: 1793001600000, Y2: 4019.9, Color: 4293292846, Width: 1.5, Style: "Dashed", ExtendRight: true });
  });

  it("reads property names case-insensitively and keeps unknown properties", () => {
    const d = normalizeDrawing({ id: "a1", kind: "horizontalline", t1: 1, y1: 2, color: 0, Gadget: 7 })!;
    expect(d.Kind).toBe("HorizontalLine");
    expect(d.Y1).toBe(2);
    expect(d.Gadget).toBe(7);
  });

  it("skips an unknown Kind or missing anchors but keeps it when the list is written back", () => {
    const doc = { XAUUSD: [spec, { Kind: "Pitchfork", T1: 1, Y1: 1, T2: 2, Y2: 2, Points: [{ T: 3, Y: 3 }] }, { Kind: "TrendLine", T1: 1, Y1: 1 }], $defaults: { TrendLine: {} } };
    const { drawings, kept } = symbolDrawings(doc, "xauusd");
    expect(drawings.map((d) => d.Kind)).toEqual(["TrendLine"]);
    expect(kept).toHaveLength(2);
    const next = withSymbolDrawings(doc, "XAUUSD", [], kept);
    expect(next.XAUUSD).toEqual(kept);
    expect(next.$defaults).toEqual({ TrendLine: {} });
  });

  it("never treats a $ key as a symbol and drops an emptied symbol", () => {
    expect(symbolDrawings({ $sync: [spec] }, "$sync").drawings).toEqual([]);
    expect(withSymbolDrawings({ XAUUSD: [spec] }, "XAUUSD", [])).toEqual({});
  });

  it("survives bad storage", () => {
    expect(parseDrawingsDoc("not json")).toEqual({});
    expect(parseDrawingsDoc("[1,2]")).toEqual({});
    expect(parseDrawingsDoc(null)).toEqual({});
  });
});

describe("colours", () => {
  it("round-trips ARGB through CSS", () => {
    expect(argbToCss(0xff4a7dd6)).toBe("#4A7DD6");
    expect(cssToArgb("#4A7DD6")).toBe(0xff4a7dd6);
    expect(cssToArgb(argbToCss(0x804a7dd6))).toBe(0x804a7dd6);
    expect(cssToArgb("rgba(74, 125, 214, 0.5)")).toBe(0x804a7dd6);
    expect(cssToArgb("nonsense")).toBe(0);
  });
});

describe("anchors", () => {
  it("maps every tool to an overlay and back", () => {
    for (const [kind, overlay] of Object.entries(KIND_TO_OVERLAY)) expect(kindOfOverlay(overlay)).toBe(kind);
    expect(kindOfOverlay("rect")).toBe("Rectangle");
    expect(kindOfOverlay("priceLine")).toBeNull();
  });

  it("stores one-anchor tools as T1/Y1 only", () => {
    expect(anchorsFromChartPoints("HorizontalLine", [{ timestamp: 10, value: 5 }])).toEqual({ T1: 10, Y1: 5, Points: null });
  });

  it("stores a parallel channel's third anchor as the point on line B at line A's right end", () => {
    // line A rises 1 per ms from (0, 100) to (10, 110); the width point (4, 90) sits on line B
    const a = anchorsFromChartPoints("ParallelChannel", [{ timestamp: 0, value: 100 }, { timestamp: 10, value: 110 }, { timestamp: 4, value: 90 }])!;
    expect(a.Points).toEqual([{ T: 10, Y: 96 }]);
    const pts = drawingToChartPoints({ Id: "x", Kind: "ParallelChannel", Color: 0, Width: 0, ...a });
    expect(pts).toEqual([{ timestamp: 0, value: 100 }, { timestamp: 10, value: 110 }, { timestamp: 10, value: 96 }]);
  });

  it("refuses an unfinished shape", () => {
    expect(anchorsFromChartPoints("TrendLine", [{ timestamp: 1, value: 1 }])).toBeNull();
  });
});

describe("legacy import", () => {
  it("turns the old per-timeframe lists into one de-duplicated symbol list", () => {
    const seg = { name: "segment", points: [{ timestamp: 1, value: 2, dataIndex: 5 }, { timestamp: 3, value: 4, dataIndex: 7 }], styles: { line: { color: "#FF0000", size: 2 } } };
    const out = legacyToDrawings([[seg, { name: "priceLine", points: [] }], [seg, { name: "rect", points: [{ timestamp: 1, value: 1 }, { timestamp: 2, value: 2 }] }]]);
    expect(out.map((d) => d.Kind)).toEqual(["TrendLine", "Rectangle"]);
    expect(out[0]).toMatchObject({ T1: 1, Y1: 2, T2: 3, Y2: 4, Color: 0xffff0000, Width: 2 });
    expect(out[0].Id).toMatch(/^[0-9a-f]{12}$/);
  });
});
