// PRICE DRIVER: holds each active synthetic symbol at a level and ticks it about once per second (fills need a tick
// under 3 s old, risk checks under 15 s), moves it on demand (ramp at <= the configured %/s, or a single jump where a
// scenario allows it), and goes silent when nothing is active so the engine's idle gate closes (Neon load).
import { assertFeedUrl, assertSymbol, FEED_URL } from "./guards";
import type { Journal } from "./journal";

export type Tick = { symbol: string; bid: number; ask: number };
/** Where ticks go: the real synth-feed route, or the dry-run recorder. */
export interface TickSink { send(ticks: Tick[]): Promise<void> }

export const DIGITS: Record<string, number> = { vGOLD: 2, vEUR: 5, vGBP: 5, vJPY: 3, vIDX: 1 };
const round = (symbol: string, v: number) => Number(v.toFixed(DIGITS[symbol] ?? 5));

export class HttpTickSink implements TickSink {
  constructor(private readonly secret: string) {}
  async send(ticks: Tick[]): Promise<void> {
    assertFeedUrl(FEED_URL);
    for (const t of ticks) assertSymbol(t.symbol);
    const res = await fetch(FEED_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-synth-feed-secret": this.secret },
      body: JSON.stringify(ticks),
    });
    if (res.status !== 200) throw new Error(`synth-feed answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}

type Level = { bid: number; spread: number };

export class PriceDriver {
  private readonly levels = new Map<string, Level>();
  private timer: NodeJS.Timeout | null = null;
  private sending = false;
  lastError: string | null = null;

  constructor(private readonly sink: TickSink, private readonly journal: Journal, private readonly opts: { tickMs: number; maxRampPctPerSec: number; maxJumpPct: number; logEveryTick: boolean }) {}

  bid(symbol: string): number { const l = this.levels.get(symbol); if (!l) throw new Error(`${symbol} has no price yet (price.set first)`); return l.bid; }
  quote(symbol: string): Tick { const l = this.levels.get(symbol)!; return { symbol, bid: l.bid, ask: round(symbol, l.bid + l.spread) }; }
  active(): string[] { return [...this.levels.keys()]; }

  /** Start (or move) a symbol at an exact level; it is ticked from now on. */
  async set(symbol: string, bid: number, spread: number): Promise<void> {
    assertSymbol(symbol);
    this.levels.set(symbol, { bid: round(symbol, bid), spread });
    this.journal.write({ kind: "price.set", symbol, bid: round(symbol, bid), ask: round(symbol, bid + spread) });
    await this.flush();
    this.ensureLoop();
  }

  /** One move of up to maxJumpPct (only where the scenario allows a jump). */
  async jump(symbol: string, toPct: number): Promise<void> {
    if (Math.abs(toPct) > this.opts.maxJumpPct) throw new Error(`jump of ${toPct}% refused (max ${this.opts.maxJumpPct}%)`);
    const l = this.levels.get(symbol); if (!l) throw new Error(`${symbol} has no price yet`);
    const from = l.bid; l.bid = round(symbol, from * (1 + toPct / 100));
    this.journal.write({ kind: "price.jump", symbol, from, to: l.bid, pct: toPct });
    await this.flush();
  }

  /**
   * Moves the bid by pctPerSec each second (capped at the configured max) in `direction`, one tick per tickMs, until
   * `stop()` returns true, the move reaches maxPct, or timeoutSecs passes. Returns why it stopped.
   */
  async ramp(symbol: string, direction: "up" | "down", pctPerSec: number, maxPct: number, timeoutSecs: number, stop: () => Promise<boolean>): Promise<"condition" | "maxPct" | "timeout"> {
    if (pctPerSec > this.opts.maxRampPctPerSec) throw new Error(`ramp ${pctPerSec}%/s refused (max ${this.opts.maxRampPctPerSec}%/s)`);
    const l = this.levels.get(symbol); if (!l) throw new Error(`${symbol} has no price yet`);
    const start = l.bid, t0 = Date.now(), sign = direction === "up" ? 1 : -1;
    const stepPct = pctPerSec * (this.opts.tickMs / 1000);
    this.journal.write({ kind: "price.ramp", symbol, direction, from: start, pctPerSec, maxPct, timeoutSecs });
    for (;;) {
      if (await stop()) { this.journal.write({ kind: "price.ramp.end", symbol, why: "condition", at: l.bid, movedPct: pct(start, l.bid) }); return "condition"; }
      if (Math.abs(pct(start, l.bid)) >= maxPct) { this.journal.write({ kind: "price.ramp.end", symbol, why: "maxPct", at: l.bid }); return "maxPct"; }
      if (Date.now() - t0 > timeoutSecs * 1000) { this.journal.write({ kind: "price.ramp.end", symbol, why: "timeout", at: l.bid }); return "timeout"; }
      l.bid = round(symbol, l.bid * (1 + sign * stepPct / 100));
      await this.flush();
      await sleep(this.opts.tickMs);
    }
  }

  /** Stop ticking these symbols (the idle gate closes once nothing is fresh). */
  release(symbols: string[]): void {
    for (const s of symbols) this.levels.delete(s);
    this.journal.write({ kind: "price.release", symbols });
    if (this.levels.size === 0) this.stopLoop();
  }
  stopAll(): void { this.levels.clear(); this.stopLoop(); }

  private ensureLoop(): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.flush(); }, this.opts.tickMs);
  }
  private stopLoop(): void { if (this.timer) { clearInterval(this.timer); this.timer = null; } }
  private async flush(): Promise<void> {
    if (this.sending || this.levels.size === 0) return;
    this.sending = true;
    const ticks = [...this.levels.keys()].map((s) => this.quote(s));
    try {
      await this.sink.send(ticks);
      this.lastError = null;
      if (this.opts.logEveryTick) this.journal.write({ kind: "tick", ticks });
    } catch (e) {
      this.lastError = (e as Error).message;
      this.journal.write({ kind: "tick.error", error: this.lastError });
    } finally { this.sending = false; }
  }
}

export const pct = (from: number, to: number) => Number((((to - from) / from) * 100).toFixed(4));
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
