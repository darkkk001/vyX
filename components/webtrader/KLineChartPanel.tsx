"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { init, dispose, ActionType } from "klinecharts";
import type { Candle } from "@/lib/market-simulator";

export type ChartLine = {
  id: string;
  price: number;
  color: string;
  dashed?: boolean;
};

// chart-polish round -- "trendLine" and "rectangle" were never real
// klinecharts overlay names in the installed version (9.8.12) -- checked
// against its actual registry (node_modules/klinecharts/dist/index.esm.js,
// no type export lists these; the real names only exist in the bundled
// JS). createOverlay silently returned null for both, every time, with no
// error anywhere -- confirmed live via a temporary diagnostic log before
// this fix, exactly the "don't merge on unit tests alone" class of bug:
// nothing here is unit-testable (klinecharts itself isn't under test),
// only a real browser click ever exercises this path. The real registered
// names are "segment" (a plain two-point line, the closest built-in match
// to a "trend line" -- klinecharts has no overlay named exactly that) and
// "rect".
export type DrawingOverlayName =
  | "segment"
  | "horizontalStraightLine"
  | "fibonacciLine"
  | "rect"
  | "simpleAnnotation";

export type KLineChartHandle = {
  addOverlay: (name: DrawingOverlayName) => void;
  removeAllDrawings: () => void;
  toggleMA: () => boolean;
};

// chart-polish round -- the slice of klinecharts' real Overlay/OverlayEvent
// shape (node_modules/klinecharts/dist/index.d.ts) this file actually
// reads. The chart instance itself stays `any` (see the component's own
// doc comment on why), but these two shapes are narrow and stable enough
// to type properly instead of reaching for `any` at every overlay
// callback site.
type OverlaySnapshot = { name: string; points: unknown; styles: unknown; lock?: boolean };
type OverlayLifecycleEvent = { overlay: { id: string } };

type Props = {
  candles: Candle[];
  // fix/realtime-sync §3 -- the single source of truth for "what does the
  // currently-forming bar look like right now": lib/market-simulator.ts's
  // applyBidAsk replaces (not mutates) candles[candles.length - 1] on
  // every real tick specifically so this prop's reference changes exactly
  // when there's a genuinely new bar to push, independent of whether
  // `candles` itself (the full-history array, keyed for the reset effect
  // below) changed reference. Optional only for a caller with no live
  // data at all (shouldn't happen in practice, but avoids a required prop
  // silently becoming `undefined` at every call site if one is ever
  // added without it).
  latestBar?: Candle;
  // chart-polish round -- storage key scoping for user-drawn overlays
  // (see the persistence effect below). Not used for anything else; the
  // dev-only broker-time drift assertion still infers its own period from
  // history rather than taking timeframe as a prop, unrelated to this.
  symbol: string;
  timeframe: string;
  digits: number;
  lines: ChartLine[];
  onContextMenuPrice?: (price: number, clientX: number, clientY: number) => void;
  // fix/realtime-sync §6 -- WebTrader.tsx closes its chart context menu on
  // this (a pan/zoom moving the chart underneath an open menu positioned
  // at a now-stale coordinate is worse than just closing it). A wheel-
  // zoom has no pointerdown at all, so the generic outside-click dismiss
  // every other menu in this file uses can't catch it -- this hooks
  // klinecharts' own action system directly instead.
  onPanOrZoom?: () => void;
};

// Thin React wrapper around klinecharts (free, open-source — no license
// approval needed unlike TradingView's own Charting Library). Replaces the
// hand-rolled <canvas> renderer: zoom/pan/crosshair come from the library,
// this component only owns data feeding, position/order price lines, and
// exposing drawing-tool/indicator actions to WebTrader's toolbar.
//
// The klinecharts instance is held as `any` deliberately — its public
// TypeScript surface for less-common calls (indicators, overlays, pixel
// conversion) isn't pinned against a verified version here, and a signature
// mismatch against strict types would fail the whole build rather than
// just this one feature at runtime.
const KLineChartPanel = forwardRef<KLineChartHandle, Props>(function KLineChartPanel(
  { candles, latestBar, symbol, timeframe, digits, lines, onContextMenuPrice, onPanOrZoom },
  ref
) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartRef = useRef<any>(null);
  const maOnRef = useRef(false);
  const lineIdsRef = useRef<string[]>([]);
  const userOverlayIdsRef = useRef<string[]>([]);
  const onContextMenuPriceRef = useRef(onContextMenuPrice);
  onContextMenuPriceRef.current = onContextMenuPrice;
  const onPanOrZoomRef = useRef(onPanOrZoom);
  onPanOrZoomRef.current = onPanOrZoom;
  // Always read the *current* symbol/timeframe from inside overlay
  // callbacks set up once at createOverlay time -- a callback closes over
  // whatever symbol/timeframe were in scope when the overlay was drawn,
  // which goes stale the moment the trader switches symbol or timeframe.
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const timeframeRef = useRef(timeframe);
  timeframeRef.current = timeframe;
  // The single overlay currently mid-draw (set on the first click of a
  // multi-point tool, cleared on the last click) -- Escape cancels this
  // one specifically, never a finished, already-selectable drawing.
  const drawingOverlayIdRef = useRef<string | null>(null);
  // The user-drawn overlay currently selected (klinecharts shows its
  // handles) -- Delete/Backspace removes this one. Never a system line
  // (SL/TP/order/last-price): all of those are created with lock: true,
  // which klinecharts itself already excludes from selection entirely.
  const selectedOverlayIdRef = useRef<string | null>(null);

  // chart-polish round -- drawings persist per symbol+timeframe in
  // localStorage. Phase 5 moves this server-side (a trader's drawings
  // should follow them across devices/sessions); this is deliberately
  // client-only for now, same scoping precedent as watchlist
  // order/column prefs elsewhere in WebTrader.tsx.
  function storageKey() {
    return `vyx-chart-drawings:${symbolRef.current}:${timeframeRef.current}`;
  }

  function persistDrawings() {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      const saved = userOverlayIdsRef.current
        .map((id) => chart.getOverlayById?.(id) as OverlaySnapshot | null | undefined)
        .filter((o): o is OverlaySnapshot => Boolean(o))
        .map((o) => ({ name: o.name, points: o.points, styles: o.styles, lock: o.lock }));
      window.localStorage.setItem(storageKey(), JSON.stringify(saved));
    } catch {
      // private browsing / quota / no localStorage -- drawings just won't
      // survive a reload this session, not worth surfacing as an error
    }
  }

  // Shared by every path that creates a user-drawn overlay (the toolbar's
  // addOverlay and this component's own persisted-drawing restore below)
  // so both stay selectable, Escape/Delete-able, and kept in sync with
  // localStorage the same way regardless of how they were created. Every
  // callback returns false -- "observed, don't suppress klinecharts' own
  // default handling" -- these only ever track state and persist, never
  // change what a click/drag/keypress does.
  function overlayLifecycleCallbacks() {
    return {
      onDrawStart: (event: OverlayLifecycleEvent) => {
        drawingOverlayIdRef.current = event.overlay.id;
        return false;
      },
      onDrawEnd: () => {
        drawingOverlayIdRef.current = null;
        persistDrawings();
        return false;
      },
      onSelected: (event: OverlayLifecycleEvent) => {
        selectedOverlayIdRef.current = event.overlay.id;
        return false;
      },
      onDeselected: () => {
        selectedOverlayIdRef.current = null;
        return false;
      },
      onRemoved: (event: OverlayLifecycleEvent) => {
        const id = event.overlay.id;
        userOverlayIdsRef.current = userOverlayIdsRef.current.filter((existing) => existing !== id);
        if (selectedOverlayIdRef.current === id) selectedOverlayIdRef.current = null;
        if (drawingOverlayIdRef.current === id) drawingOverlayIdRef.current = null;
        persistDrawings();
        return false;
      },
      onPressedMoveEnd: () => {
        persistDrawings(); // repositioning an existing drawing also needs re-saving
        return false;
      },
    };
  }

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    // Same mono stack as the rest of the terminal's .mono class
    // (app/(broker)/trade/webtrader.css) -- axis ticks, the crosshair's
    // price/time labels, and the last-price badge all read as numbers, so
    // they get the same tabular font as every other number in the app
    // instead of the browser's default sans-serif.
    const MONO_FONT = "'JetBrains Mono', ui-monospace, monospace";
    const AXIS_TEXT_COLOR = "#5A6472"; // --text-3
    const chart = init(el, {
      // Cast: klinecharts' style option types are deep partials of its own
      // internal theme shape, not worth pinning exactly here — a mismatch
      // would otherwise fail the whole build over a color value.
      styles: {
        grid: { horizontal: { color: "rgba(255,255,255,0.05)" }, vertical: { show: false } },
        candle: {
          bar: {
            upColor: "#16C784",
            downColor: "#EA3943",
            noChangeColor: "#5A6472",
            upBorderColor: "#16C784",
            downBorderColor: "#EA3943",
            noChangeBorderColor: "#5A6472",
            upWickColor: "#16C784",
            downWickColor: "#EA3943",
            noChangeWickColor: "#5A6472",
          },
          priceMark: {
            // chart-polish round -- re-enabled now that the tick->bar sync
            // bug (hotfix/terminal-live-bugs, hotfix/history-broker-time)
            // is fixed and browser-verified: applyBidAsk sets latestBar.c
            // to MarketState.bid on every tick, so this bar-driven line is
            // now provably the same value as the live tick, with the
            // added benefit (missing from the round-2 custom overlay this
            // replaces) of the axis price badge every other trading chart
            // has -- klinecharts only draws that badge as part of this
            // built-in feature, not as a separate overlay.
            last: {
              show: true,
              upColor: "#16C784",
              downColor: "#EA3943",
              noChangeColor: "#5A6472",
              line: { show: true, style: "dashed", size: 1, dashedValue: [4, 4] },
              text: { show: true, color: "#0B0F14", size: 11, family: MONO_FONT, weight: 600, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
            },
            high: { color: AXIS_TEXT_COLOR, textFamily: MONO_FONT, textSize: 11 },
            low: { color: AXIS_TEXT_COLOR, textFamily: MONO_FONT, textSize: 11 },
          },
        },
        xAxis: {
          axisLine: { color: "rgba(255,255,255,0.08)" },
          tickText: { color: AXIS_TEXT_COLOR, family: MONO_FONT, size: 11, marginStart: 4, marginEnd: 4 },
        },
        yAxis: {
          axisLine: { color: "rgba(255,255,255,0.08)" },
          tickText: { color: AXIS_TEXT_COLOR, family: MONO_FONT, size: 11, marginStart: 4, marginEnd: 6 },
        },
        crosshair: {
          horizontal: {
            line: { color: AXIS_TEXT_COLOR },
            text: { show: true, color: "#0B0F14", backgroundColor: AXIS_TEXT_COLOR, family: MONO_FONT, size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
          },
          vertical: {
            line: { color: AXIS_TEXT_COLOR },
            text: { show: true, color: "#0B0F14", backgroundColor: AXIS_TEXT_COLOR, family: MONO_FONT, size: 11, paddingLeft: 4, paddingRight: 4, paddingTop: 2, paddingBottom: 2, borderRadius: 2 },
          },
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    chartRef.current = chart ?? null;

    const onResize = () => {
      try {
        chartRef.current?.resize?.();
      } catch {
        // ignore
      }
    };
    window.addEventListener("resize", onResize);

    // klinecharts sizes its canvas from the container's box at init time
    // and otherwise only ever re-measures on a real *window* resize --
    // dragging WebTrader's own bottom-panel resizer changes this
    // container's height without the browser window changing size at
    // all, so the canvas kept its stale (pre-drag) dimensions and visibly
    // overlapped the panel that grew into its old space. A ResizeObserver
    // catches every container-size change regardless of cause.
    const containerObserver = new ResizeObserver(onResize);
    containerObserver.observe(el);

    const onContextMenu = (e: MouseEvent) => {
      if (!onContextMenuPriceRef.current || !chartRef.current || !el) return;
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      try {
        const converted = chartRef.current.convertFromPixel(
          { x: e.clientX - rect.left, y: e.clientY - rect.top },
          { paneId: "candle_pane" }
        );
        const price = Array.isArray(converted) ? converted[0]?.value : converted?.value;
        if (typeof price === "number") onContextMenuPriceRef.current(price, e.clientX, e.clientY);
      } catch {
        // conversion can fail if the pane isn't ready yet — ignore, no menu
      }
    };
    el.addEventListener("contextmenu", onContextMenu);

    // chart-polish round -- persistence's real trigger. onDrawEnd (the
    // overlay lifecycle callback that looks like the obvious place to
    // persist "a drawing just finished") turned out unreliable in a real
    // browser: after an Escape-cancelled draw removes a still-in-progress
    // overlay via removeOverlay, the *next* overlay's own onDrawEnd
    // sometimes never fires at all, even though the shape completes
    // correctly on screen -- confirmed by instrumenting every overlay
    // callback and reproducing it live, not from reading klinecharts'
    // source alone. A plain click listener on the chart's own container
    // sidesteps that entirely: it doesn't care which (if any) overlay
    // callback fired, so every click -- placing a point, finishing a
    // shape, selecting one, clicking empty space -- eventually saves
    // whatever the chart's real overlay state is a moment later. Slightly
    // redundant with the overlay callbacks' own persistDrawings() calls,
    // which is fine -- persistDrawings() is idempotent.
    let persistAfterClickTimer: ReturnType<typeof setTimeout> | null = null;
    const onClickPersist = () => {
      if (persistAfterClickTimer) clearTimeout(persistAfterClickTimer);
      persistAfterClickTimer = setTimeout(persistDrawings, 150);
    };
    el.addEventListener("click", onClickPersist);

    const onChartAction = () => onPanOrZoomRef.current?.();
    try {
      chart?.subscribeAction?.(ActionType.OnZoom, onChartAction);
      chart?.subscribeAction?.(ActionType.OnScroll, onChartAction);
    } catch {
      // ignore -- context menu just won't auto-close on pan/zoom this session
    }

    // chart-polish round -- Escape cancels an overlay still being drawn
    // (klinecharts has no built-in key handling of its own -- confirmed
    // against its source, this is entirely this component's own
    // responsibility); Delete/Backspace removes the currently-selected
    // one. Skipped entirely if focus is in a real text input elsewhere on
    // the page -- Backspace while typing must never be hijacked into
    // deleting a chart drawing just because one happens to be selected.
    const onKeyDown = (e: KeyboardEvent) => {
      const chart = chartRef.current;
      if (!chart) return;
      if (e.key === "Escape" && drawingOverlayIdRef.current) {
        try {
          chart.removeOverlay?.(drawingOverlayIdRef.current);
        } catch {
          // ignore
        }
        drawingOverlayIdRef.current = null;
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
        if (!selectedOverlayIdRef.current) return;
        try {
          chart.removeOverlay?.(selectedOverlayIdRef.current);
        } catch {
          // ignore
        }
        selectedOverlayIdRef.current = null;
      }
    };
    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("keydown", onKeyDown);
      containerObserver.disconnect();
      el.removeEventListener("contextmenu", onContextMenu);
      el.removeEventListener("click", onClickPersist);
      if (persistAfterClickTimer) clearTimeout(persistAfterClickTimer);
      try {
        chart?.unsubscribeAction?.(ActionType.OnZoom, onChartAction);
        chart?.unsubscribeAction?.(ActionType.OnScroll, onChartAction);
      } catch {
        // ignore
      }
      try {
        dispose(el);
      } catch {
        // ignore
      }
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    try {
      chartRef.current?.setPriceVolumePrecision?.({ price: digits, volume: 0 });
    } catch {
      // ignore
    }
  }, [digits]);

  // chart-polish round -- swaps in the drawings persisted for this
  // symbol+timeframe (localStorage, see storageKey/persistDrawings
  // above) and clears whatever the previous symbol+timeframe had drawn.
  // Also the effect that runs once on mount to restore a page reload's
  // own prior session, since userOverlayIdsRef starts empty either way.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      userOverlayIdsRef.current.forEach((id) => chart.removeOverlay?.(id));
    } catch {
      // ignore
    }
    userOverlayIdsRef.current = [];
    selectedOverlayIdRef.current = null;
    drawingOverlayIdRef.current = null;

    try {
      const raw = window.localStorage.getItem(storageKey());
      if (!raw) return;
      const saved = JSON.parse(raw) as Array<{ name: string; points: unknown; styles: unknown; lock?: boolean }>;
      const ids: string[] = [];
      for (const drawing of saved) {
        const id = chart.createOverlay?.({ ...drawing, ...overlayLifecycleCallbacks() });
        if (typeof id === "string") ids.push(id);
      }
      userOverlayIdsRef.current = ids;
    } catch {
      // malformed/unavailable storage -- start with no drawings for this
      // symbol+timeframe rather than crash the chart over it
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, timeframe]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || candles.length === 0) return;
    try {
      chart.applyNewData(
        candles.map((c) => ({ timestamp: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: 0 }))
      );
    } catch {
      // ignore — next data update will retry
    }
  }, [candles]);

  // fix/realtime-sync §3 -- incremental last-bar update on every real
  // tick, independent of the full applyNewData reset above (which only
  // ever re-fires on a genuine history reload: symbol/timeframe switch,
  // or seedRealCandles's real-history seed -- both of those hand this
  // component a brand new `candles` array; a live tick mutating the
  // existing one's last element does not, by design, so it needs its own
  // trigger). klinecharts' updateData replaces the bar matching this
  // timestamp if one exists, or appends a new one -- exactly the
  // semantics lightweight-charts' series.update() has, just this
  // library's own name for it. Effects run in declaration order on the
  // same commit, so a symbol/timeframe switch always gets the full reset
  // above applied before this potentially-stale-symbol's latestBar could
  // race ahead of it.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !latestBar) return;

    // hotfix/history-broker-time -- the failure this guards against was
    // invisible from inside the chart: history bars arrived in BROKER
    // server time (UTC+3) while latestBar's bucket was computed in real
    // UTC, so updateData below was handed a timestamp ~3h behind the last
    // history bar. klinecharts matches on timestamp, found nothing at or
    // after it, and silently did nothing -- the last candle just stopped
    // moving until a timeframe switch refetched history. No error, no
    // throw, nothing in the console; both sides were individually
    // self-consistent, which is why the unit tests passed too.
    //
    // Dev-only and loud: in production this must never spam a user's
    // console, but in development a mismatch bigger than one bar means
    // the two time sources have diverged again and the chart is lying.
    // The period is derived from the history itself (gap between the last
    // two bars) rather than taken as a prop -- this component isn't told
    // its timeframe, and inferring it here keeps the check self-contained
    // instead of threading a new prop through every call site for a
    // dev-only assertion.
    if (process.env.NODE_ENV !== "production" && candles.length >= 2) {
      const lastHistory = candles[candles.length - 1].t;
      const periodMs = lastHistory - candles[candles.length - 2].t;
      const drift = Math.abs(latestBar.t - lastHistory);
      if (periodMs > 0 && drift > periodMs) {
        console.error(
          `[chart] history/tick timestamp drift: last history bar ${new Date(lastHistory).toISOString()}, ` +
            `tick bucket ${new Date(latestBar.t).toISOString()}, drift ${(drift / 3_600_000).toFixed(2)}h ` +
            `(more than one ${periodMs / 60_000}m period). The last candle will appear frozen. ` +
            `Most likely history is stored in broker time rather than UTC -- see scripts/fix-broker-time-candles.ts.`
        );
      }
    }

    try {
      chart.updateData({ timestamp: latestBar.t, open: latestBar.o, high: latestBar.h, low: latestBar.l, close: latestBar.c, volume: 0 });
    } catch {
      // ignore — next tick will retry
    }
  }, [latestBar, candles]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    try {
      lineIdsRef.current.forEach((id) => chart.removeOverlay?.(id));
      const ids: string[] = [];
      lines.forEach((l) => {
        const id = `line-${l.id}`;
        const created = chart.createOverlay?.({
          name: "horizontalStraightLine",
          id,
          lock: true,
          points: [{ value: l.price }],
          styles: { line: { color: l.color, style: l.dashed ? "dashed" : "solid", size: 1.25 } },
        });
        if (created) ids.push(id);
      });
      lineIdsRef.current = ids;
    } catch {
      // ignore
    }
  }, [lines]);

  useImperativeHandle(
    ref,
    () => ({
      addOverlay(name) {
        try {
          // chart-polish round -- passing an OverlayCreate object (not
          // just the bare name string the old call site used) is what
          // wires the new overlay into selection/Escape/Delete/
          // persistence the same way a restored-from-storage one already
          // is. klinecharts' own default for every multi-point tool this
          // toolbar exposes (segment, horizontalStraightLine, rect,
          // fibonacciLine) is already click-then-click-again, not drag --
          // confirmed against klinecharts' own totalStep/currentStep
          // overlay model (no host-side "drag mode" to disable), and
          // separately by drawing each one in a real browser (see the
          // chart-polish PR screenshots).
          const id = chartRef.current?.createOverlay?.({ name, ...overlayLifecycleCallbacks() });
          if (typeof id === "string") userOverlayIdsRef.current.push(id);
        } catch {
          // ignore
        }
      },
      removeAllDrawings() {
        try {
          userOverlayIdsRef.current.forEach((id) => chartRef.current?.removeOverlay?.(id));
        } catch {
          // ignore
        }
        userOverlayIdsRef.current = [];
        selectedOverlayIdRef.current = null;
        drawingOverlayIdRef.current = null;
        persistDrawings();
      },
      toggleMA() {
        const chart = chartRef.current;
        if (!chart) return maOnRef.current;
        try {
          if (maOnRef.current) {
            chart.removeIndicator?.("candle_pane", "MA");
          } else {
            chart.createIndicator?.("MA", false, { id: "candle_pane" });
          }
          maOnRef.current = !maOnRef.current;
        } catch {
          // ignore
        }
        return maOnRef.current;
      },
    }),
    // overlayLifecycleCallbacks/persistDrawings close over refs only
    // (chartRef, userOverlayIdsRef, etc.), never state or props, so a
    // fresh function identity every render doesn't make them stale --
    // listed here only to satisfy exhaustive-deps, not because this
    // handle actually needs to change identity when they do.
    [overlayLifecycleCallbacks, persistDrawings]
  );

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});

export default KLineChartPanel;
