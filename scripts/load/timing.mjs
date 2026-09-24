#!/usr/bin/env node
// Stage 4.6 -- per-row cost breakdown of the post-close follow-up (scripts/parity/post-close-server.ts timing mode +
// the engine report's dispatcher round trips). Shape, not absolute numbers: the machine's speed varies.
//   node scripts/load/timing.mjs <out-dir>
import fs from "node:fs";
const dir = process.argv[2];
const t = JSON.parse(fs.readFileSync(`${dir}/post-close-timing.json`, "utf8"));
const r = JSON.parse(fs.readFileSync(`${dir}/engine-report.json`, "utf8"));
const rows = t.lease?.n ?? 0;
const phase = (k) => t[k] ?? { n: 0, sumMs: 0, maxMs: 0 };
const perRow = (k) => (rows ? phase(k).sumMs / rows : 0);
const handlerPerRow = rows ? phase("handler").sumMs / rows : 0;
const roundTripPerRow = rows ? (r.deliveryMeanMs * r.deliveries) / rows : 0;
const lines = [["http (round trip - handler)", Math.max(0, roundTripPerRow - handlerPerRow)]];
lines.push(["lease claim", perRow("lease")]);
for (const k of Object.keys(t).filter((k) => k.startsWith("step:")).sort()) lines.push([k, phase(k).sumMs / rows]);
lines.push(["read pendingEvents", perRow("read_events")], ["publish", perRow("publish")], ["mark DONE", perRow("done")]);
const phasesSum = lines.slice(1).reduce((s, [, v]) => s + v, 0);
lines.push(["route overhead (handler - phases)", Math.max(0, handlerPerRow - phasesSum)]);
const total = lines.reduce((s, [, v]) => s + v, 0);
console.log(`rows ${rows}, deliveries ${r.deliveries}, per-row total ${total.toFixed(2)} ms, fan-in wait ${r.maxWaitedMs} ms`);
for (const [k, v] of lines) console.log(`  ${k.padEnd(34)} ${v.toFixed(2).padStart(8)} ms  ${((100 * v) / total).toFixed(1).padStart(5)} %`);
