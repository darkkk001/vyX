"use client";

// Drawing tools step 1 (owner 2026-11-03): the floating object toolbar of the selected drawing (spec section 7 item
// 13). Docks at the top-centre of the chart; the grip drags it and the offset is remembered in this browser.
// Colour, width 1 to 4, line style, the text of a Text drawing, lock, clone, delete.

import { useEffect, useRef, useState } from "react";
import { argbToCss, cssToArgb, DEFAULT_DRAWING_COLOR, type Drawing, type LineStyle } from "@/lib/chart-drawings";

export type DrawingStylePatch = Partial<Pick<Drawing, "Color" | "Width" | "Style" | "Locked" | "Text">>;

const SWATCHES = ["#4A7DD6", "#C84A4A", "#F5A623", "#8E6CEF", "#2BB3A3", "#E0559A", "#9AA3B0", "#E6E9EE", "#14181F"];
const STYLES: LineStyle[] = ["Solid", "Dashed", "Dotted"];
const OFFSET_KEY = "vyx-drawing-toolbar";

function readOffset(): [number, number] {
  try {
    const v = JSON.parse(window.localStorage.getItem(OFFSET_KEY) ?? "null");
    if (Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === "number" && Number.isFinite(n))) return [v[0], v[1]];
  } catch {
    // no storage: the bar stays docked
  }
  return [0, 0];
}

function StyleIcon({ style }: { style: LineStyle }) {
  const dash = style === "Dashed" ? "5 3" : style === "Dotted" ? "1.5 2.5" : undefined;
  return (
    <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
      <line x1="1" y1="5" x2="17" y2="5" stroke="currentColor" strokeWidth="1.6" strokeDasharray={dash} strokeLinecap="round" />
    </svg>
  );
}

export default function DrawingStyleBar({
  drawing,
  onChange,
  onClone,
  onDelete,
}: {
  drawing: Drawing;
  onChange: (patch: DrawingStylePatch) => void;
  onClone: () => void;
  onDelete: () => void;
}) {
  const [offset, setOffset] = useState<[number, number]>([0, 0]);
  const [open, setOpen] = useState<"color" | "width" | "style" | null>(null);
  const drag = useRef<{ x: number; y: number; start: [number, number] } | null>(null);
  const barRef = useRef<HTMLDivElement>(null);

  useEffect(() => setOffset(readOffset()), []);
  useEffect(() => setOpen(null), [drawing.Id]);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent) => {
      if (!barRef.current?.contains(e.target as Node)) setOpen(null);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [open]);

  const color = argbToCss(drawing.Color || DEFAULT_DRAWING_COLOR);
  const width = drawing.Width || 1;
  const style = drawing.Style ?? "Solid";
  const locked = drawing.Locked === true;

  const onGripDown = (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, start: offset };
  };
  const onGripMove = (e: React.PointerEvent) => {
    if (!drag.current) return;
    if (e.buttons === 0) {
      drag.current = null;
      return;
    }
    setOffset([drag.current.start[0] + e.clientX - drag.current.x, drag.current.start[1] + e.clientY - drag.current.y]);
  };
  const onGripUp = () => {
    if (!drag.current) return;
    drag.current = null;
    try {
      window.localStorage.setItem(OFFSET_KEY, JSON.stringify(offset));
    } catch {
      // the offset lasts for this page only
    }
  };

  return (
    <div
      ref={barRef}
      className="dsb"
      role="toolbar"
      aria-label="Drawing style"
      style={{ transform: `translate(calc(-50% + ${offset[0]}px), ${offset[1]}px)` }}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <span className="dsb-grip" title="Drag to move" onPointerDown={onGripDown} onPointerMove={onGripMove} onPointerUp={onGripUp} onPointerCancel={onGripUp}>
        <svg width="6" height="14" viewBox="0 0 6 14" aria-hidden="true"><g fill="currentColor"><circle cx="1.5" cy="2" r="1" /><circle cx="4.5" cy="2" r="1" /><circle cx="1.5" cy="7" r="1" /><circle cx="4.5" cy="7" r="1" /><circle cx="1.5" cy="12" r="1" /><circle cx="4.5" cy="12" r="1" /></g></svg>
      </span>

      <span className="dsb-group">
        <button type="button" className="dsb-btn" title="Colour" aria-expanded={open === "color"} disabled={locked} onClick={() => setOpen(open === "color" ? null : "color")}>
          <span className="dsb-swatch" style={{ background: color }} />
        </button>
        {open === "color" ? (
          <span className="dsb-pop dsb-swatches">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                className={`dsb-swatch-btn${cssToArgb(c) === (drawing.Color || DEFAULT_DRAWING_COLOR) ? " active" : ""}`}
                title={c}
                style={{ background: c }}
                onClick={() => {
                  onChange({ Color: cssToArgb(c) });
                  setOpen(null);
                }}
              />
            ))}
          </span>
        ) : null}
      </span>

      {drawing.Kind !== "Text" ? (
        <>
          <span className="dsb-group">
            <button type="button" className="dsb-btn mono" title="Line width" aria-expanded={open === "width"} disabled={locked} onClick={() => setOpen(open === "width" ? null : "width")}>
              {width}px
            </button>
            {open === "width" ? (
              <span className="dsb-pop dsb-list">
                {[1, 2, 3, 4].map((w) => (
                  <button key={w} type="button" className={`dsb-item${w === width ? " active" : ""}`} onClick={() => { onChange({ Width: w }); setOpen(null); }}>
                    <span style={{ display: "inline-block", width: 22, height: w, background: "currentColor", borderRadius: 1 }} />
                    <span className="mono">{w}px</span>
                  </button>
                ))}
              </span>
            ) : null}
          </span>
          <span className="dsb-group">
            <button type="button" className="dsb-btn" title="Line style" aria-expanded={open === "style"} disabled={locked} onClick={() => setOpen(open === "style" ? null : "style")}>
              <StyleIcon style={style} />
            </button>
            {open === "style" ? (
              <span className="dsb-pop dsb-list">
                {STYLES.map((st) => (
                  <button key={st} type="button" className={`dsb-item${st === style ? " active" : ""}`} onClick={() => { onChange({ Style: st }); setOpen(null); }}>
                    <StyleIcon style={st} />
                    <span>{st}</span>
                  </button>
                ))}
              </span>
            ) : null}
          </span>
        </>
      ) : (
        <input
          className="dsb-text"
          aria-label="Text"
          value={drawing.Text ?? ""}
          maxLength={80}
          disabled={locked}
          onChange={(e) => onChange({ Text: e.target.value })}
        />
      )}

      <span className="dsb-sep" />
      <button type="button" className={`dsb-btn${locked ? " active" : ""}`} title={locked ? "Unlock" : "Lock"} aria-pressed={locked} onClick={() => onChange({ Locked: !locked })}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <rect x="5" y="11" width="14" height="10" rx="1" />
          {locked ? <path d="M8 11V7a4 4 0 0 1 8 0v4" /> : <path d="M8 11V7a4 4 0 0 1 7.5-2" />}
        </svg>
      </button>
      <button type="button" className="dsb-btn" title="Clone" onClick={onClone}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="1" /><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3" /></svg>
      </button>
      <button type="button" className="dsb-btn dsb-del" title="Delete (Del)" onClick={onDelete}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M3 6h18" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M9 6V4h6v2" /></svg>
      </button>
    </div>
  );
}
