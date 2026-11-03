"use client";

// Drawing tools step 1 (owner 2026-11-03): the drawing strip on the chart's left edge (spec section 3), our own
// icons. Tools: the lines group (trend, ray, extended, horizontal, horizontal ray, vertical) as a flyout like the
// native terminal's, parallel channel, Fibonacci retracement, rectangle, text. Bottom: magnet (also Ctrl held),
// lock all, hide all, remove all (always confirmed).

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DrawingKind } from "@/lib/chart-drawings";
import type { DrawingsSummary } from "./KLineChartPanel";

const S = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, "aria-hidden": true };
const dot = (x: number, y: number) => <circle cx={x} cy={y} r="1.8" fill="currentColor" stroke="none" />;

const ICONS: Record<DrawingKind, ReactNode> = {
  TrendLine: <svg {...S}><line x1="5" y1="19" x2="19" y2="5" />{dot(5, 19)}{dot(19, 5)}</svg>,
  Ray: <svg {...S}><line x1="5" y1="17" x2="22" y2="6" />{dot(5, 17)}{dot(13, 11.8)}</svg>,
  ExtendedLine: <svg {...S}><line x1="2" y1="20" x2="22" y2="4" />{dot(8, 15.2)}{dot(16, 8.8)}</svg>,
  HorizontalLine: <svg {...S}><line x1="2" y1="12" x2="22" y2="12" />{dot(12, 12)}</svg>,
  HorizontalRay: <svg {...S}><line x1="7" y1="12" x2="22" y2="12" />{dot(7, 12)}</svg>,
  VerticalLine: <svg {...S}><line x1="12" y1="2" x2="12" y2="22" />{dot(12, 12)}</svg>,
  ParallelChannel: <svg {...S}><line x1="3" y1="15" x2="17" y2="5" /><line x1="7" y1="20" x2="21" y2="10" />{dot(3, 15)}{dot(17, 5)}{dot(21, 10)}</svg>,
  Fibonacci: <svg {...S}><line x1="3" y1="5" x2="21" y2="5" /><line x1="3" y1="10" x2="21" y2="10" strokeDasharray="2 2" /><line x1="3" y1="14" x2="21" y2="14" strokeDasharray="2 2" /><line x1="3" y1="19" x2="21" y2="19" /></svg>,
  Rectangle: <svg {...S}><rect x="4" y="6" width="16" height="12" rx="0.5" />{dot(4, 6)}{dot(20, 18)}</svg>,
  Text: <svg {...S}><path d="M5 6V4h14v2" /><line x1="12" y1="4" x2="12" y2="20" /><line x1="9" y1="20" x2="15" y2="20" /></svg>,
};

const LABELS: Record<DrawingKind, string> = {
  TrendLine: "Trend line (Alt+T)",
  Ray: "Ray",
  ExtendedLine: "Extended line",
  HorizontalLine: "Horizontal line (Alt+H)",
  HorizontalRay: "Horizontal ray",
  VerticalLine: "Vertical line (Alt+V)",
  ParallelChannel: "Parallel channel",
  Fibonacci: "Fibonacci retracement (Alt+F)",
  Rectangle: "Rectangle",
  Text: "Text",
};

const LINES: DrawingKind[] = ["TrendLine", "Ray", "ExtendedLine", "HorizontalLine", "HorizontalRay", "VerticalLine"];
const SINGLES: DrawingKind[] = ["ParallelChannel", "Fibonacci", "Rectangle", "Text"];
const LINE_KEY = "vyx-drawing-line-tool";

export default function DrawingToolbar({
  symbol,
  onTool,
  magnet,
  magnetHeld,
  onMagnet,
  hidden,
  onHidden,
  summary,
  onLockAll,
  onRemoveAll,
}: {
  symbol: string;
  onTool: (kind: DrawingKind) => void;
  magnet: boolean;
  magnetHeld: boolean;
  onMagnet: (on: boolean) => void;
  hidden: boolean;
  onHidden: (on: boolean) => void;
  summary: DrawingsSummary;
  onLockAll: (locked: boolean) => void;
  onRemoveAll: () => void;
}) {
  const [lineTool, setLineTool] = useState<DrawingKind>("TrendLine");
  const [flyout, setFlyout] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const v = window.localStorage.getItem(LINE_KEY) as DrawingKind | null;
      if (v && LINES.includes(v)) setLineTool(v);
    } catch {
      // the trend line stays the group's tool
    }
  }, []);
  useEffect(() => {
    if (!flyout && !confirmRemove) return;
    const close = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setFlyout(false);
        setConfirmRemove(false);
      }
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setFlyout(false);
        setConfirmRemove(false);
      }
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", esc);
    };
  }, [flyout, confirmRemove]);

  const pickLine = (k: DrawingKind) => {
    setLineTool(k);
    setFlyout(false);
    try {
      window.localStorage.setItem(LINE_KEY, k);
    } catch {
      // remembered for this page only
    }
    onTool(k);
  };
  const magnetOn = magnet || magnetHeld;

  return (
    <div className="drawing-toolbar" ref={rootRef} role="toolbar" aria-label="Drawing tools" aria-orientation="vertical">
      <div className="dt-group">
        <button type="button" className="draw-tool-btn" title={LABELS[lineTool]} onClick={() => onTool(lineTool)}>
          {ICONS[lineTool]}
        </button>
        <button type="button" className={`dt-more${flyout ? " open" : ""}`} title="Lines" aria-expanded={flyout} aria-label="More line tools" onClick={() => setFlyout((v) => !v)}>
          <svg width="5" height="5" viewBox="0 0 5 5" aria-hidden="true"><path d="M5 0v5H0z" fill="currentColor" /></svg>
        </button>
        {flyout ? (
          <div className="dt-flyout" role="menu" aria-label="Line tools">
            {LINES.map((k) => (
              <button key={k} type="button" role="menuitem" className={`dt-flyout-item${k === lineTool ? " active" : ""}`} onClick={() => pickLine(k)}>
                {ICONS[k]}
                <span>{LABELS[k]}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>
      {SINGLES.map((k) => (
        <button key={k} type="button" className="draw-tool-btn" title={LABELS[k]} onClick={() => onTool(k)}>
          {ICONS[k]}
        </button>
      ))}

      <div className="draw-tool-sep" />
      <button type="button" className={`draw-tool-btn${magnetOn ? " active" : ""}`} aria-pressed={magnetOn} title={magnet ? "Magnet on: anchors snap to open, high, low or close" : "Magnet (or hold Ctrl)"} onClick={() => onMagnet(!magnet)}>
        <svg {...S}><path d="M6 4v8a6 6 0 0 0 12 0V4" /><path d="M6 4h4v8a2 2 0 0 0 4 0V4h4" /><line x1="6" y1="8" x2="10" y2="8" /><line x1="14" y1="8" x2="18" y2="8" /></svg>
      </button>
      <button
        type="button"
        className={`draw-tool-btn${summary.allLocked ? " active" : ""}`}
        aria-pressed={summary.allLocked}
        disabled={summary.count === 0}
        title={summary.allLocked ? "Unlock all drawings" : "Lock all drawings"}
        onClick={() => onLockAll(!summary.allLocked)}
      >
        <svg {...S}><rect x="5" y="11" width="14" height="10" rx="1" />{summary.allLocked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.5-2" />}</svg>
      </button>
      <button type="button" className={`draw-tool-btn${hidden ? " active" : ""}`} aria-pressed={hidden} title={hidden ? "Show drawings" : "Hide all drawings"} onClick={() => onHidden(!hidden)}>
        {hidden ? (
          <svg {...S}><path d="M3 3l18 18" /><path d="M10.6 6.1A9.6 9.6 0 0 1 12 6c5 0 9 6 9 6a16 16 0 0 1-3 3.4M6.6 7.6C4.3 9.2 3 12 3 12s4 6 9 6a8.6 8.6 0 0 0 4-.9" /></svg>
        ) : (
          <svg {...S}><path d="M3 12s4-6 9-6 9 6 9 6-4 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.5" /></svg>
        )}
      </button>
      <div className="dt-group">
        <button type="button" className="draw-tool-btn" disabled={summary.count === 0} title="Remove all drawings" onClick={() => setConfirmRemove((v) => !v)}>
          <svg {...S}><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4h6v2" /></svg>
        </button>
        {confirmRemove ? (
          <div className="dt-confirm" role="dialog" aria-label="Remove all drawings">
            <span>{summary.count === 1 ? `Remove the drawing on ${symbol}?` : `Remove all ${summary.count} drawings on ${symbol}?`}</span>
            <span className="dt-confirm-actions">
              <button type="button" className="dsb-btn" onClick={() => setConfirmRemove(false)}>Cancel</button>
              <button
                type="button"
                className="dsb-btn dsb-danger"
                onClick={() => {
                  setConfirmRemove(false);
                  onRemoveAll();
                }}
              >
                Remove
              </button>
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
