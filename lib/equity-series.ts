// The equity line of the backoffice client chart (bo 1.0.96 #21, owner 2026-10-27). Two sources, never mixed at one moment:
//   - while the account holds an open position: the recorded snapshots (lib/equity-snapshots.ts, every 5 min when the
//     equity changed);
//   - while it holds none: equity = balance + credit, from the ledger. Each completed row moves the equity by its amount,
//     except a CREDIT row (credit a closing loss used: balance up, credit down by the same amount, equity unchanged); so
//     the equity right after a row = (balance + credit now) - every such amount booked after it (lib/balance-after.ts's
//     rule, never the stored balanceAfter).
// A ledger point inside an open-position interval is dropped (it would show the balance without the floating P/L). The
// close's own P/L row is written a moment before the position is marked closed, so a point within CLOSE_SLACK_MS of
// closedAt counts as after the close.

export type EquityPoint = { t: string; equity: string; source: "ledger" | "snapshot" | "now" };
export type Interval = { openedAt: Date; closedAt: Date | null };

const CLOSE_SLACK_MS = 2_000;

/** Pure: whether an account held an open position at `t` (open at or before t, not closed yet). */
export function holdingAt(intervals: Interval[], t: Date): boolean {
  const ms = t.getTime();
  return intervals.some((i) => i.openedAt.getTime() <= ms && (i.closedAt === null || ms < i.closedAt.getTime() - CLOSE_SLACK_MS));
}

/** Pure: the merged, time-ordered series. `ledger` = equity right after each row (already computed), `snapshots` = the
 *  recorded rows, `now` = the current point (live equity when holding and fully priced, else balance + credit). */
export function buildEquitySeries(input: {
  ledger: { at: Date; equity: string }[];
  snapshots: { at: Date; equity: string }[];
  intervals: Interval[];
  now: { at: Date; equity: string } | null;
}): EquityPoint[] {
  const pts: { at: Date; equity: string; source: EquityPoint["source"] }[] = [];
  for (const l of input.ledger) if (!holdingAt(input.intervals, l.at)) pts.push({ ...l, source: "ledger" });
  for (const s of input.snapshots) pts.push({ ...s, source: "snapshot" });
  pts.sort((a, b) => a.at.getTime() - b.at.getTime());
  if (input.now) pts.push({ ...input.now, source: "now" });
  return pts.map((p) => ({ t: p.at.toISOString(), equity: p.equity, source: p.source }));
}
