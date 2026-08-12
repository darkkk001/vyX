"use client";

import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { init, dispose } from "klinecharts";
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
  digits: number;
  lines: ChartLine[];
  onContextMenuPrice?: (price: number, clientX: number, clientY: number) => void;
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
  { candles, digits, lines, onContextMenuPrice },
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
            last: { show: true, upColor: "#16C784", downColor: "#EA3943" },
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

    return () => {
      window.removeEventListener("resize", onResize);
      el.removeEventListener("contextmenu", onContextMenu);
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
