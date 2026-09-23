#!/usr/bin/env node
// Stage 4 load harness -- compares the web snapshot with the engine snapshot (scripts/load/snapshot.ts), id by id.
//
//   node scripts/load/diff.mjs <world.json> <web-snapshot.json> <engine-snapshot.json>
//
// Every difference is attributed to the topology its account / position belongs to (world.topologies), or "bulk".
// Exit 1 on any difference outside an `anomaly` topology (anomalies are reported, not gated: §4.7).
import fs from "node:fs";

const [worldPath, webPath, enginePath] = process.argv.slice(2);
const world = JSON.parse(fs.readFileSync(worldPath, "utf8"));
const web = JSON.parse(fs.readFileSync(webPath, "utf8"));
const eng = JSON.parse(fs.readFileSync(enginePath, "utf8"));

const topoOfAccount = new Map();
for (const t of world.topologies) for (const a of t.accounts) topoOfAccount.set(a, t);
const accountOfPosition = new Map(world.positions.map((p) => [p.id, p.account]));
const topoOf = (accountId) => topoOfAccount.get(accountId) ?? { name: "bulk", anomaly: false };
const sameNum = (a, b) => (a == null || b == null ? a === b : Math.abs(Number(a) - Number(b)) <= 1e-4);

const diffs = []; // { topo, anomaly, what }
const add = (accountId, what) => {
  const t = topoOf(accountId);
  diffs.push({ topo: t.name, anomaly: !!t.anomaly, what });
};

for (const id of new Set([...Object.keys(web.accounts), ...Object.keys(eng.accounts)])) {
  const a = web.accounts[id];
  const b = eng.accounts[id];
  if (!a || !b) { add(id, `account ${id} missing in ${!a ? "web" : "engine"}`); continue; }
  if (!sameNum(a.balance, b.balance)) add(id, `${id} balance web=${a.balance} engine=${b.balance}`);
  if (!sameNum(a.credit, b.credit)) add(id, `${id} credit web=${a.credit} engine=${b.credit}`);
  if (a.marginCallNotified !== b.marginCallNotified) add(id, `${id} marginCall web=${a.marginCallNotified} engine=${b.marginCallNotified}`);
  const norm = (xs) => xs.map((x) => { const [r, t, v] = x.split("|"); return `${r}|${t}|${Number(v)}`; }).sort().join(";");
  if (norm(a.txns) !== norm(b.txns)) add(id, `${id} txns web=[${a.txns.join(",")}] engine=[${b.txns.join(",")}]`);
}
for (const id of new Set([...Object.keys(web.positions), ...Object.keys(eng.positions)])) {
  const a = web.positions[id];
  const b = eng.positions[id];
  const acct = accountOfPosition.get(id) ?? id;
  if (!a || !b) { add(acct, `position ${id} missing in ${!a ? "web" : "engine"}`); continue; }
  if (a.status !== b.status || a.closedBy !== b.closedBy || !sameNum(a.volume, b.volume) || !sameNum(a.closePrice, b.closePrice) || !sameNum(a.realizedPnl, b.realizedPnl)) {
    add(acct, `position ${id} web=${a.status}/${a.closedBy}@${a.closePrice}/${a.realizedPnl} engine=${b.status}/${b.closedBy}@${b.closePrice}/${b.realizedPnl}`);
  }
}
for (const id of new Set([...Object.keys(web.queuedOrders), ...Object.keys(eng.queuedOrders)])) {
  if (web.queuedOrders[id] !== eng.queuedOrders[id]) add(accountOfPosition.get(id.replace(/^q-/, "")) ?? id, `queued order ${id} web=${web.queuedOrders[id]} engine=${eng.queuedOrders[id]}`);
}
// side effects: entity -> account through positions / accounts, for attribution
for (const k of new Set([...Object.keys(web.sideEffects), ...Object.keys(eng.sideEffects)])) {
  if ((web.sideEffects[k] ?? 0) === (eng.sideEffects[k] ?? 0)) continue;
  const entity = k.split(":")[2];
  add(accountOfPosition.get(entity) ?? entity, `effect ${k} web=${web.sideEffects[k] ?? 0} engine=${eng.sideEffects[k] ?? 0}`);
}

const byTopo = new Map();
for (const d of diffs) {
  const list = byTopo.get(d.topo) ?? { anomaly: d.anomaly, items: [] };
  list.items.push(d.what);
  byTopo.set(d.topo, list);
}
const names = ["bulk", ...world.topologies.map((t) => t.name)];
let gated = 0;
console.log(`${"topology".padEnd(24)} | result | differences`);
for (const n of names) {
  const entry = byTopo.get(n);
  const anomaly = n !== "bulk" && world.topologies.find((t) => t.name === n)?.anomaly;
  const status = !entry ? "MATCH" : anomaly ? "DIFF (anomaly, reported)" : "FAIL";
  if (entry && !anomaly) gated += entry.items.length;
  console.log(`${n.padEnd(24)} | ${status} | ${entry ? `${entry.items.length}: ${entry.items.slice(0, 6).join("; ")}${entry.items.length > 6 ? " ..." : ""}` : "-"}`);
}
console.log(`\n${diffs.length} difference(s), ${gated} gated`);
process.exit(gated ? 1 : 0);
