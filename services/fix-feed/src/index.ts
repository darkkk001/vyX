// vyx-fix-feed: cTrader FIX 4.4 QUOTE session -> engine /internal/price-feed, a drop-in for the MT5 EA's direct
// mode. See ../README.md for the environment variables.

import { writeFileSync } from "node:fs";
import { canonicalFor, describeConfig, loadConfig } from "./config.ts";
import { QuoteSession } from "./session.ts";
import { TickSink } from "./sink.ts";
import { TickStats } from "./stats.ts";

const cfg = loadConfig();
const log = (line: string) => console.log(`${new Date().toISOString()} ${line}`);

log(`vyx-fix-feed starting\n${describeConfig(cfg)}`);

const sink = new TickSink(cfg, log);
const stats = new TickStats(cfg.gapAlertMs, log);

const session = new QuoteSession(cfg, {
  onLog: log,
  onGaveUp: (reason) => void shutdown(`gave up: ${reason}`),
  onQuote(q) {
    // A one-sided book (rare: one side pulled) is not a tradable price; the EA skips bid<=0/ask<=0 the same way.
    if (q.bid === undefined || q.ask === undefined || q.bid <= 0 || q.ask <= 0) return;
    const symbol = canonicalFor(cfg, q.name);
    stats.record(symbol, q.bid, q.ask);
    sink.update(symbol, q.bid, q.ask, q.serverMs ?? Date.now());
  },
});

const statsTimer = setInterval(() => log(stats.periodic(cfg.statsIntervalSec)), cfg.statsIntervalSec * 1000);

let shuttingDown = false;
async function shutdown(why: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${why})`);
  clearInterval(statsTimer);
  const ticks = stats.summary();
  await session.stop();
  sink.stop();
  const summary = { ...ticks, session: session.counters, sink: sink.counters };
  log(`summary ${JSON.stringify(summary)}`);
  if (cfg.summaryPath) writeFileSync(cfg.summaryPath, JSON.stringify(summary, null, 2));
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
if (cfg.runSeconds > 0) setTimeout(() => void shutdown(`RUN_SECONDS=${cfg.runSeconds} reached`), cfg.runSeconds * 1000);

sink.start();
session.start();
