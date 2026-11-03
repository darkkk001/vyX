// WebTrader chart drawings in the shared file format (handoff/chart-drawing-spec.md v2, "one chart spec for every
// app"). One JSON document per account, keyed by upper-case SYMBOL; each drawing is anchored by time (Unix ms) and
// price, never by candle index, so one set serves every timeframe. PascalCase properties; readers are
// case-insensitive, ignore unknown properties, skip (never fail on) an unknown Kind and treat "$..." keys as
// non-symbols. Unknown kinds and properties written by another app are kept when this one writes the list back.
//
// Step 1 (owner 2026-11-03): the klinecharts built-in tools. Step 2 adds the custom tools and the server store.

export type DrawingKind =
  | "TrendLine"
  | "Ray"
  | "ExtendedLine"
  | "HorizontalLine"
  | "HorizontalRay"
  | "VerticalLine"
  | "ParallelChannel"
  | "Fibonacci"
  | "Rectangle"
  | "Text";

export type LineStyle = "Solid" | "Dashed" | "Dotted";

export type DrawingPoint = { T: number; Y: number };

export type Drawing = {
  Id: string;
  Kind: DrawingKind;
  T1: number;
  Y1: number;
  T2?: number;
  Y2?: number;
  Points?: DrawingPoint[] | null;
  Color: number; // ARGB, 0 = the tool's theme default
  Width: number; // px, 0 = default (1)
  Style?: LineStyle;
  Fill?: number;
  ExtendLeft?: boolean;
  ExtendRight?: boolean;
  Locked?: boolean;
  Hidden?: boolean;
  Text?: string | null;
  // another app's fields, kept as they are
  [extra: string]: unknown;
};

export type DrawingsDoc = Record<string, unknown>;

// a klinecharts overlay point: what the chart hands back and accepts
export type ChartPoint = { timestamp?: number; value?: number };

// the klinecharts overlay behind each tool (9.8.12 registry; "vyxRect" is registered in KLineChartPanel.tsx)
export const KIND_TO_OVERLAY: Record<DrawingKind, string> = {
  TrendLine: "segment",
  Ray: "rayLine",
  ExtendedLine: "straightLine",
  HorizontalLine: "horizontalStraightLine",
  HorizontalRay: "horizontalRayLine",
  VerticalLine: "verticalStraightLine",
  ParallelChannel: "parallelStraightLine",
  Fibonacci: "fibonacciLine",
  Rectangle: "vyxRect",
  Text: "simpleAnnotation",
};

const OVERLAY_TO_KIND: Record<string, DrawingKind> = Object.fromEntries(
  Object.entries(KIND_TO_OVERLAY).map(([k, o]) => [o, k as DrawingKind])
);
// the names the first WebTrader toolbar saved under
OVERLAY_TO_KIND.rect = "Rectangle";

export const KINDS = Object.keys(KIND_TO_OVERLAY) as DrawingKind[];

export function kindOfOverlay(name: string): DrawingKind | null {
  return OVERLAY_TO_KIND[name] ?? null;
}

// how many anchors each tool takes (klinecharts' totalStep - 1)
export const KIND_ANCHORS: Record<DrawingKind, number> = {
  TrendLine: 2,
  Ray: 2,
  ExtendedLine: 2,
  HorizontalLine: 1,
  HorizontalRay: 2, // klinecharts' horizontalRayLine: the start, then a click on the side it runs to
  VerticalLine: 1,
  ParallelChannel: 3,
  Fibonacci: 2,
  Rectangle: 2,
  Text: 1,
};

const PROPS = [
  "Id", "Kind", "T1", "Y1", "T2", "Y2", "Points", "Color", "Width", "Style", "Opacity", "Fill", "ExtendLeft",
  "ExtendRight", "Locked", "Hidden", "Text", "FontSize", "Levels", "Lots",
];
const CANON = new Map(PROPS.map((p) => [p.toLowerCase(), p]));

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function newDrawingId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

// one stored item -> a Drawing this app draws, or null when it can't (unknown Kind, missing anchors)
export function normalizeDrawing(raw: unknown): Drawing | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const d: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) d[CANON.get(k.toLowerCase()) ?? k] = v;
  const kind = KINDS.find((k) => k.toLowerCase() === String(d.Kind ?? "").toLowerCase());
  if (!kind || !isNum(d.T1) || !isNum(d.Y1)) return null;
  const n = KIND_ANCHORS[kind];
  if (n >= 2 && !(isNum(d.T2) && isNum(d.Y2))) return null;
  const points = Array.isArray(d.Points)
    ? (d.Points as unknown[]).flatMap((p) => {
        if (!p || typeof p !== "object") return [];
        const q = Object.fromEntries(Object.entries(p as Record<string, unknown>).map(([k, v]) => [k.toUpperCase(), v]));
        return isNum(q.T) && isNum(q.Y) ? [{ T: q.T, Y: q.Y }] : [];
      })
    : null;
  if (n >= 3 && (!points || points.length < n - 2)) return null;
  const style = (["Solid", "Dashed", "Dotted"] as const).find((s) => s.toLowerCase() === String(d.Style ?? "").toLowerCase());
  return {
    ...d,
    Id: typeof d.Id === "string" && d.Id ? d.Id : newDrawingId(),
    Kind: kind,
    T1: d.T1,
    Y1: d.Y1,
    ...(isNum(d.T2) ? { T2: d.T2 } : {}),
    ...(isNum(d.Y2) ? { Y2: d.Y2 } : {}),
    Points: points,
    Color: isNum(d.Color) ? d.Color >>> 0 : 0,
    Width: isNum(d.Width) && d.Width > 0 ? d.Width : 0,
    ...(style ? { Style: style } : {}),
    Locked: d.Locked === true,
    Hidden: d.Hidden === true,
  } as Drawing;
}

// the symbol's list: what this app draws, and the items it must keep but can't draw
export function symbolDrawings(doc: DrawingsDoc, symbol: string): { drawings: Drawing[]; kept: unknown[] } {
  const key = Object.keys(doc).find((k) => !k.startsWith("$") && k.toUpperCase() === symbol.toUpperCase());
  const list = key ? doc[key] : undefined;
  const drawings: Drawing[] = [];
  const kept: unknown[] = [];
  if (Array.isArray(list)) for (const item of list) {
    const d = normalizeDrawing(item);
    if (d) drawings.push(d);
    else kept.push(item);
  }
  return { drawings, kept };
}

export function withSymbolDrawings(doc: DrawingsDoc, symbol: string, drawings: Drawing[], kept: unknown[] = []): DrawingsDoc {
  const out: DrawingsDoc = {};
  for (const [k, v] of Object.entries(doc)) if (k.startsWith("$") || k.toUpperCase() !== symbol.toUpperCase()) out[k] = v;
  const list = [...drawings, ...kept];
  if (list.length > 0) out[symbol.toUpperCase()] = list;
  return out;
}

export function parseDrawingsDoc(raw: string | null): DrawingsDoc {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as DrawingsDoc) : {};
  } catch {
    return {};
  }
}

export function drawingsStorageKey(host: string, account: string): string {
  return `vyx-drawings@${host}_${account}`;
}

// ---- colours: the file stores ARGB as an unsigned int, the chart takes CSS colours

export function argbToCss(argb: number): string {
  const a = (argb >>> 24) & 0xff;
  const hex = `#${(argb & 0xffffff).toString(16).padStart(6, "0").toUpperCase()}`;
  if (a === 0xff) return hex;
  return `rgba(${(argb >>> 16) & 0xff}, ${(argb >>> 8) & 0xff}, ${argb & 0xff}, ${Math.round((a / 255) * 1000) / 1000})`;
}

export function cssToArgb(css: string): number {
  const hex = /^#([0-9a-f]{6})$/i.exec(css.trim());
  if (hex) return (0xff000000 | parseInt(hex[1], 16)) >>> 0;
  const rgba = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(css.trim());
  if (!rgba) return 0;
  const alpha = rgba[4] === undefined ? 255 : Math.round(Math.min(1, Math.max(0, parseFloat(rgba[4]))) * 255);
  return ((alpha << 24) | (Number(rgba[1]) << 16) | (Number(rgba[2]) << 8) | Number(rgba[3])) >>> 0;
}

export function withAlpha(argb: number, alpha: number): number {
  return (((Math.round(alpha * 255) & 0xff) << 24) | (argb & 0xffffff)) >>> 0;
}

// ---- drawing <-> klinecharts overlay

export type OverlayStyles = Record<string, Record<string, unknown>>;

const DASH: Record<LineStyle, number[] | null> = { Solid: null, Dashed: [6, 4], Dotted: [1, 3] };

// the theme default when Color is 0 (the native's drawing blue)
export const DEFAULT_DRAWING_COLOR = 0xff4a7dd6;

export function overlayStyles(d: Pick<Drawing, "Color" | "Width" | "Style" | "Fill" | "Kind">): OverlayStyles {
  const color = argbToCss(d.Color || DEFAULT_DRAWING_COLOR);
  const size = d.Width || 1;
  const dash = DASH[d.Style ?? "Solid"];
  const line = { color, size, style: dash ? "dashed" : "solid", dashedValue: dash ?? [2, 2] };
  const fill = argbToCss(d.Fill || withAlpha(d.Color || DEFAULT_DRAWING_COLOR, 0.12));
  return {
    line,
    // the rectangle's box
    polygon: { style: "stroke_fill", color: fill, borderColor: color, borderSize: size, borderStyle: line.style, borderDashedValue: line.dashedValue },
    // klinecharts paints the selected drawing's time / price range on the axes with this: kept faint
    rect: { style: "fill", color: argbToCss(withAlpha(d.Color || DEFAULT_DRAWING_COLOR, 0.15)), borderSize: 0 },
    // level labels (Fibonacci) and the Text tool: plain text in the drawing's colour, as on the native chart (the
    // library default is a white label on a filled chip)
    text: {
      style: "fill",
      color,
      size: 11,
      family: "'JetBrains Mono', ui-monospace, monospace",
      backgroundColor: "rgba(0, 0, 0, 0)",
      borderColor: "rgba(0, 0, 0, 0)",
      borderSize: 0,
      paddingLeft: 2,
      paddingRight: 2,
      paddingTop: 1,
      paddingBottom: 1,
    },
  };
}

export function drawingToChartPoints(d: Drawing): ChartPoint[] {
  const pts: ChartPoint[] = [{ timestamp: d.T1, value: d.Y1 }];
  if (KIND_ANCHORS[d.Kind] >= 2 && d.T2 !== undefined && d.Y2 !== undefined) pts.push({ timestamp: d.T2, value: d.Y2 });
  for (const p of d.Points ?? []) pts.push({ timestamp: p.T, value: p.Y });
  return pts.slice(0, KIND_ANCHORS[d.Kind]);
}

// the chart's anchors -> the file's T1/Y1, T2/Y2 and Points (anchors after the first two; spec section 6.1).
// A parallel channel's third anchor is stored as the point on line B at line A's right end (spec section 8 item 9).
export function anchorsFromChartPoints(kind: DrawingKind, points: ChartPoint[]): Pick<Drawing, "T1" | "Y1" | "T2" | "Y2" | "Points"> | null {
  const pts = points.filter((p): p is { timestamp: number; value: number } => isNum(p.timestamp) && isNum(p.value));
  if (pts.length < KIND_ANCHORS[kind]) return null;
  const [a, b, c] = pts;
  if (KIND_ANCHORS[kind] === 1) return { T1: a.timestamp, Y1: a.value, Points: null };
  if (kind === "ParallelChannel") {
    const slope = b.timestamp === a.timestamp ? 0 : (b.value - a.value) / (b.timestamp - a.timestamp);
    const right = a.timestamp >= b.timestamp ? a : b;
    const yOnB = c.value + slope * (right.timestamp - c.timestamp);
    return { T1: a.timestamp, Y1: a.value, T2: b.timestamp, Y2: b.value, Points: [{ T: right.timestamp, Y: yOnB }] };
  }
  return { T1: a.timestamp, Y1: a.value, T2: b.timestamp, Y2: b.value, Points: null };
}

// what each built-in draws past its anchors, recorded so another app draws the same thing
export function kindExtends(kind: DrawingKind): Pick<Drawing, "ExtendLeft" | "ExtendRight"> {
  switch (kind) {
    case "Ray":
      return { ExtendLeft: false, ExtendRight: true };
    case "ExtendedLine":
    case "ParallelChannel":
      return { ExtendLeft: true, ExtendRight: true };
    default:
      return {};
  }
}

// the first WebTrader toolbar's per-symbol+timeframe localStorage lists ({name, points, styles, lock}) -> Drawings
export function legacyToDrawings(lists: unknown[]): Drawing[] {
  const out: Drawing[] = [];
  const seen = new Set<string>();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const o of list as Array<{ name?: string; points?: ChartPoint[]; styles?: { line?: { color?: string; size?: number } }; lock?: boolean }>) {
      const kind = o && typeof o.name === "string" ? kindOfOverlay(o.name) : null;
      if (!kind || !Array.isArray(o.points)) continue;
      const anchors = anchorsFromChartPoints(kind, o.points);
      if (!anchors) continue;
      const sig = `${kind}:${JSON.stringify(anchors)}`;
      if (seen.has(sig)) continue;
      seen.add(sig);
      const color = o.styles?.line?.color ? cssToArgb(o.styles.line.color) : 0;
      out.push({ Id: newDrawingId(), Kind: kind, ...anchors, ...kindExtends(kind), Color: color, Width: o.styles?.line?.size ?? 0, Locked: o.lock === true, Hidden: false });
    }
  }
  return out;
}

export const LEGACY_STORAGE_PREFIX = "vyx-chart-drawings:";
