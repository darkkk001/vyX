// Side-by-side check of the FIX feed against the MT5 feed for the same minutes. Read-only on both sides:
//   - MT5 side: polls an engine's GET /internal/feed-stats once a second (x-internal-secret), which carries every
//     symbol's current bid/ask, last_tick_age_ms and ticks_60s.
//   - FIX side: the FEED_JSONL file a fix-feed run writes (every push batch it would have sent).
// Usage: COMPARE_URL=<engine base> COMPARE_SECRET=<internal secret> FIX_JSONL=ticks.jsonl RUN_SECONDS=600 \
//        [COMPARE_SYMBOLS=XAUUSD,EURUSD] [GAP_ALERT_MS=10000] node tools/compare.ts > compare.json

import { readFileSync } from "node:fs";

const url = (process.env.COMPARE_URL ?? "").replace(/\/+$/, "");
const secret = process.env.COMPARE_SECRET ?? "";
const jsonl = process.env.FIX_JSONL ?? "";
const runSec = Number(process.env.RUN_SECONDS ?? 600);
const gapMs = Number(process.env.GAP_ALERT_MS ?? 10_000);
if (!url || !secret || !jsonl) throw new Error("COMPARE_URL, COMPARE_SECRET and FIX_JSONL are required");

interface Sample { at: number; bid: number; ask: number; age: number; ticks60: number }
const mt5 = new Map<string, Sample[]>();
const startedMs = Date.now();

async function poll(): Promise<void> {
  try {
    const res = await fetch(`${url}/internal/feed-stats`, { headers: { "x-internal-secret": secret }, signal: AbortSignal.timeout(3000) });
    if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { per_symbol: { symbol: string; bid: string | number; ask: string | number; last_tick_age_ms: number; ticks_60s: number }[] };
    const at = Date.now();
    for (const p of body.per_symbol) {
      let arr = mt5.get(p.symbol);
      if (!arr) mt5.set(p.symbol, (arr = []));
      arr.push({ at, bid: Number(p.bid), ask: Number(p.ask), age: p.last_tick_age_ms, ticks60: p.ticks_60s });
    }
  } catch (err) {
    console.error(`feed-stats poll failed: ${(err as Error).message}`);
  }
}

const timer = setInterval(() => void poll(), 1000);
await new Promise((r) => setTimeout(r, runSec * 1000));
clearInterval(timer);

// FIX side: price changes per symbol with their arrival times.
const fix = new Map<string, { at: number; bid: number; ask: number }[]>();
for (const line of readFileSync(jsonl, "utf8").split("\n")) {
  if (!line) continue;
  const { at, ticks } = JSON.parse(line) as { at: number; ticks: { symbol: string; bid: number; ask: number }[] };
  if (at < startedMs) continue;
  for (const t of ticks) {
    let arr = fix.get(t.symbol);
    if (!arr) fix.set(t.symbol, (arr = []));
    const last = arr[arr.length - 1];
    if (!last || last.bid !== t.bid || last.ask !== t.ask) arr.push({ at, bid: t.bid, ask: t.ask });
  }
}

const wanted = (process.env.COMPARE_SYMBOLS ?? "").split(",").filter(Boolean);
const symbols = wanted.length ? wanted : [...new Set([...fix.keys()].filter((s) => mt5.has(s)))];
const out: Record<string, unknown> = {};
for (const sym of symbols) {
  const m = mt5.get(sym) ?? [];
  const f = fix.get(sym) ?? [];
  // MT5 ticks/sec: mean of ticks_60s/60 over the samples taken after its first full minute.
  const full = m.filter((s) => s.at - startedMs >= 60_000);
  const mt5Rate = full.length ? full.reduce((a, s) => a + s.ticks60, 0) / full.length / 60 : null;
  // MT5 silences: seconds where its last tick was older than the gap threshold.
  const mt5StaleSec = m.filter((s) => s.age >= gapMs).length;
  const fixGaps: { start: string; seconds: number }[] = [];
  for (let i = 1; i < f.length; i++) if (f[i].at - f[i - 1].at >= gapMs) fixGaps.push({ start: new Date(f[i - 1].at).toISOString(), seconds: (f[i].at - f[i - 1].at) / 1000 });
  // Mid-price difference at each MT5 sample vs the latest FIX price at that moment.
  const diffs: number[] = [];
  let j = 0;
  for (const s of m) {
    while (j + 1 < f.length && f[j + 1].at <= s.at) j++;
    if (!f.length || f[j].at > s.at) continue;
    diffs.push((f[j].bid + f[j].ask) / 2 - (s.bid + s.ask) / 2);
  }
  const abs = diffs.map(Math.abs).sort((a, b) => a - b);
  out[sym] = {
    mt5TicksPerSec: mt5Rate === null ? null : Number(mt5Rate.toFixed(3)),
    fixTicksPerSec: Number((f.length / runSec).toFixed(3)),
    mt5SecondsStale: mt5StaleSec,
    fixGaps,
    midDiff: abs.length ? { samples: abs.length, mean: Number((diffs.reduce((a, b) => a + b, 0) / diffs.length).toFixed(5)), p50Abs: abs[Math.floor(abs.length / 2)], maxAbs: abs[abs.length - 1] } : null,
  };
}
console.log(JSON.stringify({ startedAt: new Date(startedMs).toISOString(), seconds: runSec, gapThresholdMs: gapMs, symbols: out }, null, 2));
