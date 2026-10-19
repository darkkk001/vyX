// Pushes ticks to the engine exactly the way mt5-ea/VyXTraderPriceFeed.mq5 does in direct mode (SendDirect +
// BuildAndSend): POST <FEED_URL>/internal/price-feed, header x-price-feed-secret, body a JSON array of
//   {"symbol","bid","ask","t0","tick_ms","broker_offset_sec"[,"clock_offset_ms","rtt_ms"]}
// (engine/protocol/src/lib.rs Tick). Same cadence rules too: at most one push per pushMinIntervalMs, only symbols
// whose bid/ask/tick time changed, plus a full snapshot of every symbol every heartbeatSnapshotMs so the engine can
// tell "not moving" from "stopped reporting". `bars` is left out: FIX has no broker bars, and the engine treats a
// missing `bars` as the pre-v1.40 EA (sampled open), never as an error.

import { appendFileSync } from "node:fs";
import type { Config } from "./config.ts";

interface Tracked {
  symbol: string;   // canonical
  bid: number;
  ask: number;
  tickMs: number;
  dirty: boolean;
}

export interface SinkCounters {
  pushes: number;
  pushFailures: number;
  ticksSent: number;
  clockSyncs: number;
}

export class TickSink {
  readonly counters: SinkCounters = { pushes: 0, pushFailures: 0, ticksSent: 0, clockSyncs: 0 };
  private readonly cfg: Config;
  private readonly log: (line: string) => void;
  private readonly tracked = new Map<string, Tracked>();
  private lastSnapshotMs = 0;
  private clockOffsetMs = 0;
  private rttMs = 0;
  private hasClockSync = false;
  private lastClockSyncMs = 0;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private failing = false;

  constructor(cfg: Config, log: (line: string) => void) {
    this.cfg = cfg;
    this.log = log;
  }

  start(): void {
    this.timer = setInterval(() => void this.flush(), this.cfg.pushMinIntervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  update(symbol: string, bid: number, ask: number, tickMs: number): void {
    const t = this.tracked.get(symbol);
    if (!t) {
      this.tracked.set(symbol, { symbol, bid, ask, tickMs, dirty: true });
      return;
    }
    if (t.bid !== bid || t.ask !== ask || t.tickMs !== tickMs) {
      t.bid = bid; t.ask = ask; t.tickMs = tickMs; t.dirty = true;
    }
  }

  // Exposed for tests: the body of the next push, or null when nothing is due.
  buildBody(now = Date.now()): string | null {
    const snapshot = now - this.lastSnapshotMs >= this.cfg.heartbeatSnapshotMs;
    const t0 = now + this.clockOffsetMs;
    const offset = this.cfg.brokerOffset();
    const parts: string[] = [];
    for (const t of this.tracked.values()) {
      if (!t.dirty && !snapshot) continue;
      t.dirty = false;
      // Same text the EA's StringFormat produces: %.5f prices, integer times.
      let s = `{"symbol":${JSON.stringify(t.symbol)},"bid":${t.bid.toFixed(5)},"ask":${t.ask.toFixed(5)},"t0":${t0},"tick_ms":${t.tickMs},"broker_offset_sec":${offset}`;
      if (this.hasClockSync) s += `,"clock_offset_ms":${this.clockOffsetMs},"rtt_ms":${this.rttMs}`;
      parts.push(s + "}");
    }
    if (parts.length === 0) return null;
    if (snapshot) this.lastSnapshotMs = now;
    return `[${parts.join(",")}]`;
  }

  private async flush(): Promise<void> {
    if (this.inFlight) return; // the next interval picks up whatever changed meanwhile
    this.inFlight = true;
    try {
      if (this.cfg.feedUrl && Date.now() - this.lastClockSyncMs >= this.cfg.clockSyncIntervalSec * 1000) await this.syncClock();
      const body = this.buildBody();
      if (!body) return;
      const count = (body.match(/"symbol":/g) ?? []).length;
      if (this.cfg.jsonlPath) appendFileSync(this.cfg.jsonlPath, `{"at":${Date.now()},"ticks":${body}}\n`);
      if (!this.cfg.feedUrl) {
        this.counters.pushes++;
        this.counters.ticksSent += count;
        return;
      }
      const res = await fetch(`${this.cfg.feedUrl}/internal/price-feed`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-price-feed-secret": this.cfg.feedSecret },
        body,
        signal: AbortSignal.timeout(5000),
      });
      if (res.status !== 200) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      this.counters.pushes++;
      this.counters.ticksSent += count;
      if (this.failing) this.log("price-feed push recovered");
      this.failing = false;
    } catch (err) {
      this.counters.pushFailures++;
      if (!this.failing) this.log(`price-feed push failed: ${(err as Error).message}`);
      this.failing = true;
      for (const t of this.tracked.values()) t.dirty = true; // resend everything once the engine is back
    } finally {
      this.inFlight = false;
    }
  }

  // The EA's SyncClockOffset: GET /internal/time, offset = server - midpoint of the round trip.
  private async syncClock(): Promise<void> {
    this.lastClockSyncMs = Date.now();
    try {
      const sent = Date.now();
      const res = await fetch(`${this.cfg.feedUrl}/internal/time`, { signal: AbortSignal.timeout(3000) });
      const recv = Date.now();
      if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const { server_utc_ms } = (await res.json()) as { server_utc_ms: number };
      this.rttMs = recv - sent;
      this.clockOffsetMs = Math.round(server_utc_ms - (sent + this.rttMs / 2));
      this.hasClockSync = true;
      this.counters.clockSyncs++;
    } catch (err) {
      this.log(`clock sync failed: ${(err as Error).message}`);
    }
  }
}
