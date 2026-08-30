"use client";

import { useState } from "react";
import { SYMBOL_DEFS, fmt, type MarketState, type Timeframe, type FeedStatus } from "@/lib/market-simulator";
import { computeChartLines } from "@/lib/chart-lines";
import type { ApiPosition, ApiOrder } from "@/lib/trade-api";
import KLineChartPanel from "./KLineChartPanel";

const CELL_TF_LABELS: { key: Timeframe; label: string }[] = [
  { key: "M1", label: "1m" },
  { key: "M5", label: "5m" },
  { key: "M30", label: "30m" },
  { key: "H1", label: "1H" },
  { key: "H4", label: "4H" },
  { key: "D1", label: "D" },
];

// One panel in the multi-chart grid layout (see WebTrader's chartLayout
// state) — same KLineChartPanel as the single-chart view, just smaller and
// carrying its own symbol/timeframe independent of the others. Clicking a
// cell focuses it, which WebTrader uses to sync the order ticket/watchlist
// to whatever's now focused (there's still only one "symbol you're trading"
// at a time, same as before — the grid only changes what's on screen).
export default function ChartCell({
  symbol,
  tf,
  m,
  feedStatus,
  positions,
  pendingOrders,
  focused,
  onFocus,
  onSymbolChange,
  onTfChange,
}: {
  symbol: string;
  tf: Timeframe;
  m: MarketState;
  feedStatus: FeedStatus;
  positions: ApiPosition[];
  pendingOrders: ApiOrder[];
  focused: boolean;
  onFocus: () => void;
  onSymbolChange: (symbol: string) => void;
  onTfChange: (tf: Timeframe) => void;
}) {
  const [symbolPickerOpen, setSymbolPickerOpen] = useState(false);
  const up = m.bid >= m.prevBid;
  const lines = computeChartLines(symbol, positions, pendingOrders);

  return (
    <div
      onClick={onFocus}
      style={{
        display: "flex", flexDirection: "column", overflow: "hidden", position: "relative",
        background: "var(--bg-0)", boxShadow: focused ? "inset 0 0 0 1.5px var(--text-1)" : "inset 0 0 0 1px var(--border)",
      }}
    >
      <div style={{ height: 30, flexShrink: 0, display: "flex", alignItems: "center", gap: 8, padding: "0 8px", borderBottom: "1px solid var(--border)", background: "var(--bg-1)", position: "relative" }}>
        <span
          style={{ fontSize: 11.5, fontWeight: 600, cursor: "pointer", padding: "1px 4px", borderRadius: 4 }}
          onClick={(e) => { e.stopPropagation(); onFocus(); setSymbolPickerOpen((v) => !v); }}
        >
          {symbol} ▾
        </span>
        {symbolPickerOpen ? (
          <div
            className="account-dropdown show"
            style={{ top: "100%", left: 0, width: 180, zIndex: 10 }}
            onClick={(e) => e.stopPropagation()}
          >
            <div style={{ maxHeight: 220, overflowY: "auto" }}>
              {SYMBOL_DEFS.map((s) => (
                <div
                  key={s.name}
                  className={`acc-option${s.name === symbol ? " active" : ""}`}
                  style={{ cursor: "pointer", padding: "6px 10px" }}
                  onClick={() => { onSymbolChange(s.name); setSymbolPickerOpen(false); }}
                >
                  <span className="mono">{s.name}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {feedStatus === "live" || feedStatus === "stale" ? (
          <span className="mono" style={{ fontSize: 11, fontWeight: 600, color: feedStatus === "stale" ? "var(--text-3)" : up ? "var(--buy)" : "var(--sell)" }}>{fmt(m.bid, m.def.digits)}</span>
        ) : (
          <span className="mono" style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-3)" }}>{feedStatus === "connecting" ? "Connecting…" : "No live feed"}</span>
        )}
        <div style={{ marginLeft: "auto", display: "flex", gap: 1 }}>
          {CELL_TF_LABELS.map((t) => (
            <span
              key={t.key}
              onClick={(e) => { e.stopPropagation(); onFocus(); onTfChange(t.key); }}
              style={{ fontSize: 9.5, color: t.key === tf ? "var(--text-1)" : "var(--text-3)", background: t.key === tf ? "var(--bg-3)" : "transparent", padding: "2px 5px", borderRadius: 4, cursor: "pointer" }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0, position: "relative" }}>
        <KLineChartPanel
          candles={m.candles[tf]}
          latestBar={m.candles[tf][m.candles[tf].length - 1]}
          digits={m.def.digits}
          lines={lines}
        />
        {feedStatus === "connecting" ? (
          <div style={{ position: "absolute", top: 6, left: 6, fontSize: 10, color: "var(--text-3)", pointerEvents: "none" }}>Connecting…</div>
        ) : feedStatus === "no-feed" ? (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(0,0,0,0.35)", pointerEvents: "none" }}>
            <span style={{ fontSize: 12, fontWeight: 600, color: "var(--text-2)" }}>No live feed for {symbol}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
