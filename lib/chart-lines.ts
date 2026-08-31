import type { ApiPosition, ApiOrder, ApiAlert } from "@/lib/trade-api";
import type { ChartLine } from "@/components/webtrader/KLineChartPanel";

// Phase 1 trust pack §3 -- a distinct color from every position/order
// line (green/red buy/sell) so an alert level reads as "watching", not
// "an open trade".
const ALERT_LINE_COLOR = "#F0B90B";

// Shared by the focused/single chart and each multi-chart grid cell — same
// position/SL/TP + pending-order price lines, just scoped to whichever
// symbol is asking. `alerts` defaults to [] so every existing call site
// (both before this parameter existed) keeps compiling unchanged.
export function computeChartLines(
  symbol: string,
  positions: ApiPosition[],
  pendingOrders: ApiOrder[],
  alerts: ApiAlert[] = []
): ChartLine[] {
  const lines: ChartLine[] = [];
  alerts
    .filter((a) => a.symbol === symbol && a.status === "ACTIVE")
    .forEach((a) => {
      lines.push({ id: `alert-${a.id}`, price: parseFloat(a.price), color: ALERT_LINE_COLOR, dashed: true });
    });
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
