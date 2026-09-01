import type { ApiPosition, ApiOrder } from "@/lib/trade-api";
import type { ChartLine } from "@/components/webtrader/KLineChartPanel";

// A pending order's own SL/TP (not its entry price) -- used alongside the
// interactive chart interaction pack overlays on the main/focused chart.
// A position's own open/SL/TP price and a pending order's own entry price
// are NOT included here on purpose: those are now the restyled,
// interactive "vyxPositionLine"/"vyxEditablePriceLine" overlays built by
// WebTrader.tsx's own positionLines/editableLines (see its "---------- chart
// ----------" section) -- richer visuals (tags, P/L, close button,
// drag-to-edit) than this plain-line helper can express. A pending order's
// SL/TP has no drag interaction in the spec ("Pending orders: draggable
// entry line the same way" -- only the entry line), so those stay plain.
export function computeOrderReferenceLines(symbol: string, pendingOrders: ApiOrder[]): ChartLine[] {
  const lines: ChartLine[] = [];
  pendingOrders
    .filter((o) => o.symbol.name === symbol)
    .forEach((o) => {
      if (o.slPrice) lines.push({ id: `ord-${o.id}-sl`, price: parseFloat(o.slPrice), color: "#EA3943", dashed: true });
      if (o.tpPrice) lines.push({ id: `ord-${o.id}-tp`, price: parseFloat(o.tpPrice), color: "#16C784", dashed: true });
    });
  return lines;
}

// The original plain-line behavior (position open/SL/TP + pending order
// entry/SL/TP, all as simple locked reference lines) -- kept as-is for the
// multi-chart grid cells (ChartCell.tsx), which don't wire up the chart
// interaction pack's drag/close interactivity. Losing the reference lines
// entirely in the grid view (by only ever calling
// computeOrderReferenceLines there) would be a real visual regression, not
// a simplification.
export function computeAllChartLines(symbol: string, positions: ApiPosition[], pendingOrders: ApiOrder[]): ChartLine[] {
  const lines: ChartLine[] = [];
  positions
    .filter((p) => p.symbol.name === symbol)
    .forEach((p) => {
      lines.push({ id: `pos-${p.id}`, price: parseFloat(p.openPrice), color: p.side === "BUY" ? "#16C784" : "#EA3943" });
      if (p.slPrice) lines.push({ id: `pos-${p.id}-sl`, price: parseFloat(p.slPrice), color: "#EA3943", dashed: true });
      if (p.tpPrice) lines.push({ id: `pos-${p.id}-tp`, price: parseFloat(p.tpPrice), color: "#16C784", dashed: true });
    });
  pendingOrders
    .filter((o) => o.symbol.name === symbol)
    .forEach((o) => {
      if (!o.requestedPrice) return;
      const color = o.side === "BUY" ? "#16C784" : "#EA3943";
      lines.push({ id: `ord-${o.id}`, price: parseFloat(o.requestedPrice), color, dashed: true });
      if (o.slPrice) lines.push({ id: `ord-${o.id}-sl`, price: parseFloat(o.slPrice), color: "#EA3943", dashed: true });
      if (o.tpPrice) lines.push({ id: `ord-${o.id}-tp`, price: parseFloat(o.tpPrice), color: "#16C784", dashed: true });
    });
  return lines;
}
