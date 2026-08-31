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

export type DrawingOverlayName =
  | "trendLine"
  | "horizontalStraightLine"
  | "fibonacciLine"
  | "rectangle"
  | "simpleAnnotation";

export type KLineChartHandle = {
  addOverlay: (name: DrawingOverlayName) => void;
  removeAllDrawings: () => void;
  toggleMA: () => boolean;
};

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
  // hotfix/terminal-live-bugs round 2 -- "the dashed price line must be
  // driven by the tick, not the bar." klinecharts' own priceMark.last
  // (disabled below) can only ever draw from its internal kline data
  // model's last close, which is one hop removed from the raw tick (it
  // goes through candles[]/latestBar first) -- this prop bypasses that
  // entirely so the line always reflects MarketState.bid directly, the
  // exact same value the header price and watchlist row read, with no
  // intermediate bar-update step that could lag or silently not fire.
  currentPrice?: number;
  currentPriceRising?: boolean;
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
  { candles, latestBar, currentPrice, currentPriceRising, digits, lines, onContextMenuPrice, onPanOrZoom },
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

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
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
            // hotfix/terminal-live-bugs round 2 -- disabled in favor of the
            // currentPrice-driven overlay below. This built-in line can
            // only ever track the kline data model's own last close, which
            // is exactly the "driven by the bar, not the tick" behavior
            // that was reported stale relative to the header.
            last: { show: false, upColor: "#16C784", downColor: "#EA3943" },
            high: { color: "#5A6472" },
            low: { color: "#5A6472" },
          },
        },
        xAxis: { axisLine: { color: "rgba(255,255,255,0.08)" }, tickText: { color: "#5A6472" } },
        yAxis: { axisLine: { color: "rgba(255,255,255,0.08)" }, tickText: { color: "#5A6472" } },
        crosshair: {
          horizontal: { line: { color: "#5A6472" } },
          vertical: { line: { color: "#5A6472" } },
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

    const onChartAction = () => onPanOrZoomRef.current?.();
    try {
      chart?.subscribeAction?.(ActionType.OnZoom, onChartAction);
      chart?.subscribeAction?.(ActionType.OnScroll, onChartAction);
    } catch {
      // ignore -- context menu just won't auto-close on pan/zoom this session
    }

    return () => {
      window.removeEventListener("resize", onResize);
      containerObserver.disconnect();
      el.removeEventListener("contextmenu", onContextMenu);
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

  // hotfix/terminal-live-bugs round 2 -- the dashed "current price" line,
  // decoupled entirely from the bar/latestBar/candles machinery above. It
  // only ever reads currentPrice (MarketState.bid, passed straight
  // through from WebTrader.tsx) -- if a future bug reintroduces any lag
  // between a live tick and the bar update path, this line still shows
  // the true current price, because it was never wired through that path
  // to begin with.
  const currentPriceLineIdRef = useRef<string | null>(null);
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || currentPrice == null) return;
    try {
      if (currentPriceLineIdRef.current) {
        chart.removeOverlay?.(currentPriceLineIdRef.current);
        currentPriceLineIdRef.current = null;
      }
      const id = "current-price-line";
      const created = chart.createOverlay?.({
        name: "horizontalStraightLine",
        id,
        lock: true,
        points: [{ value: currentPrice }],
        styles: { line: { color: currentPriceRising === false ? "#EA3943" : "#16C784", style: "dashed", size: 1 } },
      });
      if (created) currentPriceLineIdRef.current = id;
    } catch {
      // ignore -- next tick will retry
    }
  }, [currentPrice, currentPriceRising]);

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
          const id = chartRef.current?.createOverlay?.(name);
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
    []
  );

  return <div ref={containerRef} style={{ width: "100%", height: "100%" }} />;
});

export default KLineChartPanel;
