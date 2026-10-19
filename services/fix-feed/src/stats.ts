// Per-symbol tick accounting for the logs and the run summary: updates received, real price changes, ticks/sec,
// the longest silence, and every silence longer than gapAlertMs (with its start time, so it can be lined up against
// the MT5 feed for the same minutes).

export interface Gap { startMs: number; ms: number }

interface SymStats {
  updates: number;          // top-of-book messages received
  changes: number;          // updates where bid or ask actually moved
  windowChanges: number;    // since the last periodic report
  firstMs: number;
  lastMs: number;
  maxGapMs: number;
  gaps: Gap[];
  bid?: number;
  ask?: number;
  perSecond: Map<number, number>;
  crossed: number;          // bid >= ask seen
}

export class TickStats {
  private readonly syms = new Map<string, SymStats>();
  private readonly startedMs = Date.now();
  private readonly gapAlertMs: number;
  private readonly log: (line: string) => void;

  constructor(gapAlertMs: number, log: (line: string) => void) {
    this.gapAlertMs = gapAlertMs;
    this.log = log;
  }

  record(symbol: string, bid: number, ask: number, now = Date.now()): void {
    let s = this.syms.get(symbol);
    if (!s) {
      s = { updates: 0, changes: 0, windowChanges: 0, firstMs: now, lastMs: now, maxGapMs: 0, gaps: [], perSecond: new Map(), crossed: 0 };
      this.syms.set(symbol, s);
    }
    s.updates++;
    if (bid >= ask) s.crossed++;
    if (bid === s.bid && ask === s.ask) return;
    if (s.changes > 0) {
      const gap = now - s.lastMs;
      if (gap > s.maxGapMs) s.maxGapMs = gap;
      if (gap >= this.gapAlertMs) {
        s.gaps.push({ startMs: s.lastMs, ms: gap });
        this.log(`gap ${symbol}: no price change for ${(gap / 1000).toFixed(1)}s (since ${new Date(s.lastMs).toISOString()})`);
      }
    }
    s.changes++;
    s.windowChanges++;
    s.lastMs = now;
    s.bid = bid;
    s.ask = ask;
    const sec = Math.floor(now / 1000);
    s.perSecond.set(sec, (s.perSecond.get(sec) ?? 0) + 1);
  }

  periodic(intervalSec: number): string {
    const parts = [...this.syms.entries()].map(([sym, s]) => {
      const rate = (s.windowChanges / intervalSec).toFixed(2);
      s.windowChanges = 0;
      return `${sym} ${rate}/s`;
    });
    return `ticks/sec last ${intervalSec}s: ${parts.join(", ") || "none"}`;
  }

  summary(now = Date.now()) {
    const elapsedSec = (now - this.startedMs) / 1000;
    const symbols: Record<string, unknown> = {};
    for (const [sym, s] of this.syms) {
      const openGap = now - s.lastMs;
      symbols[sym] = {
        updates: s.updates,
        priceChanges: s.changes,
        ticksPerSec: Number((s.changes / elapsedSec).toFixed(3)),
        peakTicksPerSec: Math.max(0, ...s.perSecond.values()),
        secondsWithoutTick: Math.max(0, Math.round(elapsedSec) - s.perSecond.size),
        maxGapMs: Math.max(s.maxGapMs, openGap),
        gapsOverThreshold: [...s.gaps, ...(openGap >= this.gapAlertMs ? [{ startMs: s.lastMs, ms: openGap, open: true }] : [])]
          .map((g) => ({ start: new Date(g.startMs).toISOString(), seconds: Number((g.ms / 1000).toFixed(1)), ...("open" in g ? { stillOpen: true } : {}) })),
        crossedQuotes: s.crossed,
        lastBid: s.bid,
        lastAsk: s.ask,
      };
    }
    return { startedAt: new Date(this.startedMs).toISOString(), elapsedSec: Math.round(elapsedSec), gapThresholdMs: this.gapAlertMs, symbols };
  }
}
