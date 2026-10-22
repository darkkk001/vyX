// WebTrader History, the terminal's one view (native Vyx.Shared/Trading/HistoryDeals.cs SingleView, terminal 1.0.92, owner):
// while a position is still OPEN its partial closes are flat rows of their own, each at its own time; once it is fully
// closed it is one row: a group (total lots, average close, total P/L, its closes as children) when it closed in parts or
// against another position, a plain row when it closed in one go. Closed positions are in the range by their close time,
// an open position's partials by their own. Newest first. Built from GET /api/trade/history?closes=1.

/** One close of a position, as /api/trade/history?closes=1 sends it (lib/history-closes.ts CloseLeg). */
export type HistoryClose = { at: string; volume: string | null; price: string | null; pnl: string; closedByTicket: number | null; final: boolean };

/** The fields of a history position this view reads. */
export type HistoryPositionLike = {
  id: string;
  status: "OPEN" | "CLOSED" | "VOIDED";
  volume: string;
  closedVolume?: string | null;
  closePrice: string | null;
  realizedPnl: string | null;
  swap: string;
  commission: string;
  closedAt: string | null;
  closes?: HistoryClose[];
  closedPnl?: string | null;
  avgClosePrice?: string | null;
};

export type HistoryLine<P extends HistoryPositionLike> = {
  key: string;
  trade: P;
  /** a partial close of a still-open position (its own row) */
  partial: boolean;
  /** a fully closed position shown with its closes as children */
  group: boolean;
  lots: string;
  closePrice: string | null;
  pnl: number;
  /** the row's time: the close's own time for a partial, else the position's close time */
  at: string;
  /** swap and commission ride on the position's row; a partial carries none (the terminal's rule) */
  swap: string;
  commission: string;
  children: HistoryClose[];
};

export type Range = { from?: string; to?: string };

function inRange(iso: string | null | undefined, r: Range): boolean {
  if (!r.from && !r.to) return true;
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return (!r.from || t >= Date.parse(r.from)) && (!r.to || t <= Date.parse(r.to));
}

/** A row is a group when its closes are worth showing: more than one, or a close made against another position. */
export function isGroup(p: HistoryPositionLike): boolean {
  const closes = p.closes ?? [];
  return closes.length > 1 || closes.some((c) => (c.closedByTicket ?? 0) > 0);
}

export function historyLines<P extends HistoryPositionLike>(rows: P[], range: Range = {}): HistoryLine<P>[] {
  const lines: HistoryLine<P>[] = [];
  for (const p of rows) {
    const closes = p.closes ?? [];
    if (p.status === "OPEN") {
      closes.forEach((c, i) => {
        if (!inRange(c.at, range)) return;
        lines.push({
          key: `${p.id}:${i}`, trade: p, partial: true, group: false, lots: c.volume ?? "", closePrice: c.price, pnl: Number(c.pnl),
          at: c.at, swap: "0", commission: "0", children: [],
        });
      });
      continue;
    }
    if (!inRange(p.closedAt, range)) continue;
    const group = isGroup(p);
    lines.push({
      key: p.id, trade: p, partial: false, group,
      lots: p.closedVolume ?? p.volume,
      closePrice: group ? (p.avgClosePrice ?? p.closePrice) : p.closePrice,
      pnl: Number(closes.length > 0 ? (p.closedPnl ?? p.realizedPnl ?? 0) : (p.realizedPnl ?? 0)),
      at: p.closedAt ?? "",
      swap: p.swap, commission: p.commission,
      children: group ? closes : [],
    });
  }
  lines.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  return lines;
}

/** The realised P/L of the range: every close in it at its own time (a partial counts on its own day), voided trades left
 *  out. A position without closes (an older answer) counts its own P/L at its close time. */
export function closesTotal(rows: HistoryPositionLike[], range: Range = {}): { pnl: number; closes: number } {
  let pnl = 0;
  let n = 0;
  for (const p of rows) {
    if (p.status === "VOIDED") continue;
    const closes = p.closes ?? [];
    if (closes.length === 0) {
      if (p.status !== "OPEN" && inRange(p.closedAt, range)) { pnl += Number(p.realizedPnl ?? 0); n++; }
      continue;
    }
    for (const c of closes) if (inRange(c.at, range)) { pnl += Number(c.pnl); n++; }
  }
  return { pnl, closes: n };
}
